import { createHash } from 'node:crypto';
import { cursorExportUserText, SOURCE_IDENTITY_SCHEME } from './source-identity.mjs';
import { stableSourceTurn, nativeTurnTextSha256 } from './live-history.mjs';
import { reconcileHistory } from './sync.mjs';

export const DETACHED_OBSERVER_ERROR = 'Cursor tmux observer detached; the original Agent keeps running in tmux';
export const EXPORT_RETIRED_ERROR = 'The old native preview could not be attributed because Cursor collapsed repeated blank lines in its transcript export; the completed source reply is shown separately and no message was resent';
const terminal = new Set(['completed', 'failed', 'interrupted']);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const sha = text => createHash('sha256').update(text).digest('hex');
const canonical = text => text.replace(/\r\n/gu, '\n').trim();
const minute = value => Number.isSafeInteger(value) && value > 0 && value % 60_000 === 0;
const display = text => text.replace(/\s/gu, '');

function soleText(turn) {
  const users = turn?.items?.filter(item => item?.type === 'userMessage');
  if (users?.length !== 1 || !nonempty(users[0].id) || !Array.isArray(users[0].content)
    || !users[0].content.length || users[0].content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return null;
  const text = users[0].content.map(block => block.text).join('\n');
  return nonempty(text) ? { user: users[0], text } : null;
}

/**
 * An old send without a source receipt cannot be retroactively owned by text.
 * This only identifies an obsolete DISPLAY to interrupt, alongside independent
 * completed source cards. It never creates an observer/submission source proof.
 */
export function unboundExportCandidate(record, history) {
  if (record?.backend !== 'legacy' || !Array.isArray(record.thread?.turns)
    || !nonempty(record.thread.cwd) || !nonempty(record.thread.model)
    || history?.id !== record.cursorSessionId || history.cwd !== record.thread.cwd
    || history.sourceIdentityScheme !== SOURCE_IDENTITY_SCHEME || typeof history.sourceComplete !== 'boolean'
    || !Array.isArray(history.turns) || !Array.isArray(history.completedTurnIds)
    || Object.keys(record.tmuxObserverTurns || {}).length
    || ['queue', 'queuedSubmissions'].some(key => record[key] !== undefined && (!Array.isArray(record[key]) || record[key].length))) return null;
  const sourceIds = history.turns.map(turn => turn?.id);
  const nativeIds = record.thread.turns.map(turn => turn?.id);
  const nativeItemIds = record.thread.turns.flatMap(turn => turn.items || []).map(item => item?.id);
  if (sourceIds.some(id => !nonempty(id)) || new Set(sourceIds).size !== sourceIds.length
    || history.completedTurnIds.some(id => !sourceIds.includes(id))
    || nativeIds.some(id => !nonempty(id)) || new Set(nativeIds).size !== nativeIds.length
    || nativeItemIds.some(id => !nonempty(id)) || new Set(nativeItemIds).size !== nativeItemIds.length) return null;
  const complete = new Set(history.completedTurnIds);
  const boundary = history.turns.at(-1);
  if (!stableSourceTurn(boundary, history) || !minute(boundary.sourceTimestampMinute)) return null;
  const unfinished = history.sourceComplete === false && !complete.has(boundary.id);
  const prefix = unfinished ? history.turns.slice(0, -1) : history.turns;
  if (!prefix.length || prefix.some(turn => !terminal.has(turn.status) || !complete.has(turn.id) || !soleText(turn))) return null;
  const eligible = [];
  for (const turn of record.thread.turns) {
    if (Object.hasOwn(record.retiredUnboundTurns || {}, turn.id) || Object.hasOwn(record.retiredObserverTurns || {}, turn.id)
      || turn.unsubmittedDraft || !['inProgress', 'interrupted', 'failed'].includes(turn.status)
      || turn.status === 'failed' && turn.error?.message !== DETACHED_OBSERVER_ERROR
      || turn.status === 'interrupted' && turn.error != null
      || !Number.isSafeInteger(turn.startedAt) || turn.startedAt <= 0
      || turn.items?.some(item => !['userMessage', 'agentMessage'].includes(item?.type))
      || Object.values(record.historySync?.sourceTurns || {}).includes(turn.id)
      || record.thread.turns.some(other => other !== turn && other.status === 'inProgress')) continue;
    const input = soleText(turn);
    if (!input || !nonempty(input.user.clientId)
      || record.thread.turns.some(other => other !== turn && other.items?.some(item => item.type === 'userMessage' && item.clientId === input.user.clientId))
      || Object.values(record.historySync?.sourceItems || {}).includes(input.user.id)) continue;
    const projected = cursorExportUserText(input.text);
    if (projected === canonical(input.text)) continue;
    const matches = history.turns.filter(source => {
      const user = soleText(source);
      return user && canonical(user.text) === projected;
    });
    if (matches.length !== 1) continue;
    const source = matches[0], inputMinute = Math.floor(turn.startedAt / 60) * 60_000;
    if (!stableSourceTurn(source, history) || !complete.has(source.id) || source.status !== 'completed'
      || !minute(source.sourceTimestampMinute) || source.sourceTimestampMinute < inputMinute
      || source.sourceTimestampMinute > inputMinute + 120_000
      || history.turns.indexOf(source) >= history.turns.length - 1
      || boundary.sourceTimestampMinute <= source.sourceTimestampMinute
      || history.turns.some(other => other !== source && other.sourceIdentity?.sha256 === source.sourceIdentity.sha256)) continue;
    eligible.push({ turn, source, prefix, boundary, unfinished, user: input.user });
  }
  return eligible.length === 1 ? eligible[0] : null;
}

export function planUnboundExportRetirement(record, { history, binding, screen } = {}) {
  const candidate = unboundExportCandidate(record, history);
  const affinity = record?.tmuxAffinity;
  if (!candidate || !affinity || !/^%\d+$/u.test(binding?.paneId || '')
    || !Number.isSafeInteger(binding?.agentPid) || binding.agentPid <= 0
    || typeof binding?.agentStartTime !== 'string' || !/^\d+$/u.test(binding.agentStartTime)
    || binding.sessionId !== record.cursorSessionId || binding.cwd !== record.thread.cwd
    || binding.paneId !== affinity?.paneId || binding.agentPid !== affinity.agentPid
    || binding.agentStartTime !== affinity.agentStartTime) return null;
  const latestUser = soleText(candidate.boundary);
  const prompt = screen?.userMessages?.at(-1);
  const showingLatest = latestUser && typeof prompt === 'string' && display(prompt) === display(latestUser.text);
  const busy = screen?.busy === true && screen.reason === 'agent-busy' && ['C-c', 'Escape'].includes(screen.stopKey);
  const question = screen?.waitingForQuestion === true && screen.busy === false && screen.stopKey === null;
  const idle = history.sourceComplete === true && screen?.inputAvailable === true && screen.busy === false;
  if (!showingLatest || !idle && !(screen?.ready === false && screen.inputAvailable === false && (busy || question))) return null;
  const next = structuredClone(record);
  const before = structuredClone(candidate.turn);
  const retired = next.thread.turns.find(turn => turn.id === before.id);
  retired.status = 'interrupted';
  retired.error = { message: EXPORT_RETIRED_ERROR, codexErrorInfo: null, additionalDetails: null };
  retired.completedAt = Math.max(before.startedAt, Number.isSafeInteger(history.updatedAt) ? history.updatedAt : before.startedAt);
  retired.durationMs = (retired.completedAt - before.startedAt) * 1000;
  next.retiredUnboundTurns = { ...next.retiredUnboundTurns, [retired.id]: {
    version: 1, reason: 'cursor-export-newlines', clientId: candidate.user.clientId,
    sessionId: record.cursorSessionId, model: record.thread.model,
    nativeUserTextSha256: nativeTurnTextSha256(retired),
    sourceCandidateId: candidate.source.id, sourceCandidateTextSha256: sha(canonical(soleText(candidate.source).text)),
    successorTurnId: candidate.boundary.id, paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime,
  } };
  next.thread.turns = next.thread.turns.filter(turn => turn.id !== retired.id);
  const merged = reconcileHistory(next, { ...history, turns: candidate.prefix });
  const sourceCard = merged.record.thread.turns.find(turn => turn.id === merged.record.historySync.sourceTurns[candidate.source.id]);
  if (!sourceCard) return null;
  merged.record.thread.turns.splice(merged.record.thread.turns.indexOf(sourceCard), 0, retired);
  return { record: merged.record, retiredTurnId: retired.id,
    turnsChanged: [{ before, after: structuredClone(retired) }, ...merged.turnsChanged] };
}
