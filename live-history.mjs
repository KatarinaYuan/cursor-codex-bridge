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
