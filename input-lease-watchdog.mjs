import { constants } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { INPUT_LEASE_OPTION, INPUT_LEASE_TTL_MS, cancelLeaseArguments, linuxProcessStart, restoreLeaseInput } from './input-lease.mjs';

// This process inherits no pane descriptors and never writes terminal input or
// signals another process. It also survives an abrupt bridge/helper exit.
const file = await open(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW);
let config;
try {
  const info = await file.stat();
  if (!info.isFile() || info.size > 32 * 1024 || (info.mode & 0o077)) throw new Error('Invalid input lease configuration');
  config = JSON.parse(await file.readFile('utf8'));
} finally { await file.close(); }
if (config.version !== 1 || !/^[a-f0-9]{48}$/.test(config.owner || '') || !/^%\d+$/.test(config.paneId || '') || !Number.isSafeInteger(config.parentPid) || !/^\d+$/.test(config.parentStart || '') || config.cancelOption !== `@cursor_bridge_input_cancel_${config.owner}` || config.doneOption !== `@cursor_bridge_input_done_${config.owner}` || !Number.isSafeInteger(config.deadline) || config.deadline > Date.now() + INPUT_LEASE_TTL_MS) throw new Error('Invalid input lease watchdog identity');
const run = args => new Promise((resolve, reject) => {
  const child = spawn(config.tmuxPath, ['-S', config.tmuxSocket, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks = []; let size = 0;
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Input lease watchdog tmux timed out')); }, 2_000); timer.unref();
  child.stdout.on('data', chunk => { size += chunk.length; if (size > 64 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); if (code === 0 && size <= 64 * 1024) resolve({ stdout: Buffer.concat(chunks).toString('utf8') }); else reject(new Error('Input lease watchdog tmux failed')); });
});
const sameProcess = async (pid, start) => { try { return await linuxProcessStart(pid, config.procRoot) === start; } catch { return false; } };
await new Promise((resolve, reject) => process.stdout.write('ready\n', error => error ? reject(error) : resolve()));
process.stdout.end();
let helper; let cancelled = false;
while (true) {
  let owner; let done; let cancel;
  try { [owner, done, cancel] = String((await run(['display-message', '-p', '-t', config.paneId, `#{${INPUT_LEASE_OPTION}}|#{${config.doneOption}}|#{${config.cancelOption}}`])).stdout || '').trim().split('|'); }
  catch {
    if (!await sameProcess(config.serverPid, config.serverStart)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
    continue;
  }
  const parentAlive = await sameProcess(config.parentPid, config.parentStart);
  if (owner !== config.owner && done === '1' && (cancel === '1' || !parentAlive)) {
    // The original tmux queue has reached its completion marker. Its cancelled
    // branch can no longer wake up later, so these unique options are disposable.
    for (const option of [config.cancelOption, config.doneOption]) await run(['set-option', '-pu', '-t', config.paneId, option]).catch(() => {});
    await rm(config.configPath, { force: true }).catch(() => {});
    break;
  }
  if (!helper) {
    try { const value = JSON.parse(await readFile(config.helperIdentityPath, 'utf8')); if (value.owner === config.owner && Number.isSafeInteger(value.pid) && /^\d+$/.test(value.start || '')) helper = value; } catch { /* The helper may not have started yet. */ }
  }
  const alive = parentAlive && (!helper || await sameProcess(helper.pid, helper.start));
  if (!alive || cancel === '1' || Date.now() >= config.deadline) {
    try { cancelled = cancel === '1' || String((await run(cancelLeaseArguments(config))).stdout || '').trim() === config.owner; } catch { /* Retry without discarding the late helper's configuration. */ }
    if (cancelled) {
      await restoreLeaseInput(run, config).catch(() => {});
      // Deadline stops all input, not recovery. A busy live server must not
      // strand an owned input-off flag merely because its queue responds late.
      if (Date.now() >= config.deadline + 3_000 && owner !== config.owner) break;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
