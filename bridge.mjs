import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CursorSession } from './cursor.mjs';
import { findLiveSourceTurn, finalizeLivePreview, hasSubmittedTurnClaim, nativeTurnTextSha256, observerTurnProof, recoverableObserverTurn, retainSubmittedTurn, submittedTurnTextSha256 } from './live-history.mjs';
import { queueList, queueAdd, queueUpdate, queueDelete, queueReorder, queuePeek, queueConsume } from './queue.mjs';
import { expandModelVariants } from './model-labels.mjs';
import { retryDraftFor, retainUnsubmittedDraft, pinLiveSourceTurn } from './draft-recovery.mjs';
import { resolveAttachmentDraftRetry } from './draft-attachments.mjs';
import { createMaintenanceGate } from './maintenance.mjs';
import { observerRetirementCandidate, planObserverRetirement } from './observer-recovery.mjs';
import { unboundExportCandidate, planUnboundExportRetirement } from './export-recovery.mjs';
import { cursorExportUserText } from './source-identity.mjs';

const PROVIDER = 'cursor';
const now = () => Math.floor(Date.now() / 1000);
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex_cursor_bridge');
const dataDir = path.join(home, 'cursor-bridge');
const inputDigest = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

function sameAdmittedInput(record, turn, user, input) {
  if (JSON.stringify(user.content) === JSON.stringify(input)) return true;
  const proof = record.attachmentDraftRequests?.[turn.id];
  return proof?.version === 1 && typeof user.clientId === 'string'
    && proof.clientUserMessageId === user.clientId
    && /^[a-f0-9]{64}$/u.test(proof.requestInputSha256)
    && /^[a-f0-9]{64}$/u.test(proof.canonicalInputSha256)
    && inputDigest(input) === proof.requestInputSha256
    && inputDigest(user.content) === proof.canonicalInputSha256;
}

// A retired observer can belong to an already submitted native request. Its
// durable receipt acknowledges retries without ever submitting that request a
// second time, including while a later CLI turn is running.
function retiredSubmission(record, clientId, input) {
  if (typeof clientId !== 'string' || !clientId.trim()) return null;
  const candidates = record.thread.turns.filter(turn => (record.retiredObserverTurns?.[turn.id] || record.retiredUnboundTurns?.[turn.id])
    && turn.items?.some(item => item.type === 'userMessage' && item.clientId === clientId));
  if (!candidates.length) return null;
  const turn = candidates[0], proof = record.retiredObserverTurns?.[turn.id] || record.retiredUnboundTurns[turn.id];
  const users = turn.items.filter(item => item.type === 'userMessage');
  const textOnly = users.length === 1 && Array.isArray(users[0].content) && users[0].content.length
    && users[0].content.every(block => block?.type === 'text' && typeof block.text === 'string');
  const projectedHash = textOnly ? createHash('sha256').update(cursorExportUserText(users[0].content.map(block => block.text).join('\n'))).digest('hex') : null;
  const unbound = record.retiredUnboundTurns?.[turn.id] === proof && proof.version === 1 && proof.reason === 'cursor-export-newlines'
    && proof.sourceCandidateTextSha256 === projectedHash
    && typeof proof.sourceCandidateId === 'string' && proof.sourceCandidateId.startsWith(`${record.cursorSessionId}:turn:envelope:`)
    && typeof proof.successorTurnId === 'string' && proof.successorTurnId.startsWith(`${record.cursorSessionId}:turn:envelope:`)
    && proof.sourceCandidateId !== proof.successorTurnId
    && typeof proof.model === 'string' && Boolean(proof.model.trim())
    && /^%\d+$/u.test(proof.paneId || '') && Number.isSafeInteger(proof.agentPid) && proof.agentPid > 0
    && typeof proof.agentStartTime === 'string' && /^\d+$/u.test(proof.agentStartTime);
  const submitted = [2, 3].includes(proof.version) && proof.origin === 'native'
    && proof.userTextSha256 === (proof.version === 3 ? projectedHash : submittedTurnTextSha256(turn));
  if (candidates.length !== 1 || turn.status !== 'interrupted' || (!unbound && !submitted)
    || proof.sessionId !== record.cursorSessionId || proof.clientId !== clientId
    || !textOnly
    || proof.nativeUserTextSha256 !== nativeTurnTextSha256(turn)
    || !sameAdmittedInput(record, turn, users[0], input)) {
    throw Object.assign(new Error('Retired Cursor message ID already belongs to different or unverifiable input'), { code: -32602 });
  }
  return turn;
}
const clients = new Set();
const records = new Map();
const sessions = new Map();
const startingSessions = new Map();
const openingSessionInstances = new Set();
let shuttingDown = false;
let shutdownPromise;
const threadLocks = new Map();
const saveLocks = new Map();
const routes = new Map();
const runningTurns = new Set();
const finishingTurns = new Set();
const turnExecutions = new Map();
const maintenance = createMaintenanceGate({
  file: process.env.CURSOR_BRIDGE_MAINTENANCE_FILE,
  locks: () => threadLocks.values(),
  isBusy: () => runningTurns.size > 0 || [...records.values()].some(r => r.thread.turns.some(t => t.status === 'inProgress')),
});
let historySync;
let tmuxSync;
const sourceHistories = new Map();
let initializedStore;
let catalogPromise;
let modelDefinitions = [];
let defaultModel = process.env.CURSOR_BRIDGE_MODEL || 'composer-2.5';

function uuid() {
  const bytes = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 15) | 0x70;
  return bytes.toString('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

async function loadStore() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(dataDir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const r = JSON.parse(await fs.readFile(path.join(dataDir, entry), 'utf8'));
      if (r.thread?.id) {
        for (const t of r.thread.turns || []) {
          if (t.status === 'inProgress' && !observerTurnProof(r, t.id) && !hasSubmittedTurnClaim(r, t.id)) {
            t.status = 'interrupted';
            t.completedAt = now();
          }
        }
        r.thread.status = { type: 'notLoaded' };
        records.set(r.thread.id, r);
      }
    } catch (error) {
      process.stderr.write(`Ignoring invalid bridge record ${entry}: ${error.message}\n`);
    }
  }
}

async function persist(r) {
  const previous = saveLocks.get(r.thread.id) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => saveRecord(r));
  saveLocks.set(r.thread.id, next);
  try { await next; } finally { if (saveLocks.get(r.thread.id) === next) saveLocks.delete(r.thread.id); }
}

async function saveRecord(r) {
  const target = path.join(dataDir, `${r.thread.id}.json`);
  const temp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(r), { mode: 0o600 });
  await fs.rename(temp, target);
}

async function withThreadLock(id, operation) {
  const previous = threadLocks.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  threadLocks.set(id, next);
  try { return await next; } finally { if (threadLocks.get(id) === next) threadLocks.delete(id); }
}

function publish(method, params) {
  for (const c of clients) c.send({ method, params });
}

function view(r, turns = false) {
  return { ...r.thread, turns: turns ? r.thread.turns : [] };
}

function status(r, state) {
  r.thread.status = state === 'active' ? { type: state, activeFlags: [] } : { type: state };
  publish('thread/status/changed', { threadId: r.thread.id, status: r.thread.status });
}

function requireRecord(id) {
  const r = records.get(id);
  if (!r) throw Object.assign(new Error(`Cursor bridge thread not found: ${id}`), { code: -32602 });
  return r;
}

function makeRecord({ id = uuid(), cwd, model, title = 'Cursor Agent', turns = [], createdAt = now(), updatedAt = now(), ...extra }) {
  return {
    version: 1, cursorSessionId: null, backend: 'acp', archived: false, ...extra,
    thread: {
      id, sessionId: id, forkedFromId: null, parentThreadId: null,
      preview: '', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
      historyMode: 'legacy', modelProvider: PROVIDER, model,
      reasoningEffort: null, createdAt, updatedAt, recencyAt: updatedAt,
      status: { type: 'notLoaded' }, path: path.join(dataDir, `${id}.json`), cwd,
      cliVersion: '0.160.0', originator: 'Cursor Agent Bridge', source: 'vscode',
      threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
      name: title, turns,
    },
  };
}

function sessionOptions(r, log) {
  return { cwd: r.thread.cwd, model: r.thread.model, log, agentPath: process.env.CURSOR_BRIDGE_AGENT || 'agent' };
}

async function catalog(log) {
  if (shuttingDown) throw new Error('Cursor bridge is shutting down');
  if (!catalogPromise) catalogPromise = (async () => {
    const probe = new CursorSession({ cwd: process.env.CURSOR_BRIDGE_CWD || os.homedir(), log, agentPath: process.env.CURSOR_BRIDGE_AGENT || 'agent' });
    openingSessionInstances.add(probe);
    try {
      const result = await probe.start();
      const models = result.models?.availableModels || [];
      if (!models.length) throw new Error('Cursor ACP returned no available models');
      try {
        const detailed = await probe.listAvailableModels();
        modelDefinitions = Array.isArray(detailed.models) ? detailed.models : [];
      } catch (error) {
        log?.(`Cursor model display definitions unavailable: ${error.message}`);
      }
      const preferred = models.find(m => m.modelId === defaultModel) || models.find(m => m.modelId.startsWith(`${defaultModel}[`)) || models.find(m => m.modelId === result.models.currentModelId) || models[0];
      defaultModel = preferred.modelId;
      const data = models.map(m => ({
        id: m.modelId, model: m.modelId, displayName: `Cursor · ${m.name || m.modelId}`,
        description: m.description || 'Runs on the remote host through Cursor Agent', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Uses the selected Cursor model configuration' }],
        defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], supportsPersonality: false,
        isDefault: m.modelId === defaultModel, upgrade: null,
        upgradeInfo: null, availabilityNux: null, modelSpecialty: null,
        multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
        defaultServiceTier: null, availableAccessPrograms: null,
      }));
      const selectable = new Set(data.map(model => model.model));
      // ACP's legacy picker advertises one configured variant per family. A
      // running TUI can use another official combination; retain that variant
      // as hidden metadata without offering it to new legacy-picker sessions.
      return expandModelVariants({ models: data, modelDefinitions }).map(model => ({
        ...data[0], ...model, id: model.model,
        hidden: !selectable.has(model.model), isDefault: model.model === defaultModel,
      }));
    } finally { openingSessionInstances.delete(probe); await probe.close(); }
  })().catch(e => { catalogPromise = null; throw e; });
  return catalogPromise;
}

function threadResponse(r) {
  return {
    thread: view(r, true), model: r.thread.model, modelProvider: PROVIDER,
    serviceTier: null, disabledPluginIds: [], cwd: r.thread.cwd, instructionSources: [],
    approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandbox: { type: 'externalSandbox', networkAccess: 'enabled' },
    reasoningEffort: null, collaborationMode: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null,
  };
}

async function inputsToAcp(input) {
  const result = [];
  for (const item of input || []) {
    if (item.type === 'text') result.push({ type: 'text', text: item.text });
    else if (item.type === 'image' && item.url?.startsWith('data:')) {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(item.url);
      if (!match) throw new Error('Unsupported image data URL');
      result.push({ type: 'image', mimeType: match[1], data: match[2] });
    } else if (item.type === 'localImage') {
      const ext = path.extname(item.path).toLowerCase();
      const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[ext];
      if (!mimeType) throw new Error(`Unsupported image type: ${ext}`);
      result.push({ type: 'image', mimeType, data: (await fs.readFile(item.path)).toString('base64') });
    } else if (item.type === 'mention' || item.type === 'skill') {
      result.push({ type: 'text', text: `${item.type}: ${item.name}\nPath: ${item.path}` });
    } else throw new Error(`Cursor bridge does not yet support input type: ${item.type}`);
  }
  if (!result.length) throw new Error('Message is empty');
  return result;
}

function createBackend(send, log) {
  const executable = process.env.CURSOR_BRIDGE_REAL_CODEX;
  if (!executable) throw new Error('CURSOR_BRIDGE_REAL_CODEX must point to the genuine Codex executable');
  const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const pending = new Map();
  let sequence = 0;
  child.stderr.on('data', data => log?.(`codex: ${data.toString().slice(0, 2000)}`));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const msg = JSON.parse(line);
      if (!msg.method && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result);
      } else send(msg);
    } catch (e) { log?.(`Backend protocol error: ${e.message}`); }
  });
  child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
  child.on('exit', (code, signal) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Codex support server exited: ${code ?? signal}`)); } pending.clear(); });
  const write = msg => child.stdin.write(`${JSON.stringify(msg)}\n`);
  return {
    write,
    call(method, params) {
      const id = `support:${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Support RPC timed out: ${method}`)); }, 60000);
        pending.set(id, { resolve, reject, timer }); write({ id, method, params });
      });
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

export function createBridge({ send, log = () => {} }) {
  const outputLog = log;
  log = message => {
    outputLog(message);
    fs.appendFile(path.join(home, 'bridge-rpc.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }).catch(() => {});
  };
  let backend;
  let connected = false;
  let requestSequence = 0;
  const queueTimers = new Map();
  const approvals = new Map();
  const client = { send };
  const notify = (method, params) => publish(method, params);
  const support = () => backend ||= createBackend(send, log);
  const ask = (method, params, respond) => {
    const id = `cursor:${++requestSequence}:${randomUUID()}`;
    approvals.set(id, respond); send({ id, method, params });
  };

  function scheduleQueue(threadId, delay = 0) {
    if (!connected || shuttingDown || queueTimers.has(threadId)) return;
    const timer = setTimeout(async () => {
      queueTimers.delete(threadId);
      let retry = false;
      try {
        await withThreadLock(threadId, async () => {
          const r = records.get(threadId);
          if (!connected || shuttingDown || !r || r.archived || !queuePeek(r)) return;
          if (activeTurn(r)) { retry = true; return; }
          // Interrupted/failed work needs the native queue's explicit resume.
          if (['interrupted', 'failed'].includes(r.thread.turns.at(-1)?.status)) return;
          try { await handleUnlocked('thread/queue/start', { threadId }); }
          catch (error) {
            // A private CLI draft or approval may temporarily hold the input.
            // Keep the queued submission and re-check admission without typing.
            retry = true;
            if (r.queueWaitReason !== error.message) {
              r.queueWaitReason = error.message;
              log(`Cursor queue waiting threadId=${threadId}: ${error.message}`);
            }
          }
        });
      } catch (error) { log(`Cursor queue threadId=${threadId}: ${error.message}`); }
      if (retry) scheduleQueue(threadId, 2000);
    }, delay);
    timer.unref();
    queueTimers.set(threadId, timer);
  }

  async function ensureSession(r) {
    if (shuttingDown) throw new Error('Cursor bridge is shutting down');
    await retireCompletedObserver(r);
    let existing = sessions.get(r.thread.id);
    if (r.backend === 'legacy' && tmuxSync) {
      const binding = await findTmuxBinding(r);
      if (existing && (Boolean(binding) !== (existing.kind === 'tmux') || binding && (existing.binding.agentPid !== binding.agentPid || existing.binding.paneId !== binding.paneId))) {
        if (runningTurns.has(r.thread.id)) throw new Error('Wait for the active Cursor turn before changing its terminal attachment');
        sessions.delete(r.thread.id); await existing.close(); existing = null;
      }
    }
    if (existing && !['failed', 'closed', 'closing'].includes(existing.state)) return existing;
    if (existing) { sessions.delete(r.thread.id); await existing.close(); }
    if (startingSessions.has(r.thread.id)) return startingSessions.get(r.thread.id);
    const opening = openSession(r).finally(() => startingSessions.delete(r.thread.id));
    startingSessions.set(r.thread.id, opening);
    return opening;
  }

  async function openSession(r) {
    let Session = CursorSession;
    if (r.backend === 'legacy') Session = (await import('./legacy.mjs')).LegacySession;
    if (shuttingDown) throw new Error('Cursor bridge is shutting down');
    const binding = r.backend === 'legacy' && tmuxSync ? await findTmuxBinding(r) : null;
    const savedObserver = r.thread.turns.find(t => t.status === 'inProgress'
      && (observerTurnProof(r, t.id) || hasSubmittedTurnClaim(r, t.id)));
    const recovery = savedObserver && binding ? recoverableObserverTurn(r, binding, sourceHistories.get(r.cursorSessionId)) : null;
    if (savedObserver && (!recovery || !tmuxSync.client.isVerified(binding))) {
      throw new Error('The saved Cursor observer cannot be verified against its original process and source; no separate Agent was started');
    }
    // Admission validated this native-origin ownership against the original
    // process and canonical source. Later queue/model UI state is not allowed
    // to turn its read-only observer into an external user preview or a retry.
    const nativeObserver = [2, 3].includes(recovery?.proof.version) ? Object.freeze({
      turnId: recovery.turn.id, proof: Object.freeze(structuredClone(recovery.proof)),
    }) : null;
    if (binding) {
      r.tmuxAffinity = { paneId: binding.paneId, agentPid: binding.agentPid, agentStartTime: binding.agentStartTime };
      // Remember a confirmed original process before starting its observer.
      // A failed capture must not permit a later resume in a separate Agent.
      await persist(r);
    }
    const models = binding ? await catalog(log) : null;
    const s = binding ? new (await import('./live.mjs')).TmuxSession({
      ...sessionOptions(r, log), client: tmuxSync.client, binding, history: sourceHistories.get(r.cursorSessionId),
      models, modelDefinitions,
    }) : new Session(sessionOptions(r, log));
    if (binding) s.setVerified?.(tmuxSync.client.isVerified(binding));
    if (binding) s.onSubmittedSource = async ({ sourceTurn, history, model, isCurrent }) => withThreadLock(r.thread.id, async () => {
      const turn = activeTurn(r);
      const clientId = turn?.items?.find(item => item.type === 'userMessage')?.clientId;
      s.assertVerified();
      if (!isCurrent() || !tmuxSync.client.isVerified(s.binding) || !turn || !runningTurns.has(r.thread.id) || s.model !== model || r.thread.model !== model
        || !pinLiveSourceTurn(r, turn, sourceTurn)
        || (clientId != null && !retainSubmittedTurn(r, turn, sourceTurn, s.binding, history))) {
        throw new Error('The submitted Cursor source cannot be durably linked to its original native message');
      }
      if (r.tmuxObserverTurns?.[turn.id]?.version === 3) {
        r.exportedSubmissionTurns ||= {};
        r.exportedSubmissionTurns[turn.id] = structuredClone(r.tmuxObserverTurns[turn.id]);
      }
      await persist(r);
    });
    openingSessionInstances.add(s);
    s.on('exit', () => { if (sessions.get(r.thread.id) === s) sessions.delete(r.thread.id); });
    s.on('model', model => {
      if ([2, 3].includes(recovery?.proof.version) && r.tmuxObserverTurns?.[recovery.turn.id]
        && model !== recovery.proof.model) {
        throw new Error('The saved native Cursor turn model differs from its original process; no input was submitted');
      }
      if (r.thread.model === model) return;
      r.thread.model = model;
      persist(r).catch(error => log(`Cursor model persist failed threadId=${r.thread.id}: ${error.message}`));
    });
    s.on('update', update => onUpdate(r, update));
    s.on('externalTurn', event => {
      withThreadLock(r.thread.id, async () => {
        if (shuttingDown || r.archived) return;
        const user = event.prompt;
        const source = s.history?.turns.find(turn => turn.id === event.sourceTurnId);
        if (!source) throw new Error('The observed Cursor source turn is no longer available');
        let t = findLiveSourceTurn(r, s.history, user);
        if (Object.hasOwn(r.historySync?.sourceTurns || {}, source.id) && !t) {
          throw new Error('The observed Cursor source mapping disagrees with its native message');
        }
        if (activeTurn(r) && activeTurn(r) !== t) throw new Error('Another native Cursor turn owns this observer');
        if (!t) {
          t = { id: uuid(), rootTurnId: null, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: now(), completedAt: null, durationMs: null };
          t.rootTurnId = t.id; r.thread.turns.push(t);
          t.items.push({ type: 'userMessage', id: uuid(), clientId: null, content: structuredClone(source.items.find(item => item.type === 'userMessage').content) });
        } else {
          r.liveSourcePreviews ||= {}; r.liveSourcePreviews[t.id] = true;
          const assistant = t.items.findLast(item => item.type === 'agentMessage');
          if (assistant) { r.livePreviewIds ||= {}; r.livePreviewIds[t.id] = assistant.id; }
          t.status = 'inProgress'; t.startedAt ||= now(); t.completedAt = null;
        }
        if (!pinLiveSourceTurn(r, t, source)) throw new Error('The observed Cursor source turn is already owned by another native turn');
        r.tmuxObserverTurns ||= {};
        r.tmuxObserverTurns[t.id] = { version: 1, sourceTurnId: source.id, sessionId: s.sessionId,
          paneId: s.binding.paneId, agentPid: s.binding.agentPid, agentStartTime: s.binding.agentStartTime };
        runningTurns.add(r.thread.id);
        r.thread.updatedAt = now(); r.thread.recencyAt = now();
        status(r, 'active'); notify('turn/started', { threadId: r.thread.id, turn: { ...t, items: [] } });
        for (const item of t.items) completeItem(r, t, item);
        onUpdate(r, { sessionUpdate: 'terminal_snapshot', text: s.screen.currentReplyBody });
        await persist(r);
        launchTurn(r, t, s, null, event.promise);
      }).catch(error => { s.detach(error); log(`Tmux external turn failed: ${error.message}`); });
    });
    s.on('permission', request => {
      const t = activeTurn(r);
      if (!t) return request.respond({ outcome: { outcome: 'cancelled' } });
      const itemId = request.params.toolCall?.toolCallId || uuid();
      const title = request.params.toolCall?.title || 'Cursor Agent action';
      const route = routes.get(r.thread.id);
      if (!route) return request.respond({ outcome: { outcome: 'cancelled' } });
      route.ask('item/commandExecution/requestApproval', {
        threadId: r.thread.id, turnId: t.id, itemId, approvalId: null,
        kind: 'command', startedAtMs: Date.now(), environmentId: null,
        command: title, cwd: r.thread.cwd, reason: 'Cursor Agent requests permission', commandActions: [],
      }, response => {
        const decision = response?.decision;
        const accept = decision === 'accept' || decision === 'acceptForSession';
        const options = request.params.options || [];
        // ACP allow_always persists permission beyond this chat. A native session approval grants only this action.
        const option = options.find(o => o.kind === (accept ? 'allow_once' : 'reject_once'));
        request.respond(option && (accept || option.kind.startsWith('reject'))
          ? { outcome: { outcome: 'selected', optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' } });
      });
    });
    s.on('request', request => {
      const t = activeTurn(r);
      if (!t) return request.respond(null, { code: -32601, message: 'No active turn' });
      const route = routes.get(r.thread.id);
      if (!route) return request.respond(null, { code: -32601, message: 'Client disconnected' });
      if (request.method !== 'cursor/ask_question') return request.respond(null, { code: -32601, message: `Unsupported interactive Cursor request: ${request.method}` });
      const raw = request.params.questions || [request.params];
      const mapping = new Map();
      const questions = raw.map((q, i) => {
        const id = String(q.id ?? i);
        const options = (q.options || []).map(o => ({ id: String(o.id), label: o.label }));
        mapping.set(id, { options, allowMultiple: q.allowMultiple === true });
        return { id, header: q.header || 'Cursor', question: q.question || q.prompt || q.title || '', isOther: false, isSecret: false,
          options: options.map(o => ({ label: o.label, description: '' })) };
      });
      if (!questions.length || questions.some(q => !q.question || !q.options.length || new Set(q.options.map(o => o.label)).size !== q.options.length)) {
        return request.respond({ outcome: { outcome: 'skipped', reason: 'Question cannot be represented by the native question UI' } });
      }
      route.ask('item/tool/requestUserInput', { threadId: r.thread.id, turnId: t.id, itemId: uuid(), questions, isBlocking: true, autoResolutionMs: null }, (response, error) => {
        if (error) return request.respond({ outcome: { outcome: 'cancelled' } });
        const answers = [];
        for (const [questionId, { options, allowMultiple }] of mapping) {
          const labels = response?.answers?.[questionId]?.answers;
          if (!Array.isArray(labels) || !labels.length || (!allowMultiple && labels.length !== 1) || labels.some(label => !options.some(o => o.label === label))) {
            return request.respond({ outcome: { outcome: 'skipped', reason: 'No valid answer selected' } });
          }
          answers.push({ questionId, selectedOptionIds: [...new Set(labels.map(label => options.find(o => o.label === label).id))] });
        }
        request.respond({ outcome: { outcome: 'answered', answers } });
      });
    });
    try {
      let recoveredPending;
      if (recovery) {
        const sourceUser = recovery.sourceTurn.items.find(item => item.type === 'userMessage');
        const prompt = sourceUser.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        recoveredPending = s.resumeObserver(recovery.sourceTurn.id, prompt);
        status(r, 'active');
      }
      const result = await s.start(r.cursorSessionId ? { sessionId: r.cursorSessionId } : {});
      if (shuttingDown) throw new Error('Cursor bridge is shutting down');
      if ([2, 3].includes(recovery?.proof.version) && result?.models?.currentModelId
        && result.models.currentModelId !== recovery.proof.model) {
        throw new Error('The saved native Cursor turn model could not be verified; no input was submitted');
      }
      if (recoveredPending) {
        // The promise may already have resolved during the first capture. Do
        // not finish its native turn until startup/model checks have passed.
        runningTurns.add(r.thread.id);
        launchTurn(r, recovery.turn, s, null, recoveredPending.promise, undefined, undefined, nativeObserver);
      }
      r.cursorSessionId = s.sessionId;
      if (result?.models?.currentModelId) r.thread.model = result.models.currentModelId;
      sessions.set(r.thread.id, s);
      // The scanner may have advanced while start() awaited its first capture.
      // That opening instance was not in sessions yet, so replay the newest
      // canonical snapshot before relying on any further transcript writes.
      if (s.kind === 'tmux' && sourceHistories.has(s.sessionId)) s.acceptHistory(sourceHistories.get(s.sessionId));
      if (!activeTurn(r)) status(r, 'idle'); await persist(r); return s;
    } catch (e) { await s.close(); throw e; }
    finally { openingSessionInstances.delete(s); }
  }

  function activeTurn(r) { return r.thread.turns.findLast(t => t.status === 'inProgress'); }
  function startItem(r, t, item) {
    t.items.push(item);
    notify('item/started', { threadId: r.thread.id, turnId: t.id, item });
    return item;
  }
  function completeItem(r, t, item) { notify('item/completed', { threadId: r.thread.id, turnId: t.id, item, completedAtMs: Date.now() }); }
  function onUpdate(r, u) {
    const t = activeTurn(r); if (!t) return;
    const common = { threadId: r.thread.id, turnId: t.id };
    if (u.sessionUpdate === 'terminal_snapshot') {
      if (!u.text) return;
      r.livePreviewIds ||= {};
      let item = t.items.find(i => i.id === r.livePreviewIds[t.id]);
      if (!item) {
        item = startItem(r, t, { type: 'agentMessage', id: uuid(), text: '', phase: 'commentary', memoryCitation: null, delivery: null, questions: null });
        r.livePreviewIds[t.id] = item.id;
      }
      item.text = u.text.slice(-24_000);
      item.phase = 'commentary';
      completeItem(r, t, item);
    } else if (u.sessionUpdate === 'agent_message_chunk') {
      const delta = u.content?.text || ''; if (!delta) return;
      let item = t.items.at(-1);
      if (item?.type !== 'agentMessage') item = startItem(r, t, { type: 'agentMessage', id: uuid(), text: '', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
      item.text += delta;
      notify('item/agentMessage/delta', { ...common, itemId: item.id, delta });
    } else if (u.sessionUpdate === 'agent_thought_chunk') {
      const delta = u.content?.text || ''; if (!delta) return;
      let item = t.items.at(-1);
      if (item?.type !== 'reasoning') item = startItem(r, t, { type: 'reasoning', id: uuid(), summary: [''], content: [] });
      item.summary[0] += delta;
      notify('item/reasoning/summaryTextDelta', { ...common, itemId: item.id, delta, summaryIndex: 0 });
    } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const id = u.toolCallId;
      let item = t.items.find(i => i.id === id);
      if (!item) item = startItem(r, t, { type: 'dynamicToolCall', id, namespace: 'cursor', tool: u.title || u.kind || 'tool', arguments: u.rawInput ?? {}, status: 'inProgress', contentItems: null, success: null, durationMs: null });
      if (u.content) item.contentItems = u.content.filter(c => c.type === 'content' && c.content?.type === 'text').map(c => ({ type: 'inputText', text: c.content.text }));
      if (u.status === 'completed' || u.status === 'failed') {
        item.status = u.status; item.success = u.status === 'completed'; completeItem(r, t, item);
      }
    } else if (u.sessionUpdate === 'plan') {
      notify('turn/plan/updated', { ...common, explanation: null, plan: (u.entries || []).map(e => ({ step: e.content, status: ({ pending: 'pending', in_progress: 'inProgress', completed: 'completed' })[e.status] || 'pending' })) });
    }
  }

  async function finishTurn(r, t, s, acpInput, externalPromise, expectedModel, retryDraft, nativeObserver, execution) {
    let detachedObserver = false;
    const nativeOrigin = nativeObserver?.turnId === t.id && nativeObserver.proof.origin === 'native';
    try {
      const result = await (externalPromise || s.prompt(acpInput, { model: expectedModel, retryDraft }));
      if (execution.retiring || turnExecutions.get(r.thread.id) !== execution) return;
      if (result?.history) {
        // Replace the rendered terminal preview with exact transcript text
        // before matching source IDs. Both phases use the same native item.
        finalizeLivePreview(r, t, result.sourceTurn);
        // The screen wraps prose for display. Replace an external turn's user
        // preview with the exact transcript text before binding stable IDs.
        if (result.origin === 'external' && !nativeOrigin) {
          const user = t.items.find(i => i.type === 'userMessage');
          const sourceUser = result.sourceTurn.items.find(i => i.type === 'userMessage');
          if (user && sourceUser) user.content = structuredClone(sourceUser.content);
        }
        // The session observed this exact source round. An older failed paste
        // with the same words must not claim the successful retry's history.
        if (!pinLiveSourceTurn(r, t, result.sourceTurn)) throw new Error('The completed Cursor source turn could not be linked to its native turn');
        // A later CLI turn may already be running when this source completes.
        // Let its own source-bound observer publish it, rather than announcing
        // a terminal completion for a still-unfinished transcript tail.
        const history = { ...result.history, turns: result.history.turns.filter((source, index, turns) =>
          result.history.sourceComplete !== false || index < turns.length - 1 || result.history.completedTurnIds?.includes(source.id)) };
        const merged = (await import('./sync.mjs')).reconcileHistory(r, history);
        Object.assign(r, merged.record);
        t = r.thread.turns.find(turn => turn.id === t.id);
        publishHistoryChanges(r, merged.turnsChanged.filter(change => change.after.id !== t.id), true);
        if (result.origin === 'external') for (const item of t.items) if (item.type === 'userMessage') completeItem(r, t, item);
      }
      t.status = result?.stopReason === 'cancelled' ? 'interrupted' : result?.stopReason === 'failed' ? 'failed' : 'completed';
      if (t.status === 'failed') t.error = result.sourceTurn?.error || { message: 'Cursor CLI turn failed', codexErrorInfo: null, additionalDetails: null };
    } catch (e) {
      if (execution.retiring || turnExecutions.get(r.thread.id) !== execution) return;
      if (s.kind === 'tmux' && ((externalPromise && nativeOrigin) || observerTurnProof(r, t.id))) {
        // Losing a read-only observer cannot fail the original Cursor task.
        // Keep its exact source ownership so another observer can adopt it.
        detachedObserver = true;
        log(`Cursor observer detached; preserving source-bound turn ${t.id}: ${e.message}`);
      } else {
        t.status = 'failed';
        t.error = { message: e.message, codexErrorInfo: null, additionalDetails: null };
        if (s.kind === 'tmux') {
          t.error.additionalDetails = (await import('./live.mjs')).multilineVerificationDetails(e.multilineVerification);
          retainUnsubmittedDraft(r, t, e.unsubmittedDraft, e.verificationAnchor);
        }
        notify('error', { threadId: r.thread.id, turnId: t.id, error: t.error, willRetry: false });
        log(`Cursor turn failed: ${e.message}`);
      }
    } finally {
      try {
        if (execution.retiring || turnExecutions.get(r.thread.id) !== execution) { /* Another transaction owns the terminal record. */ }
        else if (detachedObserver) await persist(r);
        else {
          for (const item of t.items) if (item.type !== 'userMessage') {
            if (item.id === r.livePreviewIds?.[t.id]) item.phase = 'final_answer';
            completeItem(r, t, item);
          }
          t.completedAt = now(); t.durationMs = Date.now() - t.startedAt * 1000;
          r.thread.updatedAt = now(); r.thread.recencyAt = now();
          if (r.tmuxObserverTurns?.[t.id]?.version === 3) {
            r.exportedSubmissionTurns ||= {};
            r.exportedSubmissionTurns[t.id] = structuredClone(r.tmuxObserverTurns[t.id]);
          }
          if (r.tmuxObserverTurns) delete r.tmuxObserverTurns[t.id];
          await persist(r); status(r, 'idle');
          notify('turn/completed', { threadId: r.thread.id, turn: t });
        }
      } finally {
        if (turnExecutions.get(r.thread.id) === execution) {
          turnExecutions.delete(r.thread.id);
          runningTurns.delete(r.thread.id); s.turnCommitted?.();
          if (!execution.retiring && !detachedObserver && t.status === 'completed') scheduleQueue(r.thread.id);
        }
      }
    }
  }

  function launchTurn(r, t, s, input, external, model, draft, nativeObserver) {
    const execution = { session: s, turnId: t.id, retiring: false, promise: null };
    turnExecutions.set(r.thread.id, execution);
    const pending = finishTurn(r, t, s, input, external, model, draft, nativeObserver, execution);
    execution.promise = pending;
    finishingTurns.add(pending);
    pending.catch(error => log(`Cursor turn persist failed: ${error.message}`)).finally(() => finishingTurns.delete(pending));
  }

  async function handle(method, p = {}) {
    if (['turn/start', 'thread/queue/start', 'thread/start'].includes(method)) await maintenance.assertOpen();
    if (p.threadId && (method.startsWith('thread/queue/') || ['thread/resume', 'thread/unsubscribe', 'thread/archive', 'thread/unarchive', 'turn/start', 'thread/name/set', 'thread/metadata/update'].includes(method))) {
      return withThreadLock(p.threadId, () => handleUnlocked(method, p));
    }
    return handleUnlocked(method, p);
  }

  async function handleUnlocked(method, p = {}) {
    initializedStore ||= loadStore(); await initializedStore;
    if (method === 'cursorBridge/maintenance') return maintenance.quiesce();
    if (method === 'initialize') {
      const result = await support().call(method, p);
      connected = true; clients.add(client);
      await startHistorySync(log);
      await startTmuxSync(log, r => ensureSession(r));
      return { ...result, codexHome: home };
    }
    if (method === 'initialized') { support().write({ method, params: p }); return; }
    if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
    if (method === 'getAuthStatus') return { authMethod: 'apikey', authToken: null, requiresOpenaiAuth: false };
    if (method === 'modelProvider/capabilities/read') return { imageGeneration: false, webSearch: false };
    if (method === 'collaborationMode/list') {
      // Presets must retain the selected Cursor model rather than inserting a
      // genuine Codex support server's default model into the native composer.
      return { data: [{ name: 'Agent', mode: 'default', model: null, reasoning_effort: null }] };
    }
    if (method === 'model/list') {
      const data = await catalog(log); const offset = Number(p.cursor) || 0;
      const limit = Math.max(1, Math.min(p.limit || 100, 1000));
      return { data: data.slice(offset, offset + limit), nextCursor: offset + limit < data.length ? String(offset + limit) : null };
    }
    if (method === 'config/read') {
      const result = await support().call(method, p);
      await catalog(log);
      result.config.model = defaultModel; result.config.model_provider = PROVIDER;
      result.config.approval_policy = 'on-request';
      result.config.model_providers ||= {};
      result.config.model_providers.cursor = { name: 'Cursor Agent on remote host', wire_api: 'responses', requires_openai_auth: false };
      return result;
    }
    if (method === 'config/value/write' && ['model', 'model_provider'].includes(p.keyPath)) {
      if (p.keyPath === 'model') defaultModel = p.value;
      return { status: 'ok', version: uuid(), filePath: path.join(home, 'config.toml'), overriddenMetadata: null };
    }
    if (method === 'thread/start') {
      await catalog(log);
      const models = await catalog(log);
      const requested = p.model || defaultModel;
      const selected = models.find(m => !m.hidden && m.model === requested) || models.find(m => !m.hidden && m.model.startsWith(`${requested}[`));
      if (!selected) throw new Error(`Choose a Cursor model from the model picker; unavailable model: ${requested}`);
      const cwd = path.resolve(p.cwd || process.env.CURSOR_BRIDGE_CWD || os.homedir());
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
      const r = makeRecord({ cwd, model: selected.model }); records.set(r.thread.id, r);
      await persist(r); await ensureSession(r);
      notify('thread/started', { thread: view(r) }); return threadResponse(r);
    }
    if (method === 'thread/list') {
      let data = [...records.values()].filter(r => Boolean(r.archived) === Boolean(p.archived));
      // Native clients also use this query to enumerate pinned/custom sections.
      if (p.sectionId !== undefined) data = data.filter(r => (r.thread.section?.id ?? null) === p.sectionId);
      if (p.cwd) { const cwds = Array.isArray(p.cwd) ? p.cwd : [p.cwd]; data = data.filter(r => cwds.includes(r.thread.cwd)); }
      if (p.searchTerm) data = data.filter(r => `${r.thread.name} ${r.thread.preview}`.toLowerCase().includes(p.searchTerm.toLowerCase()));
      if (p.modelProviders?.length && !p.modelProviders.includes(PROVIDER)) data = [];
      data.sort((a, b) => (b.thread.recencyAt || b.thread.createdAt) - (a.thread.recencyAt || a.thread.createdAt));
      const offset = Number(p.cursor) || 0, limit = Math.max(1, Math.min(p.limit || 50, 500));
      return { data: data.slice(offset, offset + limit).map(r => view(r)), nextCursor: offset + limit < data.length ? String(offset + limit) : null, backwardsCursor: null };
    }
    if (method === 'thread/loaded/list') return { data: [...sessions.keys()], nextCursor: null };
    if (method === 'thread/read') return { thread: view(requireRecord(p.threadId), Boolean(p.includeTurns)) };
    if (method === 'thread/attachment/list') {
      requireRecord(p.threadId);
      return { data: [], nextCursor: null };
    }
    if (method === 'thread/goal/get') {
      requireRecord(p.threadId);
      return { goal: null };
    }
    if (method === 'thread/queue/list') return queueList(requireRecord(p.threadId), p);
    const queueMutation = ({
      'thread/queue/add': queueAdd,
      'thread/queue/update': queueUpdate,
      'thread/queue/delete': queueDelete,
      'thread/queue/reorder': queueReorder,
    })[method];
    if (queueMutation) {
      const r = requireRecord(p.threadId);
      const result = queueMutation(r, p);
      await persist(r);
      notify('thread/queue/changed', { threadId: p.threadId });
      if (method === 'thread/queue/add') scheduleQueue(p.threadId);
      return result;
    }
    if (method === 'thread/queue/start') {
      const r = requireRecord(p.threadId);
      const previousTurnId = p.queuedSubmissionId && r.queuedSubmissionTurns?.[p.queuedSubmissionId];
      if (previousTurnId) {
        const previousTurn = r.thread.turns.find(turn => turn.id === previousTurnId);
        if (previousTurn) return { turn: { ...previousTurn, items: [] } };
      }
      const submission = queuePeek(r, p.queuedSubmissionId);
      if (!submission) throw Object.assign(new Error('No queued Cursor messages to send'), { code: -32602 });
      const candidates = r.thread.turns.filter(t => t.items.some(item => item.type === 'userMessage' && item.clientId === submission.clientUserMessageId));
      const attachmentMatches = candidates.filter(t => r.attachmentDraftRequests?.[t.id]
        && sameAdmittedInput(r, t, t.items.find(item => item.type === 'userMessage' && item.clientId === submission.clientUserMessageId), submission.input));
      if (attachmentMatches.length > 1) throw Object.assign(new Error('Queued message ID has ambiguous attachment retry ownership'), { code: -32602 });
      const admitted = attachmentMatches[0] || candidates[0];
      if (admitted) {
        const user = admitted.items.find(item => item.type === 'userMessage' && item.clientId === submission.clientUserMessageId);
        if (!sameAdmittedInput(r, admitted, user, submission.input)) throw Object.assign(new Error('Queued message ID already belongs to different input'), { code: -32602 });
        r.queuedSubmissionTurns ||= {};
        r.queuedSubmissionTurns[submission.id] = admitted.id;
        queueConsume(r, submission.id);
        await persist(r);
        notify('thread/queue/changed', { threadId: p.threadId });
        return { turn: { ...admitted, items: [] } };
      }
      // Use the same admission checks and thread lock as direct sends. A failed
      // admission leaves the queued message available for correction or retry.
      const result = await handleUnlocked('turn/start', {
        threadId: p.threadId, input: submission.input, clientUserMessageId: submission.clientUserMessageId,
      });
      r.queuedSubmissionTurns ||= {};
      r.queuedSubmissionTurns[submission.id] = result.turn.id;
      queueConsume(r, submission.id);
      delete r.queueWaitReason;
      await persist(r);
      notify('thread/queue/changed', { threadId: p.threadId });
      return result;
    }
    if (method === 'thread/resume') {
      const r = requireRecord(p.threadId);
      const s = await ensureSession(r);
      if (p.model && (s.kind === 'tmux' || p.model !== r.thread.model)) {
        await s.setModel(p.model); r.thread.model = s.model || p.model;
      }
      await persist(r); scheduleQueue(p.threadId); return threadResponse(r);
    }
    if (method === 'thread/unsubscribe') {
      const r = requireRecord(p.threadId), s = sessions.get(p.threadId);
      if (!s) return { status: 'notLoaded' };
      if (s.kind === 'tmux') { routes.delete(p.threadId); return { status: 'unsubscribed' }; }
      if (!activeTurn(r)) { sessions.delete(p.threadId); routes.delete(p.threadId); await s.close(); status(r, 'notLoaded'); }
      return { status: 'unsubscribed' };
    }
    if (method === 'thread/turns/list' || method === 'thread/items/list') {
      const r = requireRecord(p.threadId);
      let data = method === 'thread/turns/list' ? [...r.thread.turns] : r.thread.turns.filter(t => !p.turnId || t.id === p.turnId).flatMap(t => t.items.map(item => ({ turnId: t.id, item, startedAtMs: t.startedAt ? t.startedAt * 1000 : null, completedAtMs: t.completedAt ? t.completedAt * 1000 : null })));
      if (p.sortDirection !== 'asc') data.reverse();
      const offset = Number(p.cursor) || 0, limit = p.limit || 100;
      return { data: data.slice(offset, offset + limit), nextCursor: offset + limit < data.length ? String(offset + limit) : null, backwardsCursor: null };
    }
    if (method === 'thread/name/set') {
      const r = requireRecord(p.threadId); r.thread.name = p.name; r.titleOrigin = 'user';
      await persist(r); notify('thread/name/updated', { threadId: p.threadId, threadName: p.name }); return {};
    }
    if (method === 'thread/archive' || method === 'thread/unarchive') {
      const r = requireRecord(p.threadId);
      if (activeTurn(r)) throw new Error('Interrupt the active Cursor turn before archiving');
      r.archived = method === 'thread/archive';
      if (r.archived) { const s = sessions.get(p.threadId); sessions.delete(p.threadId); routes.delete(p.threadId); await s?.close(); status(r, 'notLoaded'); }
      await persist(r);
      notify(r.archived ? 'thread/archived' : 'thread/unarchived', { threadId: p.threadId });
      return r.archived ? {} : { thread: view(r, true) };
    }
    if (method === 'thread/metadata/update') {
      const r = requireRecord(p.threadId);
      if (p.gitInfo) r.thread.gitInfo = p.gitInfo;
      if (p.isPinned !== undefined) r.isPinned = p.isPinned;
      await persist(r); return { thread: view(r) };
    }
    if (method === 'turn/start') {
      await maintenance.assertOpen();
      const r = requireRecord(p.threadId);
      let input = p.input?.length ? p.input : typeof p.toolOutput?.output === 'string' && p.toolOutput.output.trim()
        ? [{ type: 'text', text: p.toolOutput.output, text_elements: [] }] : [];
      const retired = retiredSubmission(r, p.clientUserMessageId, input);
      if (retired) return { turn: { ...retired, items: [] } };
      if (activeTurn(r)) throw new Error('Cursor turn is already running; wait for it or interrupt it');
      let acpInput = await inputsToAcp(input);
      const s = await ensureSession(r);
      if (r.backend === 'legacy' && acpInput.some(block => block.type !== 'text')) {
        throw new Error('An existing Cursor CLI chat currently accepts text messages only');
      }
      let retryDraft = s.kind === 'tmux' ? retryDraftFor(r, s.binding, s.history, acpInput) : null;
      const attachmentRetry = !retryDraft && s.kind === 'tmux'
        ? await resolveAttachmentDraftRetry({ record: r, binding: s.binding, history: s.history, input, home }) : null;
      if (attachmentRetry) {
        // The App may upload the exact same attachment again under a fresh UUID.
        // Keep both the native message and Cursor's proven draft on the original
        // byte-identical file reference before publishing or persisting either.
        input = attachmentRetry.input;
        acpInput = await inputsToAcp(input);
        retryDraft = retryDraftFor(r, s.binding, s.history, acpInput);
        if (!retryDraft) throw new Error('The failed Cursor draft changed while verifying its attachment retry; no Enter was sent');
      }
      if (s.kind === 'tmux') await s.assertReady({ retryDraft, deferDraftCheck: Boolean(retryDraft) });
      const requestedModel = p.model || p.collaborationMode?.settings?.model;
      if (requestedModel && (s.kind === 'tmux' || requestedModel !== r.thread.model)) {
        await s.setModel(requestedModel); r.thread.model = s.model || requestedModel;
      }
      const t = { id: uuid(), rootTurnId: null, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: now(), completedAt: null, durationMs: null };
      routes.set(r.thread.id, { client, ask });
      t.rootTurnId = t.id; r.thread.turns.push(t); runningTurns.add(r.thread.id);
      const message = { type: 'userMessage', id: uuid(), clientId: p.clientUserMessageId || null, content: input };
      if (attachmentRetry && message.clientId) {
        r.attachmentDraftRequests ||= {};
        r.attachmentDraftRequests[t.id] = { version: 1, clientUserMessageId: message.clientId,
          requestInputSha256: attachmentRetry.requestInputSha256, canonicalInputSha256: inputDigest(input) };
      }
      const text = input.filter(i => i.type === 'text').map(i => i.text).join('\n');
      if (!r.thread.preview) {
        r.thread.preview = text.slice(0, 1000); r.thread.name = text.split('\n').find(Boolean)?.slice(0, 90) || 'Cursor Agent';
        notify('thread/name/updated', { threadId: r.thread.id, threadName: r.thread.name });
      }
      r.thread.updatedAt = now(); r.thread.recencyAt = now();
      status(r, 'active'); notify('turn/started', { threadId: r.thread.id, turn: { ...t, items: [] } });
      startItem(r, t, message); completeItem(r, t, message); await persist(r);
      // Start inference only after the RPC caller has received its turn id.
      const expectedModel = s.kind === 'tmux' ? s.model : undefined;
      setImmediate(() => launchTurn(r, t, s, acpInput, null, expectedModel, retryDraft));
      return { turn: { ...t, items: [] } };
    }
    if (method === 'turn/interrupt') {
      const r = requireRecord(p.threadId), t = activeTurn(r);
      if (!t) return {};
      if (p.turnId !== t.id) throw Object.assign(new Error('The active Cursor turn has changed; refresh before interrupting'), { code: -32602 });
      await sessions.get(r.thread.id)?.cancel(); return {};
    }
    // Never allow an unsupported chat action to reach the Codex model runtime.
    if (/^(thread\/|turn\/|review\/)/.test(method)) throw Object.assign(new Error(`Cursor bridge does not support ${method} yet`), { code: -32601 });
    return support().call(method, p);
  }

  return {
    async receive(message) {
      if (!message.method) {
        if (approvals.has(message.id)) { const respond = approvals.get(message.id); approvals.delete(message.id); respond(message.result, message.error); }
        else backend?.write(message);
        return;
      }
      // Record routing metadata only. Prompt text, attachments and tool output
      // must not be copied into the diagnostic log.
      const metadata = { threadId: message.params?.threadId, model: message.params?.model,
        collaborationModel: message.params?.collaborationMode?.settings?.model,
        clientUserMessageId: message.params?.clientUserMessageId };
      log(`RPC ${message.method} keys=${Object.keys(message.params || {}).join(',')} metadata=${JSON.stringify(metadata)}${message.method === 'turn/start' ? ` inputTypes=${(message.params?.input || []).map(i => i.type).join(',')}` : ''}`);
      try {
        const result = await handle(message.method, message.params);
        if (message.id !== undefined) send({ id: message.id, result: result ?? {} });
      } catch (e) {
        log(`${message.method} threadId=${message.params?.threadId || '-'} code=${Number.isInteger(e.code) ? e.code : -32000}: ${e.message}`);
        if (message.id !== undefined) send({ id: message.id, error: { code: Number.isInteger(e.code) ? e.code : -32000, message: e.message } });
      }
    },
    async close() {
      if (connected) clients.delete(client);
      connected = false;
      for (const timer of queueTimers.values()) clearTimeout(timer);
      queueTimers.clear();
      for (const respond of approvals.values()) respond({ decision: 'decline' });
      approvals.clear(); backend?.close();
      for (const [id, route] of routes) if (route.client === client) {
        routes.delete(id);
        const s = sessions.get(id);
        if (s?.kind !== 'tmux') s?.cancel();
      }
    },
  };
}

async function findTmuxBinding(r) {
  if (!tmuxSync) return null;
  await tmuxSync.refresh();
  const matches = tmuxSync.bindings.filter(binding => binding.sessionId === r.cursorSessionId);
  if (matches.length > 1) throw new Error('This Cursor session is open in several tmux panes; keep one running pane before sending from Codex');
  const binding = matches[0];
  if (binding && path.resolve(binding.cwd) !== path.resolve(r.thread.cwd)) throw new Error('The original Cursor process working directory differs from this chat; terminal attachment was refused');
  if (!binding && r.tmuxAffinity?.agentPid) {
    try {
      const text = await fs.readFile(`/proc/${r.tmuxAffinity.agentPid}/stat`, 'utf8');
      const startTime = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
      if (r.tmuxAffinity.agentStartTime && r.tmuxAffinity.agentStartTime !== startTime) return null;
    }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    throw new Error('The original Cursor process is still running but its tmux attachment cannot be verified; no separate Agent was started');
  }
  return binding || null;
}

// Called under the thread lock. This only retires an ambiguous display observer;
// the original Agent is never cancelled, typed into, or assigned a new model.
async function retireCompletedObserver(r) {
  if (!tmuxSync || shuttingDown) return false;
  const history = sourceHistories.get(r.cursorSessionId);
  const recovery = observerRetirementCandidate(r, history) || unboundExportCandidate(r, history);
  if (!recovery) return false;
  const proof = recovery.proof || { sessionId: r.cursorSessionId, ...r.tmuxAffinity };
  const createPlan = recovery.proof ? planObserverRetirement : planUnboundExportRetirement;
  const execution = turnExecutions.get(r.thread.id);
  const session = sessions.get(r.thread.id);
  if (session && (session.kind !== 'tmux' || session.sessionId !== proof.sessionId
    || session.binding.paneId !== proof.paneId || session.binding.agentPid !== proof.agentPid
    || session.binding.agentStartTime !== proof.agentStartTime)) return false;
  if (execution && (execution.turnId !== recovery.turn.id || execution.session !== session)
    || (!execution && runningTurns.has(r.thread.id))) return false;
  const snapshot = async () => {
    const candidate = await findTmuxBinding(r);
    if (!candidate) return null;
    const binding = await tmuxSync.client.verifiedBinding(candidate);
    if (!binding || !tmuxSync.client.isVerified(binding)) return null;
    const { parseCursorScreen } = await import('./screen.mjs');
    const screen = parseCursorScreen(await tmuxSync.client.capture(binding.paneId), { knownCursor: true });
    await tmuxSync.client.verifiedBinding(binding);
    if (!tmuxSync.client.isVerified(binding)) return null;
    const current = sourceHistories.get(r.cursorSessionId);
    // An advancing scanner invalidates this observation. The next tick retries.
    if (current !== history || sessions.get(r.thread.id) !== session) return null;
    return createPlan(r, { history: current, binding, screen });
  };
  if (!await snapshot()) return false;
  if (execution) execution.retiring = true;
  if (session) await session.close();
  if (execution) await execution.promise;
  // Closing may await an in-flight capture. Recheck the original process and
  // source before committing, without allowing an old finishTurn to commit too.
  const candidate = await findTmuxBinding(r);
  const binding = candidate && await tmuxSync.client.verifiedBinding(candidate);
  if (!binding || !tmuxSync.client.isVerified(binding)
    || sourceHistories.get(r.cursorSessionId) !== history) return false;
  const { parseCursorScreen } = await import('./screen.mjs');
  const screen = parseCursorScreen(await tmuxSync.client.capture(binding.paneId), { knownCursor: true });
  await tmuxSync.client.verifiedBinding(binding);
  if (!tmuxSync.client.isVerified(binding) || sourceHistories.get(r.cursorSessionId) !== history) return false;
  const plan = createPlan(r, { history, binding, screen });
  if (!plan) return false;
  plan.record.thread.status = { type: 'idle' };
  await persist(plan.record);
  Object.assign(r, plan.record);
  publishHistoryChanges(r, plan.turnsChanged, true);
  status(r, 'idle');
  return true;
}

async function startTmuxSync(log, attach) {
  if (tmuxSync || !historySync || process.platform !== 'linux' || process.env.CURSOR_BRIDGE_LIVE_TMUX === '0') return;
  const { TmuxClient } = await import('./tmux.mjs');
  const state = { client: new TmuxClient({ tmuxPath: process.env.CURSOR_BRIDGE_TMUX || 'tmux' }), bindings: [], stopped: false, timer: null, pending: null, refreshing: null, refreshedAt: 0, lastError: null, attachErrors: new Map() };
  state.refresh = async () => {
    if (state.refreshing) return state.refreshing;
    if (Date.now() - state.refreshedAt < 100) return;
    state.refreshing = state.client.discover().then(bindings => {
      state.bindings = bindings; state.refreshedAt = Date.now();
      for (const s of sessions.values()) if (s.kind === 'tmux') s.setVerified(state.client.isVerified(s.binding));
    }).catch(error => {
      for (const s of sessions.values()) if (s.kind === 'tmux') s.setVerified(false);
      throw error;
    }).finally(() => { state.refreshing = null; });
    return state.refreshing;
  };
  tmuxSync = state;
  const tick = async () => {
    if (state.stopped || shuttingDown) return;
    try {
      await state.refresh();
      for (const [id, s] of sessions) if (s.kind === 'tmux' && !state.bindings.some(b => b.sessionId === s.sessionId && b.agentPid === s.binding.agentPid && b.paneId === s.binding.paneId)) {
        try { await fs.stat(`/proc/${s.binding.agentPid}`); }
        catch (error) { if (error.code === 'ENOENT') { s.detach(); sessions.delete(id); } }
      }
      for (const r of records.values()) {
        if (r.backend !== 'legacy' || r.archived || threadLocks.has(r.thread.id)) continue;
        if (!state.bindings.some(binding => binding.sessionId === r.cursorSessionId)) continue;
        try {
          await withThreadLock(r.thread.id, async () => {
            await retireCompletedObserver(r);
            if (!runningTurns.has(r.thread.id)) await attach(r);
          });
          state.attachErrors.delete(r.thread.id);
        } catch (error) {
          if (state.attachErrors.get(r.thread.id) !== error.message) log(`Tmux attach ${r.thread.id}: ${error.message}`);
          state.attachErrors.set(r.thread.id, error.message);
        }
      }
      if (state.lastError) state.lastError = null;
    } catch (error) {
      if (state.lastError !== error.message) log(`Tmux attach: ${error.message}`);
      state.lastError = error.message;
    }
  };
  const schedule = () => {
    if (state.stopped || shuttingDown) return;
    state.timer = setTimeout(() => { state.pending = tick().finally(schedule); }, 2000);
    state.timer.unref();
  };
  state.pending = tick().finally(schedule);
  await state.pending;
}

// A single scanner belongs to the service, rather than to an individual UI connection.
// Polling catches atomic renames and newly-created nested directories without an fs.watch race.
async function startHistorySync(log) {
  if (historySync) return historySync.ready;
  const configured = process.env.CURSOR_BRIDGE_SYNC_INTERVAL_MS;
  const interval = configured === undefined ? 2000 : Number(configured);
  if (interval === 0) return;
  if (!Number.isFinite(interval) || interval < 50) throw new Error('CURSOR_BRIDGE_SYNC_INTERVAL_MS must be 0 or at least 50');
  const state = { stopped: false, timer: null, pending: null, ready: null, queued: new Map(), errors: new Set() };
  historySync = state;
  const tick = async () => {
    if (state.stopped || shuttingDown) return;
    try {
      const { createHistoryScanner } = await import('./history.mjs');
      state.scanner ||= createHistoryScanner({ home: process.env.CURSOR_BRIDGE_HISTORY_HOME || os.homedir() });
      const { changed, errors } = await state.scanner.scan();
      for (const h of changed) {
        sourceHistories.set(h.id, h);
        for (const s of sessions.values()) if (s.kind === 'tmux' && s.sessionId === h.id) s.acceptHistory(h);
      }
      const errorKeys = new Set();
      for (const error of errors) {
        const key = `${error.code || 'unknown'}: ${error.path}`; errorKeys.add(key);
        if (!state.errors.has(key)) log(`History scan error ${key}`);
      }
      state.errors = errorKeys;
      for (const h of changed) if (h.cwd) state.queued.set(h.id, h);
      let imported = 0, updated = 0;
      for (const [id, h] of state.queued) {
        if (state.stopped || shuttingDown) break;
        const existing = [...records.values()].find(r => r.backend === 'legacy' && r.cursorSessionId === id);
        const threadId = existing?.thread.id || uuid();
        if (threadLocks.has(threadId) || runningTurns.has(threadId)
          || existing?.thread.turns.some(turn => observerTurnProof(existing, turn.id)
            || (turn.status === 'inProgress' && hasSubmittedTurnClaim(existing, turn.id)))) continue;
        await withThreadLock(threadId, async () => {
          if (state.stopped || shuttingDown || runningTurns.has(threadId)) return;
          if (!existing) {
            const r = makeRecord({ id: threadId, cwd: h.cwd, model: defaultModel, title: h.title, createdAt: h.createdAt, updatedAt: h.updatedAt,
              turns: [], backend: 'legacy', cursorSessionId: h.id, sourcePath: h.sourcePath, titleOrigin: 'source' });
            r.thread.preview = h.turns?.[0]?.items?.find(i => i.type === 'userMessage')?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 1000) || h.title;
            const { reconcileHistory } = await import('./sync.mjs');
            const merged = reconcileHistory(r, h);
            Object.assign(r, merged.record);
            await persist(r); records.set(r.thread.id, r);
            publishHistoryChanges(r, merged.turnsChanged, true);
            imported++;
          } else {
            const { reconcileHistory } = await import('./sync.mjs');
            // A restart loads an unproven old preview before tmux attachment.
            // Its newer CLI tail still belongs to a live observer; the parser's
            // provisional status must not announce that tail as completed.
            const unbound = unboundExportCandidate(existing, h);
            const visible = unbound?.unfinished ? { ...h, turns: unbound.prefix } : h;
            const merged = reconcileHistory(existing, visible);
            if (merged.changed) {
              // Backend listeners hold the record object; preserve its identity.
              await persist(merged.record);
              Object.assign(existing, merged.record);
              publishHistoryChanges(existing, merged.turnsChanged, true);
              updated++;
            }
          }
          state.queued.delete(id);
        });
      }
      if (imported || updated) log(`History sync imported=${imported} updated=${updated}`);
    } catch (error) { log(`History sync failed: ${error.message}`); }
  };
  const schedule = () => {
    if (state.stopped || shuttingDown) return;
    state.timer = setTimeout(() => {
      state.pending = tick().finally(schedule);
    }, interval);
    state.timer.unref();
  };
  state.ready = state.pending = tick().finally(schedule);
  return state.ready;
}

function publishHistoryChanges(r, turnsChanged, metadataChanged) {
  // Archived chats stay archived. Their latest history is ready when reopened.
  if (r.archived) return;
  if (metadataChanged) publish('thread/started', { thread: view(r) });
  for (const { before, after } of turnsChanged) {
    const common = { threadId: r.thread.id, turnId: after.id };
    publish('turn/started', { threadId: r.thread.id, turn: { ...after, items: [] } });
    for (const item of after.items) {
      const previous = before?.items.find(i => i.id === item.id);
      if (previous && JSON.stringify(previous) === JSON.stringify(item)) continue;
      publish('item/completed', { ...common, item, completedAtMs: after.completedAt ? after.completedAt * 1000 : Date.now() });
    }
    publish('turn/completed', { threadId: r.thread.id, turn: after });
  }
}

export async function importCursorHistory(options = {}) {
  initializedStore ||= loadStore(); await initializedStore;
  const { discoverHistory } = await import('./history.mjs');
  const imported = [];
  for (const h of await discoverHistory(options)) {
    if (!h.cwd) continue;
    if ([...records.values()].some(r => r.backend === 'legacy' && r.cursorSessionId === h.id)) continue;
    const r = makeRecord({ cwd: h.cwd, model: defaultModel, title: h.title, createdAt: h.createdAt, updatedAt: h.updatedAt, turns: h.turns, backend: 'legacy', cursorSessionId: h.id, sourcePath: h.sourcePath, titleOrigin: 'source' });
    r.thread.preview = h.turns?.[0]?.items?.find(i => i.type === 'userMessage')?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 1000) || h.title;
    records.set(r.thread.id, r); await persist(r); imported.push({ threadId: r.thread.id, cursorSessionId: h.id, title: h.title });
    publish('thread/started', { thread: view(r) });
  }
  return imported;
}

export async function shutdownBridge() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    if (historySync) { historySync.stopped = true; clearTimeout(historySync.timer); }
    if (tmuxSync) { tmuxSync.stopped = true; clearTimeout(tmuxSync.timer); }
    await Promise.allSettled([...new Set([...openingSessionInstances, ...sessions.values()])].map(s => s.close()));
    if (historySync) await historySync.pending;
    if (tmuxSync) await tmuxSync.pending;
    await Promise.allSettled([...startingSessions.values(), ...(catalogPromise ? [catalogPromise] : [])]);
    await Promise.allSettled([...sessions.values()].map(s => s.close()));
    await Promise.allSettled([...finishingTurns]);
    sessions.clear();
  })();
  return shutdownPromise;
}
