import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { nativeTurnTextSha256, submittedTurnTextSha256 } from './live-history.mjs';
import { parseTranscript } from './history.mjs';

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
const frame = (prompt, busy, draft) => `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${['', prompt, ''].map(text => row(text, '227;227;227')).join('\n')}\n\n  Rendered partial\n\n${row('')}\n${row(draft === undefined ? `\x1b[2m→ \x1b[0;7m\x1b[48;2;242;242;242mA\x1b[0;2m\x1b[48;2;242;242;242mdd a follow-up${busy ? '    ctrl+c to stop' : ''}` : `→ ${draft}\x1b[7m \x1b[27m`)}\n${row('')}\n\n  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('/fixture/project')}\n`;

async function runFixture(scenario) {
  const submitted = scenario.startsWith('native-');
  const kind = submitted ? scenario.slice('native-'.length) : scenario;
  const home = process.env.CODEX_HOME;
  const maintenanceFile = join(home, 'fixture-maintenance');
  process.env.CURSOR_BRIDGE_MAINTENANCE_FILE = maintenanceFile;
  const threadId = 'fixture-native-chat';
  const rewrite = kind === 'envelope-rewrite';
  const fresh = ['fresh-submission', 'failed-submission', 'reverified-submission'].includes(kind);
  const envelope = (text, minute) => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;
  const catalog = '<available_subagent_types>\nAvailable subagent_types and a quick description of what they do:\n- helper: Helper\n</available_subagent_types>\n<available_subagent_models>\nIf the user explicitly asks for the model of a subagent/task, you may ONLY use model slugs from this list:\n- model-one\n</available_subagent_models>\n<dynamic_tool_catalog>\nThese dynamic tool namespaces were available when this conversation started. Availability may have changed, so use `GetDynamicTools` to check current state before calling `CallDynamicTool`.\n<dynamic_tool_namespaces>fixture tools</dynamic_tool_namespaces>\n</dynamic_tool_catalog>';
  const completeCatalog = catalog.replace('fixture tools', '<namespace name="fixture" tools="Read" namespaceUseInstructions="Read fixture data" source="fixture" />');
  const rewritten = rewrite ? parseTranscript([
    ['user', envelope('Earlier question', '00')], ['assistant', 'Earlier answer'],
    ['user', envelope('Do step five', '01')], ['assistant', 'Step five started'], ['user', completeCatalog],
    ['assistant', 'Step five canonical final answer'], ['user', envelope('Do step six', '02')], ['assistant', 'Step six running'],
  ].map(([role, text]) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })).join('\n'),
  { id: binding.sessionId, cwd: binding.cwd }) : null;
  const old = sourceTurn(rewrite ? `${binding.sessionId}:turn:19` : 'source-old', 'Earlier question', 'Earlier answer');
  if (fresh) old.sourceIdentity = { version: 1, kind: 'legacy-position', strength: 'position' };
  const canonicalOld = rewritten?.turns[0] || old;
  const freshSource = fresh ? parseTranscript(JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: envelope('Continue', '01') }] } }),
    { id: binding.sessionId, cwd: binding.cwd }).turns[0] : null;
  const current = rewritten?.turns[1] || freshSource || sourceTurn('source-current', 'Continue', 'Canonical current answer');
  if (fresh) current.items.push({ id: `${current.id}:assistant:0`, type: 'agentMessage', text: 'Canonical current answer', phase: 'final_answer' });
  const next = rewritten?.turns[2] || sourceTurn('source-next', 'Continue', 'Canonical next answer');
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
  if (submitted) {
    native.items[0].clientId = 'native-message-client';
    native.items[0].content[0].text = rewrite ? 'Do step five\n' : 'Continue\n';
    Object.assign(proof, { version: 2, origin: 'native', clientId: native.items[0].clientId, model: record.thread.model,
      userTextSha256: submittedTurnTextSha256(native), nativeUserTextSha256: nativeTurnTextSha256(native) });
  }
  if (kind === 'client-mismatch') proof.clientId = 'wrong-client';
  if (kind === 'model-mismatch') proof.model = 'wrong-model';
  if (kind === 'proof-mismatch') delete proof.nativeUserTextSha256;
  if (kind === 'queue-conflict') record.queuedSubmissions = [{ id: 'pending-queue', clientUserMessageId: 'another-client', input: [] }];
  if (kind === 'partial-at-start') {
    record.thread.turns[1] = structuredClone(current);
    record.thread.turns[1].items[1].text = 'Canonical partial';
    record.historySync.sourceTurns[current.id] = current.id;
    record.historySync.sourceItems = {};
    delete record.tmuxObserverTurns; delete record.livePreviewIds; delete record.liveSourcePreviews;
  }
  if (kind === 'startup-stale' || fresh) {
    record.thread.turns = [old]; record.historySync = { sourceTurns: { [old.id]: old.id }, sourceItems: {} };
    delete record.tmuxObserverTurns; delete record.livePreviewIds; delete record.liveSourcePreviews;
  }
  const store = join(home, 'cursor-bridge');
  await mkdir(store, { recursive: true });
  const recordPath = join(store, `${threadId}.json`);
  if (!['detached-finish', 'queue-detached-restart'].includes(kind)) await writeFile(recordPath, JSON.stringify(record));

  // Exercise the production loader, openSession, event handler and finishTurn.
  // Only the original pane discovery/model catalog are replaced with inert data;
  // no support server or Cursor executable can be called by this fixture.
  const source = (await readFile(join(directory, 'bridge.mjs'), 'utf8'))
    .replace(/(['"])\.\/([^'"]+\.mjs)\1/gu, (_match, _quote, name) => JSON.stringify(pathToFileURL(join(directory, name)).href));
  const modulePath = join(home, 'isolated-observer-bridge.mjs');
  await writeFile(modulePath, `${source}\nexport function configureFixture(binding, history, client, send, modelCatalog = null) {
    sourceHistories.set(binding.sessionId, history);
    tmuxSync = { client, bindings: [binding], refresh: async () => {} };
    catalogPromise = Promise.resolve(modelCatalog?.models || null);
    modelDefinitions = modelCatalog?.modelDefinitions || [];
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
  const completeBefore = ['finished-before-start', 'detached-finish'].includes(kind);
  let initial = rewrite ? { ...rewritten, sourceComplete: false }
    : kind === 'startup-stale' || fresh ? history([old], true)
    : kind === 'later-source' ? history([old, current, { ...next, completedAt: null }], false)
      : history([old, completeBefore ? current : unfinished], completeBefore);
  if (kind === 'source-mismatch') initial.turns[1].items[0].content[0].text = 'Different source user';
  const currentBinding = kind === 'process-mismatch' ? { ...binding, agentStartTime: '765433' } : binding;
  const client = { raw: frame(rewrite ? 'Do step six' : kind === 'startup-stale' || fresh ? 'Earlier question' : 'Continue', !fresh && !completeBefore && kind !== 'observed-model-mismatch'), calls: [],
    async capture() {
      this.calls.push('capture');
      if (kind === 'scan-during-start' && this.calls.length === 1) fixtureHistory(history([old, current], true));
      return this.raw;
    },
    verified: true,
    isVerified: () => client.verified,
    async paste(_pane, text, options) {
      if (!fresh) throw new Error('Observer must not paste');
      await options.beforePaste(); this.calls.push('paste'); this.raw = frame('Earlier question', false, text);
      await options.afterPaste();
      const snapshot = { ...history([old, current], false), sourceIdentityScheme: 'cursor-envelope-v1' };
      // The source can flush before transport acknowledges Enter. Failed
      // submission must never promote this read-only row into native proof.
      fixtureHistory(snapshot);
      if (kind === 'failed-submission') throw new Error('Fixture failed before Enter');
      this.calls.push('Enter'); this.raw = frame('Continue', true);
      if (kind === 'reverified-submission') {
        this.verified = false;
        fixtureSession(threadId).setVerified(false);
        setTimeout(() => {
          this.verified = true;
          fixtureSession(threadId)?.setVerified(true);
          fixtureHistory(snapshot);
        }, 50);
      }
    },
    async cancel() { throw new Error('Observer must not cancel'); },
  };
  const messages = [];
  const send = message => messages.push(structuredClone(message));
  configureFixture(currentBinding, initial, client, send, kind === 'observed-model-mismatch' ? {
    models: [{ model: 'composer-2.5[fast=false]' }], modelDefinitions: [{ value: 'composer-2.5', name: 'Composer 2.5',
      configOptions: [{ id: 'fast', type: 'select', name: 'Fast', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] }] }],
  } : null);
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
    if (fresh) {
      fixtureSession(threadId).now = () => Date.UTC(2026, 9, 19, 11, 1, 15);
      await bridge.receive({ id: 2, method: 'turn/start', params: { threadId,
        clientUserMessageId: 'fresh-client', input: [{ type: 'text', text: 'Continue' }] } });
      const started = messages.find(message => message.id === 2);
      assert.equal(started.error, undefined);
      const turnId = started.result.turn.id;
      if (kind === 'failed-submission') await wait(message => message.method === 'turn/completed' && message.params.turn.id === turnId);
      else {
        let during;
        for (let count = 0; count < 200; count++) {
          during = JSON.parse(await readFile(recordPath, 'utf8'));
          if (during.tmuxObserverTurns?.[turnId]?.version === 2) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(during.tmuxObserverTurns[turnId].origin, 'native');
        fixtureHistory({ ...history([old, current], true), sourceIdentityScheme: 'cursor-envelope-v1' });
        await wait(message => message.method === 'turn/completed' && message.params.turn.id === turnId);
      }
    } else if (kind === 'startup-stale') {
      await fixtureSession(threadId).poll();
    } else if (kind === 'detached-first') {
      await shutdownBridge();
    } else if (rewrite) {
      await wait(message => message.method === 'turn/completed' && message.params.turn.id === native.id);
      await fixtureSession(threadId).poll();
      await wait(message => message.method === 'turn/started' && message.params.turn.id !== native.id);
      let saved;
      for (let count = 0; count < 200; count++) {
        saved = JSON.parse(await readFile(recordPath, 'utf8'));
        if (saved.thread.turns.some(turn => turn.status === 'inProgress' && turn.id !== native.id)) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return { response, saved, messages, calls: client.calls, sourceIds: { old: canonicalOld.id, current: current.id, next: next.id } };
    } else if (kind === 'later-source') {
      await wait(message => message.method === 'turn/completed' && message.params.turn.id === native.id);
      assert.equal(messages.some(message => message.method === 'turn/completed' && message.params.turn.id === next.id), false);
      await fixtureSession(threadId).poll();
      await wait(message => message.method === 'turn/started' && message.params.turn.id !== native.id);
      fixtureHistory(history([old, current, next], true));
      await wait(message => message.method === 'turn/completed' && message.params.turn.id !== native.id);
    } else {
      if (!completeBefore && kind !== 'scan-during-start') {
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
        if (['queue-after-resume', 'queue-detached-first'].includes(kind)) {
          await bridge.receive({ id: 2, method: 'thread/queue/add', params: { threadId,
            clientUserMessageId: 'future-native-client', input: [{ type: 'text', text: 'A future queued request' }] } });
          assert.equal(messages.find(message => message.id === 2).error, undefined);
          // Block ordinary future queue execution so this test observes only
          // the already submitted source, not a legitimate second request.
          await writeFile(maintenanceFile, 'fixture-owned-maintenance');
        }
        if (kind === 'queue-detached-first') {
          await shutdownBridge();
          return { response, saved: JSON.parse(await readFile(recordPath, 'utf8')), messages, calls: client.calls };
        }
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

  test('ordinal rewrite and runtime catalog preserve the completed native fifth step while the sixth stays active', async t => {
    const result = await (await setup(t))('native-envelope-rewrite');
    assert.equal(result.error, undefined);
    assert.equal(result.saved.thread.turns.length, 3);
    const completed = result.saved.thread.turns.find(turn => turn.id === 'saved-native-turn');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.items[0].clientId, 'native-message-client');
    assert.equal(completed.items[0].content[0].text, 'Do step five\n');
    assert.match(completed.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n'), /Step five canonical final answer/);
    const next = result.saved.thread.turns.find(turn => turn.id === result.saved.historySync.sourceTurns[result.sourceIds.next]);
    assert.equal(next.status, 'inProgress');
    assert.equal(next.items[0].clientId, null);
    assert.equal(next.items[0].content[0].text, 'Do step six');
    assert.equal(result.messages.filter(message => message.method === 'turn/completed' && message.params.turn.id === completed.id).length, 1);
    assert.equal(result.messages.some(message => message.method === 'turn/completed' && message.params.turn.id === next.id), false);
    assert.ok(result.calls.every(call => call === 'capture'));
    assert.equal(result.saved.thread.model, 'composer-2.5[fast=true]');
    assert.equal(result.saved.historySync.sourceTurns[`${binding.sessionId}:turn:19`], undefined);
  });

  for (const fails of [false, true]) test(`real RPC fresh native source ${fails ? 'never records proof for a failed paste' : 'persists proof after Enter and completes the same turn'}`, async t => {
    const result = await (await setup(t))(fails ? 'native-failed-submission' : 'native-fresh-submission');
    const turn = result.saved.thread.turns.at(-1);
    assert.equal(turn.items[0].clientId, 'fresh-client');
    assert.equal(turn.items[0].content[0].text, 'Continue');
    assert.equal(turn.status, fails ? 'failed' : 'completed');
    assert.equal(result.messages.filter(message => message.method === 'turn/completed' && message.params.turn.id === turn.id).length, 1);
    assert.equal(result.calls.filter(call => call === 'Enter').length, fails ? 0 : 1);
    assert.equal(result.saved.tmuxObserverTurns?.[turn.id], undefined);
    if (fails) assert.equal(Object.values(result.saved.historySync.sourceTurns).includes(turn.id), false);
  });

  test('real RPC reattaches a native submission after temporary foreground verification loss without another Enter', async t => {
    const result = await (await setup(t))('native-reverified-submission');
    const turn = result.saved.thread.turns.at(-1);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.items[0].clientId, 'fresh-client');
    assert.equal(turn.items[0].content[0].text, 'Continue');
    assert.equal(result.saved.thread.model, 'composer-2.5[fast=true]');
    assert.equal(Object.values(result.saved.historySync.sourceTurns).filter(id => id === turn.id).length, 1);
    assert.equal(result.saved.tmuxObserverTurns?.[turn.id], undefined);
    assert.deepEqual(turn.items.filter(item => item.type === 'agentMessage').map(item => item.text), ['Canonical current answer']);
    assert.equal(result.calls.filter(call => call === 'paste').length, 1);
    assert.equal(result.calls.filter(call => call === 'Enter').length, 1);
    assert.equal(result.messages.filter(message => message.method === 'turn/started' && message.params.turn.id === turn.id).length, 1);
    assert.equal(result.messages.filter(message => message.method === 'turn/completed' && message.params.turn.id === turn.id).length, 1);
    assert.equal(result.messages.some(message => message.method === 'error'), false);
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

  for (const scenario of ['native-unfinished', 'native-finished-before-start', 'native-scan-during-start']) {
    test(`an explicitly proven submitted turn resumes without changing its client or original input: ${scenario}`, async t => {
      const result = await (await setup(t))(scenario);
      assert.equal(result.error, undefined);
      assert.equal(result.saved.thread.turns.length, 2);
      const turn = result.saved.thread.turns[1];
      assert.equal(turn.id, 'saved-native-turn');
      assert.equal(turn.status, 'completed');
      assert.deepEqual(turn.items.filter(item => item.type === 'userMessage'), [{ id: 'saved-native-user',
        type: 'userMessage', clientId: 'native-message-client', content: [{ type: 'text', text: 'Continue\n' }] }]);
      assert.deepEqual(turn.items.filter(item => item.type === 'agentMessage').map(item => [item.id, item.text]),
        [['saved-native-preview', 'Canonical current answer']]);
      assert.equal(result.saved.thread.model, 'composer-2.5[fast=true]');
      assert.equal(result.saved.historySync.sourceTurns['source-current'], turn.id);
      assert.equal(result.saved.tmuxObserverTurns[turn.id], undefined);
      assert.ok(result.calls.every(call => call === 'capture'));
      assert.equal(result.messages.some(message => message.method === 'turn/started'), false);
    });
  }

  test('submitted observer shutdown retains its proof and restarts the same native turn without resubmission', async t => {
    const run = await setup(t);
    const before = await run('native-detached-first');
    assert.equal(before.saved.thread.turns[1].status, 'inProgress');
    assert.equal(before.saved.tmuxObserverTurns['saved-native-turn'].origin, 'native');
    assert.equal(before.messages.some(message => message.method === 'turn/completed' || message.method === 'error'), false);
    const after = await run('native-detached-finish');
    assert.equal(after.saved.thread.turns[1].id, before.saved.thread.turns[1].id);
    assert.deepEqual(after.saved.thread.turns[1].items[0], before.saved.thread.turns[1].items[0]);
    assert.equal(after.saved.thread.turns[1].status, 'completed');
    assert.ok([...before.calls, ...after.calls].every(call => call === 'capture'));
  });

  test('queue/add after native recovery preserves the original raw user through completion', async t => {
    const result = await (await setup(t))('native-queue-after-resume');
    assert.equal(result.error, undefined);
    assert.equal(result.saved.thread.turns.length, 2);
    const turn = result.saved.thread.turns[1];
    assert.equal(turn.id, 'saved-native-turn');
    assert.equal(turn.status, 'completed');
    assert.deepEqual(turn.items[0], { id: 'saved-native-user', type: 'userMessage', clientId: 'native-message-client',
      content: [{ type: 'text', text: 'Continue\n' }] });
    assert.equal(result.saved.queuedSubmissions.length, 1);
    assert.equal(result.saved.queuedSubmissions[0].clientUserMessageId, 'future-native-client');
    assert.equal(result.messages.filter(message => message.method === 'turn/completed').length, 1);
    assert.equal(result.messages.some(message => message.method === 'turn/started'), false);
    assert.ok(result.calls.every(call => call === 'capture'));
  });

  test('queue/add then shutdown keeps native ownership, and queued restart refuses adoption without replay', async t => {
    const run = await setup(t);
    const before = await run('native-queue-detached-first');
    assert.equal(before.saved.thread.turns[1].status, 'inProgress');
    assert.equal(before.saved.tmuxObserverTurns['saved-native-turn'].origin, 'native');
    assert.equal(before.saved.queuedSubmissions.length, 1);
    assert.equal(before.messages.some(message => message.method === 'turn/completed' || message.method === 'error'), false);
    const after = await run('native-queue-detached-restart');
    assert.match(after.error.message, /saved Cursor observer cannot be verified/);
    assert.equal(after.saved.thread.turns[1].status, 'inProgress');
    assert.deepEqual(after.saved.thread.turns[1].items[0], before.saved.thread.turns[1].items[0]);
    assert.deepEqual(after.saved.tmuxObserverTurns, before.saved.tmuxObserverTurns);
    assert.deepEqual(after.saved.queuedSubmissions, before.saved.queuedSubmissions);
    assert.deepEqual(after.calls, []);
  });

  for (const scenario of ['process-mismatch', 'source-mismatch', 'client-mismatch', 'model-mismatch', 'proof-mismatch', 'queue-conflict', 'observed-model-mismatch']) {
    test(`submitted recovery blocks corrupt evidence without retrying or interrupting: ${scenario}`, async t => {
      const result = await (await setup(t))(`native-${scenario}`);
      assert.match(result.error.message, /saved (?:Cursor observer|native Cursor turn)/);
      assert.equal(result.saved.thread.turns[1].status, 'inProgress');
      assert.equal(result.saved.thread.model, 'composer-2.5[fast=true]');
      assert.equal(result.saved.thread.turns[1].items[0].clientId, 'native-message-client');
      assert.equal(result.saved.thread.turns[1].items[0].content[0].text, 'Continue\n');
      assert.ok(result.calls.every(call => call === 'capture'));
      assert.equal(result.messages.some(message => message.method === 'turn/completed'), false);
    });
  }

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
