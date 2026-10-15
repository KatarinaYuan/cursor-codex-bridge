import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { inspectHost, installHost, removeHost, renderManagedHost, resolveHostConfig, validateAlias } from './local-config.mjs';

const exec = promisify(execFile);
const effectiveText = [
  'host dev', 'hostname 192.0.2.12', 'user developer', 'port 2222',
  'identityfile ~/.ssh/team key', 'identitiesonly yes',
  'proxycommand ssh -W %h:%p gateway-%n', 'identityagent none',
  'serveraliveinterval 30', 'serveralivecountmax 3',
  'userknownhostsfile /tmp/known hosts /tmp/other',
  'hostkeyalias original-key', 'setenv CODEX_HOME=/old/profile',
  'setenv LC_CURSOR_CODEX_BRIDGE=/other/bridge',
  'setenv TEAM=a b', 'setenv Codex_home=case-sensitive',
  'remotecommand unexpected-command', 'requesttty force',
].join('\n');
const effective = resolveHostConfig(effectiveText);

async function fixture(t, original = '# Existing settings\nHost dev\n  HostName 192.0.2.12\n  User developer\n') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-ssh-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config');
  if (original !== null) await fs.writeFile(configPath, original);
  return {
    directory, original,
    options: { configPath, alias: 'dev-cursor', sourceAlias: 'dev', installationId: 'abc123', profileHome: '/home/developer/.codex cursor', sshConfig: effective },
  };
}

test('alias validation prevents option and SSH configuration injection', () => {
  assert.equal(validateAlias('team.dev-01_cursor'), 'team.dev-01_cursor');
  for (const value of ['', '-F', 'dev\nHost *', 'dev other', '*', '../config', null]) assert.throws(() => validateAlias(value));
});

test('effective host configuration is JSON serializable and preserves repeated options', () => {
  const config = resolveHostConfig(`${effectiveText}\nidentityfile /tmp/second\n`);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), config);
  assert.equal(config.hostname, '192.0.2.12');
  assert.equal(config.user, 'developer');
  assert.equal(config.port, 2222);
  assert.equal(config.entries.filter(({ keyword }) => keyword === 'identityfile').length, 2);
  assert.throws(() => resolveHostConfig('hostname server'));
  assert.throws(() => resolveHostConfig('not-a-valid-option value'));
});

test('managed block overrides only CODEX_HOME and preserves proxy command and path spaces', () => {
  const block = renderManagedHost({ alias: 'dev-cursor', sourceAlias: 'dev', installationId: 'abc123', profileHome: '/home/developer/.codex cursor', sshConfig: effective });
  assert.match(block, /SetEnv "CODEX_HOME=\/home\/developer\/\.codex cursor"/);
  assert.doesNotMatch(block, /\/old\/profile/);
  assert.doesNotMatch(block, /\/other\/bridge/);
  assert.match(block, /"TEAM=a b"/);
  assert.match(block, /"Codex_home=case-sensitive"/);
  assert.match(block, /proxycommand ssh -W %h:%p gateway-dev/);
  assert.match(block, /identityfile "~\/\.ssh\/team key"/);
  assert.match(block, /userknownhostsfile "\/tmp\/known hosts" "\/tmp\/other"/);
  assert.match(block, /identityagent "none"/);
  assert.doesNotMatch(block, /remotecommand|requesttty/);
  assert.match(block, /Host \*\n# <<</);
  assert.throws(() => renderManagedHost({ alias: 'dev', sourceAlias: 'DEV', installationId: 'abc123', profileHome: '/home/dev/.codex', sshConfig: effective }), /must differ/);
});

test('activation variable selection is restricted to the two supported names', () => {
  const options = { alias: 'dev-cursor', sourceAlias: 'dev', installationId: 'abc123', profileHome: '/home/dev/.codex', sshConfig: effective };
  const block = renderManagedHost({ ...options, activationEnv: 'LC_CURSOR_CODEX_BRIDGE' });
  assert.match(block, /SetEnv "LC_CURSOR_CODEX_BRIDGE=\/home\/dev\/\.codex"/);
  assert.doesNotMatch(block, /"CODEX_HOME=/);
  assert.match(block, /"TEAM=a b"/);
  for (const activationEnv of ['PATH', 'HOME', 'LC_SOMETHING', '', null]) assert.throws(() => renderManagedHost({ ...options, activationEnv }), /activationEnv/);
});

test('install and uninstall preserve every original byte and keep private backups', async (t) => {
  const { options, original } = await fixture(t);
  assert.equal((await inspectHost(options)).status, 'missing');
  const installed = await installHost(options);
  assert.equal(installed.changed, true);
  assert.equal((await fs.stat(options.configPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(installed.backupPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(installed.manifestPath))).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(installed.backupPath, 'utf8'), original);
  assert.equal((await inspectHost(options)).status, 'owned');
  assert.equal((await inspectHost(options)).activationEnv, 'CODEX_HOME');
  const after = await fs.readFile(options.configPath, 'utf8');
  assert.ok(after.endsWith(original));
  assert.equal((await installHost(options)).changed, false);
  await fs.appendFile(options.configPath, '# User edit outside block\n');
  assert.equal((await removeHost(options)).changed, true);
  assert.equal(await fs.readFile(options.configPath, 'utf8'), original + '# User edit outside block\n');
  assert.equal((await removeHost(options)).changed, false);
});

test('inspect reports the saved activation variable and defaults older manifests to CODEX_HOME', async (t) => {
  const { options } = await fixture(t);
  const installed = await installHost({ ...options, activationEnv: 'LC_CURSOR_CODEX_BRIDGE' });
  assert.equal((await inspectHost(options)).activationEnv, 'LC_CURSOR_CODEX_BRIDGE');
  assert.equal(JSON.parse(await fs.readFile(installed.manifestPath, 'utf8')).activationEnv, 'LC_CURSOR_CODEX_BRIDGE');
  await installHost(options);
  const manifest = JSON.parse(await fs.readFile(installed.manifestPath, 'utf8'));
  delete manifest.activationEnv;
  await fs.writeFile(installed.manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.equal((await inspectHost(options)).activationEnv, 'CODEX_HOME');
});

test('owned upgrades replace only the block and preserve installation creation metadata', async (t) => {
  const { options, original } = await fixture(t);
  const first = await installHost(options);
  const beforeManifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf8'));
  const second = await installHost({ ...options, profileHome: '/home/developer/new-profile' });
  assert.equal(second.changed, true);
  assert.ok((await fs.readFile(options.configPath, 'utf8')).endsWith(original));
  const afterManifest = JSON.parse(await fs.readFile(first.manifestPath, 'utf8'));
  assert.equal(afterManifest.createdAt, beforeManifest.createdAt);
  assert.equal(afterManifest.backupPaths.length, 2);
  assert.equal((await inspectHost(options)).status, 'owned');
});

test('edited managed blocks cannot be updated or deleted', async (t) => {
  const { options } = await fixture(t);
  await installHost(options);
  const edited = (await fs.readFile(options.configPath, 'utf8')).replace('hostname "192.0.2.12"', 'hostname "192.0.2.99"');
  await fs.writeFile(options.configPath, edited);
  assert.equal((await inspectHost(options)).status, 'conflict');
  await assert.rejects(installHost(options), /was edited/);
  await assert.rejects(removeHost(options), /was edited/);
  assert.equal(await fs.readFile(options.configPath, 'utf8'), edited);
});

test('unowned aliases including quoted names cannot be overwritten', async (t) => {
  const { options, original } = await fixture(t, 'Host "dev-cursor" another\n  HostName user-server\n');
  assert.equal((await inspectHost(options)).status, 'conflict');
  await assert.rejects(installHost(options), /already exists/);
  assert.equal(await fs.readFile(options.configPath, 'utf8'), original);
});

test('different installation IDs cannot claim an owned alias', async (t) => {
  const { options } = await fixture(t);
  await installHost(options);
  const other = { ...options, installationId: 'somebody-else' };
  assert.equal((await inspectHost(other)).status, 'conflict');
  await assert.rejects(removeHost(other), /different installation/);
});

test('symlink configuration is never followed or replaced', async (t) => {
  const { options, directory } = await fixture(t, null);
  const target = path.join(directory, 'actual-config');
  await fs.writeFile(target, '# preserved\n');
  await fs.symlink(target, options.configPath);
  await assert.rejects(installHost(options), /symlink/);
  assert.equal((await fs.lstat(options.configPath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), '# preserved\n');
});

test('symlink manifest and private metadata directory are rejected', async (t) => {
  const first = await fixture(t);
  const probe = await inspectHost(first.options);
  await fs.mkdir(path.dirname(probe.manifestPath), { mode: 0o700 });
  const target = path.join(first.directory, 'metadata');
  await fs.writeFile(target, '{}');
  await fs.symlink(target, probe.manifestPath);
  await assert.rejects(installHost(first.options), /symlink/);
  const second = await fixture(t);
  const privateDir = path.join(second.directory, 'metadata');
  await fs.mkdir(privateDir);
  await fs.symlink(privateDir, path.join(second.directory, '.cursor-codex-bridge'));
  await assert.rejects(installHost(second.options), /symlink/);
});

test('missing original config can be installed and uninstalled', async (t) => {
  const { options } = await fixture(t, null);
  await installHost(options);
  await removeHost(options);
  await assert.rejects(fs.readFile(options.configPath), { code: 'ENOENT' });
});

test('explicit alias outside an owned block prevents destructive removal', async (t) => {
  const { options } = await fixture(t);
  await installHost(options);
  await fs.appendFile(options.configPath, 'Host dev-cursor\n  HostName something-else\n');
  await assert.rejects(removeHost(options), /outside the managed block/);
});

test('alias collisions in nested quoted Include globs are detected before mutation', async (t) => {
  const { options, directory } = await fixture(t);
  const included = path.join(directory, 'config fragments');
  await fs.mkdir(included);
  await fs.writeFile(path.join(included, 'first.conf'), `Include "${path.join(included, 'nested')}"\n`);
  await fs.writeFile(path.join(included, 'nested'), 'Host DEV-CURSOR\n HostName preserve-me\n');
  const original = `Include "${path.join(included, '*.conf')}"\nHost dev\n HostName example.invalid\n`;
  await fs.writeFile(options.configPath, original);
  const inspected = await inspectHost(options);
  assert.equal(inspected.status, 'conflict');
  assert.match(inspected.reason, /included configuration/);
  await assert.rejects(installHost(options), /included configuration/);
  assert.equal(await fs.readFile(options.configPath, 'utf8'), original);
});

test('unmatched Include globs and ordinary source aliases remain supported', async (t) => {
  const { options, directory } = await fixture(t);
  await fs.writeFile(options.configPath, `Include "${path.join(directory, 'absent', '*')}"\nHost dev\n HostName source\n`);
  assert.equal((await inspectHost(options)).status, 'missing');
  await installHost(options);
  await removeHost(options);
});

test('config operations do not overwrite non-UTF-8 bytes', async (t) => {
  const { options } = await fixture(t);
  const original = Buffer.from([0x23, 0xff, 0xfe]);
  await fs.writeFile(options.configPath, original);
  await assert.rejects(installHost(options), /non-UTF-8/);
  assert.deepEqual(await fs.readFile(options.configPath), original);
});

test('OpenSSH round trip preserves effective complex authentication, proxy and environment values', async (t) => {
  const original = [
    '# retain exactly', 'Host source', ' HostName example.invalid', ' User alice', ' Port 2223',
    ' IdentityFile "~/.ssh/a b"', ' CertificateFile "~/.ssh/cert file"',
    ' IdentitiesOnly yes', ' IdentityAgent none', ' ProxyCommand ssh -W %h:%p gateway-%n',
    ' HostKeyAlias source-key', ' UserKnownHostsFile "~/.ssh/known hosts" ~/.ssh/other',
    ' ServerAliveInterval 15', ' SetEnv FOO="a b" CODEX_HOME=/old',
    'Host *', ' ServerAliveCountMax 4', '',
  ].join('\n');
  const { options, directory } = await fixture(t, original);
  let source;
  try { source = (await exec('ssh', ['-G', '-F', options.configPath, 'source'])).stdout; }
  catch (error) { if (error.code === 'ENOENT') { t.skip('OpenSSH is not installed'); return; } throw error; }
  const parsed = resolveHostConfig(source);
  await installHost({ ...options, sourceAlias: 'source', sshConfig: parsed });
  const target = resolveHostConfig((await exec('ssh', ['-G', '-F', options.configPath, options.alias])).stdout);
  const values = (config, keyword) => config.entries.filter((entry) => entry.keyword === keyword).map((entry) => entry.value);
  for (const keyword of ['hostname', 'user', 'port', 'identityfile', 'certificatefile', 'identitiesonly', 'identityagent', 'hostkeyalias', 'userknownhostsfile', 'serveraliveinterval', 'serveralivecountmax']) {
    assert.deepEqual(values(target, keyword), values(parsed, keyword), keyword);
  }
  assert.deepEqual(values(target, 'proxycommand'), ['ssh -W %h:%p gateway-source']);
  assert.deepEqual(values(target, 'setenv'), [`CODEX_HOME=${options.profileHome}`, 'FOO=a b']);
  const intentionallyChanged = new Set(['host', 'setenv', 'proxycommand', 'remotecommand', 'localcommand', 'permitlocalcommand', 'requesttty', 'sessiontype', 'stdinnull', 'forkafterauthentication', 'localforward', 'remoteforward', 'dynamicforward', 'clearallforwardings']);
  for (const keyword of new Set(parsed.entries.map((entry) => entry.keyword))) {
    if (!intentionallyChanged.has(keyword)) assert.deepEqual(values(target, keyword), values(parsed, keyword), keyword);
  }
  const sourceAfter = resolveHostConfig((await exec('ssh', ['-G', '-F', options.configPath, 'source'])).stdout);
  assert.deepEqual(sourceAfter, parsed);
  assert.ok(directory);
});

test('OpenSSH round trip retains ProxyJump, Match-effective values, and multi-argument options', async (t) => {
  const original = [
    'Host source', ' HostName example.invalid', ' User alice',
    ' ProxyJump alice@gateway.invalid:2200,bob@gateway2.invalid',
    ' CanonicalDomains example.invalid other.invalid',
    ' PermitRemoteOpen localhost:80 localhost:443',
    ' IPQoS lowdelay throughput', ' RekeyLimit 1G 1h',
    'Match originalhost source', ' ServerAliveInterval 47', '',
  ].join('\n');
  const { options } = await fixture(t, original);
  let output;
  try { output = (await exec('ssh', ['-G', '-F', options.configPath, 'source'])).stdout; }
  catch (error) { if (error.code === 'ENOENT') { t.skip('OpenSSH is not installed'); return; } throw error; }
  const source = resolveHostConfig(output);
  await installHost({ ...options, sourceAlias: 'source', sshConfig: source });
  const target = resolveHostConfig((await exec('ssh', ['-G', '-F', options.configPath, options.alias])).stdout);
  for (const keyword of ['proxyjump', 'canonicaldomains', 'permitremoteopen', 'ipqos', 'rekeylimit', 'serveraliveinterval']) {
    assert.deepEqual(target.entries.filter((entry) => entry.keyword === keyword), source.entries.filter((entry) => entry.keyword === keyword), keyword);
  }
});

test('OpenSSH fallback activation uses LC_CURSOR_CODEX_BRIDGE and retains source authentication', async (t) => {
  const original = [
    'Host dev', ' HostName example.invalid', ' User alice', ' Port 2223',
    ' IdentityFile "~/.ssh/developer key"', ' IdentitiesOnly yes',
    ' ProxyJump alice@gateway.invalid:2200',
    ' SetEnv CODEX_HOME=/original LC_CURSOR_CODEX_BRIDGE=/previous TEAM="a b"', '',
  ].join('\n');
  const { options } = await fixture(t, original);
  let output;
  try { output = (await exec('ssh', ['-G', '-F', options.configPath, 'dev'])).stdout; }
  catch (error) { if (error.code === 'ENOENT') { t.skip('OpenSSH is not installed'); return; } throw error; }
  const source = resolveHostConfig(output);
  await installHost({ ...options, sshConfig: source, activationEnv: 'LC_CURSOR_CODEX_BRIDGE' });
  const target = resolveHostConfig((await exec('ssh', ['-G', '-F', options.configPath, options.alias])).stdout);
  for (const keyword of ['hostname', 'user', 'port', 'identityfile', 'identitiesonly', 'proxyjump']) {
    assert.deepEqual(target.entries.filter((entry) => entry.keyword === keyword), source.entries.filter((entry) => entry.keyword === keyword), keyword);
  }
  assert.deepEqual(target.entries.filter((entry) => entry.keyword === 'setenv').map((entry) => entry.value), [`LC_CURSOR_CODEX_BRIDGE=${options.profileHome}`, 'TEAM=a b']);
  assert.equal((await inspectHost(options)).activationEnv, 'LC_CURSOR_CODEX_BRIDGE');
});
