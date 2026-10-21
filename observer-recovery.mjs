import { observerTurnProof, stableSourceTurn, submittedTurnTextSha256 } from './live-history.mjs';
import { cursorExportUserText, SOURCE_IDENTITY_SCHEME, unwrapUserEnvelope } from './source-identity.mjs';
import { reconcileHistory } from './sync.mjs';

export const OBSERVER_IDENTITY_LOSS_ERROR = 'Cursor observer source ownership was lost because its timestamped user envelope became ambiguous; completed transcript entries are shown separately and no input was resent';

const nonempty = value => typeof value === 'string' && value.length > 0;
const terminal = new Set(['completed', 'failed', 'interrupted']);
const second = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

function exactUserText(turn, native = false) {
  const users = turn?.items?.filter(item => item?.type === 'userMessage');
  if (users?.length !== 1 || (!native && users[0].clientId != null) || !Array.isArray(users[0].content)
    || !users[0].content.length || users[0].content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return null;
  return unwrapUserEnvelope(users[0].content.map(block => block.text).join('\n')).replace(/\r\n/gu, '\n').trim();
}

const minute = value => Number.isSafeInteger(value) && value > 0 && value % 60_000 === 0;
const displayText = text => text.replace(/\s/gu, '');

function canonicalItems(turn) {
  if (!Array.isArray(turn?.items) || turn.items.some(item => !item
    || !['userMessage', 'agentMessage'].includes(item.type) || !nonempty(item.id)
    || item.type === 'agentMessage' && typeof item.text !== 'string')) return false;
  return nonempty(exactUserText(turn));
}

/** Cheap pure gate before the caller verifies and captures the original pane. */
export function observerRetirementCandidate(record, history) {
  if (record?.backend !== 'legacy' || !Array.isArray(record.thread?.turns)
    || typeof history?.sourceComplete !== 'boolean' || history.sourceIdentityScheme !== SOURCE_IDENTITY_SCHEME
    || !Array.isArray(history.turns) || !history.turns.length || !Array.isArray(history.completedTurnIds)) return null;
  const active = record.thread.turns.filter(turn => turn?.status === 'inProgress');
  if (active.length !== 1) return null;
  const original = active[0];
  const proof = observerTurnProof(record, original.id);
  if (!proof || original.unsubmittedDraft || Object.hasOwn(record.retiredObserverTurns || {}, original.id)
    || !nonempty(record.thread.cwd) || history.cwd !== record.thread.cwd || history.id !== proof.sessionId) return null;
  const prefix = `${history.id}:turn:envelope:`;
  if (!proof.sourceTurnId.startsWith(prefix)) return null;
  const sha256 = proof.sourceTurnId.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) return null;
  const sourceIds = history.turns.map(turn => turn?.id);
  const completed = new Set(history.completedTurnIds);
  const sources = new Set(sourceIds);
  if (sourceIds.some(id => !nonempty(id)) || sources.size !== sourceIds.length
    || sourceIds.includes(proof.sourceTurnId)
    || history.completedTurnIds.some(id => !nonempty(id) || !sources.has(id))
    || completed.size !== history.completedTurnIds.length || history.turns.some(turn => !canonicalItems(turn))) return null;
  const sourceItemIds = history.turns.flatMap(turn => turn.items.map(item => item.id));
  if (new Set(sourceItemIds).size !== sourceItemIds.length) return null;
  const group = history.turns.filter(turn => turn.sourceIdentity?.sha256 === sha256);
  const submitted = proof.version === 2 || proof.version === 3;
  const nativePrompt = exactUserText(original, submitted);
  const prompt = proof.version === 3 && nativePrompt !== null ? cursorExportUserText(nativePrompt) : nativePrompt;
  const ambiguousPrefix = `${history.id}:turn:ambiguous:${sha256}:display:`;
  if (!prompt || group.length < 2 || group.some(turn => {
    const identity = turn.sourceIdentity;
    return identity.version !== 1 || identity.kind !== 'timestamped-user-envelope' || identity.strength !== 'ambiguous'
      || !turn.id.startsWith(ambiguousPrefix) || !/^(?:0|[1-9]\d*)$/u.test(turn.id.slice(ambiguousPrefix.length))
      || !terminal.has(turn.status) || !completed.has(turn.id) || exactUserText(turn) !== prompt
      || submitted && submittedTurnTextSha256(turn) !== proof.userTextSha256;
  })) return null;
  const itemIds = original.items.map(item => item.id);
  if (itemIds.some(id => !nonempty(id)) || new Set(itemIds).size !== itemIds.length) return null;
  if (submitted) {
    const nativeUser = original.items.find(item => item.type === 'userMessage');
    const sourceUserId = `${proof.sourceTurnId}:user`;
    const mapping = record.historySync?.sourceItems;
    if (!mapping || !Object.hasOwn(mapping, sourceUserId) || mapping[sourceUserId] !== nativeUser.id
      || Object.entries(mapping).some(([sourceId, nativeId]) => sourceId !== sourceUserId && nativeId === nativeUser.id)) return null;
  }

  const boundary = history.turns.at(-1);
  const groupMinute = group[0].sourceTimestampMinute;
  const advanced = stableSourceTurn(boundary, history)
    && history.turns.filter(turn => turn.sourceIdentity?.sha256 === boundary.sourceIdentity.sha256).length === 1
    && history.turns.indexOf(boundary) > Math.max(...group.map(turn => history.turns.indexOf(turn)))
    && minute(groupMinute) && group.every(turn => turn.sourceTimestampMinute === groupMinute)
    && minute(boundary.sourceTimestampMinute) && boundary.sourceTimestampMinute > groupMinute;
  // Version 1 retains its original globally complete + idle recovery. Native
  // sends and incomplete snapshots additionally need a strictly later boundary.
  if (!advanced && (proof.version !== 1 || history.sourceComplete !== true)) return null;
  const unfinishedTail = history.sourceComplete === false && !completed.has(boundary.id);
  if (unfinishedTail && !advanced) return null;
  const importTurns = unfinishedTail ? history.turns.slice(0, -1) : history.turns;
  if (importTurns.some(turn => !terminal.has(turn.status) || !completed.has(turn.id))
    || unfinishedTail && !terminal.has(boundary.status) && boundary.status !== 'inProgress') return null;
  return { turn: original, proof, group, importTurns, boundaryTurnId: advanced ? boundary.id : null, advanced };
}

function capturedSuccessor(screen, boundary) {
  const prompt = Array.isArray(screen?.userMessages) ? screen.userMessages.at(-1) : null;
  const busy = screen?.busy === true && screen.reason === 'agent-busy' && ['C-c', 'Escape'].includes(screen.stopKey);
  // The parser separately recognizes Cursor's exact clarifying-question box.
  // It grants observation only, while the ordinary input frame remains absent.
  const question = screen?.waitingForQuestion === true && screen.busy === false && screen.stopKey === null;
  return screen?.inputAvailable === false && screen.ready === false && (busy || question)
    && typeof prompt === 'string' && displayText(prompt) === displayText(exactUserText(boundary));
}

/**
 * Retire only a proven observer whose source envelope became ambiguous. The
 * caller freshly verifies the original process around its capture and commits
 * under the thread lock. Ambiguous entries remain independent display cards.
 */
export function planObserverRetirement(record, { history, binding, screen } = {}) {
  const candidate = observerRetirementCandidate(record, history);
  if (!candidate) return null;
  const { turn: original, proof, group, importTurns, advanced } = candidate;
  if (binding?.cwd !== record.thread.cwd || binding.sessionId !== proof.sessionId
    || binding.paneId !== proof.paneId || binding.agentPid !== proof.agentPid
    || binding.agentStartTime !== proof.agentStartTime) return null;
  const idle = history.sourceComplete === true && screen?.inputAvailable === true && screen.busy === false;
  if (!idle && !(advanced && capturedSuccessor(screen, history.turns.at(-1)))) return null;
  const itemIds = original.items.map(item => item.id);
  const next = structuredClone(record);
  const retired = next.thread.turns.find(turn => turn.id === original.id);
  retired.status = 'interrupted';
  retired.error = { message: OBSERVER_IDENTITY_LOSS_ERROR, codexErrorInfo: null, additionalDetails: null };
  retired.completedAt = Math.max(second(history.updatedAt), second(retired.startedAt)) || null;
  retired.durationMs = second(retired.startedAt) && retired.completedAt
    ? (retired.completedAt - retired.startedAt) * 1000 : null;
  next.retiredObserverTurns = { ...next.retiredObserverTurns, [retired.id]: structuredClone(proof) };
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
  // A live tail often has the parser's provisional "completed" status. Only
  // explicit end evidence allows its canonical card to enter completed history.
  const merged = reconcileHistory(next, { ...history, turns: importTurns });
  const turns = merged.record.thread.turns;
  if (turns.some(turn => turn.id === retired.id || turn.items?.some(item => retiredItems.has(item.id)))) return null;
  const firstCard = turns.find(turn => turn.id === merged.record.historySync.sourceTurns[group[0].id]);
  if (!firstCard) return null;
  turns.splice(turns.indexOf(firstCard), 0, retired);
  return { record: merged.record, turnsChanged: [{ before: structuredClone(original), after: structuredClone(retired) }, ...merged.turnsChanged], retiredTurnId: retired.id };
}
