/**
 * Reconcile a read-only Cursor transcript with its native bridge record.
 *
 * Cursor's transcript is append-oriented and may be read between writes. Never
 * remove native history, or replace a longer message with a partial snapshot.
 */

const clone = value => structuredClone(value);
const own = (object, key) => Object.hasOwn(object, key);
const textContent = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';

function userText(text) {
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (query ? query[1] : text.replace(/^<timestamp>[\s\S]*?<\/timestamp>\s*/, '')).replace(/\r\n/g, '\n').trim();
}

function turnUser(turn) {
  return (turn.items || []).filter(item => item.type === 'userMessage').map(item => userText(textContent(item.content))).join('\n');
}

const agentItems = turn => (turn.items || []).filter(item => item.type === 'agentMessage' && typeof item.text === 'string');
const agentText = turn => agentItems(turn).map(item => item.text).join('\n').replace(/\r\n/g, '\n').trim();

function freshId(id, used) {
  if (!used.has(id)) return id;
  let number = 1;
  while (used.has(`${id}:sync:${number}`)) number++;
  return `${id}:sync:${number}`;
}

/**
 * Pure, idempotent merge. Metadata changes count as changed so callers persist
 * the source-to-native ID bindings even when an echoed CLI turn adds no UI data.
 */
export function reconcileHistory(record, history) {
  const unchanged = { changed: false, record, turnsChanged: [], nameChanged: false };
  if (record?.backend !== 'legacy' || !record.thread || !history
    || (record.cursorSessionId && history.id !== record.cursorSessionId)) return unchanged;

  const next = clone(record);
  const priorSync = next.historySync || {};
  const sync = {
    ...priorSync, version: 1,
    sourceTurns: Object.assign(Object.create(null), priorSync.sourceTurns),
    sourceItems: Object.assign(Object.create(null), priorSync.sourceItems),
  };
  next.historySync = sync;
  next.thread.turns ||= [];
  const turns = next.thread.turns;
  const changes = [];
  const usedTurnIds = new Set(turns.map(turn => turn.id));
  const usedItemIds = new Set(turns.flatMap(turn => (turn.items || []).map(item => item.id)));
  const claimedTurns = new Set();
  let cursor = 0;
  let hasAnchor = false;

  function bindItems(native, source, isSourceTurn) {
    native.items ||= [];
    const sourceAgents = agentItems(source);
    const nativeAgents = agentItems(native);
    const sourceAgentText = agentText(source);
    const nativeAgentText = agentText(native);

    // Bridge-created turns are written back to the CLI transcript. Cursor can
    // group their assistant chunks differently; compare the whole ordered text
    // before attempting item-level alignment, without discarding native cards.
    if (!isSourceTurn && sourceAgentText && nativeAgentText
      && (nativeAgentText.startsWith(sourceAgentText) || sourceAgentText.startsWith(nativeAgentText))) {
      if (sourceAgentText.length > nativeAgentText.length) {
        const nativeFullText = nativeAgents.map(item => item.text).join('\n').replace(/\r\n/g, '\n');
        const sourceFullText = sourceAgents.map(item => item.text).join('\n').replace(/\r\n/g, '\n');
        if (sourceFullText.startsWith(nativeFullText)) {
          nativeAgents.at(-1).text += sourceFullText.slice(nativeFullText.length);
        } else {
          nativeAgents.at(-1).text = nativeAgents.at(-1).text.trimEnd() + sourceAgentText.slice(nativeAgentText.length);
        }
      }
      for (let index = 0; index < sourceAgents.length; index++) {
        sync.sourceItems[sourceAgents[index].id] = nativeAgents[Math.min(index, nativeAgents.length - 1)].id;
      }
    }

    const handledAgents = !isSourceTurn && sourceAgentText && nativeAgentText
      && (nativeAgentText.startsWith(sourceAgentText) || sourceAgentText.startsWith(nativeAgentText));
    const claimed = new Set();
    let itemCursor = 0;
    for (const sourceItem of source.items || []) {
      if (!['userMessage', 'agentMessage'].includes(sourceItem.type)) continue;
      if (sourceItem.type === 'agentMessage' && handledAgents) continue;
      let item = own(sync.sourceItems, sourceItem.id)
        ? native.items.find(candidate => candidate.id === sync.sourceItems[sourceItem.id]) : undefined;
      if (item && (claimed.has(item.id) || item.type !== sourceItem.type)) item = undefined;
      if (!item) item = native.items.find(candidate => candidate.id === sourceItem.id && !claimed.has(candidate.id) && candidate.type === sourceItem.type);
      if (!item && sourceItem.type === 'userMessage') {
        // Native wrappers and timestamps are absent from the human transcript.
        item = native.items.find(candidate => candidate.type === 'userMessage' && !claimed.has(candidate.id)
          && userText(textContent(candidate.content)) === userText(textContent(sourceItem.content)));
      }
      if (!item && sourceItem.type === 'agentMessage') {
        for (let index = itemCursor; index < native.items.length; index++) {
          const candidate = native.items[index];
          if (candidate.type !== 'agentMessage' || claimed.has(candidate.id)) continue;
          if (candidate.text === sourceItem.text || candidate.text?.startsWith(sourceItem.text) || sourceItem.text?.startsWith(candidate.text)) {
            item = candidate;
            itemCursor = index + 1;
            break;
          }
        }
      }
      if (!item) {
        item = clone(sourceItem);
        item.id = freshId(item.id, usedItemIds);
        usedItemIds.add(item.id);
        native.items.push(item);
      } else if (item.type === 'agentMessage' && typeof sourceItem.text === 'string'
        && sourceItem.text.startsWith(item.text || '')) {
        item.text = sourceItem.text;
      }
      claimed.add(item.id);
      sync.sourceItems[sourceItem.id] = item.id;
    }
    // Source-owned historical turns can gain an explicit terminal marker. A CLI
    // snapshot cannot rewrite a bridge turn's status, timing, or error evidence.
    if (isSourceTurn && (source.status === 'failed'
      || (source.status === 'interrupted' && native.status !== 'failed'))
      && native.status !== source.status) {
      native.status = source.status;
      native.error = clone(source.error);
    }
  }

  for (const source of history.turns || []) {
    if (!source?.id || !Array.isArray(source.items)) continue;
    const sourceUser = turnUser(source);
    const agrees = candidate => candidate && !claimedTurns.has(candidate.id)
      && turnUser(candidate) === sourceUser;
    let native = own(sync.sourceTurns, source.id)
      ? turns.find(turn => turn.id === sync.sourceTurns[source.id]) : undefined;
    if (!agrees(native)) native = undefined;
    if (!native) native = turns.find(turn => turn.id === source.id && agrees(turn));
    if (!native && sourceUser) {
      // Prompt text alone is ambiguous for common messages such as "Continue".
      // An unmapped echo must agree with the native answer too; otherwise it is
      // a distinct external turn that belongs before a later matching echo.
      const sourceAnswer = agentText(source);
      const candidates = turns.slice(cursor).filter(turn => agrees(turn));
      native = candidates.find(turn => {
        const nativeAnswer = agentText(turn);
        if (!sourceAnswer && nativeAnswer) return false;
        return !sourceAnswer || !nativeAnswer || sourceAnswer.startsWith(nativeAnswer) || nativeAnswer.startsWith(sourceAnswer);
      });
      // A user row may be visible before its answer has been flushed. Defer an
      // ambiguous binding until a later snapshot can distinguish it from an
      // already-completed native turn with the same prompt.
      if (!native && !sourceAnswer && !['failed', 'interrupted'].includes(source.status)
        && candidates.some(turn => agentText(turn))) continue;
    }
    const before = native ? clone(native) : null;
    if (!native) {
      native = clone(source);
      native.id = freshId(source.id, usedTurnIds);
      native.rootTurnId = native.id;
      usedTurnIds.add(native.id);
      for (const item of native.items) {
        const sourceId = item.id;
        item.id = freshId(item.id, usedItemIds);
        usedItemIds.add(item.id);
        sync.sourceItems[sourceId] = item.id;
      }
      // After a known source/native anchor, keep the source order while leaving
      // later native turns available for forward echo matching. With a truncated
      // unanchored source, append conservatively and leave the search cursor put.
      if (hasAnchor) turns.splice(cursor, 0, native);
      else turns.push(native);
    } else {
      hasAnchor = true;
      bindItems(native, source, native.id === source.id);
    }
    sync.sourceTurns[source.id] = native.id;
    claimedTurns.add(native.id);
    if (hasAnchor) cursor = Math.max(cursor, turns.indexOf(native) + 1);
    if (!before || JSON.stringify(before) !== JSON.stringify(native)) changes.push({ before, after: clone(native) });
  }

  let nameChanged = false;
  if (typeof history.title === 'string' && history.title.trim()) {
    const title = history.title.trim();
    const mayUpdateName = next.titleOrigin !== 'user'
      && (next.titleOrigin === 'source' || next.titleOrigin === 'cursor'
        || (priorSync.lastSourceTitle !== undefined && next.thread.name === priorSync.lastSourceTitle));
    if (mayUpdateName && next.thread.name !== title) {
      next.thread.name = title;
      nameChanged = true;
    }
    sync.lastSourceTitle = title;
  }
  if (!next.sourcePath && history.sourcePath) next.sourcePath = history.sourcePath;
  if (changes.length || nameChanged) {
    const updatedAt = Math.max(Number(next.thread.updatedAt) || 0, Number(history.updatedAt) || 0);
    next.thread.updatedAt = updatedAt;
    next.thread.recencyAt = Math.max(Number(next.thread.recencyAt) || 0, updatedAt);
  }
  const changed = JSON.stringify(record) !== JSON.stringify(next);
  return changed ? { changed, record: next, turnsChanged: changes, nameChanged } : unchanged;
}
