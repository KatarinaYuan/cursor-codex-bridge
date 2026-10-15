import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BRAND = 'cursor-codex-bridge';
const ACTIVATION_ENV_NAMES = new Set(['CODEX_HOME', 'LC_CURSOR_CODEX_BRIDGE']);
const OMIT = new Set([
  'host', 'setenv', 'remotecommand', 'localcommand', 'permitlocalcommand',
  'requesttty', 'sessiontype', 'stdinnull', 'forkafterauthentication',
  'localforward', 'remoteforward', 'dynamicforward', 'clearallforwardings',
]);
const REST_OF_LINE = new Set(['proxycommand', 'proxyjump', 'knownhostscommand']);
const PATH_LISTS = new Set(['userknownhostsfile', 'globalknownhostsfile']);
const RAW_LISTS = new Set([
  'ipqos', 'rekeylimit', 'canonicalizepermittedcnames', 'canonicaldomains',
  'permitremoteopen', 'channeltimeout', 'addkeystoagent',
]);
const sha = (value) => createHash('sha256').update(value).digest('hex');

export function validateAlias(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('SSH alias must contain only letters, numbers, dots, underscores, and hyphens, and must start with a letter or number.');
  }
  return value;
}

function safeLine(value, name = 'SSH value') {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error(`${name} must be a single line without NUL bytes.`);
  return value;
}

function quote(value) {
  safeLine(value);
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function originalHostTokens(value, sourceAlias) {
  // Preserve %% literals while binding %n to the name used for ssh -G.
  return value.replace(/%%|%n/g, (token) => token === '%n' ? sourceAlias : token);
}

/** Parse effective `ssh -G source-alias` output, including repeated options. */
export function resolveHostConfig(sshGText) {
  if (typeof sshGText !== 'string' || sshGText.includes('\0')) throw new Error('Expected text from ssh -G.');
  const entries = [];
  for (const raw of sshGText.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.+)$/.exec(raw);
    if (!match) throw new Error('Malformed ssh -G output.');
    entries.push({ keyword: match[1].toLowerCase(), value: safeLine(match[2]) });
  }
  const first = (keyword) => entries.find((entry) => entry.keyword === keyword)?.value;
  if (!first('hostname') || !first('user') || !/^\d+$/.test(first('port') ?? '')) {
    throw new Error('ssh -G output must include hostname, user, and port.');
  }
  return { hostname: first('hostname'), user: first('user'), port: Number(first('port')), entries };
}

function effectiveConfig(input) {
  if (typeof input === 'string') return resolveHostConfig(input);
  if (!input || !Array.isArray(input.entries)) throw new Error('sshConfig must be resolveHostConfig(ssh -G output).');
  // Do not trust objects read back from a manifest more than fresh command output.
  return resolveHostConfig(input.entries.map(({ keyword, value }) => `${keyword} ${value}`).join('\n'));
}

function pathList(value) {
  if (value === 'none') return ['none'];
  // ssh -G expands these path lists to absolute paths, but strips quotes.
  // Split at the beginning of each absolute path rather than every space.
  // A path containing " /" is inherently ambiguous in ssh -G; reject it
  // when the output cannot be interpreted as a list of absolute paths.
  const parts = value.split(/\s+(?=\/|~\/|[A-Za-z]:[\\/])/);
  if (parts.some((part) => !/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(part))) {
    throw new Error('Cannot safely copy a relative SSH known-hosts path from ssh -G; use absolute paths in the source SSH configuration.');
  }
  return parts;
}

/** A complete, explicit top-of-file block; Host * restores the original scope. */
export function renderManagedHost({ alias, sourceAlias, sshConfig, profileHome, installationId, activationEnv = 'CODEX_HOME' }) {
  validateAlias(alias);
  validateAlias(sourceAlias);
  if (alias.toLowerCase() === sourceAlias.toLowerCase()) throw new Error('The managed SSH alias must differ from the original source alias.');
  validateAlias(installationId);
  if (!ACTIVATION_ENV_NAMES.has(activationEnv)) throw new Error('activationEnv must be CODEX_HOME or LC_CURSOR_CODEX_BRIDGE.');
  safeLine(profileHome, 'Remote CODEX_HOME');
  if (!profileHome.startsWith('/')) throw new Error('Remote CODEX_HOME must be an absolute path.');
  const config = effectiveConfig(sshConfig);
  const environment = [`${activationEnv}=${profileHome}`];
  for (const { keyword, value } of config.entries) {
    if (keyword !== 'setenv' || /^(?:CODEX_HOME|LC_CURSOR_CODEX_BRIDGE)=/.test(value)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) throw new Error('Malformed SetEnv in ssh -G output.');
    environment.push(originalHostTokens(value, sourceAlias));
  }
  const lines = [
    `# >>> ${BRAND} ${installationId} ${alias} >>>`,
    `# Managed connection cloned from ${sourceAlias}. Change the source alias and reinstall to update it.`,
    `Host ${alias}`,
    // OpenSSH takes the entire first SetEnv directive, not one value per name.
    `  SetEnv ${environment.map(quote).join(' ')}`,
  ];
  for (const { keyword, value: rawValue } of config.entries) {
    if (OMIT.has(keyword)) continue;
    const value = originalHostTokens(rawValue, sourceAlias);
    if (REST_OF_LINE.has(keyword) || RAW_LISTS.has(keyword)) lines.push(`  ${keyword} ${value}`);
    else if (PATH_LISTS.has(keyword)) lines.push(`  ${keyword} ${pathList(value).map(quote).join(' ')}`);
    else lines.push(`  ${keyword} ${quote(value)}`);
  }
  lines.push('Host *', `# <<< ${BRAND} ${installationId} ${alias} <<<`, '');
  return lines.join('\n');
}

function locations({ configPath = path.join(os.homedir(), '.ssh', 'config'), alias, installationId, managedDir }) {
  validateAlias(alias);
  validateAlias(installationId);
  configPath = path.resolve(configPath);
  managedDir = path.resolve(managedDir ?? path.join(path.dirname(configPath), `.${BRAND}`));
  return { configPath, alias, installationId, managedDir, manifestPath: path.join(managedDir, `${sha(alias.toLowerCase()).slice(0, 12)}.json`) };
}

async function snapshot(filePath) {
  let stat;
  try { stat = await fs.lstat(filePath); } catch (error) { if (error.code === 'ENOENT') return { exists: false, text: '' }; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to modify a symlink or non-regular file: ${filePath}`);
  const bytes = await fs.readFile(filePath);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Refusing to rewrite a non-UTF-8 configuration file: ${filePath}`);
  return { exists: true, text, ino: stat.ino, dev: stat.dev };
}

async function manifestAt(manifestPath) {
  const file = await snapshot(manifestPath);
  if (!file.exists) return null;
  try { return JSON.parse(file.text); } catch { throw new Error(`Invalid managed SSH manifest: ${manifestPath}`); }
}

function explicitAlias(text, alias) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*Host(?:\s+|=)(.*)$/i.exec(line);
    if (!match) continue;
    const tokens = match[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s#]+/g) ?? [];
    if (tokens.some((token) => token.replace(/^["']|["']$/g, '').toLowerCase() === alias.toLowerCase())) return true;
  }
  return false;
}

function words(value) {
  const output = [];
  let word = '';
  let delimiter = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) { word += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (delimiter) { if (character === delimiter) delimiter = null; else word += character; continue; }
    if (character === '"' || character === "'") { delimiter = character; continue; }
    if (character === '#') break;
    if (/\s/.test(character)) { if (word) output.push(word); word = ''; continue; }
    word += character;
  }
  if (escaped || delimiter) throw new Error('Cannot inspect malformed SSH Include directive.');
  if (word) output.push(word);
  return output;
}

function globExpression(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') expression += '.*';
    else if (char === '?') expression += '.';
    else if (char === '[') {
      const closing = pattern.indexOf(']', index + 1);
      if (closing < 0) expression += '\\[';
      else { expression += `[${pattern.slice(index + 1, closing).replace(/^!/, '^')}]`; index = closing; }
    } else expression += char.replace(/[\\^$+?.()|{}]/g, '\\$&');
  }
  return new RegExp(`${expression}$`);
}

async function expandIncludes(pattern) {
  pattern = pattern.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (process.env[name] === undefined) throw new Error(`Cannot inspect SSH Include with unset environment variable ${name}.`);
    return process.env[name];
  });
  if (pattern.startsWith('~/')) pattern = path.join(os.homedir(), pattern.slice(2));
  else if (pattern.startsWith('~')) throw new Error('Cannot safely inspect an SSH Include referring to another user; use an absolute Include path.');
  if (!path.isAbsolute(pattern)) pattern = path.join(os.homedir(), '.ssh', pattern);
  const root = path.parse(pattern).root;
  let matches = [root];
  for (const part of pattern.slice(root.length).split(path.sep).filter(Boolean)) {
    const next = [];
    for (const parent of matches) {
      if (!/[*?[]/.test(part)) { next.push(path.join(parent, part)); continue; }
      let entries;
      try { entries = await fs.readdir(parent); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
      const matcher = globExpression(part);
      for (const entry of entries.sort()) if (matcher.test(entry)) next.push(path.join(parent, entry));
    }
    matches = next;
  }
  return matches;
}

async function includedAlias(configPath, text, alias) {
  const visited = new Set([configPath]);
  async function scan(currentText, depth) {
    if (depth > 32 || visited.size > 512) throw new Error('SSH Include nesting is too deep to inspect safely.');
    for (const line of currentText.split(/\r?\n/)) {
      const match = /^\s*Include(?:\s+|=)(.*)$/i.exec(line);
      if (!match) continue;
      for (const pattern of words(match[1])) {
        for (const includePath of await expandIncludes(pattern)) {
          if (visited.has(includePath)) continue;
          visited.add(includePath);
          let included;
          try {
            const stat = await fs.stat(includePath);
            if (!stat.isFile()) continue;
            if (stat.size > 4 * 1024 * 1024) throw new Error(`SSH Include is too large to inspect safely: ${includePath}`);
            included = await fs.readFile(includePath, 'utf8');
          } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
          if (explicitAlias(included, alias)) return includePath;
          const nested = await scan(included, depth + 1);
          if (nested) return nested;
        }
      }
    }
    return null;
  }
  return scan(text, 0);
}

function inspectState(location, current, manifest) {
  const { alias, installationId, configPath } = location;
  const begin = `# >>> ${BRAND} ${installationId} ${alias} >>>\n`;
  const end = `# <<< ${BRAND} ${installationId} ${alias} <<<\n`;
  const start = current.text.indexOf(begin);
  if (!manifest) {
    if (start >= 0 || explicitAlias(current.text, alias)) return { status: 'conflict', reason: `SSH alias ${alias} already exists without this installation's ownership manifest.` };
    return { status: 'missing' };
  }
  if (manifest.version !== 1 || manifest.alias !== alias || manifest.installationId !== installationId || manifest.configPath !== configPath) {
    return { status: 'conflict', reason: 'The SSH ownership manifest belongs to a different installation.' };
  }
  if (!ACTIVATION_ENV_NAMES.has(manifest.activationEnv ?? 'CODEX_HOME')) return { status: 'conflict', reason: 'The SSH ownership manifest contains an unsupported activation environment variable.' };
  if (start < 0) return { status: 'conflict', reason: 'The managed SSH block is missing or its markers were edited.' };
  const finish = current.text.indexOf(end, start + begin.length);
  if (finish < 0 || current.text.indexOf(begin, start + begin.length) >= 0) return { status: 'conflict', reason: 'Managed SSH block markers are duplicated or incomplete.' };
  const blockEnd = finish + end.length;
  const block = current.text.slice(start, blockEnd);
  if (sha(block) !== manifest.blockHash) return { status: 'conflict', reason: 'The managed SSH block was edited; refusing to overwrite or delete those edits.' };
  const rest = current.text.slice(0, start) + current.text.slice(blockEnd);
  if (explicitAlias(rest, alias)) return { status: 'conflict', reason: `SSH alias ${alias} also exists outside the managed block.` };
  return { status: 'owned', start, end: blockEnd, block };
}

async function checkedState(location, current, manifest) {
  const state = inspectState(location, current, manifest);
  if (state.status === 'conflict') return state;
  const collision = await includedAlias(location.configPath, current.text, location.alias);
  if (collision) return { status: 'conflict', reason: `SSH alias ${location.alias} already exists in included configuration: ${collision}` };
  return state;
}

/** Read-only preflight; a conflict is returned as data, filesystem errors throw. */
export async function inspectHost(options) {
  const location = locations(options);
  const [current, manifest] = await Promise.all([snapshot(location.configPath), manifestAt(location.manifestPath)]);
  const state = await checkedState(location, current, manifest);
  return { ...state, alias: location.alias, configPath: location.configPath, manifestPath: location.manifestPath, owned: state.status === 'owned', activationEnv: manifest?.activationEnv ?? 'CODEX_HOME' };
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to use a symlink or non-directory for private metadata: ${directory}`);
  await fs.chmod(directory, 0o700);
}

async function unchanged(filePath, before) {
  const now = await snapshot(filePath);
  if (now.exists !== before.exists || now.text !== before.text || (now.exists && (now.ino !== before.ino || now.dev !== before.dev))) {
    throw new Error(`SSH configuration changed during installation; refusing to overwrite concurrent edits: ${filePath}`);
  }
}

async function atomicWrite(filePath, text) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filePath);
  } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

async function withLock(location, callback) {
  await privateDirectory(location.managedDir);
  const lockPath = path.join(location.managedDir, `config-${sha(location.configPath).slice(0, 12)}.lock`);
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another SSH configuration operation is active. If its process stopped, remove the stale lock: ${lockPath}`);
    throw error;
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await callback(); }
  finally { await lock.close(); await fs.unlink(lockPath); }
}

async function backup(location, current) {
  if (!current.exists) return null;
  const backupPath = path.join(location.managedDir, `config-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.backup`);
  await fs.writeFile(backupPath, current.text, { mode: 0o600, flag: 'wx' });
  return backupPath;
}

export async function installHost(options) {
  const location = locations(options);
  const block = renderManagedHost(options);
  return withLock(location, async () => {
    const current = await snapshot(location.configPath);
    const manifest = await manifestAt(location.manifestPath);
    const state = await checkedState(location, current, manifest);
    if (state.status === 'conflict') throw new Error(state.reason);
    if (state.status === 'owned' && state.block === block) {
      return { changed: false, alias: location.alias, configPath: location.configPath, manifestPath: location.manifestPath, backupPath: null, blockHash: sha(block) };
    }
    const text = state.status === 'owned'
      ? current.text.slice(0, state.start) + block + current.text.slice(state.end)
      : block + current.text;
    const backupPath = await backup(location, current);
    await fs.mkdir(path.dirname(location.configPath), { recursive: true, mode: 0o700 });
    await unchanged(location.configPath, current);
    await atomicWrite(location.configPath, text);
    const nextManifest = {
      version: 1, alias: location.alias, installationId: location.installationId,
      configPath: location.configPath, sourceAlias: options.sourceAlias,
      activationEnv: options.activationEnv ?? 'CODEX_HOME',
      blockHash: sha(block), createdAt: manifest?.createdAt ?? new Date().toISOString(),
      originalExists: manifest?.originalExists ?? current.exists,
      updatedAt: new Date().toISOString(), backupPaths: [...(manifest?.backupPaths ?? []), ...(backupPath ? [backupPath] : [])],
    };
    try { await atomicWrite(location.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`); }
    catch (error) {
      // An unavailable metadata disk must not strand an unowned managed block.
      const after = await snapshot(location.configPath);
      if (after.text === text) {
        if (current.exists) await atomicWrite(location.configPath, current.text);
        else await fs.unlink(location.configPath);
      }
      throw error;
    }
    return { changed: true, alias: location.alias, configPath: location.configPath, manifestPath: location.manifestPath, backupPath, blockHash: sha(block) };
  });
}

export async function removeHost(options) {
  const location = locations(options);
  return withLock(location, async () => {
    const current = await snapshot(location.configPath);
    const manifest = await manifestAt(location.manifestPath);
    const state = await checkedState(location, current, manifest);
    if (state.status === 'conflict') throw new Error(state.reason);
    if (state.status === 'missing') return { changed: false, alias: location.alias, configPath: location.configPath, manifestPath: location.manifestPath, backupPath: null };
    const text = current.text.slice(0, state.start) + current.text.slice(state.end);
    const backupPath = await backup(location, current);
    await unchanged(location.configPath, current);
    if (!text && manifest.originalExists === false) await fs.unlink(location.configPath);
    else await atomicWrite(location.configPath, text);
    await fs.unlink(location.manifestPath);
    return { changed: true, alias: location.alias, configPath: location.configPath, manifestPath: location.manifestPath, backupPath };
  });
}
