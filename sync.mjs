import { nativeTurnTextSha256, sourceTurnOwnable, stableSourceTurn, submittedTurnTextSha256 } from './live-history.mjs';
import { cursorExportUserText, unwrapUserEnvelope } from './source-identity.mjs';

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
  return unwrapUserEnvelope(text).replace(/\r\n/g, '\n').trim();
}

function turnUser(turn) {
  return (turn.items || []).filter(item => item.type === 'userMessage').map(item => userText(textContent(item.content))).join('\n');
}

const projectedProofKeys = ['version', 'sourceTurnId', 'sessionId', 'paneId', 'agentPid', 'agentStartTime',
  'origin', 'clientId', 'model', 'userTextSha256', 'nativeUserTextSha256'];
const textUser = turn => {
  const users = turn?.items?.filter(item => item?.type === 'userMessage');
  return users?.length === 1 && typeof users[0].id === 'string' && users[0].id
    && Array.isArray(users[0].content) && users[0].content.length
    && users[0].content.every(block => block?.type === 'text' && typeof block.text === 'string') ? users[0] : null;
};

/** A retained fresh-send receipt alone permits the CLI's empty-line projection. */
function projectedCounterpart(record, history, native, source, sync) {
  const receipts = [record.tmuxObserverTurns, record.exportedSubmissionTurns]
    .filter(receipts => own(receipts || {}, native.id)).map(receipts => receipts[native.id]);
  const proof = receipts[0];
  const nativeUser = textUser(native), sourceUser = textUser(source);
  const retainedTerminal = ['completed', 'failed', 'interrupted'].includes(native.status)
    && own(record.exportedSubmissionTurns || {}, native.id);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
    || Object.keys(proof).length !== projectedProofKeys.length
    || !projectedProofKeys.every(key => own(proof, key))
    || receipts.some(receipt => !receipt || Object.keys(receipt).length !== projectedProofKeys.length
      || !projectedProofKeys.every(key => own(receipt, key) && receipt[key] === proof[key]))
    || proof.version !== 3 || proof.origin !== 'native' || proof.sourceTurnId !== source.id
    || proof.sessionId !== record.cursorSessionId || history.id !== proof.sessionId
    || !record.thread.cwd || record.thread.cwd !== history.cwd
    || typeof proof.paneId !== 'string' || !/^%\d+$/u.test(proof.paneId)
    || !Number.isSafeInteger(proof.agentPid) || proof.agentPid <= 0
    || typeof proof.agentStartTime !== 'string' || !/^\d+$/u.test(proof.agentStartTime)
    || typeof proof.model !== 'string' || !proof.model.trim()
    || !retainedTerminal && proof.model !== record.thread.model
    || !nativeUser || !sourceUser || sourceUser.clientId != null
    || typeof proof.clientId !== 'string' || !proof.clientId.trim() || proof.clientId !== nativeUser.clientId
    || native.items.filter(item => item.id === nativeUser.id).length !== 1
    || source.items.filter(item => item.id === sourceUser.id).length !== 1
    || record.thread.turns.filter(turn => turn.id === native.id).length !== 1
    || record.thread.turns.some(turn => turn !== native && turn.items?.some(item => item.type === 'userMessage'
      && (item.clientId === proof.clientId || item.id === nativeUser.id)))
    || !stableSourceTurn(source, history)
    || history.turns.filter(turn => turn.id === source.id || turn.sourceIdentity?.sha256 === source.sourceIdentity.sha256).length !== 1
    || !/^[a-f0-9]{64}$/u.test(proof.userTextSha256) || proof.userTextSha256 !== submittedTurnTextSha256(source)
    || !/^[a-f0-9]{64}$/u.test(proof.nativeUserTextSha256) || proof.nativeUserTextSha256 !== nativeTurnTextSha256(native)
    || turnUser(native) === turnUser(source) || cursorExportUserText(turnUser(native)) !== turnUser(source)
    || !own(sync.sourceTurns, source.id) || sync.sourceTurns[source.id] !== native.id
    || Object.entries(sync.sourceTurns).some(([sourceId, nativeId]) => sourceId !== source.id && nativeId === native.id)
    || !own(sync.sourceItems, sourceUser.id) || sync.sourceItems[sourceUser.id] !== nativeUser.id
    || Object.entries(sync.sourceItems).some(([sourceId, nativeId]) => sourceId !== sourceUser.id && nativeId === nativeUser.id)) return false;
  return true;
}

const agentItems = turn => (turn.items || []).filter(item => item.type === 'agentMessage' && typeof item.text === 'string');
const agentText = turn => agentItems(turn).map(item => item.text).join('\n').replace(/\r\n/g, '\n').trim();

function freshId(id, used) {
  if (!used.has(id)) return id;
  let number = 1;
  while (used.has(`${id}:sync:${number}`)) number++;
  return `${id}:sync:${number}`;
}

const detachedObserverError = 'Cursor tmux observer detached; the original Agent keeps running in tmux';

function canonicalSourceCard(card, source, sync) {
  if (!card || card.status !== 'completed'
    || JSON.stringify(card.sourceIdentity) !== JSON.stringify(source.sourceIdentity)
    || card.sourceTimestampMinute !== source.sourceTimestampMinute
    || card.items?.length !== source.items.length) return false;
  return source.items.every((item, index) => {
    const counterpart = card.items[index];
    if (!counterpart || sync.sourceItems[item.id] !== counterpart.id
      || counterpart.type === 'userMessage' && counterpart.clientId != null) return false;
    const { id: sourceId, ...sourceBody } = item;
    const { id: nativeId, ...nativeBody } = counterpart;
    return JSON.stringify(sourceBody) === JSON.stringify(nativeBody);
  });
}

/** Restore display chronology without deriving ownership of an unbound send. */
function orderDetachedPreviews(record, history, sync) {
  if (record.cursorSessionId !== history.id || !record.thread.cwd || record.thread.cwd !== history.cwd) return false;
  const turns = record.thread.turns;
  let changed = false;
  for (const turn of [...turns]) {
    const users = (turn.items || []).filter(item => item.type === 'userMessage');
    const preview = turn.items?.find(item => item.id === record.livePreviewIds?.[turn.id]);
    if (turn.status !== 'failed' || turn.error?.message !== detachedObserverError || turn.unsubmittedDraft
      || users.length !== 1 || typeof users[0].clientId !== 'string' || !users[0].clientId.trim()
      || typeof users[0].id !== 'string' || !users[0].id
      || preview?.type !== 'agentMessage' || record.liveSourcePreviews?.[turn.id] === true
      || !Number.isSafeInteger(turn.startedAt) || turn.startedAt <= 0
      || own(record.tmuxObserverTurns || {}, turn.id)
      || Object.values(sync.sourceTurns).includes(turn.id)
      || Object.values(sync.sourceItems).includes(users[0].id)) continue;
    const prompt = turnUser(turn);
    if (!prompt) continue;
    // Text only narrows which independent card needs a chronology check. It
    // never establishes a source mapping or a submission/observer proof.
    const matching = (history.turns || []).filter(source => turnUser(source) === prompt);
    if (matching.length !== 1) continue;
    const source = matching[0];
    if (!stableSourceTurn(source, history) || source.status !== 'completed'
      || !history.completedTurnIds?.includes(source.id)
      || !Number.isSafeInteger(source.sourceTimestampMinute) || source.sourceTimestampMinute % 60_000 !== 0
      || source.sourceTimestampMinute <= turn.startedAt * 1000) continue;
    const card = turns.find(candidate => candidate.id === sync.sourceTurns[source.id]);
    if (!canonicalSourceCard(card, source, sync)) continue;
    const from = turns.indexOf(turn), to = turns.indexOf(card);
    if (from <= to) continue;
    turns.splice(from, 1);
    turns.splice(to, 0, turn);
    changed = true;
  }
  return changed;
}

/**
 * Pure, idempotent merge. Metadata changes count as changed so callers persist
 * the source-to-native ID bindings even when an echoed CLI turn adds no UI data.
 */
export function reconcileHistory(record, history) {
  const unchanged = { changed: false, record, turnsChanged: [], nameChanged: false, orderChanged: false };
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
  // Retired previews retain native submission receipts. They may never become
  // source counterparts again after a truncated scan or an envelope rewrite.
  const retired = new Set([...Object.keys(next.retiredObserverTurns || {}), ...Object.keys(next.retiredUnboundTurns || {})]);
  const changes = [];
  const usedTurnIds = new Set(turns.map(turn => turn.id));
  const usedItemIds = new Set(turns.flatMap(turn => (turn.items || []).map(item => item.id)));
  const claimedTurns = new Set();
  let cursor = 0;
  let hasAnchor = false;

  function bindItems(native, source, isSourceTurn) {
    native.items ||= [];
    const projected = projectedCounterpart(next, history, native, source, sync);
    const sameUser = (candidate, sourceItem) => userText(textContent(candidate.content)) === userText(textContent(sourceItem.content))
      || projected && candidate.id === textUser(native).id && sourceItem.id === textUser(source).id;
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
      const compatibleItem = candidate => candidate && !claimed.has(candidate.id) && candidate.type === sourceItem.type
        && (candidate.type === 'userMessage'
          ? sameUser(candidate, sourceItem)
          : candidate.text === sourceItem.text || candidate.text?.startsWith(sourceItem.text) || sourceItem.text?.startsWith(candidate.text));
      let item = own(sync.sourceItems, sourceItem.id)
        ? native.items.find(candidate => candidate.id === sync.sourceItems[sourceItem.id]) : undefined;
      if (!compatibleItem(item)) item = undefined;
      if (!item) item = native.items.find(candidate => candidate.id === sourceItem.id && compatibleItem(candidate));
      if (!item && sourceItem.type === 'userMessage') {
        // Native wrappers and timestamps are absent from the human transcript.
        item = native.items.find(candidate => candidate.type === 'userMessage' && !claimed.has(candidate.id)
          && sameUser(candidate, sourceItem));
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
    // The parser's provisional status can be "completed" before turn_ended.
    // Only the source-bound live observer may publish an unfinished tail; a
    // read-only history merge must neither import it nor rewrite its preview.
    if (history.sourceComplete === false && source === history.turns.at(-1)
      && !history.completedTurnIds?.includes(source.id)) continue;
    const sourceUser = turnUser(source);
    const ownable = sourceTurnOwnable(source, history);
    const stable = stableSourceTurn(source, history);
    const agrees = candidate => candidate && !retired.has(candidate.id) && !claimedTurns.has(candidate.id)
      && (turnUser(candidate) === sourceUser || projectedCounterpart(next, history, candidate, source, sync));
    let native = own(sync.sourceTurns, source.id)
      ? turns.find(turn => turn.id === sync.sourceTurns[source.id]) : undefined;
    if (!ownable || !agrees(native)) native = undefined;
    if (!native) native = turns.find(turn => turn.id === source.id && agrees(turn)
      && (ownable || turn.sourceIdentity?.strength === 'ambiguous'));
    if (!native && source.sourceIdentity?.strength === 'ambiguous') {
      // Display reconciliation may retain an already completed card when its
      // formerly unique envelope becomes duplicated. This grants no live
      // ownership: ambiguous sources remain inadmissible to pending/proofs.
      const exact = turns.filter(turn => agrees(turn) && turn.status !== 'inProgress'
        && (turn.sourceIdentity?.sha256 === source.sourceIdentity.sha256
          || sync.sourceTurns[`${history.id}:turn:envelope:${source.sourceIdentity.sha256}`] === turn.id)
        && agentText(source) && agentText(turn) === agentText(source));
      if (exact.length === 1) native = exact[0];
    }
    if (!native && sourceUser && ownable) {
      // Prompt text alone is ambiguous for common messages such as "Continue".
      // An unmapped echo must agree with the native answer too; otherwise it is
      // a distinct external turn that belongs before a later matching echo.
      const sourceAnswer = agentText(source);
      const candidates = turns.slice(cursor).filter(turn => agrees(turn));
      const compatible = candidates.filter(turn => {
        const nativeAnswer = agentText(turn);
        // New envelope IDs must not inherit ordinal ownership. A historical
        // migration requires a unique completed user-and-answer counterpart;
        // active native submissions are bound by their live session instead.
        if (stable && (turn.status === 'inProgress' || !sourceAnswer || !nativeAnswer)) return false;
        if (!sourceAnswer && nativeAnswer) return false;
        return !sourceAnswer || !nativeAnswer || sourceAnswer.startsWith(nativeAnswer) || nativeAnswer.startsWith(sourceAnswer);
      });
      native = stable ? (compatible.length === 1 ? compatible[0] : undefined) : compatible[0];
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
    if (stable) {
      // Old positional aliases are evidence of the previous parser, not an
      // authority over the new envelope. Retire only aliases of this proven
      // counterpart; never redirect an ordinal to a different native turn.
      for (const [id, nativeId] of Object.entries(sync.sourceTurns)) {
        if (nativeId === native.id && /^\d+$/u.test(id.slice(`${history.id}:turn:`.length))
          && id.startsWith(`${history.id}:turn:`)) delete sync.sourceTurns[id];
      }
    }
    sync.sourceTurns[source.id] = native.id;
    claimedTurns.add(native.id);
    if (hasAnchor) cursor = Math.max(cursor, turns.indexOf(native) + 1);
    if (!before || JSON.stringify(before) !== JSON.stringify(native)) changes.push({ before, after: clone(native) });
  }

  const orderChanged = orderDetachedPreviews(next, history, sync);
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
  return changed ? { changed, record: next, turnsChanged: changes, nameChanged, orderChanged } : unchanged;
}
