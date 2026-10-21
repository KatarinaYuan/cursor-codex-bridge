import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseTranscript } from './history.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const threadId = 'superseded-unbound-native-chat';
const nativeId = 'superseded-native-turn';
const clientId = 'superseded-native-client';
const model = 'composer-2.5[fast=true]';
const nativeInput = 'Summarize the proposed work.\nPreserve this exact original request.\n';
// The actual later source has different prose, not merely different spacing.
const advancedInput = 'Summarize the proposed work and include a detailed migration plan.\nAlso describe the newly requested compatibility checks.';
const latestInput = 'Continue with the independent follow-up';
const privateDraft = 'Private unsent terminal draft stays here';
const fullAnswer = 'The complete source reply.\n\nIt contains the later requested details.';
const latestAnswer = 'The independent follow-up finished.';
const binding = { paneId: '%9', panePid: 300, agentPid: 301, agentStartTime: '876543',
  sessionId: 'superseded-unbound-cursor-session', cwd: '/fixture/project' };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const reset = '\x1b[0m';
const dim = text => `\x1b[2m${text}${reset}`;
const row = (text, rgb = '242;242;242') => ` \x1b[48;2;${rgb}m ${text}${' '.repeat(80)}\x1b[49m`;
function frame(prompt, busy, draft = false) {
  const input = draft ? `→ ${privateDraft}\x1b[7m \x1b[27m`
    : `\x1b[2m→ \x1b[0;7m\x1b[48;2;242;242;242mA\x1b[0;2m\x1b[48;2;242;242;242mdd a follow-up${busy ? '    ctrl+c to stop' : ''}`;
  return `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${['', ...prompt.trim().split('\n'), ''].map(text => row(text, '227;227;227')).join('\n')}\n\n${row('')}\n${row(input)}\n${row('')}\n\n  ${dim('Composer 2.5 · 5.1%')}\n  ${dim(binding.cwd)}\n`;
}
const transcriptRow = (role, text) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
const ended = JSON.stringify({ type: 'turn_ended', status: 'success' });
const envelope = (text, minute) => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;
function histories() {
  const anchorRows = [transcriptRow('user', envelope('An earlier canonical request', '00')),
    transcriptRow('assistant', 'The exact earlier canonical answer.'), ended];
  const parse = rows => parseTranscript(rows.join('\n'), { id: binding.sessionId, cwd: binding.cwd });
  const anchor = parse(anchorRows);
  anchor.sourceComplete = true;
  const rows = [...anchorRows, transcriptRow('user', envelope(advancedInput, '02')),
    transcriptRow('assistant', fullAnswer), ended,
    transcriptRow('user', envelope(latestInput, '03'))];
  const advanced = parse(rows);
  advanced.sourceComplete = false;
  const complete = parse([...rows, transcriptRow('assistant', latestAnswer), ended]);
  complete.sourceComplete = true;
  return { anchor, advanced, complete };
}
function savedRecord(history) {
  const anchor = structuredClone(history.turns[0]);
  const user = { type: 'userMessage', id: 'superseded-native-user', clientId,
    content: [{ type: 'text', text: nativeInput }] };
  const preview = { type: 'agentMessage', id: 'superseded-native-preview',
    text: 'The old partial terminal preview remains intact.', phase: 'commentary',
    memoryCitation: null, delivery: null, questions: null };
  const native = { id: nativeId, rootTurnId: nativeId, itemsView: 'full', items: [user, preview],
    status: 'inProgress', error: null, startedAt: Date.parse('2026-10-19T11:01:05Z') / 1000,
    completedAt: null, durationMs: null };
  return { version: 1, backend: 'legacy', cursorSessionId: binding.sessionId,
    tmuxAffinity: { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime },
    historySync: { version: 1, sourceTurns: { [anchor.id]: anchor.id },
      sourceItems: Object.fromEntries(anchor.items.map(item => [item.id, item.id])) },
    livePreviewIds: { [nativeId]: preview.id },
    thread: { id: threadId, cwd: binding.cwd, model, name: 'Synthetic superseded request fixture',
      status: { type: 'active', activeFlags: [] }, turns: [anchor, native] } };
}

async function runFixture(scenario) {
  const all = histories();
  const initial = savedRecord(all.anchor);
  const home = process.env.CODEX_HOME;
  const store = join(home, 'cursor-bridge');
  const recordPath = join(store, `${threadId}.json`);
  await mkdir(store, { recursive: true });
  await writeFile(recordPath, JSON.stringify(initial));
  const tmuxModulePath = join(home, 'inert-tmux-client.mjs');
  await writeFile(tmuxModulePath, 'export class TmuxClient { constructor() { return globalThis.unboundRecoveryClient; } }\n');
  // Exercise production bridge state, locks, finishTurn, real TmuxSession
  // pending/close, scanner reconciliation, automatic attachment and RPCs.
  const source = (await readFile(join(directory, 'bridge.mjs'), 'utf8'))
    .replace(/(['"])\.\/([^'"]+\.mjs)\1/gu, (_match, _quote, name) => JSON.stringify(pathToFileURL(
      name === 'tmux.mjs' ? tmuxModulePath : join(directory, name)).href))
    .replace("process.platform !== 'linux'", 'false')
    .replace("process.platform === 'linux'", 'true')
    .replace('function scheduleQueue(threadId, delay = 0) {', `globalThis.unboundRecoveryAttach = ensureSession;
  globalThis.unboundRecoveryLaunch = (record, turn, session, pending) => launchTurn(record, turn, session, null, pending.promise);
  function scheduleQueue(threadId, delay = 0) {`);
  const modulePath = join(home, 'isolated-unbound-bridge.mjs');
  await writeFile(modulePath, `${source}
export async function fixtureConfigure(history, client, send) {
  initializedStore ||= loadStore(); await initializedStore;
  sourceHistories.set(history.id, history);
  tmuxSync = { client, bindings: [client.binding], refresh: async () => {} };
  catalogPromise = Promise.resolve(null);
  clients.add({ send });
}
export async function fixtureRestorePending(client, history, submitted, bindingPending) {
  const { TmuxSession } = await import(${JSON.stringify(pathToFileURL(join(directory, 'live.mjs')).href)});
  const record = records.get(${JSON.stringify(threadId)});
  const turn = record.thread.turns.find(turn => turn.id === ${JSON.stringify(nativeId)});
  turn.status = 'inProgress'; turn.error = null;
  const session = new TmuxSession({ client, binding: client.binding, model: record.thread.model, history,
    now: () => turn.startedAt * 1000 });
  await session.start();
  // Restore an already accepted native pending request, before it has acquired
  // any source receipt. This never calls prompt/paste or submits new model work.
  const pending = session.begin('native', turn.items[0].content[0].text);
  pending.submitted = submitted;
  if (bindingPending) pending.bindingPromise = new Promise(() => {});
  sessions.set(record.thread.id, session);
  runningTurns.add(record.thread.id);
  globalThis.unboundRecoveryLaunch(record, turn, session, pending);
}
export function fixtureAdmitPending() {
  const pending = sessions.get(${JSON.stringify(threadId)}).pending;
  pending.submitted = true; pending.bindingPromise = undefined;
}
export function fixtureHistory(history) {
  sourceHistories.set(history.id, history);
  for (const session of sessions.values()) session.acceptHistory(history);
}
export function fixtureState() {
  const record = records.get(${JSON.stringify(threadId)});
  const execution = turnExecutions.get(record.thread.id);
  const session = sessions.get(record.thread.id);
  return { record: structuredClone(record), running: runningTurns.has(record.thread.id),
    execution: execution ? { turnId: execution.turnId, retiring: execution.retiring } : null,
    pending: session?.pending ? { origin: session.pending.origin, submitted: session.pending.submitted,
      sourceTurnId: session.pending.sourceTurnId ?? null, bindingPending: Boolean(session.pending.bindingPromise) } : null,
    session: session?.state ?? null };
}
export async function fixtureStartHistory(history) {
  const ready = startHistorySync(() => {});
  let scanned = false;
  historySync.scanner = { async scan() {
    if (scanned) return { changed: [], errors: [] };
    scanned = true; return { changed: [history], errors: [] };
  } };
  await ready;
}
export async function fixtureStartAutomatic() {
  if (tmuxSync) { tmuxSync.stopped = true; clearTimeout(tmuxSync.timer); await tmuxSync.pending; }
  tmuxSync = null;
  historySync ||= { stopped: false, timer: null, pending: null };
  await startTmuxSync(() => {}, globalThis.unboundRecoveryAttach);
}
`);
  const fixture = await import(pathToFileURL(modulePath).href);
  const calls = [], messages = [], captureDepths = [];
  const client = { binding: structuredClone(binding), raw: frame(nativeInput, true),
    async discover() { calls.push('discover'); return [this.binding]; },
    async verifiedBinding(candidate) { calls.push('verifiedBinding'); return this.isVerified(candidate) ? candidate : null; },
    isVerified(candidate) { return candidate?.agentPid === this.binding.agentPid
      && candidate?.agentStartTime === this.binding.agentStartTime && candidate?.paneId === this.binding.paneId; },
    async capture(_paneId, options = {}) {
      calls.push('capture'); captureDepths.push(options.historyLines ?? 500);
      return options.historyLines === 10_000 ? this.deepRaw ?? this.raw : this.raw;
    } };
  for (const method of ['paste', 'cancel', 'sendKey', 'sendKeys', 'sendRaw', 'setModel']) client[method] = async () => {
    calls.push(method); throw new Error(`Recovery must not call ${method}`);
  };
  globalThis.unboundRecoveryClient = client;
  const send = message => messages.push(structuredClone(message));
  await fixture.fixtureConfigure(all.anchor, client, send);
  const bridge = fixture.createBridge({ send });
  try {
    if (scenario.startsWith('running-')) await fixture.fixtureRestorePending(client, all.anchor,
      scenario !== 'running-unsubmitted', scenario === 'running-binding-promise');
    const before = fixture.fixtureState();
    client.raw = frame(latestInput, true);
    if (scenario === 'running-shallow-history') {
      client.deepRaw = client.raw;
      const userBox = ['', ...latestInput.split('\n'), ''].map(text => row(text, '227;227;227')).join('\n');
      client.raw = client.raw.replace(userBox, '  Long output continues from the earlier scrollback.');
    }
    const busyFrame = client.raw;
    await fixture.fixtureStartHistory(all.advanced);
    const scanned = { state: fixture.fixtureState(), messages: structuredClone(messages),
      saved: JSON.parse(await readFile(recordPath, 'utf8')) };
    const beforeAutomaticDepth = captureDepths.length;
    await fixture.fixtureStartAutomatic();
    let blocked;
    if (['running-unsubmitted', 'running-binding-promise'].includes(scenario)) {
      blocked = { state: fixture.fixtureState(), messages: structuredClone(messages), terminalUnchanged: client.raw === busyFrame };
      fixture.fixtureAdmitPending();
      await fixture.fixtureStartAutomatic();
    }
    for (let count = 0; count < 100; count++) {
      const state = fixture.fixtureState();
      if (state.running && state.execution?.turnId !== nativeId) break;
      await delay(10);
    }
    const recovered = fixture.fixtureState();
    const recoveredMessages = structuredClone(messages);
    const automaticDepths = captureDepths.slice(beforeAutomaticDepth);
    const busyFrameUnchanged = client.raw === busyFrame;
    for (const [id, input] of [[2, [{ type: 'text', text: nativeInput }]], [3, [{ type: 'text', text: `${nativeInput}changed` }]]]) {
      await bridge.receive({ id, method: 'turn/start', params: { threadId, clientUserMessageId: clientId, input } });
    }
    const retryResponses = messages.filter(message => [2, 3].includes(message.id));
    assert.equal(client.raw, busyFrame, 'Retirement, attachment and duplicate RPCs must not change terminal bytes');
    client.raw = frame(latestInput, false, true);
    const draftFrame = client.raw;
    fixture.fixtureHistory(all.complete);
    for (let count = 0; count < 120 && fixture.fixtureState().running; count++) await delay(25);
    return { scenario, initial, before, scanned, blocked, recovered, recoveredMessages,
      finished: fixture.fixtureState(), saved: JSON.parse(await readFile(recordPath, 'utf8')),
      messages, retryResponses, calls, automaticDepths, busyFrameUnchanged, draftUnchanged: client.raw === draftFrame,
      binding: client.binding, source: all.advanced };
  } finally { await bridge.close(); await fixture.shutdownBridge(); }
}

if (process.argv[2] === '--unbound-fixture') {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3])));
} else {
  async function run(t, scenario) {
    const home = await mkdtemp(join(tmpdir(), 'cursor-unbound-recovery-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(import.meta.url), '--unbound-fixture', scenario], {
        env: { ...process.env, CODEX_HOME: home, CURSOR_BRIDGE_AGENT: '/fixture/must-not-run',
          CURSOR_BRIDGE_REAL_CODEX: '/fixture/must-not-run' }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      });
    return JSON.parse(stdout);
  }
  for (const scenario of ['running-pending', 'running-unsubmitted', 'running-binding-promise', 'running-shallow-history', 'history-first-restart']) {
    test(`an unbound request with different source prose recovers through the production ${scenario} lifecycle without resubmission`, async t => {
      const result = await run(t, scenario);
      assert.ok(result.calls.every(call => ['discover', 'verifiedBinding', 'capture'].includes(call)), result.calls);
      assert.equal(result.busyFrameUnchanged, true);
      assert.equal(result.draftUnchanged, true);
      assert.deepEqual(result.binding, binding);
      assert.equal(result.saved.thread.model, model);
      assert.equal(result.messages.some(message => message.method === 'error'), false);
      if (scenario.startsWith('running-')) {
        assert.equal(result.before.running, true);
        assert.equal(result.before.execution.turnId, nativeId);
        assert.deepEqual(result.before.pending, { origin: 'native', submitted: scenario !== 'running-unsubmitted',
          sourceTurnId: null, bindingPending: scenario === 'running-binding-promise' });
        assert.equal(result.scanned.state.running, true);
        assert.equal(result.scanned.state.record.historySync.sourceTurns[result.source.turns[1].id], undefined,
          'The real history tick is held by runningTurns until the obsolete pending observer retires');
      } else {
        const boundary = result.source.turns.at(-1);
        assert.equal(result.scanned.state.running, false);
        assert.equal(result.scanned.state.session, null);
        assert.equal(result.scanned.state.record.thread.turns.find(turn => turn.id === nativeId).status, 'interrupted');
        assert.deepEqual(result.scanned.saved, result.initial, 'Deferring the unbound snapshot preserves the original saved record until retirement');
        assert.equal(result.scanned.saved.retiredUnboundTurns?.[nativeId], undefined);
        assert.equal(result.scanned.saved.historySync.sourceTurns[boundary.id], undefined);
        assert.equal(result.scanned.saved.thread.turns.some(turn => turn.id === boundary.id), false);
        assert.equal(result.scanned.messages.some(message => message.method === 'turn/completed'
          && message.params.turn.id === boundary.id), false,
        'A user-only unfinished tail never emits a provisional completed event during initialization');
      }
      if (result.blocked) {
        assert.equal(result.blocked.state.running, true);
        assert.equal(result.blocked.state.execution.turnId, nativeId);
        assert.equal(result.blocked.state.session, 'ready', 'An unadmitted pending observer must never be closed');
        assert.deepEqual(result.blocked.state.record, result.scanned.state.record);
        assert.deepEqual(result.blocked.state.pending, result.before.pending);
        assert.equal(result.blocked.terminalUnchanged, true);
        assert.equal(result.blocked.messages.some(message => message.method === 'turn/completed'
          || message.method === 'thread/status/changed' && message.params.status.type === 'idle'), false);
      }
      if (scenario === 'running-shallow-history') {
        assert.deepEqual(result.automaticDepths, [500, 10_000, 500, 10_000, 500, 10_000],
          'Both retirement observations and the new real external observer must recover the exact prompt from bounded deep captures');
      }
      const old = result.recovered.record.thread.turns.find(turn => turn.id === nativeId);
      assert.equal(old.status, 'interrupted');
      assert.deepEqual(old.items, result.initial.thread.turns.find(turn => turn.id === nativeId).items);
      assert.equal(old.items[0].content[0].text, nativeInput);
      assert.notEqual(old.items[0].content[0].text.trim(), advancedInput);
      assert.equal(result.recovered.record.tmuxObserverTurns?.[nativeId], undefined,
        'Different source prose cannot be promoted into native submission ownership');
      const receipt = result.recovered.record.retiredUnboundTurns[nativeId];
      assert.equal(receipt.version, 2);
      assert.equal(receipt.reason, 'cursor-source-advanced');
      assert.equal(receipt.clientId, clientId);
      assert.equal(receipt.anchorTurnId, result.source.turns[0].id);
      assert.equal(receipt.firstAdvancedTurnId, result.source.turns[1].id);
      assert.equal(receipt.successorTurnId, result.source.turns.at(-1).id);
      assert.equal(Object.values(result.recovered.record.historySync.sourceTurns).includes(nativeId), false);
      assert.equal(result.recovered.record.exportedSubmissionTurns?.[nativeId], undefined);
      const canonical = result.source.turns[1];
      const canonicalCard = result.recovered.record.thread.turns.find(turn =>
        turn.id === result.recovered.record.historySync.sourceTurns[canonical.id]);
      assert.notEqual(canonicalCard.id, nativeId);
      assert.equal(canonicalCard.status, 'completed');
      assert.deepEqual(canonicalCard.items, canonical.items);
      const anchor = result.initial.thread.turns[0];
      assert.deepEqual(result.recovered.record.thread.turns.find(turn => turn.id === anchor.id), anchor);
      const boundary = result.source.turns.at(-1);
      const currentId = result.recovered.record.historySync.sourceTurns[boundary.id];
      const current = result.recovered.record.thread.turns.find(turn => turn.id === currentId);
      assert.equal(current.status, 'inProgress');
      assert.equal(current.items.filter(item => item.type === 'userMessage').length, 1);
      assert.equal(result.recovered.record.tmuxObserverTurns[currentId].version, 1);
      assert.equal(result.recovered.pending.origin, 'external');
      assert.equal(result.recovered.running, true);
      assert.equal(result.recoveredMessages.some(message => message.method === 'turn/completed'
        && message.params.turn.id === currentId), false);
      assert.equal(result.retryResponses.find(message => message.id === 2).error, undefined,
        JSON.stringify(result.retryResponses.find(message => message.id === 2)));
      assert.equal(result.retryResponses.find(message => message.id === 2).result.turn.id, nativeId);
      assert.equal(result.retryResponses.find(message => message.id === 2).result.turn.status, 'interrupted');
      assert.equal(result.retryResponses.find(message => message.id === 3).error.code, -32602);
      assert.equal(result.finished.running, false);
      assert.equal(result.finished.record.thread.status.type, 'idle');
      assert.ok(result.messages.some(message => message.method === 'thread/status/changed'
        && message.params.status.type === 'idle'));
      assert.equal(result.saved.thread.turns.some(turn => turn.status === 'inProgress'), false);
      const finished = result.saved.thread.turns.find(turn => turn.id === currentId);
      assert.equal(finished.status, 'completed');
      assert.equal(finished.items.find(item => item.type === 'agentMessage').text, latestAnswer);
      assert.equal(result.messages.filter(message => message.method === 'turn/completed'
        && message.params.turn.id === nativeId).length, 1);
      assert.equal(result.messages.filter(message => message.method === 'turn/completed'
        && message.params.turn.id === currentId).length, 1);
    });
  }
}
