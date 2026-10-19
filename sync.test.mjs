import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from './history.mjs';
import { reconcileHistory } from './sync.mjs';

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
