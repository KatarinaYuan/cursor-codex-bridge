const PAGE_ROWS = 6;
const INVERSE = '\x1b[7m';
const RESET = '\x1b[27m';

function draftLines(text, maxLength = 800) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0 || maxLength > 1024) throw new Error('Draft viewport maximum length must be an integer at most 1024');
  if (typeof text !== 'string' || text.length > maxLength || !text.isWellFormed()
    || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error(`Draft viewport planning requires at most ${maxLength} UTF-16 units of well-formed text with LF as its only control character`);
  }
  let start = 0;
  return text.split('\n').map(value => {
    const line = { text: value, start, end: start + value.length };
    start = line.end + 1;
    return line;
  });
}

/** Terminal columns, including Cursor's seven reserved frame columns. */
export function draftViewportColumns(text) {
  return 2 * Math.max(...draftLines(text).map(line => line.text.length)) + 8;
}

function layout(text, width, maxLength = 800) {
  const lines = draftLines(text, maxLength);
  const minimumColumns = 2 * Math.max(...lines.map(line => line.text.length)) + 8;
  if (!Number.isSafeInteger(width) || width < minimumColumns - 7) {
    throw new Error('The input width cannot expose every hard line without soft wrapping');
  }
  return { lines, minimumColumns };
}

// Equivalent to the no-soft-wrap branch of text-layout.ts Kk in Cursor Agent
// 2026.10.16-e3cb207/9494.index.js. LF offsets and empty lines intentionally
// miss its half-open lookup and fall back to line zero.
function cursorLine(lines, offset, textLength) {
  if (offset >= textLength) return lines.length - 1;
  let low = 0, high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = lines[middle];
    if (offset >= line.start && offset < line.end) return middle;
    if (offset < line.start) high = middle - 1;
    else low = middle + 1;
  }
  return 0;
}

// Equivalent to TextInput's focused, insert-mode, zero-cursorWidth renderer.
// Normalize AFTER adding ANSI: an inverse combining mark must not compose with
// a preceding plain character across an ANSI boundary.
function renderVisible(text, offset) {
  let ansi = text.length ? '' : `${INVERSE} ${RESET}`;
  let index = 0;
  let hasInverse = false;
  for (const character of text) {
    if (character === '\n') {
      const atNewline = offset === index && (index === 0 || text[index - 1] !== '\n');
      if (!hasInverse && atNewline) { ansi += `${INVERSE} ${RESET}`; hasInverse = true; }
      ansi += '\n';
      index++;
      if (!hasInverse && offset === index && (text[index] == null || text[index] === '\n')) {
        ansi += `${INVERSE} ${RESET}`;
        hasInverse = true;
      }
      continue;
    }
    if (index === offset) { ansi += `${INVERSE}${character}${RESET}`; hasInverse = true; }
    else ansi += character;
    index += character.length;
  }
  if (!hasInverse && text.length && offset === text.length) ansi += `${INVERSE} ${RESET}`;
  ansi = ansi.normalize('NFC');
  if (ansi.replace(/\x1b\[(?:7|27)m/gu, '').includes('\x1b')) {
    const error = new Error('NFC normalization changes a caret ANSI boundary; this draft cannot be modeled safely');
    error.code = 'DRAFT_CARET_NFC';
    throw error;
  }
  const rows = [''];
  let inverse = false;
  let caret = null;
  for (const token of ansi.matchAll(/\x1b\[(?:7|27)m|[^\x1b]/gu)) {
    const value = token[0];
    if (value === INVERSE) inverse = true;
    else if (value === RESET) inverse = false;
    else if (value === '\n') rows.push('');
    else {
      if (inverse && !caret) caret = { row: rows.length - 1, offset: [...rows.at(-1)].length };
      rows[rows.length - 1] += value;
    }
  }
  return { rows, caret };
}

/** Render one exact cursor/scroll state; all offsets refer to the raw UTF-16 buffer. */
export function draftViewportSnapshot(text, width, { offset, scrollOffset, maxLength = 800 } = {}) {
  const { lines } = layout(text, width, maxLength);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || !Number.isSafeInteger(scrollOffset) || scrollOffset < 0
    || offset > 0 && offset < text.length && /[\ud800-\udbff]/u.test(text[offset - 1]) && /[\udc00-\udfff]/u.test(text[offset])) {
    throw new Error('Draft viewport offsets must be valid UTF-16 codepoint boundaries');
  }
  const maxScroll = Math.max(0, lines.length - PAGE_ROWS);
  let top = Math.min(scrollOffset, maxScroll);
  const line = cursorLine(lines, offset, text.length);
  if (line < top) top = line;
  else if (line >= top + PAGE_ROWS) top = line - PAGE_ROWS + 1;
  top = Math.min(Math.max(0, top), maxScroll);
  const visible = lines.slice(top, top + PAGE_ROWS);
  const visibleText = visible.map(value => value.text).join('\n');
  let mapped = 0;
  if (offset > visible[0].start) {
    mapped = visibleText.length;
    let relative = 0;
    for (let index = 0; index < visible.length; index++) {
      const value = visible[index];
      if (!(offset === value.end && visible[index + 1]?.start === offset) && offset <= value.end) {
        mapped = relative + Math.min(Math.max(0, offset - value.start), value.text.length);
        break;
      }
      relative += value.text.length + 1;
    }
  }
  try { return { offset, scrollOffset: top, ...renderVisible(visibleText, mapped) }; }
  catch (error) {
    if (error.code === 'DRAFT_CARET_NFC') error.scrollOffset = top;
    throw error;
  }
}

/**
 * Observe offset zero, then every codepoint boundary through the final caret.
 * This is an observation plan, not proof of draft equality: distinct buffers
 * containing long blank-line runs can produce identical entire scan traces.
 * capture:false steps still require movement: only their observation is skipped.
 * Runtime must first establish its start anchor; each movement count is raw UTF-16
 * distance (Cursor's Left/Right handler advances one UTF-16 unit per key).
 */
export function draftViewportPlan(text, width, { maxLength = 800 } = {}) {
  const { lines, minimumColumns } = layout(text, width, maxLength);
  // The caller must prove its initial boundary; do not silently skip this frame.
  const pages = [{ ...draftViewportSnapshot(text, width, { offset: 0, scrollOffset: 0, maxLength }), capture: true }];
  let offset = 0;
  let scrollOffset = pages[0].scrollOffset;
  for (const character of text) {
    offset += character.length;
    let page;
    try { page = draftViewportSnapshot(text, width, { offset, scrollOffset, maxLength }); }
    catch (error) {
      if (error.code !== 'DRAFT_CARET_NFC') throw error;
      scrollOffset = error.scrollOffset;
      pages.push({ offset, scrollOffset, movement: { direction: 'right', count: character.length }, capture: false });
      continue;
    }
    scrollOffset = page.scrollOffset;
    page.movement = { direction: 'right', count: character.length };
    page.capture = true;
    pages.push(page);
  }
  if (!pages.at(-1).capture || pages.at(-1).offset !== text.length) throw new Error('The final draft caret cannot be rendered safely');
  const covered = new Set();
  for (const page of pages) if (page.capture) for (let row = 0; row < page.rows.length; row++) covered.add(page.scrollOffset + row);
  if (lines.some((line, index) => line.text.length && !covered.has(index))) {
    throw new Error('A nonempty hard line has no safe rendered observation');
  }
  return { minimumColumns, lines, pages };
}
