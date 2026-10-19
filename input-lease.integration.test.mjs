import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TmuxClient } from './tmux.mjs';
import { createInputLease, INPUT_LEASE_OPTION, linuxProcessStart } from './input-lease.mjs';

const available = process.platform === 'linux' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0 && spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHAT = '11111111-2222-4333-8444-555555555555';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cursor-lease-test-'));
  const server = `cursor-lease-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const run = args => new Promise((resolve, reject) => {
    const child = spawn('tmux', ['-L', server, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr)));
  });
  t.after(async () => { await run(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, '.cursor', 'chats', 'test-workspace', CHAT); await mkdir(directory, { recursive: true });
  const received = join(root, 'received'); await writeFile(received, '');
  const reader = join(root, 'reader.py');
  await writeFile(reader, "import os,sys,tty\nf=open(sys.argv[1],'a')\ntty.setraw(0)\nwhile True:\n b=os.read(0,65536)\n if not b:break\n with open(sys.argv[2],'ab') as o:o.write(b)\n os.write(1,b'\\x1b[2Ktest redraw\\r')\n");
  const word = value => `'${value.replaceAll("'", "'\\''")}'`;
  await run(['new-session', '-d', '-s', 'raw', '-x', '93', '-y', '27', `python3 ${word(reader)} ${word(join(directory, 'store.db'))} ${word(received)}`]);
  const client = new TmuxClient({ run }); let binding;
  for (let attempt = 0; attempt < 100; attempt++) { [binding] = await client.discover(); if (binding) break; await pause(25); }
  assert.ok(binding, 'The owned raw reader must have a verified synthetic database binding');
  const state = async () => String((await run(['display-message', '-p', '-t', binding.paneId, `#{pane_input_off}|#{pane_pipe}|#{${INPUT_LEASE_OPTION}}`])).stdout).trim();
  const acquire = async (extra = {}) => {
    const [current] = await client.discover();
    const lease = await createInputLease({ run, binding: current, identity: client.identities.get(current.paneId), verify: () => client.binding(current.paneId, CHAT), ...extra });
    t.after(() => lease.release().catch(() => {}));
    return lease;
  };
  const restored = async () => { for (let i = 0; i < 150; i++) { if (await state() === '0|0|') return; await pause(25); } assert.fail('The owned pane input lease was not restored'); };
  const helper = async () => {
    const owner = (await state()).split('|')[2];
    for (const name of await readdir('/proc')) {
      if (!/^[1-9]\d*$/.test(name)) continue;
      try {
        const args = (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0');
        const index = args.findIndex(value => value.endsWith('/input-lease-helper.mjs'));
        if (index < 0) continue;
        const config = JSON.parse(await readFile(args[index + 1], 'utf8'));
        if (config.owner === owner && config.paneId === binding.paneId) return { pid: Number(name), start: await linuxProcessStart(Number(name)), config };
      } catch { /* Ignore unrelated or exiting processes. */ }
    }
    assert.fail('The owned input helper was not found');
  };
  return { root, run, client, binding, received, state, acquire, restored, helper };
}

test('Linux tmux lease preserves literal newlines, navigates raw input, sends one Enter, and restores keyboard input', { skip: !available }, async t => {
  const f = await fixture(t); const text = 'one\n\ntwo\nthree\nfour\nfive\nsix\nseven';
  const result = await f.client.paste(f.binding.paneId, text, { sessionId: CHAT, exclusiveInput: true, afterPaste: async lease => { await lease.moveCursor('left', 3); await lease.moveCursor('right', 3); } });
  assert.deepEqual(result, { submitted: true }); await f.restored(); await pause(50);
  assert.equal(await readFile(f.received, 'utf8'), `\x1b[200~${text}\x1b[201~${'\x1b[D'.repeat(3)}${'\x1b[C'.repeat(3)}\r`);
  await f.run(['send-keys', '-t', f.binding.paneId, '-l', 'normal']); await pause(50);
  assert.ok((await readFile(f.received, 'utf8')).endsWith('normal'));
});

test('Linux tmux lease preserves existing input-disable and foreign pipes', { skip: !available }, async t => {
  const f = await fixture(t);
  await f.run(['select-pane', '-d', '-t', f.binding.paneId]);
  await assert.rejects(f.acquire(), /already disabled/); assert.equal(await f.state(), '1|0|');
  await f.run(['select-pane', '-e', '-t', f.binding.paneId]);
  await f.run(['pipe-pane', '-O', '-t', f.binding.paneId, 'cat >/dev/null']);
  await assert.rejects(f.acquire(), /already disabled/); assert.equal(await f.state(), '0|1|');
});

test('Linux tmux lease setup failure before acquisition leaves no pane metadata', { skip: !available }, async t => {
  const f = await fixture(t); const oldDirectory = process.env.TMPDIR;
  const longDirectory = join(f.root, 'long-socket-directory-'.repeat(6));
  await mkdir(longDirectory);
  try {
    process.env.TMPDIR = longDirectory;
    await assert.rejects(f.acquire(), /listen|socket|argument|path|EINVAL|ENAMETOOLONG/i);
  } finally { if (oldDirectory === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldDirectory; }
  assert.equal(await f.state(), '0|0|');
  assert.doesNotMatch(String((await f.run(['show-options', '-p', '-t', f.binding.paneId])).stdout), /@cursor_bridge_input_/);
});

test('Linux tmux lease waits for cancellation before cleaning a rejected acquisition receipt', { skip: !available }, async t => {
  const f = await fixture(t);
  await f.run(['select-pane', '-d', '-t', f.binding.paneId]);
  const run = async args => {
    const result = await f.run(args);
    if (args[0] === 'if-shell' && args[4].includes('pane_input_off},0')) await pause(400);
    return result;
  };
  await assert.rejects(f.acquire({ run }), /already disabled/);
  assert.equal(await f.state(), '1|0|');
  let options = '';
  for (let index = 0; index < 100; index++) {
    options = String((await f.run(['show-options', '-p', '-t', f.binding.paneId])).stdout);
    if (!options.includes('@cursor_bridge_input_')) break;
    await pause(25);
  }
  assert.doesNotMatch(options, /@cursor_bridge_input_/);
  assert.equal(await readFile(f.received, 'utf8'), '');
});

test('Linux tmux lease requires its single hexadecimal anchor to be removed before the single Enter', { skip: !available }, async t => {
  const f = await fixture(t); const lease = await f.acquire(); const marker = '0123456789abcdef0123456789abcdef';
  await lease.paste('line one\nline two'); await lease.typeAscii(marker);
  await assert.rejects(lease.typeAscii(marker), /anchor/);
  await assert.rejects(lease.submit(), error => error.inputSubmissionUnknown && /not been removed/.test(error.message));
  assert.throws(() => lease.backspace(31), /exactly 32/);
  await lease.backspace(32); await assert.rejects(lease.backspace(32), /deletion/);
  await lease.submit(); await assert.rejects(lease.submit(), /already attempted Enter/);
  await lease.release(); await f.restored(); await pause(50);
  assert.equal(await readFile(f.received, 'utf8'), `\x1b[200~line one\nline two\x1b[201~${marker}${'\x7f'.repeat(32)}\r`);
});

test('Linux tmux lease can register an already verified retained anchor without typing it twice', { skip: !available }, async t => {
  const f = await fixture(t); const lease = await f.acquire();
  await lease.adoptAsciiMarker('0123456789abcdef0123456789abcdef');
  await lease.backspace(32); await lease.submit(); await lease.release(); await f.restored(); await pause(50);
  assert.equal(await readFile(f.received, 'utf8'), `${'\x7f'.repeat(32)}\r`);
});

test('Linux tmux lease keeps full discovery at explicit and input-changing boundaries', { skip: !available }, async t => {
  const f = await fixture(t); let full = 0; let pinned = 0;
  const lease = await f.acquire({
    verify: async () => { full++; await f.client.binding(f.binding.paneId, CHAT); },
    verifyPinned: async () => { pinned++; await f.client.verifyPinnedProcess(f.binding, { descendants: true }); },
  });
  const initialFull = full;
  await lease.assertActive(); await lease.moveCursor('left', 2);
  assert.equal(full, initialFull); assert.equal(pinned, 2);
  await lease.assertActive({ full: true }); assert.equal(full, initialFull + 1);
  await lease.paste('original\ntext');
  await lease.typeAscii('0123456789abcdef0123456789abcdef');
  await lease.backspace(32); await lease.submit();
  assert.equal(full, initialFull + 5);
  await lease.release(); await f.restored();
});

test('Linux tmux lease recovers a lost acquire receipt before its delayed helper starts', { skip: !available }, async t => {
  const f = await fixture(t); const delayed = join(f.root, "delayed ' helper.mjs");
  await writeFile(delayed, `await new Promise(r=>setTimeout(r,500));await import(${JSON.stringify(new URL('./input-lease-helper.mjs', import.meta.url).href)});`);
  const run = async args => { const value = await f.run(args); if (args[0] === 'if-shell' && args[4].includes('pane_input_off},0')) throw new Error('lost acquire receipt'); return value; };
  await assert.rejects(f.acquire({ run, helperPath: delayed }), /lost acquire receipt/);
  await f.restored(); assert.equal(await readFile(f.received, 'utf8'), '');
});

test('Linux tmux lease cancellation prevents a timed-out server branch from installing its late pipe', { skip: !available }, async t => {
  const f = await fixture(t); const socket = String((await f.run(['display-message', '-p', '#{socket_path}'])).stdout).trim();
  const hook = join(f.root, 'delayed-hook.sh');
  await writeFile(hook, '#!/bin/sh\ntmux -S "$1" set-hook -gu after-set-option\nsleep 0.6\n');
  const word = value => `'${value.replaceAll("'", "'\\''")}'`;
  await f.run(['set-hook', '-g', 'after-set-option', `run-shell ${word(`sh ${word(hook)} ${word(socket)}`)}`]);
  const run = async args => {
    const pending = f.run(args);
    if (args[0] === 'if-shell' && args[4].includes('pane_input_off},0')) { pending.catch(() => {}); await pause(50); throw new Error('simulated acquire timeout'); }
    return pending;
  };
  await assert.rejects(f.acquire({ run }), /simulated acquire timeout/);
  await pause(800); await f.restored(); assert.equal(await readFile(f.received, 'utf8'), '');
});

test('Linux tmux lease restores input after its deadline without submitting', { skip: !available }, async t => {
  const f = await fixture(t); const lease = await f.acquire({ ttlMs: 2_000 });
  await pause(2_100); await assert.rejects(lease.assertActive()); await lease.release(); await f.restored();
  assert.equal(await readFile(f.received, 'utf8'), '');
});

test('Linux tmux lease deadline stops a paced bulk navigation before any Enter', { skip: !available }, async t => {
  const f = await fixture(t); const lease = await f.acquire({ ttlMs: 2_000 });
  await assert.rejects(lease.moveCursor('left', 800));
  await lease.release(); await f.restored(); await pause(25);
  const received = await readFile(f.received, 'utf8');
  assert.match(received, /^(?:\x1b\[D)+$/);
  assert.ok(received.length < 800 * 3);
});

test('Linux tmux lease completes its largest paced navigation request without Enter', { skip: !available }, async t => {
  const f = await fixture(t); const lease = await f.acquire();
  assert.throws(() => lease.moveCursor('left', 801), /1 to 800/);
  await lease.moveCursor('left', 800);
  await lease.release(); await f.restored(); await pause(25);
  assert.equal(await readFile(f.received, 'utf8'), '\x1b[D'.repeat(800));
});

test('Linux tmux lease helper crash is recovered by its independent watchdog', { skip: !available }, async t => {
  const f = await fixture(t); const lease = await f.acquire(); const helper = await f.helper();
  assert.equal(await linuxProcessStart(helper.pid), helper.start);
  process.kill(helper.pid, 'SIGKILL');
  await f.restored(); await lease.release(); assert.equal(await readFile(f.received, 'utf8'), '');
});

test('Linux tmux lease restores input after parent death and after both parent and helper die', { skip: !available }, async t => {
  for (const both of [false, true]) await t.test(both ? 'both processes' : 'parent process', async t => {
    const f = await fixture(t);
    const socket = String((await f.run(['display-message', '-p', '#{socket_path}'])).stdout).trim();
    const script = `
      import {spawn} from 'node:child_process';
      import {TmuxClient} from ${JSON.stringify(new URL('./tmux.mjs', import.meta.url).href)};
      import {createInputLease} from ${JSON.stringify(new URL('./input-lease.mjs', import.meta.url).href)};
      const run=args=>new Promise((resolve,reject)=>{const p=spawn('tmux',['-S',${JSON.stringify(socket)},...args],{stdio:['ignore','pipe','pipe']});let stdout='';p.stdout.on('data',x=>stdout+=x);p.stderr.resume();p.once('error',reject);p.once('close',code=>code===0?resolve({stdout}):reject(Error('tmux failed')));});
      const client=new TmuxClient({run}); const binding=(await client.discover()).find(b=>b.paneId===${JSON.stringify(f.binding.paneId)});
      await createInputLease({run,binding,identity:client.identities.get(binding.paneId),verify:()=>client.binding(binding.paneId,${JSON.stringify(CHAT)})});
      process.send({ready:true});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.resume(); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`Owned lease parent exited before readiness: ${code}`))); });
    if (both) { const helper = await f.helper(); assert.equal(await linuxProcessStart(helper.pid), helper.start); process.kill(helper.pid, 'SIGKILL'); }
    child.kill('SIGKILL');
    await f.restored(); assert.equal(await readFile(f.received, 'utf8'), '');
  });
});

test('Linux tmux lease rechecks after a user hook and preserves a pipe installed during that hook', { skip: !available }, async t => {
  const f = await fixture(t); const socket = String((await f.run(['display-message', '-p', '#{socket_path}'])).stdout).trim();
  const hook = join(f.root, 'hook.sh');
  await writeFile(hook, '#!/bin/sh\ntmux -S "$1" set-hook -gu after-set-option\ntmux -S "$1" pipe-pane -O -t "$2" "cat >/dev/null"\n');
  const word = value => `'${value.replaceAll("'", "'\\''")}'`;
  await f.run(['set-hook', '-g', 'after-set-option', `run-shell ${word(`sh ${word(hook)} ${word(socket)} ${word(f.binding.paneId)}`)}`]);
  await assert.rejects(f.acquire(), /already disabled/);
  assert.equal(await f.state(), '0|1|');
  assert.equal(await readFile(f.received, 'utf8'), '');
});

test('Linux tmux lease detects pipe replacement and never closes the replacement or presses Enter', { skip: !available }, async t => {
  const f = await fixture(t); const lease = await f.acquire();
  await f.run(['pipe-pane', '-I', '-t', f.binding.paneId, 'sleep 15']);
  await assert.rejects(lease.submit(), error => error.inputSubmissionUnknown === true);
  await assert.rejects(lease.release(), /restoration/);
  assert.match(await f.state(), /^1\|1\|[a-f0-9]{48}$/);
  assert.equal(await readFile(f.received, 'utf8'), '');
});
