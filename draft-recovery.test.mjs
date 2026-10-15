import test from 'node:test';
import assert from 'node:assert/strict';
import { retainUnsubmittedDraft, retryDraftFor, pinLiveSourceTurn, UNSUBMITTED_DRAFT_ERROR } from './draft-recovery.mjs';
import { reconcileHistory } from './sync.mjs';

const sessionId = '11111111-2222-4333-8444-555555555555';
const model = 'composer-2.5[fast=false]';
const input = text => [{ type: 'text', text }];
const user = (id, text) => ({ id, type: 'userMessage', content: input(text) });

function fixture() {
  const binding = { sessionId, paneId: '%9', agentPid: 123, agentStartTime: '456' };
  const evidence = { ...binding, model, sourceTurnIds: ['source-0'] };
  const failed = { id: 'failed-native', status: 'failed', error: { message: UNSUBMITTED_DRAFT_ERROR }, items: [user('failed-user', '试验\n')] };
  const source = { id: 'source-0', status: 'completed', items: [user('source-user-0', 'Earlier'), { id: 'source-answer-0', type: 'agentMessage', text: 'Earlier answer' }] };
  const history = { id: sessionId, sourceComplete: true, turns: [source] };
  const record = { backend: 'legacy', cursorSessionId: sessionId, tmuxAffinity: { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime },
    thread: { id: 'native-chat', model, turns: [structuredClone(source), failed] } };
  return { record, binding, evidence, failed, history };
}

test('a matching new send recovers only the durable proof for the last failed paste', () => {
  const f = fixture();
  assert.equal(retainUnsubmittedDraft(f.record, f.failed, f.evidence), true);
  assert.deepEqual(f.failed.unsubmittedDraft, { version: 1, turnId: f.failed.id, ...f.evidence });
  const persisted = JSON.parse(JSON.stringify(f.record));
  const result = retryDraftFor(persisted, f.binding, f.history, input('试验\n'));
  assert.deepEqual(result, { text: '试验\n', proof: f.failed.unsubmittedDraft });
  result.proof.sourceTurnIds.push('caller-mutation');
  assert.deepEqual(persisted.thread.turns.at(-1).unsubmittedDraft.sourceTurnIds, ['source-0']);
  f.evidence.sourceTurnIds.push('evidence-mutation');
  assert.deepEqual(f.failed.unsubmittedDraft.sourceTurnIds, ['source-0']);
});

test('an old error string alone cannot bootstrap draft ownership', () => {
  const f = fixture();
  assert.equal(retryDraftFor(f.record, f.binding, f.history, input('试验\n')), null);
  assert.equal(Object.hasOwn(f.failed, 'unsubmittedDraft'), false);
});

test('proof retention rejects malformed, unknown or mismatched evidence without mutation', () => {
  const cases = [
    evidence => { evidence.extra = true; },
    evidence => { delete evidence.model; },
    evidence => { evidence.sessionId = 'not-a-session'; },
    evidence => { evidence.paneId = '%9; Enter'; },
    evidence => { evidence.agentPid = '123'; },
    evidence => { evidence.agentPid = -1; },
    evidence => { evidence.agentStartTime = 456; },
    evidence => { evidence.agentStartTime = ''; },
    evidence => { evidence.model = ''; },
    evidence => { evidence.sourceTurnIds = ['source-0', 'source-0']; },
    evidence => { evidence.sourceTurnIds = [undefined]; },
    evidence => { evidence.sourceTurnIds = 'source-0'; },
    evidence => { evidence.sessionId = '22222222-3333-4444-8555-666666666666'; },
    evidence => { evidence.paneId = '%10'; },
    evidence => { evidence.agentPid++; },
    evidence => { evidence.agentStartTime = '457'; },
    evidence => { evidence.model = 'another-model'; },
  ];
  for (const mutate of cases) {
    const f = fixture(); mutate(f.evidence);
    const before = structuredClone(f.record);
    assert.equal(retainUnsubmittedDraft(f.record, f.failed, f.evidence), false);
    assert.deepEqual(f.record, before);
  }
  const f = fixture();
  for (const value of [undefined, null, [], 'proof']) assert.equal(retainUnsubmittedDraft(f.record, f.failed, value), false);
});

test('only the latest failed text-only pre-submission turn can retain proof', () => {
  const cases = [
    f => { f.record.backend = 'acp'; },
    f => { f.failed.status = 'completed'; },
    f => { f.failed.error.message = 'Different failure'; },
    f => { f.failed.items.push({ id: 'answer', type: 'agentMessage', text: '' }); },
    f => { f.failed.items.push({ id: 'tool', type: 'dynamicToolCall' }); },
    f => { f.failed.items.push(user('another-user', 'trial')); },
    f => { f.failed.items[0].content.push({ type: 'image', data: 'image' }); },
    f => { f.failed.items[0].content = input(' \n '); },
    f => { f.record.thread.turns.push({ id: 'later', status: 'failed', items: [] }); },
  ];
  for (const mutate of cases) {
    const f = fixture(); mutate(f);
    assert.equal(retainUnsubmittedDraft(f.record, f.failed, f.evidence), false);
    assert.equal(Object.hasOwn(f.failed, 'unsubmittedDraft'), false);
  }
  const f = fixture();
  assert.equal(retainUnsubmittedDraft(f.record, structuredClone(f.failed), f.evidence), false);
});

test('recovery refuses changed identities, source histories, models and proof schemas', () => {
  const cases = [
    f => { delete f.failed.unsubmittedDraft; },
    f => { f.failed.unsubmittedDraft.version = 2; },
    f => { f.failed.unsubmittedDraft.turnId = 'another-turn'; },
    f => { f.failed.unsubmittedDraft.extra = 'unknown'; },
    f => { f.binding.agentPid++; },
    f => { f.binding.agentStartTime = 'reused'; },
    f => { f.binding.paneId = '%10'; },
    f => { f.binding.sessionId = 'another-session'; },
    f => { f.record.tmuxAffinity.agentPid++; },
    f => { f.record.thread.model = 'another-model'; },
    f => { f.history.id = 'another-session'; },
    f => { f.history.sourceComplete = false; },
    f => { delete f.history.sourceComplete; },
    f => { f.history.turns.push({ id: 'new-source' }); },
    f => { f.history.turns[0].id = 'replacement-source'; },
    f => { f.record.thread.turns.push({ id: 'new-native', status: 'failed', items: [] }); },
    f => { f.failed.items.push({ id: 'answer', type: 'agentMessage', text: 'Reply' }); },
  ];
  for (const mutate of cases) {
    const f = fixture(); retainUnsubmittedDraft(f.record, f.failed, f.evidence); mutate(f);
    const before = structuredClone(f.record);
    assert.equal(retryDraftFor(f.record, f.binding, f.history, input('试验\n')), null);
    assert.deepEqual(f.record, before);
  }
});

test('recovery compares incoming text exactly and rejects nontext rather than normalizing it', () => {
  const f = fixture(); retainUnsubmittedDraft(f.record, f.failed, f.evidence);
  for (const blocks of [input('试验'), input('试验\n\n'), input('试 验\n'), input('试验\r\n'),
    [{ type: 'text', text: '试验\n' }, { type: 'image', data: 'x' }], [], undefined]) {
    assert.equal(retryDraftFor(f.record, f.binding, f.history, blocks), null);
  }
});

test('source turn order is part of the recovery proof, including an empty known source', () => {
  const f = fixture();
  f.evidence.sourceTurnIds.push('source-1');
  f.history.turns.push({ id: 'source-1' });
  retainUnsubmittedDraft(f.record, f.failed, f.evidence);
  assert.ok(retryDraftFor(f.record, f.binding, f.history, input('试验\n')));
  f.history.turns.reverse();
  assert.equal(retryDraftFor(f.record, f.binding, f.history, input('试验\n')), null);
  const empty = fixture(); empty.evidence.sourceTurnIds = []; empty.history.turns = [];
  assert.equal(retainUnsubmittedDraft(empty.record, empty.failed, empty.evidence), true);
  assert.ok(retryDraftFor(empty.record, empty.binding, empty.history, input('试验\n')));
});

test('a recovered source reply binds to the new turn, preserving the earlier failed attempt', () => {
  const f = fixture(); retainUnsubmittedDraft(f.record, f.failed, f.evidence);
  const retry = { id: 'retry-native', status: 'inProgress', items: [user('retry-user', '试验\n')] };
  f.record.thread.turns.push(retry);
  const source = { id: 'source-1', status: 'completed', items: [user('source-user-1', '试验'), { id: 'source-answer-1', type: 'agentMessage', text: 'Reply from retry' }] };
  const failedBefore = structuredClone(f.failed);
  assert.equal(pinLiveSourceTurn(f.record, retry, source), true);
  assert.equal(f.record.historySync.sourceTurns[source.id], retry.id);
  assert.equal(f.record.historySync.sourceItems['source-user-1'], 'retry-user');
  const merged = reconcileHistory(f.record, { ...f.history, turns: [...f.history.turns, source] });
  assert.equal(merged.record.thread.turns.length, 3);
  assert.deepEqual(merged.record.thread.turns.find(turn => turn.id === f.failed.id), failedBefore);
  assert.equal(merged.record.thread.turns.find(turn => turn.id === retry.id).items.at(-1).text, 'Reply from retry');
  assert.equal(merged.record.historySync.sourceTurns[source.id], retry.id);
  assert.equal(reconcileHistory(merged.record, { ...f.history, turns: [...f.history.turns, source] }).changed, false);
});

test('source pinning rejects unrelated input and conflicting mappings without mutation', () => {
  const cases = [
    (f, retry) => { retry.items[0].content = input('different'); },
    (f, retry) => { retry.items.push(user('second-user', '试验')); },
    (f, retry) => { retry.items[0].content.push({ type: 'image', data: 'x' }); },
    f => { f.record.backend = 'acp'; },
    f => { f.record.historySync = { sourceTurns: { 'source-1': 'failed-native' } }; },
    f => { f.record.historySync = { sourceItems: { 'source-user-1': 'failed-user' } }; },
  ];
  for (const mutate of cases) {
    const f = fixture();
    const retry = { id: 'retry-native', status: 'inProgress', items: [user('retry-user', '试验\n')] };
    f.record.thread.turns.push(retry);
    const source = { id: 'source-1', status: 'completed', items: [user('source-user-1', '试验')] };
    mutate(f, retry);
    const before = structuredClone(f.record);
    assert.equal(pinLiveSourceTurn(f.record, retry, source), false);
    assert.deepEqual(f.record, before);
  }
});
