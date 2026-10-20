import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildRuntimeArchive, createSshClient, installationId, installSkill, manage,
  managementMain, parseManagementArgs, runProcess, shellQuote,
} from './manage.mjs';
import { resolveHostConfig } from './local-config.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const effective = resolveHostConfig('host dev\nhostname 192.0.2.10\nuser developer\nport 2222\nidentityfile /tmp/test-key\n');
const remotePaths = {
  profileHome: '/home/developer/.local/share/cursor-codex-bridge/test/profile',
  bin: '/home/developer/.local/share/cursor-codex-bridge/test/bin',
};
const completeRuntime = {
  node: { path: '/opt/node/bin/node' },
  agent: { path: '/opt/cursor/agent', loggedIn: true, acp: true },
  codex: { path: '/opt/codex/bin/codex' },
};

async function temporary(t, prefix = 'cursor-manage-test-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function scenario(t, overrides = {}) {
  const directory = await temporary(t);
  const calls = [];
  const options = parseManagementArgs(['install', '--ssh', 'dev', '--ssh-config', path.join(directory, 'config')]);
  Object.assign(options, overrides.options);
  const probe = { ok: true, ready: true, installed: false, busy: false, paths: remotePaths, platform: 'Linux', runtime: completeRuntime, ...overrides.probe };
  const state = { status: 'missing', ...overrides.state };
  const bundleDirectory = path.join(directory, 'package');
  const dependencies = {
    env: { CODEX_HOME: path.join(directory, 'codex'), PATH: process.env.PATH },
    ssh: {
      async config() { calls.push(['config']); return effective; },
      async environment(value, settings) {
        calls.push(['environment', value, settings]);
        if (overrides.environment && typeof overrides.environment === 'object') return overrides.environment[settings.variable] ?? false;
        return overrides.environment ?? true;
      },
      async remote(action, request) {
        calls.push(['remote', action, request]);
        if (action === 'probe') {
          if (overrides.probeError) throw overrides.probeError;
          return overrides.probeSequence?.[calls.filter(([name, action]) => name === 'remote' && action === 'probe').length - 1] || probe;
        }
        if (action === 'bootstrap') {
          if (overrides.bootstrapError) throw overrides.bootstrapError;
          return { ok: true, paths: overrides.bootstrapPaths || { nodePath: '/home/developer/.local/share/cursor-codex-bridge/runtimes/node/bin/node', codexPath: '/home/developer/.local/share/cursor-codex-bridge/runtimes/codex/bin/codex' } };
        }
        if (action === 'install' && overrides.deployError) throw overrides.deployError;
        if (action === 'uninstall' && overrides.rollbackError) throw overrides.rollbackError;
        return { ok: true, paths: remotePaths, retainedHistory: remotePaths.profileHome };
      },
      async upload(archivePath) { calls.push(['upload', archivePath]); return { directory: '/tmp/cursor-codex-abcd', archivePath: '/tmp/cursor-codex-abcd/runtime.tgz' }; },
      async exec(command, settings) {
        calls.push(['exec', command, settings]);
        return { code: 0, stderr: '', stdout: overrides.activation ?? remotePaths.bin };
      },
      async cleanup(value) { calls.push(['cleanup', value]); if (overrides.cleanupError) throw overrides.cleanupError; },
    },
    async inspectHost(value) { calls.push(['inspectHost', value]); return state; },
    async installHost(value) {
      calls.push(['installHost', value]);
      if (overrides.localError) throw overrides.localError;
      return { changed: true, alias: value.alias };
    },
    async removeHost(value) { calls.push(['removeHost', value]); return { changed: true }; },
    async buildRuntimeArchive() {
      calls.push(['buildRuntimeArchive']);
      await fs.mkdir(bundleDirectory);
      const archivePath = path.join(bundleDirectory, 'runtime.tgz');
      await fs.writeFile(archivePath, 'fake archive');
      return { temporary: bundleDirectory, archivePath, version: '0.1.0' };
    },
    progress(value) { calls.push(['progress', value]); },
  };
  return { directory, calls, options, dependencies, probe, bundleDirectory };
}

function mutations(calls) {
  return calls.filter(([name, action]) => ['buildRuntimeArchive', 'upload', 'installHost', 'removeHost', 'cleanup'].includes(name)
    || name === 'remote' && action !== 'probe');
}

test('management arguments support flags and values without treating shell input as aliases', () => {
  assert.deepEqual(parseManagementArgs(['install', '--ssh=team.dev-1', '--alias', 'team-cursor', '--json', '--dry-run']), {
    action: 'install', ssh: 'team.dev-1', alias: 'team-cursor', json: true, 'dry-run': true,
  });
  assert.equal(parseManagementArgs(['upgrade', '--ssh', 'dev']).alias, 'dev-cursor');
  for (const action of ['doctor', 'uninstall']) assert.equal(parseManagementArgs([action, '--ssh', 'dev']).action, action);
  assert.deepEqual(parseManagementArgs(['install', '--help']), { action: 'install', help: true });
  assert.deepEqual(parseManagementArgs(['install-skill', '--skill-dir', '/tmp/skill parent']), { action: 'install-skill', 'skill-dir': '/tmp/skill parent' });
  for (const args of [
    [], ['unknown'], ['install'], ['install', '--ssh', '-dev'], ['install', '--ssh', 'dev\nHost *'],
    ['install', '--ssh', 'dev;echo x'], ['install', '--ssh', 'dev other'], ['install', '--ssh', '../dev'],
    ['install', '--ssh', 'dev', '--alias', 'DEV'], ['install', '--ssh', 'dev', '--alias', '*'],
    ['install', '--ssh', 'dev', '--ssh', 'other'], ['install', '--ssh', 'dev', '--json=true'],
    ['install', '--ssh', 'dev', '--unknown'], ['install', '--ssh', 'dev', 'extra'],
    ['install', '--ssh', '--json'], ['install', '--ssh', 'dev', '--agent-path', '/bin/agent\nother'],
    ['install', '--ssh', 'dev', '--skill-dir', '/tmp/skills'], ['install-skill', '--ssh', 'dev'],
  ]) assert.throws(() => parseManagementArgs(args), undefined, JSON.stringify(args));
});

test('installation IDs are stable across alias case and separate different aliases', () => {
  assert.match(installationId('dev-cursor'), /^[a-f0-9]{16}$/);
  assert.equal(installationId('Dev-Cursor'), installationId('dev-cursor'));
  assert.notEqual(installationId('other-cursor'), installationId('dev-cursor'));
});

test('dry-run validates both machines without packaging, uploading, or writing configuration', async t => {
  for (const action of ['install', 'upgrade', 'uninstall']) {
    const f = await scenario(t, { options: { action, 'dry-run': true }, probe: { installed: action !== 'install' }, state: { status: action === 'install' ? 'missing' : 'owned' } });
    const result = await manage(f.options, f.dependencies);
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.deepEqual(mutations(f.calls), []);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test('missing prerequisites and blocked CODEX_HOME forwarding reject before any mutation', async t => {
  for (const overrides of [{ probe: { ready: false } }, { environment: false }]) {
    const f = await scenario(t, overrides);
    await assert.rejects(manage(f.options, f.dependencies), /prerequisites|CODEX_HOME/);
    assert.deepEqual(mutations(f.calls), []);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test('a new installation falls back to LC forwarding and passes the selected mode to both configurations', async t => {
  const f = await scenario(t, { environment: { CODEX_HOME: false, LC_CURSOR_CODEX_BRIDGE: true } });
  const result = await manage(f.options, f.dependencies);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.filter(([name]) => name === 'environment').map(([, , settings]) => settings.variable), ['CODEX_HOME', 'LC_CURSOR_CODEX_BRIDGE']);
  for (const [name, action, request] of f.calls) {
    if (name === 'remote' && action === 'probe') assert.equal(Object.hasOwn(request, 'activationEnv'), false);
    if (name === 'remote' && action === 'install') assert.equal(request.activationEnv, 'LC_CURSOR_CODEX_BRIDGE');
  }
  assert.equal(f.calls.find(([name]) => name === 'installHost')[1].activationEnv, 'LC_CURSOR_CODEX_BRIDGE');
});

test('a remote LC installation can recover a missing local manifest without changing its activation mode', async t => {
  const f = await scenario(t, {
    state: { status: 'missing' }, probe: { installed: true, activationEnv: 'LC_CURSOR_CODEX_BRIDGE' },
    environment: { CODEX_HOME: true, LC_CURSOR_CODEX_BRIDGE: true },
  });
  assert.equal((await manage(f.options, f.dependencies)).ok, true);
  assert.deepEqual(f.calls.filter(([name]) => name === 'environment').map(([, , settings]) => settings.variable), ['CODEX_HOME', 'LC_CURSOR_CODEX_BRIDGE']);
  const probeRequest = f.calls.find(([name, action]) => name === 'remote' && action === 'probe')[2];
  assert.equal(Object.hasOwn(probeRequest, 'activationEnv'), false);
  assert.equal(f.calls.find(([name, action]) => name === 'remote' && action === 'install')[2].activationEnv, 'LC_CURSOR_CODEX_BRIDGE');
  assert.equal(f.calls.find(([name]) => name === 'installHost')[1].activationEnv, 'LC_CURSOR_CODEX_BRIDGE');

  const removal = await scenario(t, {
    options: { action: 'uninstall' }, state: { status: 'missing' },
    probe: { installed: true, ready: false, activationEnv: 'LC_CURSOR_CODEX_BRIDGE' }, environment: false,
  });
  const result = await manage(removal.options, removal.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.retainedHistory, remotePaths.profileHome);
  for (const [name, action, request] of removal.calls) {
    if (name === 'remote' && ['probe', 'uninstall'].includes(action)) assert.equal(Object.hasOwn(request, 'activationEnv'), false);
  }
  assert.equal(removal.calls.find(([name]) => name === 'removeHost')[1].activationEnv, 'LC_CURSOR_CODEX_BRIDGE');
});

test('an owned LC installation keeps its activation mode instead of switching to CODEX_HOME', async t => {
  const f = await scenario(t, {
    options: { action: 'upgrade' }, state: { status: 'owned', activationEnv: 'LC_CURSOR_CODEX_BRIDGE' },
    probe: { installed: true }, environment: { CODEX_HOME: true, LC_CURSOR_CODEX_BRIDGE: true },
  });
  assert.equal((await manage(f.options, f.dependencies)).ok, true);
  assert.deepEqual(f.calls.filter(([name]) => name === 'environment').map(([, , settings]) => settings.variable), ['LC_CURSOR_CODEX_BRIDGE']);
  assert.equal(f.calls.find(([name]) => name === 'installHost')[1].activationEnv, 'LC_CURSOR_CODEX_BRIDGE');
  const blocked = await scenario(t, {
    options: { action: 'upgrade' }, state: { status: 'owned', activationEnv: 'LC_CURSOR_CODEX_BRIDGE' },
    probe: { installed: true }, environment: { CODEX_HOME: true, LC_CURSOR_CODEX_BRIDGE: false },
  });
  await assert.rejects(manage(blocked.options, blocked.dependencies), /server accepts neither/);
  assert.deepEqual(blocked.calls.filter(([name]) => name === 'environment').map(([, , settings]) => settings.variable), ['LC_CURSOR_CODEX_BRIDGE']);
  assert.deepEqual(mutations(blocked.calls), []);
});

test('bootstrap provisions only missing runtimes and probes their explicit executable paths before installation', async t => {
  for (const [missingNode, missingCodex] of [[true, false], [false, true], [true, true]]) {
    const before = {
      ok: true, ready: false, installed: false, paths: remotePaths, platform: 'Linux',
      runtime: { ...completeRuntime, ...(missingNode ? { node: null } : {}), ...(missingCodex ? { codex: null } : {}) },
    };
    const bootstrapped = {
      ...(missingNode ? { nodePath: '/home/developer/private/node/bin/node' } : { nodePath: completeRuntime.node.path }),
      ...(missingCodex ? { codexPath: '/home/developer/private/codex/bin/codex' } : {}),
    };
    const after = { ...before, ready: true, runtime: completeRuntime };
    const f = await scenario(t, { probe: before, probeSequence: [before, after], bootstrapPaths: bootstrapped });
    assert.equal((await manage(f.options, f.dependencies)).ok, true);
    const remoteCalls = f.calls.filter(([name]) => name === 'remote');
    assert.deepEqual(remoteCalls.map(([, action]) => action), ['probe', 'bootstrap', 'probe', 'install']);
    assert.deepEqual(remoteCalls[1][2], { needNode: missingNode, needCodex: missingCodex, nodePath: before.runtime.node?.path });
    assert.deepEqual(remoteCalls[2][2], { id: installationId('dev-cursor'), ...bootstrapped });
    assert.ok(f.calls.findIndex(([name, action]) => name === 'remote' && action === 'bootstrap') < f.calls.findIndex(([name]) => name === 'buildRuntimeArchive'));
  }
});

test('runtime bootstrap also supports upgrade while explicit runtime paths and non-Linux hosts disable provisioning', async t => {
  const incomplete = { ready: false, installed: true, runtime: { ...completeRuntime, codex: null } };
  const upgrade = await scenario(t, {
    options: { action: 'upgrade' }, state: { status: 'owned' }, probe: incomplete,
    probeSequence: [
      { ...incomplete, ok: true, platform: 'Linux', paths: remotePaths },
      { ok: true, ready: true, installed: true, runtime: completeRuntime, platform: 'Linux', paths: remotePaths },
    ],
    bootstrapPaths: { nodePath: completeRuntime.node.path, codexPath: '/private/codex/bin/codex' },
  });
  assert.equal((await manage(upgrade.options, upgrade.dependencies)).ok, true);
  assert.equal(upgrade.calls.some(([name, action]) => name === 'remote' && action === 'bootstrap'), true);
  for (const overrides of [
    { options: { 'node-path': '/explicit/node' } },
    { options: { 'codex-path': '/explicit/codex' } },
    { probe: { platform: 'Darwin' } },
  ]) {
    const f = await scenario(t, { ...overrides, probe: { ready: false, runtime: { ...completeRuntime, codex: null }, ...overrides.probe } });
    await assert.rejects(manage(f.options, f.dependencies), /prerequisites are incomplete/);
    assert.deepEqual(mutations(f.calls), []);
  }
});

test('dry-run reports planned provisioning without bootstrapping, packaging, uploading, or creating files', async t => {
  const f = await scenario(t, { options: { 'dry-run': true }, probe: { ready: false, runtime: { ...completeRuntime, node: null, codex: null } } });
  const result = await manage(f.options, f.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.provisionRuntimes, true);
  assert.deepEqual(mutations(f.calls), []);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('dry-run cannot treat an Agent login or ACP error as a provisionable runtime problem', async t => {
  for (const [code, agent] of [
    ['AGENT_LOGIN_REQUIRED', { ...completeRuntime.agent, loggedIn: false }],
    ['ACP_REQUIRED', { ...completeRuntime.agent, acp: false }],
  ]) {
    const f = await scenario(t, {
      options: { 'dry-run': true }, probe: {
        ready: false, runtime: { ...completeRuntime, node: null, codex: null, agent },
        errors: [{ code: 'NODE_REQUIRED' }, { code: 'CODEX_REQUIRED' }, { code, message: 'Agent needs attention' }],
      },
    });
    await assert.rejects(manage(f.options, f.dependencies), /prerequisites are incomplete/);
    assert.deepEqual(mutations(f.calls), []);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test('doctor and uninstall never bootstrap missing runtimes', async t => {
  for (const action of ['doctor', 'uninstall']) {
    const f = await scenario(t, { options: { action }, probe: { ready: false, installed: true, runtime: { ...completeRuntime, node: null, codex: null } }, state: { status: 'owned' } });
    const result = await manage(f.options, f.dependencies);
    assert.equal(result.ok, action === 'uninstall');
    assert.equal(f.calls.some(([name, remoteAction]) => name === 'remote' && remoteAction === 'bootstrap'), false);
    assert.equal(f.calls.some(([name]) => name === 'buildRuntimeArchive' || name === 'upload'), false);
  }
});

test('bootstrap failures leave existing private runtimes alone and never deploy a bridge or alias', async t => {
  const f = await scenario(t, {
    probe: { ready: false, runtime: { ...completeRuntime, codex: null } },
    bootstrapError: Object.assign(new Error('Downloaded runtime failed checksum validation; private runtime retained'), { code: 'RUNTIME_CHECKSUM' }),
  });
  await assert.rejects(manage(f.options, f.dependencies), error => error.code === 'RUNTIME_CHECKSUM' && /private runtime retained/.test(error.message));
  assert.deepEqual(mutations(f.calls).map(([name, action]) => `${name}:${action}`), ['remote:bootstrap']);
  assert.equal(f.calls.some(([name, action]) => name === 'remote' && action === 'uninstall'), false);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('failed readiness after bootstrap cannot proceed to deployment or remove private runtimes', async t => {
  const before = { ok: true, ready: false, installed: false, platform: 'Linux', paths: remotePaths, runtime: { ...completeRuntime, node: null } };
  const f = await scenario(t, { probe: before, probeSequence: [before, before], bootstrapPaths: { nodePath: '/private/node/bin/node' } });
  await assert.rejects(manage(f.options, f.dependencies), /prerequisites are incomplete/);
  assert.deepEqual(mutations(f.calls).map(([name, action]) => `${name}:${action}`), ['remote:bootstrap']);
});

test('remote probe errors and local alias conflicts cannot trigger partial installation', async t => {
  const probeFailure = await scenario(t, { probeError: new Error('Python 3 is unavailable') });
  await assert.rejects(manage(probeFailure.options, probeFailure.dependencies), /Python 3/);
  assert.deepEqual(mutations(probeFailure.calls), []);
  const conflict = await scenario(t, { state: { status: 'conflict', reason: 'Alias belongs to a user' } });
  await assert.rejects(manage(conflict.options, conflict.dependencies), /belongs to a user/);
  assert.equal(conflict.calls.some(([name]) => name === 'environment'), false);
  assert.deepEqual(mutations(conflict.calls), []);
});

test('an invalid remote profile path is rejected before packaging or host mutation', async t => {
  const f = await scenario(t, { probe: { paths: { ...remotePaths, profileHome: '/home/dev\nHost *' } } });
  await assert.rejects(manage(f.options, f.dependencies), /single line/);
  assert.deepEqual(mutations(f.calls), []);
});

test('successful install deploys before creating its alias, verifies activation, and removes staging', async t => {
  const f = await scenario(t, { options: { 'node-path': '/opt/node path/node', 'agent-path': '/opt/cursor/agent', 'codex-path': '/opt/codex' } });
  const result = await manage(f.options, f.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.alias, 'dev-cursor');
  assert.equal(result.version, '0.1.0');
  assert.match(result.next, /dev-cursor/);
  assert.deepEqual(f.calls.filter(([name]) => name !== 'progress').map(([name, action]) => name === 'remote' ? `${name}:${action}` : name), [
    'config', 'inspectHost', 'environment', 'remote:probe', 'buildRuntimeArchive', 'upload',
    'remote:install', 'installHost', 'exec', 'cleanup',
  ]);
  const probeRequest = f.calls.find(([name, action]) => name === 'remote' && action === 'probe')[2];
  assert.deepEqual(probeRequest, { id: installationId('dev-cursor'), nodePath: '/opt/node path/node', agentPath: '/opt/cursor/agent', codexPath: '/opt/codex' });
  const deployment = f.calls.find(([name, action]) => name === 'remote' && action === 'install')[2];
  assert.deepEqual(deployment, { ...probeRequest, activationEnv: 'CODEX_HOME', version: '0.1.0', archivePath: '/tmp/cursor-codex-abcd/runtime.tgz' });
  const host = f.calls.find(([name]) => name === 'installHost')[1];
  assert.equal(host.configPath, f.options['ssh-config']);
  assert.equal(host.sourceAlias, 'dev');
  assert.equal(host.profileHome, remotePaths.profileHome);
  assert.equal(host.activationEnv, 'CODEX_HOME');
  assert.equal(host.sshConfig, effective);
  assert.deepEqual(f.calls.find(([name]) => name === 'exec')[2], { alias: 'dev-cursor' });
  await assert.rejects(fs.access(f.bundleDirectory), { code: 'ENOENT' });
});

test('failure before remote deployment leaves both installations untouched and cleans staging', async t => {
  const f = await scenario(t, { deployError: new Error('remote refused archive') });
  await assert.rejects(manage(f.options, f.dependencies), /remote refused archive/);
  assert.equal(f.calls.some(([name]) => name === 'installHost' || name === 'removeHost'), false);
  assert.equal(f.calls.some(([name, action]) => name === 'remote' && action === 'uninstall'), false);
  assert.equal(f.calls.some(([name]) => name === 'cleanup'), true);
  await assert.rejects(fs.access(f.bundleDirectory), { code: 'ENOENT' });
});

test('fresh install rolls back owned remote and local configuration when activation fails', async t => {
  const f = await scenario(t, { activation: '' });
  await assert.rejects(manage(f.options, f.dependencies), /rolled back; history was retained/);
  assert.deepEqual(mutations(f.calls).map(([name, action]) => name === 'remote' ? `${name}:${action}` : name), [
    'buildRuntimeArchive', 'upload', 'remote:install', 'installHost', 'remote:uninstall', 'removeHost', 'cleanup',
  ]);
  assert.equal(f.calls.find(([name, action]) => name === 'remote' && action === 'uninstall')[2].id, installationId('dev-cursor'));
});

test('a local installation failure rolls back a fresh remote installation without removing an uncreated alias', async t => {
  const f = await scenario(t, { localError: new Error('configuration write refused') });
  await assert.rejects(manage(f.options, f.dependencies), /configuration write refused.*rolled back/);
  assert.equal(f.calls.some(([name, action]) => name === 'remote' && action === 'uninstall'), true);
  assert.equal(f.calls.some(([name]) => name === 'removeHost'), false);
});

test('rollback failure is reported while staging still gets cleaned', async t => {
  const f = await scenario(t, { activation: '', rollbackError: new Error('remote cleanup refused') });
  await assert.rejects(manage(f.options, f.dependencies), /Rollback incomplete: remote cleanup refused/);
  assert.equal(f.calls.some(([name]) => name === 'removeHost'), true);
  assert.equal(f.calls.some(([name]) => name === 'cleanup'), true);
  await assert.rejects(fs.access(f.bundleDirectory), { code: 'ENOENT' });
});

test('an upgrade activation failure retains remote releases and history instead of uninstalling', async t => {
  const f = await scenario(t, { options: { action: 'upgrade' }, probe: { installed: true }, state: { status: 'owned' }, activation: '' });
  await assert.rejects(manage(f.options, f.dependencies), /existing history and previous release are retained/);
  assert.equal(f.calls.some(([name, action]) => name === 'remote' && action === 'uninstall'), false);
  assert.equal(f.calls.some(([name]) => name === 'removeHost'), false);
  assert.equal(f.calls.some(([name]) => name === 'cleanup'), true);
});

test('upgrade requires a complete managed installation and refuses to change an active bridge', async t => {
  for (const overrides of [
    { options: { action: 'upgrade' }, probe: { installed: false, ready: false, runtime: { ...completeRuntime, codex: null } }, state: { status: 'owned' } },
    { options: { action: 'upgrade' }, probe: { installed: true, ready: false, runtime: { ...completeRuntime, codex: null } }, state: { status: 'missing' } },
    { probe: { busy: true, ready: false, runtime: { ...completeRuntime, codex: null } } },
    { options: { action: 'upgrade' }, probe: { installed: true, busy: true, ready: false, runtime: { ...completeRuntime, codex: null } }, state: { status: 'owned' } },
  ]) {
    const f = await scenario(t, overrides);
    await assert.rejects(manage(f.options, f.dependencies), /complete managed installation|active turn/);
    assert.deepEqual(mutations(f.calls), []);
  }
});

test('uninstall works after runtimes or forwarding disappear and retains the profile', async t => {
  const f = await scenario(t, { options: { action: 'uninstall' }, probe: { ready: false, installed: true }, state: { status: 'owned' }, environment: false });
  const result = await manage(f.options, f.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.retainedHistory, remotePaths.profileHome);
  assert.deepEqual(mutations(f.calls).map(([name, action]) => name === 'remote' ? `${name}:${action}` : name), ['remote:uninstall', 'removeHost']);
  const request = f.calls.find(([name, action]) => name === 'remote' && action === 'uninstall')[2];
  assert.deepEqual(request, { id: installationId('dev-cursor') });
});

test('doctor reports an absent installation without mutating either machine', async t => {
  const f = await scenario(t, { options: { action: 'doctor' } });
  const result = await manage(f.options, f.dependencies);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.name), ['installation', 'managed-ssh-alias']);
  assert.equal(f.calls.some(([name]) => name === 'exec'), false);
  assert.deepEqual(mutations(f.calls), []);
});

test('doctor checks managed alias activation and returns all failed diagnostics', async t => {
  const good = await scenario(t, { options: { action: 'doctor' }, probe: { installed: true }, state: { status: 'owned' } });
  assert.equal((await manage(good.options, good.dependencies)).ok, true);
  assert.deepEqual(mutations(good.calls), []);
  const bad = await scenario(t, { options: { action: 'doctor' }, probe: { installed: true, ready: false }, state: { status: 'owned' }, environment: false, activation: '/wrong/bin' });
  const result = await manage(bad.options, bad.dependencies);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.name), ['ssh-environment', 'remote-prerequisites', 'native-launch-path']);
  assert.deepEqual(mutations(bad.calls), []);
});

test('doctor reports damaged installed files even when runtime and launch checks pass', async t => {
  const f = await scenario(t, {
    options: { action: 'doctor' }, state: { status: 'owned' },
    probe: { installed: true, health: { ok: false, errors: [{ message: 'wrapper checksum mismatch' }, 'wrap-ansi missing'] } },
  });
  const result = await manage(f.options, f.dependencies);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.name), ['installed-files']);
  assert.match(result.checks.find(check => check.name === 'installed-files').message, /wrapper checksum mismatch; wrap-ansi missing/);
  assert.deepEqual(mutations(f.calls), []);
});

test('doctor converts a remote probe failure into a structured diagnostic', async t => {
  const failure = Object.assign(new Error('Agent login unavailable'), { details: { code: 'AUTH_REQUIRED' } });
  const f = await scenario(t, { options: { action: 'doctor' }, probeError: failure });
  const result = await manage(f.options, f.dependencies);
  assert.equal(result.ok, false);
  assert.deepEqual(result.remote, failure.details);
  assert.match(result.checks.at(-1).message, /login unavailable/);
  assert.deepEqual(mutations(f.calls), []);
});

test('SSH transport passes data on stdin and keeps paths and environment values in arguments', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, 'package');
  await fs.mkdir(path.join(root, 'installer'), { recursive: true });
  await fs.writeFile(path.join(root, 'installer', 'remote.py'), 'print("fixture")\n');
  const calls = [];
  const env = { PATH: process.env.PATH, TEST_SENTINEL: 'kept' };
  const configPath = path.join(directory, 'ssh config with spaces');
  const options = parseManagementArgs(['install', '--ssh', 'dev', '--ssh-config', configPath]);
  const ssh = createSshClient(options, { root, env, async run(executable, args, settings) {
    calls.push({ executable, args, settings });
    if (args.includes('-G')) return { code: 0, stdout: 'host dev\nhostname 192.0.2.10\nuser developer\nport 2222\n', stderr: '' };
    if (args.includes('SetEnv=CODEX_HOME=/tmp/probe value')) return { code: 0, stdout: '/tmp/probe value', stderr: '' };
    return { code: 0, stdout: '{"ok":true}', stderr: '' };
  } });
  assert.equal((await ssh.config()).hostname, '192.0.2.10');
  assert.equal(await ssh.environment('/tmp/probe value'), true);
  const hostile = "/opt/agent'; $(touch should-not-exist); #";
  await ssh.remote('probe', { agentPath: hostile });
  const call = calls.at(-1);
  assert.equal(call.executable, 'ssh');
  assert.deepEqual(call.args.slice(0, 2), ['-F', configPath]);
  assert.ok(call.args.includes('BatchMode=yes'));
  assert.ok(call.args.includes('ClearAllForwardings=yes'));
  assert.ok(call.args.includes('PermitLocalCommand=no'));
  assert.equal(call.args.at(-2), 'dev');
  assert.match(call.args.at(-1), /^python3 -c '/);
  assert.equal(call.args.at(-1).includes(hostile), false);
  assert.deepEqual(JSON.parse(call.settings.input), { agentPath: hostile });
  assert.equal(call.settings.env, env);
  await assert.rejects(ssh.cleanup('/tmp/other-project'), /Invalid staging directory/);
  assert.equal(calls.length, 3);
});

test('SSH JSON parsing and remote errors fail with bounded, readable diagnostics', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'installer'));
  await fs.writeFile(path.join(root, 'installer', 'remote.py'), '# fixture\n');
  const options = parseManagementArgs(['doctor', '--ssh', 'dev']);
  const malformed = createSshClient(options, { root, run: async () => ({ code: 0, stdout: 'shell banner', stderr: 'x'.repeat(2000) }) });
  await assert.rejects(malformed.remote('probe', {}), error => /Ensure Python 3/.test(error.message) && error.message.length < 1300);
  const failure = createSshClient(options, { root, run: async () => ({ code: 1, stdout: '{"ok":false,"error":{"code":"MISSING_AGENT","message":"Agent not found"}}', stderr: '' }) });
  await assert.rejects(failure.remote('probe', {}), error => error.code === 'MISSING_AGENT' && error.message === 'Agent not found' && error.details.ok === false);
});

test('SSH transport restricts activation variable names and gives bootstrap its own script and download deadline', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'installer'));
  const remoteSource = '# remote fixture\n';
  const bootstrapSource = '# bootstrap fixture\n';
  await fs.writeFile(path.join(root, 'installer', 'remote.py'), remoteSource);
  await fs.writeFile(path.join(root, 'installer', 'bootstrap.py'), bootstrapSource);
  const calls = [];
  const ssh = createSshClient(parseManagementArgs(['install', '--ssh', 'dev']), {
    root, async run(executable, args, settings) {
      calls.push({ executable, args, settings });
      return { code: 0, stderr: '', stdout: args.includes('SetEnv=LC_CURSOR_CODEX_BRIDGE=/tmp/test-profile') ? '/tmp/test-profile' : '{"ok":true,"paths":{}}' };
    },
  });
  assert.equal(await ssh.environment('/tmp/test-profile', { variable: 'LC_CURSOR_CODEX_BRIDGE' }), true);
  assert.match(calls[0].args.at(-1), /\$\{LC_CURSOR_CODEX_BRIDGE-\}/);
  await assert.rejects(ssh.environment('/tmp/profile', { variable: 'HOME;echo injected' }), /Invalid activation environment variable/);
  assert.equal(calls.length, 1);
  await ssh.remote('bootstrap', { needNode: false, needCodex: true, nodePath: '/opt/node' });
  assert.ok(calls.at(-1).args.at(-1).includes(Buffer.from(bootstrapSource).toString('base64')));
  assert.equal(calls.at(-1).args.at(-1).includes(Buffer.from(remoteSource).toString('base64')), false);
  assert.deepEqual(JSON.parse(calls.at(-1).settings.input), { needNode: false, needCodex: true, nodePath: '/opt/node' });
  assert.equal(calls.at(-1).settings.timeoutMs, 600_000);
  await ssh.remote('probe', {});
  // Probe retains runProcess's normal 60-second default instead of inheriting
  // the longer download allowance from a preceding bootstrap call.
  assert.equal(calls.at(-1).settings.timeoutMs, undefined);
  await ssh.remote('bootstrap', { needNode: true, needCodex: false }, { timeoutMs: 1234 });
  assert.equal(calls.at(-1).settings.timeoutMs, 1234);
});

test('shell quoting round-trips metacharacters and cannot run command substitutions', async t => {
  const directory = await temporary(t);
  const marker = path.join(directory, 'not-created');
  const value = `quote' \" \`touch ${marker}\` $(touch ${marker}) ; $HOME \\ trailing\nline`;
  const result = await runProcess('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, value);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  assert.throws(() => shellQuote('bad\0argument'), /Invalid shell argument/);
});

test('runProcess forwards exact stdin and collects independent output and exit status', async () => {
  const input = '中文\nquote\'\\$()\n';
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout);process.stderr.write("diagnostic");process.exitCode=7;'], { input });
  assert.equal(result.code, 7);
  assert.equal(result.stdout, input);
  assert.equal(result.stderr, 'diagnostic');
  assert.equal(result.signal, null);
});

test('runProcess limits output and rejects timeouts rather than leaving a caller waiting', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(8192));setInterval(()=>{},1000);'], { maxBytes: 1024 }), /output exceeded its limit/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { timeoutMs: 50 }), /timed out/);
});

test('runtime archive includes all hoisted ws and wrap-ansi dependencies while excluding source tests and private files', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, 'application');
  await fs.mkdir(path.join(root, 'installer'), { recursive: true });
  await fs.mkdir(path.join(root, 'skills', 'install-cursor-codex-bridge'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'));
  const installed = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.1.0', dependencies: installed.dependencies }));
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
  await fs.writeFile(path.join(root, 'LICENSE'), 'MIT fixture');
  await fs.writeFile(path.join(root, 'cli.mjs'), 'export {};\n');
  await fs.writeFile(path.join(root, 'private-key'), 'PRIVATE FIXTURE');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE FIXTURE');
  await fs.writeFile(path.join(root, '.git', 'config'), 'PRIVATE FIXTURE');
  await fs.writeFile(path.join(root, 'bridge.test.mjs'), 'PRIVATE TEST FIXTURE');
  await fs.writeFile(path.join(root, 'installer', 'manage.mjs'), 'export {};\n');
  await fs.writeFile(path.join(root, 'installer', 'manage.test.mjs'), 'PRIVATE TEST FIXTURE');
  await fs.writeFile(path.join(root, 'installer', 'remote.py'), '# fixture\n');
  await fs.writeFile(path.join(root, 'installer', 'bootstrap.py'), '# bootstrap fixture\n');
  await fs.writeFile(path.join(root, 'installer', '.env'), 'PRIVATE FIXTURE');
  await fs.writeFile(path.join(root, 'installer', 'temporary-credentials.json'), 'PRIVATE FIXTURE');
  await fs.writeFile(path.join(root, 'installer', 'test_remote.py'), 'PRIVATE TEST FIXTURE');
  await fs.mkdir(path.join(root, 'installer', '__pycache__'));
  await fs.writeFile(path.join(root, 'installer', '__pycache__', 'remote.pyc'), 'PRIVATE CACHE FIXTURE');
  await fs.writeFile(path.join(root, 'skills', 'install-cursor-codex-bridge', 'SKILL.md'), 'fixture skill');
  // npx can hoist dependencies next to the package rather than beneath it.
  await fs.cp(path.join(repositoryRoot, 'node_modules'), path.join(directory, 'node_modules'), { recursive: true });
  const bundle = await buildRuntimeArchive({ root });
  t.after(() => fs.rm(bundle.temporary, { recursive: true, force: true }));
  assert.equal(bundle.version, '9.1.0');
  assert.deepEqual(Object.keys(bundle.dependencies).sort(), [
    'ansi-regex', 'ansi-styles', 'get-east-asian-width', 'string-width', 'strip-ansi', 'wrap-ansi', 'ws',
  ]);
  const listing = await runProcess('tar', ['-tzf', bundle.archivePath]);
  assert.equal(listing.code, 0);
  const names = new Set(listing.stdout.trim().split('\n'));
  for (const name of ['cli.mjs', 'package.json', 'package-lock.json', 'LICENSE', 'installer/manage.mjs', 'installer/remote.py', 'installer/bootstrap.py', 'skills/install-cursor-codex-bridge/SKILL.md']) assert.ok(names.has(`./${name}`), name);
  for (const name of Object.keys(bundle.dependencies)) assert.ok(names.has(`./node_modules/${name}/package.json`), name);
  for (const name of ['private-key', '.env', '.git/config', 'bridge.test.mjs', 'installer/manage.test.mjs', 'installer/__pycache__/remote.pyc', 'installer/.env', 'installer/temporary-credentials.json', 'installer/test_remote.py']) assert.equal(names.has(`./${name}`), false, name);
  const contents = await runProcess('tar', ['-xOf', bundle.archivePath, './node_modules/wrap-ansi/package.json']);
  assert.equal(JSON.parse(contents.stdout).version, installed.dependencies['wrap-ansi']);
});

test('archive failure removes its temporary package and reports the packaging error', async t => {
  const directory = await temporary(t);
  await fs.mkdir(path.join(directory, 'installer'));
  await fs.mkdir(path.join(directory, 'skills'));
  await fs.writeFile(path.join(directory, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  let stage;
  await assert.rejects(buildRuntimeArchive({ root: directory, async run(executable, args) {
    assert.equal(executable, 'tar'); stage = args[3];
    return { code: 2, stderr: 'disk full', stdout: '' };
  } }), /Cannot create runtime archive: disk full/);
  await assert.rejects(fs.access(stage), { code: 'ENOENT' });
});

// Published v0.1.1–v0.1.3 differed only in their pinned version. Keep the
// released text here so these tests require neither Git nor network access.
const releasedSkill = [
  "---",
  "name: install-cursor-codex-bridge",
  "description: Install, diagnose, upgrade, or uninstall Cursor Codex Bridge over an existing SSH alias so Codex desktop chats use a remote Cursor Agent.",
  "---",
  "",
  "# Install Cursor Codex Bridge",
  "",
  "Use the project's CLI to manage the bridge from the laptop. This is an experimental protocol bridge, not an official Codex or Cursor integration. It requires an existing working SSH alias and a Linux glibc x64/arm64 host with Python 3.8+, bash, and Cursor Agent already logged in. The installer reuses remote Node.js 22+ and genuine Codex CLI or downloads pinned, checksum-verified private runtimes when absent; it does not use sudo or install global npm packages. The laptop needs Node.js 22+ with npm, Git, OpenSSH, tar, and Codex desktop.",
  "",
  "## Workflow",
  "",
  "1. Reuse the user's specified checkout and SSH alias. If the alias is missing, inspect available SSH host names without exposing identities or credentials, and ask the user to choose when necessary. Do not guess a host from unrelated context.",
  "2. Check laptop Node.js 22+ and npm. If unavailable, discover the native Codex `load_workspace_dependencies` tool and use its bundled Node/npm when provided. Add that runtime directory to `PATH` only for the current command; do not modify shell profiles. If neither a suitable system runtime nor a bundled Node/npm is available, report the specific prerequisite and ask the user to install Node.js 22+ with npm. Do not claim the bridge is dependency-free on arbitrary laptops.",
  "3. Prefer the pinned GitHub Release package below when no checkout was requested. Use the same `npx` prefix for `install`, then `doctor`, replacing `ALIAS` with the user's SSH alias. Alternatively, clone `https://github.com/KatarinaYuan/cursor-codex-bridge.git`, check out `v0.1.3`, run `npm ci --ignore-scripts`, then use `node cli.mjs`. Read the README and CLI `--help` for version-specific options. Reuse an existing checkout only when its origin matches this project; do not discard local edits.",
  "4. Add `--alias BRIDGE_ALIAS` only when the user specified a bridge name or a collision needs resolving; pass that same option to every later management command. Remote binary overrides (`--node-path`, `--agent-path`, `--codex-path`) must be remote absolute paths.",
  "5. Report the actual diagnostic result and generated bridge alias. Direct the user to enable that alias in Codex App SSH settings if the CLI requires it. Do not claim an end-to-end chat works solely because installation passed.",
  "",
  "```sh",
  "npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.3/cursor-codex-bridge-0.1.3.tgz cursor-codex install --ssh ALIAS",
  "npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.3/cursor-codex-bridge-0.1.3.tgz cursor-codex doctor --ssh ALIAS",
  "```",
  "",
  "An explicit installation request authorizes the installer changes described by the CLI; do not add another approval step for those routine changes. It tests `CODEX_HOME` forwarding, then `LC_CURSOR_CODEX_BRIDGE`; a server rejecting both may need the user's administrator. Report that concrete blocker instead of changing the server's SSH policy.",
  "",
  "## Other operations",
  "",
  "- Diagnose: use the same `npx` prefix with `cursor-codex doctor --ssh ALIAS` (`--json` for structured results), or `node cli.mjs doctor` in a checkout. This is read-only and does not send model messages.",
  "- Upgrade: run `cursor-codex upgrade --ssh ALIAS` using the target release package URL with `npx`, or its clean checkout with `node cli.mjs`. The command deploys the calling version; it does not fetch the latest release itself. Preserve local edits and existing user settings.",
  "- Uninstall: run `cursor-codex uninstall --ssh ALIAS` with the same `npx` prefix, or `node cli.mjs uninstall` in a checkout. Preserve the retained bridge records, original Cursor history, and shared private runtimes. Deleting those data requires a separate explicit request. Existing manual bridge deployments are not adopted or migrated by this installer.",
  "",
  "Use the installer for owned SSH/profile blocks and remote files. Do not duplicate its work by manually appending shell snippets, replacing global Codex binaries, modifying `sshd_config`, or installing global hooks. Do not bundle or copy accounts and credentials.",
  "",
  "Do not send test messages to existing chats or tmux sessions. Do not clear drafts or press Enter to resolve a failed paste. When busy or when input cannot be verified, stop the dependent mutation and report the CLI's concrete reason; inspect read-only diagnostics and `docs/troubleshooting.md`. A new isolated model test requires the user's authorization because it creates messages and may incur cost.",
  "",
  "For a failed command, diagnose the actual output; do not loop installation or restart user Agent processes. Keep logs and issue reports free of chat contents, private keys, tokens, and personal host details.",
  "",
].join('\n');
const releasedSkillMetadata = "interface:\n  display_name: \"Install Cursor Codex Bridge\"\n  short_description: \"Install and manage a remote Cursor bridge for Codex\"\n  default_prompt: \"Use $install-cursor-codex-bridge to install the bridge using my existing SSH alias and run diagnostics.\"\n";

test('skill installation uses CODEX_HOME, is idempotent, and preserves differing existing skills', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, 'package');
  const source = path.join(root, 'skills', 'install-cursor-codex-bridge');
  const codexHome = path.join(directory, 'codex home');
  await fs.mkdir(path.join(source, 'agents'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Fixture skill\n');
  await fs.writeFile(path.join(source, 'agents', 'openai.yaml'), 'interface: fixture\n');
  const settings = { root, env: { CODEX_HOME: codexHome } };
  const preview = await installSkill({ ...settings, dryRun: true });
  assert.equal(preview.changed, true);
  await assert.rejects(fs.access(codexHome), { code: 'ENOENT' });
  const result = await installSkill(settings);
  assert.equal(result.destination, path.join(codexHome, 'skills', 'install-cursor-codex-bridge'));
  assert.equal(result.changed, true);
  assert.equal(await fs.readFile(path.join(result.destination, 'agents', 'openai.yaml'), 'utf8'), 'interface: fixture\n');
  assert.equal((await installSkill(settings)).changed, false);
  await fs.writeFile(path.join(result.destination, 'SKILL.md'), 'locally customized\n');
  await assert.rejects(installSkill(settings), /existing skill differs/);
  assert.equal(await fs.readFile(path.join(result.destination, 'SKILL.md'), 'utf8'), 'locally customized\n');
});

test('install-skill routes locally and rejects a symlink destination', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, 'package');
  const source = path.join(root, 'skills', 'install-cursor-codex-bridge');
  const parent = path.join(directory, 'custom skills');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Fixture skill\n');
  const result = await manage({ action: 'install-skill', 'skill-dir': parent }, { root, env: {}, ssh: new Proxy({}, { get() { throw new Error('SSH must not be used'); } }) });
  assert.equal(result.ok, true);
  await fs.rm(result.destination, { recursive: true });
  const target = path.join(directory, 'unrelated');
  await fs.mkdir(target);
  await fs.symlink(target, result.destination);
  await assert.rejects(installSkill({ root, skillDir: parent }), /regular directory/);
  assert.deepEqual(await fs.readdir(target), []);
});

async function releasedSkillInstallation(t, version = '0.1.10', { customParent = false, metadata = true } = {}) {
  const directory = await temporary(t);
  const root = path.join(directory, 'package');
  const source = path.join(root, 'skills', 'install-cursor-codex-bridge');
  const codexHome = path.join(directory, 'codex home');
  const parent = customParent ? path.join(directory, 'custom', 'skills') : path.join(codexHome, 'skills');
  const destination = path.join(parent, 'install-cursor-codex-bridge');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Current skill\n');
  if (metadata) {
    await fs.mkdir(path.join(source, 'agents'));
    await fs.writeFile(path.join(source, 'agents', 'openai.yaml'), releasedSkillMetadata);
  }
  await fs.mkdir(path.join(destination, 'agents'), { recursive: true });
  const original = ['0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8', '0.1.9', '0.1.10'].includes(version)
    ? await fs.readFile(new URL(`./fixtures/install-skill-v${version}.md`, import.meta.url), 'utf8')
    : releasedSkill.replaceAll('0.1.3', version);
  await fs.writeFile(path.join(destination, 'SKILL.md'), original);
  await fs.writeFile(path.join(destination, 'agents', 'openai.yaml'), releasedSkillMetadata);
  return { directory, source, parent, destination, original,
    settings: { root, env: { CODEX_HOME: codexHome }, ...(customParent ? { skillDir: parent } : {}) } };
}

test('install-skill safely upgrades each unmodified published release and retains its complete backup', async t => {
  for (const version of ['0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8', '0.1.9', '0.1.10']) {
    const f = await releasedSkillInstallation(t, version, { customParent: version === '0.1.2' });
    const result = await installSkill(f.settings);
    assert.equal(result.changed, true);
    assert.equal(result.destination, f.destination);
    assert.equal(path.dirname(result.backup), path.join(path.dirname(f.parent), 'skill-backups'));
    assert.match(path.basename(result.backup), /^install-cursor-codex-bridge-\d{4}-\d{2}-\d{2}T[\w-]+-[a-f0-9-]+$/);
    assert.equal(await fs.readFile(path.join(result.backup, 'SKILL.md'), 'utf8'), f.original);
    assert.equal(await fs.readFile(path.join(result.backup, 'agents', 'openai.yaml'), 'utf8'), releasedSkillMetadata);
    assert.equal(await fs.readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), '# Current skill\n');
    assert.equal(await fs.readFile(path.join(f.destination, 'agents', 'openai.yaml'), 'utf8'), releasedSkillMetadata);
    assert.equal((await installSkill(f.settings)).changed, false);
    assert.deepEqual(await fs.readdir(f.parent), ['install-cursor-codex-bridge']);
  }
});

test('the v0.1.6 upgrade fixture contains the exact published official instructions', async () => {
  const original = await fs.readFile(new URL('./fixtures/install-skill-v0.1.6.md', import.meta.url));
  assert.equal(createHash('sha256').update(original).digest('hex'), 'b0c6774e1d99c8d5b2a9ee22bacca70ab073ce9f4ae573f45d360228b6888a5d');
});

test('the v0.1.7 upgrade fixture contains the exact published official instructions', async () => {
  const original = await fs.readFile(new URL('./fixtures/install-skill-v0.1.7.md', import.meta.url));
  assert.equal(createHash('sha256').update(original).digest('hex'), 'c94336b2d17b907cb107bacaf5e416d00b30f0f6c256a2aae5a95148c145f129');
});

test('the v0.1.8 upgrade fixture and UI metadata match the published official file hashes', async () => {
  const original = await fs.readFile(new URL('./fixtures/install-skill-v0.1.8.md', import.meta.url));
  assert.equal(createHash('sha256').update(original).digest('hex'), '283db7f5c4b6423c03ad926a1d5f8d03e829cfd4dcb1e14bd688b0800e08ea2f');
  assert.equal(createHash('sha256').update(releasedSkillMetadata).digest('hex'), '63b8acb9292c020c48526eade247f7c18ceeb6928155eb400b3071b0ff2bc027');
});

test('the v0.1.9 upgrade fixture and UI metadata match the published official file hashes', async () => {
  const original = await fs.readFile(new URL('./fixtures/install-skill-v0.1.9.md', import.meta.url));
  assert.equal(createHash('sha256').update(original).digest('hex'), '047dfc40e0e33537ec18dd14836fac1eb3b3f18eec7823e77cb3cf53484207c6');
  assert.equal(createHash('sha256').update(releasedSkillMetadata).digest('hex'), '63b8acb9292c020c48526eade247f7c18ceeb6928155eb400b3071b0ff2bc027');
});

test('the v0.1.10 upgrade fixture and UI metadata match the published official file hashes', async () => {
  const original = await fs.readFile(new URL('./fixtures/install-skill-v0.1.10.md', import.meta.url));
  assert.equal(createHash('sha256').update(original).digest('hex'), '08624899418b8465ea31901d19913da126e3992d458a43432a0cfd5a2bef1e55');
  assert.equal(createHash('sha256').update(releasedSkillMetadata).digest('hex'), '63b8acb9292c020c48526eade247f7c18ceeb6928155eb400b3071b0ff2bc027');
});

test('an upgrade dry run reports the planned backup without creating or modifying files', async t => {
  const f = await releasedSkillInstallation(t);
  const result = await installSkill({ ...f.settings, dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(result.dryRun, true);
  assert.ok(result.backup);
  await assert.rejects(fs.access(path.dirname(result.backup)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), f.original);
  assert.deepEqual(await fs.readdir(f.parent), ['install-cursor-codex-bridge']);
});

test('install-skill preserves customized v0.1.10 instructions, metadata, and additional files before making a backup', async t => {
  const contents = async directory => Object.fromEntries(await Promise.all((await fs.readdir(directory, { recursive: true })).sort().map(async name => {
    const filename = path.join(directory, name);
    return [name, (await fs.lstat(filename)).isDirectory() ? null : await fs.readFile(filename, 'utf8')];
  })));
  const changes = [
    async f => fs.appendFile(path.join(f.destination, 'SKILL.md'), '\nLocal instructions\n'),
    async f => fs.appendFile(path.join(f.destination, 'agents', 'openai.yaml'), 'local: true\n'),
    async f => fs.rm(path.join(f.destination, 'agents'), { recursive: true }),
    async f => fs.writeFile(path.join(f.destination, 'extra.txt'), 'local contents'),
    async f => fs.writeFile(path.join(f.destination, 'agents', 'extra.yaml'), 'local contents'),
  ];
  for (const change of changes) {
    const f = await releasedSkillInstallation(t);
    await change(f);
    const before = await contents(f.destination);
    await assert.rejects(installSkill(f.settings), /existing skill differs|Unexpected files|Unexpected or non-regular/);
    assert.deepEqual(await contents(f.destination), before);
    await assert.rejects(fs.access(path.join(path.dirname(f.parent), 'skill-backups')), { code: 'ENOENT' });
  }
});

test('matching instructions preserve existing UI metadata without following any skill symlinks', async t => {
  const same = await releasedSkillInstallation(t);
  await fs.copyFile(path.join(same.destination, 'SKILL.md'), path.join(same.source, 'SKILL.md'));
  await fs.writeFile(path.join(same.destination, 'agents', 'openai.yaml'), 'interface: customized\n');
  assert.equal((await installSkill(same.settings)).changed, false);
  assert.equal(await fs.readFile(path.join(same.destination, 'agents', 'openai.yaml'), 'utf8'), 'interface: customized\n');
  for (const entry of ['SKILL.md', 'agents', 'agents/openai.yaml']) {
    for (const matching of [false, true]) {
      const f = await releasedSkillInstallation(t, '0.1.3', { metadata: false });
      if (matching) await fs.copyFile(path.join(f.destination, 'SKILL.md'), path.join(f.source, 'SKILL.md'));
      const original = path.join(f.destination, entry);
      const target = path.join(f.directory, 'unrelated');
      await fs.rename(original, target);
      await fs.symlink(target, original);
      await assert.rejects(installSkill(f.settings), /regular file|non-regular/);
      assert.equal((await fs.lstat(original)).isSymbolicLink(), true);
      await assert.rejects(fs.access(path.join(path.dirname(f.parent), 'skill-backups')), { code: 'ENOENT' });
    }
  }
});

test('a failed replacement restores the original skill and removes the staged new copy', async t => {
  const f = await releasedSkillInstallation(t);
  const rename = fs.rename;
  let replacementAttempted = false;
  fs.rename = async (from, to) => {
    if (path.basename(from).startsWith('.install-cursor-codex-bridge-') && to === f.destination) {
      replacementAttempted = true;
      throw new Error('replacement failed');
    }
    return rename(from, to);
  };
  try { await assert.rejects(installSkill(f.settings), /replacement failed/); }
  finally { fs.rename = rename; }
  assert.equal(replacementAttempted, true);
  assert.equal(await fs.readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), f.original);
  assert.equal(await fs.readFile(path.join(f.destination, 'agents', 'openai.yaml'), 'utf8'), releasedSkillMetadata);
  assert.deepEqual(await fs.readdir(f.parent), ['install-cursor-codex-bridge']);
  assert.deepEqual(await fs.readdir(path.join(path.dirname(f.parent), 'skill-backups')), []);
});

test('managementMain emits parse failures as JSON without attempting SSH', async () => {
  const writes = [], previousExitCode = process.exitCode;
  try {
    const result = await managementMain(['install', '--ssh', 'bad;alias', '--json'], {
      stdout: { write(value) { writes.push(value); } },
      stderr: { write() { assert.fail('JSON mode must not print an unstructured error'); } },
    });
    assert.equal(result.ok, false);
    const response = JSON.parse(writes.join(''));
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INSTALLER_ERROR');
    assert.match(response.error.message, /SSH alias/);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = previousExitCode; }
});
