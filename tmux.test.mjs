import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, unlink, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TmuxClient } from './tmux.mjs';

const CHAT = '11111111-2222-4333-8444-555555555555';
const OTHER = '22222222-3333-4444-8555-666666666666';
const database = (session = CHAT) => `/home/testuser/.cursor/chats/cwd-hash/${session}/store.db`;

function stat(pid, ppid, { start = '100', pgrp = 20, foreground = pgrp, tty = 123, name = 'agent (main)', state = 'S' } = {}) {
  const fields = [state, ppid, pgrp, 10, tty, foreground, ...Array(13).fill(0), start];
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cursor-tmux-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const procRoot = join(root, 'proc'); await mkdir(procRoot);
  const f = { root, procRoot, calls: [], paneLines: '%1|10|0|0|/work\n' };
  f.process = async (pid, ppid, stores = [], options) => {
    await mkdir(join(procRoot, String(pid), 'fd'), { recursive: true });
    await writeFile(join(procRoot, String(pid), 'stat'), stat(pid, ppid, options));
    await symlink('/work', join(procRoot, String(pid), 'cwd'));
    for (const [index, path] of stores.entries()) await symlink(path, join(procRoot, String(pid), 'fd', String(index + 3)));
  };
  f.run = async (args, options = {}) => {
    f.calls.push({ args, ...options });
    if (f.onRun) await f.onRun(args, options);
    return { stdout: args[0] === 'list-panes' ? f.paneLines : args[0] === 'capture-pane' ? '\u001b[48;5;236m› 草稿\u001b[0m\n' : '', stderr: '' };
  };
  await f.process(10, 1, [], { pgrp: 10, foreground: 20 });
  await f.process(20, 10, [database()]);
  f.client = new TmuxClient({ procRoot, run: f.run });
  return f;
}

async function pastedFixture(t) {
  const f = await fixture(t);
  f.storePath = join(f.root, '.cursor', 'chats', 'cwd-hash', CHAT, 'store.db');
  f.pastedTextPath = join(dirname(f.storePath), 'pasted_text.json');
  await mkdir(dirname(f.storePath), { recursive: true });
  await writeFile(f.storePath, 'mock Cursor database');
  await unlink(join(f.procRoot, '20', 'fd', '3'));
  await symlink(f.storePath, join(f.procRoot, '20', 'fd', '3'));
  return f;
}

test('discovers only exact store.db descriptors in a pane process tree', async (t) => {
  const f = await fixture(t);
  await f.process(30, 1, [database(OTHER)]);
  await f.process(21, 20, [database(), `${database(OTHER)}-wal`, '/home/testuser/.cursor/chats/cwd-hash/not-a-uuid/store.db']);
  await mkdir(join(f.procRoot, 'not-a-pid'));
  assert.deepEqual(await f.client.discover(), [{ paneId: '%1', panePid: 10, agentPid: 20, agentStartTime: '100', cwd: '/work', sessionId: CHAT }]);
  assert.deepEqual(f.calls[0].args, ['list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}|#{pane_in_mode}|#{pane_dead}|#{pane_current_path}']);
});

test('does not guess a session from cwd or accept deleted, partial or ambiguous database paths', async (t) => {
  const f = await fixture(t);
  await f.process(21, 20, [database(OTHER)]);
  assert.deepEqual(await f.client.discover(), []);
  await rm(join(f.procRoot, '21'), { recursive: true });
  await unlink(join(f.procRoot, '20', 'fd', '3'));
  await symlink(`${database()} (deleted)`, join(f.procRoot, '20', 'fd', '3'));
  assert.deepEqual(await f.client.discover(), []);
  await unlink(join(f.procRoot, '20', 'fd', '3'));
  assert.deepEqual(await f.client.discover(), []);
});

test('captures ANSI by default and optionally plain text without interpreting pane arguments', async (t) => {
  const f = await fixture(t);
  assert.match(await f.client.capture('%1'), /\u001b\[48/);
  await f.client.capture('%1', { escapes: false });
  assert.deepEqual(f.calls.map(({ args }) => args), [
    ['capture-pane', '-p', '-e', '-J', '-S', '-500', '-t', '%1'],
    ['capture-pane', '-p', '-J', '-S', '-500', '-t', '%1'],
  ]);
  await assert.rejects(f.client.capture('%1; touch /tmp/injected'), /pane ID/);
});

test('pastes literal Unicode and multiline input through a unique private stdin buffer', async (t) => {
  const f = await fixture(t);
  const text = '中文 👩🏽‍💻\n$(touch /tmp/not-executed) `date` "quotes" ; --force';
  await f.client.paste('%1', text, { sessionId: CHAT });
  const mutations = f.calls.filter(({ args }) => args[0] !== 'list-panes');
  const buffer = mutations[0].args[2];
  assert.match(buffer, /^cursor_bridge_[a-f0-9]{32}$/);
  assert.deepEqual(mutations, [
    { args: ['load-buffer', '-b', buffer, '-'], input: text },
    { args: ['paste-buffer', '-p', '-d', '-b', buffer, '-t', '%1'] },
    { args: ['send-keys', '-t', '%1', 'Enter'] },
    { args: ['delete-buffer', '-b', buffer] },
  ]);
  await f.client.paste('%1', 'second prompt', { sessionId: CHAT });
  assert.notEqual(f.calls.filter(({ args }) => args[0] === 'load-buffer')[1].args[2], buffer);
});

test('cleans its private buffer after load or paste failure and never presses Enter', async (t) => {
  for (const failing of ['load-buffer', 'paste-buffer']) {
    const f = await fixture(t);
    f.onRun = async (args) => { if (args[0] === failing) throw new Error(`mock ${failing} failure`); };
    await assert.rejects(f.client.paste('%1', 'hello', { sessionId: CHAT }), /mock .* failure/);
    assert.equal(f.calls.filter(({ args }) => args[0] === 'delete-buffer').length, 1);
    assert.equal(f.calls.some(({ args }) => args[0] === 'send-keys'), false);
  }
});

test('runs asynchronous guards next to paste and Enter and stops after guard rejection', async (t) => {
  for (const failing of ['beforePaste', 'afterPaste', null]) {
    const f = await fixture(t);
    const guard = (name) => async () => {
      await Promise.resolve();
      f.calls.push({ args: [name] });
      if (failing === name) throw new Error(`rejected ${name}`);
    };
    const attempt = f.client.paste('%1', 'hello', { sessionId: CHAT, beforePaste: guard('beforePaste'), afterPaste: guard('afterPaste') });
    if (failing) await assert.rejects(attempt, new RegExp(`rejected ${failing}`));
    else await attempt;
    const sequence = f.calls.map(({ args }) => args[0]).filter((command) => command !== 'list-panes');
    assert.deepEqual(sequence, failing === 'beforePaste'
      ? ['load-buffer', 'beforePaste', 'delete-buffer']
      : failing === 'afterPaste'
        ? ['load-buffer', 'beforePaste', 'paste-buffer', 'afterPaste', 'delete-buffer']
        : ['load-buffer', 'beforePaste', 'paste-buffer', 'afterPaste', 'send-keys', 'delete-buffer']);
  }
});

test('revalidates the exact session and process before pasting and before Enter', async (t) => {
  for (const changeAt of ['load-buffer', 'paste-buffer']) {
    const f = await fixture(t);
    f.onRun = async (args) => {
      if (args[0] === changeAt) {
        await unlink(join(f.procRoot, '20', 'fd', '3'));
        await symlink(database(OTHER), join(f.procRoot, '20', 'fd', '3'));
      }
    };
    await assert.rejects(f.client.paste('%1', 'hello', { sessionId: CHAT }), /session changed/);
    assert.equal(f.calls.some(({ args }) => args[0] === 'send-keys'), false);
    assert.equal(f.calls.filter(({ args }) => args[0] === 'delete-buffer').length, 1);
  }
  const f = await fixture(t);
  f.onRun = async (args) => {
    if (args[0] === 'load-buffer') await writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10, { start: '101' }));
  };
  await assert.rejects(f.client.paste('%1', 'hello', { sessionId: CHAT }), /session changed/);
  assert.equal(f.calls.some(({ args }) => args[0] === 'paste-buffer'), false);
});

test('does not bind an exited or zombie agent and rejects copy mode or nonforeground input', async (t) => {
  const f = await fixture(t);
  f.paneLines = '%1|10|1|0|/work\n';
  assert.equal((await f.client.discover()).length, 1);
  await assert.rejects(f.client.paste('%1', 'hello', { sessionId: CHAT }), /copy-mode/);
  assert.equal(f.calls.some(({ args }) => args[0] === 'load-buffer'), false);
  f.paneLines = '%1|10|0|0|/work\n';
  await writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10, { foreground: 30 }));
  await assert.rejects(f.client.cancel('%1', { sessionId: CHAT }), /foreground/);
  await writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10, { state: 'Z' }));
  assert.deepEqual(await f.client.discover(), []);
  await rm(join(f.procRoot, '20'), { recursive: true });
  assert.deepEqual(await f.client.discover(), []);
});

test('verifies cached identity without rescanning and pauses observation in copy mode or another foreground tty', async (t) => {
  const f = await fixture(t);
  const [binding] = await f.client.discover();
  const calls = f.calls.length;
  assert.equal(f.client.isVerified(binding), true);
  assert.equal(f.client.isVerified({ ...binding }), false);
  assert.equal(f.calls.length, calls);
  f.paneLines = '%1|10|1|0|/work\n';
  await f.client.discover();
  assert.equal(f.client.isVerified(binding), false);
  await assert.rejects(f.client.verifiedBinding(binding), /copy-mode/);
  f.paneLines = '%1|10|0|0|/work\n';
  const fresh = await f.client.verifiedBinding(binding);
  assert.equal(f.client.isVerified(fresh), true);
  await writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10, { tty: 456 }));
  await f.client.discover();
  assert.equal(f.client.isVerified(binding), false);
  await writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10));
  await writeFile(join(f.procRoot, '10', 'stat'), stat(10, 1, { pgrp: 10, foreground: 30 }));
  await f.client.discover();
  assert.equal(f.client.isVerified(binding), false);
  assert.equal(f.calls.some(({ args }) => args[0] === 'send-keys'), false);
});

test('cached and immediate verification detect reused agent and pane PIDs', async (t) => {
  for (const changedPid of [10, 20]) {
    const f = await fixture(t);
    const [binding] = await f.client.discover();
    await writeFile(join(f.procRoot, String(changedPid), 'stat'), changedPid === 10
      ? stat(10, 1, { pgrp: 10, foreground: 20, start: '101' })
      : stat(20, 10, { start: '101' }));
    const [replacement] = await f.client.discover();
    assert.equal(f.client.isVerified(binding), false);
    assert.equal(f.client.isVerified(replacement), true);
    await assert.rejects(f.client.verifiedBinding(binding), /binding changed/);
  }
});

test('reads exact saved paste strings only from its verified process database directory', async (t) => {
  const f = await pastedFixture(t);
  const entries = JSON.parse('{"7":"中文 👩🏽‍💻\\nline two\\n[Pasted text #9 +4 lines]","9":"literal $() and `quotes`","__proto__":"plain saved text"}');
  await writeFile(f.pastedTextPath, JSON.stringify({ entries, ignoredMetadata: true }));
  const [binding] = await f.client.discover();
  assert.deepEqual(await f.client.readPastedTexts(binding), { entries });
  assert.equal(f.calls.length, 3, 'Discovery is repeated both before and after the file read');
  assert.ok(f.calls.every(({ args }) => args[0] === 'list-panes'), 'Reading saved paste expansions must not send keys or change buffers');
});

test('missing paste stores return empty entries only for a still verified binding', async (t) => {
  const f = await pastedFixture(t);
  const [binding] = await f.client.discover();
  assert.deepEqual(await f.client.readPastedTexts(binding), { entries: {} });
  let scans = 0;
  f.onRun = async (args) => {
    if (args[0] === 'list-panes' && ++scans === 2) await writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10, { start: '101' }));
  };
  await assert.rejects(f.client.readPastedTexts(binding), /binding changed/);
  assert.ok(f.calls.every(({ args }) => args[0] === 'list-panes'));
});

test('saved paste reads reject forged, foreign, mutated, and ambiguous bindings', async (t) => {
  const f = await pastedFixture(t);
  await writeFile(f.pastedTextPath, JSON.stringify({ entries: { 1: 'original saved text' } }));
  const [binding] = await f.client.discover();
  await assert.rejects(f.client.readPastedTexts({ ...binding }), /binding returned by this TmuxClient/);
  const otherClient = new TmuxClient({ procRoot: f.procRoot, run: f.run });
  const [foreign] = await otherClient.discover();
  await assert.rejects(f.client.readPastedTexts(foreign), /binding returned by this TmuxClient/);
  binding.sessionId = OTHER;
  await assert.rejects(f.client.readPastedTexts(binding), /binding changed/);
  binding.sessionId = CHAT;
  await symlink(database(OTHER), join(f.procRoot, '20', 'fd', '4'));
  await assert.rejects(f.client.readPastedTexts(binding), /binding changed/);
  assert.ok(f.calls.every(({ args }) => args[0] === 'list-panes'));
});

test('saved paste reads reject identity, foreground, and pane changes occurring during the read', async (t) => {
  const changes = {
    'reused agent PID': async f => writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10, { start: '101' })),
    'reused pane PID': async f => writeFile(join(f.procRoot, '10', 'stat'), stat(10, 1, { pgrp: 10, foreground: 20, start: '101' })),
    'different session': async f => {
      await unlink(join(f.procRoot, '20', 'fd', '3'));
      await symlink(database(OTHER), join(f.procRoot, '20', 'fd', '3'));
    },
    'same session in a different database directory': async f => {
      await unlink(join(f.procRoot, '20', 'fd', '3'));
      await symlink(database(), join(f.procRoot, '20', 'fd', '3'));
    },
    'another foreground process': async f => writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10, { foreground: 30 })),
    'copy mode': async f => { f.paneLines = '%1|10|1|0|/work\n'; },
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async t => {
      const f = await pastedFixture(t);
      await writeFile(f.pastedTextPath, JSON.stringify({ entries: { 1: 'saved text' } }));
      const [binding] = await f.client.discover();
      let scans = 0;
      f.onRun = async args => { if (args[0] === 'list-panes' && ++scans === 2) await change(f); };
      await assert.rejects(f.client.readPastedTexts(binding), /binding changed/);
      assert.ok(f.calls.every(({ args }) => args[0] === 'list-panes'));
    });
  }
});

test('saved paste files require bounded UTF-8 JSON with a plain map of strings', async (t) => {
  const f = await pastedFixture(t);
  const [binding] = await f.client.discover();
  for (const content of ['not json', 'null', '[]', '{}', '{"entries":null}', '{"entries":[]}', '{"entries":{"1":false}}', '{"entries":{"1":{"text":"nested"}}}']) {
    await writeFile(f.pastedTextPath, content);
    await assert.rejects(f.client.readPastedTexts(binding));
  }
  await writeFile(f.pastedTextPath, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]));
  await assert.rejects(f.client.readPastedTexts(binding), /encoded data|encoding/i);
  await writeFile(f.pastedTextPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  await assert.rejects(f.client.readPastedTexts(binding), /8 MiB limit/);
  await unlink(f.pastedTextPath);
  await mkdir(f.pastedTextPath);
  await assert.rejects(f.client.readPastedTexts(binding), /regular file/);
  await rm(f.pastedTextPath, { recursive: true });
  const elsewhere = join(f.root, 'unrelated-pastes.json');
  await writeFile(elsewhere, JSON.stringify({ entries: { 1: 'not from this session directory' } }));
  await symlink(elsewhere, f.pastedTextPath);
  await assert.rejects(f.client.readPastedTexts(binding), { code: 'ELOOP' });
  assert.ok(f.calls.every(({ args }) => args[0] === 'list-panes'));
});

test('submitting a guarded existing draft sends one Enter without loading or pasting text', async (t) => {
  const f = await fixture(t);
  let guards = 0;
  await f.client.submitDraft('%1', { sessionId: CHAT, beforeSubmit: async () => { await Promise.resolve(); guards++; } });
  assert.equal(guards, 1);
  assert.deepEqual(f.calls.map(({ args }) => args[0]), ['list-panes', 'list-panes', 'send-keys']);
  assert.deepEqual(f.calls.at(-1).args, ['send-keys', '-t', '%1', 'Enter']);
});

test('draft submission requires its guard and never sends Enter after rejection or identity changes', async (t) => {
  const f = await fixture(t);
  for (const beforeSubmit of [undefined, null, true, 'guard']) {
    await assert.rejects(f.client.submitDraft('%1', { sessionId: CHAT, beforeSubmit }), /submission guard/);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.submitDraft('%1', { sessionId: CHAT, beforeSubmit: async () => { throw new Error('Draft differs from the failed paste'); } }), /Draft differs/);
  assert.equal(f.calls.some(({ args }) => args[0] === 'send-keys'), false);
  await assert.rejects(f.client.submitDraft('%1', {
    sessionId: CHAT,
    beforeSubmit: async () => writeFile(join(f.procRoot, '20', 'stat'), stat(20, 10, { start: '101' })),
  }), /session changed/);
  assert.ok(f.calls.every(({ args }) => args[0] === 'list-panes'));
});

test('missing tmux or an absent server yields no bindings and unknown failures clear cached trust', async (t) => {
  const f = await fixture(t);
  const [binding] = await f.client.discover();
  for (const error of [
    new Error('no server running on /tmp/tmux-0/default'),
    new Error('no sessions'),
    new Error('error connecting to /tmp/tmux-0/default (No such file or directory)'),
    Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }),
  ]) {
    f.onRun = () => { throw error; };
    assert.deepEqual(await f.client.discover(), []);
    assert.equal(f.client.isVerified(binding), false);
  }
  f.onRun = null;
  const [fresh] = await f.client.discover();
  assert.equal(f.client.isVerified(fresh), true);
  f.onRun = () => { throw new Error('unexpected permission failure'); };
  await assert.rejects(f.client.discover(), /unexpected permission/);
  assert.equal(f.client.isVerified(fresh), false);
});

test('rejects terminal control characters and malformed input before invoking tmux', async (t) => {
  const f = await fixture(t);
  for (const text of ['x\u001b[200~', 'x\r', 'x\t', 'x\u0000', 'x\u007f', 'x\u009b', 'x\ud800']) {
    await assert.rejects(f.client.paste('%1', text, { sessionId: CHAT }), /control characters/);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.paste('%1', '', { sessionId: CHAT }), /nonempty/);
  await assert.rejects(f.client.paste('%1', 'hello', {}), /UUID/);
});

test('cancel sends only Escape after revalidating the original session', async (t) => {
  const f = await fixture(t);
  await f.client.cancel('%1', { sessionId: CHAT });
  assert.deepEqual(f.calls.filter(({ args }) => args[0] !== 'list-panes'), [{ args: ['send-keys', '-t', '%1', 'Escape'] }]);
  await assert.rejects(f.client.cancel('%1', { sessionId: OTHER }), /session changed/);
  assert.equal(f.calls.filter(({ args }) => args[0] === 'send-keys').length, 1);
});

test('cancel accepts only a verified Escape or C-c key and never signals a process', async (t) => {
  const f = await fixture(t);
  for (const key of ['y', 'Enter', 'C-c; kill-server', '', null]) {
    await assert.rejects(f.client.cancel('%1', { sessionId: CHAT, key }), /stop key/);
  }
  assert.equal(f.calls.length, 0);
  await f.client.cancel('%1', { sessionId: CHAT, key: 'C-c' });
  assert.deepEqual(f.calls.filter(({ args }) => args[0] !== 'list-panes'), [{ args: ['send-keys', '-t', '%1', 'C-c'] }]);
});

test('the default runner executes tmux as an argv process and reports failures', async (t) => {
  const f = await fixture(t);
  const executable = join(f.root, 'fake tmux');
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\nif(process.argv.includes('%9')) { process.stderr.write('mock failure'); process.exitCode = 2; }\n`);
  await chmod(executable, 0o700);
  const client = new TmuxClient({ tmuxPath: executable, procRoot: f.procRoot });
  assert.deepEqual(JSON.parse(await client.capture('%1')), ['capture-pane', '-p', '-e', '-J', '-S', '-500', '-t', '%1']);
  await assert.rejects(client.capture('%9'), /mock failure/);
});

test('the default runner bounds combined stdout and stderr output', async (t) => {
  const f = await fixture(t);
  const executable = join(f.root, 'large-output-tmux');
  await writeFile(executable, '#!/bin/sh\nprintf 12345678901234567890\nprintf 12345678901234567890 >&2\n');
  await chmod(executable, 0o700);
  const client = new TmuxClient({ tmuxPath: executable, maxOutputBytes: 32 });
  await assert.rejects(client.capture('%1'), /32-byte output limit/);
});

test('the default runner times out and terminates only its own tmux client process', async (t) => {
  const f = await fixture(t);
  const executable = join(f.root, 'stalled-tmux'); const pidPath = join(f.root, 'tmux-pid');
  const quotedPidPath = `'${pidPath.replaceAll("'", "'\\''")}'`;
  await writeFile(executable, `#!/bin/sh\nprintf '%s' "$$" > ${quotedPidPath}\ntrap '' TERM\nwhile :; do :; done\n`);
  await chmod(executable, 0o700);
  const client = new TmuxClient({ tmuxPath: executable, commandTimeoutMs: 1_500 });
  await assert.rejects(client.capture('%1'), /timed out after 1500ms/);
  const pid = Number(await readFile(pidPath, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('The spawned tmux CLI client survived its timeout');
});
