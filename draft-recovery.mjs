export const UNSUBMITTED_DRAFT_ERROR = 'Cursor input changed or could not be verified after paste; text remains as an unsubmitted draft in tmux. Review it in Cursor CLI';

const evidenceKeys = ['sessionId', 'paneId', 'agentPid', 'agentStartTime', 'model', 'sourceTurnIds'];
const markerKeys = ['version', 'turnId', ...evidenceKeys];
const nonempty = value => typeof value === 'string' && value.length > 0;
const sameKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);

function validEvidence(value, keys = evidenceKeys) {
  return sameKeys(value, keys)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.sessionId)
    && /^%\d+$/u.test(value.paneId)
    && Number.isSafeInteger(value.agentPid) && value.agentPid > 0
    && typeof value.agentStartTime === 'string' && /^\d+$/u.test(value.agentStartTime)
    && nonempty(value.model)
    && Array.isArray(value.sourceTurnIds) && value.sourceTurnIds.every(nonempty)
    && new Set(value.sourceTurnIds).size === value.sourceTurnIds.length;
}

function sameBinding(proof, binding) {
  return binding?.paneId === proof.paneId && binding.agentPid === proof.agentPid
    && binding.agentStartTime === proof.agentStartTime;
}

function textBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length
    || blocks.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return null;
  const text = blocks.map(block => block.text).join('\n');
  return text.trim() ? text : null;
}

function soleUser(turn) {
  if (!Array.isArray(turn?.items) || turn.items.length !== 1 || turn.items[0]?.type !== 'userMessage') return null;
  const user = turn.items[0];
  return textBlocks(user.content) === null ? null : user;
}

function failedDraftTurn(record, turn) {
  return record?.backend === 'legacy' && record.thread?.turns?.at(-1) === turn
    && nonempty(turn?.id) && turn.status === 'failed'
    && turn.error?.message === UNSUBMITTED_DRAFT_ERROR && soleUser(turn) !== null;
}

/** Retain only a structured proof emitted after paste failed before Enter. */
export function retainUnsubmittedDraft(record, turn, evidence) {
  if (!failedDraftTurn(record, turn) || !validEvidence(evidence)
    || evidence.sessionId !== record.cursorSessionId
    || evidence.model !== record.thread.model || !sameBinding(evidence, record.tmuxAffinity)) return false;
  turn.unsubmittedDraft = { version: 1, turnId: turn.id, ...structuredClone(evidence) };
  return true;
}

/** A new, identical send may submit its proven draft once without pasting again. */
export function retryDraftFor(record, binding, history, acpInput) {
  const turn = record?.thread?.turns?.at(-1);
  const proof = turn?.unsubmittedDraft;
  if (!failedDraftTurn(record, turn) || !validEvidence(proof, markerKeys)
    || proof.version !== 1 || proof.turnId !== turn.id
    || proof.sessionId !== record.cursorSessionId || binding?.sessionId !== proof.sessionId
    || !sameBinding(proof, binding) || !sameBinding(proof, record.tmuxAffinity)
    || proof.model !== record.thread.model
    || history?.id !== proof.sessionId || history.sourceComplete !== true || !Array.isArray(history.turns)) return null;
  const sourceIds = history.turns.map(source => source?.id);
  if (!sourceIds.every(nonempty) || !sameIds(proof.sourceTurnIds, sourceIds)) return null;
  const text = textBlocks(acpInput);
  if (text === null || text !== textBlocks(soleUser(turn).content)) return null;
  return { text, proof: structuredClone(proof) };
}

const canonicalText = blocks => textBlocks(blocks)?.replace(/\r\n/gu, '\n').trim();

/** Pin a completed native send before the history matcher can choose an older failure. */
export function pinLiveSourceTurn(record, nativeTurn, sourceTurn) {
  if (record?.backend !== 'legacy' || !record.thread?.turns?.includes(nativeTurn)
    || !nonempty(nativeTurn?.id) || !nonempty(sourceTurn?.id)) return false;
  const nativeUsers = nativeTurn.items?.filter(item => item.type === 'userMessage') || [];
  const sourceUsers = sourceTurn.items?.filter(item => item.type === 'userMessage') || [];
  if (nativeUsers.length !== 1 || sourceUsers.length !== 1 || !nonempty(nativeUsers[0].id)
    || !nonempty(sourceUsers[0].id) || canonicalText(nativeUsers[0].content) === undefined
    || canonicalText(nativeUsers[0].content) !== canonicalText(sourceUsers[0].content)) return false;
  const prior = record.historySync;
  if (prior?.sourceTurns && Object.hasOwn(prior.sourceTurns, sourceTurn.id)
    && prior.sourceTurns[sourceTurn.id] !== nativeTurn.id) return false;
  if (prior?.sourceItems && Object.hasOwn(prior.sourceItems, sourceUsers[0].id)
    && prior.sourceItems[sourceUsers[0].id] !== nativeUsers[0].id) return false;
  record.historySync ||= { version: 1 };
  record.historySync.sourceTurns ||= Object.create(null);
  record.historySync.sourceItems ||= Object.create(null);
  Object.defineProperty(record.historySync.sourceTurns, sourceTurn.id, { value: nativeTurn.id, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(record.historySync.sourceItems, sourceUsers[0].id, { value: nativeUsers[0].id, enumerable: true, writable: true, configurable: true });
  return true;
}
