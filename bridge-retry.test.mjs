import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { TmuxSession } from './live.mjs';
import { UNSUBMITTED_DRAFT_ERROR } from './draft-recovery.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const binding = { paneId: '%8', panePid: 200, agentPid: 201, agentStartTime: '765432', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd: '/fixture/project' };
const prompt = `<codex_delegation>\n  <source_thread_id>00000000-1111-4222-8333-444444444444</source_thread_id>\n  <input>${'R'.repeat(260)}</input>\n</codex_delegation>`;
const sourceTurn = (id, text, reply = 'Synthetic reply') => ({
  id, status: 'completed', startedAt: 100, completedAt: 101,
  items: [{ id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text }] }, { id: `${id}-agent`, type: 'agentMessage', text: reply }],
});

function draftFrame(columns, draft) {
  const paint = text => ` \x1b[48;2;242;242;242m${text}${' '.repeat(Math.max(0, columns - 2 - stringWidth(text)))}\x1b[49m`;
  const rows = `${draft}\x1b[7m \x1b[27m`.split('\n').flatMap(line =>
    wrapAnsi(line, columns - 7, { trim: false, hard: true }).split('\n')
      .map((part, index) => index ? part.replace(/^ +/u, '') : part))
    .slice(-6).map((part, index) => paint(` ${index ? '  ' : '→ '}${part}`));
  return `  Cursor Agent\n  \x1b[2mv2025.01.01-test\x1b[0m\n\n${paint('')}\n${rows.join('\n')}\n${paint('')}\n\n  \x1b[2mComposer 2.5 · 5.1%\x1b[0m\n  \x1b[2m/fixture/project\x1b[0m\n`;
}

async function runFixture(scenario) {
  const home = process.env.CODEX_HOME;
  const threadId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const old = sourceTurn('source-old', 'Earlier question');
  const failed = {
    id: 'failed-native', status: 'failed', error: { message: UNSUBMITTED_DRAFT_ERROR },
    items: [{ id: 'failed-user', type: 'userMessage', content: [{ type: 'text', text: prompt }] }],
  };
  if (scenario !== 'unproven') failed.unsubmittedDraft = {
    version: 1, turnId: failed.id, sessionId: binding.sessionId, paneId: binding.paneId,
    agentPid: binding.agentPid, agentStartTime: binding.agentStartTime,
    model: 'composer-2.5[fast=true]', sourceTurnIds: [old.id],
  };
  const record = {
    version: 1, backend: 'legacy', cursorSessionId: binding.sessionId,
    tmuxAffinity: { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime },
    historySync: { sourceTurns: { [old.id]: old.id }, sourceItems: {} },
    thread: { id: threadId, cwd: binding.cwd, model: 'composer-2.5[fast=true]', name: 'Synthetic conversation', preview: 'Earlier question', turns: [old, failed] },
  };
  const store = join(home, 'cursor-bridge');
  await mkdir(store, { recursive: true });
  await writeFile(join(store, `${threadId}.json`), JSON.stringify(record));

  // Run the production RPC handler with its real persisted-record loader. The
  // isolated copy adds only a fixture seam for an already-open TmuxSession;
  // turn/start and all draft guards are copied unchanged from production.
  const source = (await readFile(join(directory, 'bridge.mjs'), 'utf8'))
    .replace(/(['"])\.\/([^'"]+\.mjs)\1/gu, (_match, _quote, name) => JSON.stringify(pathToFileURL(join(directory, name)).href));
  const modulePath = join(home, 'isolated-bridge.mjs');
  await writeFile(modulePath, `${source}\nexport function registerFixtureSession(id, session, send) { sessions.set(id, session); clients.add({ send }); }\n`);
  const { createBridge, registerFixtureSession } = await import(pathToFileURL(modulePath).href);
  const history = { id: binding.sessionId, cwd: binding.cwd, sourceComplete: true, turns: [old] };
  const client = {
    columns: 93, calls: [],
    draft: scenario === 'changed' ? prompt.replace('<codex_delegation>', '<other_delegation>') : prompt,
    async capture() { return draftFrame(this.columns, this.draft); },
    async paste() { throw new Error('Retry must never paste again'); },
    async submitDraft(_paneId, { minimumColumns, beforeSubmit }) {
      this.calls.push('submit-draft');
      const original = this.columns;
      this.columns = Math.max(original, minimumColumns ?? original);
      try {
        await beforeSubmit();
        if (['diagnostic', 'invalid-diagnostic'].includes(scenario)) {
          const multilineVerification = { version: 1, phase: 'scan', operation: 'capture', offset: 12,
            attempt: 15, mismatch: 'caret-offset', expectedCaretOffset: 1, actualCaretOffset: 2 };
          if (scenario === 'invalid-diagnostic') multilineVerification.text = '/private/draft';
          throw Object.assign(new Error(UNSUBMITTED_DRAFT_ERROR), { multilineVerification,
            unsubmittedDraft: { sessionId: binding.sessionId, paneId: binding.paneId,
              agentPid: binding.agentPid, agentStartTime: binding.agentStartTime,
              model: record.thread.model, sourceTurnIds: [old.id] } });
        }
        this.calls.push('Enter');
        setImmediate(() => session.acceptHistory({ ...history, turns: [old, sourceTurn('source-retry', prompt)] }));
      } finally { this.columns = original; }
    },
  };
  const session = new TmuxSession({ client, binding, model: record.thread.model, history, interval: 60_000 });
  await session.start();
  const readiness = [];
  const assertReady = session.assertReady.bind(session);
  session.assertReady = options => { readiness.push({ deferred: Boolean(options?.deferDraftCheck), proven: Boolean(options?.retryDraft) }); return assertReady(options); };
  const assertDraft = session.assertDraft.bind(session);
  session.assertDraft = (...args) => { client.calls.push(`verify-draft-at-${client.columns}`); return assertDraft(...args); };
  const messages = [];
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  const send = message => {
    messages.push(message);
    if (message.method === 'turn/completed') completed(message.params.turn);
  };
  registerFixtureSession(threadId, session, send);
  const bridge = createBridge({ send });
  try {
    await bridge.receive({ id: 1, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: prompt }] } });
    const response = messages.find(message => message.id === 1);
    let turn = null;
    if (response.result) {
      let timer;
      try { turn = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Retry completion timed out')), 2000); })]); }
      finally { clearTimeout(timer); }
    }
    const saved = JSON.parse(await readFile(join(store, `${threadId}.json`), 'utf8'));
    return { response, turn, readiness, calls: client.calls, columns: client.columns, savedTurnCount: saved.thread.turns.length,
      savedTurn: saved.thread.turns.at(-1), mapping: saved.historySync.sourceTurns['source-retry'] };
  } finally { await bridge.close(); await session.close(); }
}

if (process.argv[2] === '--bridge-retry-fixture') {
  process.stdout.write(JSON.stringify(await runFixture(process.argv[3])));
} else {
  async function fixture(t, scenario) {
    const temp = await mkdtemp(join(tmpdir(), 'cursor-bridge-retry-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--bridge-retry-fixture', scenario], {
      env: { ...process.env, CODEX_HOME: temp }, timeout: 8000,
    });
    return JSON.parse(stdout);
  }

  test('multiline diagnostics survive native error persistence without changing retry ownership', async t => {
    const result = await fixture(t, 'diagnostic');
    assert.equal(result.turn.error.message, UNSUBMITTED_DRAFT_ERROR);
    assert.deepEqual(JSON.parse(result.turn.error.additionalDetails), { multilineVerification: {
      version: 1, phase: 'scan', operation: 'capture', offset: 12, attempt: 15,
      mismatch: 'caret-offset', expectedCaretOffset: 1, actualCaretOffset: 2,
    } });
    assert.deepEqual(result.savedTurn.error, result.turn.error);
    assert.equal(result.savedTurn.unsubmittedDraft.version, 1);
    assert.equal(result.calls.includes('Enter'), false);
  });

  test('native errors discard multiline details containing draft text', async t => {
    const result = await fixture(t, 'invalid-diagnostic');
    assert.equal(result.turn.error.additionalDetails, null);
    assert.equal(result.savedTurn.error.additionalDetails, null);
    assert.equal(result.turn.error.message, UNSUBMITTED_DRAFT_ERROR);
    assert.equal(result.savedTurn.unsubmittedDraft.version, 1);
    assert.equal(result.calls.includes('Enter'), false);
  });

  test('turn/start admits a persisted clipped retry and verifies its complete draft before its only Enter', async t => {
    const result = await fixture(t, 'valid');
    assert.equal(result.response.error, undefined);
    assert.deepEqual(result.readiness, [{ deferred: true, proven: true }, { deferred: true, proven: true }]);
    assert.deepEqual(result.calls, ['submit-draft', 'verify-draft-at-145', 'Enter']);
    assert.equal(result.turn.status, 'completed');
    assert.equal(result.mapping, result.turn.id);
    assert.equal(result.savedTurnCount, 3);
    assert.equal(result.columns, 93);
  });

  test('turn/start refuses an unproven terminal draft before admitting another native turn', async t => {
    const result = await fixture(t, 'unproven');
    assert.match(result.response.error.message, /input-has-draft/);
    assert.deepEqual(result.readiness, [{ deferred: false, proven: false }]);
    assert.deepEqual(result.calls, []);
    assert.equal(result.savedTurnCount, 2);
  });

  test('turn/start deferred admission still rejects a changed hidden first line at the final retry guard', async t => {
    const result = await fixture(t, 'changed');
    assert.equal(result.response.error, undefined);
    assert.equal(result.turn.status, 'failed');
    assert.match(result.turn.error.message, /draft changed/);
    assert.deepEqual(result.calls, ['submit-draft', 'verify-draft-at-145']);
    assert.equal(result.mapping, undefined);
    assert.equal(result.columns, 93);
  });
}
