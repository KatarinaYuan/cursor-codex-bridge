const textContent = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';

function userText(turn) {
  return (turn?.items || []).filter(item => item.type === 'userMessage').map(item => {
    const text = textContent(item.content);
    const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    return query ? query[1] : text.replace(/^<timestamp>[\s\S]*?<\/timestamp>\s*/, '');
  }).join('\n');
}

const displayText = text => text.replace(/\s+/gu, '');

const nonempty = value => typeof value === 'string' && value.length > 0;
const observerProofKeys = ['version', 'sourceTurnId', 'sessionId', 'paneId', 'agentPid', 'agentStartTime'];
const sameObserverBinding = (proof, binding) => binding && proof.paneId === binding.paneId
  && proof.agentPid === binding.agentPid && proof.agentStartTime === binding.agentStartTime;

/** Validate persisted observer ownership without deriving it from rendered text. */
export function observerTurnProof(record, turnId) {
  const proof = record?.tmuxObserverTurns?.[turnId];
  const turns = record?.thread?.turns;
  if (record?.backend !== 'legacy' || !nonempty(turnId) || !Array.isArray(turns)
    || !Object.hasOwn(record.tmuxObserverTurns || {}, turnId)
    || !proof || typeof proof !== 'object' || Array.isArray(proof)
    || Object.keys(proof).length !== observerProofKeys.length
    || !observerProofKeys.every(key => Object.hasOwn(proof, key))
    || proof.version !== 1 || !nonempty(proof.sourceTurnId) || !nonempty(proof.sessionId)
    || proof.sessionId !== record.cursorSessionId || typeof proof.paneId !== 'string' || !/^%\d+$/u.test(proof.paneId)
    || !Number.isSafeInteger(proof.agentPid) || proof.agentPid <= 0
    || typeof proof.agentStartTime !== 'string' || !/^\d+$/u.test(proof.agentStartTime)
    || !sameObserverBinding(proof, record.tmuxAffinity)) return null;
  const matches = turns.filter(turn => turn.id === turnId);
  const turn = matches[0];
  if (matches.length !== 1 || turn.status !== 'inProgress' || !Array.isArray(turn.items)
    || turn.items.some(item => !['userMessage', 'agentMessage'].includes(item?.type))) return null;
  const users = turn.items.filter(item => item.type === 'userMessage');
  if (users.length !== 1 || users[0].clientId != null || !Array.isArray(users[0].content)
    || !users[0].content.length || users[0].content.some(block => block?.type !== 'text' || typeof block.text !== 'string')
    || !displayText(userText(turn))) return null;
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
  if (sources.length !== 1 || !Array.isArray(sourceTurn.items) || sourceTurn.items.some(item => !item || typeof item !== 'object')
    || displayText(userText(sourceTurn)) !== displayText(userText(turn))) return null;
  return { turn, sourceTurn, proof };
}

/** Reuse only the exact native counterpart of the currently unfinished source turn. */
export function findLiveSourceTurn(record, history, prompt) {
  if (history?.sourceComplete !== false || typeof prompt !== 'string'
    || (record.cursorSessionId && record.cursorSessionId !== history.id)) return null;
  const source = history.turns?.at(-1);
  if (!source?.id || history.completedTurnIds?.includes(source.id)
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
