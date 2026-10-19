import test from 'node:test';
import assert from 'node:assert/strict';
import { draftViewportColumns, draftViewportPlan, draftViewportSnapshot } from './draft-viewport.mjs';

const plan = text => draftViewportPlan(text, draftViewportColumns(text) - 7);
const snapshot = (text, offset, scrollOffset = 0) => draftViewportSnapshot(text, draftViewportColumns(text) - 7, { offset, scrollOffset });

test('raw hard-line spans retain indentation, trailing spaces, empty lines and final LF', () => {
  const text = '  first  \n\n \nlast\n';
  assert.deepEqual(plan(text).lines, [
    { text: '  first  ', start: 0, end: 9 },
    { text: '', start: 10, end: 10 },
    { text: ' ', start: 11, end: 12 },
    { text: 'last', start: 13, end: 17 },
    { text: '', start: 18, end: 18 },
  ]);
  assert.deepEqual(snapshot(text, text.length), {
    offset: text.length, scrollOffset: 0, rows: ['  first  ', '', ' ', 'last', ' '], caret: { row: 4, offset: 0 },
  });
});

test('start anchor inverses the first codepoint rather than inserting a blank', () => {
  assert.deepEqual(snapshot('first\nsecond', 0), {
    offset: 0, scrollOffset: 0, rows: ['first', 'second'], caret: { row: 0, offset: 0 },
  });
  assert.deepEqual(snapshot('😀x', 0).rows, ['😀x']);
  assert.deepEqual(snapshot('😀x', 2).caret, { row: 0, offset: 1 });
  assert.deepEqual(snapshot('', 0).rows, [' ']);
  assert.deepEqual(snapshot('\ntext', 0).rows, [' ', 'text']);
});

test('hard-line LF offsets fall back to line zero, unlike a caret at the next line start', () => {
  const text = 'A\nB\nC\nD\nE\nF\nG\nH\nI';
  // G is outside the first page. Its end sits on LF, so Kk unexpectedly
  // scrolls back to zero and clamps the visible caret to the end of F.
  assert.deepEqual(snapshot(text, 13, 2), {
    offset: 13, scrollOffset: 0, rows: ['A', 'B', 'C', 'D', 'E', 'F '], caret: { row: 5, offset: 1 },
  });
  assert.deepEqual(snapshot(text, 14, 0), {
    offset: 14, scrollOffset: 2, rows: ['C', 'D', 'E', 'F', 'G', 'H'], caret: { row: 5, offset: 0 },
  });
  assert.equal(snapshot(text, text.length, 0).scrollOffset, 3);
});

test('empty-line offsets cannot anchor their own page, but EOF anchors the final empty line', () => {
  const text = 'A' + '\n'.repeat(20) + 'Z\n';
  const result = plan(text);
  for (const offset of [2, 8, 15, 20]) {
    const page = result.pages.find(candidate => candidate.offset === offset);
    assert.equal(page.scrollOffset, 0);
    assert.deepEqual(page.caret, { row: Math.min(offset - 1, 5), offset: 0 });
  }
  const z = result.pages.find(page => page.offset === 21);
  assert.equal(z.scrollOffset, 15);
  assert.deepEqual(z.caret, { row: 5, offset: 0 });
  assert.equal(z.rows.at(-1), 'Z');
  const final = result.pages.at(-1);
  assert.equal(final.scrollOffset, 16);
  assert.equal(final.rows.at(-1), ' ');
  assert.deepEqual(final.caret, { row: 5, offset: 0 });
});

test('newline rendering inserts only the actual inverse blank and preserves whitespace', () => {
  assert.deepEqual(snapshot('one\ntwo', 3).rows, ['one ', 'two']);
  assert.deepEqual(snapshot('\n\n', 1).rows, ['', ' ', '']);
  assert.deepEqual(snapshot('\n\n', 2).rows, ['', '', ' ']);
  assert.deepEqual(snapshot('  \n \n', 1).rows, ['  ', ' ', '']);
  assert.deepEqual(snapshot('  \n \n', 1).caret, { row: 0, offset: 1 });
});

test('NFC is applied after ANSI and rejects a composing ANSI terminator instead of inventing a caret', () => {
  const text = 'e\u0301😀\n👩‍💻';
  assert.throws(() => snapshot(text, 0), /ANSI boundary/);
  assert.throws(() => snapshot(text, 1), /ANSI boundary/);
  assert.equal(snapshot(text, 2).rows[0], 'é😀');
  assert.deepEqual(snapshot(text, 2).caret, { row: 0, offset: 1 });
  const tail = snapshot(text, text.length);
  assert.equal(tail.rows[1], '👩‍💻 ');
  assert.deepEqual(tail.caret, { row: 1, offset: 3 });
});

test('full scan observes every raw codepoint boundary and exposes every nonempty hard line', () => {
  for (const text of [Array(30).fill('same').join('\n'), 'A' + '\n'.repeat(30) + 'Z', '\n'.repeat(800),
    Array(15).fill('é😀').join('\n')]) {
    const result = plan(text);
    const expectedOffsets = [0];
    let offset = 0;
    for (const character of text) { offset += character.length; expectedOffsets.push(offset); }
    assert.deepEqual(result.pages.map(page => page.offset), expectedOffsets);
    assert.equal(result.pages[0].movement, undefined);
    assert.equal(result.pages[0].scrollOffset, 0);
    for (let index = 1; index < result.pages.length; index++) {
      const page = result.pages[index];
      assert.deepEqual(page.movement, { direction: 'right', count: expectedOffsets[index] - expectedOffsets[index - 1] });
      assert.equal(page.movement.count <= 2, true);
      assert.deepEqual(page, { ...snapshot(text, page.offset, result.pages[index - 1].scrollOffset), movement: page.movement, capture: true });
    }
    for (let index = 0; index < result.lines.length; index++) {
      const line = result.lines[index];
      if (!line.text) continue;
      const page = result.pages.find(candidate => candidate.offset === line.start);
      assert.equal(index >= page.scrollOffset && index < page.scrollOffset + 6, true);
    }
    assert.equal(result.pages.at(-1).offset, text.length);
    assert.equal(result.pages.at(-1).scrollOffset, Math.max(0, result.lines.length - 6));
  }
});

test('width, text length and malformed cursor boundaries fail before a plan is returned', () => {
  const text = '😀'.repeat(400);
  assert.equal(draftViewportColumns(text), 1608);
  assert.equal(draftViewportPlan(text, 1601).pages.at(-1).caret.offset, 400);
  assert.throws(() => draftViewportPlan(text, 1600), /width/);
  assert.throws(() => plan(text + 'x'), /800/);
  for (const width of [undefined, NaN, 0, 1.5]) assert.throws(() => draftViewportPlan('abc', width), /width/);
  for (const invalid of ['\ud800', '\t', '\r', '\x1b']) assert.throws(() => plan(invalid), /well-formed/);
  for (const offset of [-1, 1, 4, 0.5]) assert.throws(() => snapshot('😀x', offset), /boundaries/);
  assert.throws(() => snapshot('abc', 0, -1), /boundaries/);
});

// These observations are intentionally insufficient for sending authorization.
for (const expected of ['\n'.repeat(6), '\n'.repeat(6) + 'a' + '\n'.repeat(6)]) {
test(`full anchor and codepoint scan traces collide with an extra final LF (${expected.trim() ? 'nonempty' : 'blank'} prompt)`, () => {
  const different = expected + '\n';
  const moves = [-800, -1, 800, 1, -800, ...plan(expected).pages.slice(1).map(page => page.movement.count)];
  function trace(text) {
    let offset = text.length, scrollOffset = Math.max(0, text.split('\n').length - 6);
    return moves.map(move => {
      offset = Math.max(0, Math.min(text.length, offset + move));
      const page = snapshot(text, offset, scrollOffset);
      scrollOffset = page.scrollOffset;
      return { rows: page.rows.map(row => row.replace(/ +$/u, '')), caret: page.caret };
    });
  }
  assert.notEqual(expected, different);
  assert.deepEqual(trace(expected), trace(different));
  if (!expected.trim()) assert.deepEqual(trace(expected).map(page => page.caret.row), [0, 0, 5, 5, 0, 1, 2, 3, 4, 5, 5]);
});
}


test('internal enhanced drafts opt into a bounded length while public column planning stays at 800', () => {
  const original = 'a'.repeat(800), enhanced = original + '!anchor!';
  assert.throws(() => draftViewportColumns(enhanced), /800/);
  assert.throws(() => draftViewportPlan(enhanced, 1700), /800/);
  assert.equal(draftViewportPlan(enhanced, 1700, { maxLength: 1024 }).pages.at(-1).offset, enhanced.length);
  assert.equal(draftViewportSnapshot(enhanced, 1700, { offset: enhanced.length, scrollOffset: 0, maxLength: 1024 }).caret.offset, enhanced.length);
  for (const maxLength of [1025, -1, 1.5]) assert.throws(() => draftViewportPlan('a', 10, { maxLength }), /maximum length/);
});

test('unsafe NFC capture steps retain their actual movements and scroll state', () => {
  const text = 'A\ne\u0301\nB\nC\nD\nE\nF\n!anchor!';
  const result = plan(text);
  const skipped = result.pages.filter(page => page.capture === false);
  assert.deepEqual(skipped.map(page => page.offset), [2, 3]);
  assert.equal(skipped.every(page => page.movement.count === 1 && !page.rows && !page.caret), true);
  assert.equal(result.pages.at(-1).capture, true);
  assert.equal(result.pages.at(-1).offset, text.length);
  assert.throws(() => plan('e\u0301\n!anchor!'), /ANSI boundary/);
});

test('one shared unique suffix distinguishes the blank-run counterexample and inserted or deleted content', () => {
  const suffix = '!UNIQUE_anchor_7!';
  function trace(text, moves) {
    let offset = text.length, scrollOffset = 0;
    return moves.map(move => {
      offset = Math.max(0, Math.min(text.length, offset + move));
      const page = draftViewportSnapshot(text, 200, { offset, scrollOffset, maxLength: 1024 });
      scrollOffset = page.scrollOffset;
      return { rows: page.rows.map(row => row.replace(/ +$/u, '')), caret: page.caret };
    });
  }
  for (const original of ['\n'.repeat(6) + 'a' + '\n'.repeat(6), 'a' + '\n'.repeat(7), '\n'.repeat(7) + 'a', Array(17).fill('same').join('\n')]) {
    const expected = original + suffix;
    const moves = [-1024, -1, 1024, 1, -1024,
      ...draftViewportPlan(expected, 200, { maxLength: 1024 }).pages.slice(1).map(page => page.movement.count), 1];
    const expectedTrace = trace(expected, moves);
    const mutants = new Set([original + '\n'.repeat(7), original + 'same\nsame\n']);
    for (let index = 0; index <= original.length; index++) {
      for (const char of ['\n', ' ', 'a']) mutants.add(original.slice(0, index) + char + original.slice(index));
      if (index < original.length) mutants.add(original.slice(0, index) + original.slice(index + 1));
    }
    for (const mutant of mutants) if (mutant !== original) {
      assert.notDeepEqual(trace(mutant + suffix, moves), expectedTrace, JSON.stringify({ original, mutant }));
    }
  }
});
