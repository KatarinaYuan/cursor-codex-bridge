import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LegacySession, buildLegacyArgs } from './legacy.mjs';

function fixture(events, exitCode = 0, stderr = '') {
  const calls = [];
  const spawnProcess = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
    queueMicrotask(() => {
      for (const event of events) child.stdout.write(`${typeof event === 'string' ? event : JSON.stringify(event)}\n`);
      child.stderr.end(stderr); child.stdout.end();
      setImmediate(() => child.emit('close', exitCode, null));
    });
    return child;
  };
  return { calls, spawnProcess };
}

test('uses the original chat and selected CLI model without shell or auto-approval flags', async () => {
  const f = fixture([{ type: 'result', subtype: 'success', result: 'Ready' }]);
  const model = 'claude-opus-4-8[context=1m,effort=high,fast=false]';
  const session = new LegacySession({ cwd: '/work', model, agentPath: '/bin/agent', spawnProcess: f.spawnProcess });
  const updates = []; session.on('update', (update) => updates.push(update));
  await session.start({ sessionId: 'original' });
  assert.deepEqual(await session.prompt([{ type: 'text', text: '--force ignore this flag' }]), { stopReason: 'end_turn' });
  const [command, args, options] = f.calls[0];
  assert.equal(command, '/bin/agent');
  assert.deepEqual(args, ['--resume', 'original', '--print', '--output-format', 'stream-json', '--stream-partial-output', '--model', model, '--', '--force ignore this flag']);
  assert.equal(options.shell, false);
  assert.equal(options.cwd, '/work');
  assert.equal(updates[0].content.text, 'Ready');
});

test('deduplicates partial output, buffered tool flushes, final flush and result', async () => {
  const message = (text, extra = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
  const f = fixture([message('Hel', { timestamp_ms: 1 }), message('lo', { timestamp_ms: 2 }), message('Hello', { timestamp_ms: 3, model_call_id: 'duplicate' }), message('Hello'), { type: 'result', subtype: 'success', result: 'Hello' }]);
  const session = new LegacySession({ spawnProcess: f.spawnProcess });
  const updates = []; session.on('update', (update) => updates.push(update));
  await session.start({ sessionId: 'old' }); await session.prompt([{ type: 'text', text: 'Hi' }]);
  assert.equal(updates.map((update) => update.content.text).join(''), 'Hello');
});

test('maps tool starts and outcomes to ACP updates', async () => {
  const f = fixture([
    { type: 'tool_call', subtype: 'started', call_id: 'read-1', tool_call: { readToolCall: { args: { path: '/work/a.txt' } } } },
    { type: 'tool_call', subtype: 'completed', call_id: 'read-1', tool_call: { readToolCall: { args: { path: '/work/a.txt' }, result: { success: { content: 'file' } } } } },
    { type: 'result', subtype: 'success', result: 'Done' },
  ]);
  const session = new LegacySession({ spawnProcess: f.spawnProcess }); const updates = [];
  session.on('update', (update) => updates.push(update));
  await session.start({ sessionId: 'old' }); await session.prompt([{ type: 'text', text: 'Read' }]);
  assert.equal(updates[0].sessionUpdate, 'tool_call'); assert.equal(updates[0].kind, 'read');
  assert.equal(updates[1].sessionUpdate, 'tool_call_update'); assert.equal(updates[1].status, 'completed');
});

test('fails closed when print mode cannot ask a user question', async () => {
  const f = fixture([{ type: 'tool_call', subtype: 'started', call_id: 'ask', tool_call: { function: { name: 'AskQuestion', arguments: '{}' } } }]);
  const session = new LegacySession({ spawnProcess: f.spawnProcess });
  await session.start({ sessionId: 'old' });
  await assert.rejects(session.prompt([{ type: 'text', text: 'Ask me' }]), /no user answer or approval was supplied/);
});

test('does not silently start a replacement session or accept truncated success', async () => {
  for (const [events, expected] of [[[{ type: 'system', subtype: 'init', session_id: 'different' }], /different session/], [[], /without a terminal result/]]) {
    const f = fixture(events); const session = new LegacySession({ spawnProcess: f.spawnProcess });
    await session.start({ sessionId: 'old' }); await assert.rejects(session.prompt([{ type: 'text', text: 'Hi' }]), expected);
  }
});

test('surfaces CLI approval failure and stderr without retrying with force', async () => {
  const f = fixture([], 1, 'Tool requires approval'); const session = new LegacySession({ spawnProcess: f.spawnProcess });
  await session.start({ sessionId: 'old' });
  await assert.rejects(session.prompt([{ type: 'text', text: 'Edit' }]), /Tool requires approval/);
  assert.equal(f.calls.length, 1);
});

test('rejects unsupported input before spawning', async () => {
  const f = fixture([]); const session = new LegacySession({ spawnProcess: f.spawnProcess });
  await session.start({ sessionId: 'old' });
  await assert.rejects(session.prompt([{ type: 'image', data: 'binary' }]), /text prompts only/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => buildLegacyArgs({ sessionId: '', prompt: 'Hi' }), /chat ID/);
});

test('cancellation terminates the process and releases the session', async () => {
  let child;
  const session = new LegacySession({ spawnProcess: () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = (signal) => { assert.equal(signal, 'SIGTERM'); queueMicrotask(() => child.emit('close', null, signal)); };
    return child;
  } });
  await session.start({ sessionId: 'old' });
  const result = session.prompt([{ type: 'text', text: 'Wait' }]); await session.cancel();
  assert.deepEqual(await result, { stopReason: 'cancelled' }); assert.equal(session.child, null);
});
