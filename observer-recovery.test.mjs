import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTranscript } from './history.mjs';
import { nativeTurnTextSha256, submittedTurnTextSha256 } from './live-history.mjs';
import { OBSERVER_IDENTITY_LOSS_ERROR, observerRetirementCandidate, planObserverRetirement } from './observer-recovery.mjs';
import { parseCursorScreen } from './screen.mjs';
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
  assert.deepEqual(result.record.retiredObserverTurns[f.preview.id], before.record.tmuxObserverTurns[f.preview.id]);
  assert.notEqual(result.record.retiredObserverTurns[f.preview.id], before.record.tmuxObserverTurns[f.preview.id]);
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

function advancedFixture({ native = true, busy = true, unfinished = true, matchingPreview = false } = {}) {
  const f = fixture({ matchingPreview });
  if (native) {
    const user = f.preview.items[0]; user.clientId = 'native-client';
    Object.assign(f.record.tmuxObserverTurns[f.preview.id], { version: 2, origin: 'native', clientId: user.clientId,
      model: f.record.thread.model, userTextSha256: submittedTurnTextSha256(f.preview), nativeUserTextSha256: nativeTurnTextSha256(f.preview) });
  }
  if (unfinished) {
    f.history.sourceComplete = false;
    f.history.completedTurnIds.pop();
    f.history.turns.at(-1).items[1].text = 'Only a partial successor reply';
  }
  if (busy) {
    const row = (text, rgb = '242;242;242') => ` \x1b[48;2;${rgb}m ${text}${' '.repeat(80)}\x1b[49m`;
    f.screen = parseCursorScreen([
      '  Cursor Agent', '  v2026.10.19-test',
      row('A later question', '227;227;227'), 'Only a partial successor reply',
      row(''), row('→ Add a follow-up    ctrl+c to stop'), row(''),
    ].join('\n'), { knownCursor: true });
    assert.equal(f.screen.reason, 'agent-busy');
    assert.equal(f.screen.modelName, null, 'a busy frame need not expose its model');
  }
  return f;
}

function projectedAdvancedFixture() {
  const f = advancedFixture();
  const oldSource = f.source;
  const rows = [['user', envelope('Earlier question', '00')], ['assistant', 'Earlier complete answer']];
  const query = 'Continue  carefully\n\n  on this line';
  const unique = transcript([...rows, ['user', envelope(query, '01')], ['assistant', 'First canonical answer']]);
  f.source = unique.turns[1];
  f.history = transcript([...rows, ['user', envelope(query, '01')], ['assistant', 'First canonical answer'],
    ['user', envelope(query, '01')], ['assistant', 'Second canonical answer'],
    ['user', envelope('A later question', '02')], ['assistant', 'Only a partial successor reply']]);
  f.history.sourceComplete = false;
  f.history.completedTurnIds = f.history.turns.slice(0, -1).map(turn => turn.id);
  f.preview.items[0].content[0].text = 'Continue  carefully\n\n\n\n  on this line\n';
  const proof = f.record.tmuxObserverTurns[f.preview.id];
  Object.assign(proof, { version: 3, sourceTurnId: f.source.id,
    userTextSha256: submittedTurnTextSha256(f.source), nativeUserTextSha256: nativeTurnTextSha256(f.preview) });
  delete f.record.historySync.sourceTurns[oldSource.id];
  f.record.historySync.sourceTurns[f.source.id] = f.preview.id;
  delete f.record.historySync.sourceItems[oldSource.items[0].id];
  delete f.record.historySync.sourceItems[oldSource.items[1].id];
  f.record.historySync.sourceItems[f.source.items[0].id] = f.preview.items[0].id;
  f.record.historySync.sourceItems[f.source.items[1].id] = f.preview.items[1].id;
  return f;
}

test('v3 duplicate-source retirement validates exported source and raw native hashes while preserving original blank lines', () => {
  const f = projectedAdvancedFixture();
  const before = structuredClone(f);
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.deepEqual(f, before);
  const retired = result.record.thread.turns.find(turn => turn.id === f.preview.id);
  assert.deepEqual(retired.items, f.preview.items);
  assert.equal(retired.items[0].content[0].text, 'Continue  carefully\n\n\n\n  on this line\n');
  assert.equal(result.record.retiredObserverTurns[retired.id].version, 3);
  assert.equal(result.record.thread.turns.some(turn => turn.id === f.history.turns.at(-1).id), false);
  assert.equal(reconcileHistory(result.record, { ...f.history, turns: f.history.turns.slice(0, -1) }).changed, false);
});

test('v3 duplicate-source retirement keeps strict hashes, whitespace, mappings and later-boundary requirements', () => {
  const mutations = [
    f => { f.record.tmuxObserverTurns[f.preview.id].version = 2; },
    f => { f.record.tmuxObserverTurns[f.preview.id].userTextSha256 = '0'.repeat(64); },
    f => { f.record.tmuxObserverTurns[f.preview.id].nativeUserTextSha256 = '0'.repeat(64); },
    f => { f.preview.items[0].content[0].text += '\n'; },
    f => { f.history.turns[1].items[0].content[0].text = 'Continue carefully\n\n  on this line'; },
    f => { f.history.turns[2].items[0].content[0].text = 'Continue  carefully\n  on this line'; },
    f => { f.record.historySync.sourceItems.alias = f.preview.items[0].id; },
    f => { f.history.turns.pop(); },
    f => { f.binding.agentStartTime = 'changed'; },
    f => { f.record.thread.model = 'different-model'; },
  ];
  for (const mutate of mutations) {
    const f = projectedAdvancedFixture(); mutate(f);
    const before = structuredClone(f);
    assert.equal(planObserverRetirement(f.record, f), null, mutate.toString());
    assert.deepEqual(f, before);
  }
});

test('native version 2 retirement still refuses ambiguous identities without a valid later boundary', () => {
  const f = advancedFixture({ busy: false, unfinished: false });
  f.history.turns.pop(); f.history.completedTurnIds.pop();
  const before = structuredClone(f);
  assert.equal(planObserverRetirement(f.record, f), null);
  assert.deepEqual(f, before);
});

for (const native of [false, true]) test(`a later busy stable turn releases a version ${native ? 2 : 1} observer and imports only its completed prefix`, () => {
  const f = advancedFixture({ native, matchingPreview: true });
  const before = structuredClone(f);
  const candidate = observerRetirementCandidate(f.record, f.history);
  assert.ok(candidate);
  assert.equal(candidate.turn, f.preview);
  assert.equal(candidate.proof.version, native ? 2 : 1);
  assert.equal(candidate.boundaryTurnId, f.history.turns.at(-1).id);
  assert.equal(candidate.advanced, true);
  assert.deepEqual(candidate.importTurns, f.history.turns.slice(0, -1));
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.deepEqual(f, before, 'planning keeps record, canonical capture and bindings pure');
  const retired = result.record.thread.turns.find(turn => turn.id === f.preview.id);
  assert.equal(retired.status, 'interrupted');
  assert.deepEqual(retired.items, f.preview.items);
  assert.deepEqual(result.record.retiredObserverTurns[f.preview.id], f.record.tmuxObserverTurns[f.preview.id]);
  assert.equal(result.record.thread.model, f.record.thread.model);
  assert.deepEqual(result.record.queuedSubmissions, f.record.queuedSubmissions);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id),
    [f.history.turns[0].id, f.preview.id, ...f.history.turns.slice(1, -1).map(turn => turn.id)]);
  for (const source of f.history.turns.slice(1, -1)) {
    assert.notEqual(result.record.historySync.sourceTurns[source.id], f.preview.id);
  }
  const tail = f.history.turns.at(-1);
  assert.equal(result.record.historySync.sourceTurns[tail.id], undefined);
  assert.equal(result.record.thread.turns.some(turn => turn.id === tail.id), false, 'provisional parser completion is not end evidence');
  assert.equal(Object.values(result.record.historySync.sourceItems).some(id => retired.items.some(item => item.id === id)), false);
  assert.equal(planObserverRetirement(JSON.parse(JSON.stringify(result.record)), f), null);
});

test('a completed later boundary permits native retirement on an idle capture', () => {
  const f = advancedFixture({ busy: false, unfinished: false });
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.equal(result.record.thread.turns.at(-1).id, f.history.turns.at(-1).id);
  assert.equal(result.record.thread.turns.at(-1).status, 'completed');
});

test('a busy capture of a later explicitly completed boundary also preserves its canonical card', () => {
  const f = advancedFixture({ unfinished: false });
  f.history.sourceComplete = false;
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.equal(result.record.thread.turns.at(-1).id, f.history.turns.at(-1).id);
});

test('version 1 globally completed idle recovery remains possible without any later turn', () => {
  const f = fixture();
  f.history.turns.pop(); f.history.completedTurnIds.pop();
  assert.equal(observerRetirementCandidate(f.record, f.history).advanced, false);
  assert.ok(planObserverRetirement(f.record, f));
});

test('advanced retirement refuses uncertain boundary, schema, completion, binding, proof and native user mapping evidence', () => {
  const mutations = [
    f => { f.history.turns.at(-1).sourceTimestampMinute = f.history.turns[1].sourceTimestampMinute; },
    f => { f.history.turns.at(-1).sourceTimestampMinute = f.history.turns[1].sourceTimestampMinute - 60_000; },
    f => { delete f.history.turns.at(-1).sourceTimestampMinute; },
    f => { f.history.turns.at(-1).sourceTimestampMinute += 1; },
    f => { f.history.turns.at(-1).sourceTimestampMinute = String(f.history.turns.at(-1).sourceTimestampMinute); },
    f => { f.history.turns[1].sourceTimestampMinute -= 60_000; },
    f => { delete f.history.turns[1].sourceTimestampMinute; },
    f => { f.history.turns.at(-1).sourceIdentity.version = 2; },
    f => { f.history.turns.at(-1).sourceIdentity.strength = 'position'; },
    f => { f.history.turns.at(-1).sourceIdentity.kind = 'legacy-position'; },
    f => { f.history.turns.at(-1).sourceIdentity.sha256 = 'invalid'; },
    f => { f.history.turns.at(-1).id += ':unknown'; },
    f => { f.history.turns.at(-1).status = 'unknown'; },
    f => { f.history.turns.at(-1).items[0].clientId = 'untrusted-client'; },
    f => { f.history.turns.at(-1).items[0].content[0].type = 'image'; },
    f => { f.history.turns.at(-1).items[0].content[0].text = ' '; },
    f => { f.history.turns[0].items[0].id = f.history.turns[1].items[0].id; },
    f => { f.history.turns[1].items[1].type = 'toolCall'; },
    f => { f.history.turns[2].sourceIdentity.version = 2; },
    f => { f.history.turns[2].items[0].content[0].text = 'Continue carefully\non this line'; },
    f => { f.history.turns[2].status = 'inProgress'; },
    f => { f.history.sourceIdentityScheme = 'cursor-envelope-v2'; },
    f => { delete f.history.sourceComplete; },
    f => { delete f.history.completedTurnIds; },
    f => { f.history.completedTurnIds.shift(); },
    f => { f.history.completedTurnIds.pop(); },
    f => { f.history.completedTurnIds.push(f.history.completedTurnIds[0]); },
    f => { f.history.completedTurnIds.push('unknown-source'); },
    f => { f.history.turns.push(structuredClone(f.history.turns.at(-1))); },
    f => { f.history.turns.splice(1, 0, f.history.turns.pop()); },
    f => { f.history.id = 'other-session'; },
    f => { f.history.cwd = '/other-project'; },
    f => { f.binding.cwd = '/other-project'; },
    f => { f.binding.sessionId = 'other-session'; },
    f => { f.binding.paneId = '%9'; },
    f => { f.binding.agentPid++; },
    f => { f.binding.agentStartTime = '999999'; },
    f => { f.record.tmuxAffinity.agentStartTime = '999999'; },
    f => { f.record.thread.model = 'a-different-model'; },
    f => { f.record.tmuxObserverTurns[f.preview.id].model = 'a-different-model'; },
    f => { f.record.tmuxObserverTurns[f.preview.id].extra = true; },
    f => { f.record.tmuxObserverTurns[f.preview.id].nativeUserTextSha256 = 'f'.repeat(64); },
    f => { f.preview.items[0].clientId = 'different-client'; },
    f => { f.preview.items[0].content[0].text += ' '; },
    f => { f.preview.unsubmittedDraft = { retained: true }; },
    f => { f.record.thread.turns.push({ id: 'unrelated-active', status: 'inProgress', items: [] }); },
    f => { delete f.record.historySync.sourceItems[`${f.source.id}:user`]; },
    f => { f.record.historySync.sourceItems[`${f.source.id}:user`] = 'wrong-native-user'; },
    f => { f.record.historySync.sourceItems.alias = f.preview.items[0].id; },
    f => { f.record.historySync.sourceTurns.alias = f.preview.id; },
    f => { f.record.retiredObserverTurns = { [f.preview.id]: structuredClone(f.record.tmuxObserverTurns[f.preview.id]) }; },
  ];
  for (const mutate of mutations) {
    const f = advancedFixture(); mutate(f);
    const before = structuredClone(f);
    assert.equal(planObserverRetirement(f.record, f) === null, true, mutate.toString());
    assert.deepEqual(f, before, 'every rejected advanced plan remains pure');
  }
});

test('a busy successor requires a complete recognized capture of the exact latest user boundary', () => {
  const mutations = [
    f => { f.screen.busy = false; },
    f => { delete f.screen.busy; },
    f => { f.screen.reason = 'unrecognized-cursor-screen'; },
    f => { f.screen.reason = 'incomplete-input-frame'; },
    f => { f.screen.reason = 'unrecognized-footer-or-overlay'; },
    f => { f.screen.inputAvailable = true; },
    f => { delete f.screen.inputAvailable; },
    f => { f.screen.ready = true; },
    f => { delete f.screen.stopKey; },
    f => { f.screen.stopKey = 'Enter'; },
    f => { f.screen.userMessages = []; },
    f => { f.screen.userMessages = ['Continue  carefully\non this line']; },
    f => { f.screen.userMessages.push('A newer screen-only user'); },
  ];
  for (const mutate of mutations) {
    const f = advancedFixture(); mutate(f);
    const before = structuredClone(f);
    assert.equal(planObserverRetirement(f.record, f) === null, true, mutate.toString());
    assert.deepEqual(f, before);
  }
  const wrapped = advancedFixture();
  wrapped.screen.userMessages = ['Earlier visible prompt', 'A later\nquestion'];
  assert.ok(planObserverRetirement(wrapped.record, wrapped), 'screen soft wrapping follows the live observer comparison');
});

function questionFixture(native = true) {
  const f = advancedFixture({ native, busy: false });
  Object.assign(f.screen, { waitingForQuestion: true, busy: false, ready: false, inputAvailable: false,
    stopKey: null, reason: 'incomplete-input-frame', userMessages: ['A later question'], modelName: null,
    inputText: 'Cursor Clarifying Questions\nQuestion 1 of 2\nPrivate typed answer stays here',
    inputDraft: { rows: ['Private typed answer stays here'], caret: { row: 0, offset: 29 }, width: 80 } });
  return f;
}

for (const native of [false, true]) test(`a recognized clarifying question releases version ${native ? 2 : 1} ownership without importing its unfinished successor or touching input`, () => {
  const f = questionFixture(native);
  const before = structuredClone(f);
  const result = planObserverRetirement(f.record, f);
  assert.ok(result);
  assert.deepEqual(f, before, 'the question overlay, private answer and all recovery inputs remain untouched');
  const retired = result.record.thread.turns.find(turn => turn.id === f.preview.id);
  assert.equal(retired.status, 'interrupted');
  assert.deepEqual(retired.items, f.preview.items);
  assert.deepEqual(result.record.retiredObserverTurns[f.preview.id], f.record.tmuxObserverTurns[f.preview.id]);
  assert.equal(result.record.thread.model, f.record.thread.model);
  assert.deepEqual(result.record.privateDraft, f.record.privateDraft);
  assert.deepEqual(result.record.queuedSubmissions, f.record.queuedSubmissions);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id),
    [f.history.turns[0].id, f.preview.id, ...f.history.turns.slice(1, -1).map(turn => turn.id)]);
  assert.equal(result.record.historySync.sourceTurns[f.history.turns.at(-1).id], undefined);
  assert.equal(Object.values(result.record.historySync.sourceTurns).includes(f.preview.id), false);
  assert.equal(Object.values(result.record.historySync.sourceItems).some(id => retired.items.some(item => item.id === id)), false);
});

test('a clarifying-question successor requires explicit parser recognition, unavailable input and the latest proven boundary', () => {
  const mutations = [
    f => { delete f.screen.waitingForQuestion; },
    f => { f.screen.waitingForQuestion = false; },
    f => { f.screen.waitingForQuestion = 'true'; },
    f => { f.screen.busy = true; },
    f => { delete f.screen.busy; },
    f => { f.screen.ready = true; },
    f => { delete f.screen.ready; },
    f => { f.screen.inputAvailable = true; },
    f => { delete f.screen.inputAvailable; },
    f => { f.screen.stopKey = 'Escape'; },
    f => { delete f.screen.stopKey; },
    f => { delete f.screen.userMessages; },
    f => { f.screen.userMessages = []; },
    f => { f.screen.userMessages = ['Continue  carefully\non this line']; },
    f => { f.screen.userMessages.push('A different latest question'); },
    f => { f.history.turns.at(-1).sourceTimestampMinute = f.history.turns[1].sourceTimestampMinute; },
    f => { f.history.turns.at(-1).sourceIdentity.strength = 'ambiguous'; },
    f => { f.history.completedTurnIds.pop(); },
    f => { f.binding.agentStartTime = '999999'; },
    f => { f.record.thread.model = 'changed-model'; },
    f => { f.preview.unsubmittedDraft = { retained: true }; },
    f => { f.record.historySync.sourceItems.alias = f.preview.items[0].id; },
  ];
  for (const mutate of mutations) {
    const f = questionFixture(); mutate(f);
    const before = structuredClone(f);
    assert.equal(planObserverRetirement(f.record, f) === null, true, mutate.toString());
    assert.deepEqual(f, before, 'rejected question recovery never edits private input or persisted evidence');
  }
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
