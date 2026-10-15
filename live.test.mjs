import test from 'node:test';
import assert from 'node:assert/strict';
import { TmuxSession } from './live.mjs';

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
    this.submitted = new Promise(resolve => { this.didSubmit = resolve; });
  }

  async capture(paneId) {
    assert.equal(paneId, binding.paneId);
    this.captures++;
    return this.raw;
  }

  async paste(paneId, text, options) {
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
  async submitDraft(paneId, { sessionId, beforeSubmit }) {
    this.calls.push({ type: 'submit-draft-request', paneId, sessionId });
    await this.beforeSubmitGuard?.();
    await beforeSubmit();
    this.calls.push({ type: 'Enter', paneId });
    this.didSubmit();
  }
  async kill() { this.calls.push({ type: 'kill' }); }
  async close() { this.calls.push({ type: 'client-close' }); }
}

async function start(t, { client = new MockTmuxClient(), source = history([turn('old', 'Earlier question', 'Earlier answer')]), sourceTurnIds = [], models, modelDefinitions } = {}) {
  const session = new TmuxSession({ client, binding, model: 'composer-2.5[fast=true]', models, modelDefinitions, history: source, sourceTurnIds, interval: 60_000 });
  t.after(() => session.close());
  const result = await session.start();
  return { session, client, result };
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
  client.raw = frame({ prompt: 'A genuinely new third question', answer: 'Third partial', busy: true });
  await session.poll();
  assert.equal(external.length, 2);
});

test('a partial transcript tail cannot restart its explicitly completed last turn from a delayed busy frame', async t => {
  const { session, client } = await start(t);
  const external = [];
  session.on('externalTurn', event => external.push(event));
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
  release(frame({ prompt: 'Stale pane user', answer: 'Stale pane reply', busy: true }));
  await polling;
  assert.equal(session.screen, originalScreen);
  assert.deepEqual(external, []);
  assert.deepEqual(updates, []);
  client.capture = capture;
  client.raw = frame({ prompt: 'Verified current user', answer: 'Verified current reply', busy: true });
  await session.poll();
  assert.equal(external.length, 1);
  assert.equal(updates.at(-1).text, 'Verified current reply');
});

for (const [hint, key] of [['ctrl+c to stop', 'C-c'], ['esc to stop', 'Escape']]) {
  test(`cancel forwards only the verified Cursor stop key: ${key}`, async t => {
    const { session, client } = await start(t);
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
