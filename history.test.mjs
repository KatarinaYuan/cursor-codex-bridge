import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, discoverHistory, createHistoryScanner } from './history.mjs';

const row = (role, text, extra = []) => JSON.stringify({ role, message: { content: [{ type: 'text', text }, ...extra] } });

test('parses native messages, unwraps user query and retains assistant text without tools', () => {
  const history = parseTranscript([
    row('user', '<timestamp>today</timestamp>\n<user_query>\nRead the code\n</user_query>'),
    row('assistant', 'I will inspect it.', [{ type: 'tool_use', name: 'Read', input: { path: 'secret' } }]),
    row('assistant', 'The answer.'),
    JSON.stringify({ type: 'turn_ended', status: 'success' }),
    row('user', 'Continue'), row('assistant', 'Done'),
  ].join('\n'), { id: 'chat', cwd: '/work', createdAt: 1_760_000_000_000, updatedAt: 1_760_000_010_000 });
  assert.equal(history.title, 'Read the code');
  assert.equal(history.createdAt, 1_760_000_000);
  assert.equal(history.updatedAt, 1_760_000_010);
  assert.equal(history.turns.length, 2);
  assert.equal(history.turns[0].items.length, 3);
  assert.equal(history.turns[0].items[0].content[0].text, 'Read the code');
  assert.equal(history.turns[0].items[1].text, 'I will inspect it.');
  assert.equal(history.turns[0].rootTurnId, history.turns[0].id);
  assert.equal(history.turns[0].itemsView, 'full');
  assert.equal(history.turns[0].startedAt, null);
  assert.equal(history.turns[0].completedAt, null);
  assert.equal(history.turns[0].durationMs, null);
  assert.equal(history.turns[0].items[0].clientId, null);
  assert.deepEqual(history.turns[0].items[0].content[0].text_elements, []);
  for (const key of ['memoryCitation', 'delivery', 'questions']) assert.equal(history.turns[0].items[1][key], null);
  assert.ok(!JSON.stringify(history).includes('secret'));
});

test('starts another turn on a user message even without turn_ended markers', () => {
  const history = parseTranscript([row('user', 'First'), row('assistant', 'One'), row('user', 'Second')].join('\n'));
  assert.equal(history.turns.length, 2);
  assert.equal(history.turns[1].items[0].content[0].text, 'Second');
});

test('tolerates partial JSONL append and marks explicit failures', () => {
  const history = parseTranscript([row('user', 'Try'), '{"type":"turn_ended","status":"failed","error":"denied"}', '{"role":'].join('\n'));
  assert.equal(history.turns.length, 1);
  assert.equal(history.turns[0].status, 'failed');
  assert.equal(history.turns[0].error.message, 'denied');
});

test('retains exact completed source IDs when a following JSON row is incomplete', () => {
  const parsed = parseTranscript([row('user', 'Continue'), row('assistant', 'Old answer'),
    JSON.stringify({ type: 'turn_ended', status: 'success' }), '{"role":"user"'].join('\n'), { id: 'repeat' });
  assert.deepEqual(parsed.completedTurnIds, ['repeat:turn:0']);
  const next = parseTranscript([row('user', 'Continue'), row('assistant', 'Old answer'), row('user', 'Continue')].join('\n'), { id: 'repeat' });
  assert.deepEqual(next.completedTurnIds, ['repeat:turn:0']);
});

test('preserves partial responses and marks explicit interruption spellings', () => {
  for (const status of ['aborted', 'cancelled', 'canceled', 'interrupted']) {
    const history = parseTranscript([
      row('user', 'Try'), row('assistant', 'Partial answer'),
      JSON.stringify({ type: 'turn_ended', status }),
    ].join('\n'));
    assert.equal(history.turns.length, 1, status);
    assert.equal(history.turns[0].status, 'interrupted', status);
    assert.equal(history.turns[0].error, null, status);
    assert.equal(history.turns[0].items[1].text, 'Partial answer', status);
  }
});

test('discovers transcripts with exact cwd from chat metadata and sibling MD5 folder', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cursor-history-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = '/work_with-characters/project';
  const chatRoot = join(home, '.cursor', 'chats', 'workspace-hash');
  const projectRoot = join(home, '.cursor', 'projects', 'work-with-characters-project', 'agent-transcripts');
  for (const id of ['native-1', 'native-2']) {
    await mkdir(join(chatRoot, id), { recursive: true });
    await mkdir(join(projectRoot, id), { recursive: true });
    await writeFile(join(projectRoot, id, `${id}.jsonl`), [row('user', `Question ${id}`), row('assistant', 'Answer')].join('\n'));
  }
  await writeFile(join(chatRoot, 'native-1', 'meta.json'), JSON.stringify({ cwd, title: 'Native title', createdAtMs: 1_760_000_000_000, updatedAtMs: 1_760_000_001_000 }));
  const discovered = await discoverHistory({ home });
  assert.equal(discovered.length, 2);
  assert.ok(discovered.every((entry) => entry.cwd === cwd));
  assert.equal(discovered.find((entry) => entry.id === 'native-1').title, 'Native title');
  assert.equal((await discoverHistory({ home, cwd: '/wrong' })).length, 0);
  assert.equal((await discoverHistory({ home, cwd })).length, 2);
});

test('returns no history when Cursor has never run', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cursor-empty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await discoverHistory({ home }), []);
});

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cursor-scan-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = options.cwd || '/work_with-characters/project';
  const id = options.id || 'native-chat';
  const chat = join(home, '.cursor', 'chats', 'cwd-hash', id);
  const transcriptDir = join(home, '.cursor', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, ''), 'agent-transcripts', id);
  await mkdir(chat, { recursive: true });
  await mkdir(transcriptDir, { recursive: true });
  const metadataPath = join(chat, 'meta.json');
  const sourcePath = join(transcriptDir, `${id}.jsonl`);
  await writeFile(metadataPath, JSON.stringify({ cwd, title: 'CLI history', createdAtMs: 1_760_000_000_000, updatedAtMs: 1_760_000_001_000 }));
  await writeFile(sourcePath, [row('user', 'First'), row('assistant', 'Answer'), '{"type":"turn_ended","status":"success"}'].join('\n') + '\n');
  return { home, cwd, id, metadataPath, sourcePath, scanner: createHistoryScanner({ home }) };
}

test('scanner caches unchanged bodies, discovers new chats and detects metadata-only changes', async (t) => {
  const { home, scanner, sourcePath, metadataPath, cwd } = await fixture(t);
  const first = await scanner.scan();
  assert.equal(first.changed.length, 1);
  assert.equal(first.histories[0].sourceComplete, true);
  const unchanged = await scanner.scan();
  assert.deepEqual(unchanged.changed, []);
  assert.strictEqual(unchanged.histories[0].turns, first.histories[0].turns);

  await writeFile(metadataPath, JSON.stringify({ cwd, title: 'Renamed from CLI' }));
  const renamed = await scanner.scan();
  assert.equal(renamed.changed[0].title, 'Renamed from CLI');
  assert.strictEqual(renamed.changed[0].turns, first.histories[0].turns);
  assert.equal(renamed.changed[0].createdAt, first.histories[0].createdAt);
  assert.notEqual(renamed.changed[0].sourceRevision, first.histories[0].sourceRevision);

  const otherPath = join(sourcePath, '..', '..', 'new-chat', 'new-chat.jsonl');
  await mkdir(join(otherPath, '..'), { recursive: true });
  await writeFile(otherPath, row('user', 'A new CLI chat'));
  const added = await scanner.scan();
  assert.equal(added.histories.length, 2);
  assert.equal(added.changed.length, 1);
  assert.equal(added.changed[0].id, 'new-chat');
  assert.equal(added.changed[0].cwd, cwd);
  assert.equal(added.changed[0].sourceComplete, false);
  assert.deepEqual(added.errors, []);
  assert.equal((await discoverHistory({ home })).length, 2);
});

test('scanner handles partial append, then updates the same conversation after completion', async (t) => {
  const { scanner, sourcePath } = await fixture(t);
  const first = await scanner.scan();
  const extra = row('user', 'Second question');
  await appendFile(sourcePath, extra.slice(0, 15));
  const partial = await scanner.scan();
  assert.equal(partial.histories[0].turns.length, 1);
  assert.equal(partial.histories[0].sourceComplete, false);
  assert.equal(partial.changed.length, 1);
  assert.deepEqual(partial.errors, []);

  await appendFile(sourcePath, extra.slice(15) + '\n' + row('assistant', 'Second answer') + '\n' + '{"type":"turn_ended","status":"success"}\n');
  const completed = await scanner.scan();
  assert.equal(completed.histories[0].turns.length, 2);
  assert.equal(completed.histories[0].turns[1].items[1].text, 'Second answer');
  assert.equal(completed.histories[0].sourceComplete, true);
  assert.equal(completed.histories[0].turns[0].id, first.histories[0].turns[0].id);
  assert.notEqual(completed.histories[0].sourceRevision, partial.histories[0].sourceRevision);
});

test('scanner advances recency from transcript mtime when Cursor metadata has not updated', async (t) => {
  const { scanner, sourcePath } = await fixture(t);
  const oldTime = new Date(1_760_000_000_000);
  await utimes(sourcePath, oldTime, oldTime);
  const first = await scanner.scan();
  assert.equal(first.histories[0].updatedAt, 1_760_000_001);
  await appendFile(sourcePath, row('user', 'New turn without a metadata write') + '\n');
  const appended = await scanner.scan();
  assert.ok(appended.histories[0].updatedAt > first.histories[0].updatedAt);
  assert.equal(appended.histories[0].sourceComplete, false);
  const unchanged = await scanner.scan();
  assert.equal(unchanged.histories[0].updatedAt, appended.histories[0].updatedAt);
  assert.deepEqual(unchanged.changed, []);
});

test('a partial first row is retried after its remaining bytes are appended', async (t) => {
  const { scanner, sourcePath } = await fixture(t);
  await writeFile(sourcePath, '{"role":');
  assert.deepEqual((await scanner.scan()).histories, []);
  await appendFile(sourcePath, '"user","message":{"content":[{"type":"text","text":"Now complete"}]}}\n');
  const result = await scanner.scan();
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].turns[0].items[0].content[0].text, 'Now complete');
});

test('scanner detects atomic replacement and same-size rewrites with restored mtime', async (t) => {
  const { scanner, sourcePath } = await fixture(t);
  const first = await scanner.scan();
  const replacement = `${sourcePath}.tmp`;
  const nextText = [row('user', 'First'), row('assistant', 'Better'), '{"type":"turn_ended","status":"success"}'].join('\n') + '\n';
  await writeFile(replacement, nextText);
  await rename(replacement, sourcePath);
  const replaced = await scanner.scan();
  assert.equal(replaced.changed[0].turns[0].items[1].text, 'Better');
  assert.notEqual(replaced.changed[0].sourceRevision, first.histories[0].sourceRevision);

  const before = await stat(sourcePath);
  await writeFile(sourcePath, nextText.replace('Better', 'Newest'));
  await utimes(sourcePath, before.atime, before.mtime);
  const rewritten = await scanner.scan();
  assert.equal(rewritten.changed[0].turns[0].items[1].text, 'Newest');
  assert.notEqual(rewritten.changed[0].sourceRevision, replaced.changed[0].sourceRevision);
});

test('scanner retains successful snapshots through deletion, corrupt metadata and truncated rewrites', async (t) => {
  const { scanner, sourcePath, metadataPath, cwd } = await fixture(t);
  const first = await scanner.scan();
  await writeFile(metadataPath, '{"cwd":');
  const brokenMetadata = await scanner.scan();
  assert.equal(brokenMetadata.histories[0].cwd, cwd);
  assert.equal(brokenMetadata.histories[0].title, 'CLI history');
  assert.equal(brokenMetadata.errors[0].code, 'EINVALID');

  await writeFile(sourcePath, row('user', 'First') + '\n{"role":');
  const truncated = await scanner.scan();
  assert.deepEqual(truncated.histories[0].turns, first.histories[0].turns);
  assert.ok(truncated.errors.some((error) => error.code === 'EINCOMPLETE'));
  assert.equal(truncated.histories[0].sourceRevision, first.histories[0].sourceRevision);

  await rm(sourcePath);
  await rm(metadataPath);
  const missing = await scanner.scan();
  assert.deepEqual(missing.histories[0].turns, first.histories[0].turns);
  assert.deepEqual(missing.changed, []);
});

test('scanner refuses malformed complete rows without erasing the last good messages', async (t) => {
  const { scanner, sourcePath } = await fixture(t);
  const first = await scanner.scan();
  await appendFile(sourcePath, '{"role":\n' + row('assistant', 'Do not silently drop the corrupt row') + '\n');
  const broken = await scanner.scan();
  assert.deepEqual(broken.histories[0].turns, first.histories[0].turns);
  assert.equal(broken.errors[0].code, 'EINVALID');
  assert.deepEqual(broken.changed, []);
});

test('scanner never guesses an exact cwd from a lossy or ambiguous project name', async (t) => {
  const { home, scanner, sourcePath, metadataPath } = await fixture(t, { cwd: '/work_with-characters/project' });
  await rm(metadataPath);
  const unknown = await scanner.scan();
  assert.equal(unknown.histories[0].cwd, null);

  const otherCwd = '/work-with_characters/project';
  const otherChat = join(home, '.cursor', 'chats', 'another-hash', 'other');
  await mkdir(otherChat, { recursive: true });
  await writeFile(join(otherChat, 'meta.json'), JSON.stringify({ cwd: otherCwd }));
  await writeFile(metadataPath, JSON.stringify({ cwd: '/work_with-characters/project' }));
  const anonymousPath = join(sourcePath, '..', '..', 'unmapped', 'unmapped.jsonl');
  await mkdir(join(anonymousPath, '..'), { recursive: true });
  await writeFile(anonymousPath, row('user', 'Ambiguous'));
  const ambiguous = await scanner.scan();
  assert.equal(ambiguous.histories.find((history) => history.id === 'unmapped').cwd, null);
  assert.equal(ambiguous.histories.find((history) => history.id === 'native-chat').cwd, '/work_with-characters/project');
});

test('scanner excludes nested subagents and coalesces concurrent scan calls', async (t) => {
  const { scanner, sourcePath } = await fixture(t);
  const subagentPath = join(sourcePath, '..', 'subagents', 'subagent.jsonl');
  await mkdir(join(subagentPath, '..'), { recursive: true });
  await writeFile(subagentPath, row('user', 'Nested agent'));
  const a = scanner.scan();
  const b = scanner.scan();
  assert.strictEqual(a, b);
  const result = await a;
  assert.equal(result.histories.length, 1);
});
