import { isDeepStrictEqual } from 'node:util';
import { nativeTurnTextSha256, stableSourceTurn } from './live-history.mjs';
import { SOURCE_IDENTITY_SCHEME } from './source-identity.mjs';
import { reconcileHistory } from './sync.mjs';
import { DETACHED_OBSERVER_ERROR } from './export-recovery.mjs';

export const SUPERSEDED_UNBOUND_ERROR = 'The old native display had no verified source ownership and Cursor has advanced beyond it; completed source messages are shown separately and no message was resent';

const own = (object, key) => Object.hasOwn(object || {}, key);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const terminal = new Set(['completed', 'failed', 'interrupted']);
const minute = value => Number.isSafeInteger(value) && value > 0 && value % 60_000 === 0;
const plainMap = value => value && typeof value === 'object' && !Array.isArray(value);
const display = text => text.replace(/\s/gu, '');

function soleText(turn) {
  const users = turn?.items?.filter(item => item?.type === 'userMessage');
  if (users?.length !== 1 || !nonempty(users[0].id) || !Array.isArray(users[0].content)
    || !users[0].content.length || users[0].content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return null;
  const text = users[0].content.map(block => block.text).join('\n');
  return nonempty(text) ? { user: users[0], text } : null;
}

function canonicalSource(turn) {
  return Array.isArray(turn?.items) && turn.items.every(item => item && nonempty(item.id)
    && (item.type === 'userMessage' || item.type === 'agentMessage' && typeof item.text === 'string'))
    && soleText(turn)?.user.clientId == null && Boolean(soleText(turn));
}

function stableUnique(turn, history) {
  return stableSourceTurn(turn, history) && minute(turn.sourceTimestampMinute)
    && history.turns.filter(other => other.id === turn.id || other.sourceIdentity?.sha256 === turn.sourceIdentity.sha256).length === 1;
}

function canonicalCounterpart(record, source, complete) {
  if (source.status !== 'completed' || !complete.has(source.id)) return null;
  const sync = record.historySync;
  const nativeId = sync.sourceTurns[source.id];
  const native = record.thread.turns.find(turn => turn.id === nativeId);
  if (!native || native.status !== 'completed' || native.items?.length !== source.items.length
    || !isDeepStrictEqual(native.sourceIdentity, source.sourceIdentity)
    || native.sourceTimestampMinute !== source.sourceTimestampMinute
    || !source.items.some(item => item.type === 'agentMessage' && nonempty(item.text))
    || Object.entries(sync.sourceTurns).some(([id, mapped]) => id !== source.id && mapped === nativeId)) return null;
  for (let index = 0; index < source.items.length; index++) {
    const item = source.items[index], counterpart = native.items[index];
    if (!counterpart || !own(sync.sourceItems, item.id) || sync.sourceItems[item.id] !== counterpart.id
      || Object.entries(sync.sourceItems).some(([id, mapped]) => id !== item.id && mapped === counterpart.id)) return null;
    const { id: sourceId, ...sourceBody } = item;
    const { id: nativeItemId, ...nativeBody } = counterpart;
    if (!isDeepStrictEqual(sourceBody, nativeBody)) return null;
  }
  return native;
}

/**
 * Source chronology can supersede an unowned display. It cannot establish that
 * the native input was submitted, nor attribute a differently worded source.
 */
export function supersededUnboundCandidate(record, history) {
  const affinity = record?.tmuxAffinity;
  if (record?.backend !== 'legacy' || !Array.isArray(record.thread?.turns)
    || !nonempty(record.thread.cwd) || !nonempty(record.thread.model)
    || !/^%\d+$/u.test(affinity?.paneId || '') || !Number.isSafeInteger(affinity?.agentPid) || affinity.agentPid <= 0
    || typeof affinity?.agentStartTime !== 'string' || !/^\d+$/u.test(affinity.agentStartTime)
    || history?.id !== record.cursorSessionId || history.cwd !== record.thread.cwd
    || history.sourceIdentityScheme !== SOURCE_IDENTITY_SCHEME || typeof history.sourceComplete !== 'boolean'
    || !Array.isArray(history.turns) || !Array.isArray(history.completedTurnIds)
    || !plainMap(record.historySync?.sourceTurns) || !plainMap(record.historySync?.sourceItems)
    || record.tmuxObserverTurns !== undefined && (!plainMap(record.tmuxObserverTurns) || Object.keys(record.tmuxObserverTurns).length)
    || record.exportedSubmissionTurns !== undefined && !plainMap(record.exportedSubmissionTurns)
    || ['queue', 'queuedSubmissions'].some(key => record[key] !== undefined && (!Array.isArray(record[key]) || record[key].length))) return null;
  const turns = record.thread.turns;
  const sourceIds = history.turns.map(turn => turn?.id);
  const nativeIds = turns.map(turn => turn?.id);
  const sourceItems = history.turns.flatMap(turn => turn?.items || []).map(item => item?.id);
  const nativeItems = turns.flatMap(turn => turn?.items || []).map(item => item?.id);
  if ([sourceIds, nativeIds, sourceItems, nativeItems].some(ids => ids.some(id => !nonempty(id)) || new Set(ids).size !== ids.length)
    || new Set(history.completedTurnIds).size !== history.completedTurnIds.length
    || history.completedTurnIds.some(id => !sourceIds.includes(id))
    || history.turns.some(turn => !canonicalSource(turn))
    || turns.filter(turn => turn.status === 'inProgress').length > 1) return null;
  const complete = new Set(history.completedTurnIds);
  const boundary = history.turns.at(-1);
  if (!stableUnique(boundary, history)) return null;
  const unfinished = history.sourceComplete === false && !complete.has(boundary.id);
  const prefix = unfinished ? history.turns.slice(0, -1) : history.turns;
  if (!prefix.length || prefix.some(turn => !terminal.has(turn.status) || !complete.has(turn.id))
    || unfinished && !['completed', 'inProgress'].includes(boundary.status)) return null;
  const eligible = turns.filter(turn => {
    const input = soleText(turn);
    const preview = turn.items?.find(item => item.id === record.livePreviewIds?.[turn.id]);
    return input && nonempty(input.user.clientId) && Number.isSafeInteger(turn.startedAt) && turn.startedAt > 0
      && !own(record.retiredUnboundTurns, turn.id) && !own(record.retiredObserverTurns, turn.id)
      && !own(record.exportedSubmissionTurns, turn.id) && turn.unsubmittedDraft == null
      && ['inProgress', 'interrupted', 'failed'].includes(turn.status)
      && (turn.status !== 'failed' || turn.error?.message === DETACHED_OBSERVER_ERROR)
      && (turn.status !== 'interrupted' || turn.error == null)
      && turn.items.every(item => item.type === 'userMessage' || item.type === 'agentMessage' && typeof item.text === 'string')
      && preview?.type === 'agentMessage' && record.liveSourcePreviews?.[turn.id] !== true
      && !Object.values(record.historySync.sourceTurns).includes(turn.id)
      && !Object.values(record.historySync.sourceItems).some(id => turn.items.some(item => item.id === id))
      && !turns.some(other => other !== turn && (other.status === 'inProgress'
        || other.items?.some(item => item.type === 'userMessage' && item.clientId === input.user.clientId)));
  });
  if (eligible.length !== 1 || eligible[0] !== turns.at(-1)) return null;
  const turn = eligible[0];
  const inputMinute = Math.floor(turn.startedAt / 60) * 60_000;
  const anchors = history.turns.filter(source => {
    if (!stableUnique(source, history) || source.sourceTimestampMinute >= turn.startedAt * 1000) return false;
    const counterpart = canonicalCounterpart(record, source, complete);
    return counterpart && turns.indexOf(counterpart) < turns.indexOf(turn)
      && (counterpart.completedAt == null ? source.sourceTimestampMinute < inputMinute
        : Number.isSafeInteger(counterpart.completedAt) && counterpart.completedAt > 0 && counterpart.completedAt <= turn.startedAt);
  });
  const anchor = anchors.at(-1);
  if (!anchor) return null;
  const firstAdvanced = history.turns[history.turns.indexOf(anchor) + 1];
  if (!stableUnique(firstAdvanced, history) || firstAdvanced.status !== 'completed' || !complete.has(firstAdvanced.id)
    || firstAdvanced.sourceTimestampMinute < inputMinute || firstAdvanced.sourceTimestampMinute > inputMinute + 120_000
    || firstAdvanced === boundary || boundary.sourceTimestampMinute <= firstAdvanced.sourceTimestampMinute
    || history.turns.slice(history.turns.indexOf(anchor)).some((source, index, later) => !minute(source.sourceTimestampMinute)
      || index > 0 && source.sourceTimestampMinute < later[index - 1].sourceTimestampMinute)) return null;
  return { turn, anchor, firstAdvanced, boundary, prefix, unfinished, user: soleText(turn).user };
}

/** Pure display-only plan; the caller separately fences the original observer. */
export function planSupersededUnboundRetirement(record, { history, binding, screen } = {}) {
  const candidate = supersededUnboundCandidate(record, history);
  const affinity = record?.tmuxAffinity;
  if (!candidate || !affinity || !/^%\d+$/u.test(binding?.paneId || '')
    || !Number.isSafeInteger(binding?.agentPid) || binding.agentPid <= 0
    || typeof binding?.agentStartTime !== 'string' || !/^\d+$/u.test(binding.agentStartTime)
    || binding.sessionId !== record.cursorSessionId || binding.cwd !== record.thread.cwd
    || binding.paneId !== affinity.paneId || binding.agentPid !== affinity.agentPid
    || binding.agentStartTime !== affinity.agentStartTime) return null;
  const prompt = Array.isArray(screen?.userMessages) ? screen.userMessages.at(-1) : null;
  const latest = soleText(candidate.boundary);
  const busy = screen?.busy === true && screen.reason === 'agent-busy' && ['C-c', 'Escape'].includes(screen.stopKey);
  const question = screen?.waitingForQuestion === true && screen.busy === false && screen.stopKey === null
    && screen.reason === 'question-awaiting-answer';
  const idle = history.sourceComplete === true && screen?.inputAvailable === true && screen.busy === false
    && ['ready', 'input-has-draft'].includes(screen.reason);
  if (!latest || typeof prompt !== 'string' || display(prompt) !== display(latest.text)
    || !idle && !(screen?.ready === false && screen.inputAvailable === false && (busy || question))) return null;
  const next = structuredClone(record);
  const before = structuredClone(candidate.turn);
  const retired = next.thread.turns.find(turn => turn.id === before.id);
  retired.status = 'interrupted';
  retired.error = { message: SUPERSEDED_UNBOUND_ERROR, codexErrorInfo: null, additionalDetails: null };
  retired.completedAt = Math.max(before.startedAt, Number.isSafeInteger(history.updatedAt) ? history.updatedAt : before.startedAt);
  retired.durationMs = (retired.completedAt - before.startedAt) * 1000;
  next.retiredUnboundTurns = { ...next.retiredUnboundTurns, [retired.id]: {
    version: 2, reason: 'cursor-source-advanced', clientId: candidate.user.clientId,
    sessionId: record.cursorSessionId, model: record.thread.model, nativeUserTextSha256: nativeTurnTextSha256(retired),
    anchorTurnId: candidate.anchor.id, firstAdvancedTurnId: candidate.firstAdvanced.id, successorTurnId: candidate.boundary.id,
    paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime,
  } };
  next.thread.turns = next.thread.turns.filter(turn => turn.id !== retired.id);
  const merged = reconcileHistory(next, { ...history, turns: candidate.prefix });
  const firstCard = merged.record.thread.turns.find(turn => turn.id === merged.record.historySync.sourceTurns[candidate.firstAdvanced.id]);
  if (!firstCard || merged.record.thread.turns.some(turn => turn.id === retired.id
    || turn.items?.some(item => retired.items.some(original => original.id === item.id)))) return null;
  merged.record.thread.turns.splice(merged.record.thread.turns.indexOf(firstCard), 0, retired);
  return { record: merged.record, retiredTurnId: retired.id,
    turnsChanged: [{ before, after: structuredClone(retired) }, ...merged.turnsChanged] };
}
