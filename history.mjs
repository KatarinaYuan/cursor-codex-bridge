import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const textBlocks = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : '';

function userText(text) {
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return query ? query[1] : text.replace(/^<timestamp>[\s\S]*?<\/timestamp>\s*/, '');
}

function seconds(value, fallback = 0) {
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number > 100_000_000_000 ? number / 1000 : number);
}

/** Parse Cursor's human-readable JSONL export; never modify its native store. */
export function parseTranscript(text, options = {}) {
  const id = options.id ?? (options.sourcePath ? basename(options.sourcePath, '.jsonl') : 'cursor-history');
  const turns = [];
  const completedTurnIds = [];
  let current;
  let firstUser = '';
  let itemNumber = 0;
  const ensureTurn = () => {
    if (!current) {
      const turnId = `${id}:turn:${turns.length}`;
      current = {
        id: turnId, rootTurnId: turnId, items: [], itemsView: 'full',
        status: 'completed', error: null,
        startedAt: null, completedAt: null, durationMs: null,
      };
      turns.push(current);
    }
    return current;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; } // A live append may leave a partial final row.
    if (row.type === 'turn_ended') {
      if (current) completedTurnIds.push(current.id);
      if (current && ['aborted', 'cancelled', 'canceled', 'interrupted'].includes(row.status)) current.status = 'interrupted';
      if (current && (row.status === 'error' || row.status === 'failed')) {
        current.status = 'failed';
        current.error = { message: typeof row.error === 'string' ? row.error : 'Cursor turn failed', codexErrorInfo: null, additionalDetails: null };
      }
      current = undefined;
      continue;
    }
    const role = row.role ?? row.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let content = textBlocks(row.message?.content ?? row.content);
    if (role === 'user') content = userText(content);
    if (!content.trim()) continue;
    if (role === 'user') {
      if (current?.items.some((item) => item.type === 'userMessage')) {
        completedTurnIds.push(current.id);
        current = undefined;
      }
      if (!firstUser) firstUser = content;
      ensureTurn().items.push({ id: `${id}:item:${itemNumber++}`, type: 'userMessage', clientId: null, content: [{ type: 'text', text: content, text_elements: [] }] });
    } else {
      ensureTurn().items.push({ id: `${id}:item:${itemNumber++}`, type: 'agentMessage', text: content, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
    }
  }
  return {
    id,
    cwd: options.cwd ?? null,
    title: options.title?.trim() || firstUser.replace(/\s+/g, ' ').trim().slice(0, 100) || `Cursor ${id}`,
    createdAt: seconds(options.createdAt),
    updatedAt: seconds(options.updatedAt, seconds(options.createdAt)),
    turns,
    completedTurnIds,
    sourcePath: options.sourcePath ?? null,
  };
}

// ctime and inode catch replacements and same-size rewrites whose mtime was
// restored. Nanosecond precision also detects several appends within one tick.
function signature(details) {
  return [details.dev, details.ino, details.size, details.mtimeNs, details.ctimeNs].join(':');
}

const projectName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '');
const itemCount = (history) => history.turns.reduce((count, turn) => count + turn.items.length, 0);
const revision = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Poll ordinary CLI history without rereading unchanged transcript bodies.
 * Missing files and failed reads retain the last successful snapshot. The
 * caller must not interpret their absence as a request to delete a chat.
 */
export function createHistoryScanner({ home = homedir(), cwd } = {}) {
  const metadataFiles = new Map();
  const knownChats = new Map();
  const transcriptCache = new Map();
  let previousRevisions = new Map();
  let pending;

  async function scanHistory() {
    const errors = [];
    function report(path, error, message = error.message) {
      if (error.code !== 'ENOENT') errors.push({ path, code: error.code || 'EINVALID', message });
    }
    async function entries(path) {
      try { return await readdir(path, { withFileTypes: true }); }
      catch (error) { report(path, error); return []; }
    }
    async function directories(path) {
      return (await entries(path)).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
    }
    async function readMetadata(path) {
      const previous = metadataFiles.get(path);
      let details;
      try { details = await stat(path, { bigint: true }); }
      catch (error) { report(path, error); return; }
      const nextSignature = signature(details);
      if (previous?.signature === nextSignature) {
        if (previous.error) errors.push(previous.error);
        return;
      }
      const entry = { ...previous, signature: nextSignature, error: undefined };
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError();
        if (signature(await stat(path, { bigint: true })) !== nextSignature) {
          throw Object.assign(new Error('Metadata changed while reading; retrying on the next scan'), { code: 'EAGAIN' });
        }
        entry.value = { ...previous?.value, ...value };
      } catch (error) {
        // Never let a partially written meta.json erase a known exact cwd.
        entry.error = { path, code: error.code || 'EINVALID', message: error instanceof SyntaxError ? 'Invalid JSON metadata' : error.message };
        if (error.code !== 'ENOENT') errors.push(entry.error);
        if (error.code === 'EAGAIN') entry.signature = undefined;
      }
      metadataFiles.set(path, entry);
    }

    for (const workspace of await directories(join(home, '.cursor', 'chats'))) {
      let chats = knownChats.get(workspace);
      if (!chats) knownChats.set(workspace, chats = new Set());
      for (const chat of await directories(workspace)) {
        chats.add(basename(chat));
        await readMetadata(join(chat, 'meta.json'));
      }
    }

    const byId = new Map();
    const projectCwds = new Map();
    for (const [workspace, chats] of knownChats) {
      const workspaceCwds = new Set();
      for (const id of chats) {
        const value = metadataFiles.get(join(workspace, id, 'meta.json'))?.value;
        if (!value) continue;
        byId.set(id, value);
        if (typeof value.cwd !== 'string' || !value.cwd.startsWith('/')) continue;
        workspaceCwds.add(value.cwd);
        const key = projectName(value.cwd);
        if (!projectCwds.has(key)) projectCwds.set(key, new Set());
        projectCwds.get(key).add(value.cwd);
      }
      // Sibling metadata in Cursor's cwd-hashed folder gives an exact path.
      // An ambiguous folder must never choose one of several possible cwds.
      if (workspaceCwds.size === 1) for (const id of chats) {
        const metadata = byId.get(id) || {};
        if (!metadata.cwd) byId.set(id, { ...metadata, cwd: [...workspaceCwds][0] });
      }
    }

    async function transcriptFiles(root) {
      const files = [];
      for (const entry of await entries(root)) {
        const path = join(root, entry.name);
        if (entry.isDirectory() && entry.name !== 'subagents') files.push(...await transcriptFiles(path));
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
      }
      return files;
    }

    for (const project of await directories(join(home, '.cursor', 'projects'))) {
      for (const sourcePath of await transcriptFiles(join(project, 'agent-transcripts'))) {
        let entry = transcriptCache.get(sourcePath);
        if (!entry) transcriptCache.set(sourcePath, entry = { project: basename(project), id: basename(sourcePath, '.jsonl') });
        try {
          const details = await stat(sourcePath, { bigint: true });
          const nextSignature = signature(details);
          if (entry.signature === nextSignature) {
            if (entry.error) errors.push(entry.error);
            continue;
          }
          entry.signature = nextSignature;
          entry.error = undefined;
          const text = await readFile(sourcePath, 'utf8');
          if (signature(await stat(sourcePath, { bigint: true })) !== nextSignature) {
            throw Object.assign(new Error('Transcript changed while reading; retrying on the next scan'), { code: 'EAGAIN' });
          }
          const lines = text.split(/\r?\n/).filter((line) => line.trim());
          let partial = false;
          let lastRow;
          for (let index = 0; index < lines.length; index++) {
            try { lastRow = JSON.parse(lines[index]); }
            catch {
              if (index !== lines.length - 1 || text.endsWith('\n')) throw Object.assign(new Error('Invalid complete transcript row'), { code: 'EINVALID' });
              partial = true;
            }
          }
          const parsed = parseTranscript(text, { id: entry.id, sourcePath });
          if (entry.base && itemCount(parsed) < itemCount(entry.base)) {
            throw Object.assign(new Error('Transcript temporarily contains less history; retaining the previous snapshot'), { code: 'EINCOMPLETE' });
          }
          if (!parsed.turns.length) continue;
          entry.base = parsed;
          entry.sourceComplete = !partial && lastRow?.type === 'turn_ended';
          entry.details = details;
          entry.validSignature = nextSignature;
        } catch (error) {
          entry.error = { path: sourcePath, code: error.code || 'EINVALID', message: error.message };
          report(sourcePath, error);
          // A file changing during a read must be retried even if its next stat
          // has the same signature as the one observed before the failed read.
          if (error.code === 'EAGAIN') entry.signature = undefined;
        }
      }
    }

    const result = new Map();
    for (const entry of transcriptCache.values()) {
      if (!entry.base) continue;
      const metadata = byId.get(entry.id) || {};
      const candidates = projectCwds.get(entry.project);
      const workspace = typeof metadata.cwd === 'string' && metadata.cwd.startsWith('/') ? metadata.cwd
        : candidates?.size === 1 ? [...candidates][0] : null;
      if (cwd && (!workspace || resolve(workspace) !== resolve(cwd))) continue;
      const details = entry.details;
      const metadataKey = JSON.stringify([workspace, metadata.title, metadata.createdAtMs, metadata.updatedAtMs]);
      const sourceRevision = revision(`${entry.validSignature}\n${metadataKey}`);
      const parsed = {
        ...entry.base,
        cwd: workspace,
        title: typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : entry.base.title,
        createdAt: seconds(metadata.createdAtMs, seconds(Number(details.birthtimeMs || details.mtimeMs))),
        // Metadata may lag behind a transcript append during a live turn.
        updatedAt: Math.max(seconds(metadata.updatedAtMs), seconds(Number(details.mtimeMs))),
        sourceRevision,
        sourceComplete: entry.sourceComplete,
      };
      const previous = result.get(parsed.id);
      if (!previous || parsed.updatedAt > previous.updatedAt) result.set(parsed.id, parsed);
    }
    const histories = [...result.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const changed = histories.filter((entry) => previousRevisions.get(entry.id) !== entry.sourceRevision);
    previousRevisions = new Map(histories.map((entry) => [entry.id, entry.sourceRevision]));
    return { histories, changed, errors };
  }

  return {
    scan() {
      if (!pending) pending = scanHistory().finally(() => { pending = undefined; });
      return pending;
    },
  };
}

/** Discover ordinary CLI chats, independent of Cursor's separate ACP namespace. */
export async function discoverHistory(options = {}) {
  return (await createHistoryScanner(options).scan()).histories;
}
