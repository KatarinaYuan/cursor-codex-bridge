import test from 'node:test';
import assert from 'node:assert/strict';
import { queueList, queueAdd, queueUpdate, queueDelete, queueReorder, queuePeek, queueConsume, queueRemove } from './queue.mjs';

const input = text => [{ type: 'text', text, text_elements: [] }];
const add = (record, clientId, text) => queueAdd(record, { clientUserMessageId: clientId, input: input(text) }).queuedSubmission;
const invalid = action => assert.throws(action, error => error.code === -32602);

test('an absent queue lists and peeks empty without mutating the record', () => {
  const record = { thread: { id: 'thread' } };
  const before = structuredClone(record);
  assert.deepEqual(queueList(record), { data: [], nextCursor: null });
  assert.equal(queuePeek(record), null);
  assert.equal(queueConsume(record), null);
  assert.deepEqual(record, before);
});

test('stores complete native input data and returns independent snapshots', () => {
  const record = {};
  const blocks = [
    { type: 'text', text: 'Look here', text_elements: [{ byteRange: { start: 0, end: 4 }, placeholder: 'file' }] },
    { type: 'image', fileId: 'uploaded-image', detail: 'original' },
    { type: 'mention', name: 'Source', path: '/workspace/source' },
    { type: 'futureNativeBlock', preserved: { nested: [1, 2] } },
  ];
  const result = queueAdd(record, { clientUserMessageId: 'client-1', input: blocks });
  assert.match(result.queuedSubmission.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.queuedSubmission.input, blocks);
  blocks[0].text = 'caller changed';
  result.queuedSubmission.input[1].detail = 'low';
  const page = queueList(record);
  page.data[0].input[2].path = '/changed';
  assert.equal(record.queuedSubmissions[0].input[0].text, 'Look here');
  assert.equal(record.queuedSubmissions[0].input[1].detail, 'original');
  assert.equal(record.queuedSubmissions[0].input[2].path, '/workspace/source');
});

test('add retries are idempotent by client message ID and conflicting retries leave the queue intact', () => {
  const record = {};
  const first = add(record, 'client-1', 'First');
  const snapshot = structuredClone(record);
  assert.deepEqual(add(record, 'client-1', 'First'), first);
  invalid(() => add(record, 'client-1', 'Different'));
  assert.deepEqual(record, snapshot);
  assert.equal(record.queuedSubmissions.length, 1);
});

test('invalid add and update requests do not initialize, append, replace, or remove queue data', () => {
  const empty = {};
  for (const params of [null, {}, { clientUserMessageId: '', input: input('Hi') }, { clientUserMessageId: 3, input: input('Hi') },
    { clientUserMessageId: 'a', input: [] }, { clientUserMessageId: 'a', input: 'Hi' }]) {
    invalid(() => queueAdd(empty, params));
    assert.deepEqual(empty, {});
  }
  const record = {};
  const entry = add(record, 'client-1', 'Keep me');
  const before = structuredClone(record);
  for (const params of [{ queuedSubmissionId: entry.id, input: [] }, { queuedSubmissionId: entry.id, input: null },
    { queuedSubmissionId: 'missing', input: input('New') }, { queuedSubmissionId: '', input: input('New') }]) {
    invalid(() => queueUpdate(record, params));
    assert.deepEqual(record, before);
  }
});

test('updates preserve submission identity and position across JSON persistence', () => {
  let record = {};
  const first = add(record, 'client-1', 'First');
  const second = add(record, 'client-2', 'Second');
  record = JSON.parse(JSON.stringify(record));
  const result = queueUpdate(record, { queuedSubmissionId: first.id, input: input('Revised first') });
  assert.deepEqual(result.queuedSubmission, { ...first, input: input('Revised first') });
  assert.deepEqual(record.queuedSubmissions.map(item => item.id), [first.id, second.id]);
  result.queuedSubmission.input[0].text = 'Result changed';
  assert.equal(queuePeek(record, first.id).input[0].text, 'Revised first');
});

test('pagination traverses the complete queue and validates opaque cursors and unsigned limits', () => {
  const record = {};
  const ids = ['1', '2', '3', '4', '5'].map(id => add(record, `client-${id}`, id).id);
  const first = queueList(record, { limit: 2 });
  const second = queueList(record, { limit: 2, cursor: first.nextCursor });
  const third = queueList(record, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual([...first.data, ...second.data, ...third.data].map(item => item.id), ids);
  assert.equal(third.nextCursor, null);
  assert.equal(queueList(record, { limit: 0 }).data.length, 5);
  assert.deepEqual(queueList(record, { cursor: 'queue:100' }), { data: [], nextCursor: null });
  const before = structuredClone(record);
  for (const params of [{ cursor: 'garbage' }, { cursor: 1 }, { cursor: 'queue:-1' }, { cursor: 'queue:999999999999999999999' },
    { limit: -1 }, { limit: 1.5 }, { limit: '2' }, { limit: 0x1_0000_0000 }]) invalid(() => queueList(record, params));
  assert.deepEqual(record, before);
});

test('reorder requires every queued ID exactly once and rejects invalid changes atomically', () => {
  const record = {};
  const ids = ['1', '2', '3'].map(id => add(record, `client-${id}`, id).id);
  const before = structuredClone(record);
  for (const queuedSubmissionIds of [null, ids.slice(1), [ids[0], ids[0], ids[2]], [ids[0], ids[1], 'unknown'], [ids[0], ids[1], 3]]) {
    invalid(() => queueReorder(record, { queuedSubmissionIds }));
    assert.deepEqual(record, before);
  }
  assert.deepEqual(queueReorder(record, { queuedSubmissionIds: [...ids].reverse() }), {});
  assert.deepEqual(queueList(record).data.map(item => item.id), [...ids].reverse());
});

test('peek does not consume, explicit consumption removes only the accepted selected entry, and delete reports presence', () => {
  const record = {};
  const first = add(record, 'client-1', 'First');
  const second = add(record, 'client-2', 'Second');
  const third = add(record, 'client-3', 'Third');
  assert.deepEqual(queuePeek(record), first);
  assert.deepEqual(queuePeek(record, second.id), second);
  assert.equal(record.queuedSubmissions.length, 3, 'backend validation can fail after peek without losing queued data');
  const before = structuredClone(record);
  invalid(() => queueConsume(record, 'unknown'));
  invalid(() => queuePeek(record, ''));
  assert.deepEqual(record, before);
  assert.deepEqual(queueConsume(record, second.id), second);
  assert.deepEqual(queueRemove(record), first);
  assert.deepEqual(queueDelete(record, { queuedSubmissionId: third.id }), { deleted: true });
  assert.deepEqual(queueDelete(record, { queuedSubmissionId: third.id }), { deleted: false });
  assert.deepEqual(queueList(record), { data: [], nextCursor: null });
});

test('invalid persisted submissions are never consumed', () => {
  for (const entry of [
    { id: 'queued', clientUserMessageId: 'client', input: [] },
    { id: 'queued', clientUserMessageId: '', input: input('Hi') },
  ]) {
    const record = { queuedSubmissions: [entry] };
    const before = structuredClone(record);
    invalid(() => queueConsume(record));
    assert.deepEqual(record, before);
  }
});

test('malformed RPC parameter objects consistently report invalid params without changing data', () => {
  const record = {};
  add(record, 'client-1', 'Preserve');
  const before = structuredClone(record);
  for (const operation of [queueList, queueAdd, queueUpdate, queueDelete, queueReorder]) {
    for (const malformed of [null, 4, 'bad', []]) invalid(() => operation(record, malformed));
  }
  assert.deepEqual(record, before);
});
