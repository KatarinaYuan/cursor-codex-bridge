import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const invalid = message => Object.assign(new Error(message), { code: -32602 });
const params = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Queue parameters must be an object');
  return value;
};
const validId = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be a nonempty string`);
  return value;
};
const validInput = input => {
  // Preserve native input blocks intact. The backend validates whether it can
  // execute them before the caller consumes a queued submission.
  if (!Array.isArray(input) || !input.length) throw invalid('input must be a nonempty array');
};
const copy = value => {
  try { return structuredClone(value); } catch { throw invalid('Queued submission must be cloneable data'); }
};
const entries = record => {
  if (record.queuedSubmissions === undefined) return [];
  if (!Array.isArray(record.queuedSubmissions)) throw invalid('Stored queue must be an array');
  return record.queuedSubmissions;
};

/** Read a page without initializing or otherwise changing the stored queue. */
export function queueList(record, options = {}) {
  const { cursor = null, limit = null } = params(options);
  if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 0xffff_ffff)) throw invalid('limit must be an unsigned 32-bit integer');
  let offset = 0;
  if (cursor !== null) {
    if (typeof cursor !== 'string' || !/^queue:\d+$/.test(cursor)) throw invalid('Invalid queue cursor');
    offset = Number(cursor.slice(6));
    if (!Number.isSafeInteger(offset)) throw invalid('Invalid queue cursor');
  }
  const data = entries(record);
  const pageSize = limit || 50;
  const end = Math.min(offset + pageSize, data.length);
  return { data: copy(data.slice(offset, end)), nextCursor: end < data.length ? `queue:${end}` : null };
}

export function queueAdd(record, options = {}) {
  const { clientUserMessageId, input } = params(options);
  validId(clientUserMessageId, 'clientUserMessageId');
  validInput(input);
  const data = entries(record);
  const existing = data.find(entry => entry.clientUserMessageId === clientUserMessageId);
  if (existing) {
    if (!isDeepStrictEqual(existing.input, input)) throw invalid('clientUserMessageId already refers to different input');
    return { queuedSubmission: copy(existing) };
  }
  const entry = { id: randomUUID(), clientUserMessageId, input: copy(input) };
  record.queuedSubmissions = [...data, entry];
  return { queuedSubmission: copy(entry) };
}

export function queueUpdate(record, options = {}) {
  const { queuedSubmissionId, input } = params(options);
  validId(queuedSubmissionId, 'queuedSubmissionId');
  validInput(input);
  const data = entries(record);
  const index = data.findIndex(entry => entry.id === queuedSubmissionId);
  if (index < 0) throw invalid('Unknown queuedSubmissionId');
  const entry = { ...data[index], input: copy(input) };
  record.queuedSubmissions = data.map((item, at) => at === index ? entry : item);
  return { queuedSubmission: copy(entry) };
}

export function queueDelete(record, options = {}) {
  const { queuedSubmissionId } = params(options);
  validId(queuedSubmissionId, 'queuedSubmissionId');
  const data = entries(record);
  const index = data.findIndex(entry => entry.id === queuedSubmissionId);
  if (index < 0) return { deleted: false };
  record.queuedSubmissions = data.filter((_, at) => at !== index);
  return { deleted: true };
}

export function queueReorder(record, options = {}) {
  const { queuedSubmissionIds } = params(options);
  const data = entries(record);
  if (!Array.isArray(queuedSubmissionIds) || queuedSubmissionIds.length !== data.length) throw invalid('queuedSubmissionIds must contain the complete queue');
  queuedSubmissionIds.forEach(id => validId(id, 'queuedSubmissionIds item'));
  const byId = new Map(data.map(entry => [entry.id, entry]));
  if (new Set(queuedSubmissionIds).size !== data.length || queuedSubmissionIds.some(id => !byId.has(id))) {
    throw invalid('queuedSubmissionIds must contain each queued ID exactly once');
  }
  record.queuedSubmissions = queuedSubmissionIds.map(id => byId.get(id));
  return {};
}

/** Inspect a selected entry, or the head, without consuming it. */
export function queuePeek(record, id = null) {
  if (id !== null) validId(id, 'queuedSubmissionId');
  const data = entries(record);
  const entry = id === null ? data[0] : data.find(item => item.id === id);
  if (!entry) {
    if (id !== null) throw invalid('Unknown queuedSubmissionId');
    return null;
  }
  validId(entry.id, 'Stored queuedSubmissionId');
  validId(entry.clientUserMessageId, 'Stored clientUserMessageId');
  validInput(entry.input);
  return copy(entry);
}

/** Call only after the backend has accepted a previously inspected submission. */
export function queueConsume(record, id = null) {
  const entry = queuePeek(record, id);
  if (!entry) return null;
  record.queuedSubmissions = entries(record).filter(item => item.id !== entry.id);
  return entry;
}

export const queueRemove = queueConsume;
