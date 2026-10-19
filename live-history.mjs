import { createHash } from 'node:crypto';
import { unwrapUserEnvelope } from './source-identity.mjs';

const textContent = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';

function userText(turn) {
  return (turn?.items || []).filter(item => item.type === 'userMessage').map(item => {
    const text = textContent(item.content);
    return unwrapUserEnvelope(text);
  }).join('\n');
}

const displayText = text => text.replace(/\s+/gu, '');

const nonempty = value => typeof value === 'string' && value.length > 0;
const observerProofKeys = ['version', 'sourceTurnId', 'sessionId', 'paneId', 'agentPid', 'agentStartTime'];
const submittedProofKeys = [...observerProofKeys, 'origin', 'clientId', 'model', 'userTextSha256', 'nativeUserTextSha256'];
const sameObserverBinding = (proof, binding) => binding && proof.paneId === binding.paneId
  && proof.agentPid === binding.agentPid && proof.agentStartTime === binding.agentStartTime;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const canonicalSubmittedText = turn => userText(turn).replace(/\r\n/gu, '\n').trim();

// Match the existing native tmux send contract: Cursor may trim the outer
// whitespace, but all interior whitespace and hard newlines remain significant.
export const submittedTurnTextSha256 = turn => sha256(canonicalSubmittedText(turn));
export const nativeTurnTextSha256 = turn => sha256((turn?.items || [])
  .filter(item => item.type === 'userMessage').map(item => textContent(item.content)).join('\n'));

/** Ambiguous display IDs must never establish ownership of a real submission. */
export function sourceTurnOwnable(turn, history) {
  const identity = turn?.sourceIdentity;
  if (!identity) return !history?.sourceIdentityScheme;
  if (identity.version !== 1 || identity.strength === 'ambiguous') return false;
  if (identity.kind === 'legacy-position') return identity.strength === 'position';
  return identity.kind === 'timestamped-user-envelope' && identity.strength === 'stable'
    && /^[a-f0-9]{64}$/u.test(identity.sha256 || '')
    && turn.id === `${history?.id}:turn:envelope:${identity.sha256}`;
}

export const stableSourceTurn = (turn, history) => sourceTurnOwnable(turn, history)
  && turn.sourceIdentity?.strength === 'stable';

/** Persist provenance only for a freshly observed native send, never a prompt-only restart. */
export function retainSubmittedTurn(record, nativeTurn, sourceTurn, binding, history) {
  if (!stableSourceTurn(sourceTurn, history) || history?.id !== record?.cursorSessionId
    || binding?.sessionId !== history.id || binding?.cwd !== record?.thread?.cwd
    || history.cwd !== record.thread.cwd || nativeTurn?.status !== 'inProgress'
    || !record.thread.turns.includes(nativeTurn) || canonicalSubmittedText(sourceTurn) !== canonicalSubmittedText(nativeTurn)) return false;
  const user = nativeTurn.items?.filter(item => item.type === 'userMessage');
  if (user?.length !== 1 || !nonempty(user[0].clientId)) return false;
  const proof = { version: 2, sourceTurnId: sourceTurn.id, sessionId: history.id,
    paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime,
    origin: 'native', clientId: user[0].clientId, model: record.thread.model,
    userTextSha256: submittedTurnTextSha256(sourceTurn), nativeUserTextSha256: nativeTurnTextSha256(nativeTurn) };
  if (Object.hasOwn(record.tmuxObserverTurns || {}, nativeTurn.id)
    && JSON.stringify(record.tmuxObserverTurns[nativeTurn.id]) !== JSON.stringify(proof)) return false;
  const next = { ...record, tmuxObserverTurns: { ...record.tmuxObserverTurns, [nativeTurn.id]: proof } };
  if (!observerTurnProof(next, nativeTurn.id)) return false;
  record.tmuxObserverTurns = next.tmuxObserverTurns;
  return true;
}

/** A malformed explicit native claim must remain blocked, never become a retry. */
export function hasSubmittedTurnClaim(record, turnId) {
  const proof = record?.tmuxObserverTurns?.[turnId];
  return Object.hasOwn(record?.tmuxObserverTurns || {}, turnId)
    && proof && typeof proof === 'object' && (proof.version === 2 || proof.origin === 'native');
}

/** Validate persisted observer ownership without deriving it from rendered text. */
export function observerTurnProof(record, turnId) {
  const proof = record?.tmuxObserverTurns?.[turnId];
  const turns = record?.thread?.turns;
  const submitted = proof?.version === 2;
  const keys = submitted ? submittedProofKeys : observerProofKeys;
  if (record?.backend !== 'legacy' || !nonempty(turnId) || !Array.isArray(turns)
    || !Object.hasOwn(record.tmuxObserverTurns || {}, turnId)
    || !proof || typeof proof !== 'object' || Array.isArray(proof)
    || Object.keys(proof).length !== keys.length
    || !keys.every(key => Object.hasOwn(proof, key))
    || (!submitted && proof.version !== 1) || !nonempty(proof.sourceTurnId) || !nonempty(proof.sessionId)
    || proof.sessionId !== record.cursorSessionId || typeof proof.paneId !== 'string' || !/^%\d+$/u.test(proof.paneId)
    || !Number.isSafeInteger(proof.agentPid) || proof.agentPid <= 0
    || typeof proof.agentStartTime !== 'string' || !/^\d+$/u.test(proof.agentStartTime)
    || !sameObserverBinding(proof, record.tmuxAffinity)) return null;
  const matches = turns.filter(turn => turn.id === turnId);
  const turn = matches[0];
  if (matches.length !== 1 || turn.status !== 'inProgress' || !Array.isArray(turn.items)
    || turn.items.some(item => !['userMessage', 'agentMessage'].includes(item?.type))) return null;
  const users = turn.items.filter(item => item.type === 'userMessage');
  if (users.length !== 1 || (!submitted && users[0].clientId != null) || !Array.isArray(users[0].content)
    || !users[0].content.length || users[0].content.some(block => block?.type !== 'text' || typeof block.text !== 'string')
    || !displayText(userText(turn))) return null;
  if (submitted && (proof.origin !== 'native' || !nonempty(proof.clientId) || !proof.clientId.trim()
    || proof.clientId !== users[0].clientId || !nonempty(proof.model) || proof.model !== record.thread.model
    || !/^[a-f0-9]{64}$/u.test(proof.userTextSha256) || proof.userTextSha256 !== submittedTurnTextSha256(turn)
    || !/^[a-f0-9]{64}$/u.test(proof.nativeUserTextSha256) || proof.nativeUserTextSha256 !== nativeTurnTextSha256(turn)
    || turns.filter(candidate => candidate.status === 'inProgress').length !== 1
    || turns.some(candidate => candidate !== turn && candidate.items?.some(item => item.type === 'userMessage' && item.clientId === proof.clientId)))) return null;
  const mapping = record.historySync?.sourceTurns;
  if (!mapping || !Object.hasOwn(mapping, proof.sourceTurnId) || mapping[proof.sourceTurnId] !== turnId
    || Object.entries(mapping).some(([sourceId, nativeId]) => sourceId !== proof.sourceTurnId && nativeId === turnId)
    || Object.entries(record.tmuxObserverTurns).some(([nativeId, other]) => nativeId !== turnId
      && other?.sourceTurnId === proof.sourceTurnId)) return null;
  return proof;
}

/** Adopt one proven observer only against its original process and exact source. */
export function recoverableObserverTurn(record, binding, history) {
  const active = record?.thread?.turns?.filter(turn => turn.status === 'inProgress');
  if (active?.length !== 1) return null;
  const turn = active[0];
  const proof = observerTurnProof(record, turn.id);
  if (!proof || binding?.sessionId !== proof.sessionId || history?.id !== proof.sessionId
    || !sameObserverBinding(proof, binding) || !nonempty(record.thread.cwd)
    || binding.cwd !== record.thread.cwd || history.cwd !== record.thread.cwd
    || !Array.isArray(history.turns)) return null;
  const sources = history.turns.filter(source => source?.id === proof.sourceTurnId);
  const sourceTurn = sources[0];
  if (sources.length !== 1 || !sourceTurnOwnable(sourceTurn, history) || !Array.isArray(sourceTurn.items) || sourceTurn.items.some(item => !item || typeof item !== 'object')
    || displayText(userText(sourceTurn)) !== displayText(userText(turn))) return null;
  if (proof.version === 2) {
    const users = sourceTurn.items.filter(item => item.type === 'userMessage');
    const nativeUser = turn.items.find(item => item.type === 'userMessage');
    const mapping = record.historySync?.sourceItems;
    if ((record.queuedSubmissions !== undefined && (!Array.isArray(record.queuedSubmissions) || record.queuedSubmissions.length))
      || typeof history.sourceComplete !== 'boolean' || !Array.isArray(history.completedTurnIds)
      || users.length !== 1 || users[0].clientId != null || !nonempty(users[0].id) || !nonempty(nativeUser.id)
      || !Array.isArray(users[0].content) || !users[0].content.length
      || users[0].content.some(block => block?.type !== 'text' || typeof block.text !== 'string')
      || canonicalSubmittedText(sourceTurn) !== canonicalSubmittedText(turn)
      || submittedTurnTextSha256(sourceTurn) !== proof.userTextSha256
      || !mapping || !Object.hasOwn(mapping, users[0].id) || mapping[users[0].id] !== nativeUser.id
      || Object.entries(mapping).some(([sourceId, nativeId]) => sourceId !== users[0].id && nativeId === nativeUser.id)) return null;
  }
  return { turn, sourceTurn, proof };
}

/** Reuse only the exact native counterpart of the currently unfinished source turn. */
export function findLiveSourceTurn(record, history, prompt) {
  if (history?.sourceComplete !== false || typeof prompt !== 'string'
    || (record.cursorSessionId && record.cursorSessionId !== history.id)) return null;
  const source = history.turns?.at(-1);
  if (!source?.id || !sourceTurnOwnable(source, history) || history.completedTurnIds?.includes(source.id)
    || !displayText(prompt) || displayText(userText(source)) !== displayText(prompt)) return null;
  const mapping = record.historySync?.sourceTurns;
  const nativeId = mapping && Object.hasOwn(mapping, source.id) ? mapping[source.id] : source.id;
  const native = record.thread?.turns?.find(turn => turn.id === nativeId);
  return native && displayText(userText(native)) === displayText(prompt) ? native : null;
}

/** Replace a rendered preview before canonical history reconciliation, keeping its native ID. */
export function finalizeLivePreview(record, nativeTurn, sourceTurn) {
  const previewId = record.livePreviewIds?.[nativeTurn?.id];
  const preview = nativeTurn?.items?.find(item => item.id === previewId && item.type === 'agentMessage');
  if (!preview) return;
  const sourceAgents = (sourceTurn?.items || []).filter(item => item.type === 'agentMessage' && typeof item.text === 'string');
  if (record.liveSourcePreviews?.[nativeTurn.id] === true) {
    const mapping = record.historySync?.sourceItems;
    let source = sourceAgents.find(item => item.id === preview.id
      || (mapping && Object.hasOwn(mapping, item.id) && mapping[item.id] === preview.id));
    if (!source && sourceAgents.length) {
      source = sourceAgents[0];
      record.historySync ||= { version: 1 };
      record.historySync.sourceItems ||= Object.create(null);
      record.historySync.sourceItems[source.id] = preview.id;
    }
    preview.text = source?.text || '';
  } else {
    preview.text = sourceAgents.map(item => item.text).join('\n');
  }
  preview.phase = 'final_answer';
}
