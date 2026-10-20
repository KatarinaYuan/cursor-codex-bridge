import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTranscript } from './history.mjs';
import { nativeTurnTextSha256, submittedTurnTextSha256 } from './live-history.mjs';
import { OBSERVER_IDENTITY_LOSS_ERROR, planObserverRetirement } from './observer-recovery.mjs';
import { reconcileHistory } from './sync.mjs';

const envelope = (text, minute) => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;
function transcript(rows) {
  return parseTranscript(rows.map(([role, text]) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })).join('\n'),
    { id: 'cursor-session', cwd: '/fixture/project', updatedAt: 300 });
}

function fixture({ draft = false, matchingPreview = false, cardsAlreadyImported = false } = {}) {
  const earlier = [['user', envelope('Earlier question', '00')], ['assistant', 'Earlier complete answer']];
  const unique = transcript([...earlier, ['user', envelope('Continue  carefully\non this line', '01')], ['assistant', 'First canonical answer']]);
  const source = unique.turns[1];
  const old = structuredClone(unique.turns[0]);
  const preview = structuredClone(source);
  preview.id = 'external-preview'; preview.rootTurnId = preview.id; preview.status = 'inProgress';
  preview.startedAt = 200; preview.completedAt = null;
  preview.items[0].id = 'preview-user'; preview.items[1].id = 'preview-answer';
  preview.items[1].text = matchingPreview ? 'First canonical answer' : 'Rendered  partial\n  with exact whitespace\n';
  preview.items[1].phase = 'commentary';
  const binding = { sessionId: unique.id, cwd: unique.cwd, paneId: '%8', agentPid: 201, agentStartTime: '765432' };
  const record = { backend: 'legacy', cursorSessionId: unique.id, archived: false, titleOrigin: 'user',
    tmuxAffinity: { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime },
    thread: { id: 'native-chat', cwd: unique.cwd, model: 'composer-2.5[fast=true]', name: 'My custom title', updatedAt: 200,
      turns: [old, preview] },
    tmuxObserverTurns: { [preview.id]: { version: 1, sourceTurnId: source.id, sessionId: unique.id,
      paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime } },
    historySync: { sourceTurns: { [old.id]: old.id, [source.id]: preview.id },
      sourceItems: { [old.items[0].id]: old.items[0].id, [old.items[1].id]: old.items[1].id,
        [source.items[0].id]: preview.items[0].id, [source.items[1].id]: preview.items[1].id, anotherPreviewAlias: preview.items[1].id,
        unrelatedAlias: 'unrelated-native-item' } },
    livePreviewIds: { [preview.id]: preview.items[1].id }, liveSourcePreviews: { [preview.id]: true },
    queuedSubmissions: [{ id: 'queued-message', input: [{ type: 'text', text: 'Future question' }] }],
    privateDraft: { text: 'Keep this untouched' },
  };
  const history = transcript([...earlier,
    ['user', envelope('Continue  carefully\non this line', '01')], ['assistant', 'First canonical answer'],
    ['user', envelope('Continue  carefully\non this line', '01')], ['assistant', 'Second canonical answer'],
    ['user', envelope('A later question', '02')], ['assistant', 'Later complete answer']]);
  history.sourceComplete = true; history.completedTurnIds = history.turns.map(turn => turn.id);
  const screen = { inputAvailable: true, busy: false, ready: !draft, inputEmpty: !draft,
    reason: draft ? 'input-has-draft' : 'ready', inputText: draft ? 'Private unsent draft' : '' };
  if (cardsAlreadyImported) {
    const canonical = reconcileHistory({ ...structuredClone(record), thread: { ...structuredClone(record.thread), turns: [old] } }, history).record;
    record.thread.turns = [...canonical.thread.turns, preview];
    Object.assign(record.historySync.sourceTurns, canonical.historySync.sourceTurns);
    Object.assign(record.historySync.sourceItems, canonical.historySync.sourceItems);
  }
  return { record, history, binding, screen, preview, source };
}

for (const draft of [false, true]) test(`retires only the stale observer and imports canonical history${draft ? ' while preserving a private draft' : ''}`, () => {
  const f = fixture({ draft });
  const before = structuredClone(f);
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.deepEqual(f, before, 'planning must not mutate any input');
  assert.equal(result.retiredTurnId, f.preview.id);
  const retired = result.record.thread.turns[1];
  assert.equal(retired.status, 'interrupted');
  assert.equal(retired.error.message, OBSERVER_IDENTITY_LOSS_ERROR);
  assert.deepEqual(retired.items, f.preview.items, 'rendered text and exact user bytes remain evidence');
  assert.equal(retired.completedAt, 300);
  assert.equal(retired.durationMs, 100_000);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id),
    [f.history.turns[0].id, f.preview.id, ...f.history.turns.slice(1).map(turn => turn.id)]);
  assert.deepEqual(result.record.thread.turns[0], f.record.thread.turns[0]);
  assert.equal(result.record.thread.turns.slice(2).every(turn => turn.status === 'completed'), true);
  assert.equal(result.record.tmuxObserverTurns[f.preview.id], undefined);
  assert.equal(Object.values(result.record.historySync.sourceTurns).includes(f.preview.id), false);
  assert.equal(Object.values(result.record.historySync.sourceItems).some(id => f.preview.items.some(item => item.id === id)), false);
  assert.equal(result.record.historySync.sourceTurns[f.source.id], undefined);
  assert.equal(result.record.historySync.sourceItems.unrelatedAlias, 'unrelated-native-item');
  assert.deepEqual(result.record.queuedSubmissions, f.record.queuedSubmissions);
  assert.deepEqual(result.record.privateDraft, f.record.privateDraft);
  assert.equal(result.record.thread.model, f.record.thread.model);
  assert.equal(result.record.thread.name, f.record.thread.name);
  assert.deepEqual(result.turnsChanged.find(change => change.after.id === f.preview.id).before, f.preview);
  const saved = JSON.parse(JSON.stringify(result.record));
  assert.equal(planObserverRetirement(saved, f), null, 'a persisted retirement is idempotent');
  assert.equal(reconcileHistory(saved, f.history).changed, false, 'normal subsequent sync preserves the display order and ownership separation');
});

test('an exact final preview is still retained separately from both ambiguous canonical cards', () => {
  const f = fixture({ matchingPreview: true });
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.equal(result.record.thread.turns.length, 5);
  assert.deepEqual(result.record.thread.turns[1].items, f.preview.items);
  for (const source of f.history.turns.slice(1, 3)) {
    assert.notEqual(result.record.historySync.sourceTurns[source.id], f.preview.id);
  }
});

test('existing canonical replies keep their IDs and chronology when a late stale preview retires', () => {
  const f = fixture({ cardsAlreadyImported: true });
  const originals = structuredClone(f.record.thread.turns.slice(0, -1));
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.deepEqual(result.record.thread.turns.filter(turn => turn.id !== f.preview.id), originals);
  assert.equal(result.record.thread.turns[1].id, f.preview.id);
  assert.deepEqual(result.turnsChanged.map(change => change.after.id), [f.preview.id]);
});

test('exact unwrapped matching preserves meaningful interior spaces and newlines', () => {
  const wrapped = fixture();
  wrapped.preview.items[0].content[0].text = envelope('Continue  carefully\non this line', '01');
  assert.ok(planObserverRetirement(wrapped.record, wrapped));
  for (const text of ['Continue carefully\non this line', 'Continue  carefully on this line', 'Different question']) {
    const f = fixture(); f.preview.items[0].content[0].text = text;
    assert.equal(planObserverRetirement(f.record, f), null);
  }
});

test('retirement refuses every missing or uncertain completion, process, identity and proof guard', () => {
  const mutations = [
    f => { f.record.backend = 'acp'; },
    f => { f.record.thread.turns.push({ id: 'other-active', status: 'inProgress', items: [] }); },
    f => { f.preview.status = 'completed'; },
    f => { f.preview.unsubmittedDraft = { text: 'Do not hide this draft' }; },
    f => { delete f.record.tmuxObserverTurns; },
    f => { f.record.tmuxObserverTurns[f.preview.id].extra = true; },
    f => { f.record.tmuxObserverTurns[f.preview.id].version = 2; },
    f => { f.record.tmuxObserverTurns[f.preview.id].sourceTurnId = 'cursor-session:turn:1'; },
    f => { f.record.historySync.sourceTurns[f.source.id] = 'wrong-turn'; },
    f => { f.record.historySync.sourceTurns.otherAlias = f.preview.id; },
    f => { f.record.tmuxObserverTurns.other = { ...f.record.tmuxObserverTurns[f.preview.id] }; },
    f => { f.record.tmuxAffinity.agentStartTime = '999'; },
    f => { f.binding.paneId = '%9'; },
    f => { f.binding.agentPid++; },
    f => { f.binding.agentStartTime = '999'; },
    f => { f.binding.sessionId = 'different-session'; },
    f => { f.binding.cwd = '/another/project'; },
    f => { f.record.thread.cwd = ''; },
    f => { f.history.cwd = '/another/project'; },
    f => { f.history.id = 'different-session'; },
    f => { f.history.sourceComplete = false; },
    f => { delete f.history.sourceComplete; },
    f => { f.history.sourceIdentityScheme = 'unknown-v2'; },
    f => { delete f.history.completedTurnIds; },
    f => { f.history.completedTurnIds.pop(); },
    f => { f.history.completedTurnIds.splice(1, 1); },
    f => { f.history.turns.push(structuredClone(f.history.turns[1])); },
    f => { f.history.turns[2].sourceIdentity.sha256 = 'a'.repeat(64); },
    f => { f.history.turns[2].sourceIdentity.strength = 'stable'; },
    f => { f.history.turns[2].sourceIdentity.kind = 'legacy-position'; },
    f => { f.history.turns[2].sourceIdentity.version = 2; },
    f => { f.history.turns[2].id = f.source.id; },
    f => { f.history.turns[2].id += ':unknown'; },
    f => { f.history.turns[2].items[0].content[0].text = 'Different question'; },
    f => { f.history.turns[2].items[0].clientId = 'native-client'; },
    f => { f.history.turns[2].status = 'inProgress'; },
    f => { f.screen.busy = true; },
    f => { delete f.screen.busy; },
    f => { f.screen.inputAvailable = false; },
    f => { f.preview.items[0].clientId = 'native-client'; },
    f => { f.preview.items[1].id = f.preview.items[0].id; },
    f => { f.preview.items.push({ type: 'dynamicToolCall', id: 'tool' }); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    const before = structuredClone(f);
    assert.equal(planObserverRetirement(f.record, f), null, mutate.toString());
    assert.deepEqual(f, before, 'rejected plans never mutate inputs');
  }
});

test('even a fully valid native version 2 proof cannot be retired through ambiguous display identities', () => {
  const f = fixture();
  const user = f.preview.items[0]; user.clientId = 'native-client';
  Object.assign(f.record.tmuxObserverTurns[f.preview.id], { version: 2, origin: 'native', clientId: user.clientId,
    model: f.record.thread.model, userTextSha256: submittedTurnTextSha256(f.preview), nativeUserTextSha256: nativeTurnTextSha256(f.preview) });
  const before = structuredClone(f.record);
  assert.equal(planObserverRetirement(f.record, f), null);
  assert.deepEqual(f.record, before);
});

test('other saved observer evidence and retained drafts are untouched', () => {
  const f = fixture();
  f.record.tmuxObserverTurns.unrelated = { version: 1, sourceTurnId: 'unrelated-source', private: 'retain' };
  const prior = { id: 'failed-draft', rootTurnId: 'failed-draft', status: 'failed', items: [{ id: 'draft-user', type: 'userMessage',
    clientId: 'draft-client', content: [{ type: 'text', text: 'Unsent message\n' }] }], unsubmittedDraft: { retained: true } };
  f.record.thread.turns.push(prior);
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.deepEqual(result.record.tmuxObserverTurns.unrelated, f.record.tmuxObserverTurns.unrelated);
  assert.deepEqual(result.record.thread.turns.find(turn => turn.id === prior.id), prior);
});
