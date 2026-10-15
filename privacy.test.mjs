import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function syntheticUuid(value) {
  const segments = value.toLowerCase().split('-');
  return new Set(segments[0]).size === 1 && new Set(segments[4]).size === 1;
}

function allowedAddress(value) {
  const parts = value.split('.').map(Number);
  // A dotted software version with out-of-range components is not IPv4.
  if (parts.some(part => part > 255)) return true;
  return parts[0] === 127 || parts.every(part => part === 0)
    || parts.slice(0, 3).join('.') === '192.0.2'
    || parts.slice(0, 3).join('.') === '198.51.100'
    || parts.slice(0, 3).join('.') === '203.0.113';
}

test('static test fixtures use synthetic IDs and reserved addresses', async () => {
  const files = [];
  for (const [directory, matches] of [
    ['', name => name.endsWith('.test.mjs')],
    ['installer', name => name.includes('test')],
  ]) {
    let entries;
    try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); }
    catch { assert.fail(`Cannot list test fixtures: ${directory || '.'}`); }
    for (const entry of entries) {
      // Never follow symlinks into data outside the repository.
      if (entry.isFile() && matches(entry.name)) files.push(path.join(directory, entry.name));
    }
  }

  const violations = [];
  for (const file of files.sort()) {
    let source;
    try { source = await readFile(path.join(root, file), 'utf8'); }
    catch { assert.fail(`Cannot read test fixture: ${file}`); }
    const ids = source.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || [];
    const addresses = source.match(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g) || [];
    if (ids.some(value => !syntheticUuid(value)) || addresses.some(value => !allowedAddress(value))) violations.push(file);
  }
  // Report filenames only; a failing fixture may contain private information.
  if (violations.length) assert.fail(`Replace private test fixtures in: ${violations.join(', ')}`);
});
