import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));
const binding = { paneId: '%8', panePid: 200, agentPid: 201, agentStartTime: '765432', sessionId: 'fixture-cursor-session', cwd: '/fixture/project' };
const sourceTurn = (id, text, reply) => ({
  id, rootTurnId: id, status: 'completed', error: null, startedAt: 100, completedAt: 101,
  items: [{ id: `${id}-user`, type: 'userMessage', clientId: null, content: [{ type: 'text', text }] },
    { id: `${id}-agent`, type: 'agentMessage', text: reply, phase: 'final_answer' }],
});
const reset = '\x1b[0m';
const dim = text => `\x1b[2m${text}${reset}`;
const row = (text, rgb = '242;242;242') => ` \x1b[48;2;${rgb}m ${text}${' '.repeat(70)}\x1b[49m`;
const frame = (prompt, busy) => `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${['', prompt, ''].map(text => row(text, '227;227;227')).join('\n')}\n\n  Rendered partial\n\n${row('')}\n${row(`\x1b[2m→ \x1b[0;7m\x1b[48;2;242;242;242mA\x1b[0;2m\x1b[48;2;242;242;242mdd a follow-up${busy ? '    ctrl+c to stop' : ''}`)}\n${row('')}\n\n  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('/fixture/project')}\n`;

async function runFixture(scenario) {
  const home = process.env.CODEX_HOME;
  const threadId = 'fixture-native-chat';
  const old = sourceTurn('source-old', 'Earlier question', 'Earlier answer');
  const current = sourceTurn('source-current', 'Continue', 'Canonical current answer');
  const next = sourceTurn('source-next', 'Continue', 'Canonical next answer');
  const native = structuredClone(current);
  native.id = 'saved-native-turn'; native.rootTurnId = native.id;
  native.status = 'inProgress'; native.completedAt = null;
  native.items[0].id = 'saved-native-user'; native.items[1].id = 'saved-native-preview';
  native.items[1].text = 'Rendered partial'; native.items[1].phase = 'commentary';
  const proof = { version: 1, sourceTurnId: current.id, sessionId: binding.sessionId,
    paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime };
  const record = {
    version: 1, backend: 'legacy', cursorSessionId: binding.sessionId,
    tmuxAffinity: { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime },
    historySync: { sourceTurns: { [old.id]: old.id, [current.id]: native.id }, sourceItems: {
      [current.items[0].id]: native.items[0].id, [current.items[1].id]: native.items[1].id,
    } },
    tmuxObserverTurns: { [native.id]: proof }, livePreviewIds: { [native.id]: native.items[1].id },
    liveSourcePreviews: { [native.id]: true },
    thread: { id: threadId, cwd: binding.cwd, model: 'composer-2.5[fast=true]', name: 'Synthetic conversation', turns: [old, native] },
  };
  if (scenario === 'partial-at-start') {
    record.thread.turns[1] = structuredClone(current);
    record.thread.turns[1].items[1].text = 'Canonical partial';
    record.historySync.sourceTurns[current.id] = current.id;
    record.historySync.sourceItems = {};
    delete record.tmuxObserverTurns; delete record.livePreviewIds; delete record.liveSourcePreviews;
  }
  if (scenario === 'startup-stale') {
    record.thread.turns = [old]; record.historySync = { sourceTurns: { [old.id]: old.id }, sourceItems: {} };
    delete record.tmuxObserverTurns; delete record.livePreviewIds; delete record.liveSourcePreviews;
  }
  const store = join(home, 'cursor-bridge');
  await mkdir(store, { recursive: true });
  const recordPath = join(store, `${threadId}.json`);
  if (scenario !== 'detached-finish') await writeFile(recordPath, JSON.stringify(record));

  // Exercise the production loader, openSession, event handler and finishTurn.
  // Only the original pane discovery/model catalog are replaced with inert data;
  // no support server or Cursor executable can be called by this fixture.
  const source = (await readFile(join(directory, 'bridge.mjs'), 'utf8'))
    .replace(/(['"])\.\/([^'"]+\.mjs)\1/gu, (_match, _quote, name) => JSON.stringify(pathToFileURL(join(directory, name)).href));
  const modulePath = join(home, 'isolated-observer-bridge.mjs');
  await writeFile(modulePath, `${source}\nexport function configureFixture(binding, history, client, send) {
    sourceHistories.set(binding.sessionId, history);
    tmuxSync = { client, bindings: [binding], refresh: async () => {} };
    catalogPromise = Promise.resolve(null);
    clients.add({ send });
  }
  export function fixtureHistory(history) {
    sourceHistories.set(history.id, history);
    for (const session of sessions.values()) session.acceptHistory(history);
  }
  export function fixtureSession(id) { return sessions.get(id); }\n`);
  const { createBridge, configureFixture, fixtureHistory, fixtureSession, shutdownBridge } = await import(pathToFileURL(modulePath).href);
  const history = (turns, complete) => ({ id: binding.sessionId, cwd: binding.cwd, sourceComplete: complete,
    completedTurnIds: (complete ? turns : turns.slice(0, -1)).map(turn => turn.id), turns });
  const unfinished = { ...structuredClone(current), status: 'completed', completedAt: null };
  unfinished.items[1].text = 'Canonical partial';
  const completeBefore = ['finished-before-start', 'detached-finish'].includes(scenario);
  let initial = scenario === 'startup-stale' ? history([old], true)
    : scenario === 'later-source' ? history([old, current, { ...next, completedAt: null }], false)
      : history([old, completeBefore ? current : unfinished], completeBefore);
  if (scenario === 'source-mismatch') initial.turns[1].items[0].content[0].text = 'Different source user';
  const currentBinding = scenario === 'process-mismatch' ? { ...binding, agentStartTime: '765433' } : binding;
  const client = { raw: frame(scenario === 'startup-stale' ? 'Earlier question' : 'Continue', !completeBefore), calls: [],
    async capture() {
      this.calls.push('capture');
      if (scenario === 'scan-during-start' && this.calls.length === 1) fixtureHistory(history([old, current], true));
      return this.raw;
    },
    isVerified: () => true,
    async paste() { throw new Error('Observer must not paste'); },
    async cancel() { throw new Error('Observer must not cancel'); },
  };
  const messages = [];
  const send = message => messages.push(structuredClone(message));
  configureFixture(currentBinding, initial, client, send);
  const bridge = createBridge({ send });
  const wait = async predicate => {
    for (let count = 0; count < 200; count++) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Synthetic observer did not settle');
  };
  try {
    await bridge.receive({ id: 1, method: 'thread/resume', params: { threadId } });
    const response = messages.find(message => message.id === 1);
    if (response.error) return { error: response.error, messages, calls: client.calls,
      saved: JSON.parse(await readFile(recordPath, 'utf8')) };
    if (scenario === 'startup-stale') {
      await fixtureSession(threadId).poll();
    } else if (scenario === 'detached-first') {
      await shutdownBridge();
    } else if (scenario === 'later-source') {
      await wait(message => message.method === 'turn/completed' && message.params.turn.id === native.id);
      assert.equal(messages.some(message => message.method === 'turn/completed' && message.params.turn.id === next.id), false);
      await fixtureSession(threadId).poll();
      await wait(message => message.method === 'turn/started' && message.params.turn.id !== native.id);
      fixtureHistory(history([old, current, next], true));
      await wait(message => message.method === 'turn/completed' && message.params.turn.id !== native.id);
    } else {
      if (!completeBefore && scenario !== 'scan-during-start') {
        await wait(message => message.method === 'thread/status/changed' && message.params.status.type === 'active');
        let during;
        for (let count = 0; count < 200; count++) {
          during = JSON.parse(await readFile(recordPath, 'utf8'));
          if (during.thread.turns[1].status === 'inProgress' && during.tmuxObserverTurns?.[during.thread.turns[1].id]) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(during.thread.turns.length, 2);
        assert.equal(during.thread.turns[1].status, 'inProgress');
        assert.ok(during.tmuxObserverTurns[during.thread.turns[1].id]);
        fixtureHistory(history([old, current], true));
      }
      await wait(message => message.method === 'turn/completed');
    }
    const saved = JSON.parse(await readFile(recordPath, 'utf8'));
    return { response, saved, messages, calls: client.calls };
  } finally { await bridge.close(); await shutdownBridge(); }
}

if (process.argv[2] === '--observer-fixture') {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3])));
} else {
  async function setup(t) {
    const home = await mkdtemp(join(tmpdir(), 'cursor-observer-recovery-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    return async scenario => {
      const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--observer-fixture', scenario], {
        env: { ...process.env, CODEX_HOME: home, CURSOR_BRIDGE_AGENT: '/fixture/must-not-run', CURSOR_BRIDGE_REAL_CODEX: '/fixture/must-not-run' }, timeout: 8000,
      });
      return JSON.parse(stdout);
    };
  }

  for (const scenario of ['unfinished', 'finished-before-start', 'partial-at-start', 'scan-during-start']) {
    test(`the real RPC loader adopts one canonical observer without replaying input: ${scenario}`, async t => {
      const result = await (await setup(t))(scenario);
      assert.equal(result.error, undefined);
      assert.equal(result.saved.thread.turns.length, 2);
      const native = result.saved.thread.turns[1];
      assert.equal(native.id, scenario === 'partial-at-start' ? 'source-current' : 'saved-native-turn');
      assert.equal(native.status, 'completed');
      assert.equal(native.items.filter(item => item.type === 'userMessage').length, 1);
      assert.deepEqual(native.items.filter(item => item.type === 'agentMessage').map(item => item.text), ['Canonical current answer']);
      assert.equal(result.saved.historySync.sourceTurns['source-current'], native.id);
      assert.equal(result.saved.tmuxObserverTurns[native.id], undefined);
      assert.equal(result.saved.thread.model, 'composer-2.5[fast=true]');
      assert.ok(result.calls.every(call => call === 'capture'));
    });
  }

  test('a source completing during disconnect and a later identical prompt keep separate native identities', async t => {
    const result = await (await setup(t))('later-source');
    assert.equal(result.saved.thread.turns.length, 3);
    assert.equal(result.saved.thread.turns[1].id, 'saved-native-turn');
    assert.equal(result.saved.thread.turns[1].items.at(-1).text, 'Canonical current answer');
    assert.equal(result.saved.thread.turns[2].items.at(-1).text, 'Canonical next answer');
    assert.equal(result.saved.thread.turns[2].status, 'completed');
    assert.notEqual(result.saved.historySync.sourceTurns['source-current'], result.saved.historySync.sourceTurns['source-next']);
    assert.equal(result.messages.filter(message => message.method === 'turn/completed').length, 2);
  });

  test('a graceful observer shutdown preserves the running source and a later process recovers the same native ID', async t => {
    const run = await setup(t);
    const before = await run('detached-first');
    assert.equal(before.saved.thread.turns[1].status, 'inProgress');
    assert.ok(before.saved.tmuxObserverTurns['saved-native-turn']);
    assert.equal(before.messages.some(message => message.method === 'turn/completed' || message.method === 'error'), false);
    const after = await run('detached-finish');
    assert.equal(after.saved.thread.turns.length, 2);
    assert.equal(after.saved.thread.turns[1].id, 'saved-native-turn');
    assert.equal(after.saved.thread.turns[1].status, 'completed');
  });

  for (const scenario of ['process-mismatch', 'source-mismatch']) {
    test(`observer recovery refuses ambiguous evidence and never starts another Agent: ${scenario}`, async t => {
      const result = await (await setup(t))(scenario);
      assert.match(result.error.message, /saved Cursor observer cannot be verified/);
      assert.equal(result.saved.thread.turns[1].status, 'inProgress');
      assert.deepEqual(result.calls, []);
      assert.equal(result.messages.some(message => message.method === 'turn/completed'), false);
    });
  }

  test('the real bridge does not create a native turn from a stale busy startup frame', async t => {
    const result = await (await setup(t))('startup-stale');
    assert.equal(result.saved.thread.turns.length, 1);
    assert.equal(result.messages.some(message => message.method === 'turn/started'), false);
  });
}
