import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from './history.mjs';
import { reconcileHistory } from './sync.mjs';
import { findLiveSourceTurn, finalizeLivePreview, hasSubmittedTurnClaim, nativeTurnTextSha256, observerTurnProof,
  recoverableObserverTurn, submittedTurnTextSha256 } from './live-history.mjs';
import { retainSubmittedTurn } from './live-history.mjs';
import { pinLiveSourceTurn } from './draft-recovery.mjs';

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

function submittedFixture() {
  const fixture = observerFixture();
  const { native, source, turn } = fixture;
  native.thread.model = 'composer-2.5[fast=true]';
  turn.items[0].clientId = 'native-client-message';
  turn.items[0].id = 'native-user-item';
  // Keep the raw native input intact even when Cursor drops an outer newline.
  turn.items[0].content[0].text = 'Continue please\n';
  native.historySync.sourceItems = { [source.turns[0].items[0].id]: turn.items[0].id };
  const proof = { ...fixture.proof, version: 2, origin: 'native', clientId: turn.items[0].clientId,
    model: native.thread.model, userTextSha256: submittedTurnTextSha256(turn), nativeUserTextSha256: nativeTurnTextSha256(turn) };
  native.tmuxObserverTurns[turn.id] = proof;
  return { ...fixture, proof };
}

test('explicit submitted proof recovers the same native client, model, user bytes and exact source without mutation', () => {
  for (const complete of [false, true]) {
    const fixture = submittedFixture();
    fixture.source.sourceComplete = complete;
    fixture.source.completedTurnIds = complete ? [fixture.proof.sourceTurnId] : [];
    const before = structuredClone(fixture);
    assert.equal(observerTurnProof(fixture.native, fixture.turn.id), fixture.proof);
    const recovered = recoverableObserverTurn(fixture.native, fixture.binding, fixture.source);
    assert.equal(recovered.turn, fixture.turn);
    assert.equal(recovered.sourceTurn, fixture.source.turns[0]);
    assert.deepEqual(fixture, before);
  }
});

test('only a unique stable source can create a fresh submitted proof after a real live binding', () => {
  const { native, source, binding, turn } = submittedFixture();
  const stamped = history([['user', '<timestamp>Monday, Oct 19, 2026, 11:01 AM (UTC)</timestamp>\n<user_query>Continue please</user_query>'], ['assistant', 'Canonical partial']]);
  delete native.tmuxObserverTurns; native.historySync = { sourceTurns: {}, sourceItems: {} };
  assert.equal(pinLiveSourceTurn(native, turn, stamped.turns[0]), true);
  assert.equal(retainSubmittedTurn(native, turn, stamped.turns[0], binding, stamped), true);
  assert.equal(recoverableObserverTurn(native, binding, stamped)?.turn.id, turn.id);
  const before = structuredClone(native);
  assert.equal(retainSubmittedTurn(native, turn, source.turns[0], binding, source), false);
  assert.deepEqual(native, before);
  const duplicate = history([['user', '<timestamp>Monday, Oct 19, 2026, 11:01 AM (UTC)</timestamp>\n<user_query>Continue please</user_query>'],
    ['assistant', 'One'], ['user', '<timestamp>Monday, Oct 19, 2026, 11:01 AM (UTC)</timestamp>\n<user_query>Continue please</user_query>']]);
  assert.equal(recoverableObserverTurn(native, binding, duplicate), null);
  assert.equal(retainSubmittedTurn(native, turn, duplicate.turns[0], binding, duplicate), false);
});

test('an old ordinal submitted proof cannot jump to a new stable source with the same text', () => {
  const { native, source, binding } = submittedFixture();
  const stamped = history([['user', '<timestamp>Monday, Oct 19, 2026, 11:01 AM (UTC)</timestamp>\n<user_query>Continue please</user_query>']]);
  assert.notEqual(stamped.turns[0].id, source.turns[0].id);
  assert.equal(recoverableObserverTurn(native, binding, stamped), null);
});

test('submitted proofs reject client/model/raw-text/queue and exact canonical attribution conflicts', () => {
  const corruptions = [
    ({ proof }) => { delete proof.origin; },
    ({ proof }) => { proof.origin = 'external'; },
    ({ proof }) => { proof.version = 1; },
    ({ proof }) => { proof.extra = true; },
    ({ proof }) => { proof.clientId = ''; },
    ({ proof }) => { proof.clientId = 'other-native-client'; },
    ({ proof }) => { proof.model = 'different-model'; },
    ({ proof }) => { proof.userTextSha256 = '0'.repeat(64); },
    ({ proof }) => { proof.nativeUserTextSha256 = '0'.repeat(64); },
    ({ turn }) => { turn.items[0].clientId = null; },
    ({ turn }) => { turn.items[0].content[0].text = 'Continue please'; },
    ({ native }) => { native.queuedSubmissions = [{ clientUserMessageId: 'queued' }]; },
    ({ native }) => { native.queuedSubmissions = null; },
    ({ native, turn }) => { native.thread.turns.push({ id: 'duplicate-client', status: 'completed', items: [structuredClone(turn.items[0])] }); },
    ({ native, source }) => { delete native.historySync.sourceItems[source.turns[0].items[0].id]; },
    ({ native }) => { native.historySync.sourceItems['competing-source-user'] = 'native-user-item'; },
    ({ source }) => { source.turns[0].items.push(structuredClone(source.turns[0].items[0])); },
    ({ source }) => { source.turns[0].items[0].clientId = 'other-native-client'; },
    ({ source }) => { source.turns[0].items[0].content[0].text = 'Continue\nplease'; },
    ({ source }) => { delete source.sourceComplete; },
    ({ source }) => { delete source.completedTurnIds; },
  ];
  for (const corrupt of corruptions) {
    const fixture = submittedFixture();
    corrupt(fixture);
    const before = structuredClone(fixture);
    assert.equal(recoverableObserverTurn(fixture.native, fixture.binding, fixture.source), null, String(corrupt));
    assert.deepEqual(fixture, before);
  }
});

test('a malformed explicit submitted claim stays recognizable for fail-closed startup', () => {
  const fixture = submittedFixture();
  fixture.proof.clientId = 'wrong-client';
  assert.equal(observerTurnProof(fixture.native, fixture.turn.id), null);
  assert.equal(hasSubmittedTurnClaim(fixture.native, fixture.turn.id), true);
  fixture.proof.version = 99;
  assert.equal(hasSubmittedTurnClaim(fixture.native, fixture.turn.id), true);
});

test('queueing later preserves native ownership but blocks a fresh observer adoption', () => {
  const fixture = submittedFixture();
  fixture.native.queuedSubmissions = [{ id: 'queued-later', clientUserMessageId: 'future-client', input: [] }];
  assert.equal(observerTurnProof(fixture.native, fixture.turn.id), fixture.proof);
  assert.equal(recoverableObserverTurn(fixture.native, fixture.binding, fixture.source), null);
});

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
