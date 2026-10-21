import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTranscript } from './history.mjs';
import { reconcileHistory } from './sync.mjs';
import { DETACHED_OBSERVER_ERROR, EXPORT_RETIRED_ERROR, unboundExportCandidate, planUnboundExportRetirement } from './export-recovery.mjs';

function fixture({ status = 'inProgress', complete = false } = {}) {
  const input = 'Review these changes.\n\n\n\nKeep  internal spaces.\nOne more line.\n';
  const env = (text, minute) => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;
  const row = (role, text) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } });
  const ended = JSON.stringify({ type: 'turn_ended', status: 'success' });
  const history = parseTranscript([
    row('user', env('Earlier request', '00')), row('assistant', 'Earlier answer'), ended,
    row('user', env(input.replace(/\n{3,}/gu, '\n\n').trim(), '01')), row('assistant', 'Full completed answer\n\nLast line.'), ended,
    row('user', env('Later independent request', '02')), row('assistant', 'Later partial reply'), ...(complete ? [ended] : []),
  ].join('\n'), { id: 'export-session', cwd: '/fixture/project', updatedAt: Date.UTC(2026, 9, 19, 11, 3) / 1000 });
  history.sourceComplete = complete;
  const preview = { id: 'unbound-native', rootTurnId: 'unbound-native', status,
    startedAt: Date.UTC(2026, 9, 19, 11, 0, 45) / 1000, completedAt: null, durationMs: null,
    error: status === 'failed' ? { message: DETACHED_OBSERVER_ERROR, codexErrorInfo: null, additionalDetails: null } : null,
    items: [{ type: 'userMessage', id: 'raw-user', clientId: 'original-client', content: [{ type: 'text', text: input }] },
      { type: 'agentMessage', id: 'raw-preview', text: 'Rendered partial\n   retained exactly', phase: 'commentary' }] };
  const earlier = structuredClone(history.turns[0]);
  const binding = { sessionId: history.id, cwd: history.cwd, paneId: '%8', agentPid: 201, agentStartTime: '765432' };
  const record = { backend: 'legacy', cursorSessionId: history.id,
    tmuxAffinity: { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime },
    historySync: { sourceTurns: { [earlier.id]: earlier.id }, sourceItems: {} },
    livePreviewIds: { [preview.id]: 'raw-preview' },
    thread: { id: 'native-chat', cwd: history.cwd, model: 'composer-2.5[fast=true]', name: 'My private title', turns: [earlier, preview] } };
  const screen = { busy: !complete, ready: false, inputAvailable: complete, reason: complete ? 'input-has-draft' : 'agent-busy',
    inputText: complete ? 'A private CLI draft' : null, stopKey: complete ? null : 'C-c', userMessages: ['Later independent request'] };
  return { record, history, binding, screen, preview };
}

for (const status of ['inProgress', 'interrupted', 'failed']) test(`unbound ${status} export display retires without claiming its source or resending`, () => {
  const f = fixture({ status });
  const before = structuredClone(f);
  assert.equal(unboundExportCandidate(f.record, f.history).turn, f.preview);
  const plan = planUnboundExportRetirement(f.record, f);
  assert.ok(plan);
  assert.deepEqual(f, before);
  const retired = plan.record.thread.turns.find(turn => turn.id === f.preview.id);
  assert.equal(retired.status, 'interrupted');
  assert.equal(retired.error.message, EXPORT_RETIRED_ERROR);
  assert.deepEqual(retired.items, f.preview.items);
  assert.equal(plan.record.tmuxObserverTurns, undefined);
  assert.equal(plan.record.exportedSubmissionTurns, undefined);
  assert.equal(Object.values(plan.record.historySync.sourceTurns).includes(retired.id), false);
  assert.equal(Object.values(plan.record.historySync.sourceItems).some(id => retired.items.some(item => item.id === id)), false);
  assert.deepEqual(plan.record.thread.turns.map(turn => turn.id), [f.history.turns[0].id, retired.id, f.history.turns[1].id]);
  const source = plan.record.thread.turns.at(-1);
  assert.equal(source.status, 'completed');
  assert.deepEqual(source.items, f.history.turns[1].items);
  const receipt = plan.record.retiredUnboundTurns[retired.id];
  assert.equal(receipt.reason, 'cursor-export-newlines');
  assert.equal(receipt.sourceCandidateId, f.history.turns[1].id);
  assert.equal(receipt.successorTurnId, f.history.turns[2].id);
  assert.equal(receipt.clientId, 'original-client');
  const saved = JSON.parse(JSON.stringify(plan.record));
  assert.equal(planUnboundExportRetirement(saved, f), null);
  const synced = reconcileHistory(saved, { ...f.history, turns: f.history.turns.slice(0, -1) });
  assert.equal(synced.changed, false);
});

test('completed successor and a real CLI draft permit display-only retirement', () => {
  const f = fixture({ complete: true });
  const before = structuredClone(f.screen);
  const plan = planUnboundExportRetirement(f.record, f);
  assert.ok(plan);
  assert.equal(plan.record.thread.turns.at(-1).id, f.history.turns.at(-1).id);
  assert.equal(plan.record.thread.turns.at(-1).status, 'completed');
  assert.deepEqual(f.screen, before);
});

test('already imported canonical cards retain IDs and move no original content', () => {
  const f = fixture();
  f.record = reconcileHistory(f.record, { ...f.history, turns: f.history.turns.slice(0, -1) }).record;
  const existing = structuredClone(f.record.thread.turns.filter(turn => turn.id !== f.preview.id));
  const plan = planUnboundExportRetirement(f.record, f);
  assert.ok(plan);
  assert.deepEqual(plan.record.thread.turns.filter(turn => turn.id !== f.preview.id), existing);
  assert.equal(plan.record.thread.turns[1].id, f.preview.id);
  assert.deepEqual(plan.turnsChanged.map(change => change.after.id), [f.preview.id]);
});

test('unbound retirement refuses uncertain source, original input, status, ownership and process', () => {
  const mutations = [
    f => { f.record.backend = 'acp'; },
    f => { f.history.id = 'different'; },
    f => { f.history.cwd = '/different'; },
    f => { f.history.sourceIdentityScheme = 'unknown'; },
    f => { delete f.history.sourceComplete; },
    f => { delete f.history.completedTurnIds; },
    f => { f.history.completedTurnIds.splice(1, 1); },
    f => { f.history.turns[1].status = 'inProgress'; },
    f => { f.history.turns[1].sourceIdentity.strength = 'ambiguous'; },
    f => { f.history.turns[1].sourceTimestampMinute -= 180_000; },
    f => { f.history.turns[1].sourceTimestampMinute += 240_000; },
    f => { f.history.turns[2].sourceTimestampMinute = f.history.turns[1].sourceTimestampMinute; },
    f => { f.history.turns.push(structuredClone(f.history.turns[1])); },
    f => { f.history.turns[1].items[0].content[0].text = 'Review these changes.\n\nKeep internal spaces.\nOne more line.'; },
    f => { f.history.turns[1].items[0].content[0].text = 'Review these changes. Keep  internal spaces. One more line.'; },
    f => { f.preview.items[0].content[0].text = f.preview.items[0].content[0].text.replace(/\n{3,}/gu, '\n\n'); },
    f => { f.preview.items[0].content.push({ type: 'image', url: '/fixture/image' }); },
    f => { f.preview.items[0].clientId = null; },
    f => { f.preview.items[1].id = f.preview.items[0].id; },
    f => { f.preview.status = 'completed'; },
    f => { f.preview.status = 'failed'; f.preview.error = { message: 'Other failure' }; },
    f => { f.preview.status = 'interrupted'; f.preview.error = { message: 'User cancelled' }; },
    f => { f.preview.unsubmittedDraft = { text: 'Do not touch' }; },
    f => { f.record.tmuxObserverTurns = { [f.preview.id]: {} }; },
    f => { f.record.historySync.sourceTurns[f.history.turns[1].id] = f.preview.id; },
    f => { f.record.historySync.sourceItems[f.history.turns[1].items[0].id] = f.preview.items[0].id; },
    f => { f.record.queuedSubmissions = [{}]; },
    f => { f.record.thread.turns.push({ id: 'other-active', status: 'inProgress', items: [] }); },
    f => { f.record.thread.turns.push(structuredClone(f.preview)); },
    f => { delete f.record.tmuxAffinity; },
    f => { f.binding.agentPid++; },
    f => { f.binding.agentStartTime = '123'; },
    f => { f.binding.paneId = '%9'; },
    f => { f.binding.cwd = '/different'; },
    f => { f.binding.sessionId = 'different'; },
    f => { f.screen.userMessages = ['Other request']; },
    f => { f.screen.busy = false; },
    f => { f.screen.stopKey = null; },
    f => { f.screen.reason = 'unknown'; },
    f => { f.screen.inputAvailable = true; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    const before = structuredClone(f);
    assert.equal(planUnboundExportRetirement(f.record, f), null, mutate.toString());
    assert.deepEqual(f, before);
  }
});
