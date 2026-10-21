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
import { DETACHED_OBSERVER_ERROR } from './export-recovery.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const threadId = 'export-recovery-native-chat';
const nativeId = 'original-native-turn';
const clientId = 'original-native-client';
const model = 'composer-2.5[fast=true]';
const rawInput = 'Keep these blank lines.\n\n\n\nAnd this final line.\n';
const exportedInput = 'Keep these blank lines.\n\nAnd this final line.';
const laterInput = 'A later independent request';
const draft = 'Private CLI draft remains untouched';
const answer = 'The full canonical answer.\n\nAll its lines remain intact.';
const binding = { paneId: '%8', panePid: 200, agentPid: 201, agentStartTime: '765432',
  sessionId: 'export-recovery-cursor-session', cwd: '/fixture/project' };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const reset = '\x1b[0m';
const dim = text => `\x1b[2m${text}${reset}`;
const row = (text, rgb = '242;242;242') => ` \x1b[48;2;${rgb}m ${text}${' '.repeat(80)}\x1b[49m`;
function frame(prompt, busy, privateDraft = false) {
  const input = privateDraft ? `→ ${draft}\x1b[7m \x1b[27m`
    : `\x1b[2m→ \x1b[0;7m\x1b[48;2;242;242;242mA\x1b[0;2m\x1b[48;2;242;242;242mdd a follow-up${busy ? '    ctrl+c to stop' : ''}`;
  return `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${['', ...prompt.split('\n'), ''].map(text => row(text, '227;227;227')).join('\n')}\n\n  Rendered partial\n\n${row('')}\n${row(input)}\n${row('')}\n\n  ${dim('Composer 2.5 · 5.1%')}\n  ${dim(binding.cwd)}\n`;
}
const transcriptRow = (role, text) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
const ended = JSON.stringify({ type: 'turn_ended', status: 'success' });
const envelope = (text, minute) => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;
function histories() {
  const earlier = [transcriptRow('user', envelope('An earlier distinct request', '00')),
    transcriptRow('assistant', 'The earlier answer.'), ended];
  const request = transcriptRow('user', envelope(exportedInput, '01'));
  const parse = rows => parseTranscript(rows.join('\n'), { id: binding.sessionId, cwd: binding.cwd });
  const stable = parse([...earlier, request, transcriptRow('assistant', 'Rendered partial')]);
  stable.sourceComplete = false;
  const complete = parse([...earlier, request, transcriptRow('assistant', answer), ended]);
  complete.sourceComplete = true;
  const advanced = parse([...earlier, request, transcriptRow('assistant', answer), ended,
    transcriptRow('user', envelope(laterInput, '02')), transcriptRow('assistant', 'Working on the later request')]);
  advanced.sourceComplete = false;
  return { stable, complete, advanced };
}
function savedRecord(history, scenario) {
  const source = history.turns[1];
  const turn = structuredClone(source);
  Object.assign(turn, { id: nativeId, rootTurnId: nativeId,
    status: scenario === 'unbound-failed' ? 'failed' : 'inProgress',
    error: scenario === 'unbound-failed' ? { message: DETACHED_OBSERVER_ERROR } : null,
    startedAt: Date.parse('2026-10-19T11:01:00Z') / 1000, completedAt: null });
  turn.items[0] = { ...turn.items[0], id: 'original-native-user', clientId, content: [{ type: 'text', text: rawInput }] };
  turn.items[1] = { ...turn.items[1], id: 'original-native-preview', text: 'Rendered partial', phase: 'commentary' };
  const earlier = structuredClone(history.turns[0]);
  const record = { version: 1, backend: 'legacy', cursorSessionId: binding.sessionId,
    tmuxAffinity: { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime },
    historySync: { version: 1, sourceTurns: { [earlier.id]: earlier.id }, sourceItems: {} },
    livePreviewIds: { [nativeId]: turn.items[1].id }, liveSourcePreviews: { [nativeId]: true },
    thread: { id: threadId, cwd: binding.cwd, model, name: 'Synthetic export recovery fixture',
      status: { type: 'active', activeFlags: [] }, turns: [earlier, turn] } };
  if (scenario === 'v3-restart') {
    record.historySync.sourceTurns[source.id] = nativeId;
    record.historySync.sourceItems[source.items[0].id] = turn.items[0].id;
    record.historySync.sourceItems[source.items[1].id] = turn.items[1].id;
    record.tmuxObserverTurns = { [nativeId]: { version: 3, origin: 'native', sourceTurnId: source.id,
      sessionId: binding.sessionId, paneId: binding.paneId, agentPid: binding.agentPid,
      agentStartTime: binding.agentStartTime, clientId, model,
      userTextSha256: submittedTurnTextSha256(source), nativeUserTextSha256: nativeTurnTextSha256(turn) } };
  }
  return record;
}

async function runFixture(scenario) {
  const all = histories();
  const initial = savedRecord(all.stable, scenario);
  const home = process.env.CODEX_HOME;
  const store = join(home, 'cursor-bridge');
  const recordPath = join(store, `${threadId}.json`);
  await mkdir(store, { recursive: true });
  await writeFile(recordPath, JSON.stringify(initial));
  const tmuxModulePath = join(home, 'inert-tmux-client.mjs');
  await writeFile(tmuxModulePath, 'export class TmuxClient { constructor() { return globalThis.exportRecoveryClient; } }\n');
  // Run the real bridge lifecycle, periodic retirement, persistence, RPCs and
  // notifications. Only Linux discovery/terminal I/O are replaced by a fixture.
  const source = (await readFile(join(directory, 'bridge.mjs'), 'utf8'))
    .replace(/(['"])\.\/([^'"]+\.mjs)\1/gu, (_match, _quote, name) => JSON.stringify(pathToFileURL(
      name === 'tmux.mjs' ? tmuxModulePath : join(directory, name)).href))
    .replace("process.platform !== 'linux'", 'false')
    .replace('function scheduleQueue(threadId, delay = 0) {',
      'globalThis.exportRecoveryAttach = ensureSession;\n  function scheduleQueue(threadId, delay = 0) {');
  const modulePath = join(home, 'isolated-export-bridge.mjs');
  await writeFile(modulePath, `${source}
export async function fixtureConfigure(history, client, send, restoreActive) {
  initializedStore ||= loadStore(); await initializedStore;
  if (restoreActive) records.get(${JSON.stringify(threadId)}).thread.turns.find(turn => turn.id === ${JSON.stringify(nativeId)}).status = 'inProgress';
  sourceHistories.set(history.id, history);
  tmuxSync = { client, bindings: [client.binding], refresh: async () => {} };
  catalogPromise = Promise.resolve(null);
  clients.add({ send });
}
export function fixtureHistory(history) {
  sourceHistories.set(history.id, history);
  for (const session of sessions.values()) session.acceptHistory(history);
}
export function fixtureState() {
  const record = records.get(${JSON.stringify(threadId)});
  const execution = turnExecutions.get(record.thread.id);
  return { record: structuredClone(record), running: runningTurns.has(record.thread.id),
    execution: execution ? { turnId: execution.turnId, retiring: execution.retiring } : null,
    session: sessions.get(record.thread.id)?.state ?? null };
}
export async function fixtureStartHistory(history) {
  tmuxSync = null;
  const ready = startHistorySync(() => {});
  let scanned = false;
  historySync.scanner = { async scan() {
    if (scanned) return { changed: [], errors: [] };
    scanned = true;
    return { changed: [history], errors: [] };
  } };
  await ready;
}
export async function fixtureStartAutomatic() {
  tmuxSync = null;
  historySync ||= { stopped: false, timer: null, pending: null };
  await startTmuxSync(() => {}, globalThis.exportRecoveryAttach);
}
`);
  const fixture = await import(pathToFileURL(modulePath).href);
  const calls = [], messages = [];
  const client = { binding: structuredClone(binding), raw: frame(scenario === 'v3-restart' ? exportedInput : laterInput, true),
    async discover() { calls.push('discover'); return [this.binding]; },
    async verifiedBinding(candidate) { calls.push('verifiedBinding'); return this.isVerified(candidate) ? candidate : null; },
    isVerified(candidate) { return candidate?.agentPid === this.binding.agentPid
      && candidate?.agentStartTime === this.binding.agentStartTime && candidate?.paneId === this.binding.paneId; },
    async capture() { calls.push('capture'); return this.raw; } };
  for (const method of ['paste', 'cancel', 'sendKey', 'sendKeys', 'sendRaw', 'setModel']) client[method] = async () => {
    calls.push(method); throw new Error(`Recovery must not call ${method}`);
  };
  globalThis.exportRecoveryClient = client;
  const send = message => messages.push(structuredClone(message));
  await fixture.fixtureConfigure(scenario === 'v3-restart' ? all.stable : all.advanced, client, send,
    scenario === 'unbound-active');
  const bridge = fixture.createBridge({ send });
  const before = fixture.fixtureState();
  let resumed, recovered, savedRecovered, historyFirst;
  try {
    if (scenario === 'unbound-history-first') {
      await fixture.fixtureStartHistory(all.advanced);
      historyFirst = { state: fixture.fixtureState(), messages: structuredClone(messages),
        saved: JSON.parse(await readFile(recordPath, 'utf8')) };
      await fixture.fixtureStartAutomatic();
    } else if (scenario === 'unbound-active') await fixture.fixtureStartAutomatic();
    else {
      await bridge.receive({ id: 1, method: 'thread/resume', params: { threadId } });
      resumed = messages.find(message => message.id === 1);
      assert.equal(resumed.error, undefined, JSON.stringify(resumed));
    }
    for (let count = 0; count < 100 && !fixture.fixtureState().running; count++) await delay(10);
    recovered = fixture.fixtureState();
    savedRecovered = JSON.parse(await readFile(recordPath, 'utf8'));
    const unchangedFrame = client.raw;
    let retryResponses;
    if (scenario !== 'v3-restart') {
      for (const [id, input] of [[2, [{ type: 'text', text: rawInput }]], [3, [{ type: 'text', text: `${rawInput}changed` }]]]) {
        await bridge.receive({ id, method: 'turn/start', params: { threadId, clientUserMessageId: clientId, input } });
      }
      retryResponses = messages.filter(message => [2, 3].includes(message.id));
    }
    assert.equal(client.raw, unchangedFrame, 'Recovery and duplicate RPCs must not alter terminal bytes');
    client.raw = frame(scenario === 'v3-restart' ? exportedInput : laterInput, false, true);
    const privateFrame = client.raw;
    if (scenario === 'v3-restart') fixture.fixtureHistory(all.complete);
    else {
      const final = structuredClone(all.advanced);
      final.sourceComplete = true;
      final.completedTurnIds.push(final.turns.at(-1).id);
      final.turns.at(-1).items.push({ id: `${final.turns.at(-1).id}:final`, type: 'agentMessage', text: 'Later request finished' });
      fixture.fixtureHistory(final);
    }
    for (let count = 0; count < 120 && fixture.fixtureState().running; count++) await delay(25);
    const finished = fixture.fixtureState();
    return { scenario, initial, before, historyFirst, recovered, savedRecovered, finished,
      saved: JSON.parse(await readFile(recordPath, 'utf8')), messages, retryResponses, calls, resumed,
      draftUnchanged: client.raw === privateFrame, binding: client.binding, source: all.advanced };
  } finally { await bridge.close(); await fixture.shutdownBridge(); }
}

if (process.argv[2] === '--export-fixture') {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3])));
} else {
  async function run(t, scenario) {
    const home = await mkdtemp(join(tmpdir(), 'cursor-export-recovery-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(import.meta.url), '--export-fixture', scenario], {
        env: { ...process.env, CODEX_HOME: home, CURSOR_BRIDGE_AGENT: '/fixture/must-not-run',
          CURSOR_BRIDGE_REAL_CODEX: '/fixture/must-not-run' }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      });
    return JSON.parse(stdout);
  }
  function assertReadOnly(result) {
    assert.ok(result.calls.every(call => ['discover', 'verifiedBinding', 'capture'].includes(call)), result.calls);
    assert.equal(result.draftUnchanged, true);
    assert.deepEqual(result.binding, binding);
    assert.equal(result.saved.thread.model, model);
    assert.equal(result.messages.some(message => message.method === 'error'), false);
  }
  for (const scenario of ['unbound-active', 'unbound-restart', 'unbound-failed', 'unbound-history-first']) {
    test(`the production ${scenario === 'unbound-active' ? 'automatic tick' : `restart/resume (${scenario})`} retires an unbound multiline preview without resending and follows the real successor`, async t => {
      const result = await run(t, scenario);
      assertReadOnly(result);
      if (scenario === 'unbound-history-first') {
        const boundary = result.source.turns.at(-1);
        assert.equal(result.historyFirst.state.running, false);
        assert.equal(result.historyFirst.state.session, null);
        assert.equal(result.historyFirst.saved.thread.turns.find(turn => turn.id === nativeId).status, 'interrupted');
        assert.equal(result.historyFirst.saved.retiredUnboundTurns?.[nativeId], undefined,
          'The history scanner runs before retirement has established a receipt');
        assert.equal(result.historyFirst.saved.historySync.sourceTurns[boundary.id], undefined);
        assert.equal(result.historyFirst.saved.thread.turns.some(turn => turn.id === boundary.id), false,
          'The scanner must not import the provisional completed tail before live attachment');
        assert.equal(result.historyFirst.messages.some(message => message.method === 'turn/completed'
          && message.params.turn.id === boundary.id), false,
        'No false native completion may be published for the genuinely busy source');
        const completedSourceId = result.source.turns[1].id;
        const imported = result.historyFirst.saved.thread.turns.find(turn =>
          turn.id === result.historyFirst.saved.historySync.sourceTurns[completedSourceId]);
        assert.equal(imported.status, 'completed', 'The already completed prefix still synchronizes normally');
        assert.deepEqual(imported.items, result.source.turns[1].items);
      }
      const old = result.recovered.record.thread.turns.find(turn => turn.id === nativeId);
      assert.equal(old.status, 'interrupted');
      assert.deepEqual(old.items, result.initial.thread.turns.find(turn => turn.id === nativeId).items,
        'The original raw multiline input and partial preview remain unchanged');
      assert.equal(old.items[0].content[0].text, rawInput);
      assert.equal(result.recovered.record.tmuxObserverTurns?.[nativeId], undefined,
        'An unproven old submission never acquires a retroactive ownership proof');
      assert.equal(result.recovered.record.retiredUnboundTurns[nativeId].clientId, clientId);
      const completedSource = result.source.turns[1];
      const card = result.recovered.record.thread.turns.find(turn =>
        turn.id === result.recovered.record.historySync.sourceTurns[completedSource.id]);
      assert.notEqual(card.id, nativeId);
      assert.equal(card.status, 'completed');
      assert.deepEqual(card.items, completedSource.items);
      const successorId = result.recovered.record.historySync.sourceTurns[result.source.turns.at(-1).id];
      const current = result.recovered.record.thread.turns.find(turn => turn.id === successorId);
      assert.equal(current.status, 'inProgress');
      assert.equal(result.recovered.record.tmuxObserverTurns[current.id].version, 1);
      assert.equal(result.recovered.running, true);
      assert.equal(result.retryResponses.find(message => message.id === 2).result.turn.id, nativeId);
      assert.equal(result.retryResponses.find(message => message.id === 2).result.turn.status, 'interrupted');
      assert.equal(result.retryResponses.find(message => message.id === 3).error.code, -32602);
      assert.equal(result.finished.running, false);
      assert.equal(result.finished.record.thread.turns.find(turn => turn.id === successorId).status, 'completed');
      assert.equal(result.finished.record.thread.turns.find(turn => turn.id === successorId).items.at(-1).text,
        'Working on the later request\nLater request finished');
      assert.equal(result.messages.filter(message => message.method === 'turn/completed' && message.params.turn.id === nativeId).length, 1);
      assert.equal(result.messages.filter(message => message.method === 'turn/completed' && message.params.turn.id === successorId).length, 1);
      assert.equal(result.saved.thread.turns.some(turn => turn.status === 'inProgress'), false);
    });
  }
  test('a v3 native multiline receipt survives restart and archives exact ownership when its canonical source completes', async t => {
    const result = await run(t, 'v3-restart');
    assertReadOnly(result);
    assert.equal(result.recovered.running, true);
    assert.equal(result.recovered.record.tmuxObserverTurns[nativeId].version, 3);
    assert.equal(result.finished.running, false);
    const turn = result.saved.thread.turns.find(turn => turn.id === nativeId);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.items.filter(item => item.type === 'userMessage').length, 1);
    assert.equal(turn.items.find(item => item.type === 'userMessage').content[0].text, rawInput);
    assert.equal(turn.items.find(item => item.type === 'userMessage').clientId, clientId);
    assert.equal(turn.items.find(item => item.type === 'agentMessage').text, answer);
    assert.equal(result.saved.thread.turns.length, 2, 'The source is merged into its proven native counterpart');
    assert.equal(result.saved.tmuxObserverTurns?.[nativeId], undefined);
    assert.equal(result.saved.exportedSubmissionTurns[nativeId].version, 3);
    assert.equal(result.saved.exportedSubmissionTurns[nativeId].nativeUserTextSha256,
      nativeTurnTextSha256(result.initial.thread.turns.find(item => item.id === nativeId)));
    assert.equal(result.messages.filter(message => message.method === 'turn/completed' && message.params.turn.id === nativeId).length, 1);
  });
}
