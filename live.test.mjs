import test from 'node:test';
import assert from 'node:assert/strict';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { TmuxSession, multilineVerificationDetails } from './live.mjs';
import { UNSUBMITTED_DRAFT_ERROR, UNSUBMITTED_ANCHORED_DRAFT_ERROR } from './draft-recovery.mjs';
import { parseCursorScreen } from './screen.mjs';
import { parseTranscript } from './history.mjs';

// These frames reproduce Cursor's default light-theme capture-pane -e output:
// user messages use a grey background, while the prompt has an inverse caret.
const reset = '\x1b[0m';
const dim = text => `\x1b[2m${text}${reset}`;
const row = (text, rgb = '242;242;242') => ` \x1b[48;2;${rgb}m ${text}${' '.repeat(70)}\x1b[49m`;
const userBox = text => ['', ...text.split('\n'), ''].map(line => row(line, '227;227;227')).join('\n');
const placeholder = text => `\x1b[2m→ \x1b[0;7m\x1b[48;2;242;242;242m${text[0]}\x1b[0;2m\x1b[48;2;242;242;242m${text.slice(1)}`;
function frame({ prompt = 'Earlier question', answer = 'Earlier answer', busy = false, input, footer, prior = [] } = {}) {
  const inputText = input ?? `${placeholder('Add a follow-up')}${busy ? '    ctrl+c to stop' : ''}`;
  const inputRows = input?.startsWith('→ ') ? inputText.split('\n').map((line, index, lines) => row(
    `${index ? '  ' : ''}${line}${index === lines.length - 1 ? '\x1b[7m \x1b[27m' : ''}`,
  )).join('\n') : row(inputText);
  const preceding = prior.map(message => `${userBox(message.prompt)}\n\n  ${message.answer}\n\n`).join('');
  return `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${preceding}${userBox(prompt)}\n\n  ${answer}\n\n${row('')}\n${inputRows}\n${row('')}\n\n${footer ?? `  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('~')}`}\n\n`;
}

const binding = { paneId: '%7', panePid: 100, agentPid: 101, agentStartTime: '554433', sessionId: '11111111-2222-4333-8444-555555555555', cwd: '/fixture/project' };
const turn = (id, prompt, answer = 'Canonical reply') => ({
  id, status: 'completed', startedAt: 100, completedAt: 101,
  items: [
    { id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text: prompt }] },
    { id: `${id}-answer`, type: 'agentMessage', text: answer },
  ],
});
const history = (turns, sourceComplete = true, id = binding.sessionId) => ({ id, cwd: binding.cwd, turns, sourceComplete });

class MockTmuxClient {
  constructor(raw = frame()) {
    this.raw = raw;
    this.calls = [];
    this.captures = 0;
    this.minimumColumnRequests = [];
    this.submitted = new Promise(resolve => { this.didSubmit = resolve; });
  }

  async capture(paneId) {
    assert.equal(paneId, binding.paneId);
    this.captures++;
    return this.raw;
  }

  async paste(paneId, text, options) {
    this.minimumColumnRequests.push(options.minimumColumns);
    this.calls.push({ type: 'paste-request', paneId, text, sessionId: options.sessionId });
    await this.beforeGuard?.();
    await options.beforePaste();
    this.calls.push({ type: 'paste', paneId, text });
    this.raw = this.pastedFrame ?? frame({ input: `→ ${text}` });
    await options.afterPaste();
    this.calls.push({ type: 'Enter', paneId });
    this.didSubmit();
  }

  async cancel(paneId, options) { this.calls.push({ type: 'cancel', paneId, ...options }); }
  async readPastedTexts(current) {
    assert.equal(current, binding);
    this.pasteReads = (this.pasteReads || 0) + 1;
    return typeof this.pastedTexts === 'function' ? this.pastedTexts() : this.pastedTexts || { entries: {} };
  }
  async submitDraft(paneId, { sessionId, beforeSubmit, minimumColumns }) {
    this.minimumColumnRequests.push(minimumColumns);
    this.calls.push({ type: 'submit-draft-request', paneId, sessionId });
    await this.beforeSubmitGuard?.();
    await beforeSubmit();
    this.calls.push({ type: 'Enter', paneId });
    this.didSubmit();
  }
  async kill() { this.calls.push({ type: 'kill' }); }
  async close() { this.calls.push({ type: 'client-close' }); }
}

// All contents are synthetic. Cursor reserves seven terminal columns around
// its input, and keeps only the last six visual rows of an uncollapsed draft.
const narrowWrapper = `<codex_delegation>\n  <source_thread_id>00000000-1111-4222-8333-444444444444</source_thread_id>\n  <input>${'R'.repeat(260)}</input>\n</codex_delegation>`;
function sizedFrame(columns, draft = null, overlay = '') {
  const inputWidth = columns - 7;
  const paint = text => {
    return ` \x1b[48;2;242;242;242m${text}${' '.repeat(Math.max(0, columns - 2 - stringWidth(text)))}\x1b[49m`;
  };
  const rows = draft === null ? [` ${placeholder('Add a follow-up')}`]
    : `${draft}\x1b[7m \x1b[27m`.split('\n').flatMap(line =>
      wrapAnsi(line, inputWidth, { trim: false, hard: true }).split('\n')
        .map((part, index) => index ? part.replace(/^ +/u, '') : part))
      .slice(-6).map((part, index) => ` ${index ? '  ' : '→ '}${part}`);
  return `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${userBox('Earlier question')}\n\n  Earlier answer\n\n${paint('')}\n${rows.map(paint).join('\n')}\n${paint('')}\n\n  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('/fixture/project')}\n${overlay}\n`;
}

class NarrowTmuxClient extends MockTmuxClient {
  constructor(draft = null) {
    super();
    this.columns = 93;
    this.draft = draft;
    this.overlay = '';
    this.columnTransactions = [];
  }

  async capture(paneId) {
    this.raw = sizedFrame(this.columns, this.draft, this.overlay);
    return super.capture(paneId);
  }

  async withColumns(minimumColumns, callback) {
    this.minimumColumnRequests.push(minimumColumns);
    const original = this.columns;
    this.columns = Math.max(original, minimumColumns ?? original);
    const transaction = { requested: minimumColumns, active: this.columns };
    this.columnTransactions.push(transaction);
    try { return await callback(); }
    finally { this.columns = original; transaction.restored = this.columns; }
  }

  async paste(paneId, text, options) {
    this.calls.push({ type: 'paste-request', paneId, text, sessionId: options.sessionId });
    return this.withColumns(options.minimumColumns, async () => {
      await this.beforeGuard?.();
      await options.beforePaste();
      this.calls.push({ type: 'paste', paneId, text });
      this.draft = this.alterPastedText?.(text) ?? text;
      await this.afterPasteGuard?.();
      await options.afterPaste();
      this.calls.push({ type: 'Enter', paneId });
      this.didSubmit();
    });
  }

  async submitDraft(paneId, options) {
    this.calls.push({ type: 'submit-draft-request', paneId, sessionId: options.sessionId });
    return this.withColumns(options.minimumColumns, async () => {
      await this.beforeSubmitGuard?.();
      await options.beforeSubmit();
      this.calls.push({ type: 'Enter', paneId });
      this.didSubmit();
    });
  }
}

// An independently captured layout counterexample, using only synthetic text.
// Cursor's scroll layout produces seven rows at input width 86, although Ink
// alone produces five. The TUI drops the first 43 CJK characters before Ink.
const preclippedPrompt = Array(3).fill('中'.repeat(44)).join(' ') + '\n';
const preclippedViewport = `中 \n${'中'.repeat(43)}\n中 \n${'中'.repeat(43)}\n中\n`;
class PreclippedTmuxClient extends NarrowTmuxClient {
  async capture(paneId) {
    if (this.draft === preclippedPrompt && this.columns === 93) {
      this.raw = sizedFrame(this.columns, preclippedViewport, this.overlay);
      return MockTmuxClient.prototype.capture.call(this, paneId);
    }
    return super.capture(paneId);
  }
}

// Independent no-soft-wrap transcription of Cursor's observed layout: LF and
// empty-line offsets miss its half-open line lookup and fall back to line zero.
// This fake transports exact cursor keys and edits; it never calls the planner.
class PagedTmuxClient extends NarrowTmuxClient {
  constructor(draft = null) {
    super(draft);
    this.offset = draft?.length || 0;
    this.scroll = 0;
    this.leaseChecks = 0;
    this.fullLeaseChecks = 0;
    this.marker = null;
    this.leaseActive = true;
    this.footer = 'Composer 2.5 · 5.1%';
  }

  async capture(paneId) {
    if (this.draft === null) return super.capture(paneId);
    const lines = [];
    let start = 0;
    for (const text of this.draft.split('\n')) {
      lines.push({ text, start, end: start + text.length });
      start += text.length + 1;
    }
    const selected = this.offset >= this.draft.length ? lines.length - 1
      : Math.max(0, lines.findIndex(line => this.offset >= line.start && this.offset < line.end));
    if (selected < this.scroll) this.scroll = selected;
    else if (selected >= this.scroll + 6) this.scroll = selected - 5;
    this.scroll = Math.max(0, Math.min(this.scroll, lines.length - 6));
    const visible = lines.slice(this.scroll, this.scroll + 6);
    const text = visible.map(line => line.text).join('\n');
    const caret = Math.max(0, Math.min(this.offset - visible[0].start, text.length));
    let output = '', index = 0, inverse = false;
    const cursor = value => `\x1b[7m${value}\x1b[27m`;
    for (const character of text) {
      if (character === '\n') {
        if (!inverse && caret === index && (index === 0 || text[index - 1] !== '\n')) { output += cursor(' '); inverse = true; }
        output += '\n'; index++;
        if (!inverse && caret === index && (text[index] === '\n' || text[index] === undefined)) { output += cursor(' '); inverse = true; }
      } else {
        if (index === caret) { output += cursor(character); inverse = true; } else output += character;
        index += character.length;
      }
    }
    if (!inverse && caret === text.length) output += cursor(' ');
    const paint = value => ` \x1b[48;2;242;242;242m${value}${' '.repeat(Math.max(0, this.columns - 2 - stringWidth(value)))}\x1b[49m`;
    const completion = this.completionAt?.(this.offset, this.draft);
    if (completion) this.completionFrames = (this.completionFrames || 0) + 1;
    const footer = completion ? `     ${dim(this.completionLabel || 'No matches')}`
      : `  ${dim(this.footer)}\n  ${dim('/fixture/project')}`;
    this.raw = `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${userBox('Earlier question')}\n  Earlier answer\n\n${paint('')}\n${output.normalize().split('\n').map((value, i) => paint(` ${i ? '  ' : '→ '}${value}`)).join('\n')}\n${paint('')}\n\n${footer}\n${this.overlay}\n`;
    this.raw = this.alterDraftFrame?.(this.raw) ?? this.raw;
    return MockTmuxClient.prototype.capture.call(this, paneId);
  }

  lease() {
    return {
      assertActive: async options => { this.leaseChecks++; if (options?.full) this.fullLeaseChecks++; await this.onLeaseCheck?.(); if (!this.leaseActive) throw new Error('Input lease ownership changed'); },
      moveCursor: async (direction, count) => {
        assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 800);
        this.offset = Math.max(0, Math.min(this.draft.length, this.offset + (direction === 'left' ? -count : count)));
        this.calls.push({ type: 'move', direction, count });
        await this.onMove?.();
      },
      typeAscii: async suffix => {
        assert.match(suffix, /^[0-9a-f]{32}$/u);
        assert.equal(this.marker, null);
        this.marker = suffix;
        this.draft = this.draft.slice(0, this.offset) + suffix + this.draft.slice(this.offset);
        this.offset += suffix.length;
        this.calls.push({ type: 'marker' });
        await this.onMarker?.();
      },
      adoptAsciiMarker: async suffix => { assert.equal(this.marker, null); this.marker = suffix; this.calls.push({ type: 'adopt' }); },
      backspace: async count => {
        assert.equal(count, this.marker?.length);
        assert.equal(this.draft.slice(this.offset - count, this.offset), this.marker);
        this.draft = this.draft.slice(0, this.offset - count) + this.draft.slice(this.offset);
        this.offset -= count;
        this.marker = null;
        this.calls.push({ type: 'remove-marker' });
        await this.onRemoveMarker?.();
      },
    };
  }

  async paste(paneId, text, options) {
    assert.equal(options.exclusiveInput, true);
    this.calls.push({ type: 'paste-request' });
    return this.withColumns(options.minimumColumns, async () => {
      const lease = this.lease();
      await options.beforePaste(lease);
      this.draft = this.alterPastedText?.(text) ?? text;
      this.offset = this.draft.length;
      this.calls.push({ type: 'paste', text });
      await options.afterPaste(lease);
      assert.equal(this.marker, null);
      this.calls.push({ type: 'Enter' }); this.didSubmit();
    });
  }

  async submitDraft(paneId, options) {
    assert.equal(options.exclusiveInput, true);
    this.calls.push({ type: 'submit-draft-request' });
    return this.withColumns(options.minimumColumns, async () => {
      await options.beforeSubmit(this.lease());
      assert.equal(this.marker, null);
      this.calls.push({ type: 'Enter' }); this.didSubmit();
    });
  }
}

async function start(t, { client = new MockTmuxClient(), source = history([turn('old', 'Earlier question', 'Earlier answer')]), sourceTurnIds = [], models, modelDefinitions } = {}) {
  const session = new TmuxSession({ client, binding, model: 'composer-2.5[fast=true]', models, modelDefinitions, history: source, sourceTurnIds, interval: 60_000,
    now: () => Date.UTC(2026, 9, 19, 11, 0) });
  t.after(() => session.close());
  const result = await session.start();
  return { session, client, result };
}

function markSourceStarted(session, id, prompt) {
  const unfinished = { ...turn(id, prompt, ''), status: 'inProgress' };
  delete unfinished.completedAt;
  session.acceptHistory(history([...(session.history?.turns || []).filter(source => source.id !== id), unfinished], false));
  return unfinished;
}

for (const partialTail of [false, true]) {
  test(`observer startup suppresses a stale busy completed source${partialTail ? ' with a partial transcript tail' : ''}`, async t => {
    const completed = turn('startup-completed', 'Already done', 'Canonical answer');
    const source = history([completed], !partialTail);
    if (partialTail) source.completedTurnIds = [completed.id];
    const client = new MockTmuxClient(frame({ prompt: 'Already done', answer: 'Canonical answer', busy: true }));
    const session = new TmuxSession({ client, binding, model: 'composer-2.5[fast=true]', history: source, interval: 60_000 });
    t.after(() => session.close());
    const external = [];
    session.on('externalTurn', event => external.push(event));
    await session.start();
    await session.poll();
    assert.deepEqual(external, []);
    assert.equal(session.pending, null);
    assert.deepEqual(client.calls, []);
  });
}

test('completion followed by idle and stale busy redraw cannot duplicate an external turn', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
  markSourceStarted(session, 'idle-redraw-source', 'External question');
  client.raw = frame({ prompt: 'External question', answer: 'Streaming', busy: true });
  await session.poll();
  assert.equal(external.length, 1);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('idle-redraw-source', 'External question', 'Canonical answer')]));
  await external[0].promise;
  session.turnCommitted();
  client.raw = frame({ prompt: 'External question', answer: 'Canonical answer' });
  await session.poll();
  client.raw = frame({ prompt: 'External question', answer: 'Canonical answer', busy: true });
  await session.poll();
  await session.poll();
  assert.equal(external.length, 1);
  assert.equal(session.pending, null);
  assert.deepEqual(client.calls, []);
});

test('a busy screen waits for a matching unfinished source identity before creating a pending turn', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
  client.raw = frame({ prompt: 'Not flushed yet', answer: 'Streaming', busy: true });
  await session.poll();
  assert.equal(external.length, 0);
  assert.equal(session.pending, null);
  markSourceStarted(session, 'different-source', 'Another prompt');
  await session.poll();
  assert.equal(external.length, 0);
  assert.equal(session.pending, null);
  markSourceStarted(session, 'eventual-source', 'Not flushed yet');
  await session.poll();
  assert.equal(external.length, 1);
  assert.equal(external[0].sourceTurnId, 'eventual-source');
  assert.equal(session.pending.sourceTurnId, 'eventual-source');
  assert.deepEqual(client.calls, []);
});

test('external completion must match the observed source ID even when a later source repeats its prompt', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
  markSourceStarted(session, 'observed-source', 'Continue');
  client.raw = frame({ prompt: 'Continue', answer: 'Streaming', busy: true });
  await session.poll();
  assert.equal(external.length, 1);
  assert.equal(external[0].sourceTurnId, 'observed-source');
  let resolved = false;
  external[0].promise.then(() => { resolved = true; });
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('later-source', 'Continue', 'Later answer')]));
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(session.pending.sourceTurnId, 'observed-source');
  const exact = turn('observed-source', 'Continue', 'Exact answer');
  session.acceptHistory(history([turn('old', 'Earlier question'), exact, turn('later-source', 'Continue', 'Later answer')]));
  assert.equal((await external[0].promise).sourceTurn, exact);
  assert.deepEqual(client.calls, []);
});

for (const alreadyComplete of [false, true]) {
  test(`resumeObserver adopts its exact ${alreadyComplete ? 'completed' : 'unfinished'} source without terminal input`, async t => {
    const current = turn('recovered-source', 'Continue', 'Canonical answer');
    if (!alreadyComplete) { current.status = 'inProgress'; delete current.completedAt; }
    const source = history([turn('old', 'Earlier question'), current], alreadyComplete);
    const client = new MockTmuxClient(frame({ prompt: 'Continue', answer: 'Canonical answer', busy: !alreadyComplete }));
    const session = new TmuxSession({ client, binding, model: 'composer-2.5[fast=true]', history: source, interval: 60_000 });
    t.after(() => session.close());
    const external = [];
    session.on('externalTurn', event => external.push(event));
    const pending = session.resumeObserver(current.id, 'Continue');
    assert.equal(pending.sourceTurnId, current.id);
    await session.start();
    if (!alreadyComplete) {
      let resolved = false;
      pending.promise.then(() => { resolved = true; });
      await Promise.resolve();
      assert.equal(resolved, false);
      const completed = { ...current, status: 'completed', completedAt: 102 };
      session.acceptHistory(history([turn('old', 'Earlier question'), completed]));
      assert.equal((await pending.promise).sourceTurn, completed);
    } else assert.equal((await pending.promise).sourceTurn, current);
    assert.deepEqual(external, []);
    assert.deepEqual(client.calls, []);
  });
}

test('a native message submits once to the original pane and streams before canonical completion', async t => {
  const { session, client } = await start(t);
  const updates = [];
  session.on('update', update => updates.push(update));
  let resolved = false;
  const response = session.prompt([{ type: 'text', text: 'New question' }]);
  response.then(() => { resolved = true; });
  await client.submitted;
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  assert.equal(client.calls[0].paneId, binding.paneId);
  assert.equal(client.calls[0].sessionId, binding.sessionId);
  assert.equal(client.calls[1].text, 'New question');

  client.raw = frame({ prompt: 'New question', answer: 'Reply arriving token by token…', busy: true });
  await session.poll();
  assert.equal(resolved, false);
  assert.equal(updates.at(-1).sessionUpdate, 'terminal_snapshot');
  assert.match(updates.at(-1).text, /Reply arriving token by token/);
  assert.equal(updates.at(-1).text.includes('New question'), false, 'the assistant preview must not repeat the user message');
  assert.equal(updates.at(-1).text.includes('Earlier answer'), false);

  const completed = history([turn('old', 'Earlier question'), turn('new', 'New question', 'Canonical full reply')]);
  session.acceptHistory({ ...completed, sourceComplete: false });
  await Promise.resolve();
  assert.equal(resolved, false);
  client.raw = frame({ prompt: 'New question', answer: 'Canonical full reply' });
  session.acceptHistory(completed);
  const result = await response;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.origin, 'native');
  assert.equal(result.history, completed);
  assert.equal(result.sourceTurn, completed.turns[1]);
  session.turnCommitted();
  await session.poll();
  assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
});

test('a verified multi-line Unicode message reaches the original pane intact', async t => {
  const { session, client } = await start(t);
  const prompt = '第一行\n第二行 🧪';
  client.pastedFrame = frame({ input: '→ 第一行\n第二行 🧪' });
  const response = session.prompt([{ type: 'text', text: prompt }]);
  response.catch(() => {});
  const submitted = await Promise.race([
    client.submitted.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 300)),
  ]);
  assert.equal(submitted, true, 'the exact multi-line draft should remain eligible for Enter');
  assert.equal(client.calls.find(call => call.type === 'paste').text, prompt);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('unicode', prompt)]));
  assert.equal((await response).sourceTurn.id, 'unicode');
});

test('the original trailing LF is proved by its extra content row and inverse caret', async t => {
  const { session, client } = await start(t);
  const prompt = '好呀\n';
  const response = session.prompt([{ type: 'text', text: prompt }]);
  await client.submitted;
  assert.equal(client.calls.find(call => call.type === 'paste').text, prompt);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('tail-lf', '好呀')]));
  assert.equal((await response).sourceTurn.id, 'tail-lf');
});

test('a missing trailing LF is not repaired by trimming the expected prompt', async t => {
  const { session, client } = await start(t);
  client.pastedFrame = frame({ input: '→ 好呀' });
  const error = await session.prompt([{ type: 'text', text: '好呀\n' }]).catch(error => error);
  assert.match(error.message, /unsubmitted draft/);
  assert.deepEqual(error.unsubmittedDraft, {
    sessionId: binding.sessionId, paneId: binding.paneId, agentPid: binding.agentPid,
    agentStartTime: binding.agentStartTime, model: 'composer-2.5[fast=true]', sourceTurnIds: ['old'],
  });
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste']);
});

test('hard-newline indentation and final spaces remain part of the proved message', async t => {
  const { session, client } = await start(t);
  const prompt = 'Line one\n  原来的缩进  ';
  const response = session.prompt([{ type: 'text', text: prompt }]);
  await client.submitted;
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('spaces', prompt)]));
  assert.equal((await response).sourceTurn.id, 'spaces');
});

test('a changed indentation cannot be hidden by display-row trimming', async t => {
  const { session, client } = await start(t);
  client.pastedFrame = frame({ input: '→ Line one\n 原来的缩进' });
  await assert.rejects(session.prompt([{ type: 'text', text: 'Line one\n  原来的缩进' }]), /unsubmitted draft/);
  assert.equal(client.calls.some(call => call.type === 'Enter'), false);
});

test('a Chinese soft wrap is checked using Cursor official text width and caret position', async t => {
  const { session, client } = await start(t);
  // The fixture's top padding has 71 background cells: text width is 66.
  const prompt = '中'.repeat(34);
  client.pastedFrame = frame({ input: `→ ${'中'.repeat(33)}\n中` });
  const response = session.prompt([{ type: 'text', text: prompt }]);
  await client.submitted;
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('wrapped-native', prompt)]));
  assert.equal((await response).sourceTurn.id, 'wrapped-native');
});

test('a long paste token must expand to the exact original text before Enter', async t => {
  const { session, client } = await start(t);
  const prompt = `${'中'.repeat(801)}\n  preserved tail  \n`;
  client.pastedFrame = frame({ input: '→ [Pasted text #17 +3 lines]' });
  client.pastedTexts = { entries: { 17: prompt } };
  const response = session.prompt([{ type: 'text', text: prompt }]);
  await client.submitted;
  assert.equal(client.pasteReads, 1);
  assert.deepEqual(client.minimumColumnRequests, [undefined], 'collapsed paste tokens keep their existing verification path');
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('long-paste', prompt)]));
  assert.equal((await response).sourceTurn.id, 'long-paste');
});

test('a newly saved paste token can become verifiable on a later render attempt', async t => {
  const { session, client } = await start(t);
  const prompt = '中'.repeat(801);
  client.pastedFrame = frame({ input: '→ [Pasted text #18 +1 lines]' });
  client.pastedTexts = () => ({ entries: client.pasteReads > 1 ? { 18: prompt } : {} });
  const response = session.prompt([{ type: 'text', text: prompt }]);
  await client.submitted;
  assert.equal(client.pasteReads, 2);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('later-token', prompt)]));
  assert.equal((await response).sourceTurn.id, 'later-token');
});

test('missing paste tokens and literal old token references cannot accidentally submit expanded text', async t => {
  for (const entries of [{}, { 1: 'The original older expanded content' }]) {
    const { session, client } = await start(t);
    client.pastedTexts = { entries };
    await assert.rejects(session.prompt([{ type: 'text', text: '[Pasted text #1 +1 lines]' }]), /unsubmitted draft/);
    assert.equal(client.calls.some(call => call.type === 'Enter'), false);
  }
});

test('paste expansion is a single pass even when the saved original contains an older token', async t => {
  const { session, client } = await start(t);
  const prompt = `${'中'.repeat(801)} [Pasted text #1 +1 lines]`;
  client.pastedFrame = frame({ input: '→ [Pasted text #19 +1 lines]' });
  client.pastedTexts = { entries: { 1: 'must never replace this literal reference', 19: prompt } };
  const response = session.prompt([{ type: 'text', text: prompt }]);
  await client.submitted;
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('single-pass', prompt)]));
  assert.equal((await response).sourceTurn.id, 'single-pass');
});

const retryFor = (text, overrides = {}) => ({ text, proof: {
  version: 1, turnId: 'failed-native', sessionId: binding.sessionId, paneId: binding.paneId,
  agentPid: binding.agentPid, agentStartTime: binding.agentStartTime,
  model: 'composer-2.5[fast=true]', sourceTurnIds: ['old'], ...overrides,
} });

test('a narrow terminal automatically exposes a clipped wrapped message for exact verification', async t => {
  const clipped = parseCursorScreen(sizedFrame(93, narrowWrapper), { knownCursor: true });
  assert.equal(narrowWrapper.length < 800, true, 'Cursor does not collapse this message to a paste token');
  assert.equal(clipped.inputDraft.width, 86);
  assert.equal(clipped.inputDraft.rows.length, 6);
  assert.equal(clipped.inputDraft.rows[0].includes('<codex_delegation>'), false, 'the original leading line is hidden at this width');

  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  const response = session.prompt([{ type: 'text', text: narrowWrapper }]);
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.minimumColumnRequests, [145], 'Both the scroll layout and Ink must expose at most six rows');
  assert.deepEqual(client.columnTransactions, [{ requested: 145, active: 145, restored: 93 }]);
  assert.equal(client.draft, narrowWrapper, 'the complete original message is pasted without rewriting it');
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('narrow-native', narrowWrapper)]));
  assert.equal((await response).sourceTurn.id, 'narrow-native');
});

test('a wrapped message already within six visual rows does not resize the terminal', async t => {
  const prompt = narrowWrapper.replace('R'.repeat(260), 'R'.repeat(150));
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  const response = session.prompt([{ type: 'text', text: prompt }]);
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  assert.deepEqual(client.minimumColumnRequests, [undefined]);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('fitting-native', prompt)]));
  assert.equal((await response).sourceTurn.id, 'fitting-native');
});

test('automatic width planning exposes the full draft when Cursor preclips seven rows that Ink renders in five', async t => {
  const inkOnly = wrapAnsi(`${preclippedPrompt}\x1b[7m \x1b[27m`, 86, { trim: false, hard: true }).split('\n');
  assert.equal(inkOnly.length, 5);
  assert.equal(preclippedPrompt.length, 135);
  const clipped = parseCursorScreen(sizedFrame(93, preclippedViewport), { knownCursor: true });
  assert.equal(clipped.inputDraft.rows.length, 6);
  assert.equal(clipped.inputDraft.rows[0].startsWith('中 '), true, 'The first full CJK row was clipped before Ink rendered');
  const { session, client } = await start(t, { client: new PreclippedTmuxClient() });
  const response = session.prompt([{ type: 'text', text: preclippedPrompt }]);
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  assert.deepEqual(client.minimumColumnRequests, [95], 'Input width 88 exposes both complete layouts');
  assert.equal(client.draft, preclippedPrompt);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('preclipped-native', preclippedPrompt)]));
  assert.equal((await response).sourceTurn.id, 'preclipped-native');
  assert.equal(client.columns, 93);
});

test('a failed preclipped draft widens before retry and sends one Enter without another paste', async t => {
  const { session, client } = await start(t, { client: new PreclippedTmuxClient(preclippedPrompt) });
  const response = session.prompt([{ type: 'text', text: preclippedPrompt }], { retryDraft: retryFor(preclippedPrompt) });
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  assert.deepEqual(client.minimumColumnRequests, [95]);
  assert.deepEqual(client.calls.map(call => call.type), ['submit-draft-request', 'Enter']);
  assert.equal(client.draft, preclippedPrompt);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('preclipped-retry', preclippedPrompt)]));
  assert.equal((await response).sourceTurn.id, 'preclipped-retry');
});

test('a complete-looking Ink frame cannot prove a draft that Cursor would have preclipped', async t => {
  const { session } = await start(t);
  const inkOnlyFrame = parseCursorScreen(sizedFrame(93, preclippedPrompt), { knownCursor: true });
  assert.equal(inkOnlyFrame.inputDraft.rows.length, 5);
  assert.equal(await session.matchesDraft(inkOnlyFrame, preclippedPrompt), false);
});

test('automatic width planning counts wide Chinese cells when exposing the complete draft', async t => {
  const prompt = narrowWrapper.replace('R'.repeat(260), '中'.repeat(160));
  const clipped = parseCursorScreen(sizedFrame(93, prompt), { knownCursor: true });
  assert.equal(clipped.inputDraft.rows[0].includes('<codex_delegation>'), false);
  assert.equal(prompt.length < 800, true);
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  const response = session.prompt([{ type: 'text', text: prompt }]);
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  assert.equal(client.minimumColumnRequests[0] > 100, true, 'CJK cell widths require more room than character counts suggest');
  assert.equal(client.draft, prompt);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('cjk-resize', prompt)]));
  assert.equal((await response).sourceTurn.id, 'cjk-resize');
});

test('a clipped failed draft retries at a verifiable width with one Enter and no second paste', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient(narrowWrapper) });
  const retryDraft = retryFor(narrowWrapper);
  await assert.rejects(session.assertReady({ retryDraft }), /draft changed/);
  const response = session.prompt([{ type: 'text', text: narrowWrapper }], { retryDraft });
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.minimumColumnRequests, [145]);
  assert.deepEqual(client.calls.map(call => call.type), ['submit-draft-request', 'Enter']);
  assert.equal(client.draft, narrowWrapper);
  assert.equal(client.columns, 93);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('narrow-retry', narrowWrapper)]));
  assert.equal((await response).sourceTurn.id, 'narrow-retry');
});

test('a changed hidden first line cannot authorize retry after automatic widening', async t => {
  const changed = narrowWrapper.replace('<codex_delegation>', '<other_delegation>');
  const { session, client } = await start(t, { client: new NarrowTmuxClient(changed) });
  const error = await session.prompt([{ type: 'text', text: narrowWrapper }], { retryDraft: retryFor(narrowWrapper) }).catch(error => error);
  assert.match(error.message, /draft changed/);
  assert.deepEqual(client.minimumColumnRequests, [145]);
  assert.deepEqual(client.calls.map(call => call.type), ['submit-draft-request']);
  assert.equal(client.columns, 93);
  assert.equal(client.draft, changed, 'a person\'s changed draft is retained intact');
});

test('an overlay on a clipped retry is rejected before a resize or Enter is requested', async t => {
  const client = new NarrowTmuxClient(narrowWrapper);
  client.overlay = '  Allow this command? [y/n]';
  const { session } = await start(t, { client });
  await assert.rejects(session.prompt([{ type: 'text', text: narrowWrapper }], { retryDraft: retryFor(narrowWrapper) }), /unavailable|no longer available|draft changed/i);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(client.minimumColumnRequests, []);
});

test('a local draft arriving during automatic widening prevents paste and Enter', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  client.beforeGuard = () => { client.draft = 'Keep this concurrent local draft'; };
  await assert.rejects(session.prompt([{ type: 'text', text: narrowWrapper }]), /changed before paste/);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request']);
  assert.equal(client.columns, 93);
  assert.equal(client.draft, 'Keep this concurrent local draft');
});

test('automatic widening waits for Cursor to render its new input width before pasting', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  const capture = client.capture.bind(client);
  let staleCaptures = 0;
  client.capture = async paneId => client.columns > 93 && staleCaptures++ < 2
    ? sizedFrame(93, client.draft, client.overlay) : capture(paneId);
  client.afterPasteGuard = () => assert.equal(staleCaptures >= 3, true, 'paste waits for a capture at the new width');
  const response = session.prompt([{ type: 'text', text: narrowWrapper }]);
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  assert.equal(staleCaptures >= 3, true, 'the two stale captures cannot authorize paste');
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('delayed-resize', narrowWrapper)]));
  assert.equal((await response).sourceTurn.id, 'delayed-resize');
});

test('a TUI that never renders the widened input cannot receive paste or Enter', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  client.capture = async () => sizedFrame(93, client.draft, client.overlay);
  await assert.rejects(session.prompt([{ type: 'text', text: narrowWrapper }]), /width|resize|columns/i);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request']);
  assert.equal(client.columns, 93);
  assert.equal(client.draft, null);
});

test('a transient incomplete redraw after widening is retried before one exact paste and Enter', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  const partial = `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${row(placeholder('Add a follow-up'))}\n\n  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('/fixture/project')}\n`;
  assert.equal(parseCursorScreen(partial, { knownCursor: true }).reason, 'incomplete-input-frame');
  const capture = client.capture.bind(client);
  let widenedCaptures = 0;
  client.capture = async paneId => client.columns > 93 && widenedCaptures++ < 2 ? partial : capture(paneId);
  client.afterPasteGuard = () => assert.equal(widenedCaptures >= 3, true, 'an incomplete frame cannot authorize paste');
  const response = session.prompt([{ type: 'text', text: narrowWrapper }]);
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  assert.equal(client.draft, narrowWrapper);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('partial-redraw', narrowWrapper)]));
  assert.equal((await response).sourceTurn.id, 'partial-redraw');
  assert.equal(client.columns, 93);
});

test('a persistently incomplete redraw after widening never receives paste or Enter', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  const capture = client.capture.bind(client);
  let widenedCaptures = 0;
  client.capture = async paneId => {
    if (client.columns <= 93) return capture(paneId);
    widenedCaptures++;
    return `  Cursor Agent\n  ${dim('v2025.01.01-test')}\n\n${row(placeholder('Add a follow-up'))}\n`;
  };
  await assert.rejects(session.prompt([{ type: 'text', text: narrowWrapper }]), /resize|width|incomplete-input-frame/i);
  assert.equal(widenedCaptures > 1, true, 'a partial redraw receives a bounded render opportunity');
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request']);
  assert.equal(client.columns, 93);
  assert.equal(client.draft, null);
});

test('an approval overlay that persists after widening never receives paste or Enter', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  client.beforeGuard = () => { client.overlay = '  Allow this command? [y/n]'; };
  await assert.rejects(session.prompt([{ type: 'text', text: narrowWrapper }]), /resize|width|overlay|changed before paste/i);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request']);
  assert.equal(client.columns, 93);
  assert.equal(client.draft, null);
  assert.equal(client.overlay, '  Allow this command? [y/n]');
});

test('automatic widening still rejects an altered message instead of sending Enter', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  client.alterPastedText = text => text.replace('<codex_delegation>', '<other_delegation>');
  await assert.rejects(session.prompt([{ type: 'text', text: narrowWrapper }]), /unsubmitted draft/);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste']);
  assert.equal(client.columns, 93);
  assert.equal(client.draft.startsWith('<other_delegation>'), true);
});

test('a short seven-hard-line input requires an exclusive lease before paste', async t => {
  const { session, client } = await start(t, { client: new NarrowTmuxClient() });
  const prompt = 'first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh';
  await assert.rejects(session.prompt([{ type: 'text', text: prompt }]), /exclusive.*lease/i);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request']);
  assert.equal(client.draft, null);
});

test('a multiline saved-paste reference is rejected before it can expand a different Cursor buffer', async t => {
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  const prompt = 'first\nsecond\n[Pasted text #1 +9 lines]\nfourth\nfifth\nsixth\nseventh';
  await assert.rejects(session.prompt([{ type: 'text', text: prompt }]), /paste-token spelling.*no text was pasted/);
  assert.equal(client.calls.some(call => ['paste', 'Enter', 'marker'].includes(call.type)), false);
  assert.equal(client.draft, null);
});

test('a multiline NFD caret ambiguity is rejected before paste instead of skipping its unobservable positions', async t => {
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  const prompt = 'A\ne\u0301\u0323\nB\nC\nD\nE\nF';
  await assert.rejects(session.prompt([{ type: 'text', text: prompt }]), /cannot safely display every cursor position/);
  assert.equal(client.calls.some(call => ['paste', 'Enter', 'marker'].includes(call.type)), false);
  assert.equal(client.draft, null);
});

for (const [name, prompt] of [
  ['seven lines', 'first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh'],
  ['twelve repeated lines', Array(12).fill('same  ').join('\n')],
  ['leading and trailing blank lines', '\n'.repeat(6) + 'a' + '\n'.repeat(6)],
  ['indentation and Unicode', '\n  中文 😀\n\n    indented  \nrepeat\nrepeat\n\n\nemoji 👩‍💻\né\nend\n'],
  ['long hard line', `first\n${'长'.repeat(120)}\nthird\nfourth\nfifth\nsixth\nseventh\n`],
  ['800 UTF-16 units', 'a\n'.repeat(6) + 'z'.repeat(788)],
]) {
  test(`exclusive multiline verification preserves ${name} and removes its suffix before one Enter`, async t => {
    const { session, client } = await start(t, { client: new PagedTmuxClient() });
    const response = session.prompt([{ type: 'text', text: prompt }]);
    await client.submitted;
    assert.equal(client.draft, prompt);
    assert.equal(client.calls.filter(call => call.type === 'paste').length, 1);
    assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
    assert.equal(client.calls.filter(call => call.type === 'marker').length, 1);
    assert.equal(client.calls.filter(call => call.type === 'remove-marker').length, 1);
    assert.ok(client.fullLeaseChecks >= 3);
    session.acceptHistory(history([turn('old', 'Earlier question'), turn('multiline-completed', prompt)]));
    assert.equal((await response).sourceTurn.id, 'multiline-completed');
    assert.equal(client.columns, 93);
  });
}

test('a hidden extra LF cannot pass multiline verification even when the unmarked viewport trace collides', async t => {
  const prompt = '\n'.repeat(6) + 'a' + '\n'.repeat(6);
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  client.alterPastedText = text => text + '\n';
  const error = await session.prompt([{ type: 'text', text: prompt }]).catch(error => error);
  assert.equal(error.verificationAnchor.state, 'injected');
  assert.equal(client.calls.some(call => call.type === 'Enter'), false);
  assert.equal(client.draft, prompt + '\n' + error.verificationAnchor.suffix);
  assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
  assert.equal(error.multilineVerification.phase, 'scan');
  assert.notEqual(error.multilineVerification.mismatch, 'none');
});

test('multiline failure diagnostics identify a failed scan without exposing draft or marker text', async t => {
  const prompt = '\n# Files mentioned by the user:\n\n## private.mp4: /private/attachment.mp4\n\nPrivate instructions\n\n## My request:\n1. 中文请求\n2. More private text\n';
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  client.onMove = () => {
    if (client.marker && client.offset === 2) client.alterDraftFrame = raw => raw.replace('/private/attachment.mp4', '/private/different.mp4');
  };
  const error = await session.prompt([{ type: 'text', text: prompt }]).catch(error => error);
  assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
  assert.equal(error.multilineVerification.phase, 'scan');
  assert.equal(error.multilineVerification.operation, 'capture');
  assert.equal(error.multilineVerification.offset, 2);
  assert.equal(error.multilineVerification.attempt, 15);
  assert.equal(error.multilineVerification.mismatch, 'row-content');
  const details = multilineVerificationDetails(error.multilineVerification);
  assert.ok(details.length < 700);
  assert.equal(details.includes('private'), false);
  assert.equal(details.includes(error.verificationAnchor.suffix), false);
  assert.deepEqual(JSON.parse(details).multilineVerification, error.multilineVerification);
  assert.equal(client.calls.some(call => call.type === 'Enter'), false);
});

test('multiline detail serialization rejects unknown strings, fields and unbounded measurements', () => {
  const valid = { version: 1, phase: 'anchor-end', operation: 'capture', mismatch: 'caret-missing',
    expectedWidth: 200, actualWidth: null, actualRows: 6, actualCaretRow: null, actualCaretOffset: null };
  assert.ok(multilineVerificationDetails(valid));
  assert.ok(multilineVerificationDetails({ ...valid, expectedWidth: 2000, actualWidth: 2000 }));
  const withSerializer = Object.defineProperty({ ...valid }, 'toJSON', { value: () => '/private/draft' });
  assert.equal(multilineVerificationDetails(withSerializer).includes('/private/draft'), false);
  for (const invalid of [{ ...valid, text: '/private/draft' }, { ...valid, phase: '/private/draft' },
    { ...valid, screenReason: '/private/draft' }, { ...valid, mismatch: '/private/draft' },
    { ...valid, actualRows: 1008 }, { ...valid, expectedWidth: 65536 }, { ...valid, expectedWidth: null }]) {
    assert.equal(multilineVerificationDetails(invalid), null);
  }
});

const attachmentPath = '/home/user/.codex_cursor_bridge/attachments/00000000-1111-4222-8333-444444444444/example.mp4';
const attachmentPrompt = `\n# Files mentioned by the user:\n\n## example.mp4: ${attachmentPath}\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n1. 请分析视频的镜头安排和人物动作，按发生顺序说明每个片段的视觉内容。\n2. 请比较开场、中段和结尾的叙事关系，指出画面中能够核实的细节，并说明节奏、构图和转场怎样影响整体表达。不要根据没有出现的情节补充故事，也不要忽略首尾的画面。\n`;
const attachmentSlash = attachmentPrompt.indexOf(attachmentPath);
const inAttachmentSlash = offset => offset >= attachmentSlash && offset <= attachmentSlash + attachmentPath.length;

function replayPreviousSlashFrame(client, { offset, previousOffset = offset - 1, lag, alter = raw => raw }) {
  const state = { captures: 0, moves: undefined, previous: undefined };
  client.alterDraftFrame = raw => {
    if (!client.marker) return raw;
    if (client.offset === previousOffset) state.previous = raw;
    if (client.offset !== offset) return raw;
    const moves = client.calls.filter(call => call.type === 'move').length;
    state.moves ??= moves;
    assert.equal(moves, state.moves, 'settling may only capture, never move the cursor');
    if (++state.captures > lag) return raw;
    assert.ok(state.previous, 'the previous viewport must have already been observed');
    const stale = state.previous.replace(`  ${dim(client.footer)}\n  ${dim('/fixture/project')}`, `     ${dim('No matches')}`);
    return alter(stale);
  };
  return state;
}

test('an attachment wrapper scans the exact empty slash completion and submits once after ordinary EOF verification', async t => {
  assert.equal(attachmentPrompt.split('\n').length, 11);
  assert.ok(attachmentPrompt.length <= 800);
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  client.completionAt = inAttachmentSlash;
  const response = session.prompt([{ type: 'text', text: attachmentPrompt }]);
  response.catch(() => {});
  await Promise.race([client.submitted, response]);
  assert.ok(client.completionFrames > 0);
  assert.equal(client.draft, attachmentPrompt);
  assert.equal(client.calls.filter(call => call.type === 'paste').length, 1);
  assert.equal(client.calls.filter(call => call.type === 'remove-marker').length, 1);
  assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('attachment', attachmentPrompt)]));
  assert.equal((await response).sourceTurn.id, 'attachment');
});

for (const lag of [1, 2]) {
  for (const position of ['activation', 'inside', 'closing', 'two-unit-codepoint']) {
    test(`an exact previous slash viewport settles after ${lag} captures at ${position} without extra keys`, async t => {
      const prompt = position === 'two-unit-codepoint' ? attachmentPrompt.replaceAll('example.mp4', 'e🧪.mp4') : attachmentPrompt;
      const filename = position === 'two-unit-codepoint' ? attachmentPath.replace('example.mp4', 'e🧪.mp4') : attachmentPath;
      const startOffset = prompt.indexOf(filename), endOffset = startOffset + filename.length;
      const offset = position === 'activation' ? startOffset : position === 'closing' ? endOffset + 1
        : position === 'two-unit-codepoint' ? prompt.indexOf('🧪', startOffset) + 2 : startOffset + 5;
      const { session, client } = await start(t, { client: new PagedTmuxClient() });
      client.completionAt = offset => offset >= startOffset && offset <= endOffset;
      const stale = replayPreviousSlashFrame(client, { offset, lag,
        previousOffset: offset - (position === 'two-unit-codepoint' ? 2 : 1) });
      const response = session.prompt([{ type: 'text', text: prompt }]);
      response.catch(() => {});
      await Promise.race([client.submitted, response]);
      assert.equal(stale.captures, lag + 1);
      assert.equal(client.calls.filter(call => call.type === 'move').length, [...prompt].length + 32 + 6);
      assert.equal(client.calls.filter(call => call.type === 'remove-marker').length, 1);
      assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
      assert.equal(client.draft, prompt);
      session.acceptHistory(history([turn('old', 'Earlier question'), turn('settled-slash', prompt)]));
      assert.equal((await response).sourceTurn.id, 'settled-slash');
    });
  }
}

test('a persistent exact previous slash viewport exhausts capture retries without moving or submitting', async t => {
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  client.completionAt = inAttachmentSlash;
  const offset = attachmentSlash + 5;
  const stale = replayPreviousSlashFrame(client, { offset, lag: Infinity });
  const error = await session.prompt([{ type: 'text', text: attachmentPrompt }]).catch(error => error);
  assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
  assert.equal(error.multilineVerification.phase, 'scan');
  assert.equal(error.multilineVerification.offset, offset);
  assert.equal(error.multilineVerification.mismatch, 'caret-offset');
  assert.equal(error.multilineVerification.attempt, 15);
  assert.equal(stale.captures, 15);
  assert.equal(client.calls.filter(call => call.type === 'move').length, stale.moves);
  assert.equal(client.calls.some(call => ['remove-marker', 'Enter'].includes(call.type)), false);
  assert.equal(client.draft, attachmentPrompt + error.verificationAnchor.suffix);
});

for (const change of ['unknown-menu', 'row-content', 'caret-missing', 'older-frame']) {
  test(`a previous slash viewport with ${change} fails immediately without further input`, async t => {
    const { session, client } = await start(t, { client: new PagedTmuxClient() });
    client.completionAt = inAttachmentSlash;
    const offset = attachmentSlash + 5;
    const stale = replayPreviousSlashFrame(client, { offset, lag: Infinity,
      previousOffset: offset - (change === 'older-frame' ? 2 : 1),
      alter: raw => change === 'unknown-menu' ? raw.replace('No matches', 'Choose a command')
        : change === 'row-content' ? raw.replace('## example.mp4:', '## altered.mp4:')
          : change === 'caret-missing' ? raw.replace(/\x1b\[(?:7|27)m/gu, '') : raw });
    const error = await session.prompt([{ type: 'text', text: attachmentPrompt }]).catch(error => error);
    assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
    assert.equal(error.multilineVerification.phase, 'scan');
    assert.equal(error.multilineVerification.attempt, 1);
    assert.equal(stale.captures, 1);
    assert.equal(client.calls.filter(call => call.type === 'move').length, stale.moves);
    assert.equal(client.calls.some(call => ['remove-marker', 'Enter'].includes(call.type)), false);
    assert.equal(client.draft, attachmentPrompt + error.verificationAnchor.suffix);
  });
}

for (const change of ['lease', 'source', 'epoch', 'model', 'session']) {
  test(`an exact stale slash viewport still rejects a ${change} change before any further key`, async t => {
    const { session, client } = await start(t, { client: new PagedTmuxClient() });
    client.completionAt = inAttachmentSlash;
    const stale = replayPreviousSlashFrame(client, { offset: attachmentSlash + 5, lag: Infinity, alter: raw => {
      if (change === 'lease') client.leaseActive = false;
      if (change === 'source') session.history = history([turn('old', 'Earlier question'), turn('elsewhere', 'Another turn')]);
      if (change === 'epoch') session.setVerified(false);
      if (change === 'model') session.model = 'changed-model';
      if (change === 'session') session.sessionId = 'changed-session';
      return raw;
    } });
    const error = await session.prompt([{ type: 'text', text: attachmentPrompt }]).catch(error => error);
    assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
    assert.equal(error.multilineVerification.phase, 'scan');
    assert.equal(error.multilineVerification.operation, 'context');
    assert.equal(stale.captures, 1);
    assert.equal(client.calls.filter(call => call.type === 'move').length, stale.moves);
    assert.equal(client.calls.some(call => ['remove-marker', 'Enter'].includes(call.type)), false);
  });
}

for (const lag of [1, 2]) {
  test(`slash completion closing after ${lag} captures waits without extra cursor movement`, async t => {
    const { session, client } = await start(t, { client: new PagedTmuxClient() });
    const afterToken = attachmentSlash + attachmentPath.length + 1;
    let closingCaptures = 0;
    let closingMoves;
    client.completionAt = offset => {
      if (inAttachmentSlash(offset)) return true;
      if (offset !== afterToken) return false;
      const moves = client.calls.filter(call => call.type === 'move').length;
      closingMoves ??= moves;
      assert.equal(moves, closingMoves, 'the caret must stay fixed while the menu closes');
      return ++closingCaptures <= lag;
    };
    const response = session.prompt([{ type: 'text', text: attachmentPrompt }]);
    response.catch(() => {});
    await Promise.race([client.submitted, response]);
    assert.equal(closingCaptures, lag + 1);
    assert.equal(client.calls.filter(call => call.type === 'move').length, [...attachmentPrompt].length + 32 + 6);
    assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
    assert.equal(client.draft, attachmentPrompt);
    session.acceptHistory(history([turn('old', 'Earlier question'), turn(`lag-${lag}`, attachmentPrompt)]));
    await response;
  });
}

for (const change of ['lease', 'source', 'epoch']) {
  test(`an exact slash menu still rejects a ${change} change before further navigation`, async t => {
    const { session, client } = await start(t, { client: new PagedTmuxClient() });
    client.completionAt = inAttachmentSlash;
    let movesAtChange;
    client.alterDraftFrame = raw => {
      if (raw.includes(dim('No matches'))) {
        movesAtChange ??= client.calls.filter(call => call.type === 'move').length;
        if (change === 'lease') client.leaseActive = false;
        if (change === 'source') session.history = history([turn('old', 'Earlier question'), turn('elsewhere', 'Another turn')]);
        if (change === 'epoch') session.setVerified(false);
      }
      return raw;
    };
    const error = await session.prompt([{ type: 'text', text: attachmentPrompt }]).catch(error => error);
    assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
    assert.equal(error.multilineVerification.phase, 'scan');
    assert.equal(error.multilineVerification.operation, 'context');
    assert.equal(client.calls.filter(call => call.type === 'move').length, movesAtChange);
    assert.equal(client.calls.some(call => ['remove-marker', 'Enter'].includes(call.type)), false);
  });
}

for (const footer of ['Gemini 4 Argon · 5.1%', 'Unknown Model · 5.1%']) {
  test(`an ordinary footer returning after slash completion must still match the pinned model: ${footer}`, async t => {
    const { session, client } = await start(t, { client: new PagedTmuxClient(), ...catalogOptions });
    client.completionAt = offset => {
      if (offset === attachmentSlash + attachmentPath.length + 1) client.footer = footer;
      return inAttachmentSlash(offset);
    };
    const error = await session.prompt([{ type: 'text', text: attachmentPrompt }]).catch(error => error);
    assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
    assert.equal(error.multilineVerification.phase, 'scan');
    assert.equal(error.multilineVerification.operation, 'model');
    assert.equal(client.calls.some(call => ['remove-marker', 'Enter'].includes(call.type)), false);
  });
}

test('persistent empty slash completion at final enhanced EOF never removes the marker or submits', async t => {
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  const finalMoveCount = [...attachmentPrompt].length + 32 + 6;
  client.completionAt = (offset, draft) => inAttachmentSlash(offset)
    || offset === draft.length && client.calls.filter(call => call.type === 'move').length >= finalMoveCount;
  const error = await session.prompt([{ type: 'text', text: attachmentPrompt }]).catch(error => error);
  assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
  assert.equal(error.multilineVerification.phase, 'scan-end-confirm');
  assert.equal(error.multilineVerification.attempt, 15);
  assert.equal(client.calls.filter(call => call.type === 'move').length, finalMoveCount);
  assert.equal(client.calls.some(call => ['remove-marker', 'Enter'].includes(call.type)), false);
  assert.equal(client.draft, attachmentPrompt + error.verificationAnchor.suffix);
});

for (const change of ['unknown-menu', 'draft', 'model', 'outside-token']) {
  test(`slash completion cannot hide a changed ${change} during a multiline scan`, async t => {
    const { session, client } = await start(t, { client: new PagedTmuxClient() });
    client.completionAt = change === 'outside-token' ? offset => offset === 2 : inAttachmentSlash;
    if (change === 'unknown-menu') client.completionLabel = 'Choose a command';
    if (change === 'draft') client.alterDraftFrame = raw => raw.includes(dim('No matches'))
      ? raw.replace('## example.mp4:', '## altered.mp4:') : raw;
    if (change === 'model') client.onMove = () => { if (inAttachmentSlash(client.offset)) session.model = 'changed-model'; };
    const error = await session.prompt([{ type: 'text', text: attachmentPrompt }]).catch(error => error);
    assert.equal(error.message, UNSUBMITTED_ANCHORED_DRAFT_ERROR);
    assert.equal(error.multilineVerification.phase, 'scan');
    assert.equal(error.multilineVerification.offset, change === 'outside-token' ? 2 : attachmentSlash);
    if (change === 'draft') assert.equal(error.multilineVerification.mismatch, 'row-content');
    else if (change !== 'model') assert.equal(error.multilineVerification.mismatch, 'input-unavailable');
    assert.equal(client.calls.some(call => ['remove-marker', 'Enter'].includes(call.type)), false);
    assert.equal(client.draft, attachmentPrompt + error.verificationAnchor.suffix);
  });
}

test('empty slash completion at the original EOF cannot authorize final submission', async t => {
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  let markerRemoved = false;
  client.onRemoveMarker = () => { markerRemoved = true; };
  client.completionAt = (offset, draft) => inAttachmentSlash(offset)
    || markerRemoved && draft === attachmentPrompt && offset === draft.length;
  const error = await session.prompt([{ type: 'text', text: attachmentPrompt }]).catch(error => error);
  assert.equal(error.message, UNSUBMITTED_DRAFT_ERROR);
  assert.equal(error.multilineVerification.phase, 'original-end');
  assert.equal(error.multilineVerification.mismatch, 'input-unavailable');
  assert.equal(error.multilineVerification.attempt, 15);
  assert.equal(error.verificationAnchor, undefined);
  assert.equal(client.draft, attachmentPrompt);
  assert.equal(client.calls.some(call => call.type === 'Enter'), false);
});

for (const change of ['overlay', 'model', 'verification', 'source', 'lease']) {
  test(`multiline ${change} change after marker insertion sends no Enter and retains a recoverable draft`, async t => {
    const prompt = 'a\nb\nc\nd\ne\nf\ng\nh';
    const { session, client } = await start(t, { client: new PagedTmuxClient(), ...catalogOptions });
    client.onMarker = () => {
      if (change === 'overlay') client.overlay = '  Allow this command? [y/n]';
      if (change === 'model') client.footer = 'Unrecognized Model · 5.1%';
      if (change === 'verification') session.setVerified(false);
      if (change === 'source') session.history = history([turn('old', 'Earlier question'), turn('unexpected', 'Elsewhere')]);
      if (change === 'lease') client.leaseActive = false;
    };
    const error = await session.prompt([{ type: 'text', text: prompt }]).catch(error => error);
    assert.equal(error.verificationAnchor.state, 'injected');
    assert.equal(client.calls.some(call => call.type === 'Enter'), false);
    assert.equal(client.draft, prompt + error.verificationAnchor.suffix);
  });
}

test('an exact multiline retry validates an arbitrary caret without a second paste', async t => {
  const prompt = '\nfirst\n  second\nthird\nfourth\nfifth\nsixth\nseventh\n';
  const client = new PagedTmuxClient(prompt);
  client.offset = 5;
  const { session } = await start(t, { client });
  const response = session.prompt([{ type: 'text', text: prompt }], { retryDraft: retryFor(prompt) });
  await client.submitted;
  assert.equal(client.draft, prompt);
  assert.equal(client.calls.some(call => call.type === 'paste'), false);
  assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('retry-multiline', prompt)]));
  assert.equal((await response).sourceTurn.id, 'retry-multiline');
});

test('an anchored multiline retry verifies and deletes the existing suffix without typing another', async t => {
  const prompt = 'a\n'.repeat(6) + 'z'.repeat(788);
  const suffix = 'c'.repeat(32);
  const client = new PagedTmuxClient(prompt + suffix);
  client.offset = 0;
  const { session } = await start(t, { client });
  const retryDraft = retryFor(prompt);
  retryDraft.proof.version = 2;
  retryDraft.proof.verificationAnchor = { version: 1, suffix, state: 'injected' };
  const response = session.prompt([{ type: 'text', text: prompt }], { retryDraft });
  await client.submitted;
  assert.equal(client.draft, prompt);
  assert.equal(client.calls.some(call => ['paste', 'marker'].includes(call.type)), false);
  assert.equal(client.calls.filter(call => call.type === 'adopt').length, 1);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('retry-anchored', prompt)]));
  assert.equal((await response).sourceTurn.id, 'retry-anchored');
});

test('an anchored retry preserves its existing-marker journal if lease verification fails before navigation', async t => {
  const prompt = 'a\nb\nc\nd\ne\nf\ng\n';
  const suffix = 'd'.repeat(32);
  const client = new PagedTmuxClient(prompt + suffix);
  const { session } = await start(t, { client });
  client.onLeaseCheck = () => { throw new Error('The lease owner changed'); };
  const retryDraft = retryFor(prompt);
  retryDraft.proof.version = 2;
  retryDraft.proof.verificationAnchor = { version: 1, suffix, state: 'injected' };
  const error = await session.prompt([{ type: 'text', text: prompt }], { retryDraft }).catch(error => error);
  assert.equal(error.verificationAnchor?.state, 'injected');
  assert.equal(error.verificationAnchor.suffix, suffix);
  assert.equal(client.calls.some(call => ['paste', 'marker', 'Enter'].includes(call.type)), false);
  assert.equal(client.draft, prompt + suffix);
  assert.deepEqual(error.multilineVerification, { version: 1, phase: 'input-width', operation: 'context' });
});

test('a failure after exact marker removal retains an ordinary unsubmitted draft without an injected-anchor proof', async t => {
  const prompt = 'a\nb\nc\nd\ne\nf\ng\n';
  const { session, client } = await start(t, { client: new PagedTmuxClient() });
  client.onRemoveMarker = () => { client.overlay = '  Allow this command? [y/n]'; };
  const error = await session.prompt([{ type: 'text', text: prompt }]).catch(error => error);
  assert.equal(error.message, UNSUBMITTED_DRAFT_ERROR);
  assert.equal(error.verificationAnchor, undefined);
  assert.ok(error.unsubmittedDraft);
  assert.equal(client.draft, prompt);
  assert.equal(client.calls.some(call => call.type === 'Enter'), false);
  assert.equal(error.multilineVerification.phase, 'original-end');
  assert.equal(error.multilineVerification.mismatch, 'input-unavailable');
});

test('an eligible failed trailing-LF draft retries with a guarded Enter and no second paste', async t => {
  const prompt = '好呀\n';
  const { session, client } = await start(t, { client: new MockTmuxClient(frame({ input: `→ ${prompt}` })) });
  const retryDraft = retryFor(prompt);
  await session.assertReady({ retryDraft });
  const response = session.prompt([{ type: 'text', text: prompt }], { retryDraft });
  await client.submitted;
  assert.deepEqual(client.calls.map(call => call.type), ['submit-draft-request', 'Enter']);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('retry-success', prompt)]));
  assert.equal((await response).sourceTurn.id, 'retry-success');
});

test('retry requires the exact failed text, binding, model and unchanged source baseline', async t => {
  for (const overrides of [{ agentStartTime: 'different' }, { sourceTurnIds: [] }, { model: 'different-model' }]) {
    const { session, client } = await start(t, { client: new MockTmuxClient(frame({ input: '→ Retry me' })) });
    await assert.rejects(session.prompt([{ type: 'text', text: 'Retry me' }], { retryDraft: retryFor('Retry me', overrides) }), /verified session/);
    assert.deepEqual(client.calls, []);
  }
  const { session, client } = await start(t, { client: new MockTmuxClient(frame({ input: '→ Retry me' })) });
  await assert.rejects(session.prompt([{ type: 'text', text: 'Different text' }], { retryDraft: retryFor('Retry me') }), /exact failed/);
  assert.deepEqual(client.calls, []);
});

test('a draft changing immediately before retry cannot receive Enter', async t => {
  const { session, client } = await start(t, { client: new MockTmuxClient(frame({ input: '→ Retry me' })) });
  client.beforeSubmitGuard = () => { client.raw = frame({ input: '→ Retry me plus local text' }); };
  const error = await session.prompt([{ type: 'text', text: 'Retry me' }], { retryDraft: retryFor('Retry me') }).catch(error => error);
  assert.match(error.message, /draft changed/);
  assert.deepEqual(client.calls.map(call => call.type), ['submit-draft-request']);
  assert.deepEqual(error.unsubmittedDraft.sourceTurnIds, ['old']);
});

test('failure recovery evidence keeps the pre-paste source baseline after CLI history advances', async t => {
  const { session, client } = await start(t);
  client.pastedFrame = frame({ input: '→ Unexpected draft' });
  const capture = client.capture.bind(client);
  client.capture = async paneId => {
    if (client.calls.some(call => call.type === 'paste')) session.acceptHistory(history([turn('old', 'Earlier question'), turn('elsewhere', 'Another CLI message')]));
    return capture(paneId);
  };
  const error = await session.prompt([{ type: 'text', text: 'Native message' }]).catch(error => error);
  assert.deepEqual(error.unsubmittedDraft.sourceTurnIds, ['old']);
  client.raw = frame({ input: '→ Native message' });
  await assert.rejects(session.assertReady({ retryDraft: retryFor('Native message') }), /source history/);
  assert.equal(client.calls.some(call => call.type === 'Enter'), false);
});

test('native canonical completion tolerates a trailing LF and CRLF but preserves internal whitespace', async t => {
  const { session } = await start(t);
  // The transcript wrapper strips exterior whitespace after submission. The
  // paste guard remains exact; this test isolates reconciliation of that turn.
  const pending = session.begin('native', 'Reply  READY\r\non this line\n');
  pending.submitted = true;
  let resolved = false;
  pending.promise.then(() => { resolved = true; });
  const old = turn('old', 'Earlier question');
  session.acceptHistory(history([old, turn('different-spacing', 'Reply READY\non this line')]));
  await Promise.resolve();
  assert.equal(resolved, false, 'canonical matching must preserve meaningful spaces inside a line');
  const completed = history([old, turn('matching', 'Reply  READY\non this line')]);
  session.acceptHistory(completed);
  const result = await pending.promise;
  assert.equal(result.sourceTurn.id, 'matching');
  assert.equal(result.history, completed);
  assert.equal(result.stopReason, 'end_turn');
});

const stampedHistory = (rows, complete = true) => ({ ...parseTranscript(rows.map(([role, text]) =>
  JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })).join('\n'),
{ id: binding.sessionId, cwd: binding.cwd }), sourceComplete: complete });
const stampedPrompt = (text, minute = '01') => `<timestamp>Monday, Oct 19, 2026, 11:${minute} AM (UTC)</timestamp>\n<user_query>${text}</user_query>`;

test('a fresh native turn binds once to the exact Cursor empty-line export and completes without changing its input', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  const original = 'First\r\n\r\n\r\n\r\n  Second  line\r\n';
  const pending = session.begin('native', original); pending.submitted = true;
  let claims = 0;
  session.onSubmittedSource = async event => {
    claims++;
    assert.equal(event.prompt, original);
    assert.equal(event.isCurrent(), true);
    assert.equal(event.sourceTurn.items[0].content[0].text, 'First\n\n  Second  line');
  };
  const complete = stampedHistory([['user', stampedPrompt('First\n\n  Second  line')], ['assistant', 'Exported reply']]);
  session.acceptHistory(complete);
  const result = await pending.promise;
  assert.equal(result.sourceTurn, complete.turns[0]);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(pending.prompt, original);
  assert.equal(claims, 1);
  assert.deepEqual(client.calls, [], 'history reconciliation cannot type or resubmit');
});

test('native export matching preserves spaces and one versus two hard breaks and refuses projected ambiguity', async t => {
  for (const wrong of ['First\n  Second  line', 'First\n\n  Second line', 'First Second line']) {
    const { session, client } = await start(t, { source: stampedHistory([]) });
    const pending = session.begin('native', 'First\n\n\n\n  Second  line'); pending.submitted = true;
    let claims = 0;
    session.onSubmittedSource = async () => { claims++; };
    session.acceptHistory(stampedHistory([['user', stampedPrompt(wrong)], ['assistant', 'Wrong attribution']]));
    await settleBinding();
    assert.equal(session.pending, pending);
    assert.equal(pending.sourceTurnId, undefined);
    assert.equal(claims, 0);
    assert.deepEqual(client.calls, []);
    await session.close();
  }
  const { session, client } = await start(t, { source: stampedHistory([]) });
  const pending = session.begin('native', 'First\n\n\n\nSecond'); pending.submitted = true;
  let claims = 0;
  session.onSubmittedSource = async () => { claims++; };
  session.acceptHistory(stampedHistory([['user', stampedPrompt('First\n\nSecond')], ['assistant', 'One'],
    ['user', stampedPrompt('First\n\nSecond')], ['assistant', 'Two']]));
  await settleBinding();
  assert.equal(claims, 0);
  assert.match(pending.identityError.message, /identity changed or is ambiguous/);
  assert.deepEqual(client.calls, []);
});

test('baseline export collapse does not become drift, but changed spaces still block a new native claim', async t => {
  for (const changedSpace of [false, true]) {
    const old = turn('old-export', 'Earlier\n\n\n\nline  spacing');
    const { session, client } = await start(t, { source: history([old]) });
    const pending = session.begin('native', 'Current\n\n\n\nquestion'); pending.submitted = true;
    const prior = turn(old.id, changedSpace ? 'Earlier\n\nline spacing' : 'Earlier\n\nline  spacing');
    const complete = history([prior, turn('current-export', 'Current\n\nquestion')]);
    session.acceptHistory(complete);
    if (changedSpace) {
      assert.match(pending.identityError.message, /identity changed/);
      assert.equal(session.pending, pending);
    } else assert.equal((await pending.promise).sourceTurn.id, 'current-export');
    assert.deepEqual(client.calls, []);
    await session.close();
  }
});

test('old ambiguous same-prompt groups do not block a later unique submitted source', async t => {
  const older = [['user', stampedPrompt('Continue')], ['assistant', 'One'], ['user', stampedPrompt('Continue')], ['assistant', 'Two']];
  const { session, client } = await start(t, { source: stampedHistory(older) });
  let claims = 0;
  session.onSubmittedSource = async () => { claims++; };
  const pending = session.begin('native', 'Continue\n'); pending.submitted = true;
  const latest = stampedHistory([...older, ['user', stampedPrompt('Continue', '02')], ['assistant', 'Unique latest answer']]);
  session.acceptHistory(latest);
  assert.equal((await pending.promise).sourceTurn.id, latest.turns[2].id);
  assert.equal(claims, 1);
  assert.deepEqual(client.calls, []);
});

test('a fresh duplicate envelope and a previously unique envelope losing uniqueness refuse ownership', async t => {
  for (const bindBeforeDuplicate of [false, true]) {
    const { session, client } = await start(t, { source: stampedHistory([]) });
    let claims = 0, resolved = false;
    session.onSubmittedSource = async () => { claims++; };
    const pending = session.begin('native', 'Continue'); pending.submitted = true;
    pending.promise.then(() => { resolved = true; }, () => {});
    const rows = [['user', stampedPrompt('Continue')], ['assistant', 'One']];
    if (bindBeforeDuplicate) { session.acceptHistory(stampedHistory(rows, false)); await Promise.resolve(); }
    session.acceptHistory(stampedHistory([...rows, ['user', stampedPrompt('Continue')], ['assistant', 'Two']]));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(resolved, false);
    assert.match(pending.identityError.message, /identity changed or is ambiguous/);
    assert.equal(claims, bindBeforeDuplicate ? 1 : 0);
    assert.deepEqual(client.calls, []);
  }
});

test('a reused positional source ID cannot complete a different native submission', async t => {
  const { session, client } = await start(t, { source: history([turn('source:turn:1', 'Old request', 'Old result')]) });
  const pending = session.begin('native', 'New request'); pending.submitted = true;
  let resolved = false; pending.promise.then(() => { resolved = true; }, () => {});
  session.acceptHistory(history([turn('source:turn:1', 'New request', 'New result')]));
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.match(pending.identityError.message, /identity changed/);
  assert.deepEqual(client.calls, []);
});

for (const fails of [false, true]) test(`canonical history before transport acknowledgement ${fails ? 'does not claim a failed paste' : 'waits for successful Enter'}`, async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  let claims = 0;
  session.onSubmittedSource = async () => { claims++; };
  const paste = client.paste.bind(client);
  client.paste = async (...args) => {
    session.acceptHistory(stampedHistory([['user', stampedPrompt('New question')], ['assistant', 'Fast canonical answer']]));
    await Promise.resolve();
    assert.equal(claims, 0);
    if (fails) throw new Error('Fixture failed before Enter');
    return paste(...args);
  };
  const response = session.prompt([{ type: 'text', text: 'New question' }]);
  if (fails) {
    await assert.rejects(response, /failed before Enter/);
    assert.equal(claims, 0);
    assert.equal(client.calls.some(call => call.type === 'Enter'), false);
  } else {
    assert.equal((await response).sourceTurn.items[1].text, 'Fast canonical answer');
    assert.equal(claims, 1);
    assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
  }
});

test('source revocation while durable submission binding waits cannot finish a stale canonical snapshot', async t => {
  const { session } = await start(t, { source: stampedHistory([]) });
  let release, claims = 0, resolved = false, current;
  const held = new Promise(resolve => { release = resolve; });
  session.onSubmittedSource = async event => { await held; current = event.isCurrent(); if (current) claims++; };
  const pending = session.begin('native', 'Continue'); pending.submitted = true;
  pending.promise.then(() => { resolved = true; }, () => {});
  const rows = [['user', stampedPrompt('Continue')], ['assistant', 'One']];
  session.acceptHistory(stampedHistory(rows));
  await Promise.resolve();
  session.acceptHistory(stampedHistory([...rows, ['user', stampedPrompt('Continue')], ['assistant', 'Two']]));
  release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(current, false); assert.equal(claims, 0); assert.equal(resolved, false);
  session.acceptHistory(stampedHistory(rows));
  await Promise.resolve();
  assert.equal(resolved, false, 'observed ambiguity cannot disappear merely because a rewrite removed its duplicate');
});

test('a recovered external source stays blocked after its observed envelope lost uniqueness', async t => {
  const rows = [['user', stampedPrompt('Continue')], ['assistant', 'One']];
  const { session } = await start(t, { source: stampedHistory(rows, false) });
  const pending = session.resumeObserver(session.history.turns[0].id, 'Continue');
  let resolved = false; pending.promise.then(() => { resolved = true; }, () => {});
  session.acceptHistory(stampedHistory([...rows, ['user', stampedPrompt('Continue')], ['assistant', 'Two']]));
  session.acceptHistory(stampedHistory(rows));
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.match(pending.identityError.message, /ambiguous/);
});

const settleBinding = () => new Promise(resolve => setImmediate(resolve));

test('verification restored after Enter durably binds the same source without sending again', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  let claims = 0;
  session.onSubmittedSource = async () => { claims++; };
  const response = session.prompt([{ type: 'text', text: 'New question' }]);
  response.catch(() => {});
  await client.submitted; await Promise.resolve();
  session.setVerified(false);
  const complete = stampedHistory([['user', stampedPrompt('New question')], ['assistant', 'Reply']]);
  session.acceptHistory(complete);
  const pending = session.pending;
  const sourceTurnId = pending.sourceTurnId;
  await settleBinding();
  assert.equal(claims, 0);
  assert.equal(pending.bindingPromise, undefined, 'an unverified TUI must not begin persistence');
  session.setVerified(true);
  session.acceptHistory(complete);
  assert.equal((await response).sourceTurn.id, sourceTurnId);
  assert.equal(claims, 1);
  assert.equal(pending.bindingComplete, true);
  assert.equal(pending.bindingError, null);
  assert.equal(client.calls.filter(call => call.type === 'paste').length, 1);
  assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
});

test('verification revoked before a scheduled binding retries under the new epoch', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  let claims = 0;
  session.onSubmittedSource = async () => { claims++; };
  const pending = session.begin('native', 'Continue'); pending.submitted = true;
  const complete = stampedHistory([['user', stampedPrompt('Continue')], ['assistant', 'Reply']]);
  session.acceptHistory(complete);
  const sourceTurnId = pending.sourceTurnId;
  session.setVerified(false);
  await settleBinding();
  assert.equal(claims, 0);
  assert.match(pending.bindingError.message, /not verified/);
  session.setVerified(true);
  session.acceptHistory(complete);
  assert.equal((await pending.promise).sourceTurn.id, sourceTurnId);
  assert.equal(claims, 1);
  assert.equal(pending.bindingError, null);
  assert.deepEqual(client.calls, []);
});

test('temporary persistence failure retries only the pinned source after backoff', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  let clock = session.now(), attempts = 0;
  session.now = () => clock;
  const sources = [];
  session.onSubmittedSource = async event => {
    sources.push(event.sourceTurn.id);
    assert.equal(event.isCurrent(), true);
    if (++attempts === 1) throw new Error('Fixture storage temporarily unavailable');
  };
  const pending = session.begin('native', 'Continue'); pending.submitted = true;
  const complete = stampedHistory([['user', stampedPrompt('Continue')], ['assistant', 'Reply']]);
  session.acceptHistory(complete);
  await settleBinding();
  assert.match(pending.bindingError.message, /temporarily unavailable/);
  for (let count = 0; count < 10; count++) session.acceptHistory(complete);
  clock += 999;
  session.acceptHistory(complete);
  await settleBinding();
  assert.equal(attempts, 1);
  clock++;
  session.acceptHistory(complete);
  assert.equal((await pending.promise).sourceTurn.id, sources[0]);
  session.acceptHistory(complete);
  await settleBinding();
  assert.equal(attempts, 2);
  assert.deepEqual(sources, [pending.sourceTurnId, pending.sourceTurnId]);
  assert.equal(pending.bindingError, null);
  assert.deepEqual(client.calls, []);
});

test('durable source binding is single flight and successful binding is never repeated', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  let release, attempts = 0, resolved = false;
  const held = new Promise(resolve => { release = resolve; });
  session.onSubmittedSource = async event => { attempts++; await held; assert.equal(event.isCurrent(), true); };
  const pending = session.begin('native', 'Continue'); pending.submitted = true;
  pending.promise.then(() => { resolved = true; });
  const rows = [['user', stampedPrompt('Continue')], ['assistant', 'Reply']];
  const incomplete = stampedHistory(rows, false);
  session.acceptHistory(incomplete);
  await settleBinding();
  for (let count = 0; count < 10; count++) session.acceptHistory(incomplete);
  await settleBinding();
  assert.equal(attempts, 1);
  assert.equal(resolved, false);
  release();
  await settleBinding();
  assert.equal(pending.bindingComplete, true);
  for (let count = 0; count < 10; count++) session.acceptHistory(incomplete);
  session.acceptHistory(stampedHistory(rows));
  await pending.promise;
  assert.equal(attempts, 1);
  assert.deepEqual(client.calls, []);
});

test('verification changing during persistence invalidates its attempt and safely retries the same source', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  let release, attempts = 0, firstCurrent;
  const held = new Promise(resolve => { release = resolve; });
  session.onSubmittedSource = async event => {
    if (++attempts === 1) { await held; firstCurrent = event.isCurrent(); }
    else assert.equal(event.isCurrent(), true);
  };
  const pending = session.begin('native', 'Continue'); pending.submitted = true;
  const complete = stampedHistory([['user', stampedPrompt('Continue')], ['assistant', 'Reply']]);
  session.acceptHistory(complete);
  await settleBinding();
  const sourceTurnId = pending.sourceTurnId;
  session.setVerified(false);
  session.setVerified(true);
  session.acceptHistory(complete);
  assert.equal(attempts, 1, 'verification changes cannot start a parallel attempt');
  release();
  await settleBinding();
  assert.equal(firstCurrent, false);
  assert.equal(pending.bindingComplete, undefined);
  assert.match(pending.bindingError.message, /changed while/);
  session.acceptHistory(complete);
  assert.equal((await pending.promise).sourceTurn.id, sourceTurnId);
  assert.equal(attempts, 2);
  assert.equal(pending.bindingError, null);
  assert.deepEqual(client.calls, []);
});

test('a pinned source disappearing or being replaced by the same text permanently prevents rebinding', async t => {
  for (const replacement of [[], [['user', stampedPrompt('Continue', '02')], ['assistant', 'Other reply']]]) {
    const { session, client } = await start(t, { source: stampedHistory([]) });
    let claims = 0;
    session.onSubmittedSource = async () => { claims++; };
    const pending = session.begin('native', 'Continue'); pending.submitted = true;
    const complete = stampedHistory([['user', stampedPrompt('Continue')], ['assistant', 'Original reply']]);
    session.setVerified(false);
    session.acceptHistory(complete);
    const sourceTurnId = pending.sourceTurnId;
    session.acceptHistory(stampedHistory(replacement));
    session.setVerified(true);
    session.acceptHistory(complete);
    await settleBinding();
    assert.equal(claims, 0);
    assert.equal(session.pending, pending);
    assert.equal(pending.sourceTurnId, sourceTurnId);
    assert.match(pending.identityError.message, /identity changed/);
    assert.deepEqual(client.calls, []);
  }
});

test('temporary persistence failure cannot retry after its pinned source becomes ambiguous', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  let attempts = 0;
  session.onSubmittedSource = async () => { attempts++; throw new Error('Fixture storage failed'); };
  const pending = session.begin('native', 'Continue'); pending.submitted = true;
  const rows = [['user', stampedPrompt('Continue')], ['assistant', 'Reply']];
  session.acceptHistory(stampedHistory(rows));
  await settleBinding();
  session.acceptHistory(stampedHistory([...rows, ...rows]));
  session.setVerified(false); session.setVerified(true);
  session.acceptHistory(stampedHistory(rows));
  await settleBinding();
  assert.equal(attempts, 1);
  assert.equal(session.pending, pending);
  assert.match(pending.identityError.message, /ambiguous/);
  assert.deepEqual(client.calls, []);
});

test('a model or original binding change blocks a pending durable claim', async t => {
  for (const change of ['model', 'binding-object', 'binding-field']) {
    const { session, client } = await start(t, { source: stampedHistory([]) });
    session.binding = { ...binding };
    let claims = 0;
    session.onSubmittedSource = async () => { claims++; };
    const pending = session.begin('native', 'Continue'); pending.submitted = true;
    const complete = stampedHistory([['user', stampedPrompt('Continue')], ['assistant', 'Reply']]);
    session.setVerified(false);
    session.acceptHistory(complete);
    if (change === 'model') session.model = 'another-model';
    else if (change === 'binding-object') session.binding = { ...binding };
    else session.binding.agentStartTime = 'different';
    session.setVerified(true);
    session.acceptHistory(complete);
    await settleBinding();
    assert.equal(claims, 0, change);
    assert.equal(session.pending, pending);
    assert.deepEqual(client.calls, []);
  }
});

test('closing the observer cancels a late durable callback without completing or retrying its turn', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  let release, current, attempts = 0;
  const held = new Promise(resolve => { release = resolve; });
  session.onSubmittedSource = async event => { attempts++; await held; current = event.isCurrent(); };
  const pending = session.begin('native', 'Continue'); pending.submitted = true;
  const rejected = assert.rejects(pending.promise, /observer detached/);
  const complete = stampedHistory([['user', stampedPrompt('Continue')], ['assistant', 'Reply']]);
  session.acceptHistory(complete);
  await settleBinding();
  await session.close();
  await rejected;
  release();
  await settleBinding();
  session.acceptHistory(complete);
  await settleBinding();
  assert.equal(current, false);
  assert.equal(attempts, 1);
  assert.equal(pending.bindingComplete, undefined);
  assert.equal(session.pending, null);
  assert.deepEqual(client.calls, []);
});

test('a completed same-prompt envelope exported late from an older minute cannot claim a fresh native send', async t => {
  const { session, client } = await start(t, { source: stampedHistory([]) });
  session.now = () => Date.UTC(2026, 9, 19, 11, 2, 15);
  let claims = 0, resolved = false;
  session.onSubmittedSource = async () => { claims++; };
  const pending = session.begin('native', 'Continue'); pending.submitted = true;
  pending.promise.then(() => { resolved = true; }, () => {});
  const older = [['user', stampedPrompt('Continue', '01')], ['assistant', 'Old late export']];
  session.acceptHistory(stampedHistory(older));
  await Promise.resolve();
  assert.equal(claims, 0); assert.equal(resolved, false);
  const fresh = stampedHistory([...older, ['user', stampedPrompt('Continue', '02')], ['assistant', 'Fresh answer']]);
  session.acceptHistory(fresh);
  assert.equal((await pending.promise).sourceTurn.id, fresh.turns[1].id);
  assert.equal(claims, 1); assert.deepEqual(client.calls, []);
});

test('a newly submitted native turn cannot show the previous reply before its user frame appears', async t => {
  const { session, client } = await start(t);
  const updates = [];
  session.on('update', update => updates.push(update));
  const response = session.prompt([{ type: 'text', text: 'New question' }]);
  response.catch(() => {});
  await client.submitted;
  // Input has reached the TUI, but its conversation area has not redrawn yet.
  await session.poll();
  assert.deepEqual(updates, []);
  client.raw = frame({ prompt: 'New question', answer: 'Earlier answer', busy: true });
  await session.poll();
  assert.deepEqual(updates, [{ sessionUpdate: 'terminal_snapshot', text: 'Earlier answer' }]);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('new', 'New question')]));
  await response;
});

test('an external busy turn publishes live snapshots and completes from that same source history', async t => {
  const { session, client } = await start(t);
  const external = []; const updates = [];
  session.on('externalTurn', event => external.push(event));
  session.on('update', event => updates.push(event));
  markSourceStarted(session, 'external', 'From tmux');
  client.raw = frame({ prompt: 'From tmux', answer: 'First partial', busy: true });
  await session.poll();
  assert.equal(external.length, 1);
  assert.equal(external[0].prompt, 'From tmux');
  assert.match(updates.at(-1).text, /First partial/);
  client.raw = frame({ prompt: 'From tmux', answer: 'Second partial', busy: true });
  await session.poll();
  assert.equal(external.length, 1);
  assert.match(updates.at(-1).text, /Second partial/);
  assert.deepEqual(client.calls, []);

  const completed = history([turn('old', 'Earlier question'), turn('external', 'From tmux', 'Complete external reply')]);
  client.raw = frame({ prompt: 'From tmux', answer: 'Complete external reply' });
  session.acceptHistory(completed);
  const result = await external[0].promise;
  assert.equal(result.origin, 'external');
  assert.equal(result.history, completed);
  session.turnCommitted();
  await session.poll();
  await session.poll();
  assert.equal(external.length, 1);
});

test('a checkpoint arriving before the busy frame clears cannot restart the completed turn', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
  markSourceStarted(session, 'external', 'From tmux');
  client.raw = frame({ prompt: 'From tmux', answer: 'Partial reply', busy: true });
  await session.poll();
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('external', 'From tmux')]));
  await external[0].promise;
  session.turnCommitted();
  await session.poll();
  await session.poll();
  assert.equal(external.length, 1);
  client.raw = frame({ prompt: 'From tmux', answer: 'Canonical reply' });
  await session.poll();
  markSourceStarted(session, 'external-next', 'Next from tmux');
  client.raw = frame({ prompt: 'Next from tmux', answer: 'Next partial', busy: true });
  await session.poll();
  assert.equal(external.length, 2);
});

test('an idle redraw with a changed historical user message does not invent a running turn', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
  client.raw = frame({ prompt: 'An older scrolled question', answer: 'Its completed answer' });
  await session.poll();
  assert.deepEqual(external, []);
});

test('drafts, approval overlays, shell mode and unrecognized screens never receive a paste', async t => {
  const blocked = [
    frame({ input: '→ My unfinished local draft' }),
    frame({ footer: `  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('~')}\n  Allow this command? [y/n]` }),
    frame({ input: '> ls' }),
    'A shell prompt $ ',
  ];
  for (const raw of blocked) {
    const { session, client } = await start(t, { client: new MockTmuxClient(raw) });
    await assert.rejects(session.prompt([{ type: 'text', text: 'A native message' }]), /input is unavailable/);
    assert.deepEqual(client.calls, []);
    await session.close();
  }
});

function branchWrappedFooter() {
  const frameWidth = row('').replace(/\x1b\[[\d;]*m/gu, '').length;
  const indent = '  ';
  const pathPrefix = '/fixtures/';
  const firstLine = `${indent}${pathPrefix}${'a'.repeat(frameWidth - indent.length - pathPrefix.length - 1)} `;
  assert.equal(firstLine.length, frameWidth);
  assert.equal(firstLine.at(-1), ' ', 'the separator space occupies the final frame column');
  return `  ${dim('Composer 2.5 · 5.1%')}\n${dim(firstLine)}\n${indent}${dim('· feat/example')}`;
}

test('an idle footer with its branch wrapped after the separator submits once to the original pane', async t => {
  const footer = branchWrappedFooter();
  const { session, client } = await start(t, { client: new MockTmuxClient(frame({ footer })) });
  await session.assertReady();
  assert.equal(session.screen.inputEmpty, true);
  assert.equal(session.screen.prompt, '');
  assert.deepEqual(client.calls, []);

  const prompt = 'Continue the example';
  client.pastedFrame = frame({ input: `→ ${prompt}`, footer });
  const response = session.prompt([{ type: 'text', text: prompt }]);
  response.catch(() => {});
  const submitted = await Promise.race([
    client.submitted.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 300)),
  ]);
  assert.equal(submitted, true, 'the exact pasted draft with the wrapped footer should receive Enter');
  assert.deepEqual(client.calls, [
    { type: 'paste-request', paneId: binding.paneId, text: prompt, sessionId: binding.sessionId },
    { type: 'paste', paneId: binding.paneId, text: prompt },
    { type: 'Enter', paneId: binding.paneId },
  ]);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('wrapped-footer', prompt)]));
  assert.equal((await response).sourceTurn.id, 'wrapped-footer');
  session.turnCommitted();
  await session.poll();
  assert.equal(client.calls.filter(call => call.type === 'Enter').length, 1);
});

test('a wrapped branch footer still blocks approval rows, menus and an existing local draft without typing', async t => {
  const footer = branchWrappedFooter();
  const blocked = [
    frame({ footer: `${footer}\n  Allow this command? [y/n]` }),
    frame({ footer: `${footer}\n  ${dim('Always allow')}` }),
    frame({ input: '→ Keep this local draft', footer }),
  ];
  for (const raw of blocked) {
    const { session, client } = await start(t, { client: new MockTmuxClient(raw) });
    await assert.rejects(session.assertReady(), /input is unavailable/);
    await assert.rejects(session.prompt([{ type: 'text', text: 'A native message' }]), /input is unavailable/);
    assert.deepEqual(client.calls, []);
    assert.equal(client.raw, raw, 'the original terminal contents must remain untouched');
    await session.close();
  }
});

test('a wrapped branch footer cannot bypass the exact post-paste draft check', async t => {
  const footer = branchWrappedFooter();
  const { session, client } = await start(t, { client: new MockTmuxClient(frame({ footer })) });
  client.pastedFrame = frame({ input: '→ A native message plus local text', footer });
  await assert.rejects(session.prompt([{ type: 'text', text: 'A native message' }]), /unsubmitted draft/);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste']);
  assert.match(client.raw, /plus local text/);
});

test('a draft arriving immediately before paste prevents both paste and Enter', async t => {
  const { session, client } = await start(t);
  client.beforeGuard = () => { client.raw = frame({ input: '→ Typed concurrently in tmux' }); };
  await assert.rejects(session.prompt([{ type: 'text', text: 'A native message' }]), /changed before paste/);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request']);
});

test('an altered draft after paste remains unsubmitted instead of sending Enter', async t => {
  const { session, client } = await start(t);
  client.pastedFrame = frame({ input: '→ A native message plus local text' });
  await assert.rejects(session.prompt([{ type: 'text', text: 'A native message' }]), /unsubmitted draft/);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste']);
  assert.match(client.raw, /plus local text/);
});

test('meaningful whitespace changed after paste also prevents Enter', async t => {
  const { session, client } = await start(t);
  client.pastedFrame = frame({ input: "→ Return the string 'a b'" });
  const response = session.prompt([{ type: 'text', text: "Return the string 'a  b'" }]);
  const result = await Promise.race([
    response.catch(error => error),
    new Promise(resolve => setTimeout(() => resolve(null), 600)),
  ]);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste']);
  assert.match(result?.message || '', /unsubmitted draft/);
});

test('an approval overlay appearing after paste cannot receive Enter even with the expected draft', async t => {
  const { session, client } = await start(t);
  client.pastedFrame = frame({
    input: '→ A native message',
    footer: `  ${dim('Composer 2.5 · 5.1%')}\n  ${dim('~')}\n  Allow this command? [y/n]`,
  });
  const response = session.prompt([{ type: 'text', text: 'A native message' }]);
  const result = await Promise.race([
    response.catch(error => error),
    new Promise(resolve => setTimeout(() => resolve(null), 600)),
  ]);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste']);
  assert.match(result?.message || '', /unsubmitted draft/);
});

test('history from another session and an old identical prompt cannot complete the current turn', async t => {
  const prompt = 'Continue';
  const old = turn('old-continue', prompt, 'Previous response');
  const { session, client } = await start(t, { source: history([old]) });
  const response = session.prompt([{ type: 'text', text: prompt }]);
  let resolved = false;
  response.then(() => { resolved = true; });
  await client.submitted;
  session.acceptHistory(history([old, turn('foreign', prompt)], true, 'different-session'));
  session.acceptHistory(history([old]));
  await Promise.resolve();
  assert.equal(resolved, false);
  const completed = history([old, turn('new-continue', prompt, 'New response')]);
  session.acceptHistory(completed);
  assert.equal((await response).sourceTurn.id, 'new-continue');
});

test('closing an observer rejects its pending promise and leaves the real Agent untouched', async t => {
  const { session, client } = await start(t);
  const response = session.prompt([{ type: 'text', text: 'A native message' }]);
  const rejected = assert.rejects(response, /original Agent keeps running/);
  await client.submitted;
  await session.close();
  await rejected;
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  assert.equal(session.state, 'closed');
});

for (const secondComplete of [true, false]) {
  test(`one history scan completes the pending external turn when a second turn is already ${secondComplete ? 'complete' : 'in progress'}`, async t => {
    const { session, client } = await start(t);
    const external = [];
    session.on('externalTurn', event => external.push(event));
    markSourceStarted(session, 'external-first', 'First from tmux');
    client.raw = frame({ prompt: 'First from tmux', answer: 'First partial', busy: true });
    await session.poll();
    assert.equal(external.length, 1);

    const first = turn('external-first', 'First from tmux', 'First canonical reply');
    const second = { ...turn('external-second', 'Second from tmux', 'Second reply'), status: secondComplete ? 'completed' : 'inProgress' };
    if (!secondComplete) delete second.completedAt;
    const caughtUp = history([turn('old', 'Earlier question'), first, second], secondComplete);
    session.acceptHistory(caughtUp);
    const result = await external[0].promise;
    assert.equal(result.sourceTurn, first, 'the first pending turn must not wait for or resolve as the latest turn');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.history, caughtUp, 'the bridge needs the entire snapshot to publish the later source turn');
    assert.equal(result.history.turns.at(-1), second);
    assert.equal(session.pending, null);
    assert.deepEqual(client.calls, []);
  });
}

for (const prompt of ['请帮我分析这段非常长的中文问题并解释结果', 'cursor_auto_sync_session_with_a_very_long_unbroken_identifier']) {
  test(`an externally wrapped ${/^[\p{Script=Han}]/u.test(prompt) ? 'Chinese message' : 'unbroken token'} completes from its unwrapped canonical source`, async t => {
    const previous = turn('old-identical', prompt, 'Previous identical question reply');
    const { session, client } = await start(t, { source: history([previous]) });
    const external = [];
    session.on('externalTurn', event => external.push(event));
    const wrapped = `${prompt.slice(0, 10)}\n${prompt.slice(10)}`;
    markSourceStarted(session, 'new-wrapped', prompt);
    client.raw = frame({ prompt: wrapped, answer: 'Streaming current reply', busy: true });
    await session.poll();
    assert.equal(external.length, 1);
    assert.equal(external[0].prompt, wrapped);
    let resolved = false;
    external[0].promise.then(() => { resolved = true; });
    session.acceptHistory(history([previous]));
    await Promise.resolve();
    assert.equal(resolved, false, 'a prior turn with the same prompt must remain part of the baseline');

    const current = turn('new-wrapped', prompt, 'Canonical current reply');
    const completed = history([previous, current]);
    session.acceptHistory(completed);
    const result = await external[0].promise;
    assert.equal(result.sourceTurn, current);
    assert.equal(result.history, completed);
    assert.equal(result.stopReason, 'end_turn');
  });
}

test('an explicitly ended last turn with a partial transcript tail stays in the baseline for a repeated prompt', async t => {
  const prompt = 'Continue';
  const previous = turn('previous-identical', prompt, 'Previous canonical reply');
  const partialTail = { ...history([previous], false), completedTurnIds: [previous.id] };
  const { session, client } = await start(t, { source: partialTail });
  const external = [];
  session.on('externalTurn', event => external.push(event));
  markSourceStarted(session, 'current-identical', prompt);
  client.raw = frame({ prompt, answer: 'Current streaming reply', busy: true });
  await session.poll();
  assert.equal(external.length, 1);
  let resolved = false;
  external[0].promise.then(() => { resolved = true; });
  session.acceptHistory(partialTail);
  await Promise.resolve();
  assert.equal(resolved, false, 'the explicitly ended old turn cannot satisfy the repeated new prompt');
  const current = turn('current-identical', prompt, 'Current canonical reply');
  const completed = { ...history([previous, current], false), completedTurnIds: [previous.id, current.id] };
  session.acceptHistory(completed);
  const result = await external[0].promise;
  assert.equal(result.sourceTurn, current);
  assert.equal(result.history, completed);
});

test('an interrupted source turn resolves as cancelled without sending another cancellation to tmux', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
  markSourceStarted(session, 'interrupted', 'Interrupt this turn');
  client.raw = frame({ prompt: 'Interrupt this turn', answer: 'Partial before interruption', busy: true });
  await session.poll();
  const interrupted = { ...turn('interrupted', 'Interrupt this turn', 'Partial before interruption'), status: 'interrupted' };
  const completed = history([turn('old', 'Earlier question'), interrupted]);
  session.acceptHistory(completed);
  const result = await external[0].promise;
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.sourceTurn, interrupted);
  assert.equal(result.history, completed);
  assert.deepEqual(client.calls, []);
});

for (const scenario of ['changed prompt', 'repeated prompt with another user frame', 'repeated prompt after scrollback drops a frame']) {
  test(`a following busy turn starts after commit without an idle frame: ${scenario}`, async t => {
    const { session, client } = await start(t);
    const external = []; const updates = [];
    session.on('externalTurn', event => external.push(event));
    session.on('update', update => updates.push(update));
    const firstPrompt = scenario === 'changed prompt' ? 'First from tmux' : 'Continue';
    const nextPrompt = scenario === 'changed prompt' ? 'Next from tmux' : 'Continue';
    markSourceStarted(session, 'fast-first', firstPrompt);
    client.raw = frame({ prompt: firstPrompt, answer: 'First partial', busy: true });
    await session.poll();
    const first = turn('fast-first', firstPrompt, 'First canonical reply');
    const next = { ...turn('fast-next', nextPrompt, 'Next partial'), status: 'inProgress' };
    delete next.completedAt;
    const caughtUp = history([turn('old', 'Earlier question'), first, next], false);
    session.acceptHistory(caughtUp);
    assert.equal((await external[0].promise).sourceTurn, first);
    const prior = scenario === 'repeated prompt with another user frame' ? [{ prompt: firstPrompt, answer: 'First canonical reply' }] : [];
    client.raw = frame({ prompt: nextPrompt, answer: 'Next partial', busy: true, prior });
    await session.poll();
    assert.equal(external.length, 1, 'the next live turn must wait for the bridge to commit the first');
    session.turnCommitted();
    await session.poll();
    assert.equal(external.length, 2);
    assert.equal(external[1].prompt, nextPrompt);
    assert.equal(external[0].sourceTurnId, first.id);
    assert.equal(external[1].sourceTurnId, next.id);
    assert.equal(updates.at(-1).text, 'Next partial');
    assert.equal(updates.at(-1).text.includes(nextPrompt), false);
    await session.poll();
    assert.equal(external.length, 2);
    const completedNext = { ...next, status: 'completed', completedAt: 102 };
    session.acceptHistory(history([turn('old', 'Earlier question'), first, completedNext]));
    assert.equal((await external[1].promise).sourceTurn, completedNext);
  });
}

test('later turns already completed in the same history scan do not restart from delayed busy redraws', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
  markSourceStarted(session, 'completed-first', 'First fast question');
  client.raw = frame({ prompt: 'First fast question', answer: 'First partial', busy: true });
  await session.poll();
  const first = turn('completed-first', 'First fast question', 'First canonical reply');
  const second = turn('completed-second', 'Second fast question', 'Second canonical reply');
  session.acceptHistory(history([turn('old', 'Earlier question'), first, second]));
  const result = await external[0].promise;
  assert.equal(result.sourceTurn, first);
  assert.equal(result.history.turns.at(-1), second);
  session.turnCommitted();
  await session.poll();
  client.raw = frame({ prompt: 'Second fast question', answer: 'Second canonical reply', busy: true });
  await session.poll();
  client.raw = frame({ prompt: 'Second fast question', answer: 'Second canonical reply', busy: true, prior: [{ prompt: first.items[0].content[0].text, answer: 'First canonical reply' }] });
  await session.poll();
  assert.equal(external.length, 1, 'both completed turns have already been published through canonical history');
  markSourceStarted(session, 'completed-third', 'A genuinely new third question');
  client.raw = frame({ prompt: 'A genuinely new third question', answer: 'Third partial', busy: true });
  await session.poll();
  assert.equal(external.length, 2);
});

test('a partial transcript tail cannot restart its explicitly completed last turn from a delayed busy frame', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
  markSourceStarted(session, 'partial-tail-first', 'First question');
  client.raw = frame({ prompt: 'First question', answer: 'First partial', busy: true });
  await session.poll();
  const first = turn('partial-tail-first', 'First question', 'First canonical reply');
  const last = turn('partial-tail-last', 'Second question', 'Second canonical reply');
  session.acceptHistory({ ...history([turn('old', 'Earlier question'), first, last], false), completedTurnIds: [first.id, last.id] });
  assert.equal((await external[0].promise).sourceTurn, first);
  session.turnCommitted();
  client.raw = frame({ prompt: 'Second question', answer: 'Second canonical reply', busy: true,
    prior: [{ prompt: 'First question', answer: 'First canonical reply' }] });
  await session.poll();
  await session.poll();
  assert.equal(external.length, 1, 'completedTurnIds must suppress the ended final turn despite sourceComplete=false');
});

test('verification pauses observations and submissions until the original pane is verified again', async t => {
  const { session, client } = await start(t);
  const external = []; const updates = [];
  session.on('externalTurn', event => external.push(event));
  session.on('update', update => updates.push(update));
  const captures = client.captures;
  session.setVerified(false);
  markSourceStarted(session, 'paused-source', 'From a paused pane');
  client.raw = frame({ prompt: 'From a paused pane', answer: 'Do not emit until verified', busy: true });
  await session.poll();
  await session.poll();
  await assert.rejects(session.assertReady(), /not verified/);
  await assert.rejects(session.prompt([{ type: 'text', text: 'Do not paste' }]), /not verified/);
  assert.equal(client.captures, captures);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(external, []);
  assert.deepEqual(updates, []);
  session.setVerified(true);
  await session.poll();
  assert.equal(external.length, 1);
  assert.equal(updates.at(-1).text, 'Do not emit until verified');
  session.setVerified(false);
  const pausedCaptures = client.captures;
  await assert.rejects(session.cancel(), /not verified/);
  assert.equal(client.captures, pausedCaptures);
});

test('a capture started before verification is revoked cannot publish a stale pane frame', async t => {
  const { session, client } = await start(t);
  const external = []; const updates = [];
  session.on('externalTurn', event => external.push(event));
  session.on('update', update => updates.push(update));
  const originalScreen = session.screen;
  let release;
  const blockedCapture = new Promise(resolve => { release = resolve; });
  const capture = client.capture.bind(client);
  client.capture = () => blockedCapture;
  const polling = session.poll();
  session.setVerified(false);
  // Even an immediate re-verification must not revive the old in-flight read.
  session.setVerified(true);
  markSourceStarted(session, 'stale-source', 'Stale pane user');
  release(frame({ prompt: 'Stale pane user', answer: 'Stale pane reply', busy: true }));
  await polling;
  assert.equal(session.screen, originalScreen);
  assert.deepEqual(external, []);
  assert.deepEqual(updates, []);
  client.capture = capture;
  markSourceStarted(session, 'verified-current', 'Verified current user');
  client.raw = frame({ prompt: 'Verified current user', answer: 'Verified current reply', busy: true });
  await session.poll();
  assert.equal(external.length, 1);
  assert.equal(updates.at(-1).text, 'Verified current reply');
});

for (const [hint, key] of [['ctrl+c to stop', 'C-c'], ['esc to stop', 'Escape']]) {
  test(`cancel forwards only the verified Cursor stop key: ${key}`, async t => {
    const { session, client } = await start(t);
    markSourceStarted(session, 'cancel-source', 'Running from tmux');
    client.raw = frame({ prompt: 'Running from tmux', answer: 'Working', input: `${placeholder('Add a follow-up')}    ${hint}` });
    await session.poll();
    await session.cancel();
    assert.deepEqual(client.calls, [{ type: 'cancel', paneId: binding.paneId, sessionId: binding.sessionId, key }]);
  });
}

test('a stop-key phrase in reply text cannot authorize cancellation', async t => {
  const { session, client } = await start(t);
  const response = session.prompt([{ type: 'text', text: 'Explain stop keys' }]);
  response.catch(() => {});
  await client.submitted;
  client.raw = frame({ prompt: 'Explain stop keys', answer: 'The hint says ctrl+c to stop, or esc to stop.' });
  await assert.rejects(session.cancel(), /waiting for input|stop key is unrecognized/);
  assert.equal(client.calls.some(call => call.type === 'cancel'), false);
});

// Exact shapes from Cursor's cursor/list_available_models extension. Its
// currentValue is a catalog default, never the running pane's selection.
const opusMedium = 'claude-opus-5-5[context=300k,effort=medium,fast=false]';
const opusHighFast = 'claude-opus-5-5[context=300k,effort=high,fast=true]';
const composerFast = 'composer-2.5[fast=true]';
const liveModels = [composerFast, opusMedium, opusHighFast].map(model => ({ model, displayName: `Cursor · ${model.split('[')[0]}` }));
const fastDefinition = { id: 'fast', name: 'Fast', type: 'select', currentValue: 'false', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] };
const liveDefinitions = [
  { value: 'composer-2.5', name: 'Composer 2.5', configOptions: [fastDefinition] },
  { value: 'claude-opus-5-5', name: 'Claude Opus 5.5', configOptions: [
    { id: 'context', name: 'Context', type: 'select', currentValue: '1m', options: [{ value: '300k', name: '300K' }, { value: '1m', name: '1M' }] },
    { id: 'effort', name: 'Effort', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    fastDefinition,
  ] },
];
const modelFrame = (label, options = {}) => frame({ ...options, footer: `  ${dim(`${label} · 5.1%`)}\n  ${dim('~')}` });
const catalogOptions = { models: liveModels, modelDefinitions: liveDefinitions };

test('the verified CLI footer replaces an imported model and returns the exact catalog variant', async t => {
  const { session, result, client } = await start(t, { ...catalogOptions, client: new MockTmuxClient(modelFrame('Claude Opus 5.5 300K Medium')) });
  assert.equal(session.model, opusMedium);
  assert.equal(result.models.currentModelId, opusMedium);
  assert.deepEqual(await session.setModel(opusMedium), { currentModelId: opusMedium });
  await assert.rejects(session.setModel('composer-2.5'), /currently uses|Ambiguous/);
  await assert.rejects(session.setModel(opusHighFast), /currently uses/);
  assert.deepEqual(client.calls, [], 'model validation must never type into the original pane');

  const changed = [];
  session.on('model', model => changed.push(model));
  client.raw = modelFrame('Composer 2.5 Fast');
  await session.poll();
  await session.poll();
  assert.equal(session.model, composerFast);
  assert.deepEqual(changed, [composerFast]);
  await assert.rejects(session.setModel('composer-2.5'), /Ambiguous/);
  assert.deepEqual(await session.setModel(composerFast), { currentModelId: composerFast });
});

test('the original non-fast Composer model is recognized when ACP lists only its fast variant', async t => {
  const composerNormal = 'composer-2.5[fast=false]';
  const client = new MockTmuxClient(modelFrame('Composer 2.5'));
  const { session, result } = await start(t, {
    client, models: liveModels.filter(model => model.model === composerFast), modelDefinitions: [liveDefinitions[0]],
  });
  assert.equal(session.model, composerNormal);
  assert.equal(result.models.currentModelId, composerNormal);
  await assert.rejects(session.setModel(composerFast), /currently uses/);
  assert.deepEqual(await session.setModel(composerNormal), { currentModelId: composerNormal });
  assert.deepEqual(client.calls, []);

  client.pastedFrame = modelFrame('Composer 2.5', { input: '→ Correctly configured message' });
  const response = session.prompt([{ type: 'text', text: 'Correctly configured message' }], { model: composerNormal });
  response.catch(() => {});
  const submitted = await Promise.race([
    client.submitted.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 300)),
  ]);
  assert.equal(submitted, true);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('normal-composer', 'Correctly configured message')]));
  assert.equal((await response).sourceTurn.id, 'normal-composer');
});

test('a prompt using the verified full model configuration reaches the original Agent', async t => {
  const { session, client } = await start(t, { ...catalogOptions, client: new MockTmuxClient(modelFrame('Claude Opus 5.5 300K Medium')) });
  client.pastedFrame = modelFrame('Claude Opus 5.5 300K Medium', { input: '→ Verified model message' });
  const response = session.prompt([{ type: 'text', text: 'Verified model message' }], { model: opusMedium });
  response.catch(() => {});
  const submitted = await Promise.race([
    client.submitted.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 300)),
  ]);
  assert.equal(submitted, true);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste', 'Enter']);
  session.acceptHistory(history([turn('old', 'Earlier question'), turn('verified-model', 'Verified model message')]));
  assert.equal((await response).sourceTurn.id, 'verified-model');
});

test('an unknown or ambiguous footer leaves the observer running while refusing explicit model selection and sends', async t => {
  for (const label of ['Unknown New Model', 'Claude Opus 5.5 300K Medium']) {
    const models = label.startsWith('Unknown') ? liveModels : [...liveModels, { model: 'claude-opus-5-5[effort=medium,fast=false,context=300k]', displayName: 'duplicate canonical configuration' }];
    const { session, result, client } = await start(t, { ...catalogOptions, models, client: new MockTmuxClient(modelFrame(label)) });
    assert.equal(session.state, 'ready');
    assert.equal(result.models, undefined);
    await assert.rejects(session.assertReady(), /model cannot be verified/);
    await assert.rejects(session.setModel(composerFast), /model cannot be verified/);
    await assert.rejects(session.prompt([{ type: 'text', text: 'Do not send' }]), /model cannot be verified/);
    assert.deepEqual(client.calls, []);
  }
});

test('an unsupported Auto Balance model with a private local draft still opens its observer without typing', async t => {
  const client = new MockTmuxClient(modelFrame('Auto Balance', { input: '→ Existing private local draft' }));
  const { session, result } = await start(t, { ...catalogOptions, client });
  assert.equal(session.state, 'ready');
  assert.equal(result.models, undefined);
  await session.poll();
  await assert.rejects(session.assertReady(), /input-has-draft/);
  await assert.rejects(session.prompt([{ type: 'text', text: 'Do not overwrite the local draft' }]), /input-has-draft/);
  await assert.rejects(session.setModel(composerFast), /model cannot be verified/);
  assert.deepEqual(client.calls, []);
  assert.match(client.raw, /Existing private local draft/);
});

test('an unsupported busy model can mirror and complete an external turn from canonical history', async t => {
  const { session, client } = await start(t, { ...catalogOptions, client: new MockTmuxClient(modelFrame('Auto Balance')) });
  const external = [];
  session.on('externalTurn', event => external.push(event));
  markSourceStarted(session, 'unsupported-model-turn', 'External question');
  client.raw = modelFrame('Auto Balance', { prompt: 'External question', answer: 'External streaming reply', busy: true });
  await session.poll();
  assert.equal(external.length, 1);
  const current = turn('unsupported-model-turn', 'External question', 'Canonical external reply');
  session.acceptHistory(history([turn('old', 'Earlier question'), current]));
  assert.equal((await external[0].promise).sourceTurn, current);
  assert.deepEqual(client.calls, []);
});

test('setModel reads a fresh footer and cannot pass a previously verified ID on unknown or changed screens', async t => {
  const { session, client } = await start(t, { ...catalogOptions, client: new MockTmuxClient(modelFrame('Claude Opus 5.5 300K Medium')) });
  client.raw = modelFrame('Claude Opus 5.5 300K High Fast');
  await assert.rejects(session.setModel(opusMedium), /currently uses/);
  assert.equal(session.model, opusHighFast);
  client.raw = modelFrame('Unknown New Model');
  await assert.rejects(session.setModel(opusHighFast), /model cannot be verified/);
  await assert.rejects(session.prompt([{ type: 'text', text: 'Do not send' }], { model: opusHighFast }), /model cannot be verified/);
  assert.deepEqual(client.calls, []);
});

test('a model request remains constrained when the CLI changes before prompt admission', async t => {
  const { session, client } = await start(t, { ...catalogOptions, client: new MockTmuxClient(modelFrame('Claude Opus 5.5 300K Medium')) });
  await session.setModel(opusMedium);
  client.raw = modelFrame('Claude Opus 5.5 300K High Fast');
  await assert.rejects(session.prompt([{ type: 'text', text: 'Do not send' }], { model: opusMedium }), /currently uses/);
  assert.deepEqual(client.calls, []);
});

test('a CLI model change immediately before paste prevents typing into the original pane', async t => {
  const { session, client } = await start(t, { ...catalogOptions, client: new MockTmuxClient(modelFrame('Claude Opus 5.5 300K Medium')) });
  client.beforeGuard = () => { client.raw = modelFrame('Composer 2.5 Fast'); };
  await assert.rejects(session.prompt([{ type: 'text', text: 'Do not send' }], { model: opusMedium }), /currently uses/);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request']);
});

test('a CLI model change after paste leaves the message unsubmitted', async t => {
  const { session, client } = await start(t, { ...catalogOptions, client: new MockTmuxClient(modelFrame('Claude Opus 5.5 300K Medium')) });
  client.pastedFrame = modelFrame('Composer 2.5 Fast', { input: '→ Do not send' });
  await assert.rejects(session.prompt([{ type: 'text', text: 'Do not send' }], { model: opusMedium }), /currently uses/);
  assert.deepEqual(client.calls.map(call => call.type), ['paste-request', 'paste']);
});
