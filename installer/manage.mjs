import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { inspectHost, installHost, removeHost, renderManagedHost, resolveHostConfig, validateAlias } from './local-config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actions = new Set(['install', 'doctor', 'upgrade', 'uninstall', 'install-skill']);
const optionsWithValue = new Set(['ssh', 'alias', 'ssh-config', 'node-path', 'agent-path', 'codex-path', 'skill-dir']);
const booleanOptions = new Set(['dry-run', 'json', 'help']);
const activationCommand = () => `bash -lc ${shellQuote("printf '%s' \"${CODEX_INSTALL_DIR-}\"")}`;

export function parseManagementArgs(args) {
  const [action, ...rest] = args;
  if (!actions.has(action)) throw new Error(`Unknown management command: ${action}`);
  const options = { action };
  for (let index = 0; index < rest.length; index += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[index]);
    if (!match) throw new Error(`Unknown argument: ${rest[index]}`);
    const [, name, inline] = match;
    if (Object.hasOwn(options, name)) throw new Error(`Repeated option: --${name}`);
    if (booleanOptions.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      options[name] = true;
    } else if (optionsWithValue.has(name)) {
      const value = inline ?? rest[++index];
      if (!value || value.startsWith('--') || /[\r\n\0]/.test(value)) throw new Error(`--${name} requires a single-line value`);
      options[name] = value;
    } else throw new Error(`Unknown option: --${name}`);
  }
  if (options.help) return options;
  if (action === 'install-skill') {
    if (options.ssh || options.alias) throw new Error('install-skill is local; do not specify --ssh or --alias');
  } else {
    validateAlias(options.ssh);
    options.alias ||= `${options.ssh}-cursor`;
    validateAlias(options.alias);
    if (options.alias.toLowerCase() === options.ssh.toLowerCase()) throw new Error('The managed alias must differ from the original SSH alias');
    if (options['skill-dir']) throw new Error('--skill-dir applies only to install-skill');
  }
  return options;
}

export function installationId(alias) {
  return createHash('sha256').update(alias.toLowerCase()).digest('hex').slice(0, 16);
}

export function shellQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid shell argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function runProcess(executable, args, { input, timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let bytes = 0, failure;
    const timer = setTimeout(() => { failure = new Error(`${path.basename(executable)} timed out`); child.kill('SIGTERM'); }, timeoutMs);
    const collect = (target, data) => {
      bytes += data.length;
      if (bytes > maxBytes) { failure ||= new Error(`${path.basename(executable)} output exceeded its limit`); child.kill('SIGTERM'); }
      else target.push(data);
    };
    child.stdout.on('data', data => collect(stdout, data));
    child.stderr.on('data', data => collect(stderr, data));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure ||= error; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(input);
  });
}

function sshArgs(options, { alias = options.ssh, overrides = [], configPath } = {}) {
  return [...(configPath || options['ssh-config'] ? ['-F', configPath || options['ssh-config']] : []),
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
    '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', ...overrides, alias];
}

export function createSshClient(options, { run = runProcess, env = process.env, root = packageRoot } = {}) {
  async function exec(command, settings = {}) {
    return run('ssh', [...sshArgs(options, settings), command], { env, ...settings });
  }
  return {
    exec,
    async config() {
      const result = await run('ssh', [...(options['ssh-config'] ? ['-F', options['ssh-config']] : []), '-G', options.ssh], { env });
      if (result.code) throw new Error(`Cannot resolve SSH alias ${options.ssh}: ${result.stderr.trim()}`);
      return resolveHostConfig(result.stdout);
    },
    async environment(value, settings = {}) {
      const variable = settings.variable || 'CODEX_HOME';
      if (!['CODEX_HOME', 'LC_CURSOR_CODEX_BRIDGE'].includes(variable)) throw new Error('Invalid activation environment variable');
      const command = `printf '%s' "\${${variable}-}"`;
      const result = await exec(command, {
        ...settings, overrides: ['-o', `SetEnv=${variable}=${value}`],
      });
      if (result.code) throw new Error(`SSH connection failed: ${result.stderr.trim()}`);
      return result.stdout === value;
    },
    async remote(action, request, settings = {}) {
      const script = await fs.readFile(path.join(root, 'installer', action === 'bootstrap' ? 'bootstrap.py' : 'remote.py'));
      const bootstrap = `import base64;exec(compile(base64.b64decode('${script.toString('base64')}'),'cursor-codex-remote.py','exec'))`;
      const result = await exec(`python3 -c ${shellQuote(bootstrap)} ${shellQuote(action)}`, {
        ...(action === 'bootstrap' ? { timeoutMs: 600_000 } : {}), ...settings, input: JSON.stringify(request),
      });
      let response;
      try { response = JSON.parse(result.stdout); } catch {
        throw new Error(`Remote installer did not return JSON. Ensure Python 3 is available and shell startup files are quiet. ${result.stderr.trim().slice(0, 1000)}`);
      }
      if (result.code || !response.ok) {
        const error = new Error(response.error?.message || `Remote ${action} failed`);
        error.code = response.error?.code; error.details = response; throw error;
      }
      return response;
    },
    async validate(block) {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-codex-ssh-check-'));
      try {
        const file = path.join(temporary, 'config');
        await fs.writeFile(file, block, { mode: 0o600 });
        const result = await run('ssh', ['-F', file, '-G', options.alias], { env });
        if (result.code) throw new Error(`Generated SSH configuration was rejected: ${result.stderr.trim()}`);
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    },
    async upload(archive) {
      const directory = `/tmp/cursor-codex-${randomUUID()}`;
      const archivePath = `${directory}/runtime.tgz`;
      const result = await exec(`umask 077; mkdir -m 700 ${shellQuote(directory)} && cat > ${shellQuote(archivePath)}`, {
        input: await fs.readFile(archive), timeoutMs: 60_000,
      });
      if (result.code) throw new Error(`Cannot upload bridge archive: ${result.stderr.trim()}`);
      return { directory, archivePath };
    },
    async cleanup(directory) {
      if (!/^\/tmp\/cursor-codex-[a-f0-9-]+$/.test(directory)) throw new Error('Invalid staging directory');
      const code = `import shutil;shutil.rmtree(${JSON.stringify(directory)},ignore_errors=True)`;
      const result = await exec(`python3 -c ${shellQuote(code)}`);
      if (result.code) throw new Error('Could not remove the remote staging directory');
    },
  };
}

async function dependencyRoot(name, from) {
  const require = createRequire(path.join(from, 'package.json'));
  let entry;
  try { entry = require.resolve(`${name}/package.json`); }
  catch { entry = require.resolve(name); }
  let directory = path.dirname(entry);
  while (true) {
    try { const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); if (pkg.name === name) return { directory, pkg }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot find installed dependency ${name}; run npm ci first`);
    directory = parent;
  }
}

/** Bundle installed pure-JS dependencies, including npx's hoisted layout. No remote npm access is needed. */
export async function buildRuntimeArchive({ root = packageRoot, run = runProcess } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-codex-package-'));
  const stage = path.join(temporary, 'runtime');
  try {
    await fs.mkdir(stage, { mode: 0o700 });
    for (const name of await fs.readdir(root)) {
      if (name.endsWith('.mjs') && !name.endsWith('.test.mjs') || ['package.json', 'package-lock.json', 'LICENSE'].includes(name)) {
        await fs.copyFile(path.join(root, name), path.join(stage, name));
      }
    }
    await fs.mkdir(path.join(stage, 'installer'));
    for (const name of await fs.readdir(path.join(root, 'installer'))) {
      if (name.endsWith('.mjs') && !name.endsWith('.test.mjs') || ['remote.py', 'bootstrap.py'].includes(name)) {
        await fs.copyFile(path.join(root, 'installer', name), path.join(stage, 'installer', name));
      }
    }
    await fs.cp(path.join(root, 'skills'), path.join(stage, 'skills'), { recursive: true });
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const copied = new Map();
    async function copyDependency(name, from) {
      const dependency = await dependencyRoot(name, from);
      if (copied.has(name)) {
        if (copied.get(name) !== dependency.pkg.version) throw new Error(`Cannot flatten multiple versions of ${name}`);
        return;
      }
      copied.set(name, dependency.pkg.version);
      await fs.cp(dependency.directory, path.join(stage, 'node_modules', name), { recursive: true, dereference: true });
      for (const child of Object.keys(dependency.pkg.dependencies || {})) await copyDependency(child, dependency.directory);
    }
    for (const name of Object.keys(pkg.dependencies || {})) await copyDependency(name, root);
    const archivePath = path.join(temporary, 'runtime.tgz');
    const result = await run('tar', ['-czf', archivePath, '-C', stage, '.']);
    if (result.code) throw new Error(`Cannot create runtime archive: ${result.stderr.trim()}`);
    return { archivePath, temporary, version: pkg.version, dependencies: Object.fromEntries(copied) };
  } catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
}

// Only unmodified published skills can be replaced automatically. Keep this
// list explicit so a local customization is never mistaken for an old release.
const publishedSkillHashes = new Set([
  '54096f63381f651ddac2750e2a2f4f8ecba6dc6efa0ef54631374ea009ff09e6', // v0.1.1
  'a4cd646810201eafc5d93034c7f073bbfb88b86b44625bd9b87bf9cb3cc671f4', // v0.1.2
  'bc235e5fad62a733abe8078aa182b3803c41c5506e1f5390240f5c2c6ec0371b', // v0.1.3
  'd642231eb0f837efb1adaab03986f4680711060e6e3750a7b02d2bc53392bcca', // v0.1.4
  '4de868b764aa57218e084522a160d5ea7870ebe67589c958ff9c68e25de91f1c', // v0.1.5
  'b0c6774e1d99c8d5b2a9ee22bacca70ab073ce9f4ae573f45d360228b6888a5d', // v0.1.6
  'c94336b2d17b907cb107bacaf5e416d00b30f0f6c256a2aae5a95148c145f129', // v0.1.7
  '283db7f5c4b6423c03ad926a1d5f8d03e829cfd4dcb1e14bd688b0800e08ea2f', // v0.1.8
  '047dfc40e0e33537ec18dd14836fac1eb3b3f18eec7823e77cb3cf53484207c6', // v0.1.9
  '08624899418b8465ea31901d19913da126e3992d458a43432a0cfd5a2bef1e55', // v0.1.10
  '5cc08aeb33c7101fd017b13a0d196709c2f7665ae47b59793ec91e932946d0fa', // v0.1.11
]);
const publishedSkillMetadataHash = '63b8acb9292c020c48526eade247f7c18ceeb6928155eb400b3071b0ff2bc027';
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function readSkillFiles(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill destination must be a regular directory');
  const files = new Map();
  for (const name of await fs.readdir(directory)) {
    const filename = path.join(directory, name);
    const entry = await fs.lstat(filename);
    if (name === 'agents' && entry.isDirectory() && !entry.isSymbolicLink()) {
      const names = await fs.readdir(filename);
      if (names.length !== 1 || names[0] !== 'openai.yaml') throw new Error(`Unexpected files in skill directory: ${filename}`);
      const metadata = path.join(filename, 'openai.yaml');
      if (!(await fs.lstat(metadata)).isFile()) throw new Error(`Skill file must be a regular file: ${metadata}`);
      files.set('agents/openai.yaml', await fs.readFile(metadata));
    } else if (name === 'SKILL.md' && entry.isFile()) files.set(name, await fs.readFile(filename));
    else throw new Error(`Unexpected or non-regular file in skill directory: ${filename}`);
  }
  if (!files.has('SKILL.md')) throw new Error(`Skill is missing SKILL.md: ${directory}`);
  return files;
}

export async function installSkill({ env = process.env, skillDir, dryRun = false, root = packageRoot } = {}) {
  const name = 'install-cursor-codex-bridge';
  const parent = path.resolve(skillDir || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills'));
  const destination = path.join(parent, name);
  const source = path.join(root, 'skills', name);
  const sourceFiles = await readSkillFiles(source);
  let exists = false;
  try { const stat = await fs.lstat(destination); exists = true; if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Skill destination must be a regular directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    const targetFiles = await readSkillFiles(destination);
    if (sourceFiles.get('SKILL.md').equals(targetFiles.get('SKILL.md'))) {
      // Preserve the user's existing UI metadata when the instructions match.
      return { ok: true, action: 'install-skill', destination, changed: false, dryRun };
    }
    if (targetFiles.size !== 2 || !publishedSkillHashes.has(sha256(targetFiles.get('SKILL.md')))
      || sha256(targetFiles.get('agents/openai.yaml') || '') !== publishedSkillMetadataHash) {
      throw new Error(`An existing skill differs at ${destination}; preserve or remove it before installing this version`);
    }
  }
  const backup = exists ? path.join(path.dirname(parent), 'skill-backups',
    `${name}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`) : undefined;
  if (!dryRun) {
    await fs.mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.${name}-${randomUUID()}`);
    let backedUp = false;
    try {
      await fs.mkdir(staging, { mode: 0o700 });
      for (const [name, contents] of sourceFiles) {
        const filename = path.join(staging, name);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, contents, { flag: 'wx', mode: 0o600 });
      }
      if (backup) {
        await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
        await fs.rename(destination, backup);
        backedUp = true;
      }
      try { await fs.rename(staging, destination); }
      catch (error) {
        if (backedUp) {
          try { await fs.rename(backup, destination); }
          catch (rollbackError) { throw new Error(`Skill update failed; original skill is retained at ${backup}: ${rollbackError.message}`, { cause: error }); }
        }
        throw error;
      }
    }
    finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  return { ok: true, action: 'install-skill', destination, changed: true, dryRun, ...(backup ? { backup } : {}) };
}

function requestFor(options, id) {
  return { id, ...(options['node-path'] ? { nodePath: options['node-path'] } : {}),
    ...(options['agent-path'] ? { agentPath: options['agent-path'] } : {}),
    ...(options['codex-path'] ? { codexPath: options['codex-path'] } : {}) };
}

export async function manage(options, dependencies = {}) {
  const env = dependencies.env || process.env;
  if (options.action === 'install-skill') return installSkill({ env, skillDir: options['skill-dir'], dryRun: options['dry-run'], root: dependencies.root });
  const ssh = dependencies.ssh || createSshClient(options, { env });
  const id = installationId(options.alias);
  const configPath = path.resolve(options['ssh-config'] || path.join(os.homedir(), '.ssh', 'config'));
  const hostOptions = { configPath, alias: options.alias, sourceAlias: options.ssh, installationId: id };
  const request = requestFor(options, id);
  const checks = [];
  const progress = dependencies.progress || (() => {});
  const config = await ssh.config();
  const hostState = await (dependencies.inspectHost || inspectHost)(hostOptions);
  if (hostState.status === 'conflict') throw new Error(hostState.reason);
  progress('Checking SSH environment forwarding and remote prerequisites…');
  const activationEnv = hostState.activationEnv || 'CODEX_HOME';
  let selectedEnv = activationEnv;
  let environmentAccepted = await ssh.environment(`/tmp/cursor-codex-probe-${randomUUID()}`, { variable: selectedEnv });
  if (!environmentAccepted && hostState.status !== 'owned') {
    selectedEnv = 'LC_CURSOR_CODEX_BRIDGE';
    environmentAccepted = await ssh.environment(`/tmp/cursor-codex-probe-${randomUUID()}`, { variable: selectedEnv });
  }
  hostOptions.activationEnv = selectedEnv;
  checks.push({ name: 'ssh-environment', ok: environmentAccepted,
    message: environmentAccepted ? `${selectedEnv} forwarding works` : 'The SSH server accepts neither CODEX_HOME nor LC_CURSOR_CODEX_BRIDGE. Enable one in sshd AcceptEnv or use a compatible connection; no server settings were changed.' });
  let probe;
  try { probe = await ssh.remote('probe', request); }
  catch (error) {
    if (options.action !== 'doctor') throw error;
    checks.push({ name: 'remote-prerequisites', ok: false, message: error.message });
    return { ok: false, action: options.action, sourceAlias: options.ssh, alias: options.alias, checks, remote: error.details || null };
  }
  if (probe.installed && probe.activationEnv && probe.activationEnv !== selectedEnv && hostState.status !== 'owned') {
    selectedEnv = probe.activationEnv;
    environmentAccepted = await ssh.environment(`/tmp/cursor-codex-probe-${randomUUID()}`, { variable: selectedEnv });
    checks[0] = { name: 'ssh-environment', ok: environmentAccepted, message: `${selectedEnv} forwarding ${environmentAccepted ? 'works' : 'is blocked'}` };
    hostOptions.activationEnv = selectedEnv;
  }
  const installing = ['install', 'upgrade'].includes(options.action);
  if (options.action === 'upgrade' && (!probe.installed || hostState.status !== 'owned')) throw new Error('No complete managed installation found; use install first');
  if (installing && probe.busy) throw new Error('The dedicated bridge has an active turn; wait for it to finish before changing the installation');
  const needsRuntime = !probe.runtime?.node?.path || !probe.runtime?.codex?.path;
  const nonRuntimeErrors = (probe.errors || []).filter(error => !['NODE_REQUIRED', 'CODEX_REQUIRED'].includes(error.code) && !(error.code === 'AGENT_REQUIRED' && !probe.runtime?.node?.path));
  const canProvision = installing && environmentAccepted && needsRuntime && !nonRuntimeErrors.length && probe.platform === 'Linux' && !options['node-path'] && !options['codex-path'];
  if (canProvision && !options['dry-run']) {
    progress('Installing missing Node/Codex runtimes in a private user directory…');
    const provisioned = await ssh.remote('bootstrap', { needNode: !probe.runtime?.node?.path, needCodex: !probe.runtime?.codex?.path, nodePath: probe.runtime?.node?.path });
    probe = await ssh.remote('probe', { ...request, ...provisioned.paths });
  }
  const runtimeReady = probe.ready ?? probe.prerequisites?.ok ?? Boolean(probe.runtime?.node?.path && probe.runtime?.agent?.loggedIn && probe.runtime?.agent?.acp && probe.runtime?.codex?.path);
  checks.push({ name: 'remote-prerequisites', ok: runtimeReady, message: runtimeReady ? 'Remote runtimes and Cursor login are available' : 'Remote prerequisites are incomplete; inspect remote diagnostics' });
  const profileHome = probe.paths.profileHome;
  // Validate the generated SSH block before either machine is modified.
  const block = renderManagedHost({ ...hostOptions, sshConfig: config, profileHome });
  await ssh.validate?.(block);
  if (options.action === 'doctor') {
    checks.push({ name: 'installation', ok: Boolean(probe.installed), message: probe.installed ? 'Remote bridge is installed' : 'Not installed; run install --ssh with the source alias' });
    if (probe.installed && probe.health) checks.push({ name: 'installed-files', ok: probe.health.ok,
      message: probe.health.ok ? 'Installed wrapper, release, and dependencies are intact' : `Installed files need repair: ${(probe.health.errors || []).map(error => error.message || error).join('; ')}` });
    checks.push({ name: 'managed-ssh-alias', ok: hostState.status === 'owned', message: `Managed SSH alias ${options.alias}: ${hostState.status}` });
    if (hostState.status === 'owned') {
      const activated = await ssh.exec(activationCommand(), { alias: options.alias });
      checks.push({ name: 'native-launch-path', ok: activated.code === 0 && activated.stdout === probe.paths.bin,
        message: activated.code === 0 && activated.stdout === probe.paths.bin ? 'SSH starts the dedicated bridge wrapper' : 'Login shell did not activate CODEX_INSTALL_DIR; inspect the managed profile block' });
    }
    return { ok: checks.every(check => check.ok), action: options.action, sourceAlias: options.ssh, alias: options.alias, checks, remote: probe };
  }
  if (options.action === 'uninstall') {
    // Uninstallation remains possible when Agent or Codex has since been removed.
    if (options['dry-run']) return { ok: true, action: options.action, dryRun: true, alias: options.alias, remote: probe, retainedHistory: profileHome };
    progress('Removing owned bridge programs and configuration; retaining history…');
    const result = await ssh.remote('uninstall', request);
    const local = await (dependencies.removeHost || removeHost)(hostOptions);
    return { ok: true, action: options.action, alias: options.alias, remote: result, local, retainedHistory: profileHome };
  }
  if (!environmentAccepted || !runtimeReady && !(canProvision && options['dry-run'])) {
    const error = new Error(checks.filter(check => !check.ok).map(check => check.message).join('; '));
    error.details = { checks, remote: probe }; throw error;
  }
  if (options['dry-run']) return { ok: true, action: options.action, dryRun: true, sourceAlias: options.ssh, alias: options.alias, checks, provisionRuntimes: canProvision, remote: probe };
  let bundle, upload, deployed = false, local;
  try {
    progress('Packaging the bridge with its dependencies…');
    bundle = await (dependencies.buildRuntimeArchive || buildRuntimeArchive)();
    upload = await ssh.upload(bundle.archivePath);
    progress('Installing the remote bridge…');
    const result = await ssh.remote('install', { ...request, activationEnv: selectedEnv, version: bundle.version, archivePath: upload.archivePath });
    deployed = true;
    local = await (dependencies.installHost || installHost)({ ...hostOptions, sshConfig: config, profileHome });
    const activation = await ssh.exec(activationCommand(), { alias: options.alias });
    if (activation.code || activation.stdout !== result.paths.bin) throw new Error('The installed alias did not activate the dedicated bridge. Run doctor to inspect shell startup configuration.');
    return { ok: true, action: options.action, sourceAlias: options.ssh, alias: options.alias, version: bundle.version,
      local, remote: result, next: `In Codex desktop SSH connections, enable ${options.alias}, open a remote project, and select a Cursor model.` };
  } catch (error) {
    if (deployed && !probe.installed) {
      const rollbackErrors = [];
      try { await ssh.remote('uninstall', request); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      if (local?.changed) try { await (dependencies.removeHost || removeHost)(hostOptions); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      if (rollbackErrors.length) error.message += ` Rollback incomplete: ${rollbackErrors.join('; ')}`;
      else error.message += ' The new remote installation and managed alias were rolled back; history was retained.';
    } else if (deployed) error.message += ' Remote version was installed; existing history and previous release are retained. Run doctor before reconnecting.';
    throw error;
  } finally {
    if (upload) try { await ssh.cleanup(upload.directory); } catch (error) { progress(error.message); }
    if (bundle) await fs.rm(bundle.temporary, { recursive: true, force: true });
  }
}

export async function managementMain(args, { env = process.env, stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  let options;
  try {
    options = parseManagementArgs(args);
    if (options.help) {
      stdout.write(`Usage: cursor-codex ${options.action} ${options.action === 'install-skill' ? '[--skill-dir PARENT]' : '--ssh EXISTING_ALIAS [--alias NEW_ALIAS] [--ssh-config PATH]'} [--dry-run] [--json]\n`);
      return;
    }
    const result = await manage(options, { env, progress: value => { if (!options.json) stderr.write(`${value}\n`); }, ...dependencies });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      stdout.write(`${result.ok ? 'OK' : 'FAILED'}: ${result.action}${result.dryRun ? ' (dry run)' : ''}${result.alias ? ` — ${result.alias}` : ''}\n`);
      for (const check of result.checks || []) stdout.write(`  ${check.ok ? '✓' : '✗'} ${check.message}\n`);
      if (result.next) stdout.write(`${result.next}\n`);
      if (result.destination) stdout.write(`Skill: ${result.destination}\n`);
      if (result.backup) stdout.write(`Skill backup${result.dryRun ? ' (planned)' : ''}: ${result.backup}\n`);
      if (result.retainedHistory) stdout.write(`Retained bridge history: ${result.retainedHistory}\n`);
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  } catch (error) {
    if (options?.json || args.includes('--json')) stdout.write(`${JSON.stringify({ ok: false, action: options?.action || args[0], error: { code: error.code || 'INSTALLER_ERROR', message: error.message }, ...(error.details ? { details: error.details } : {}) }, null, 2)}\n`);
    else stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return { ok: false, error };
  }
}
