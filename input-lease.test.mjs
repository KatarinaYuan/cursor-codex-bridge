import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireLeaseArguments, releaseLeaseArguments, leaseCondition, INPUT_LEASE_OPTION } from './input-lease.mjs';

const config = { paneId: '%7', panePid: 123, owner: 'a'.repeat(48), configPath: "/tmp/private 'quoted'/config.json" };

test('acquisition is one tmux format-condition queue and never uses destructive pipe -o', () => {
  const args = acquireLeaseArguments(config, '/runtime/helper.mjs');
  assert.deepEqual(args.slice(0, 4), ['if-shell', '-F', '-t', '%7']);
  for (const condition of ['#{pane_id},%7', '#{pane_pid},123', '#{pane_dead},0', '#{pane_in_mode},0', '#{pane_input_off},0', '#{pane_pipe},0', `#{${INPUT_LEASE_OPTION}},`]) assert.ok(args[4].includes(condition), condition);
  assert.match(args[5], /select-pane -d -t %7 ; pipe-pane -I -t %7/);
  assert.match(args[5], /set-option[^;]+; if-shell -F -t %7/);
  assert.ok(args[5].includes(`#{${INPUT_LEASE_OPTION}},${config.owner}`));
  assert.ok(!args[5].includes('pipe-pane -o'));
  assert.ok(args[5].includes("\\'"), 'Config paths are shell quoted twice for the tmux command and its helper shell');
  assert.equal(args[6], 'display-message -p cursor-input-lease-unavailable');
});

test('restoration never closes an unknown pipe and changes input only with exact owner and no current pipe', () => {
  const args = releaseLeaseArguments(config);
  assert.match(args[4], /pane_pipe},0/);
  assert.ok(args[4].includes(`#{${INPUT_LEASE_OPTION}},${config.owner}`));
  assert.match(args[4], /pane_input_off},1/);
  assert.match(args[5], /select-pane -e -t %7/);
  assert.match(args[5], /set-option -pu -t %7 @cursor_bridge_input_lease/);
  assert.ok(!args.some(arg => arg.includes('pipe-pane')));
});

test('active lease condition is bound to pane and process rather than the presence of any pipe', () => {
  const condition = leaseCondition(config);
  assert.ok(condition.includes('#{pane_pid},123'));
  assert.ok(condition.includes(config.owner));
  assert.ok(condition.includes('#{pane_input_off},1'));
});
