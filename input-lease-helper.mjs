import { connect } from 'node:net';
import { closeSync, constants, readSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { TmuxClient } from './tmux.mjs';
import { INPUT_LEASE_OPTION, INPUT_LEASE_TTL_MS, linuxProcessStart, restoreLeaseInput } from './input-lease.mjs';

const handle = await open(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW);
let config;
try {
  const info = await handle.stat();
  if (!info.isFile() || info.size > 32 * 1024 || (info.mode & 0o077)) throw new Error('Invalid input lease configuration');
  config = JSON.parse(await handle.readFile('utf8'));
} finally { await handle.close(); }
if (config.version !== 1 || !/^[a-f0-9]{48}$/.test(config.owner || '') || !/^%\d+$/.test(config.paneId || '') || !Number.isSafeInteger(config.parentPid) || !Number.isSafeInteger(config.deadline) || config.deadline > Date.now() + INPUT_LEASE_TTL_MS) throw new Error('Invalid input lease identity');

const run = args => new Promise((resolve, reject) => {
  const child = spawn(config.tmuxPath, ['-S', config.tmuxSocket, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let size = 0;
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Input lease tmux verification timed out')); }, 4_000); timer.unref();
  child.stdout.on('data', chunk => { size += chunk.length; if (size > 64 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); });
  child.stderr.resume();
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); if (code === 0 && size <= 64 * 1024) resolve({ stdout: Buffer.concat(chunks).toString('utf8') }); else reject(new Error('Input lease tmux verification failed')); });
});
const client = new TmuxClient({ procRoot: config.procRoot, run });
let stopped = false; let tainted = false; let pasted = false; let submitted = false; let marker; let markerRemoved = false; let cleaning; let socket; let watchdog; let pinnedBinding;
// Initializing the Node socket puts this socketpair descriptor in nonblocking
// mode. Drain any copied pane output before testing EOF: buffered redraw bytes
// must not hide a peer that tmux closed/replaced. These bytes are never input.
const output = process.stdout;
const peerBytes = Buffer.alloc(4096);
const assertPipePeer = () => {
  for (let consumed = 0; consumed <= 1024 * 1024;) {
    try {
      const bytes = readSync(1, peerBytes, 0, peerBytes.length, null);
      if (bytes === 0) throw new Error('Cursor input lease pipe was closed or replaced');
      consumed += bytes;
    } catch (error) {
      if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return;
      throw error;
    }
  }
  throw new Error('Cursor input lease pane output exceeded its bounded peer check');
};
const send = message => { if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };
const abortLease = error => {
  send({ fatal: error.message });
  cleanup().finally(() => socket?.destroy()).catch(() => {});
};
const sameParent = async () => { if (await linuxProcessStart(config.parentPid, config.procRoot) !== config.parentStart) throw new Error('Cursor input lease parent changed'); };
const assertActive = async (pinned = false, descendants = false) => {
  if (stopped || tainted || Date.now() >= config.deadline) throw new Error('Cursor input lease expired or an earlier input write failed');
  await sameParent();
  const binding = pinned ? await client.verifyPinnedProcess(pinnedBinding, { descendants }) : (await client.discover()).find(item => item.paneId === config.paneId && item.sessionId === config.sessionId);
  if (!binding || !client.isVerified(binding) || binding.panePid !== config.panePid || binding.agentPid !== config.agentPid || binding.agentStartTime !== config.agentStartTime || client.identities.get(config.paneId) !== config.identity) throw new Error('Cursor input lease process binding changed');
  pinnedBinding = binding;
  const { stdout } = await run(['display-message', '-p', '-t', config.paneId, `#{pane_id}|#{pane_pid}|#{pane_input_off}|#{pane_pipe}|#{pane_dead}|#{pane_in_mode}|#{${INPUT_LEASE_OPTION}}`]);
  if (String(stdout).trim() !== `${config.paneId}|${config.panePid}|1|1|0|0|${config.owner}`) throw new Error('Cursor input lease ownership changed');
  assertPipePeer();
  if (stopped || Date.now() >= config.deadline) throw new Error('Cursor input lease expired before input');
};
const cleanup = () => {
  if (cleaning) return cleaning;
  stopped = true; clearInterval(watchdog);
  cleaning = (async () => {
    // Never issue pipe-pane without a command: a concurrent actor may have
    // replaced our pipe. Closing this exact descriptor cannot close theirs.
    try { closeSync(1); } catch { /* The server may already have closed it. */ }
    await restoreLeaseInput(run, config);
  })();
  return cleaning;
};
const writeInput = async bytes => {
  try {
    if (stopped || tainted || Date.now() >= config.deadline) throw new Error('Cursor input lease expired before input');
    assertPipePeer();
    await new Promise((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()));
  } catch (error) { tainted = true; throw error; }
};
process.stdout.on('error', error => { abortLease(error); });
process.once('SIGTERM', () => { cleanup().finally(() => socket?.destroy()).catch(() => {}); });
process.once('SIGINT', () => { cleanup().finally(() => socket?.destroy()).catch(() => {}); });
let chain = Promise.resolve();
try {
  await sameParent();
  const helperStart = await linuxProcessStart(process.pid, config.procRoot);
  await writeFile(config.helperIdentityPath, JSON.stringify({ owner: config.owner, pid: process.pid, start: helperStart }), { mode: 0o600, flag: 'wx' });
  if (Date.now() >= config.deadline) throw new Error('Cursor input lease expired before helper startup');
  socket = connect(config.socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  send({ hello: config.owner, pid: process.pid, start: helperStart });
  watchdog = setInterval(() => {
    if (Date.now() >= config.deadline) { abortLease(new Error('Cursor input lease deadline reached')); return; }
    try { assertPipePeer(); } catch (error) { abortLease(error); return; }
    sameParent().catch(error => abortLease(error));
  }, 100); watchdog.unref();
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) { socket.destroy(); return; }
    for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      chain = chain.then(async () => {
        const message = JSON.parse(line);
        try {
          if (!Number.isSafeInteger(message.id) || message.id < 1) throw new Error('Invalid input lease request');
          if (message.action === 'release') { await cleanup(); send({ id: message.id, ok: true }); socket.end(); return; }
          await assertActive(Boolean(pinnedBinding && (message.action === 'assert' || message.action === 'move') && message.full !== true), true);
          if (message.action === 'assert') { /* Verification is the operation. */ }
          else if (message.action === 'move') {
            if (!['left', 'right'].includes(message.direction) || !Number.isSafeInteger(message.count) || message.count < 1 || message.count > 800 || submitted) throw new Error('Invalid input lease navigation');
            // Ink parses an aggregated chunk of identical CSI arrows as one
            // key event. Give each arrow its own write and consumption turn;
            // the caller still proves the resulting caret from actual frames.
            const arrow = message.direction === 'left' ? '\u001b[D' : '\u001b[C';
            for (let index = 0; index < message.count; index++) {
              if (index) await assertActive(true);
              await writeInput(arrow);
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          } else if (message.action === 'paste') {
            if (typeof message.text !== 'string' || !message.text || Buffer.byteLength(message.text) > 8 * 1024 * 1024 || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(message.text) || !message.text.isWellFormed() || pasted || submitted) throw new Error('Invalid input lease paste');
            pasted = true;
            await writeInput(`\u001b[200~${message.text}\u001b[201~`);
          } else if (message.action === 'submit') {
            if (submitted) throw new Error('Cursor input lease has already attempted Enter');
            if (marker && !markerRemoved) throw new Error('Cursor input verification anchor has not been removed');
            submitted = true;
            await writeInput('\r');
          } else if (message.action === 'ascii' || message.action === 'adopt') {
            if (typeof message.text !== 'string' || !/^[a-f0-9]{32}$/.test(message.text) || marker || submitted) throw new Error('Invalid input verification anchor');
            marker = message.text;
            if (message.action === 'ascii') await writeInput(message.text);
          } else if (message.action === 'backspace') {
            if (!marker || markerRemoved || message.count !== marker.length || submitted) throw new Error('Invalid input verification deletion');
            await writeInput('\u007f'.repeat(message.count));
            markerRemoved = true;
          } else throw new Error('Invalid input lease operation');
          send({ id: message.id, ok: true });
        } catch (error) { send({ id: message.id, ok: false, error: error.message }); }
      }).catch(() => socket.destroy());
    }
  });
  await new Promise(resolve => { socket.once('close', resolve); socket.once('error', resolve); });
} finally {
  clearInterval(watchdog);
  await cleanup().catch(() => {});
}
