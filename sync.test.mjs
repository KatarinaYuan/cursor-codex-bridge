import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from './history.mjs';
import { reconcileHistory } from './sync.mjs';
import { retainSubmittedTurn } from './live-history.mjs';

function history(rows, extra = {}) {
  return parseTranscript(rows.map(([role, text]) => JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })).join('\n'), {
    id: 'cursor-chat', title: 'Source title', cwd: '/home/testuser', updatedAt: 200, ...extra,
  });
}
function record(source, extra = {}) {
  return {
    backend: 'legacy', cursorSessionId: source.id, archived: false, titleOrigin: 'source',
    thread: { id: 'native-chat', name: source.title, model: 'composer-2.5', updatedAt: 100, recencyAt: 100,
      turns: structuredClone(source.turns) }, ...extra,
  };
}
const source = history([['user', 'First question'], ['assistant', 'First answer']]);

function projectedFixture(completed = false) {
  const incoming = history([['user', '<timestamp>Monday, Oct 19, 2026, 11:01 AM (UTC)</timestamp>\n<user_query>First\n\n  Second  line</user_query>'],
    ['assistant', 'Complete projected reply']]);
  incoming.sourceComplete = completed;
  incoming.completedTurnIds = completed ? incoming.turns.map(turn => turn.id) : [];
  const native = record(incoming);
  native.thread.cwd = incoming.cwd;
  const turn = native.thread.turns[0];
  turn.id = 'projected-native'; turn.rootTurnId = turn.id; turn.status = 'inProgress';
  turn.items[0].id = 'projected-native-user'; turn.items[0].clientId = 'projected-client';
  turn.items[0].content[0].text = 'First\n\n\n\n  Second  line\n';
  turn.items[1].id = 'projected-native-answer';
  const binding = { sessionId: incoming.id, cwd: incoming.cwd, paneId: '%12', agentPid: 42, agentStartTime: '12345' };
  native.tmuxAffinity = { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime };
  native.historySync = { sourceTurns: { [incoming.turns[0].id]: turn.id },
    sourceItems: { [incoming.turns[0].items[0].id]: turn.items[0].id } };
  assert.equal(retainSubmittedTurn(native, turn, incoming.turns[0], binding, incoming), true);
  const proof = native.tmuxObserverTurns[turn.id];
  assert.equal(proof.version, 3);
  if (completed) {
    turn.status = 'completed';
    native.exportedSubmissionTurns = { [turn.id]: structuredClone(proof) };
    delete native.tmuxObserverTurns[turn.id];
  }
  return { native, incoming, turn, proof: completed ? native.exportedSubmissionTurns[turn.id] : proof };
}

for (const completed of [false, true]) test(`a ${completed ? 'retained completed' : 'live'} v3 receipt reconciles the projected echo without duplicating or replacing the raw native user`, () => {
  const f = projectedFixture(completed);
  if (completed) f.native.tmuxAffinity = { paneId: '%99', agentPid: 900, agentStartTime: '99999' };
  const before = structuredClone(f);
  const result = reconcileHistory(f.native, f.incoming);
  assert.deepEqual(f, before);
  assert.equal(result.record.thread.turns.length, 1);
  const native = result.record.thread.turns[0];
  assert.equal(native.items.filter(item => item.type === 'userMessage').length, 1);
  assert.deepEqual(native.items.find(item => item.type === 'userMessage'), f.turn.items[0]);
  assert.equal(native.items[0].content[0].text, 'First\n\n\n\n  Second  line\n');
  assert.equal(result.record.historySync.sourceItems[f.incoming.turns[0].items[0].id], f.turn.items[0].id);
  assert.equal(reconcileHistory(JSON.parse(JSON.stringify(result.record)), f.incoming).changed, false);
});

test('a retained completed projection survives later model and original process changes without duplicating its native user', () => {
  const f = projectedFixture(true);
  f.native.thread.model = 'different-current-model';
  f.native.tmuxAffinity = { paneId: '%99', agentPid: 900, agentStartTime: '99999' };
  const before = structuredClone(f);
  const result = reconcileHistory(f.native, f.incoming);
  assert.deepEqual(f, before);
  assert.equal(result.record.thread.turns.length, 1);
  assert.deepEqual(result.record.thread.turns[0].items, f.turn.items);
  assert.equal(result.record.thread.model, 'different-current-model');
  assert.deepEqual(result.record.exportedSubmissionTurns, f.native.exportedSubmissionTurns);
  assert.equal(reconcileHistory(JSON.parse(JSON.stringify(result.record)), f.incoming).changed, false);
});

test('a live projection still requires its model and a terminal projection requires an archived receipt before ignoring later model changes', () => {
  for (const terminal of [false, true]) {
    const f = projectedFixture();
    if (terminal) f.turn.status = 'completed';
    f.native.thread.model = 'different-current-model';
    const result = reconcileHistory(f.native, f.incoming);
    assert.notEqual(result.record.historySync.sourceTurns[f.incoming.turns[0].id], f.turn.id);
    assert.deepEqual(result.record.thread.turns.find(turn => turn.id === f.turn.id).items, f.turn.items);
  }
});

test('projection echo matching refuses missing or corrupt receipts and every uncertain ownership field', () => {
  const mutations = [
    f => { delete f.native.exportedSubmissionTurns; },
    f => { f.proof.version = 2; },
    f => { f.proof.origin = 'external'; },
    f => { f.proof.extra = true; },
    f => { f.proof.sessionId = 'other-session'; },
    f => { f.proof.sourceTurnId += ':wrong'; },
    f => { f.proof.paneId = 'not-pane'; },
    f => { f.proof.agentPid = 0; },
    f => { f.proof.agentStartTime = 'not-start'; },
    f => { f.proof.model = ''; },
    f => { f.proof.model = '   '; },
    f => { f.proof.clientId = 'other-client'; },
    f => { f.proof.nativeUserTextSha256 = '0'.repeat(64); },
    f => { f.proof.userTextSha256 = '0'.repeat(64); },
    f => { f.turn.items[0].content[0].text += '\n'; },
    f => { f.incoming.turns[0].items[0].content[0].text = 'First\n  Second  line'; },
    f => { f.incoming.turns[0].items[0].content[0].text = 'First\n\n  Second line'; },
    f => { f.incoming.turns[0].sourceIdentity.strength = 'ambiguous'; },
    f => { delete f.native.historySync.sourceTurns[f.incoming.turns[0].id]; },
    f => { f.native.historySync.sourceTurns.other = f.turn.id; },
    f => { delete f.native.historySync.sourceItems[f.incoming.turns[0].items[0].id]; },
    f => { f.native.historySync.sourceItems.other = f.turn.items[0].id; },
    f => { f.native.thread.cwd = '/other-project'; },
    f => { f.native.thread.turns.push({ id: 'duplicate-client', items: [structuredClone(f.turn.items[0])] }); },
    f => { f.native.tmuxObserverTurns = { [f.turn.id]: { ...f.proof, clientId: 'competing-proof' } }; },
  ];
  for (const mutate of mutations) {
    const f = projectedFixture(true); mutate(f);
    const original = structuredClone(f.turn.items[0]);
    const result = reconcileHistory(f.native, f.incoming);
    assert.notEqual(result.record.historySync.sourceTurns[f.incoming.turns[0].id], f.turn.id, mutate.toString());
    assert.deepEqual(result.record.thread.turns.find(turn => turn.id === f.turn.id).items[0], original);
  }
});

test('imports new external turns and is idempotent after persistence', () => {
  const initial = record(source);
  const incoming = history([['user', 'First question'], ['assistant', 'First answer'], ['user', 'External question'], ['assistant', 'External answer']]);
  const result = reconcileHistory(initial, incoming);
  assert.equal(result.changed, true);
  assert.equal(initial.thread.turns.length, 1, 'merge does not mutate caller state');
  assert.equal(result.record.thread.turns.length, 2);
  assert.equal(result.turnsChanged.length, 1);
  assert.equal(result.turnsChanged[0].before, null);
  assert.equal(result.record.thread.updatedAt, 200);
  const persisted = JSON.parse(JSON.stringify(result.record));
  assert.equal(reconcileHistory(persisted, incoming).changed, false);
});

test('binds a bridge continuation echoed by CLI without duplicating cards or IDs', () => {
  const native = record(source);
  native.thread.turns.push({ id: 'native-turn', rootTurnId: 'native-turn', status: 'completed',
    startedAt: 150, completedAt: 155, items: [
      { id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: '<timestamp>today</timestamp>\n<user_query>Continue here</user_query>' }] },
      { id: 'native-reasoning', type: 'reasoning', summary: ['Reasoned locally'] },
      { id: 'native-tool', type: 'dynamicToolCall', status: 'completed' },
      { id: 'native-answer', type: 'agentMessage', text: 'The continuation answer', phase: 'final_answer' },
    ] });
  const incoming = history([['user', 'First question'], ['assistant', 'First answer'], ['user', 'Continue here'], ['assistant', 'The continuation answer']]);
  const result = reconcileHistory(native, incoming);
  assert.equal(result.record.thread.turns.length, 2);
  assert.deepEqual(result.record.thread.turns[1], native.thread.turns[1]);
  assert.equal(result.turnsChanged.length, 0);
  assert.equal(result.record.historySync.sourceTurns['cursor-chat:turn:1'], 'native-turn');
  assert.equal(result.record.historySync.sourceItems[incoming.turns[1].items[1].id], 'native-answer');
  assert.equal(reconcileHistory(result.record, incoming).changed, false);
});

test('partial assistant messages grow and never regress to an older snapshot', () => {
  const partial = history([['user', 'First question'], ['assistant', 'First']]);
  let native = record(partial);
  const firstId = native.thread.turns[0].items[1].id;
  const extended = reconcileHistory(native, source);
  assert.equal(extended.turnsChanged.length, 1);
  assert.equal(extended.record.thread.turns[0].items[1].id, firstId);
  assert.equal(extended.record.thread.turns[0].items[1].text, 'First answer');
  native = JSON.parse(JSON.stringify(extended.record));
  const older = reconcileHistory(native, partial);
  assert.equal(older.changed, false);
  assert.equal(older.record.thread.turns[0].items[1].text, 'First answer');
});

test('updates source-owned interruptions without regressing terminal evidence', () => {
  const incoming = structuredClone(source);
  incoming.turns[0].status = 'interrupted';
  const native = record(source);
  native.thread.turns[0].startedAt = 77;
  native.thread.turns[0].completedAt = 88;
  const result = reconcileHistory(native, incoming);
  assert.equal(result.record.thread.turns[0].status, 'interrupted');
  assert.equal(result.record.thread.turns[0].error, null);
  assert.equal(result.record.thread.turns[0].startedAt, 77);
  assert.equal(result.record.thread.turns[0].completedAt, 88);
  assert.equal(result.turnsChanged.length, 1);
  assert.equal(reconcileHistory(result.record, incoming).changed, false);
  assert.equal(reconcileHistory(result.record, source).record.thread.turns[0].status, 'interrupted');

  const failed = structuredClone(result.record);
  failed.thread.turns[0].status = 'failed';
  failed.thread.turns[0].error = { message: 'Known failure' };
  const older = reconcileHistory(failed, incoming);
  assert.equal(older.record.thread.turns[0].status, 'failed');
  assert.deepEqual(older.record.thread.turns[0].error, { message: 'Known failure' });
});

test('source interruptions cannot overwrite bridge-owned status, timing, or error evidence', () => {
  const native = record(source);
  native.thread.turns[0].id = 'bridge-turn';
  native.thread.turns[0].rootTurnId = 'bridge-turn';
  native.thread.turns[0].startedAt = 77;
  native.thread.turns[0].completedAt = 88;
  native.thread.turns[0].error = { message: 'Native evidence' };
  const incoming = structuredClone(source);
  incoming.turns[0].status = 'interrupted';
  const result = reconcileHistory(native, incoming);
  assert.deepEqual(result.record.thread.turns[0], native.thread.turns[0]);
  assert.equal(result.turnsChanged.length, 0);
  assert.equal(result.record.historySync.sourceTurns[source.turns[0].id], 'bridge-turn');
});

test('preserves explicit native rename, archive, selected model and timing', () => {
  const native = record(source, { archived: true, titleOrigin: 'user' });
  native.thread.name = 'My native title';
  native.thread.model = 'claude-sonnet-4.6';
  native.thread.turns[0].startedAt = 77;
  const result = reconcileHistory(native, { ...source, title: 'A new Cursor title' });
  assert.equal(result.nameChanged, false);
  assert.equal(result.record.thread.name, 'My native title');
  assert.equal(result.record.archived, true);
  assert.equal(result.record.thread.model, 'claude-sonnet-4.6');
  assert.equal(result.record.thread.turns[0].startedAt, 77);
});

test('updates source-controlled titles but conservatively keeps older unmarked custom names', () => {
  const renamed = { ...source, title: 'Changed at CLI' };
  const auto = reconcileHistory(record(source), renamed);
  assert.equal(auto.nameChanged, true);
  assert.equal(auto.record.thread.name, renamed.title);
  const manual = record(source);
  delete manual.titleOrigin;
  manual.thread.name = 'An earlier native rename';
  assert.equal(reconcileHistory(manual, renamed).record.thread.name, manual.thread.name);
});

test('truncated source never removes existing turns or items', () => {
  const longer = history([['user', 'First question'], ['assistant', 'First answer'], ['user', 'Second question'], ['assistant', 'Second answer']]);
  const seeded = reconcileHistory(record(longer), longer).record;
  const truncated = reconcileHistory(seeded, source);
  assert.equal(truncated.turnsChanged.length, 0);
  assert.equal(truncated.record.thread.turns.length, 2);
  assert.deepEqual(truncated.record.thread.turns, longer.turns);
  assert.equal(truncated.changed, false);
});

test('identical prompts match forwards rather than globally deduplicating text', () => {
  const incoming = history([['user', 'Same question'], ['assistant', 'Answer one'], ['user', 'Same question'], ['assistant', 'Answer two'], ['user', 'Same question'], ['assistant', 'Answer three']]);
  const native = record(incoming);
  native.thread.turns.pop();
  native.thread.turns[0].id = 'native-one';
  native.thread.turns[1].id = 'native-two';
  const result = reconcileHistory(native, incoming);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id), ['native-one', 'native-two', 'cursor-chat:turn:2']);
  assert.equal(result.record.thread.turns[1].items[1].text, 'Answer two');
  assert.equal(result.turnsChanged.length, 1);
  assert.equal(reconcileHistory(result.record, incoming).changed, false);
});

function interleavedRecord(bridgePrompt = 'Bridge question') {
  const native = record(source);
  native.thread.turns.push({ id: 'bridge-B', rootTurnId: 'bridge-B', status: 'completed', items: [
    { id: 'bridge-user-B', type: 'userMessage', content: [{ type: 'text', text: bridgePrompt }] },
    { id: 'bridge-reasoning-B', type: 'reasoning', summary: ['Native reasoning'] },
    { id: 'bridge-answer-B', type: 'agentMessage', text: 'native B' },
  ] });
  return native;
}

test('inserts an external turn between an anchor and its later native bridge echo', () => {
  const native = interleavedRecord();
  const incoming = history([['user', 'First question'], ['assistant', 'First answer'],
    ['user', 'External question'], ['assistant', 'external C'], ['user', 'Bridge question'], ['assistant', 'native B']]);
  const result = reconcileHistory(native, incoming);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id), ['cursor-chat:turn:0', 'cursor-chat:turn:1', 'bridge-B']);
  assert.deepEqual(result.record.thread.turns[2], native.thread.turns[1]);
  assert.equal(result.record.historySync.sourceTurns['cursor-chat:turn:2'], 'bridge-B');
  assert.equal(result.turnsChanged.length, 1);
  assert.equal(reconcileHistory(JSON.parse(JSON.stringify(result.record)), incoming).changed, false);
});

test('interleaved repeated Continue prompts use the answer to identify the native echo', () => {
  const native = interleavedRecord('Continue');
  const incoming = history([['user', 'First question'], ['assistant', 'First answer'],
    ['user', 'Continue'], ['assistant', 'external C'], ['user', 'Continue'], ['assistant', 'native B']]);
  const result = reconcileHistory(native, incoming);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id), ['cursor-chat:turn:0', 'cursor-chat:turn:1', 'bridge-B']);
  assert.deepEqual(result.record.thread.turns[2], native.thread.turns[1]);
  assert.equal(result.record.thread.turns[1].items[1].text, 'external C');
  assert.equal(result.turnsChanged.length, 1);
  assert.equal(reconcileHistory(JSON.parse(JSON.stringify(result.record)), incoming).changed, false);
});

test('unanchored truncated source appends new data without losing a later existing bridge echo', () => {
  const native = interleavedRecord();
  const incoming = history([['user', 'External question'], ['assistant', 'external C'],
    ['user', 'Bridge question'], ['assistant', 'native B']]);
  const result = reconcileHistory(native, incoming);
  assert.deepEqual(result.record.thread.turns.slice(0, 2), native.thread.turns);
  assert.equal(result.record.thread.turns.length, 3);
  assert.equal(result.record.thread.turns[2].items[1].text, 'external C');
  assert.equal(result.record.historySync.sourceTurns['cursor-chat:turn:1'], 'bridge-B');
  assert.equal(reconcileHistory(JSON.parse(JSON.stringify(result.record)), incoming).changed, false);
});

test('a partial user-only repeated prompt waits for enough evidence to avoid a false echo binding', () => {
  const native = interleavedRecord('Continue');
  const partial = history([['user', 'First question'], ['assistant', 'First answer'], ['user', 'Continue']]);
  const first = reconcileHistory(native, partial);
  assert.equal(first.record.thread.turns.length, 2);
  assert.equal(first.record.historySync.sourceTurns['cursor-chat:turn:1'], undefined);
  const complete = history([['user', 'First question'], ['assistant', 'First answer'],
    ['user', 'Continue'], ['assistant', 'external C'], ['user', 'Continue'], ['assistant', 'native B']]);
  const result = reconcileHistory(JSON.parse(JSON.stringify(first.record)), complete);
  assert.equal(result.record.thread.turns.length, 3);
  assert.deepEqual(result.record.thread.turns[2], native.thread.turns[1]);
  assert.equal(result.record.thread.turns[1].items[1].text, 'external C');
});

test('an explicitly interrupted user-only repeat imports without binding an earlier completed answer', () => {
  const native = interleavedRecord('Continue');
  const incoming = history([['user', 'First question'], ['assistant', 'First answer'], ['user', 'Continue']]);
  incoming.turns[1].status = 'interrupted';
  const result = reconcileHistory(native, incoming);
  assert.equal(result.record.thread.turns.length, 3);
  assert.equal(result.record.thread.turns[1].status, 'interrupted');
  assert.equal(result.record.thread.turns[1].items.length, 1);
  assert.deepEqual(result.record.thread.turns[2], native.thread.turns[1]);
  assert.equal(result.record.historySync.sourceTurns['cursor-chat:turn:1'], 'cursor-chat:turn:1');
  assert.equal(reconcileHistory(result.record, incoming).changed, false);
});

test('matches echoed assistant chunks with different transcript grouping', () => {
  const incoming = history([['user', 'A question'], ['assistant', 'Part one'], ['assistant', 'Part two']]);
  const native = record(incoming);
  native.thread.turns[0].id = 'bridge-native-turn';
  native.thread.turns[0].items = [
    { id: 'bridge-user', type: 'userMessage', content: [{ type: 'text', text: 'A question' }] },
    { id: 'bridge-answer', type: 'agentMessage', text: 'Part one\nPart two' },
  ];
  const result = reconcileHistory(native, incoming);
  assert.deepEqual(result.record.thread.turns[0], native.thread.turns[0]);
  assert.equal(result.turnsChanged.length, 0);
  assert.equal(reconcileHistory(result.record, incoming).changed, false);
});

test('extends an echoed bridge answer while preserving its native ID and intervening tool cards', () => {
  const incoming = history([['user', 'A question'], ['assistant', 'The complete answer']]);
  const native = record(incoming);
  native.thread.turns[0].id = 'native-turn';
  native.thread.turns[0].items[1].id = 'native-answer';
  native.thread.turns[0].items[1].text = 'The complete';
  native.thread.turns[0].items.splice(1, 0, { id: 'native-tool', type: 'dynamicToolCall', status: 'completed' });
  const result = reconcileHistory(native, incoming);
  assert.equal(result.record.thread.turns[0].items.length, 3);
  assert.equal(result.record.thread.turns[0].items[2].id, 'native-answer');
  assert.equal(result.record.thread.turns[0].items[2].text, 'The complete answer');
  assert.equal(result.record.thread.turns[0].items[1].id, 'native-tool');
  assert.equal(result.turnsChanged.length, 1);
  assert.equal(reconcileHistory(JSON.parse(JSON.stringify(result.record)), incoming).changed, false);
});

test('new external turn data never aliases scanner snapshots', () => {
  const incoming = history([['user', 'First question'], ['assistant', 'First answer'], ['user', 'External question'], ['assistant', 'External answer']]);
  const result = reconcileHistory(record(source), incoming);
  result.record.thread.turns[1].items[0].content[0].text = 'changed in record';
  result.turnsChanged[0].after.items[1].text = 'changed in notification';
  assert.equal(incoming.turns[1].items[0].content[0].text, 'External question');
  assert.equal(incoming.turns[1].items[1].text, 'External answer');
  assert.equal(result.record.thread.turns[1].items[1].text, 'External answer');
});

test('bridge partial text ending in a streamed space extends without doubling whitespace', () => {
  const incoming = history([['user', 'A question'], ['assistant', 'Hello world']]);
  const native = record(incoming);
  native.thread.turns[0].id = 'native-turn';
  native.thread.turns[0].items[1].text = 'Hello ';
  const result = reconcileHistory(native, incoming);
  assert.equal(result.record.thread.turns[0].items[1].text, 'Hello world');
  assert.equal(reconcileHistory(result.record, incoming).changed, false);
});

test('an unrelated or ACP-backed record is left untouched', () => {
  const native = record(source);
  assert.equal(reconcileHistory({ ...native, backend: 'acp' }, source).changed, false);
  assert.equal(reconcileHistory(native, { ...source, id: 'other-chat' }).changed, false);
});

const envelope = (text, minute) => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;

test('stable envelopes migrate old ordinal history by unique complete content without changing native identity', () => {
  const prior = history([['user', 'First question'], ['assistant', 'First answer'],
    ['user', 'Briefly report'], ['assistant', 'Old complete report']]);
  const native = record(prior);
  native.thread.turns[1].items[0].clientId = 'original-client';
  native.thread.turns[1].items[0].content[0].text = 'Briefly report\n';
  native.historySync = { sourceTurns: Object.fromEntries(prior.turns.map(turn => [turn.id, turn.id])), sourceItems: {} };
  const incoming = history([['user', envelope('First question', '00')], ['assistant', 'First answer'],
    ['user', envelope('Briefly report', '01')], ['assistant', 'Old complete report'],
    ['user', envelope('New request', '02')], ['assistant', 'New result']]);
  const result = reconcileHistory(native, incoming);
  assert.equal(result.record.thread.turns.length, 3);
  assert.deepEqual(result.record.thread.turns.slice(0, 2), native.thread.turns);
  for (let index = 0; index < 2; index++) {
    assert.equal(result.record.historySync.sourceTurns[incoming.turns[index].id], native.thread.turns[index].id);
    assert.equal(result.record.historySync.sourceTurns[prior.turns[index].id], undefined);
  }
  assert.equal(result.record.thread.model, native.thread.model);
  assert.equal(reconcileHistory(result.record, incoming).changed, false);
});

test('new stable IDs cannot claim a running native turn merely because its prompt or ordinal matches', () => {
  const prior = history([['user', 'Old request'], ['assistant', 'Old answer']]);
  const native = record(prior);
  native.thread.turns.push({ id: 'pending-native', status: 'inProgress', items: [{ id: 'pending-user', type: 'userMessage',
    clientId: 'pending-client', content: [{ type: 'text', text: 'New request\n' }] }] });
  native.historySync = { sourceTurns: { 'cursor-chat:turn:0': prior.turns[0].id }, sourceItems: {} };
  const incoming = history([['user', envelope('New request', '01')], ['assistant', 'New answer']]);
  const result = reconcileHistory(native, incoming);
  assert.equal(result.record.thread.turns.find(turn => turn.id === 'pending-native').status, 'inProgress');
  assert.notEqual(result.record.historySync.sourceTurns[incoming.turns[0].id], 'pending-native');
  assert.equal(result.record.thread.turns[0].items[0].content[0].text, 'Old request');
});

test('multiple compatible historical answers never guess which native ID owns a new envelope', () => {
  const source = history([['user', envelope('Continue', '01')], ['assistant', 'Same answer']]);
  const native = record(source);
  native.thread.turns[0].id = 'native-one';
  native.thread.turns[0].items[0].id = 'native-one-user';
  const second = structuredClone(native.thread.turns[0]); second.id = 'native-two'; second.items[0].id = 'native-two-user';
  native.thread.turns.push(second);
  const result = reconcileHistory(native, source);
  assert.notEqual(result.record.historySync.sourceTurns[source.turns[0].id], 'native-one');
  assert.notEqual(result.record.historySync.sourceTurns[source.turns[0].id], 'native-two');
});

test('a completed unique envelope becomes two display cards without duplicating its exact historical answer', () => {
  const unique = history([['user', envelope('Continue', '01')], ['assistant', 'First answer']]);
  const native = reconcileHistory(record(unique), unique).record;
  const originalId = native.thread.turns[0].id;
  const ambiguous = history([['user', envelope('Continue', '01')], ['assistant', 'First answer'],
    ['user', envelope('Continue', '01')], ['assistant', 'Second answer']]);
  const result = reconcileHistory(native, ambiguous);
  assert.equal(result.record.thread.turns.length, 2);
  assert.equal(result.record.historySync.sourceTurns[ambiguous.turns[0].id], originalId);
  assert.notEqual(result.record.historySync.sourceTurns[ambiguous.turns[1].id], originalId);
  assert.equal(reconcileHistory(result.record, ambiguous).changed, false);
});

test('a completed native UUID retains its display identity when a proven envelope later duplicates', () => {
  const unique = history([['user', envelope('Continue', '01')], ['assistant', 'First answer']]);
  const native = record(unique);
  native.thread.turns[0].id = 'completed-native';
  native.thread.turns[0].items[0].clientId = 'original-client';
  delete native.thread.turns[0].sourceIdentity;
  native.historySync = { sourceTurns: { [unique.turns[0].id]: 'completed-native' }, sourceItems: {} };
  const ambiguous = history([['user', envelope('Continue', '01')], ['assistant', 'First answer'],
    ['user', envelope('Continue', '01')], ['assistant', 'Second answer']]);
  const result = reconcileHistory(native, ambiguous);
  assert.equal(result.record.thread.turns.length, 2);
  assert.equal(result.record.thread.turns[0].id, 'completed-native');
  assert.equal(result.record.thread.turns[0].items[0].clientId, 'original-client');
});

test('a reused assistant item ID cannot hide incompatible rewritten source text', () => {
  const prior = history([['user', 'A question'], ['assistant', 'Original answer']]);
  const native = reconcileHistory(record(prior), prior).record;
  const rewritten = history([['user', 'A question'], ['assistant', 'Different rewritten answer']]);
  const result = reconcileHistory(native, rewritten);
  const agents = result.record.thread.turns[0].items.filter(item => item.type === 'agentMessage');
  assert.deepEqual(agents.map(item => item.text), ['Original answer', 'Different rewritten answer']);
  assert.notEqual(agents[0].id, agents[1].id);
  assert.equal(reconcileHistory(result.record, rewritten).changed, false);
});

test('an unfinished new envelope cannot reuse an earlier completed same-prompt answer prefix', () => {
  const prior = history([['user', envelope('Continue', '01')], ['assistant', 'Hello world']]);
  const native = reconcileHistory(record(prior), prior).record;
  const incoming = { ...history([['user', envelope('Continue', '02')], ['assistant', 'Hello']]), sourceComplete: false };
  const result = reconcileHistory(native, incoming);
  assert.equal(result.record.thread.turns.length, 2);
  assert.notEqual(result.record.historySync.sourceTurns[incoming.turns[0].id], native.thread.turns[0].id);
  assert.equal(result.record.thread.turns[0].items[1].text, 'Hello world');
});

function detachedPreviewFixture() {
  const incoming = history([['user', envelope('Earlier request', '00')], ['assistant', 'Earlier result'],
    ['user', envelope('Continue', '02')], ['assistant', 'The complete canonical response'],
    ['user', envelope('Later CLI request', '03')], ['assistant', 'Later CLI result']]);
  incoming.sourceComplete = true;
  incoming.completedTurnIds = incoming.turns.map(turn => turn.id);
  const native = reconcileHistory(record(incoming), incoming).record;
  native.thread.cwd = incoming.cwd;
  const failed = { id: 'detached-native', rootTurnId: 'detached-native', status: 'failed',
    startedAt: Date.UTC(2026, 9, 19, 11, 1, 15) / 1000, completedAt: 1_800_000_000, durationMs: 1234,
    error: { message: 'Cursor tmux observer detached; the original Agent keeps running in tmux', codexErrorInfo: null, additionalDetails: null },
    items: [{ id: 'detached-user', type: 'userMessage', clientId: 'original-client',
      content: [{ type: 'text', text: 'Continue\n' }] },
    { id: 'detached-preview', type: 'agentMessage', text: 'A wrapped\nterminal preview', phase: 'final_answer' }] };
  native.thread.turns.push(failed);
  native.livePreviewIds = { [failed.id]: 'detached-preview' };
  return { native, incoming, failed, source: incoming.turns[1] };
}

test('a detached unbound preview is displayed before its later independent canonical source without claiming it', () => {
  const { native, incoming, failed, source } = detachedPreviewFixture();
  const original = JSON.stringify(native);
  const result = reconcileHistory(native, incoming);
  assert.equal(result.changed, true);
  assert.equal(result.orderChanged, true);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id), [incoming.turns[0].id, failed.id, source.id, incoming.turns[2].id]);
  assert.deepEqual(result.record.thread.turns.find(turn => turn.id === failed.id), failed);
  assert.deepEqual(result.record.historySync, native.historySync);
  assert.equal(result.record.tmuxObserverTurns, undefined);
  assert.deepEqual(result.turnsChanged, [], 'a display reorder does not invent changed turn/item payloads');
  assert.equal(JSON.stringify(native), original, 'reconciliation remains pure');
  const repeated = reconcileHistory(JSON.parse(JSON.stringify(result.record)), incoming);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.orderChanged, false);
});

test('newly imported canonical replies are placed after an existing detached preview on the first merge', () => {
  const { native, incoming, failed } = detachedPreviewFixture();
  native.thread.turns = [native.thread.turns[0], failed];
  const result = reconcileHistory(native, incoming);
  assert.equal(result.orderChanged, true);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id), [incoming.turns[0].id, failed.id, incoming.turns[1].id, incoming.turns[2].id]);
  assert.deepEqual(result.record.thread.turns.find(turn => turn.id === failed.id), failed);
  assert.equal(Object.values(result.record.historySync.sourceTurns).includes(failed.id), false);
  assert.equal(Object.values(result.record.historySync.sourceItems).includes(failed.items[0].id), false);
});

test('detached preview ordering rejects uncertain time, completion, identity and native provenance', () => {
  const mutators = [
    ({ failed, source }) => { failed.startedAt = source.sourceTimestampMinute / 1000; },
    ({ failed, source }) => { failed.startedAt = source.sourceTimestampMinute / 1000 + 30; },
    ({ failed }) => { delete failed.startedAt; },
    ({ source }) => { delete source.sourceTimestampMinute; },
    ({ source }) => { source.sourceTimestampMinute++; },
    ({ incoming, source }) => { incoming.completedTurnIds = incoming.completedTurnIds.filter(id => id !== source.id); },
    ({ incoming, source }) => { incoming.turns.push(structuredClone(source)); },
    ({ source }) => { source.sourceIdentity.strength = 'ambiguous'; },
    ({ native, failed }) => { native.tmuxObserverTurns = { [failed.id]: { version: 2 } }; },
    ({ native, failed }) => { native.historySync.sourceTurns.other = failed.id; },
    ({ native, failed }) => { native.historySync.sourceItems.other = failed.items[0].id; },
    ({ failed }) => { failed.error.message = 'Another failure'; },
    ({ failed }) => { failed.items[0].clientId = null; },
    ({ failed }) => { failed.unsubmittedDraft = { retained: true }; },
    ({ failed }) => { delete failed.items[0].id; },
    ({ native, failed }) => { native.livePreviewIds[failed.id] = 'somebody-elses-item'; },
    ({ native, failed }) => { native.liveSourcePreviews = { [failed.id]: true }; },
    ({ native }) => { native.thread.cwd = '/another-project'; },
  ];
  for (const mutate of mutators) {
    const fixture = detachedPreviewFixture(); mutate(fixture);
    const result = reconcileHistory(fixture.native, fixture.incoming);
    assert.equal(result.orderChanged, false, mutate.toString());
    assert.equal(result.record.thread.turns.at(-1).id, fixture.failed.id, mutate.toString());
  }
});

test('a source mapping cannot authorize moving a preview before a noncanonical native card', () => {
  const { native, incoming, failed, source } = detachedPreviewFixture();
  const card = native.thread.turns.find(turn => turn.id === source.id);
  card.id = 'another-native'; card.rootTurnId = card.id;
  card.items[0].clientId = 'another-client';
  native.historySync.sourceTurns[source.id] = card.id;
  const result = reconcileHistory(native, incoming);
  assert.equal(result.orderChanged, false);
  assert.equal(result.record.thread.turns.at(-1).id, failed.id);
});

test('strict canonical clones support display ordering while leaving all source mappings intact', () => {
  const { native, incoming, failed, source } = detachedPreviewFixture();
  const card = native.thread.turns.find(turn => turn.id === source.id);
  card.id = 'canonical-clone'; card.rootTurnId = card.id;
  native.historySync.sourceTurns[source.id] = card.id;
  for (const item of card.items) {
    const sourceId = item.id;
    item.id += ':clone'; native.historySync.sourceItems[sourceId] = item.id;
  }
  const maps = JSON.stringify(native.historySync);
  const result = reconcileHistory(native, incoming);
  assert.equal(result.orderChanged, true);
  assert.deepEqual(result.record.thread.turns.map(turn => turn.id), [incoming.turns[0].id, failed.id, card.id, incoming.turns[2].id]);
  assert.equal(JSON.stringify(result.record.historySync), maps);
});

test('every history reconciliation result includes a boolean ordering flag', () => {
  assert.equal(reconcileHistory(record(source), source).orderChanged, false);
  assert.equal(reconcileHistory({ backend: 'acp' }, source).orderChanged, false);
});

test('retired submission receipts cannot be reclaimed by mapped, direct or content fallback matches', () => {
  const envelope = '<timestamp>Monday, Oct 19, 2026, 11:01 AM (UTC)</timestamp>\n<user_query>Repeated request</user_query>';
  for (const family of ['retiredObserverTurns', 'retiredUnboundTurns']) for (const mode of ['mapped', 'direct', 'fallback', 'ambiguous']) {
    const incoming = history([['user', envelope], ['assistant', 'The same complete answer']]);
    incoming.sourceComplete = true;
    incoming.completedTurnIds = incoming.turns.map(turn => turn.id);
    const source = incoming.turns[0];
    const retired = structuredClone(source);
    retired.id = mode === 'direct' ? source.id : 'retired-native-turn';
    retired.rootTurnId = retired.id; retired.status = 'interrupted';
    retired.items[0].clientId = 'original-submission';
    retired.items[0].id = 'retired-native-user';
    retired.items[1].id = 'retired-native-preview';
    const native = record(incoming);
    native.thread.turns = [retired];
    native[family] = { [retired.id]: { version: 2, clientId: 'original-submission' } };
    native.historySync = { sourceTurns: mode === 'mapped' ? { [source.id]: retired.id } : {}, sourceItems: {} };
    if (mode === 'ambiguous') {
      source.sourceIdentity.strength = 'ambiguous';
      source.id = `${incoming.id}:turn:ambiguous:${source.sourceIdentity.sha256}:display:0`;
      incoming.completedTurnIds = [source.id];
      native.historySync.sourceTurns[`${incoming.id}:turn:envelope:${source.sourceIdentity.sha256}`] = retired.id;
    }
    const result = reconcileHistory(native, incoming);
    const cardId = result.record.historySync.sourceTurns[source.id];
    // Ambiguous entries are display-only and do not gain source ownership.
    const card = mode === 'ambiguous' ? result.record.thread.turns.find(turn => turn.id !== retired.id)
      : result.record.thread.turns.find(turn => turn.id === cardId);
    assert.ok(card, mode);
    assert.notEqual(card.id, retired.id, mode);
    assert.equal(card.status, 'completed');
    assert.deepEqual(result.record.thread.turns.find(turn => turn.id === retired.id), retired, mode);
    assert.equal(reconcileHistory(JSON.parse(JSON.stringify(result.record)), incoming).changed, false, mode);
  }
});

test('a valid retained v3 projection receipt cannot reclaim a retired unbound preview', () => {
  const f = projectedFixture(true);
  f.native.retiredUnboundTurns = { [f.turn.id]: { version: 1 } };
  const original = structuredClone(f.turn);
  const result = reconcileHistory(f.native, f.incoming);
  assert.notEqual(result.record.historySync.sourceTurns[f.incoming.turns[0].id], f.turn.id);
  assert.deepEqual(result.record.thread.turns.find(turn => turn.id === f.turn.id), original);
});
