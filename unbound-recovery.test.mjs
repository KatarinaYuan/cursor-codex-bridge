import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from './history.mjs';
import { reconcileHistory } from './sync.mjs';
import { nativeTurnTextSha256 } from './live-history.mjs';
import { DETACHED_OBSERVER_ERROR } from './export-recovery.mjs';
import { SUPERSEDED_UNBOUND_ERROR, supersededUnboundCandidate, planSupersededUnboundRetirement } from './unbound-recovery.mjs';

const stamp = (text, minute) => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;
const base = Date.UTC(2026, 9, 19, 11, 0) / 1000;

function fixture({ status = 'inProgress', mode = 'busy' } = {}) {
  const row = (role, text) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
  const end = JSON.stringify({ type: 'turn_ended', status: 'success' });
  const history = parseTranscript([
    row('user', stamp('Earlier canonical request', '00')), row('assistant', 'Earlier complete reply'), end,
    row('user', stamp('A genuinely different source request.\n\nPreserve its text.', '01')),
    row('assistant', 'The independent source completed this entire response.'), end,
    row('user', stamp('Latest independent request', '02')), row('assistant', 'Latest partial response'),
    ...(mode === 'idle' ? [end] : []),
  ].join('\n'), { id: 'superseded-session', cwd: '/fixture/project', updatedAt: base + 180 });
  history.sourceComplete = mode === 'idle';
  const anchor = structuredClone(history.turns[0]);
  anchor.startedAt = base; anchor.completedAt = base + 30;
  const preview = { id: 'unbound-display', rootTurnId: 'unbound-display', status,
    startedAt: base + 45, completedAt: null, durationMs: null,
    error: status === 'failed' ? { message: DETACHED_OBSERVER_ERROR } : null,
    items: [{ id: 'native-input', type: 'userMessage', clientId: 'native-client',
      content: [{ type: 'text', text: 'Native input is not the source request.\n\n\n\nKeep  all bytes.\n' }] },
    { id: 'native-preview', type: 'agentMessage', text: 'Wrapped private preview\n  retained exactly', phase: 'commentary' }] };
  const binding = { sessionId: history.id, cwd: history.cwd, paneId: '%12', agentPid: 42, agentStartTime: '12345' };
  const record = { backend: 'legacy', cursorSessionId: history.id,
    tmuxAffinity: { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime },
    thread: { id: 'native-chat', cwd: history.cwd, model: 'original-model', turns: [anchor, preview] },
    historySync: { sourceTurns: { [anchor.id]: anchor.id },
      sourceItems: Object.fromEntries(anchor.items.map(item => [item.id, item.id])) },
    livePreviewIds: { [preview.id]: 'native-preview' }, liveSourcePreviews: { [preview.id]: false },
    privateDraft: { text: 'Unrelated private data stays untouched' } };
  const screen = { userMessages: ['Latest independent request'], ready: false, inputAvailable: mode === 'idle',
    busy: mode === 'busy', waitingForQuestion: mode === 'question', stopKey: mode === 'busy' ? 'C-c' : null,
    reason: mode === 'busy' ? 'agent-busy' : mode === 'question' ? 'question-awaiting-answer' : 'input-has-draft',
    inputText: mode === 'idle' ? 'Keep the local draft untouched' : null };
  return { record, history, binding, screen, preview };
}

for (const status of ['inProgress', 'interrupted', 'failed']) for (const mode of ['busy', 'question', 'idle']) {
  test(`superseded ${status} display retires independently on a recognized ${mode} successor`, () => {
    const f = fixture({ status, mode });
    const before = structuredClone(f);
    const candidate = supersededUnboundCandidate(f.record, f.history);
    assert.equal(candidate.turn, f.preview);
    assert.equal(candidate.anchor, f.history.turns[0]);
    assert.equal(candidate.firstAdvanced, f.history.turns[1]);
    const result = planSupersededUnboundRetirement(f.record, f);
    assert.ok(result);
    assert.deepEqual(f, before);
    const retired = result.record.thread.turns.find(turn => turn.id === f.preview.id);
    assert.equal(retired.status, 'interrupted');
    assert.equal(retired.error.message, SUPERSEDED_UNBOUND_ERROR);
    assert.deepEqual(retired.items, f.preview.items);
    assert.deepEqual(result.record.privateDraft, f.record.privateDraft);
    assert.equal(result.record.thread.model, f.record.thread.model);
    assert.equal(result.record.tmuxObserverTurns, undefined);
    assert.equal(result.record.exportedSubmissionTurns, undefined);
    assert.equal(Object.values(result.record.historySync.sourceTurns).includes(retired.id), false);
    assert.equal(Object.values(result.record.historySync.sourceItems).some(id => retired.items.some(item => item.id === id)), false);
    const receipt = result.record.retiredUnboundTurns[retired.id];
    assert.deepEqual(receipt, { version: 2, reason: 'cursor-source-advanced', clientId: 'native-client',
      sessionId: f.history.id, model: 'original-model', nativeUserTextSha256: nativeTurnTextSha256(f.preview),
      anchorTurnId: f.history.turns[0].id, firstAdvancedTurnId: f.history.turns[1].id,
      successorTurnId: f.history.turns[2].id, paneId: '%12', agentPid: 42, agentStartTime: '12345' });
    assert.equal(Object.hasOwn(receipt, 'sourceTurnId'), false, 'display evidence is not submission ownership');
    assert.deepEqual(result.record.thread.turns.map(turn => turn.id), [f.history.turns[0].id, retired.id,
      f.history.turns[1].id, ...(mode === 'idle' ? [f.history.turns[2].id] : [])]);
    assert.deepEqual(result.record.thread.turns.find(turn => turn.id === f.history.turns[1].id).items, f.history.turns[1].items);
    const persisted = JSON.parse(JSON.stringify(result.record));
    assert.equal(planSupersededUnboundRetirement(persisted, f), null);
    assert.equal(reconcileHistory(persisted, { ...f.history, turns: candidate.prefix }).changed, false);
  });
}

test('source chronology never asserts the native input is the same submission', () => {
  const f = fixture();
  f.preview.items[0].content[0].text = '<user_query>Completely unrelated literal input\n  with spacing</user_query>';
  const result = planSupersededUnboundRetirement(f.record, f);
  assert.ok(result);
  assert.deepEqual(result.record.thread.turns.find(turn => turn.id === f.preview.id).items, f.preview.items);
  assert.equal(result.record.historySync.sourceTurns[f.history.turns[1].id], f.history.turns[1].id);
});

test('a same-minute anchor requires its actual completion time to precede the native input', () => {
  for (const completedAt of [null, undefined, 0, base + 0.5, String(base), base + 46]) {
    const f = fixture();
    f.record.thread.turns[0].completedAt = completedAt;
    const before = structuredClone(f);
    assert.equal(supersededUnboundCandidate(f.record, f.history), null, String(completedAt));
    assert.equal(planSupersededUnboundRetirement(f.record, f), null, String(completedAt));
    assert.deepEqual(f, before);
  }
  const sameMinute = fixture();
  sameMinute.record.thread.turns[0].completedAt = sameMinute.preview.startedAt;
  assert.ok(planSupersededUnboundRetirement(sameMinute.record, sameMinute));

  for (const completedAt of [null, undefined]) {
    const earlierMinute = fixture();
    earlierMinute.preview.startedAt = base + 60;
    earlierMinute.record.thread.turns[0].completedAt = completedAt;
    assert.ok(planSupersededUnboundRetirement(earlierMinute.record, earlierMinute));
  }
});

test('supersession refuses uncertain anchor, source chronology, native ownership or source completion', () => {
  const mutations = [
    f => { f.record.backend = 'acp'; },
    f => { delete f.record.tmuxAffinity; },
    f => { f.record.tmuxAffinity.paneId = 'invalid'; },
    f => { f.record.tmuxAffinity.agentPid = 0; },
    f => { f.record.tmuxAffinity.agentPid = '42'; },
    f => { f.record.tmuxAffinity.agentStartTime = 'invalid'; },
    f => { f.record.tmuxAffinity.agentStartTime = 12345; },
    f => { f.history.id = 'other-session'; },
    f => { f.history.cwd = '/other'; },
    f => { f.history.sourceIdentityScheme = 'unknown'; },
    f => { delete f.history.sourceComplete; },
    f => { delete f.history.completedTurnIds; },
    f => { f.history.completedTurnIds.push(f.history.completedTurnIds[0]); },
    f => { f.history.completedTurnIds.splice(1, 1); },
    f => { f.history.turns[1].status = 'inProgress'; },
    f => { f.history.turns[1].sourceIdentity.strength = 'ambiguous'; },
    f => { f.history.turns[1].sourceTimestampMinute = base * 1000 - 60_000; },
    f => { f.history.turns[1].sourceTimestampMinute = base * 1000 + 180_000; },
    f => { f.history.turns[2].sourceTimestampMinute = f.history.turns[1].sourceTimestampMinute; },
    f => { f.history.turns.pop(); },
    f => { f.history.turns.push(structuredClone(f.history.turns[1])); },
    f => { f.history.turns[2].sourceIdentity.strength = 'ambiguous'; },
    f => { f.history.turns[2].sourceTimestampMinute++; },
    f => { f.history.turns[0].sourceIdentity.sha256 = '0'.repeat(64); },
    f => { f.record.thread.turns[0].items[1].text += ' changed'; },
    f => { f.record.thread.turns[0].items[1].phase = 'commentary'; },
    f => { f.record.thread.turns[0].items[0].clientId = 'other'; },
    f => { f.record.thread.turns[0].completedAt = f.preview.startedAt + 1; },
    f => { f.record.thread.turns[0].status = 'interrupted'; },
    f => { delete f.record.historySync.sourceItems[f.history.turns[0].items[1].id]; },
    f => { f.record.historySync.sourceItems.alias = f.history.turns[0].items[1].id; },
    f => { f.record.historySync.sourceTurns.alias = f.history.turns[0].id; },
    f => { f.record.historySync.sourceTurns[f.history.turns[1].id] = f.preview.id; },
    f => { f.record.historySync.sourceItems[f.history.turns[1].items[1].id] = f.preview.items[1].id; },
    f => { f.record.tmuxObserverTurns = { [f.preview.id]: { invalid: true } }; },
    f => { f.record.exportedSubmissionTurns = { [f.preview.id]: { invalid: true } }; },
    f => { f.preview.unsubmittedDraft = { text: 'Draft' }; },
    f => { f.preview.status = 'failed'; f.preview.error = { message: 'Other error' }; },
    f => { f.preview.status = 'interrupted'; f.preview.error = { message: 'Explicit user cancellation' }; },
    f => { f.preview.status = 'completed'; },
    f => { delete f.record.livePreviewIds[f.preview.id]; },
    f => { f.record.livePreviewIds[f.preview.id] = f.history.turns[0].items[1].id; },
    f => { f.record.liveSourcePreviews[f.preview.id] = true; },
    f => { f.preview.items[1].text = null; },
    f => { f.preview.items[0].clientId = null; },
    f => { f.preview.items[0].content.push({ type: 'image', url: '/fixture/image' }); },
    f => { f.preview.items.push(structuredClone(f.preview.items[0])); },
    f => { f.preview.items[1].id = f.preview.items[0].id; },
    f => { f.record.thread.turns[0].items[0].clientId = f.preview.items[0].clientId; },
    f => { f.record.queuedSubmissions = [{}]; },
    f => { f.record.queue = null; },
    f => { f.record.thread.turns.push({ id: 'another-active', status: 'inProgress', items: [] }); },
    f => { f.record.thread.turns.push(structuredClone(f.history.turns[1])); },
    f => { f.record.retiredUnboundTurns = { [f.preview.id]: { version: 2 } }; },
    f => { f.record.retiredObserverTurns = { [f.preview.id]: { version: 3 } }; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    const before = structuredClone(f);
    assert.equal(supersededUnboundCandidate(f.record, f.history), null, mutate.toString());
    assert.equal(planSupersededUnboundRetirement(f.record, f), null, mutate.toString());
    assert.deepEqual(f, before);
  }
});

test('fresh original-process and recognized latest capture are required for display-only retirement', () => {
  const mutations = [
    f => { delete f.record.tmuxAffinity; },
    f => { f.binding.sessionId = 'other'; },
    f => { f.binding.cwd = '/other'; },
    f => { f.binding.paneId = '%13'; },
    f => { f.binding.agentPid++; },
    f => { f.binding.agentStartTime = '999'; },
    f => { f.screen.userMessages = []; },
    f => { f.screen.userMessages.push('A newer uncaptured source'); },
    f => { f.screen.reason = 'unrecognized-footer-or-overlay'; },
    f => { f.screen.inputAvailable = true; },
    f => { f.screen.ready = true; },
    f => { f.screen.stopKey = 'Enter'; },
    f => { f.screen.busy = false; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    const before = structuredClone(f);
    assert.equal(planSupersededUnboundRetirement(f.record, f), null, mutate.toString());
    assert.deepEqual(f, before);
  }
  const wrapped = fixture(); wrapped.screen.userMessages = ['Latest independent\nrequest'];
  assert.ok(planSupersededUnboundRetirement(wrapped.record, wrapped));
  const unknownQuestion = fixture({ mode: 'question' }); unknownQuestion.screen.reason = 'unrecognized-footer-or-overlay';
  assert.equal(planSupersededUnboundRetirement(unknownQuestion.record, unknownQuestion), null);
});
