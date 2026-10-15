import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMaintenanceGate } from './maintenance.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-maintenance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'maintenance');
  const gate = createMaintenanceGate({ file, locks: () => [], isBusy: () => false, ...options });
  return { file, gate };
}

test('maintenance blocks admission and recovers when a failed installer removes its marker', async t => {
  const { file, gate } = await fixture(t);
  await gate.assertOpen();
  await assert.rejects(gate.quiesce(), /installer marker/);
  await fs.writeFile(file, 'maintenance');
  await assert.rejects(gate.assertOpen(), { code: -32002 });
  assert.deepEqual(await gate.quiesce(), { idle: true, protocol: 1 });
  await fs.unlink(file); await gate.assertOpen();
});

test('quiesce waits for accepted requests and rejects if they have started an active turn', async t => {
  let release, active = false;
  const pending = new Promise(resolve => { release = () => { active = true; resolve(); }; });
  const { file, gate } = await fixture(t, { locks: () => [pending], isBusy: () => active });
  await fs.writeFile(file, 'maintenance');
  const result = gate.quiesce();
  release();
  await assert.rejects(result, /active turn/);
  await assert.rejects(gate.assertOpen(), { code: -32002 });
});

test('pending requests prevent maintenance from hanging indefinitely', async t => {
  const { file, gate } = await fixture(t, { locks: () => [new Promise(() => {})], drainTimeoutMs: 5 });
  await fs.writeFile(file, 'maintenance');
  await assert.rejects(gate.quiesce(), /still pending/);
});
