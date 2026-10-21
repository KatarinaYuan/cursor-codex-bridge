// Only the default light Cursor TUI theme is understood. An unfamiliar screen
// must never grant permission to type into a terminal that a person is using.
const INPUT_BACKGROUND = '242,242,242';
const USER_BACKGROUND = '227,227,227';
const PLACEHOLDERS = new Set(['Add a follow-up', 'Plan, search, build anything']);

function screenLines(raw) {
  const lines = [{ cells: [] }];
  let background = null;
  let foreground = null;
  let dim = false;
  let inverse = false;
  const token = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|[^\x1b]/gu;
  for (const match of String(raw ?? '').matchAll(token)) {
    const value = match[0];
    if (value.startsWith('\x1b')) {
      if (!/^\x1b\[[\d;:]*m$/.test(value)) continue;
      // tmux emits semicolon SGR parameters; the colon form is equivalent.
      const parameters = value.slice(2, -1).replaceAll(':', ';').split(';').map(p => p === '' ? 0 : Number(p));
      for (let i = 0; i < parameters.length; i++) {
        const parameter = parameters[i];
        if (parameter === 0) { background = null; foreground = null; dim = false; inverse = false; }
        else if (parameter === 2) dim = true;
        else if (parameter === 22) dim = false;
        else if (parameter === 7) inverse = true;
        else if (parameter === 27) inverse = false;
        else if (parameter === 49) background = null;
        else if (parameter === 39) foreground = null;
        else if (parameter >= 30 && parameter <= 37 || parameter >= 90 && parameter <= 97) foreground = parameter;
        else if (parameter >= 40 && parameter <= 47 || parameter >= 100 && parameter <= 107) background = `indexed:${parameter}`;
        else if (parameter === 48 && parameters[i + 1] === 2) {
          background = parameters.slice(i + 2, i + 5).join(',');
          i += 4;
        } else if (parameter === 48 && parameters[i + 1] === 5) {
          background = `indexed:${parameters[i + 2]}`;
          i += 2;
        } else if ((parameter === 38 || parameter === 58) && parameters[i + 1] === 2) {
          if (parameter === 38) foreground = `rgb:${parameters.slice(i + 2, i + 5).join(',')}`;
          i += 4;
        } else if ((parameter === 38 || parameter === 58) && parameters[i + 1] === 5) {
          if (parameter === 38) foreground = `indexed:${parameters[i + 2]}`;
          i += 2;
        }
      }
      continue;
    }
    if (value === '\n') lines.push({ cells: [] });
    else if (value !== '\r' && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) lines.at(-1).cells.push({ value, background, foreground, dim, inverse });
  }
  for (const line of lines) {
    line.rawText = line.cells.map(cell => cell.value).join('');
    line.text = line.rawText.trimEnd();
  }
  return lines;
}

function backgroundGroups(lines, background) {
  const groups = [];
  for (let index = 0; index < lines.length; index++) {
    const cells = lines[index].cells;
    if (!cells.some(cell => cell.background === background)) continue;
    const previous = groups.at(-1);
    if (previous?.end === index - 1) previous.end = index;
    else groups.push({ start: index, end: index });
  }
  return groups;
}

function frameText(lines, frame, background) {
  return lines.slice(frame.start, frame.end + 1).map(line => line.cells
    .filter(cell => cell.background === background).map(cell => cell.value).join('').trim()).join('\n').trim();
}

function allVisibleDim(line) {
  const visible = line.cells.filter(cell => !/\s/u.test(cell.value));
  return visible.length > 0 && visible.every(cell => cell.dim);
}

function questionOverlay(lines) {
  const visible = lines.map(line => line.text.trim()).filter(Boolean);
  if (!/^└─+┘$/u.test(visible.at(-1) || '')) return false;
  const start = visible.findLastIndex(line => /^┌─+┐$/u.test(line));
  if (start < 0) return false;
  const box = visible.slice(start + 1, -1);
  if (!box.length || box.some(line => !/^│.*│$/u.test(line))) return false;
  const content = box.map(line => line.slice(1, -1).trim()).filter(Boolean);
  const position = content[1]?.match(/^Question ([1-9]\d*) of ([1-9]\d*)$/u);
  return content[0] === 'Clarifying Questions' && Boolean(position)
    && Number.isSafeInteger(Number(position[2])) && Number(position[1]) <= Number(position[2])
    && content.some(line => /^(?:›\s*)?\[[ x]\]\s+\S/u.test(line))
    && content.at(-1) === '↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip';
}

function modelFooter(line) {
  if (!line) return null;
  const match = line.text.trim().match(/^(.{1,100}?)\s+[·•]\s+(\d+(?:\.\d+)?)%(?:\s+[·•]\s+\d+\s+files?\s+edited)?(?: {2,}(Run Everything))?$/u);
  if (!match || Number(match[2]) > 100) return null;
  const label = match[3];
  const labelOffset = label ? [...line.text.slice(0, line.text.lastIndexOf(label))].length : line.cells.length;
  if (!allVisibleDim({ cells: line.cells.slice(0, labelOffset) })) return null;
  // This existing Cursor permission-mode badge is status, not an approval UI.
  // Accept only the exact label and magenta styling seen in the default TUI.
  if (label && !line.cells.slice(labelOffset).filter(cell => !/\s/u.test(cell.value))
    .every(cell => cell.foreground === 35 && !cell.dim)) return null;
  return match;
}

function cwdFooter(lines, frameWidth) {
  if (!lines.length || !lines.every(allVisibleDim)) return false;
  if (!/^(?:~(?:\/.*)?|\/.*|[A-Za-z]:[\\/].*|\.{1,2}\/.*)$/u.test(lines[0].text.trim())) return false;
  const indent = lines[0].text.match(/^ */)[0].length;
  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1];
    const continuation = lines[index].text.trim();
    const separatorContinuation = /^[·•] [^\s]+$/u.test(continuation);
    // Cursor hard-wraps long cwd/branch text at the input frame's right edge.
    // Without a known column width (e.g. wide Unicode), reject continuation
    // rather than treating a menu or approval row as more path text.
    // A separator can start the next row only when its preceding single space
    // occupied the final column. Retain that raw space as edge evidence;
    // arbitrarily padded short paths must not authorize an extra footer row.
    if (!/^[\x20-\x7e]*$/.test(previous.rawText) || previous.rawText.length !== frameWidth
      || previous.text.length !== frameWidth - (separatorContinuation ? 1 : 0)
      || lines[index].text.match(/^ */)[0].length !== indent) return false;
    if (!separatorContinuation && !/^[^\s·•]+(?: [·•] [^\s]+)?$/u.test(continuation)
      || /^(?:allow|always|deny|accept|approve|cancel|continue|yes|no|enter|escape)(?:\s|$)/iu.test(
        separatorContinuation ? continuation.slice(2) : continuation)) return false;
  }
  return true;
}

function completeInputFrame(lines, frame) {
  if (frame.end - frame.start < 2) return false;
  for (const index of [frame.start, frame.end]) {
    const cells = lines[index].cells.filter(cell => cell.background === INPUT_BACKGROUND);
    if (cells.length < 12 || cells.some(cell => !/\s/u.test(cell.value))) return false;
  }
  // Tool output, popovers, and partial redraws must not share the frame's rows.
  return lines.slice(frame.start, frame.end + 1).every(line => line.cells
    .filter(cell => cell.background !== INPUT_BACKGROUND).every(cell => /\s/u.test(cell.value)));
}

function inputDraft(lines, frame) {
  const rows = lines.slice(frame.start + 1, frame.end).map(line => line.cells
    .filter(cell => cell.background === INPUT_BACKGROUND));
  const prefix = rows[0]?.map(cell => cell.value).join('').match(/^( +)→ /u)?.[0];
  if (!prefix) return null;
  const offset = [...prefix].length;
  // The input starts at the same column on continuation rows. Strip only the
  // TUI's fixed indentation, never the draft's own spaces or blank lines.
  if (rows.slice(1).some(row => row.length < offset
    || row.slice(0, offset).some(cell => cell.value !== ' '))) return null;
  const content = rows.map(row => row.slice(offset));
  const inverse = rows.flatMap((row, rowIndex) => row.flatMap((cell, column) =>
    cell.inverse ? [{ row: rowIndex, offset: column - offset }] : []));
  const first = inverse[0];
  const caret = first && first.offset >= 0 && inverse.every((cell, index) =>
    cell.row === first.row && cell.offset === first.offset + index)
    ? first : null;
  // Right-hand spaces include terminal fill. Consumers must compare them with
  // the expected input and use the caret to locate its end; trimming these rows
  // would erase trailing newlines and indentation again. Offsets count Unicode
  // codepoints, matching the cells collected from capture-pane.
  // Cursor's prompt renderer reserves three columns before the text and two
  // after it. The blank frame row measures actual terminal columns, including
  // when a content row contains wide or combining Unicode characters.
  const width = lines[frame.start].cells.filter(cell => cell.background === INPUT_BACKGROUND).length - 5;
  return { rows: content.map(row => row.map(cell => cell.value).join('')), caret, width };
}

/** Parse a tmux `capture-pane -e -p -J` snapshot without controlling the pane. */
export function parseCursorScreen(rawANSI, { knownCursor = false } = {}) {
  const lines = screenLines(rawANSI);
  const text = lines.map(line => line.text).join('\n').trim();
  const frames = backgroundGroups(lines, INPUT_BACKGROUND);
  const frame = frames.at(-1);
  const body = (frame ? lines.slice(0, frame.start) : lines).map(line => line.text).join('\n').trim();
  const userFrames = backgroundGroups(frame ? lines.slice(0, frame.start) : lines, USER_BACKGROUND);
  const userMessages = userFrames.map(group => frameText(lines, group, USER_BACKGROUND)).filter(Boolean);
  const currentTurnBody = userFrames.length ? lines.slice(userFrames.at(-1).start, frame?.start)
    .map(line => line.text).join('\n').trim() : body;
  const currentReplyBody = userFrames.length ? lines.slice(userFrames.at(-1).end + 1, frame?.start)
    .map(line => line.text).join('\n').trim() : '';
  const inputText = frame ? frameText(lines, frame, INPUT_BACKGROUND) : '';
  const followingLines = frame ? lines.slice(frame.end + 1) : [];
  const footer = followingLines.filter(line => line.text.trim());
  const stopHint = `${inputText}\n${footer.map(line => line.text).join('\n')}`
    .match(/\b(ctrl\s*\+\s*c|esc)\s+to\s+stop\b/i);
  const busy = Boolean(stopHint);
  const inputMatch = inputText.match(/^([→>])[ \t]*([\s\S]*)$/u);
  const placeholder = inputMatch && !inputMatch[2].includes('\n') && PLACEHOLDERS.has(inputMatch[2].trim());
  const inputVisible = frame ? lines.slice(frame.start, frame.end + 1).flatMap(line => line.cells)
    .filter(cell => cell.background === INPUT_BACKGROUND && !/\s/u.test(cell.value)) : [];
  // A person can type the exact placeholder. Cursor dims the real placeholder
  // and may render only its first character in reverse video as the caret.
  const styledPlaceholder = inputVisible[0]?.value === '→' && inputVisible[0].dim
    && inputVisible.slice(1).every((cell, index) => cell.dim || index === 0 && cell.inverse);
  const inputEmpty = Boolean(inputMatch?.[1] === '→' && placeholder && styledPlaceholder);
  const prompt = inputMatch ? (inputEmpty ? '' : inputMatch[2].trim()) : inputText;
  const headerIndex = lines.findIndex(line => /^Cursor Agent(?:\s|$)/.test(line.text.trim()));
  const hasHeader = headerIndex >= 0 && lines[headerIndex].text.trim() === 'Cursor Agent' && headerIndex < (frame?.start ?? lines.length)
    && lines.slice(headerIndex + 1, headerIndex + 5).some(line => /^v\d{4}\.\d{1,2}\.\d{1,2}(?:-[\w.-]+)?$/.test(line.text.trim()));
  // A long conversation may have scrolled its header beyond capture history.
  // Only a caller that verified the pane's process identity may waive it;
  // a visible but unfamiliar Cursor header is always rejected.
  const recognizedCursor = hasHeader || knownCursor === true && headerIndex < 0;
  const completeFrame = Boolean(frame && completeInputFrame(lines, frame));
  const draft = completeFrame && !inputEmpty ? inputDraft(lines, frame) : null;
  const stopKey = recognizedCursor && completeFrame && stopHint
    ? (/^ctrl/i.test(stopHint[1]) ? 'C-c' : 'Escape') : null;
  const modelMatch = modelFooter(footer[0]);
  const hasFooter = Boolean(modelMatch) && cwdFooter(footer.slice(1), frame ? lines[frame.start].cells.length : 0);
  // This attests only a read-only question display. It grants neither input
  // readiness nor model inference, and never answers or dismisses the question.
  const waitingForQuestion = recognizedCursor && !busy && questionOverlay(lines);
  let reason = 'ready';
  if (!recognizedCursor) reason = 'unrecognized-cursor-screen';
  else if (waitingForQuestion) reason = 'question-awaiting-answer';
  else if (!completeFrame) reason = 'incomplete-input-frame';
  else if (busy) reason = 'agent-busy';
  else if (!inputMatch || inputMatch[1] !== '→') reason = 'unrecognized-input-mode';
  else if (!hasFooter) reason = 'unrecognized-footer-or-overlay';
  const inputAvailable = reason === 'ready';
  if (inputAvailable && !inputEmpty) reason = 'input-has-draft';
  const ready = reason === 'ready';
  const inputWidth = completeFrame ? lines[frame.start].cells.filter(cell => cell.background === INPUT_BACKGROUND).length - 5 : null;
  // Cursor's empty slash palette replaces the entire model/path footer while
  // a cursor crosses an absolute path. This is only a structural observation:
  // it never grants readiness, model inference or permission to submit input.
  const inputCompletion = reason === 'unrecognized-footer-or-overlay' && !busy && !inputEmpty
    && inputMatch?.[1] === '→' && draft?.caret && footer.length === 1
    && /^ {5}No matches$/u.test(footer[0].text) && allVisibleDim(footer[0])
    ? 'no-matches' : null;
  return { text, body, currentTurnBody, currentReplyBody, inputText, inputDraft: draft, inputWidth, inputEmpty, inputAvailable, ready, busy, stopKey, waitingForQuestion, blocked: !ready, prompt,
    modelName: modelMatch?.[1]?.trim() ?? null, userMessages, reason, inputCompletion };
}
/** A supported frame may have scrolled its user envelope out of the short capture. */
export function needsHistoryCapture(screen) {
  if (!Array.isArray(screen?.userMessages) || screen.userMessages.length) return false;
  const busy = screen.ready === false && screen.inputAvailable === false && screen.busy === true
    && screen.reason === 'agent-busy' && ['C-c', 'Escape'].includes(screen.stopKey);
  const question = screen.ready === false && screen.inputAvailable === false && screen.busy === false
    && screen.waitingForQuestion === true && screen.stopKey === null && screen.reason === 'question-awaiting-answer';
  const idle = screen.inputAvailable === true && screen.busy === false && screen.stopKey === null
    && (screen.reason === 'ready' && screen.ready === true || screen.reason === 'input-has-draft' && screen.ready === false);
  return busy || question || idle;
}
