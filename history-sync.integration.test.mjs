import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const row = (role, text) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
const ended = JSON.stringify({ type: 'turn_ended', status: 'success' });
const turnText = turn => turn.items.map(item => item.type === 'userMessage'
  ? item.content.map(block => block.text || '').join('\n') : item.text || '').join('\n');

async function genuineCodex() {
  const candidates = [
    process.env.CURSOR_BRIDGE_TEST_REAL_CODEX,
    process.env.CURSOR_BRIDGE_REAL_CODEX,
    ...String(process.env.PATH || '').split(delimiter).map(path => join(path, 'codex')),
  ].filter(Boolean);
  for (const executable of candidates) {
    try { await access(executable, constants.X_OK); return executable; } catch { /* Try the next installed CLI. */ }
  }
  return null;
}

class RpcClient extends EventEmitter {
  constructor(env) {
    super();
    this.messages = [];
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.child = spawn(process.execPath, [join(directory, 'cli.mjs'), 'app-server', '--listen', 'stdio://'], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-20_000); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.protocolError = new Error(`Invalid bridge output: ${line}`); return; }
      this.messages.push(message);
      this.emit('message', message);
      if (message.method || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else pending.resolve(message.result);
    });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.exit = { code, signal };
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Bridge exited: ${code ?? signal}\n${this.stderr}`));
      }
      this.pending.clear();
      this.emit('closed');
      resolve();
    }));
  }

  send(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }

  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}\n${this.stderr}`));
      }, 12_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  waitFor(predicate, since = 0) {
    const existing = this.messages.slice(since).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const finish = (error, message) => {
        clearTimeout(timer);
        this.off('message', listener);
        this.off('closed', onClose);
        error ? reject(error) : resolve(message);
      };
      const listener = message => { if (predicate(message)) finish(null, message); };
      const onClose = () => finish(new Error(`Bridge closed while waiting for a notification\n${this.stderr}`));
      const timer = setTimeout(() => finish(new Error(`Notification timeout\n${this.stderr}`)), 8_000);
      this.on('message', listener);
      this.once('closed', onClose);
    });
  }

  async initialize() {
    const result = await this.call('initialize', {
      clientInfo: { name: 'cursor_history_sync_integration_test', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  async close() {
    if (this.exit) return;
    // Input EOF must stop the synchronizer as well as the genuine support server.
    this.child.stdin.end();
    let forced = false;
    const timer = setTimeout(() => { forced = true; this.child.kill('SIGKILL'); }, 3_000);
    await this.closed;
    clearTimeout(timer);
    assert.equal(forced, false, `History synchronizer kept its process alive after EOF\n${this.stderr}`);
    assert.deepEqual(this.exit, { code: 0, signal: null }, this.stderr);
    assert.equal(this.protocolError, undefined);
  }
}

async function setup(t, agentSource) {
  const codex = await genuineCodex();
  if (!codex) { t.skip('A genuine Codex CLI is required; set CURSOR_BRIDGE_TEST_REAL_CODEX'); return null; }
  const temp = await mkdtemp(join(tmpdir(), 'cursor-history-sync-integration-'));
  const sourceHome = join(temp, 'source');
  const store = join(temp, 'store');
  const agent = join(temp, 'agent-must-not-run.mjs');
  const agentTrace = join(temp, 'agent-started');
  await writeFile(agent, agentSource || `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(process.env.CURSOR_HISTORY_SYNC_AGENT_TRACE, 'unexpected agent process');\nprocess.exit(73);\n`);
  await chmod(agent, 0o700);
  const env = {
    ...process.env,
    CODEX_HOME: store,
    CURSOR_BRIDGE_CODEX_HOME: store,
    CURSOR_BRIDGE_HISTORY_HOME: sourceHome,
    CURSOR_BRIDGE_SYNC_INTERVAL_MS: '100',
    CURSOR_BRIDGE_AGENT: agent,
    CURSOR_BRIDGE_REAL_CODEX: codex,
    CURSOR_HISTORY_SYNC_AGENT_TRACE: agentTrace,
    CURSOR_HISTORY_SYNC_RELEASE: join(temp, 'release-agent'),
  };
  delete env.OPENAI_API_KEY;
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  const clients = [];
  const start = () => { const client = new RpcClient(env); clients.push(client); return client; };
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await rm(temp, { recursive: true, force: true });
  });
  const assertNoAgent = async () => assert.rejects(access(agentTrace), { code: 'ENOENT' }, 'Reading external Cursor history must never start an agent or inference');
  const persisted = async () => {
    const recordDirectory = join(store, 'cursor-bridge');
    return Promise.all((await readdir(recordDirectory)).filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await readFile(join(recordDirectory, name), 'utf8'))));
  };
  return { start, sourceHome, persisted, assertNoAgent, temp, env, agentTrace };
}

async function writeCursorChat(sourceHome, id, contents, cwd = '/work/sync-project') {
  const metadataDirectory = join(sourceHome, '.cursor', 'chats', 'workspace-hash', id);
  const transcriptDirectory = join(sourceHome, '.cursor', 'projects', 'work-sync-project', 'agent-transcripts', id);
  await Promise.all([mkdir(metadataDirectory, { recursive: true }), mkdir(transcriptDirectory, { recursive: true })]);
  await writeFile(join(metadataDirectory, 'meta.json'), JSON.stringify({
    cwd, title: 'External Cursor CLI chat', createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }));
  const transcript = join(transcriptDirectory, `${id}.jsonl`);
  await writeFile(transcript, `${contents.join('\n')}\n`);
  return transcript;
}

function historyEvents(messages, threadId) {
  return messages.filter(message => message.method && (
    message.params?.threadId === threadId || message.params?.thread?.id === threadId
  ) && /^(thread\/started|turn\/(started|completed)|item\/(started|completed))$/.test(message.method));
}

async function assertCompletedEvents(client, threadId, text, since) {
  const completed = await client.waitFor(message => message.method === 'turn/completed'
    && message.params.threadId === threadId && turnText(message.params.turn).includes(text), since);
  const turn = completed.params.turn;
  const events = client.messages.slice(since);
  assert.ok(events.some(message => message.method === 'turn/started'
    && message.params.threadId === threadId && message.params.turn.id === turn.id), 'Native clients need the synchronized turn before its completion');
  for (const item of turn.items) {
    assert.ok(events.some(message => message.method === 'item/completed'
      && message.params.threadId === threadId && message.params.turnId === turn.id && message.params.item.id === item.id), `Missing synchronized item completion: ${item.id}`);
  }
  return turn;
}

async function waitForRead(client, threadId, predicate) {
  const deadline = Date.now() + 6_000;
  do {
    const thread = (await client.call('thread/read', { threadId, includeTurns: true })).thread;
    if (predicate(thread)) return thread;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`Synchronized history was not visible through thread/read\n${client.stderr}`);
}

test('external Cursor CLI chats synchronize proactively, preserve native settings, and survive restart without inference', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { start, sourceHome, persisted, assertNoAgent } = fixture;
  let client = start();
  await client.initialize();
  const cursorId = 'external-cli-session';
  const sinceCreated = client.messages.length;
  const transcript = await writeCursorChat(sourceHome, cursorId, [row('user', 'First external question'), row('assistant', 'First external answer'), ended]);

  // No list/read RPC drives discovery: the connected native client must be notified.
  const discovered = await client.waitFor(message => message.method === 'thread/started'
    && message.params.thread.cwd === '/work/sync-project', sinceCreated);
  const threadId = discovered.params.thread.id;
  const firstTurn = await assertCompletedEvents(client, threadId, 'First external answer', sinceCreated);
  const original = (await client.call('thread/read', { threadId, includeTurns: true })).thread;
  assert.equal(original.modelProvider, 'cursor');
  assert.equal(original.turns.length, 1);
  assert.deepEqual(original.turns[0], firstTurn);
  assert.equal((await client.call('thread/list', { modelProviders: ['cursor'] })).data[0].id, threadId);
  await assertNoAgent();

  let since = client.messages.length;
  // Cursor can append a transcript before updating its metadata timestamps.
  await appendFile(transcript, `${row('user', 'Second external question')}\n${row('assistant', 'Second external answer')}\n${ended}\n`);
  const secondTurn = await assertCompletedEvents(client, threadId, 'Second external answer', since);
  assert.notEqual(secondTurn.id, firstTurn.id);
  let current = (await client.call('thread/read', { threadId, includeTurns: true })).thread;
  assert.equal(current.turns.length, 2);
  assert.deepEqual(current.turns[0], original.turns[0], 'Appending history must preserve stable existing turn/item IDs');
  assert.equal(current.turns[1].id, secondTurn.id);
  assert.ok(client.messages.slice(since).filter(message => message.method === 'thread/started')
    .every(message => message.params.thread.id === threadId), 'Appending an existing CLI chat must reuse its native thread');

  since = client.messages.length;
  await delay(450); // Several scans, with no source mutation and no list RPC.
  assert.deepEqual(historyEvents(client.messages.slice(since), threadId), [], 'Unchanged history must not be replayed on every scan');
  assert.equal((await persisted()).filter(record => record.cursorSessionId === cursorId).length, 1);

  await client.call('thread/name/set', { threadId, name: 'My native sidebar name' });
  await client.call('thread/archive', { threadId });
  since = client.messages.length;
  await appendFile(transcript, `${row('user', 'Third external question')}\n${row('assistant', 'Third external answer')}\n${ended}\n`);
  current = await waitForRead(client, threadId, thread => thread.turns.length === 3);
  assert.equal(current.name, 'My native sidebar name');
  assert.equal(current.turns.length, 3);
  assert.deepEqual(historyEvents(client.messages.slice(since), threadId), [], 'Background synchronization must not make an archived chat reappear');
  assert.equal((await client.call('thread/list', { archived: false })).data.some(thread => thread.id === threadId), false);
  assert.equal((await client.call('thread/list', { archived: true })).data.find(thread => thread.id === threadId).name, 'My native sidebar name');
  const beforeRestart = structuredClone(current.turns);
  await assertNoAgent();

  await client.close();
  client = start();
  await client.initialize();
  const restored = (await client.call('thread/read', { threadId, includeTurns: true })).thread;
  assert.equal(restored.id, threadId);
  assert.equal(restored.name, 'My native sidebar name');
  assert.deepEqual(restored.turns, beforeRestart);
  assert.equal((await client.call('thread/list', { archived: true })).data.filter(thread => thread.id === threadId).length, 1);
  assert.equal((await persisted()).filter(record => record.cursorSessionId === cursorId).length, 1);
  since = client.messages.length;
  await delay(350);
  assert.deepEqual(historyEvents(client.messages.slice(since), threadId), [], 'Restarting with unchanged history must not replay completed turns');

  // A partial final JSONL row is normal while the external CLI is writing.
  await appendFile(transcript, '{"role":');
  await delay(350);
  const duringPartial = (await client.call('thread/read', { threadId, includeTurns: true })).thread;
  assert.deepEqual(duringPartial.turns, beforeRestart, 'A partial append must not delete or replace the known history prefix');
  assert.deepEqual(historyEvents(client.messages.slice(since), threadId), [], 'An incomplete row must not fabricate a native turn');
  since = client.messages.length;
  await appendFile(transcript, `"user","message":{"content":[{"type":"text","text":"Fourth external question"}]}}\n${row('assistant', 'Fourth external answer')}\n${ended}\n`);
  const final = await waitForRead(client, threadId, thread => thread.turns.length === 4);
  assert.equal(final.turns.length, 4);
  assert.deepEqual(final.turns.slice(0, 3), beforeRestart);
  assert.equal(final.name, 'My native sidebar name');
  assert.deepEqual(historyEvents(client.messages.slice(since), threadId), []);
  await assertNoAgent();
  await client.close();
});

test('external snapshots wait for a native Cursor turn and merge its transcript echo without duplicate turns', async t => {
  const mockAgent = `#!${process.execPath}
import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
assert.equal(args[0],'--resume');
assert.equal(args[1],'native-running-session');
assert.ok(args.includes('--print'));
assert.equal(args.at(-1),'Native question');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
send({type:'system',subtype:'init',session_id:args[1]});
send({type:'assistant',timestamp_ms:1,message:{content:[{type:'text',text:'Native '}]}});
writeFileSync(process.env.CURSOR_HISTORY_SYNC_AGENT_TRACE,'running');
const timer=setInterval(()=>{
  if(!existsSync(process.env.CURSOR_HISTORY_SYNC_RELEASE))return;
  clearInterval(timer);
  send({type:'assistant',timestamp_ms:2,message:{content:[{type:'text',text:'answer'}]}});
  send({type:'result',subtype:'success',result:'Native answer'});
},20);
`;
  const fixture = await setup(t, mockAgent);
  if (!fixture) return;
  const { start, sourceHome, temp, env, persisted } = fixture;
  const client = start();
  await client.initialize();
  let since = client.messages.length;
  const transcript = await writeCursorChat(sourceHome, 'native-running-session', [row('user', 'Original question'), row('assistant', 'Original answer'), ended], temp);
  const discovered = await client.waitFor(message => message.method === 'thread/started' && message.params.thread.cwd === temp, since);
  const threadId = discovered.params.thread.id;
  await assertCompletedEvents(client, threadId, 'Original answer', since);
  const original = (await client.call('thread/read', { threadId, includeTurns: true })).thread.turns[0];

  since = client.messages.length;
  const { turn } = await client.call('turn/start', { threadId, input: [{ type: 'text', text: 'Native question', text_elements: [] }] });
  await client.waitFor(message => message.method === 'item/agentMessage/delta' && message.params.threadId === threadId && message.params.delta === 'Native ', since);
  const active = (await client.call('thread/read', { threadId, includeTurns: true })).thread.turns.find(candidate => candidate.id === turn.id);
  assert.equal(active.status, 'inProgress');
  assert.equal(turnText(active), 'Native question\nNative ');

  // Simulate Cursor writing the native request back to its own transcript,
  // followed by another CLI turn, while the native bridge is still streaming.
  await appendFile(transcript, `${row('user', 'Native question')}\n${row('assistant', 'Native answer')}\n${ended}\n${row('user', 'External later question')}\n${row('assistant', 'External later answer')}\n${ended}\n`);
  await delay(450);
  const during = (await client.call('thread/read', { threadId, includeTurns: true })).thread;
  assert.equal(during.turns.length, 2, 'An external snapshot must wait until the running native turn is settled');
  assert.deepEqual(during.turns[0], original);
  assert.deepEqual(during.turns[1], active, 'The source transcript must not overwrite a partial native response or its IDs');

  const afterRelease = client.messages.length;
  await writeFile(env.CURSOR_HISTORY_SYNC_RELEASE, 'finish');
  const nativeCompleted = await client.waitFor(message => message.method === 'turn/completed'
    && message.params.threadId === threadId && message.params.turn.id === turn.id, afterRelease);
  assert.equal(nativeCompleted.params.turn.status, 'completed');
  assert.equal(turnText(nativeCompleted.params.turn), 'Native question\nNative answer');
  await assertCompletedEvents(client, threadId, 'External later answer', afterRelease);
  const settled = await waitForRead(client, threadId, thread => thread.turns.length === 3);
  assert.deepEqual(settled.turns[0], original);
  assert.equal(settled.turns.filter(candidate => turnText(candidate).startsWith('Native question\n')).length, 1);
  assert.deepEqual(settled.turns.find(candidate => candidate.id === turn.id), nativeCompleted.params.turn, 'Transcript echo must retain the native turn ID, items, timing and completion evidence');
  assert.equal(turnText(settled.turns[2]), 'External later question\nExternal later answer');
  assert.equal((await persisted()).filter(record => record.cursorSessionId === 'native-running-session').length, 1);
  await client.close();
});
