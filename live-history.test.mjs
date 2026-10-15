import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from './history.mjs';
import { reconcileHistory } from './sync.mjs';
import { findLiveSourceTurn, finalizeLivePreview } from './live-history.mjs';

function history(rows, sourceComplete = false) {
  return { ...parseTranscript(rows.map(([role, text]) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })).join('\n'), {
    id: 'cursor-chat', cwd: '/home/testuser', updatedAt: 200,
  }), sourceComplete };
}

function record(source) {
  return {
    backend: 'legacy', cursorSessionId: source.id, titleOrigin: 'source',
    thread: { id: 'native-chat', name: source.title, updatedAt: 100, turns: structuredClone(source.turns) },
  };
}

function preview(record, turn, item, sourceOwned) {
  record.livePreviewIds = { [turn.id]: item.id };
  record.liveSourcePreviews = { [turn.id]: sourceOwned };
  item.phase = 'commentary';
  item.text = 'Rendered terminal output';
}

const answers = turn => turn.items.filter(item => item.type === 'agentMessage');

test('finds the unfinished source turn with an existing assistant partial using its exact native mapping', () => {
  const partial = history([['user', '你好 继续'], ['assistant', 'First partial']]);
  const native = record(partial);
  const turn = native.thread.turns[0];
  turn.id = 'mapped-native-turn';
  native.historySync = { sourceTurns: { [partial.turns[0].id]: turn.id } };
  assert.equal(findLiveSourceTurn(native, partial, '你\n好\u00a0继续'), turn);
  assert.equal(findLiveSourceTurn(native, partial, 'Different question'), null);
});

test('a source-owned user-only turn binds its preview to the first canonical assistant without duplicates', () => {
  const partial = history([['user', 'Continue']]);
  const native = record(partial);
  const turn = findLiveSourceTurn(native, partial, 'Continue');
  const item = { id: 'native-preview', type: 'agentMessage', text: '' };
  turn.items.push(item);
  preview(native, turn, item, true);
  const canonical = history([['user', 'Continue'], ['assistant', 'First answer'], ['assistant', 'Second answer']], true);
  finalizeLivePreview(native, turn, canonical.turns[0]);
  assert.equal(native.historySync.sourceItems[canonical.turns[0].items[1].id], item.id);
  const result = reconcileHistory(native, canonical);
  assert.deepEqual(answers(result.record.thread.turns[0]).map(item => [item.id, item.text, item.phase]), [
    ['native-preview', 'First answer', 'final_answer'],
    [canonical.turns[0].items[2].id, 'Second answer', 'final_answer'],
  ]);
  assert.equal(reconcileHistory(result.record, canonical).changed, false);
});

test('a reused turn with multiple partial assistants keeps each canonical item and finalizes only its matching preview', () => {
  const partial = history([['user', 'Continue'], ['assistant', 'First answer'], ['assistant', 'Second par']]);
  const native = record(partial);
  const turn = findLiveSourceTurn(native, partial, 'Continue');
  const last = answers(turn).at(-1);
  const originalLastId = last.id;
  preview(native, turn, last, true);
  const canonical = history([['user', 'Continue'], ['assistant', 'First answer'], ['assistant', 'Second partial completed'], ['assistant', 'Third answer']], true);
  finalizeLivePreview(native, turn, canonical.turns[0]);
  const result = reconcileHistory(native, canonical);
  assert.deepEqual(answers(result.record.thread.turns[0]).map(item => item.text), ['First answer', 'Second partial completed', 'Third answer']);
  assert.equal(answers(result.record.thread.turns[0])[1].id, originalLastId);
  assert.equal(answers(result.record.thread.turns[0])[1].phase, 'final_answer');
  assert.equal(reconcileHistory(result.record, canonical).changed, false);
});

test('a remapped source assistant finalizes its mapped preview instead of the first source assistant', () => {
  const partial = history([['user', 'Continue'], ['assistant', 'First answer'], ['assistant', 'Second partial']]);
  const native = record(partial);
  const turn = native.thread.turns[0];
  const last = answers(turn).at(-1);
  const sourceItemId = last.id;
  last.id = 'remapped-preview';
  native.historySync = { sourceItems: { [sourceItemId]: last.id } };
  preview(native, turn, last, true);
  const canonical = history([['user', 'Continue'], ['assistant', 'First answer'], ['assistant', 'Second completed']], true);
  finalizeLivePreview(native, turn, canonical.turns[0]);
  const result = reconcileHistory(native, canonical);
  assert.deepEqual(answers(result.record.thread.turns[0]).map(item => item.text), ['First answer', 'Second completed']);
  assert.equal(answers(result.record.thread.turns[0])[1].id, 'remapped-preview');
});

test('a fresh native UUID turn retains its aggregate preview ID when the transcript splits assistants', () => {
  const canonical = history([['user', 'Continue'], ['assistant', 'First answer'], ['assistant', 'Second answer']], true);
  const native = record(canonical);
  const turn = native.thread.turns[0];
  turn.id = 'fresh-native-uuid';
  turn.rootTurnId = turn.id;
  turn.items = [turn.items[0], { id: 'aggregate-preview', type: 'agentMessage', text: '' }];
  preview(native, turn, turn.items[1], false);
  finalizeLivePreview(native, turn, canonical.turns[0]);
  const result = reconcileHistory(native, canonical);
  assert.equal(result.record.thread.turns.length, 1);
  assert.deepEqual(answers(result.record.thread.turns[0]).map(item => [item.id, item.text, item.phase]), [
    ['aggregate-preview', 'First answer\nSecond answer', 'final_answer'],
  ]);
  assert.equal(reconcileHistory(result.record, canonical).changed, false);
});

test('complete or unconfirmed source snapshots never reuse a native turn', () => {
  const complete = history([['user', 'Continue'], ['assistant', 'Done']], true);
  const native = record(complete);
  assert.equal(findLiveSourceTurn(native, complete, 'Continue'), null);
  delete complete.sourceComplete;
  assert.equal(findLiveSourceTurn(native, complete, 'Continue'), null);
  complete.sourceComplete = false;
  assert.equal(findLiveSourceTurn(native, { ...complete, id: 'another-chat' }, 'Continue'), null);
});

test('a partial next row cannot make the previous explicitly completed turn reusable', () => {
  const partial = history([['user', 'Continue'], ['assistant', 'Old completed answer']]);
  partial.completedTurnIds = [partial.turns[0].id];
  const native = record(partial);
  assert.equal(findLiveSourceTurn(native, partial, 'Continue'), null);
});

test('repeated prompts only reuse the exact last source counterpart and never an older matching turn', () => {
  const partial = history([['user', 'Continue'], ['assistant', 'Old answer'], ['user', 'Continue'], ['assistant', 'New partial']]);
  const native = record(partial);
  assert.equal(findLiveSourceTurn(native, partial, 'Continue'), native.thread.turns[1]);
  native.thread.turns.pop();
  assert.equal(findLiveSourceTurn(native, partial, 'Continue'), null);
  native.historySync = { sourceTurns: { [partial.turns[1].id]: 'missing-native-turn' } };
  assert.equal(findLiveSourceTurn(native, partial, 'Continue'), null);
});

test('a source preview without a canonical assistant is cleared, and absent previews do nothing', () => {
  const canonical = history([['user', 'Continue']], true);
  const native = record(canonical);
  const turn = native.thread.turns[0];
  const before = structuredClone(native);
  finalizeLivePreview(native, turn, canonical.turns[0]);
  assert.deepEqual(native, before);
  const item = { id: 'preview', type: 'agentMessage', text: '' };
  turn.items.push(item);
  preview(native, turn, item, true);
  finalizeLivePreview(native, turn, canonical.turns[0]);
  const result = reconcileHistory(native, canonical);
  assert.equal(answers(result.record.thread.turns[0])[0].text, '');
  assert.equal(answers(result.record.thread.turns[0])[0].phase, 'final_answer');
});
