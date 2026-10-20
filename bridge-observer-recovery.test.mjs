import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseTranscript } from './history.mjs';
import { nativeTurnTextSha256, submittedTurnTextSha256 } from './live-history.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const threadId = 'observer-recovery-native-chat';
const nativeId = 'original-observer-turn';
const model = 'composer-2.5[fast=true]';
const draft = 'Private CLI draft stays exactly here';
const originalBinding = { paneId: '%8', panePid: 200, agentPid: 201, agentStartTime: '765432',
  sessionId: 'observer-recovery-cursor-session', cwd: '/fixture/project' };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const reset = '\x1b[0m';
const dim = text => `\x1b[2m${text}${reset}`;
const row = (text, rgb = '242;242;242') => ` \x1b[48;2;${rgb}m ${text}${' '.repeat(80)}\x1b[49m`;
const frame = (busy, privateDraft = false) => `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${['', 'Do the requested work', ''].map(text => row(text, '227;227;227')).join('\n')}\n\n  Rendered partial\n\n${row('')}\n${row(privateDraft ? `→ ${draft}\x1b[7m \x1b[27m` : `\x1b[2m→ \x1b[0;7m\x1b[48;2;242;242;242mA\x1b[0;2m\x1b[48;2;242;242;242mdd a follow-up${busy ? '    ctrl+c to stop' : ''}`)}\n${row('')}\n\n  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('/fixture/project')}\n`;
const transcriptRow = (role, text) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
const ended = JSON.stringify({ type: 'turn_ended', status: 'success' });
const envelope = (text, minute) => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;

function histories() {
  const earlier = [transcriptRow('user', envelope('An earlier distinct request', '00')),
    transcriptRow('assistant', 'Earlier historical answer\n\nwith its original lines.'), ended];
  const request = transcriptRow('user', envelope('Do the requested work', '01'));
  const parse = rows => parseTranscript(rows.join('\n'), { id: originalBinding.sessionId, cwd: originalBinding.cwd });
  const stable = parse([...earlier, request, transcriptRow('assistant', 'Rendered partial')]);
  const complete = parse([...earlier, request,
    transcriptRow('assistant', `Canonical first answer\n\n${'full source text '.repeat(1800)}\nLast line A.`), ended,
    request, transcriptRow('assistant', 'Canonical second answer\n\nLast line B.'), ended]);
  // The scanner supplies snapshot completion in addition to parsed end markers.
  stable.sourceComplete = false;
  complete.sourceComplete = true;
  return { stable, complete };
}

function savedRecord(stable, native) {
  const source = stable.turns.at(-1);
  const turn = structuredClone(source);
  Object.assign(turn, { id: nativeId, rootTurnId: nativeId, status: 'inProgress', completedAt: null });
  turn.items[0].id = 'original-native-user';
  turn.items[1].id = 'original-native-preview';
  turn.items[1].phase = 'commentary';
  const proof = { version: 1, sourceTurnId: source.id, sessionId: originalBinding.sessionId,
    paneId: originalBinding.paneId, agentPid: originalBinding.agentPid, agentStartTime: originalBinding.agentStartTime };
  if (native) {
    turn.items[0].clientId = 'original-native-client';
    Object.assign(proof, { version: 2, origin: 'native', clientId: turn.items[0].clientId, model,
      userTextSha256: submittedTurnTextSha256(turn), nativeUserTextSha256: nativeTurnTextSha256(turn) });
  }
  const earlier = structuredClone(stable.turns[0]);
  return { version: 1, backend: 'legacy', cursorSessionId: originalBinding.sessionId,
    tmuxAffinity: { paneId: originalBinding.paneId, agentPid: originalBinding.agentPid, agentStartTime: originalBinding.agentStartTime },
    historySync: { version: 1, sourceTurns: { [earlier.id]: earlier.id, [source.id]: nativeId },
      sourceItems: { [source.items[0].id]: turn.items[0].id, [source.items[1].id]: turn.items[1].id } },
    tmuxObserverTurns: { [nativeId]: proof }, livePreviewIds: { [nativeId]: turn.items[1].id },
    liveSourcePreviews: { [nativeId]: true },
    thread: { id: threadId, cwd: originalBinding.cwd, model, name: 'Synthetic recovery fixture',
      status: { type: 'active', activeFlags: [] }, turns: [earlier, turn] } };
}

async function runFixture(scenario) {
  const { stable, complete } = histories();
  const native = scenario.startsWith('native-');
  const live = scenario.endsWith('live') || scenario === 'persistence-failure';
  const initial = savedRecord(stable, native);
  const home = process.env.CODEX_HOME;
  const store = join(home, 'cursor-bridge');
  const recordPath = join(store, `${threadId}.json`);
  await mkdir(store, { recursive: true });
  await writeFile(recordPath, JSON.stringify(initial));

  // Only pane discovery and terminal I/O are replaced. Loading, locking,
  // retirement, persistence, RPC recovery and native notifications are real.
  const tmuxModulePath = join(home, 'inert-tmux-client.mjs');
  await writeFile(tmuxModulePath, 'export class TmuxClient { constructor() { return globalThis.observerRecoveryClient; } }\n');
  const source = (await readFile(join(directory, 'bridge.mjs'), 'utf8'))
    .replace(/(['"])\.\/([^'"]+\.mjs)\1/gu, (_match, _quote, name) => JSON.stringify(pathToFileURL(
      name === 'tmux.mjs' ? tmuxModulePath : join(directory, name)).href))
    // Discovery is inert, so the production periodic loop can run on macOS too.
    .replace("process.platform !== 'linux'", 'false');
  const modulePath = join(home, 'isolated-recovery-bridge.mjs');
  await writeFile(modulePath, `${source}
export async function fixtureConfigure(history, client, send) {
  initializedStore ||= loadStore(); await initializedStore;
  sourceHistories.set(history.id, history);
  tmuxSync = { client, bindings: [client.binding], refresh: async () => {} };
  catalogPromise = Promise.resolve(null);
  clients.add({ send });
}
export function fixtureHistory(history) {
  sourceHistories.set(history.id, history);
  for (const session of sessions.values()) session.acceptHistory(history);
}
export function fixtureBinding(binding) { tmuxSync.bindings = [binding]; }
export function fixtureState() {
  const record = records.get(${JSON.stringify(threadId)});
  const execution = turnExecutions.get(record.thread.id);
  return { record: structuredClone(record), running: runningTurns.has(record.thread.id),
    execution: execution ? { turnId: execution.turnId, retiring: execution.retiring } : null,
    session: sessions.get(record.thread.id)?.state ?? null };
}
export async function fixtureRetire() {
  const record = records.get(${JSON.stringify(threadId)});
  return withThreadLock(record.thread.id, () => retireCompletedObserver(record));
}
export async function fixtureStartAutomatic() {
  tmuxSync = null;
  historySync = { stopped: false, timer: null, pending: null };
  await startTmuxSync(() => {}, async () => {});
}
export function fixtureFailNextSave() {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === ${JSON.stringify(recordPath)}) { fs.rename = rename; throw new Error('fixture durable write failed'); }
    return rename(from, to);
  };
}
`);
  const fixture = await import(pathToFileURL(modulePath).href);
  const messages = [];
  const calls = [];
  let captureHook;
  const client = {
    binding: structuredClone(originalBinding), raw: frame(live),
    async discover() { calls.push('discover'); return [this.binding]; },
    async verifiedBinding(candidate) { calls.push('verifiedBinding'); return this.isVerified(candidate) ? candidate : null; },
    isVerified(candidate) { return candidate?.agentPid === this.binding.agentPid
      && candidate?.agentStartTime === this.binding.agentStartTime && candidate?.paneId === this.binding.paneId; },
    async capture() { calls.push('capture'); const result = this.raw; await captureHook?.(); return result; },
  };
  for (const method of ['paste', 'cancel', 'sendKey', 'sendKeys', 'sendRaw', 'setModel']) client[method] = async () => {
    calls.push(method); throw new Error(`Recovery must not call ${method}`);
  };
  globalThis.observerRecoveryClient = client;
  const send = message => messages.push(structuredClone(message));
  await fixture.fixtureConfigure(live ? stable : complete, client, send);
  const bridge = fixture.createBridge({ send });
  let response;
  try {
    if (live) {
      await bridge.receive({ id: 1, method: 'thread/resume', params: { threadId } });
      response = messages.find(message => message.id === 1);
      assert.equal(response.error, undefined);
      assert.equal(fixture.fixtureState().execution?.turnId, nativeId);
      fixture.fixtureHistory(complete);
    }
    client.raw = frame(false, true);
    const unchangedFrame = client.raw;
    const before = fixture.fixtureState();
    const since = messages.length;
    let first;
    let afterFirst;
    if (scenario === 'automatic-busy-then-idle') {
      client.raw = frame(true);
      await fixture.fixtureStartAutomatic();
      afterFirst = fixture.fixtureState();
      assert.equal(afterFirst.record.thread.turns.at(-1).status, 'inProgress');
      assert.equal(messages.slice(since).some(message => message.method === 'turn/completed'), false);
      client.raw = unchangedFrame;
      // No scanner callback, client resume, or history replacement occurs.
      for (let count = 0; count < 120 && fixture.fixtureState().record.thread.turns.some(turn => turn.status === 'inProgress'); count++) await delay(25);
      first = true;
    } else if (scenario === 'restart') {
      await bridge.receive({ id: 2, method: 'thread/resume', params: { threadId } });
      response = messages.find(message => message.id === 2);
      assert.equal(response.error, undefined);
      first = true;
    } else if (scenario.startsWith('native-') && !live) {
      first = await fixture.fixtureRetire();
      await bridge.receive({ id: 2, method: 'thread/resume', params: { threadId } });
      response = messages.find(message => message.id === 2);
    } else {
      if (scenario.includes('race')) {
        let captures = 0;
        captureHook = async () => {
          if (++captures !== (scenario.includes('commit') ? 2 : 1)) return;
          if (scenario.startsWith('history-')) fixture.fixtureHistory(structuredClone(complete));
          else {
            client.binding = { ...client.binding, agentStartTime: '765433' };
            fixture.fixtureBinding(client.binding);
          }
        };
      }
      if (scenario === 'persistence-failure') fixture.fixtureFailNextSave();
      try { first = await fixture.fixtureRetire(); }
      catch (error) { first = { error: error.message }; }
      if (scenario === 'persistence-failure') {
        afterFirst = { ...fixture.fixtureState(), saved: JSON.parse(await readFile(recordPath, 'utf8')),
          messages: messages.slice(since) };
        assert.match(first.error, /fixture durable write failed/);
        assert.equal(await fixture.fixtureRetire(), true);
      }
    }
    return { scenario, first, afterFirst, before, state: fixture.fixtureState(),
      saved: JSON.parse(await readFile(recordPath, 'utf8')), source: complete,
      messages: messages.slice(since), calls, response,
      frameUnchanged: client.raw === unchangedFrame, binding: client.binding };
  } finally { await bridge.close(); await fixture.shutdownBridge(); }
}

if (process.argv[2] === '--recovery-fixture') {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3])));
} else {
  async function run(t, scenario) {
    const home = await mkdtemp(join(tmpdir(), 'cursor-observer-retirement-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(import.meta.url), '--recovery-fixture', scenario], {
        env: { ...process.env, CODEX_HOME: home, CURSOR_BRIDGE_AGENT: '/fixture/must-not-run',
          CURSOR_BRIDGE_REAL_CODEX: '/fixture/must-not-run' }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      });
    return JSON.parse(stdout);
  }

  function assertReadOnly(result) {
    assert.ok(result.calls.every(call => ['discover', 'verifiedBinding', 'capture'].includes(call)), result.calls);
    assert.equal(result.frameUnchanged, true, 'The private terminal draft must remain byte-for-byte unchanged');
    assert.equal(result.saved.thread.model, model);
  }

  function assertRecovered(result) {
    assertReadOnly(result);
    assert.equal(result.saved.thread.status.type, 'idle');
    assert.equal(result.saved.thread.turns.some(turn => turn.status === 'inProgress'), false);
    const before = result.before.record.thread.turns.find(turn => turn.id === nativeId);
    const retired = result.saved.thread.turns.find(turn => turn.id === nativeId);
    assert.equal(retired.status, 'interrupted');
    assert.deepEqual(retired.items, before.items, 'Retirement preserves every original native item');
    assert.match(retired.error?.message || '', /(?:ambiguous|ownership|identity|duplicate)/i);
    assert.equal(result.saved.tmuxObserverTurns?.[nativeId], undefined);
    assert.equal(result.saved.historySync.sourceTurns[result.before.record.tmuxObserverTurns[nativeId].sourceTurnId], undefined);
    assert.deepEqual(result.binding, originalBinding);
    assert.equal(result.state.running, false);
    assert.equal(result.state.execution, null);
    const earlier = result.before.record.thread.turns.find(turn => turn.id !== nativeId);
    assert.deepEqual(result.saved.thread.turns.find(turn => turn.id === earlier.id), earlier,
      'The existing historical card remains byte-for-byte equivalent');
    for (const source of result.source.turns) {
      const card = result.saved.thread.turns.find(turn => turn.id === result.saved.historySync.sourceTurns[source.id]);
      assert.ok(card, source.id);
      assert.notEqual(card.id, nativeId, 'An ambiguous display source cannot claim the interrupted observer');
      assert.equal(card.status, 'completed');
      assert.deepEqual(card.items, source.items, 'Canonical cards retain full source text and item identities');
    }
    const completed = result.messages.filter(message => message.method === 'turn/completed');
    assert.equal(completed.filter(message => message.params.turn.id === nativeId).length, 1);
    assert.equal(completed.find(message => message.params.turn.id === nativeId).params.turn.status, 'interrupted');
    assert.ok(result.messages.some(message => message.method === 'thread/status/changed' && message.params.status.type === 'idle'));
    assert.equal(result.messages.some(message => message.method === 'error'), false);
  }

  test('a live real observer retires and notifies the native client without reopening the chat or typing', async t => {
    const result = await run(t, 'external-live');
    assert.equal(result.before.running, true);
    assert.equal(result.first, true);
    assertRecovered(result);
  });

  test('RPC ensureSession recovers the persisted external observer after a bridge restart', async t => {
    const result = await run(t, 'restart');
    assert.equal(result.before.execution, null);
    assertRecovered(result);
    assert.equal(result.response.result.thread.turns.find(turn => turn.id === nativeId).status, 'interrupted');
  });

  test('the production automatic tick retries busy then idle with unchanged history and no thread/resume', async t => {
    const result = await run(t, 'automatic-busy-then-idle');
    assert.equal(result.afterFirst.record.thread.turns.find(turn => turn.id === nativeId).status, 'inProgress');
    assertRecovered(result);
    assert.ok(result.calls.filter(call => call === 'discover').length >= 2);
  });

  for (const scenario of ['history-race', 'history-commit-race', 'binding-race', 'binding-commit-race']) {
    test(`a changed observation after capture cannot retire the saved observer: ${scenario}`, async t => {
      const result = await run(t, scenario);
      assert.equal(result.first, false);
      assert.deepEqual(result.state.record, result.before.record);
      assert.equal(result.saved.thread.turns.find(turn => turn.id === nativeId).status, 'inProgress');
      assert.equal(result.messages.some(message => message.method === 'turn/completed'
        || message.method === 'thread/status/changed' && message.params.status.type === 'idle'), false);
      assertReadOnly(result);
    });
  }

  for (const scenario of ['native-live', 'native-restart']) {
    test(`ambiguous native v2 ownership stays held without resubmission or false completion: ${scenario}`, async t => {
      const result = await run(t, scenario);
      assert.equal(result.first, false);
      assert.deepEqual(result.state.record, result.before.record);
      assert.equal(result.saved.thread.turns.find(turn => turn.id === nativeId).status, 'inProgress');
      assert.equal(result.saved.tmuxObserverTurns[nativeId].version, 2);
      assert.equal(result.messages.some(message => message.method === 'turn/completed'
        || message.method === 'thread/status/changed' && message.params.status.type === 'idle'), false);
      if (scenario === 'native-restart') assert.match(result.response.error.message, /saved Cursor observer cannot be verified/);
      assertReadOnly(result);
    });
  }

  test('a failed durable retirement emits no idle or completion and later retries without losing any cards', async t => {
    const result = await run(t, 'persistence-failure');
    assert.deepEqual(result.afterFirst.record, result.before.record);
    assert.equal(result.afterFirst.saved.thread.turns.find(turn => turn.id === nativeId).status, 'inProgress');
    assert.ok(result.afterFirst.saved.tmuxObserverTurns[nativeId]);
    assert.equal(result.afterFirst.messages.some(message => message.method === 'turn/completed'
      || message.method === 'thread/status/changed' && message.params.status.type === 'idle'), false);
    assertRecovered(result);
  });
}
