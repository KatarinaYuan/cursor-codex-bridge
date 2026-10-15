import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { WebSocket } from 'ws';
import { planCommand } from './cli.mjs';
import { bridgeHome, controlSocketPath, parseListen, serveStdio, serveUnix } from './transport.mjs';

function echoBridge({ send }) {
  return { receive(message) { send({ id: message.id, result: message.params }); }, close() {} };
}

test('an npm-style bin symlink executes version, help, and the local skill installer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cb-bin-symlink-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binDirectory = join(directory, 'node_modules', '.bin');
  await mkdir(binDirectory, { recursive: true });
  const entry = join(binDirectory, 'cursor-codex');
  await symlink(fileURLToPath(new URL('./cli.mjs', import.meta.url)), entry);
  const env = { ...process.env, CODEX_HOME: join(directory, 'isolated-codex') };
  delete env.CURSOR_BRIDGE_REAL_CODEX;
  const run = (args) => promisify(execFile)(entry, args, { env, timeout: 10_000 });
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

  const version = await run(['--version']);
  assert.equal(version.stdout, `${pkg.version}\n`);
  assert.equal(version.stderr, '');

  const help = await run(['--help']);
  assert.match(help.stdout, /Usage: cursor-codex <command>/);
  assert.match(help.stdout, /install --ssh ALIAS/);
  assert.match(help.stdout, /install-skill/);
  assert.equal(help.stderr, '');
  // Merely inspecting the CLI must not start an agent or create a service home.
  await assert.rejects(lstat(env.CODEX_HOME), { code: 'ENOENT' });

  const skillParent = join(directory, 'local skills');
  const installed = await run(['install-skill', '--skill-dir', skillParent, '--json']);
  const result = JSON.parse(installed.stdout);
  const destination = join(skillParent, 'install-cursor-codex-bridge');
  assert.equal(result.ok, true);
  assert.equal(result.action, 'install-skill');
  assert.equal(result.changed, true);
  assert.equal(result.destination, destination);
  assert.equal(installed.stderr, '');
  assert.equal(await readFile(join(destination, 'SKILL.md'), 'utf8'),
    await readFile(new URL('./skills/install-cursor-codex-bridge/SKILL.md', import.meta.url), 'utf8'));
  assert.equal(await readFile(join(destination, 'agents', 'openai.yaml'), 'utf8'),
    await readFile(new URL('./skills/install-cursor-codex-bridge/agents/openai.yaml', import.meta.url), 'utf8'));
});

test('history import plans keep source Cursor home separate from the destination store', () => {
  assert.deepEqual(planCommand(['bridge-import-history', '--cwd', '/work', '--home=/source'], { CODEX_HOME: '/destination' }), {
    type: 'import-history', home: '/destination', options: { cwd: '/work', home: '/source' },
  });
  assert.deepEqual(planCommand(['bridge-import-history'], { CODEX_HOME: '/destination' }), {
    type: 'import-history', home: '/destination', options: {},
  });
  assert.equal(planCommand(['bridge-import-history', '--help']).type, 'import-history-help');
  assert.throws(() => planCommand(['bridge-import-history', '--cwd']), /requires a path/);
  assert.throws(() => planCommand(['bridge-import-history', '--cwd', '--home', '/source']), /requires a path/);
  assert.throws(() => planCommand(['bridge-import-history', '--model', 'auto']), /Unknown bridge-import-history argument/);
});

test('history import CLI prints mapping JSON into the selected store without starting either agent backend', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cb-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceHome = join(directory, 'source');
  const destination = join(directory, 'destination');
  const cwd = '/fixture/project';
  const nativeId = 'existing-cursor-chat';
  const chatRoot = join(sourceHome, '.cursor', 'chats', 'workspace-hash', nativeId);
  const transcriptRoot = join(sourceHome, '.cursor', 'projects', 'fixture-project', 'agent-transcripts', nativeId);
  await Promise.all([mkdir(chatRoot, { recursive: true }), mkdir(transcriptRoot, { recursive: true })]);
  await writeFile(join(chatRoot, 'meta.json'), JSON.stringify({ cwd, title: 'Existing Cursor chat' }));
  await writeFile(join(transcriptRoot, `${nativeId}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Earlier question' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Earlier answer' }] } }),
  ].join('\n'));
  const trace = join(directory, 'unexpected-backend-start');
  const sentinel = join(directory, 'backend-sentinel');
  await writeFile(sentinel, '#!/bin/sh\nprintf invoked >> "$CURSOR_BRIDGE_TEST_TRACE"\nexit 91\n', { mode: 0o700 });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'bridge-import-history', '--cwd', cwd, '--home', sourceHome,
  ], { env: {
    ...process.env, CODEX_HOME: destination, CURSOR_BRIDGE_CODEX_HOME: destination,
    CURSOR_BRIDGE_AGENT: sentinel, CURSOR_BRIDGE_REAL_CODEX: sentinel, CURSOR_BRIDGE_TEST_TRACE: trace,
  }, timeout: 10_000 });
  const mappings = JSON.parse(stdout);
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].cursorSessionId, nativeId);
  assert.equal(mappings[0].title, 'Existing Cursor chat');
  assert.match(stderr, /Restart the running bridge service/);
  const persisted = JSON.parse(await readFile(join(destination, 'cursor-bridge', `${mappings[0].threadId}.json`), 'utf8'));
  assert.equal(persisted.backend, 'legacy');
  assert.equal(persisted.cursorSessionId, nativeId);
  assert.equal(persisted.thread.cwd, cwd);
  assert.deepEqual(await readdir(join(destination, 'cursor-bridge')), [`${mappings[0].threadId}.json`]);
  await assert.rejects(lstat(trace), { code: 'ENOENT' });
});

test('native socket paths and delegate plans preserve the isolated service home', () => {
  const env = { CODEX_HOME: '/tmp/cursor-service' };
  assert.equal(bridgeHome(env), '/tmp/cursor-service');
  assert.equal(controlSocketPath(bridgeHome(env)), '/tmp/cursor-service/app-server-control/app-server-control.sock');
  assert.deepEqual(planCommand(['app-server', '--listen', 'unix://'], env), {
    type: 'serve', home: '/tmp/cursor-service',
    transport: { type: 'unix', path: '/tmp/cursor-service/app-server-control/app-server-control.sock' },
  });
  assert.deepEqual(planCommand(['app-server', 'proxy'], env).args, [
    'app-server', 'proxy', '--sock', '/tmp/cursor-service/app-server-control/app-server-control.sock',
  ]);
  assert.deepEqual(planCommand(['app-server', 'proxy', '--sock', '/tmp/explicit.sock'], env).args,
    ['app-server', 'proxy', '--sock', '/tmp/explicit.sock']);
  assert.equal(planCommand(['app-server', 'generate-json-schema', '--out', '/tmp/schema'], env).type, 'delegate');
  assert.equal(planCommand(['app-server', '--help'], env).type, 'delegate');
  assert.equal(planCommand(['--version'], env).type, 'version');
  assert.equal(planCommand(['--version'], { ...env, CURSOR_BRIDGE_REAL_CODEX: '/original/codex' }).type, 'delegate');
  assert.deepEqual(parseListen(['--listen=stdio://']), { type: 'stdio' });
  assert.throws(() => parseListen(['--listen', 'ws://0.0.0.0:3000']), /Unsupported bridge transport/);
});

test('stdio keeps JSON-RPC framing and does not block incoming messages on async receives', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const received = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const server = serveStdio({ input, output, createBridge: ({ send }) => ({
    async receive(message) {
      received.push(message.id);
      if (message.id === 1) await blocked;
      send({ id: message.id, result: {} });
    }, close() { release(); },
  }) });
  const next = once(output, 'data');
  input.write('{"id":1,"method":"turn/start"}\n{"id":2,"method":"turn/interrupt"}\n');
  const [response] = await next;
  assert.deepEqual(received, [1, 2]);
  assert.equal(JSON.parse(response.toString()).id, 2);
  await server.close();
  input.destroy();
  output.destroy();
});

test('Unix WebSocket listener handles JSON-RPC, private permissions, and cleanup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cb-'));
  const socketPath = join(directory, 'bridge.sock');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await serveUnix({ socketPath, createBridge: echoBridge });
  t.after(() => server.close());
  assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
  const socket = new WebSocket(`ws+unix://${socketPath}:/`);
  t.after(() => socket.terminate());
  let advertisedLimit;
  socket.once('upgrade', (response) => { advertisedLimit = response.headers['x-codex-websocket-max-unfragmented-message-bytes']; });
  await once(socket, 'open');
  assert.equal(advertisedLimit, String(64 * 1024 * 1024));
  const next = once(socket, 'message');
  socket.send(JSON.stringify({ id: 7, method: 'echo', params: { text: 'Cursor 模型' } }));
  const [response] = await next;
  assert.deepEqual(JSON.parse(response.toString()), { id: 7, result: { text: 'Cursor 模型' } });
  await assert.rejects(serveUnix({ socketPath, createBridge: echoBridge }), /already in use/);
  await server.close();
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });
});

test('Unix listener refuses insecure directories and existing ordinary files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cb-'));
  const socketPath = join(directory, 'bridge.sock');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o755);
  await assert.rejects(serveUnix({ socketPath, createBridge: echoBridge }), /private directory/);
  await chmod(directory, 0o700);
  await writeFile(socketPath, 'keep this');
  await assert.rejects(serveUnix({ socketPath, createBridge: echoBridge }), /Refusing to replace/);
});

test('Unix shutdown rejects late clients while an existing bridge is still closing', { timeout: 2_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cb-close-'));
  const socketPath = join(directory, 'bridge.sock');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let startedClosing;
  const closing = new Promise((resolve) => { startedClosing = resolve; });
  let created = 0;
  let closed = 0;
  let shutdown = 0;
  const server = await serveUnix({
    socketPath,
    createBridge: () => {
      created += 1;
      return {
        receive() {},
        async close() { closed += 1; startedClosing(); await gate; },
      };
    },
    onClose: async () => { shutdown += 1; },
  });
  t.after(() => { release(); return server.close(); });
  const first = new WebSocket(`ws+unix://${socketPath}:/`);
  t.after(() => first.terminate());
  await once(first, 'open');
  const done = server.close();
  await closing;
  const late = new WebSocket(`ws+unix://${socketPath}:/`);
  t.after(() => late.terminate());
  let lateOpened = false;
  late.on('open', () => { lateOpened = true; });
  // A refused socket or a rejected upgrade are both valid shutdown outcomes.
  late.on('error', () => {});
  await new Promise((resolveClosed) => late.once('close', resolveClosed));
  assert.equal(lateOpened, false);
  assert.equal(created, 1);
  release();
  await done;
  assert.equal(closed, 1);
  assert.equal(shutdown, 1);
});
