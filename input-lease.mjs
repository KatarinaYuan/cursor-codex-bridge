import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const INPUT_LEASE_OPTION = '@cursor_bridge_input_lease';
export const INPUT_LEASE_TTL_MS = 300_000;
const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'input-lease-helper.mjs');
const shellWord = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function leaseCondition({ paneId, panePid, owner }, acquiring = false) {
  const checks = [`#{==:#{pane_id},${paneId}}`, `#{==:#{pane_pid},${panePid}}`, '#{==:#{pane_dead},0}', '#{==:#{pane_in_mode},0}', `#{==:#{pane_input_off},${acquiring ? 0 : 1}}`, `#{==:#{${INPUT_LEASE_OPTION}},${acquiring ? '' : owner}}`];
  if (acquiring) checks.push('#{==:#{pane_pipe},0}');
  if (acquiring) checks.push(`#{!=:#{@cursor_bridge_input_cancel_${owner}},1}`);
  return checks.reduce((left, right) => `#{&&:${left},${right}}`);
}

export function acquireLeaseArguments(config, helperPath = HELPER) {
  const command = `exec ${shellWord(process.execPath)} ${shellWord(helperPath)} ${shellWord(config.configPath)}`;
  // set-option may run a user's after-set-option hook, which can yield the
  // server command queue. Recheck after that hook before touching input/pipe.
  const innerCondition = leaseCondition(config, true).replace(`#{${INPUT_LEASE_OPTION}},`, `#{${INPUT_LEASE_OPTION}},${config.owner}`);
  const install = `select-pane -d -t ${config.paneId} ; pipe-pane -I -t ${config.paneId} ${shellWord(command)} ; display-message -p ${config.owner}`;
  return ['if-shell', '-F', '-t', config.paneId, leaseCondition(config, true),
    `set-option -p -t ${config.paneId} ${INPUT_LEASE_OPTION} ${config.owner} ; if-shell -F -t ${config.paneId} ${shellWord(innerCondition)} ${shellWord(install)} 'display-message -p cursor-input-lease-unavailable'`,
    'display-message -p cursor-input-lease-unavailable', ';', 'set-option', '-p', '-t', config.paneId, config.doneOption || `@cursor_bridge_input_done_${config.owner}`, '1'];
}

export function cancelLeaseArguments(config) {
  const condition = `#{&&:#{==:#{pane_id},${config.paneId}},#{==:#{pane_pid},${config.panePid}}}`;
  return ['if-shell', '-F', '-t', config.paneId, condition, `set-option -p -t ${config.paneId} ${config.cancelOption} 1 ; display-message -p ${config.owner}`, 'display-message -p cursor-input-pane-gone'];
}

export function releaseLeaseArguments(config) {
  const base = [`#{==:#{pane_id},${config.paneId}}`, `#{==:#{pane_pid},${config.panePid}}`, `#{==:#{${INPUT_LEASE_OPTION}},${config.owner}}`];
  const checks = [...base, '#{==:#{pane_input_off},1}', '#{==:#{pane_pipe},0}'];
  const condition = checks.reduce((left, right) => `#{&&:${left},${right}}`);
  const notDisabled = [...base, '#{==:#{pane_input_off},0}'].reduce((left, right) => `#{&&:${left},${right}}`);
  return ['if-shell', '-F', '-t', config.paneId, condition,
    `select-pane -e -t ${config.paneId} ; set-option -pu -t ${config.paneId} ${INPUT_LEASE_OPTION} ; display-message -p ${config.owner}`,
    `if-shell -F -t ${config.paneId} ${shellWord(notDisabled)} ${shellWord(`set-option -pu -t ${config.paneId} ${INPUT_LEASE_OPTION} ; display-message -p ${config.owner}`)} 'display-message -p cursor-input-lease-not-restored'`];
}

export async function restoreLeaseInput(run, config, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const result = await run(releaseLeaseArguments(config));
      if (String(result.stdout || '').trim() === config.owner) return;
      const state = await run(['display-message', '-p', '-t', config.paneId, `#{pane_id}|#{pane_pid}|#{pane_input_off}|#{${INPUT_LEASE_OPTION}}`]);
      if (String(state.stdout || '').trim() === `${config.paneId}|${config.panePid}|0|`) return;
    } catch { /* The server may still be consuming the owned pipe's EOF. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error('Cursor pane changed before input could be restored; its current pipe and input settings were preserved');
}

export async function linuxProcessStart(pid, procRoot = '/proc') {
  const value = await readFile(join(procRoot, String(pid), 'stat'), 'utf8');
  const boundary = value.lastIndexOf(') ');
  const fields = value.slice(boundary + 2).trim().split(/\s+/);
  if (boundary < 0 || Number(value.slice(0, value.indexOf(' '))) !== pid || !/^\d+$/.test(fields[19] || '') || ['Z', 'X', 'x'].includes(fields[0])) throw new Error('Cursor input lease process identity is unavailable');
  return fields[19];
}

/** A private pipe-pane input helper owns the only live input route until release. */
export async function createInputLease({ run, verify, verifyPinned = verify, binding, identity, tmuxPath = 'tmux', procRoot = '/proc', ttlMs = INPUT_LEASE_TTL_MS, helperPath = HELPER }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > INPUT_LEASE_TTL_MS) throw new Error('Cursor input lease deadline is invalid');
  await verify();
  const parentStart = await linuxProcessStart(process.pid, procRoot);
  const { stdout } = await run(['display-message', '-p', '-t', binding.paneId, '#{socket_path}|#{pid}']);
  const serverMatch = /^(\/[^\r\n\0]*)\|([1-9]\d*)$/.exec(String(stdout || '').trim());
  if (!serverMatch) throw new Error('Cursor tmux server socket could not be verified');
  const socketPath = serverMatch[1]; const serverPid = Number(serverMatch[2]);
  const serverStart = await linuxProcessStart(serverPid, procRoot);
  const root = await mkdtemp(join(tmpdir(), 'cursor-input-'));
  await chmod(root, 0o700);
  const owner = randomBytes(24).toString('hex');
  const config = { version: 1, ...binding, owner, identity, tmuxPath, procRoot, tmuxSocket: socketPath, serverPid, serverStart, socket: join(root, 's'), configPath: join(root, 'config.json'), helperIdentityPath: join(root, 'helper.json'), cancelOption: `@cursor_bridge_input_cancel_${owner}`, doneOption: `@cursor_bridge_input_done_${owner}`, parentPid: process.pid, parentStart, deadline: Date.now() + ttlMs };
  let connection; let server; let guardian; let acquireAttempted = false; let closing = false; let released = false; let requestId = 0; let readyResolve; let readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A rejection can arrive while the acquiring tmux command is still running.
  ready.catch(() => {});
  const rejectAll = error => { readyReject(error); for (const item of pending.values()) item.reject(error); pending.clear(); };
  try {
    await writeFile(config.configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    // Node can silently truncate Linux Unix socket names at sun_path's limit,
    // potentially placing the socket outside its private temporary directory.
    if (Buffer.byteLength(config.socket) > 107) throw new Error('Cursor input lease IPC socket path exceeds its safe length');
    server = createServer(socket => {
      if (connection || closing) { socket.destroy(); return; }
      connection = socket;
      let buffer = ''; let authenticated = false;
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 128 * 1024) { socket.destroy(new Error('Cursor input lease response exceeded its limit')); return; }
        for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { socket.destroy(new Error('Cursor input lease returned an invalid response')); return; }
          if (!authenticated) {
            if (message.hello !== owner || !Number.isSafeInteger(message.pid) || !/^\d+$/.test(message.start || '')) { socket.destroy(); return; }
            authenticated = true; readyResolve(); continue;
          }
          if (typeof message.fatal === 'string') { rejectAll(new Error(`Cursor input lease ended: ${message.fatal}`)); continue; }
          const item = pending.get(message.id);
          if (!item) continue;
          pending.delete(message.id);
          if (message.ok === true) item.resolve(message);
          else item.reject(new Error(message.error || 'Cursor input lease rejected the operation'));
        }
      });
      socket.on('error', error => rejectAll(error));
      socket.on('close', () => { if (!released) rejectAll(new Error('Cursor input lease disconnected; no further input is allowed')); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
    guardian = spawn(process.execPath, [fileURLToPath(new URL('./input-lease-watchdog.mjs', import.meta.url)), config.configPath], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve, reject) => {
      let response = ''; const timer = setTimeout(() => reject(new Error('Cursor input lease watchdog did not become ready')), 5_000); timer.unref();
      guardian.stdout.on('data', value => { response += value; if (response === 'ready\n') { clearTimeout(timer); resolve(); } else if (response.length > 32) { clearTimeout(timer); reject(new Error('Cursor input lease watchdog returned an invalid response')); } });
      guardian.once('error', error => { clearTimeout(timer); reject(error); });
      guardian.once('exit', code => { clearTimeout(timer); if (response !== 'ready\n') reject(new Error(`Cursor input lease watchdog exited before readiness (${code})`)); });
    });
    guardian.unref();
    acquireAttempted = true;
    const acquired = await run(acquireLeaseArguments(config, helperPath));
    if (String(acquired.stdout || '').trim() !== owner) throw new Error('Cursor pane input is already disabled, piped, or leased; no text was pasted');
    let timer;
    try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cursor input lease helper did not become ready')), 5_000); timer.unref(); })]); }
    finally { clearTimeout(timer); }
    const request = async (action, extra = {}) => {
      if (closing || !connection || connection.destroyed || Date.now() >= config.deadline) throw new Error('Cursor input lease is no longer active');
      await ((action === 'assert' || action === 'move') && extra.full !== true ? verifyPinned : verify)();
      if (closing || connection.destroyed || Date.now() >= config.deadline) throw new Error('Cursor input lease expired before input');
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const operationMs = action === 'move' ? 10_000 + extra.count * 100 : 10_000;
        const timer = setTimeout(() => { pending.delete(id); connection.destroy(); reject(new Error('Cursor input lease operation timed out; no further input is allowed')); }, Math.min(operationMs, Math.max(1, config.deadline - Date.now())));
        timer.unref();
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        connection.write(`${JSON.stringify({ id, action, ...extra })}\n`, error => { if (error) { const item = pending.get(id); pending.delete(id); item?.reject(error); } });
      });
    };
    const lease = {
      assertActive: ({ full = false } = {}) => {
        if (typeof full !== 'boolean') throw new Error('Cursor input full verification flag must be boolean');
        return request('assert', { full });
      },
      moveCursor: (direction, count = 1) => {
        if (!['left', 'right'].includes(direction) || !Number.isSafeInteger(count) || count < 1 || count > 800) throw new Error('Cursor input navigation must move left or right by 1 to 800 characters');
        return request('move', { direction, count });
      },
      paste: text => request('paste', { text }),
      typeAscii: text => {
        if (typeof text !== 'string' || !/^[a-f0-9]{32}$/.test(text)) throw new Error('Cursor input verification anchors must contain 32 lowercase hexadecimal characters');
        return request('ascii', { text });
      },
      adoptAsciiMarker: text => {
        if (typeof text !== 'string' || !/^[a-f0-9]{32}$/.test(text)) throw new Error('Cursor input verification anchors must contain 32 lowercase hexadecimal characters');
        return request('adopt', { text });
      },
      backspace: count => {
        if (count !== 32) throw new Error('Cursor input verification deletion must contain exactly 32 characters');
        return request('backspace', { count });
      },
      submit: async () => {
        // An acknowledgement failure cannot establish whether CR reached the TUI.
        // The caller must never retry this attempt automatically.
        try { return await request('submit'); }
        catch (error) { error.inputSubmissionUnknown = true; throw error; }
      },
      release: async () => {
        if (released) return;
        let failure;
        try { await request('release'); released = true; }
        catch (error) {
          // The helper can be killed independently. EOF then removes its pipe;
          // this exact-owner/no-pipe CAS remains safe without a helper ACK.
          connection?.destroy();
          try { await restoreLeaseInput(run, config); released = true; }
          catch { failure = error; }
        }
        // A completed queue alone is insufficient for guardian cleanup: on a
        // rejected acquisition the parent must first install cancellation.
        // Signal that this successful release also reached its final phase.
        if (released) {
          try { await run(cancelLeaseArguments(config)); }
          catch (error) { failure ||= error; }
        }
        closing = true; connection?.end(); server.close();
        if (!failure) await rm(root, { recursive: true, force: true });
        if (failure) throw new Error(`Cursor input lease restoration could not be confirmed: ${failure.message}`, { cause: failure });
      },
    };
    await lease.assertActive({ full: true });
    return lease;
  } catch (error) {
    closing = true; connection?.destroy(); server?.close();
    if (!acquireAttempted) {
      // No acquisition command can arrive late. Stop only this spawned,
      // pre-acquisition watchdog; do not create cancellation without a queue.
      if (guardian?.pid && guardian.exitCode === null && guardian.signalCode === null) {
        guardian.kill('SIGTERM');
        await new Promise(resolve => {
          if (guardian.exitCode !== null || guardian.signalCode !== null) { resolve(); return; }
          const timer = setTimeout(resolve, 1_000);
          guardian.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill('SIGKILL');
      }
      if (guardian?.pid) {
        // An unusually short deadline may have elapsed during setup. Remove
        // only the two unique options that this unarmed watchdog could create.
        const condition = `#{&&:#{==:#{pane_id},${config.paneId}},#{==:#{pane_pid},${config.panePid}}}`;
        try {
          const metadata = await run(['display-message', '-p', '-t', config.paneId, `#{${config.cancelOption}}|#{${config.doneOption}}`]);
          if (String(metadata.stdout || '').trim() !== '|') await run(['if-shell', '-F', '-t', config.paneId, condition, `set-option -pu -t ${config.paneId} ${config.cancelOption} ; set-option -pu -t ${config.paneId} ${config.doneOption}`]);
        } catch { /* No pane input or ownership was ever acquired. */ }
      }
      await rm(root, { recursive: true, force: true });
      throw error;
    }
    // This never closes a pipe. The helper closes only its own descriptor, then
    // restores input with the same condition if it started late.
    let cancelled = false; let restored = false;
    try { cancelled = String((await run(cancelLeaseArguments(config))).stdout || '').trim() === owner; } catch { /* The independent watchdog retries. */ }
    try { await restoreLeaseInput(run, config); restored = true; } catch { /* Keep configuration available to a late helper/watchdog. */ }
    if (cancelled && restored) await rm(root, { recursive: true, force: true });
    throw error;
  }
}
