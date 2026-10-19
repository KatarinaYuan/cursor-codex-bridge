import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createInputLease } from './input-lease.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORE = new RegExp(`^/(?:[^/]+/)*\\.cursor/chats/[^/]+/(${UUID})/store\\.db$`, 'i');
const SESSION = new RegExp(`^${UUID}$`, 'i');
const MAX_PASTED_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_COLUMNS = 1007;

function inputColumns(value, exclusive = false) {
  const maximum = exclusive ? 2007 : MAX_INPUT_COLUMNS;
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
    throw new Error(`Cursor input minimumColumns must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function paneTarget(paneId) {
  if (typeof paneId !== 'string' || !/^%\d+$/.test(paneId)) throw new Error('A tmux pane ID such as %1 is required');
  return paneId;
}

function sessionTarget(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION.test(sessionId)) throw new Error('An exact Cursor session UUID is required');
  return sessionId.toLowerCase();
}

function defaultRunner(tmuxPath, { commandTimeoutMs, maxOutputBytes }) {
  return (args, { input } = {}) => new Promise((resolve, reject) => {
    const child = spawn(tmuxPath, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    let outputBytes = 0; let settled = false; let killTimer;
    const settle = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) reject(error); else resolve(result);
    };
    const abort = (error) => {
      if (settled) return;
      // kill() targets only the spawned tmux CLI client PID. Do not kill a
      // process group, send tmux kill-* commands, or signal the Cursor process.
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 100);
      killTimer.unref();
      child.stdin.destroy();
      settle(error);
    };
    const timeout = setTimeout(() => abort(new Error(`tmux ${args[0]} timed out after ${commandTimeoutMs}ms`)), commandTimeoutMs);
    timeout.unref();
    const collect = (destination) => (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) abort(new Error(`tmux ${args[0]} exceeded the ${maxOutputBytes}-byte output limit`));
      else destination.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    // A server disappearing may close stdin before it consumes the private buffer.
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') abort(error); });
    child.once('error', (error) => settle(error));
    child.once('close', (code, signal) => {
      clearTimeout(killTimer);
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code === 0) settle(null, result);
      else settle(new Error(`tmux ${args[0]} failed (${signal || code}): ${result.stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

async function batches(values, operation, width = 32) {
  const output = [];
  for (let index = 0; index < values.length; index += width) {
    output.push(...await Promise.all(values.slice(index, index + width).map(operation)));
  }
  return output;
}

async function processStat(procRoot, pid) {
  try {
    const text = await readFile(join(procRoot, String(pid), 'stat'), 'utf8');
    const boundary = text.lastIndexOf(') ');
    if (boundary < 0 || Number(text.slice(0, text.indexOf(' '))) !== pid) return null;
    const fields = text.slice(boundary + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]); const pgrp = Number(fields[2]); const tty = Number(fields[4]); const foregroundPgrp = Number(fields[5]); const startTime = fields[19];
    if (!Number.isSafeInteger(ppid) || !/^\d+$/.test(startTime || '') || ['Z', 'X', 'x'].includes(fields[0])) return null;
    return { pid, ppid, pgrp, tty, foregroundPgrp, startTime };
  } catch { return null; }
}

function sameProcess(left, right) {
  return Boolean(left && right && left.pid === right.pid && left.ppid === right.ppid && left.startTime === right.startTime);
}

function ancestorChain(processes, pid, rootPid) {
  const chain = []; const seen = new Set();
  for (let current = processes.get(pid); current && !seen.has(current.pid); current = processes.get(current.ppid)) {
    seen.add(current.pid); chain.push(current);
    if (current.pid === rootPid) return chain;
  }
  return null;
}

async function cursorStores(procRoot, pid) {
  let names;
  try { names = await readdir(join(procRoot, String(pid), 'fd')); } catch { return []; }
  const paths = await batches(names.filter((name) => /^\d+$/.test(name)), async (name) => {
    try { return await readlink(join(procRoot, String(pid), 'fd', name)); } catch { return null; }
  });
  return [...new Set(paths.filter((path) => typeof path === 'string' && STORE.test(path)))];
}

async function paneDescendants(procRoot, rootPid) {
  const pending = [rootPid]; const visited = new Set(); const descendants = [];
  while (pending.length) {
    const pid = pending.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    if (visited.size > 4096) throw new Error('Cursor pane process tree exceeded its verification limit');
    const stat = await processStat(procRoot, pid);
    if (!stat) continue;
    descendants.push(stat);
    let tasks;
    try { tasks = await readdir(join(procRoot, String(pid), 'task')); }
    catch (error) { if (!await processStat(procRoot, pid)) continue; throw error; }
    const children = await batches(tasks.filter(task => /^[1-9]\d*$/.test(task)), async task => {
      try { return await readFile(join(procRoot, String(pid), 'task', task, 'children'), 'utf8'); }
      catch (error) { if (!await processStat(procRoot, pid)) return ''; throw error; }
    });
    for (const child of children.join(' ').trim().split(/\s+/).filter(Boolean)) {
      if (!/^[1-9]\d*$/.test(child) || !Number.isSafeInteger(Number(child))) throw new Error('Cursor pane child process identity is invalid');
      const childStat = await processStat(procRoot, Number(child));
      if (childStat?.ppid === pid) pending.push(Number(child));
    }
  }
  return descendants;
}

async function readPastedTextFile(filename) {
  // A nonblocking, non-symlink regular file cannot redirect this read to a pipe
  // or another session's paste store. Bound reads as well as the initial size:
  // Cursor may append to the file between stat() and read().
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Cursor pasted text store must be a regular file');
    if (info.size > MAX_PASTED_TEXT_BYTES) throw new Error('Cursor pasted text store exceeds the 8 MiB limit');
    const chunks = []; let size = 0;
    while (size <= MAX_PASTED_TEXT_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_PASTED_TEXT_BYTES + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_PASTED_TEXT_BYTES) throw new Error('Cursor pasted text store exceeds the 8 MiB limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    const plainObject = item => item !== null && typeof item === 'object' && !Array.isArray(item) && Object.getPrototypeOf(item) === Object.prototype;
    if (!plainObject(value) || !plainObject(value.entries) || Object.values(value.entries).some(text => typeof text !== 'string')) {
      throw new Error('Cursor pasted text store entries must be a plain string map');
    }
    return { entries: value.entries };
  } finally { await handle.close(); }
}

/**
 * Connects to an already-running Cursor TUI. It never starts an agent or changes
 * persistent tmux configuration. A requested input width may temporarily widen
 * an exclusive window and is restored immediately after Enter. The caller must establish that the prompt is idle and its
 * draft is empty before paste(); this transport cannot interpret the TUI.
 *
 * A test runner may be injected as run(tmuxArgs, { input } = {}), returning
 * { stdout, stderr }. Input goes to stdin and is never interpreted by a shell.
 */
export class TmuxClient {
  constructor({ tmuxPath = 'tmux', procRoot = '/proc', run, inputLeaseFactory = createInputLease, commandTimeoutMs = 5_000, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0) throw new Error('Tmux command timeout must be a positive integer');
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('Tmux output limit must be a positive integer');
    this.procRoot = procRoot;
    this.tmuxPath = tmuxPath;
    this.inputLeaseFactory = inputLeaseFactory;
    this.run = run || defaultRunner(tmuxPath, { commandTimeoutMs, maxOutputBytes });
    this.identities = new Map();
    this.panes = new Map();
    this.observations = new Map();
    this.snapshots = new WeakMap();
  }

  async discover() {
    try { return await this.scan(); }
    catch (error) {
      this.identities = new Map(); this.panes = new Map(); this.observations = new Map();
      if (error.code === 'ENOENT' || /\bno server running\b|\bno sessions\b|error connecting[^\n]*No such file or directory/i.test(error.message || '')) return [];
      throw error;
    }
  }

  async scan() {
    // tmux sanitizes literal control characters in formats on some versions.
    // Keep cwd last so a visible separator inside a path cannot shift fields.
    const result = await this.run(['list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_in_mode}|#{pane_dead}|#{pane_current_path}']);
    const panes = String(result.stdout || '').split('\n').flatMap((line) => {
      const match = /^(%\d+)\|([1-9]\d*)\|([01])\|([01])\|(.*)$/.exec(line);
      return match ? [{ paneId: match[1], panePid: Number(match[2]), inMode: match[3] === '1', dead: match[4] === '1', paneCwd: match[5] }] : [];
    });
    let entries;
    try { entries = await readdir(this.procRoot); } catch { this.identities = new Map(); this.panes = new Map(); this.observations = new Map(); return []; }
    const stats = await batches(entries.filter((entry) => /^[1-9]\d*$/.test(entry)), (entry) => processStat(this.procRoot, Number(entry)));
    const processes = new Map(stats.filter(Boolean).map((stat) => [stat.pid, stat]));
    const bindings = []; const identities = new Map(); const paneStates = new Map(); const observations = new Map();
    for (const pane of panes) {
      const descendants = [...processes.values()].flatMap((stat) => {
        const chain = ancestorChain(processes, stat.pid, pane.panePid);
        return chain ? [{ stat, chain }] : [];
      });
      const matches = (await batches(descendants, async ({ stat, chain }) => {
        const stores = await cursorStores(this.procRoot, stat.pid);
        return stores.map((store) => ({ stat, chain, store }));
      })).flat();
      // A pane containing several Cursor databases cannot identify one session.
      if (new Set(matches.map(({ store }) => store)).size !== 1) continue;
      const candidate = matches.sort((left, right) => left.chain.length - right.chain.length || left.stat.pid - right.stat.pid)[0];
      if (!candidate) continue;
      const rechecked = await Promise.all(candidate.chain.map((stat) => processStat(this.procRoot, stat.pid)));
      if (!candidate.chain.every((stat, index) => sameProcess(stat, rechecked[index]))) continue;
      // Closing the database, replacing a process, or leaving the pane invalidates
      // the observation; a later poll can establish a new binding.
      if (!(await cursorStores(this.procRoot, candidate.stat.pid)).includes(candidate.store)) continue;
      let cwd;
      try { cwd = await readlink(join(this.procRoot, String(candidate.stat.pid), 'cwd')); } catch { continue; }
      if (!isAbsolute(cwd)) continue;
      const sessionId = STORE.exec(candidate.store)[1].toLowerCase();
      const binding = { paneId: pane.paneId, panePid: pane.panePid, agentPid: candidate.stat.pid, agentStartTime: candidate.stat.startTime, cwd, sessionId };
      bindings.push(binding);
      const identity = `${candidate.chain.map(({ pid, startTime }) => `${pid}:${startTime}`).join('/')}:${candidate.store}`;
      identities.set(pane.paneId, identity);
      const current = rechecked[0]; const paneProcess = rechecked.at(-1);
      const state = { inMode: pane.inMode, dead: pane.dead, foreground: Number.isSafeInteger(current.tty) && current.tty !== 0 && current.tty === paneProcess.tty && current.pgrp > 0 && current.pgrp === current.foregroundPgrp && current.pgrp === paneProcess.foregroundPgrp };
      paneStates.set(pane.paneId, state);
      observations.set(pane.paneId, { binding, identity, state });
      this.snapshots.set(binding, { ...binding, identity, storePath: candidate.store });
    }
    this.identities = identities;
    this.panes = paneStates;
    this.observations = observations;
    return bindings;
  }

  /** Uses the most recent discovery; pass an object returned by this client. */
  isVerified(binding) {
    const snapshot = binding && this.snapshots.get(binding);
    const latest = snapshot && this.observations.get(snapshot.paneId);
    return Boolean(latest && latest.identity === snapshot.identity &&
      Object.keys(snapshot).filter((key) => key !== 'identity' && key !== 'storePath').every((key) => binding[key] === snapshot[key] && latest.binding[key] === snapshot[key]) &&
      !latest.state.inMode && !latest.state.dead && latest.state.foreground);
  }

  /** Rechecks the process and foreground immediately; never sends any keys. */
  async verifiedBinding(binding) {
    const snapshot = binding && this.snapshots.get(binding);
    if (!snapshot) throw new Error('A binding returned by this TmuxClient is required');
    await this.discover();
    if (!this.isVerified(binding)) throw new Error('Cursor tmux binding changed, is in copy-mode, or is no longer in the foreground');
    return this.observations.get(snapshot.paneId).binding;
  }

  /** Rechecks a pinned process between full discoveries during an input lease. */
  async verifyPinnedProcess(binding, { descendants = false } = {}) {
    const snapshot = binding && this.snapshots.get(binding);
    if (!snapshot || !this.isVerified(binding)) throw new Error('A verified Cursor process snapshot is required');
    const boundary = snapshot.identity.indexOf(':/');
    const chainText = snapshot.identity.slice(0, boundary);
    if (boundary < 0 || !/^[1-9]\d*:\d+(?:\/[1-9]\d*:\d+)*$/.test(chainText)) throw new Error('Cursor pinned process identity is invalid');
    const chain = chainText.split('/').map(part => { const [pid, startTime] = part.split(':'); return { pid: Number(pid), startTime }; });
    if (chain[0].pid !== snapshot.agentPid || chain.at(-1).pid !== snapshot.panePid) throw new Error('Cursor pinned process chain changed');
    const check = async () => {
      const stats = await Promise.all(chain.map(item => processStat(this.procRoot, item.pid)));
      if (stats.some((stat, index) => !stat || stat.startTime !== chain[index].startTime || (index + 1 < chain.length && stat.ppid !== chain[index + 1].pid))) throw new Error('Cursor pinned process chain changed');
      const current = stats[0]; const pane = stats.at(-1);
      if (!current.tty || current.tty !== pane.tty || current.pgrp <= 0 || current.pgrp !== current.foregroundPgrp || current.pgrp !== pane.foregroundPgrp) throw new Error('Cursor pinned process left the foreground');
      return stats;
    };
    const before = await check();
    const stores = await cursorStores(this.procRoot, snapshot.agentPid);
    if (stores.length !== 1 || stores[0] !== snapshot.storePath || await readlink(join(this.procRoot, String(snapshot.agentPid), 'cwd')) !== snapshot.cwd) throw new Error('Cursor pinned process database or directory changed');
    if (descendants) {
      const processes = await paneDescendants(this.procRoot, snapshot.panePid);
      const paths = new Set((await batches(processes, stat => cursorStores(this.procRoot, stat.pid))).flat());
      if (paths.size !== 1 || !paths.has(snapshot.storePath)) throw new Error('Cursor pinned pane database binding changed');
    }
    const after = await check();
    if (!before.every((stat, index) => sameProcess(stat, after[index]))) throw new Error('Cursor pinned process changed during verification');
    return binding;
  }

  /** Reads Cursor's saved paste expansions without sending input to its TUI. */
  async readPastedTexts(binding) {
    const current = await this.verifiedBinding(binding);
    const { storePath } = this.snapshots.get(binding);
    const stores = await cursorStores(this.procRoot, current.agentPid);
    if (stores.length !== 1 || stores[0] !== storePath || STORE.exec(storePath)?.[1].toLowerCase() !== current.sessionId) {
      throw new Error('Cursor tmux database identity changed while reading pasted text');
    }
    try {
      try { return await readPastedTextFile(join(dirname(storePath), 'pasted_text.json')); }
      catch (error) {
        if (error.code === 'ENOENT') return { entries: {} };
        throw error;
      }
    } finally {
      // Missing files also require this check: absence must not hide a reused
      // PID, a different session, copy-mode, or a changed foreground process.
      await this.verifiedBinding(binding);
    }
  }

  async capture(paneId, { escapes = true } = {}) {
    const result = await this.run(['capture-pane', '-p', ...(escapes ? ['-e'] : []), '-J', '-S', '-500', '-t', paneTarget(paneId)]);
    return String(result.stdout || '');
  }

  async binding(paneId, sessionId, identity) {
    const target = paneTarget(paneId); const expected = sessionTarget(sessionId);
    const matches = (await this.discover()).filter((entry) => entry.paneId === target && entry.sessionId === expected);
    const currentIdentity = this.identities.get(target);
    if (matches.length !== 1 || !currentIdentity || (identity && identity !== currentIdentity)) {
      throw new Error('Cursor tmux session changed or is no longer running; no further keys were sent');
    }
    const state = this.panes.get(target);
    if (state.inMode || state.dead || !state.foreground) throw new Error('Cursor tmux pane is in copy-mode, closed, or no longer in the foreground; no further keys were sent');
    return currentIdentity;
  }

  async inputViewport(paneId) {
    const { stdout } = await this.run(['display-message', '-p', '-t', paneTarget(paneId), '#{pane_id}|#{window_id}|#{window_width}|#{window_height}|#{pane_width}|#{pane_height}|#{window_panes}|#{window_zoomed_flag}']);
    const match = /^(%\d+)\|(@\d+)\|([1-9]\d*)\|([1-9]\d*)\|([1-9]\d*)\|([1-9]\d*)\|([1-9]\d*)\|([01])$/.exec(String(stdout || '').trim());
    if (!match || match[1] !== paneId || match.slice(3, 8).some(value => !Number.isSafeInteger(Number(value)))) {
      throw new Error('Cursor tmux input window geometry could not be verified');
    }
    return { paneId: match[1], windowId: match[2], width: Number(match[3]), height: Number(match[4]), paneWidth: Number(match[5]), paneHeight: Number(match[6]), panes: Number(match[7]), zoomed: match[8] === '1' };
  }

  async localWindowSize(windowId) {
    const { stdout } = await this.run(['show-options', '-w', '-qv', '-t', windowId, 'window-size']);
    const value = String(stdout || '').trim();
    if (value && !['largest', 'smallest', 'manual', 'latest'].includes(value)) throw new Error('Cursor tmux local window-size option could not be verified');
    // Without -A, an empty value means this window inherits the global option.
    return value || null;
  }

  async restoreInputViewport(paneId, original, columns, originalOption) {
    const current = await this.inputViewport(paneId);
    const option = await this.localWindowSize(original.windowId);
    const exclusive = current.windowId === original.windowId && current.panes === 1 && !current.zoomed && current.paneWidth === current.width && current.paneHeight === current.height;
    if (!exclusive || current.width !== columns || current.height !== original.height || option !== 'manual') {
      // A failed resize that made no changes needs no cleanup. Any other state
      // belongs to a concurrent actor; never overwrite their layout or option.
      if (exclusive && current.width === original.width && current.height === original.height && option === originalOption) return;
      throw new Error('Cursor tmux input window changed concurrently; automatic width restoration was skipped to preserve the current layout and window-size option');
    }
    await this.run(['resize-window', '-t', original.windowId, '-x', String(original.width), '-y', String(original.height)]);
    const restored = await this.inputViewport(paneId);
    if (restored.windowId !== original.windowId || restored.width !== original.width || restored.height !== original.height || restored.paneWidth !== original.width || restored.paneHeight !== original.height || restored.panes !== 1 || restored.zoomed || await this.localWindowSize(original.windowId) !== 'manual') {
      throw new Error('Cursor tmux input window changed during automatic restoration; the current window-size option was preserved');
    }
    // resize-window sets a local manual option. Restore inheritance with -u,
    // rather than freezing the global value as a new local override.
    await this.run(originalOption === null
      ? ['set-option', '-wu', '-t', original.windowId, 'window-size']
      : ['set-option', '-w', '-t', original.windowId, 'window-size', originalOption]);
  }

  async withInputViewport(paneId, sessionId, identity, minimumColumns, operation) {
    if (minimumColumns === undefined) return operation();
    const original = await this.inputViewport(paneId);
    if (original.paneWidth >= minimumColumns) return operation();
    if (original.panes !== 1 || original.zoomed || original.paneWidth !== original.width || original.paneHeight !== original.height) {
      throw new Error('Cursor long input requires more columns, but its tmux window has multiple panes or is zoomed; no new draft was pasted');
    }
    const originalOption = await this.localWindowSize(original.windowId);
    let result; let failure; let resizeAttempted = false;
    try {
      await this.binding(paneId, sessionId, identity);
      const current = await this.inputViewport(paneId);
      if (JSON.stringify(current) !== JSON.stringify(original) || await this.localWindowSize(original.windowId) !== originalOption) {
        throw new Error('Cursor tmux input window changed before automatic widening; no new draft was pasted');
      }
      await this.binding(paneId, sessionId, identity);
      resizeAttempted = true;
      await this.run(['resize-window', '-t', original.windowId, '-x', String(minimumColumns), '-y', String(original.height)]);
      await this.binding(paneId, sessionId, identity);
      const widened = await this.inputViewport(paneId);
      if (widened.windowId !== original.windowId || widened.width !== minimumColumns || widened.height !== original.height || widened.paneWidth !== minimumColumns || widened.paneHeight !== original.height || widened.panes !== 1 || widened.zoomed || await this.localWindowSize(original.windowId) !== 'manual') {
        throw new Error('Cursor tmux input window could not be safely widened; no new draft was pasted');
      }
      result = await operation();
    } catch (error) { failure = error; }
    finally {
      try { if (resizeAttempted) await this.restoreInputViewport(paneId, original, minimumColumns, originalOption); }
      catch (error) {
        // Once Enter succeeds a cleanup failure must not be reported as failed
        // delivery: retrying would submit the same user message twice.
        if (result?.submitted) result.viewportRestoreError = error.message;
        else if (failure instanceof Error) {
          // Keep the guard's original error object and recovery proof. In
          // particular, retry classification requires its exact message and
          // afterPaste may attach unsubmittedDraft for exact retry.
          failure.viewportRestoreError = error.message;
        } else failure = new Error(`Cursor input was not submitted; ${error.message}`, { cause: failure || error });
      }
    }
    if (failure) throw failure;
    return result;
  }

  async withExclusiveInput(paneId, sessionId, identity, operation) {
    await this.binding(paneId, sessionId, identity);
    const binding = this.observations.get(paneId).binding;
    const lease = await this.inputLeaseFactory({ run: this.run, binding, identity, tmuxPath: this.tmuxPath, procRoot: this.procRoot, verify: () => this.binding(paneId, sessionId, identity), verifyPinned: () => this.verifyPinnedProcess(binding, { descendants: true }) });
    let result; let failure;
    try { result = await operation(lease); }
    catch (error) { failure = error; }
    finally {
      try { await lease.release(); }
      catch (error) {
        if (result?.submitted) result.inputLeaseRestoreError = error.message;
        else if (failure instanceof Error) failure.inputLeaseRestoreError = error.message;
        else failure = new Error(`Cursor input was not submitted; ${error.message}`, { cause: error });
      }
    }
    if (failure) throw failure;
    return result;
  }

  async paste(paneId, text, { sessionId, beforePaste, afterPaste, minimumColumns, exclusiveInput = false } = {}) {
    inputColumns(minimumColumns, exclusiveInput);
    if (typeof text !== 'string' || !text.length) throw new Error('A nonempty text prompt is required');
    if ((beforePaste !== undefined && typeof beforePaste !== 'function') || (afterPaste !== undefined && typeof afterPaste !== 'function')) {
      throw new Error('Tmux paste guards must be functions');
    }
    // LF is the only allowed control character: bracketed paste preserves the
    // multiline prompt. In particular, ESC, CR, TAB, DEL and C1 are rejected.
    if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(text) || !text.isWellFormed()) {
      throw new Error('Cursor prompts cannot contain terminal control characters or malformed Unicode');
    }
    const identity = await this.binding(paneId, sessionId);
    if (exclusiveInput) return this.withInputViewport(paneId, sessionId, identity, minimumColumns, () => this.withExclusiveInput(paneId, sessionId, identity, async lease => {
      await lease.assertActive();
      await beforePaste?.(lease);
      await lease.assertActive();
      await lease.paste(text);
      await lease.assertActive();
      await afterPaste?.(lease);
      await lease.assertActive();
      await lease.submit();
      return { submitted: true };
    }));
    return this.withInputViewport(paneId, sessionId, identity, minimumColumns, async () => {
      const buffer = `cursor_bridge_${randomUUID().replaceAll('-', '')}`;
      try {
        await this.run(['load-buffer', '-b', buffer, '-'], { input: text });
        await this.binding(paneId, sessionId, identity);
        // The caller can reject an active prompt, approval, or a concurrent draft
        // immediately before any text reaches the TUI.
        await beforePaste?.();
        await this.binding(paneId, sessionId, identity);
        await this.run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', paneId]);
        await this.binding(paneId, sessionId, identity);
        // Verify that the visible draft contains exactly this prompt before Enter.
        // A rejection leaves the draft in place and never submits it.
        await afterPaste?.();
        await this.binding(paneId, sessionId, identity);
        await this.run(['send-keys', '-t', paneId, 'Enter']);
        return { submitted: true };
      } finally {
        // load-buffer can fail after creation; paste-buffer -d normally removes it.
        try { await this.run(['delete-buffer', '-b', buffer]); } catch { /* Already absent, or the tmux server exited. */ }
      }
    });
  }

  /** Submits an existing draft only after the caller proves its exact contents. */
  async submitDraft(paneId, { sessionId, beforeSubmit, minimumColumns, exclusiveInput = false } = {}) {
    inputColumns(minimumColumns, exclusiveInput);
    if (typeof beforeSubmit !== 'function') throw new Error('A Cursor draft submission guard is required');
    const identity = await this.binding(paneId, sessionId);
    if (exclusiveInput) return this.withInputViewport(paneId, sessionId, identity, minimumColumns, () => this.withExclusiveInput(paneId, sessionId, identity, async lease => {
      await lease.assertActive();
      await beforeSubmit(lease);
      await lease.assertActive();
      await lease.submit();
      return { submitted: true };
    }));
    return this.withInputViewport(paneId, sessionId, identity, minimumColumns, async () => {
      await beforeSubmit();
      await this.binding(paneId, sessionId, identity);
      await this.run(['send-keys', '-t', paneId, 'Enter']);
      return { submitted: true };
    });
  }

  async cancel(paneId, { sessionId, key = 'Escape' } = {}) {
    if (!['Escape', 'C-c'].includes(key)) throw new Error('The Cursor stop key must be Escape or C-c');
    await this.binding(paneId, sessionId);
    await this.run(['send-keys', '-t', paneId, key]);
  }
}
