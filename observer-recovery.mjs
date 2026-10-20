import { observerTurnProof } from './live-history.mjs';
import { SOURCE_IDENTITY_SCHEME, unwrapUserEnvelope } from './source-identity.mjs';
import { reconcileHistory } from './sync.mjs';

export const OBSERVER_IDENTITY_LOSS_ERROR = 'Cursor observer source ownership was lost because its timestamped user envelope became ambiguous; completed transcript entries are shown separately and no input was resent';

const nonempty = value => typeof value === 'string' && value.length > 0;
const terminal = new Set(['completed', 'failed', 'interrupted']);
const second = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

function exactUserText(turn) {
  const users = turn?.items?.filter(item => item?.type === 'userMessage');
  if (users?.length !== 1 || users[0].clientId != null || !Array.isArray(users[0].content)
    || !users[0].content.length || users[0].content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return null;
  return unwrapUserEnvelope(users[0].content.map(block => block.text).join('\n')).replace(/\r\n/gu, '\n').trim();
}

/**
 * End only a read-only preview whose formerly unique envelope now repeats.
 * The caller supplies a freshly verified, idle capture of the original process
 * and commits this plan under its thread lock. Ambiguous entries are imported
 * for display; none acquires the retired observer's source ownership.
 */
export function planObserverRetirement(record, { history, binding, screen } = {}) {
  if (record?.backend !== 'legacy' || !Array.isArray(record.thread?.turns)
    || screen?.inputAvailable !== true || screen.busy !== false
    || history?.sourceComplete !== true || history.sourceIdentityScheme !== SOURCE_IDENTITY_SCHEME
    || !Array.isArray(history.turns) || !history.turns.length || !Array.isArray(history.completedTurnIds)) return null;
  const active = record.thread.turns.filter(turn => turn?.status === 'inProgress');
  if (active.length !== 1) return null;
  const original = active[0];
  const proof = observerTurnProof(record, original.id);
  if (proof?.version !== 1 || original.unsubmittedDraft
    || !nonempty(record.thread.cwd) || history.cwd !== record.thread.cwd || binding?.cwd !== record.thread.cwd
    || history.id !== proof.sessionId || binding.sessionId !== proof.sessionId
    || binding.paneId !== proof.paneId || binding.agentPid !== proof.agentPid
    || binding.agentStartTime !== proof.agentStartTime) return null;
  const prefix = `${history.id}:turn:envelope:`;
  if (!proof.sourceTurnId.startsWith(prefix)) return null;
  const sha256 = proof.sourceTurnId.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) return null;
  const completed = new Set(history.completedTurnIds);
  const sourceIds = history.turns.map(turn => turn?.id);
  if (sourceIds.some(id => !nonempty(id)) || new Set(sourceIds).size !== sourceIds.length
    || history.turns.some(turn => !terminal.has(turn.status) || !completed.has(turn.id))
    || sourceIds.includes(proof.sourceTurnId)) return null;
  const group = history.turns.filter(turn => turn.sourceIdentity?.sha256 === sha256);
  const prompt = exactUserText(original);
  const ambiguousPrefix = `${history.id}:turn:ambiguous:${sha256}:display:`;
  if (!prompt || group.length < 2 || group.some(turn => {
    const identity = turn.sourceIdentity;
    return identity.version !== 1 || identity.kind !== 'timestamped-user-envelope' || identity.strength !== 'ambiguous'
      || !turn.id.startsWith(ambiguousPrefix) || !/^(?:0|[1-9]\d*)$/u.test(turn.id.slice(ambiguousPrefix.length))
      || !Array.isArray(turn.items) || turn.items.some(item => !item || !['userMessage', 'agentMessage'].includes(item.type))
      || exactUserText(turn) !== prompt;
  })) return null;
  const itemIds = original.items.map(item => item.id);
  if (itemIds.some(id => !nonempty(id)) || new Set(itemIds).size !== itemIds.length) return null;

  const next = structuredClone(record);
  const retired = next.thread.turns.find(turn => turn.id === original.id);
  retired.status = 'interrupted';
  retired.error = { message: OBSERVER_IDENTITY_LOSS_ERROR, codexErrorInfo: null, additionalDetails: null };
  retired.completedAt = Math.max(second(history.updatedAt), second(retired.startedAt)) || null;
  retired.durationMs = second(retired.startedAt) && retired.completedAt
    ? (retired.completedAt - retired.startedAt) * 1000 : null;
  delete next.tmuxObserverTurns[retired.id];
  for (const [sourceId, nativeId] of Object.entries(next.historySync.sourceTurns)) {
    if (nativeId === retired.id) delete next.historySync.sourceTurns[sourceId];
  }
  const retiredItems = new Set(itemIds);
  for (const [sourceId, nativeId] of Object.entries(next.historySync.sourceItems || {})) {
    if (retiredItems.has(nativeId) || sourceId.startsWith(`${proof.sourceTurnId}:`)) delete next.historySync.sourceItems[sourceId];
  }

  // Exclude the preview during display reconciliation so even an identical
  // final answer cannot silently turn it into one of the ambiguous entries.
  next.thread.turns = next.thread.turns.filter(turn => turn.id !== retired.id);
  const merged = reconcileHistory(next, history);
  const turns = merged.record.thread.turns;
  if (turns.some(turn => turn.id === retired.id || turn.items?.some(item => retiredItems.has(item.id)))) return null;
  const firstCard = turns.find(turn => turn.id === merged.record.historySync.sourceTurns[group[0].id]);
  if (!firstCard) return null;
  turns.splice(turns.indexOf(firstCard), 0, retired);
  return { record: merged.record, turnsChanged: [{ before: structuredClone(original), after: structuredClone(retired) }, ...merged.turnsChanged], retiredTurnId: retired.id };
}
