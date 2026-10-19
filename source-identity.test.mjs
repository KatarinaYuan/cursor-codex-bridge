import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { SOURCE_IDENTITY_SCHEME, timestampedUserEnvelope, isRuntimeContext, unwrapUserEnvelope } from './source-identity.mjs';

const stamp = 'Monday, Oct 19, 2026, 3:38 AM (UTC)';
const envelope = (query, timestamp = stamp) => `<timestamp>${timestamp}</timestamp>\n<user_query>${query}</user_query>`;
const attachment = '<manually_attached_skills>\nThe user has manually attached the following skills to their message.\nThese skills contain specific instructions or workflows that the user wants you to follow for this request.\nOnly read the files if needed, the full skill content is inlined here.\n\nSkill Name: example\nPath: /example/skills/example/SKILL.md\nSKILL.md content:\n# Example skill\nFollow the requested workflow.\n</manually_attached_skills>\n';
const catalog = [
  '<available_subagent_types>\nAvailable subagent_types and a quick description of what they do:\n- explore: Explore files.\n</available_subagent_types>',
  '<available_subagent_models>\nIf the user explicitly asks for the model of a subagent/task, you may ONLY use model slugs from this list:\n- inherit (default)\n</available_subagent_models>',
  '<dynamic_tool_catalog>\nThese dynamic tool namespaces were available when this conversation started. Availability may have changed, so use `GetDynamicTools` to check current state before calling `CallDynamicTool`.\n<dynamic_tool_namespaces>\n<namespace name="example" tools="Read" namespaceUseInstructions="Inspect the source.\n- Keep all text." source="native" />\n</dynamic_tool_namespaces>\n</dynamic_tool_catalog>',
].join('\n\n');

test('shared display unwrapping requires a whole wrapper and preserves literal nested tags', () => {
  const query = 'Explain </user_query> and <user_query> literally';
  assert.equal(unwrapUserEnvelope(envelope(query)), query);
  assert.equal(unwrapUserEnvelope('<timestamp>today</timestamp>\n<user_query>\n  Legacy\n</user_query>'), 'Legacy');
  assert.equal(unwrapUserEnvelope('<user_query>\n  Legacy\n</user_query>'), 'Legacy');
  for (const literal of ['Explain <user_query>literal</user_query> then continue',
    'before ' + envelope('Inside'), '<timestamp>timestamp only</timestamp>\nPreserve this']) {
    assert.equal(unwrapUserEnvelope(literal), literal);
  }
});

test('complete CLI attached-skill prefixes preserve the underlying envelope identity', () => {
  const text = envelope('\n  Request with skills\n');
  assert.deepEqual(timestampedUserEnvelope(attachment + text, 'chat'), timestampedUserEnvelope(text, 'chat'));
  assert.equal(unwrapUserEnvelope(attachment + text), 'Request with skills');
  assert.equal(unwrapUserEnvelope(attachment + '<user_query>Legacy request</user_query>'), 'Legacy request');
  assert.equal(timestampedUserEnvelope(attachment + '<user_query>Legacy request</user_query>', 'chat'), null);
});

test('literal, incomplete and mixed attached-skill prefixes never extract a later query', () => {
  const text = envelope('Keep the complete message');
  for (const raw of [
    attachment.replace('The user has manually attached the following skills to their message.', 'Explain this literal attachment:') + text,
    attachment.replace('Path: /example/skills/example/SKILL.md\n', '') + text,
    attachment.replace('</manually_attached_skills>', '') + text,
    attachment + 'Another instruction before the query\n' + text,
  ]) {
    assert.equal(timestampedUserEnvelope(raw, 'chat'), null);
    assert.equal(unwrapUserEnvelope(raw), raw);
  }
});

test('envelope identity preserves exact timestamp and query independently of surrounding separators', () => {
  assert.equal(SOURCE_IDENTITY_SCHEME, 'cursor-envelope-v1');
  const raw = '\n  Continue\n';
  const first = timestampedUserEnvelope(envelope(raw), 'chat');
  const spaced = timestampedUserEnvelope(`  <timestamp>${stamp}</timestamp>\n\n<user_query>${raw}</user_query>\n`, 'chat');
  assert.equal(first.query, raw);
  assert.equal(first.timestamp, stamp);
  assert.equal(first.timestampMinute, Date.UTC(2026, 9, 19, 3, 38));
  assert.equal(first.sha256, spaced.sha256);
  assert.match(first.sha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(first.sha256, timestampedUserEnvelope(envelope(raw, 'Monday, Oct 19, 2026, 3:39 AM (UTC)'), 'chat').sha256);
  assert.notEqual(first.sha256, timestampedUserEnvelope(envelope(raw), 'other-chat').sha256);
  assert.notEqual(first.sha256, timestampedUserEnvelope(envelope(raw.trim()), 'chat').sha256);
});

test('CLI UTC timestamp metadata is independent of the reader timezone', () => {
  const moduleUrl = new URL('./source-identity.mjs', import.meta.url).href;
  const script = `import { timestampedUserEnvelope } from ${JSON.stringify(moduleUrl)}; process.stdout.write(String(timestampedUserEnvelope(${JSON.stringify(envelope('Continue'))}, 'chat').timestampMinute));`;
  for (const timezone of ['Asia/Shanghai', 'America/Los_Angeles']) {
    const value = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: timezone } });
    assert.equal(Number(value), Date.UTC(2026, 9, 19, 3, 38));
  }
});

test('invalid, partial and mixed user envelopes remain legacy text', () => {
  for (const text of ['Continue', envelope('Continue', 'not a timestamp'), envelope('Continue') + ' trailing',
    '<timestamp>' + stamp + '</timestamp>\n<user_query>missing close', '<user_query>Continue</user_query>']) {
    assert.equal(timestampedUserEnvelope(text, 'chat'), null);
  }
});

test('only a complete known runtime context is recognized', () => {
  assert.equal(isRuntimeContext(catalog), true);
  assert.equal(isRuntimeContext('\n' + catalog + '\n'), true);
  const negatives = [
    'Explain ' + catalog, catalog + '\nDo this next.', envelope(catalog),
    catalog.replace('</dynamic_tool_catalog>', ''),
    catalog.replace('<available_subagent_types>', '<available_subagent_types><available_subagent_types>'),
    catalog.replace('Available subagent_types and a quick description of what they do:', 'Here are some tags:'),
    catalog.replace('</dynamic_tool_namespaces>', ''),
    catalog.replace('source="native"', ''),
    catalog.replace('source="native"', 'name="duplicate"'),
    catalog.replace('<namespace name="example"', 'literal text <namespace name="example"'),
    catalog.replace('source="native" />', 'source="native" >'),
    catalog.replace('namespaceUseInstructions="Inspect the source.\n- Keep all text."', 'namespaceUseInstructions=""'),
    catalog.replace('</available_subagent_models>', '</available_subagent_models>\n<user_query>real</user_query>'),
    '<available_subagent_types>literal example</available_subagent_types>',
  ];
  for (const text of negatives) assert.equal(isRuntimeContext(text), false);
});
