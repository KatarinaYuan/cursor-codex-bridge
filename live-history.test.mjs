import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from './history.mjs';
import { reconcileHistory } from './sync.mjs';
import { findLiveSourceTurn, finalizeLivePreview, observerTurnProof, recoverableObserverTurn } from './live-history.mjs';

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

function observerFixture() {
  const source = history([['user', 'Continue please'], ['assistant', 'Canonical partial']]);
  source.cwd = '/home/testuser';
  const native = record(source);
  native.thread.cwd = source.cwd;
  const turn = native.thread.turns[0];
  const sourceTurnId = turn.id;
  turn.id = 'observer-native';
  turn.status = 'inProgress';
  turn.items[0].clientId = null;
  const binding = { sessionId: source.id, cwd: source.cwd, paneId: '%12', agentPid: 42, agentStartTime: '12345' };
  native.tmuxAffinity = { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime };
  native.historySync = { sourceTurns: { [sourceTurnId]: turn.id } };
  native.tmuxObserverTurns = { [turn.id]: { version: 1, sourceTurnId, sessionId: binding.sessionId,
    paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime } };
  return { native, source, binding, turn, proof: native.tmuxObserverTurns[turn.id] };
}

test('observer recovery retains exact ownership for both unfinished and completed source snapshots without mutation', () => {
  for (const complete of [false, true]) {
    const { native, source, binding, turn, proof } = observerFixture();
    source.sourceComplete = complete;
    source.completedTurnIds = complete ? [proof.sourceTurnId] : [];
    const before = structuredClone({ native, source, binding });
    assert.equal(observerTurnProof(native, turn.id), proof);
    const recovered = recoverableObserverTurn(native, binding, source);
    assert.equal(recovered.turn, turn);
    assert.equal(recovered.sourceTurn, source.turns[0]);
    assert.equal(recovered.proof, proof);
    assert.deepEqual({ native, source, binding }, before);
  }
});

test('observer proof refuses corrupt provenance, native client sends and competing source ownership', () => {
  const corruptions = [
    ({ native }) => { native.backend = 'acp'; },
    ({ native }) => { delete native.tmuxObserverTurns; },
    ({ proof }) => { proof.version = 2; },
    ({ proof }) => { proof.extra = true; },
    ({ proof }) => { delete proof.sourceTurnId; },
    ({ proof }) => { proof.sessionId = 'another-session'; },
    ({ proof }) => { proof.paneId = '%13'; },
    ({ proof }) => { proof.agentPid = 43; },
    ({ proof }) => { proof.agentStartTime = '54321'; },
    ({ proof, native }) => { proof.agentPid = native.tmuxAffinity.agentPid = 0; },
    ({ turn }) => { turn.status = 'completed'; },
    ({ turn }) => { turn.items[0].clientId = 'native-client-id'; },
    ({ turn }) => { turn.items[0].clientId = ''; },
    ({ turn }) => { turn.items.push(structuredClone(turn.items[0])); },
    ({ turn }) => { turn.items[0].content.push({ type: 'image', url: 'fixture' }); },
    ({ turn }) => { turn.items[0].content = [{ type: 'text', text: '   ' }]; },
    ({ turn }) => { turn.items.push({ type: 'dynamicToolCall', id: 'tool' }); },
    ({ native, proof }) => { delete native.historySync.sourceTurns[proof.sourceTurnId]; },
    ({ native, proof }) => { native.historySync.sourceTurns[proof.sourceTurnId] = 'other-native'; },
    ({ native, turn }) => { native.historySync.sourceTurns['another-source'] = turn.id; },
    ({ native, proof }) => { native.tmuxObserverTurns['other-native'] = { ...proof }; },
  ];
  for (const corrupt of corruptions) {
    const fixture = observerFixture();
    corrupt(fixture);
    const before = structuredClone(fixture.native);
    assert.equal(observerTurnProof(fixture.native, fixture.turn.id), null, String(corrupt));
    assert.equal(recoverableObserverTurn(fixture.native, fixture.binding, fixture.source), null, String(corrupt));
    assert.deepEqual(fixture.native, before);
  }
});

test('observer recovery requires unique active turn, original binding, cwd and exact canonical source identity', () => {
  const corruptions = [
    ({ binding }) => { binding.sessionId = 'another-session'; },
    ({ binding }) => { binding.paneId = '%99'; },
    ({ binding }) => { binding.agentPid++; },
    ({ binding }) => { binding.agentStartTime = '999'; },
    ({ binding }) => { binding.cwd += '/other'; },
    ({ source }) => { source.cwd += '/other'; },
    ({ source }) => { source.id = 'another-session'; },
    ({ source }) => { source.turns[0].id = 'same-prompt-different-source'; },
    ({ source }) => { source.turns[0].items[0].content[0].text = 'Different prompt'; },
    ({ source }) => { source.turns.push(structuredClone(source.turns[0])); },
    ({ native }) => { native.thread.turns.push({ id: 'unproven-active', status: 'inProgress', items: [] }); },
  ];
  for (const corrupt of corruptions) {
    const fixture = observerFixture();
    corrupt(fixture);
    const before = structuredClone(fixture);
    assert.equal(recoverableObserverTurn(fixture.native, fixture.binding, fixture.source), null, String(corrupt));
    assert.deepEqual(fixture, before);
  }
  const fixture = observerFixture();
  fixture.turn.items[0].clientId = undefined;
  fixture.source.turns[0].items[0].content[0].text = 'Con\ntinue please';
  assert.equal(recoverableObserverTurn(fixture.native, fixture.binding, fixture.source).turn, fixture.turn);
});

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
