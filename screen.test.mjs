import test from 'node:test';
import assert from 'node:assert/strict';
import { needsHistoryCapture, parseCursorScreen } from './screen.mjs';

const reset = '\x1b[0m';
const dim = text => `\x1b[2m${text}${reset}`;
const boxRow = (text, rgb = '242;242;242') => ` ${`\x1b[48;2;${rgb}m`} ${text}${' '.repeat(70)}\x1b[49m`;
const userBox = text => ['', ...text.split('\n'), ''].map(line => boxRow(line, '227;227;227')).join('\n');
const placeholder = text => `\x1b[2m→ \x1b[0;7m\x1b[48;2;242;242;242m${text[0]}\x1b[0;2m\x1b[48;2;242;242;242m${text.slice(1)}`;
function screen({ body = `${userBox('Question')}\n\n  Answer`, input = placeholder('Add a follow-up'), footer = `  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('~')}`, top = true, bottom = true, header = '  Cursor Agent\n  \x1b[2mv2025.01.01-test\x1b[0m' } = {}) {
  return `${header}\n\n${body}\n\n${[
    top ? boxRow('') : null, boxRow(input), bottom ? boxRow('') : null,
  ].filter(row => row !== null).join('\n')}\n\n${footer}\n\n`;
}

function draftScreen(rows, carets = []) {
  const width = 30;
  const painted = rows.map((text, row) => {
    const cells = [...`${row === 0 ? ' → ' : '   '}${text}`.padEnd(width)];
    return ` \x1b[48;2;242;242;242m${cells.map((cell, column) => carets.some(caret =>
      caret.row === row && caret.offset === column - 3)
      ? `\x1b[7m${cell}\x1b[27m` : cell).join('')}\x1b[49m`;
  });
  const border = ` \x1b[48;2;242;242;242m${' '.repeat(width)}\x1b[49m`;
  return `Cursor Agent\nv2025.01.01-test\n${border}\n${painted.join('\n')}\n${border}\n${dim('Composer 2.5 · 5.1%')}\n${dim('~')}\n`;
}

test('a complete bottom question box is observation-only and never grants typing readiness', () => {
  const raw = `Cursor Agent\nv2025.01.01-test\n${userBox('A current question')}\nA partial reply\n
 ┌─────────────────────────────────────────────────────────────────────────────────────┐
 │ Clarifying Questions                                                                │
 │ Question 1 of 2                                                                     │
 │ 1. What should happen next?                                                         │
 │   › [ ] Keep waiting                                                               │
 │     [ ] Other: (type to answer)                                                     │
 │ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip            │
 └─────────────────────────────────────────────────────────────────────────────────────┘\n`;
  const parsed = parseCursorScreen(raw, { knownCursor: true });
  assert.equal(parsed.waitingForQuestion, true);
  assert.equal(parsed.reason, 'question-awaiting-answer');
  assert.equal(parsed.inputAvailable, false);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.busy, false);
  assert.equal(parsed.stopKey, null);
  assert.match(parsed.currentReplyBody, /Clarifying Questions/);
  for (const altered of [raw.replace('Clarifying Questions', 'Unrecognized Menu'), raw.replace('Question 1 of 2', 'Question 3 of 2'),
    raw.replace('Esc to skip', 'Esc to close'), raw.replace('└', '┌'), `${raw}\nAnother overlay`, raw.replaceAll('[ ]', '[?]'),
    raw.replace('Cursor Agent', 'Cursor Agent Preview')]) {
    assert.equal(parseCursorScreen(altered, { knownCursor: true }).waitingForQuestion, false);
  }
});

test('recognizes the real default-theme placeholder with inverse caret', () => {
  const parsed = parseCursorScreen(screen());
  assert.equal(parsed.ready, true);
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.busy, false);
  assert.equal(parsed.stopKey, null);
  assert.equal(parsed.inputEmpty, true);
  assert.equal(parsed.inputAvailable, true);
  assert.equal(parsed.prompt, '');
  assert.equal(parsed.inputText, '→ Add a follow-up');
  assert.equal(parsed.modelName, 'Composer 2.5');
  assert.equal(parsed.text.includes('\x1b'), false);
  assert.equal(parsed.body.includes('Add a follow-up'), false);
  assert.deepEqual(parsed.userMessages, ['Question']);
  assert.match(parsed.currentTurnBody, /Question\n\n\s*Answer$/);
  assert.equal(parsed.currentReplyBody, 'Answer');
});

test('observes the exact empty slash palette without granting input or a model', () => {
  const raw = draftScreen(['', '# Files mentioned by the user:', '', '## clip.mp4: /fixture/clip.mp4', '', 'Read the attachment.'], [{ row: 3, offset: 13 }]);
  const palette = raw.replace(`${dim('Composer 2.5 · 5.1%')}\n${dim('~')}`, `     ${dim('No matches')}`);
  const parsed = parseCursorScreen(palette);
  assert.equal(parsed.inputCompletion, 'no-matches');
  assert.equal(parsed.reason, 'unrecognized-footer-or-overlay');
  assert.equal(parsed.inputAvailable, false);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.modelName, null);
  assert.deepEqual(parsed.inputDraft.caret, { row: 3, offset: 13 });
  for (const footer of ['     No matches', `    ${dim('No matches')}`, `     ${dim('No matches!')}`,
    `     ${dim('No matches')}\nAllow this command?`, `     ${dim('No matches')}\n${dim('~')}`]) {
    assert.equal(parseCursorScreen(palette.replace(`     ${dim('No matches')}`, footer)).inputCompletion, null);
  }
  assert.equal(parseCursorScreen(palette.replace(/\x1b\[7m|\x1b\[27m/gu, '')).inputCompletion, null);
  assert.equal(parseCursorScreen(palette.replace('→ ', '> ')).inputCompletion, null);
  assert.equal(parseCursorScreen(palette.replace('Cursor Agent', 'Other Agent')).inputCompletion, null);
});

test('recognizes a fresh empty prompt and supported model/path footers', () => {
  const parsed = parseCursorScreen(screen({
    input: placeholder('Plan, search, build anything'),
    footer: ` ${dim('Claude Sonnet 4.6 · 0%')}\n ${dim('/home/testuser/project with spaces')}`,
  }));
  assert.equal(parsed.ready, true);
});

test('recognizes real edited-file counts and the existing permission-mode badge', () => {
  for (const [model, edited] of [['Auto Balance', '36 files edited'], ['Claude Opus 5.5 300K Medium', '1 file edited']]) {
    const parsed = parseCursorScreen(screen({ footer:
      `  ${dim(`${model} · 31.5% · ${edited}`)}                 \x1b[35mRun Everything\x1b[39m\n  ${dim('/data/workspace')}`,
    }));
    assert.equal(parsed.ready, true);
    assert.equal(parsed.modelName, model);
  }
});

test('recognizes a hard-wrapped cwd and branch only at the frame edge', () => {
  // This fixture's blank input row is 72 columns wide, including its margin.
  const cwdFirst = `  /${'a'.repeat(69)}`;
  const footer = `  ${dim('Auto Balance · 86.3% · 36 files edited')}   \x1b[35mRun Everything\x1b[39m\n${dim(cwdFirst)}\n  ${dim('studio · feat/bench')}`;
  assert.equal(parseCursorScreen(screen({ footer })).ready, true);
  assert.equal(parseCursorScreen(screen({ footer: footer.replace('a'.repeat(69), 'a'.repeat(68)) })).ready, false);
  assert.equal(parseCursorScreen(screen({ footer: footer.replace('studio · feat/bench', 'Always allow') })).ready, false);
  assert.equal(parseCursorScreen(screen({ footer: footer.replace('studio · feat/bench', 'Allow') })).ready, false);
});

test('recognizes a wrapped branch separator after a space at the frame edge', () => {
  // The final separator space occupies column 72 even though display text
  // trims it. Both rows are synthetic and use the same two-column indent.
  const cwdFirst = `  /${'a'.repeat(68)} `;
  for (const separator of ['·', '•']) {
    const footer = `  ${dim('Composer 2.5 · 5.1%')}\n${dim(cwdFirst)}\n  ${dim(`${separator} feat/example`)}`;
    assert.equal(parseCursorScreen(screen({ footer })).ready, true);
    const draft = parseCursorScreen(screen({ footer, input: '→ unfinished draft' }));
    assert.equal(draft.ready, false);
    assert.equal(draft.inputAvailable, true);
    assert.equal(draft.reason, 'input-has-draft');
  }
});

test('wrapped branch rows require exact edge geometry, dim styling and branch syntax', () => {
  const cwdFirst = `  /${'a'.repeat(68)} `;
  const row = `  ${dim('· feat/example')}`;
  const footer = (cwd, continuation) => `  ${dim('Composer 2.5 · 5.1%')}\n${cwd}\n${continuation}`;
  for (const [cwd, continuation] of [
    [dim(cwdFirst.trimEnd()), row],
    [dim(`${cwdFirst.trimEnd()}a`), row],
    [dim(`  /${'a'.repeat(67)}  `), row],
    [dim(`  /${'a'.repeat(67)} `), row],
    [dim(`${cwdFirst} `), row],
    [dim(cwdFirst.replace('a', '界')), row],
    [cwdFirst, row],
    [dim(cwdFirst), '  · feat/example'],
    [dim(cwdFirst), ` ${dim('· feat/example')}`],
    [dim(cwdFirst), `  ${dim('feat/example')}`],
    [dim(cwdFirst), `  ${dim('· feat/example extra')}`],
    [dim(cwdFirst), `  ${dim('· Allow')}`],
    [dim(cwdFirst), `  ${dim('· Continue')}`],
    [dim(cwdFirst), `  ${dim('· feat/example')}\n  ${dim('Allow')}`],
  ]) {
    const parsed = parseCursorScreen(screen({ footer: footer(cwd, continuation) }));
    assert.equal(parsed.inputAvailable, false);
    assert.equal(parsed.reason, 'unrecognized-footer-or-overlay');
  }
});

test('recognizes a branch wrapped after the complete separator at the frame edge', () => {
  // The final space of " · " occupies column 72; only the branch moves down.
  for (const separator of ['·', '•']) {
    const path = `  /${'a'.repeat(66)} ${separator} `;
    const footer = `  ${dim('Gemini 4 Argon Medium · 35.9% · 1 file edited')}   \x1b[35mRun Everything\x1b[39m\n${dim(path)}\n  ${dim('feat/example')}`;
    const parsed = parseCursorScreen(screen({ footer }));
    assert.equal(parsed.ready, true);
    assert.equal(parsed.inputEmpty, true);
    assert.equal(parsed.modelName, 'Gemini 4 Argon Medium');
    const draft = parseCursorScreen(screen({ footer, input: '→ Keep this draft' }));
    assert.equal(draft.ready, false);
    assert.equal(draft.reason, 'input-has-draft');
  }
});

test('a separator at the previous edge cannot disguise padding, menus or approval rows', () => {
  const path = `  /${'a'.repeat(66)} · `;
  const row = `  ${dim('feat/example')}`;
  const footer = (path, branch) => `  ${dim('Gemini 4 Argon Medium · 35.9%')}\n${path}\n${branch}`;
  for (const [previous, next] of [
    [dim(path.trimEnd()), row],
    [dim(`${path} `), row],
    [dim(path.replace(' · ', '·  ')), row],
    [dim(path.replace('a', '')), row],
    [dim(path.replace('a', 'aa')), row],
    [dim(path.replace('a', '界')), row],
    [path, row],
    [dim(path), '  feat/example'],
    [dim(path), ` ${dim('feat/example')}`],
    [dim(path), `  ${dim('· feat/example')}`],
    [dim(path), `  ${dim('feat/example extra')}`],
    [dim(path), `  ${dim('feat/example · other')}`],
    ...['Allow', 'Always', 'Continue', 'yes', 'Enter', 'Escape'].map(value => [dim(path), `  ${dim(value)}`]),
    [dim(path), `${row}\n  ${dim('Allow')}`],
    [dim(path), `${row}\n  Allow this command? [y/n]`],
  ]) {
    const parsed = parseCursorScreen(screen({ footer: footer(previous, next) }));
    assert.equal(parsed.inputAvailable, false);
    assert.equal(parsed.reason, 'unrecognized-footer-or-overlay');
  }
});

test('status badges cannot disguise approvals, unknown labels, or unstyled menus', () => {
  for (const status of ['\x1b[35mAllow command?\x1b[39m', 'Run Everything', '\x1b[2mRun Everything\x1b[0m']) {
    const footer = ` ${dim('Composer 2.5 · 5.1% · 2 files edited')}   ${status}\n ${dim('/data/workspace')}`;
    assert.equal(parseCursorScreen(screen({ footer })).inputAvailable, false);
  }
});

test('a busy stop hint in the actual input frame blocks sending', () => {
  const parsed = parseCursorScreen(screen({ input: `${placeholder('Add a follow-up')}    ctrl+c to stop` }));
  assert.equal(parsed.ready, false);
  assert.equal(parsed.busy, true);
  assert.equal(parsed.blocked, true);
  assert.equal(parsed.reason, 'agent-busy');
  assert.equal(parsed.stopKey, 'C-c');
});

test('stop keys come from trusted input/footer hints and match the displayed shortcut', () => {
  const escape = parseCursorScreen(screen({ footer: `${dim('esc to stop')}` }));
  assert.equal(escape.busy, true);
  assert.equal(escape.stopKey, 'Escape');
  const control = parseCursorScreen(screen({ footer: `${dim('Ctrl + C to stop')}` }));
  assert.equal(control.stopKey, 'C-c');
  for (const raw of [
    screen({ header: 'Cursor Agent\nvunknown', input: `${placeholder('Add a follow-up')} ctrl+c to stop` }),
    screen({ top: false, input: `${placeholder('Add a follow-up')} ctrl+c to stop` }),
    screen({ input: `${placeholder('Add a follow-up')} ctrl+c to stop` }).replaceAll('242;242;242', '40;40;40'),
  ]) assert.equal(parseCursorScreen(raw).stopKey, null);
});

test('normal drafts and a draft spelling the exact placeholder are never empty', () => {
  for (const input of ['→ Please continue', '→ Add a follow-up', '→ Plan, search, build anything', '\x1b[2m→ \x1b[22mAdd a follow-up']) {
    const parsed = parseCursorScreen(screen({ input }));
    assert.equal(parsed.ready, false, input);
    assert.equal(parsed.inputEmpty, false, input);
    assert.equal(parsed.reason, 'input-has-draft', input);
    assert.notEqual(parsed.prompt, '', input);
  }
});

test('shell mode is never eligible for chat input', () => {
  const parsed = parseCursorScreen(screen({ input: '\x1b[2m> Add a follow-up' }));
  assert.equal(parsed.ready, false);
  assert.equal(parsed.inputEmpty, false);
  assert.equal(parsed.reason, 'unrecognized-input-mode');
});

test('only a verified Cursor process may waive a scrolled-out header', () => {
  const raw = screen({ header: '' });
  assert.equal(parseCursorScreen(raw).ready, false);
  assert.equal(parseCursorScreen(raw, { knownCursor: true }).ready, true);
  assert.equal(parseCursorScreen(raw, { knownCursor: 'true' }).ready, false);
  for (const header of ['Cursor Agent\nvunknown', 'Cursor Agent unexpected\nv2025.01.01-test']) {
    assert.equal(parseCursorScreen(screen({ header }), { knownCursor: true }).ready, false);
  }
});

test('multi-line pasted drafts expose the entire input for exact verification', () => {
  const input = `→ Line one\n${boxRow('第二行 👩🏽‍💻')}`;
  const parsed = parseCursorScreen(screen({ input }));
  assert.equal(parsed.ready, false);
  assert.equal(parsed.inputEmpty, false);
  assert.equal(parsed.inputAvailable, true);
  assert.equal(parsed.reason, 'input-has-draft');
  assert.equal(parsed.inputText, '→ Line one\n第二行 👩🏽‍💻');
  assert.equal(parsed.prompt, 'Line one\n第二行 👩🏽‍💻');
});

test('draft rows retain a trailing newline that display text trims away', () => {
  const parsed = parseCursorScreen(draftScreen(['ab', ''], [{ row: 1, offset: 0 }]));
  assert.equal(parsed.inputText, '→ ab');
  assert.equal(parsed.prompt, 'ab');
  assert.equal(parsed.inputAvailable, true);
  assert.equal(parsed.inputDraft.rows.length, 2);
  assert.equal(parsed.inputDraft.rows[0], 'ab'.padEnd(27));
  assert.equal(parsed.inputDraft.rows[1], ' '.repeat(27));
  assert.deepEqual(parsed.inputDraft.caret, { row: 1, offset: 0 });
  assert.equal(parsed.inputDraft.width, 25);
});

test('draft rows preserve leading blank lines, indentation and trailing spaces', () => {
  const parsed = parseCursorScreen(draftScreen(['', '  indented  ', '', '  '], [{ row: 3, offset: 2 }]));
  assert.deepEqual(parsed.inputDraft.rows, [
    ' '.repeat(27), '  indented  '.padEnd(27), ' '.repeat(27), ' '.repeat(27),
  ]);
  assert.deepEqual(parsed.inputDraft.caret, { row: 3, offset: 2 });
});

test('draft caret offsets count Unicode codepoints without stripping their text', () => {
  const parsed = parseCursorScreen(draftScreen(['  中文 🧪'], [{ row: 0, offset: 6 }]));
  assert.equal(parsed.inputDraft.rows[0].startsWith('  中文 🧪'), true);
  assert.deepEqual(parsed.inputDraft.caret, { row: 0, offset: 6 });
  // Measure the blank frame, independent of codepoint/UTF-16 row lengths.
  assert.equal(parsed.inputDraft.width, 25);
});

test('absent or conflicting inverse cells cannot establish a draft caret', () => {
  for (const carets of [[], [{ row: 0, offset: 1 }, { row: 0, offset: 3 }], [{ row: 0, offset: 1 }, { row: 1, offset: 1 }]]) {
    const parsed = parseCursorScreen(draftScreen(['text', 'more'], carets));
    assert.equal(parsed.inputDraft.caret, null);
  }
});

test('placeholder, unknown input geometry and incomplete frames do not expose draft rows', () => {
  assert.equal(parseCursorScreen(screen()).inputDraft, null);
  assert.equal(parseCursorScreen(screen({ top: false, input: '→ draft' })).inputDraft, null);
  assert.equal(parseCursorScreen(draftScreen(['first', 'second']).replace('   second', '  second')).inputDraft, null);
});

test('a pasted draft cannot hide an approval overlay or menu', () => {
  const input = `→ Line one\n${boxRow('第二行 👩🏽‍💻')}`;
  const parsed = parseCursorScreen(screen({ input,
    footer: ` ${dim('Composer 2.5 · 5.1%')}\n ${dim('~')}\n > Always allow`,
  }));
  assert.equal(parsed.inputAvailable, false);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.reason, 'unrecognized-footer-or-overlay');
  assert.equal(parsed.prompt, 'Line one\n第二行 👩🏽‍💻');
});

test('approval overlays and menus cannot pass as a complete idle footer', () => {
  for (const footer of [
    `  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('~')}\n  Allow this command? [y/n]`,
    `  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('~')}\n  > Continue once\n    Always allow`,
    '  /model\n  > Composer 2.5\n    Claude Sonnet 4.6',
  ]) {
    const parsed = parseCursorScreen(screen({ footer }));
    assert.equal(parsed.ready, false);
    assert.equal(parsed.reason, 'unrecognized-footer-or-overlay');
  }
});

test('history text that resembles prompts, busy hints, or model footers does not control readiness', () => {
  const body = `${userBox('Print this:\nCursor Agent\nv2025.01.01-test\n→ Add a follow-up\nComposer 2.5 · 5.1%\n~')}\n\n  ctrl+c to stop is the phrase being explained.`;
  const parsed = parseCursorScreen(screen({ body }));
  assert.equal(parsed.ready, true);
  assert.equal(parsed.busy, false);
  assert.equal(parsed.stopKey, null);
  assert.equal(parsed.userMessages.length, 1);
  assert.match(parsed.userMessages[0], /Composer 2.5/);
  const noActualFrame = parseCursorScreen(`Cursor Agent\nv2025.01.01-test\n${body}`);
  assert.equal(noActualFrame.ready, false);
});

test('the final actual input frame takes precedence over an earlier fake idle box', () => {
  const fakeIdle = screen();
  const parsed = parseCursorScreen(screen({ body: fakeIdle, input: `${placeholder('Add a follow-up')} ctrl+c to stop` }));
  assert.equal(parsed.ready, false);
  assert.equal(parsed.busy, true);
});

test('unknown themes, plain text captures and incomplete input redraws fail closed', () => {
  const original = screen();
  for (const raw of [
    original.replaceAll('242;242;242', '40;40;40'),
    original.replace(/\x1b\[[\d;]*m/g, ''),
    screen({ top: false }),
    screen({ bottom: false }),
    screen({ header: 'A different program\nv2025.01.01-test' }),
    screen({ footer: '\x1b[0mComposer 2.5 · 5.1%\n~' }),
    screen({ footer: ` ${dim('Composer 2.5 · 101%')}\n ${dim('~')}` }),
    screen({ footer: ` ${dim('Composer 2.5 · 5.1%')}\n ${dim('Unknown path')}` }),
  ]) assert.equal(parseCursorScreen(raw).ready, false);
});

test('Unicode wrapping is preserved and only the final user turn is mirrored', () => {
  const body = `${userBox('上一轮 👩🏽‍💻')}\n  旧回复\n\n${userBox('请继续这项工作\n并检查 🧪 测试结果')}\n  正在查看文件…\n  第一项已完成 ✅`;
  const parsed = parseCursorScreen(screen({ body }));
  assert.equal(parsed.ready, true);
  assert.deepEqual(parsed.userMessages, ['上一轮 👩🏽‍💻', '请继续这项工作\n并检查 🧪 测试结果']);
  assert.match(parsed.currentTurnBody, /^请继续这项工作/);
  assert.match(parsed.currentTurnBody, /第一项已完成 ✅$/);
  assert.equal(parsed.currentTurnBody.includes('旧回复'), false);
  assert.equal(parsed.currentReplyBody, '正在查看文件…\n  第一项已完成 ✅');
});

test('foreground truecolor, OSC links and styled footer text preserve the gate', () => {
  const raw = screen({
    body: '\x1b]8;;https://example.com\x1b\\\x1b[38;2;2;242;242mLinked answer\x1b]8;;\x1b\\\x1b[0m',
    footer: ` ${dim('Gemini 3.1 Pro · 12.3%')}\n ${dim('/home/testuser/实验 🧪')}`,
  });
  const parsed = parseCursorScreen(raw);
  assert.equal(parsed.ready, true);
  assert.equal(parsed.body.includes('https://example.com'), false);
  assert.match(parsed.body, /Linked answer$/);
  assert.equal(parsed.currentReplyBody, '');
});


test('history capture fallback requires an empty user list and a supported exact observation state', () => {
  const busy = { userMessages: [], ready: false, inputAvailable: false, busy: true,
    waitingForQuestion: false, stopKey: 'C-c', reason: 'agent-busy' };
  const question = { ...busy, busy: false, waitingForQuestion: true, stopKey: null, reason: 'question-awaiting-answer' };
  const idle = { ...busy, ready: true, inputAvailable: true, busy: false, stopKey: null, reason: 'ready' };
  const draft = { ...idle, ready: false, reason: 'input-has-draft' };
  for (const supported of [busy, { ...busy, stopKey: 'Escape' }, question, idle, draft]) {
    assert.equal(needsHistoryCapture(supported), true);
    assert.equal(needsHistoryCapture({ ...supported, userMessages: ['Already visible'] }), false);
    assert.equal(needsHistoryCapture({ ...supported, userMessages: [null] }), false);
    assert.equal(needsHistoryCapture({ ...supported, userMessages: null }), false);
    assert.equal(needsHistoryCapture({ ...supported, userMessages: '' }), false);
    assert.equal(needsHistoryCapture({ ...supported, reason: 'unrecognized-footer-or-overlay' }), false);
  }
  for (const unsupported of [undefined, null, {}, [],
    { ...busy, ready: true }, { ...busy, inputAvailable: true }, { ...busy, busy: 'true' },
    { ...busy, stopKey: 'Enter' }, { ...busy, stopKey: null },
    { ...question, waitingForQuestion: false }, { ...question, waitingForQuestion: 'true' },
    { ...question, stopKey: 'Escape' }, { ...question, inputAvailable: true },
    { ...idle, ready: false }, { ...idle, inputAvailable: false }, { ...idle, stopKey: 'C-c' },
    { ...draft, ready: true }, { ...draft, busy: true }]) {
    assert.equal(needsHistoryCapture(unsupported), false, JSON.stringify(unsupported));
  }
});
