import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CursorSession } from './cursor.mjs';

// A separate executable exercises real stdio, process exits, and delayed server requests.
const mockSource = `#!${process.execPath}
import readline from 'node:readline';
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['acp']);
const scenario = process.env.CURSOR_TEST_SCENARIO;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\\n');
const reply = (id, result) => send({id, result});
let stage = 0;
let promptId;
let permissionResult;
const models = { currentModelId:'composer-2.5[fast=true]', availableModels:[{modelId:'composer-2.5[fast=true]',name:'composer-2.5'},{modelId:'auto-smart[optimize_for=balanced]',name:'Auto Balance'}] };
readline.createInterface({input:process.stdin}).on('line', async line => {
  const m=JSON.parse(line);
  if (m.method==='initialize') {
    assert.equal(stage++,0);
    assert.equal(m.params.protocolVersion,1);
    assert.deepEqual(m.params.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false});
    if (scenario==='exit-init') return process.exit(7);
    return reply(m.id,{protocolVersion:1,authMethods:[{id:'cursor_login'}]});
  }
  if (m.method==='authenticate') {
    assert.equal(stage++,1);
    assert.equal(m.params.methodId,'cursor_login');
    return reply(m.id,{});
  }
  if (m.method==='session/new' || m.method==='session/load') {
    assert.equal(stage++,2);
    assert.deepEqual(m.params.mcpServers,[]);
    if (m.method==='session/load') {
      assert.equal(m.params.sessionId,'existing-session');
      send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'replay'}}}});
    }
    process.stderr.write('SECRET_TOKEN_SHOULD_NEVER_APPEAR_IN_LOGS');
    return reply(m.id,{...(m.method==='session/new'?{sessionId:'new-session'}:{}),models,modes:{currentModeId:'agent',availableModes:[{id:'agent',name:'Agent'}]}});
  }
  if (m.method==='session/set_config_option') {
    if (scenario==='legacy-model') return send({id:m.id,error:{code:-32601,message:'Method not found'}});
    if (scenario==='reject-model') return send({id:m.id,error:{code:-32602,message:'Invalid model value'}});
    assert.equal(m.params.configId,'model');
    assert.equal(m.params.value,'auto-smart[optimize_for=balanced]');
    return reply(m.id,{configOptions:[{id:'model',currentValue:m.params.value}]});
  }
  if (m.method==='session/set_model') {
    assert.equal(scenario,'legacy-model');
    assert.equal(m.params.modelId,'auto-smart[optimize_for=balanced]');
    return reply(m.id,{});
  }
  if (m.method==='session/prompt') {
    assert.deepEqual(m.params.prompt,[{type:'text',text:'hello'}]);
    promptId=m.id;
    if (scenario==='exit-prompt') return process.exit(23);
    if (scenario==='malformed') return process.stdout.write('not-json\\n');
    if (scenario==='hang') return;
    if (scenario==='approval' || scenario==='unhandled' || scenario==='approval-timeout') {
      return send({id:0,method:'session/request_permission',params:{sessionId:'new-session',options:[{optionId:'allow-once',kind:'allow_once'},{optionId:'reject-once',kind:'reject_once'}],toolCall:{toolCallId:'tool-1',title:'Run command'}}});
    }
    const update={jsonrpc:'2.0',method:'session/update',params:{sessionId:'new-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好'}}}};
    const bytes=Buffer.from(JSON.stringify(update)+'\\n');
    const chinese=bytes.indexOf(Buffer.from('你'));
    process.stdout.write(bytes.subarray(0,chinese+1));
    await new Promise(r=>setTimeout(r,5));
    process.stdout.write(bytes.subarray(chinese+1));
    send({method:'cursor/update_todos',params:{todos:[]}});
    return reply(m.id,{stopReason:'end_turn'});
  }
  if (m.method==='session/cancel') return promptId && reply(promptId,{stopReason:'cancelled'});
  if (m.id===0) {
    permissionResult=m.result;
    if (scenario==='unhandled' || scenario==='approval-timeout') return reply(promptId,{stopReason:'cancelled',permissionResult});
    assert.deepEqual(m.result,{outcome:{outcome:'selected',optionId:'allow-once'}});
    return send({id:'question-1',method:'cursor/ask_question',params:{toolCallId:'question',questions:[{id:'q',prompt:'Which?',options:[]}]}});
  }
  if (m.id==='question-1') {
    assert.deepEqual(m.result,{outcome:{outcome:'answered',answers:[]}});
    return send({id:'plan-1',method:'cursor/create_plan',params:{toolCallId:'plan',plan:'Do this'}});
  }
  if (m.id==='plan-1') {
    assert.deepEqual(m.result,{outcome:{outcome:'rejected',reason:'test'}});
    return reply(promptId,{stopReason:'end_turn'});
  }
  throw Error('Unexpected request');
});
`;

async function setup(t, scenario = 'normal', options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-acp-test-'));
  const executable = join(dir, 'agent.mjs');
  await writeFile(executable, mockSource);
  await chmod(executable, 0o700);
  const logs = [];
  const session = new CursorSession({
    cwd: dir, agentPath: executable,
    env: { CURSOR_TEST_SCENARIO: scenario },
    log: message => logs.push(message),
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    ...options,
  });
  t.after(async () => {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { session, logs, dir };
}

test('handshake authenticates, exposes model data, and decodes split UTF-8 stream', async t => {
  const { session, logs } = await setup(t);
  const chunks = [];
  const notifications = [];
  session.on('update', (update, params) => {
    chunks.push(update.content.text);
    assert.equal(params.sessionId, 'new-session');
  });
  session.on('notification', value => notifications.push(value));
  const result = await session.start();
  assert.equal(result.sessionId, 'new-session');
  assert.equal(result.models.availableModels.length, 2);
  assert.equal(session.model, 'composer-2.5[fast=true]');
  assert.deepEqual(await session.prompt([{ type: 'text', text: 'hello' }]), { stopReason: 'end_turn' });
  assert.deepEqual(chunks, ['你好']);
  assert.equal(notifications[0].method, 'cursor/update_todos');
  assert.ok(logs.every(line => !line.includes('SECRET_TOKEN')));
});

test('the default agent executable resolves through the session PATH', async t => {
  const { session, dir } = await setup(t, 'normal', { agentPath: undefined });
  await symlink('agent.mjs', join(dir, 'agent'));
  session.env.PATH = dir;
  const result = await session.start();
  assert.equal(result.sessionId, 'new-session');
  assert.deepEqual(await session.prompt([{ type: 'text', text: 'hello' }]), { stopReason: 'end_turn' });
});

test('loading preserves the given ID and relays replay updates before the load result', async t => {
  const { session } = await setup(t);
  const replay = [];
  session.on('update', update => replay.push(update.content.text));
  const result = await session.start({ sessionId: 'existing-session' });
  assert.equal(session.sessionId, 'existing-session');
  assert.equal(result.sessionId, 'existing-session');
  assert.deepEqual(replay, ['replay']);
});

test('model aliases resolve to the advertised variant using session config', async t => {
  const { session } = await setup(t, 'normal', { model: 'auto' });
  const result = await session.start();
  assert.equal(session.model, 'auto-smart[optimize_for=balanced]');
  assert.equal(result.models.currentModelId, session.model);
  assert.equal(result.configOptions[0].currentValue, session.model);
});

test('model changes fall back only when session config is unsupported', async t => {
  const { session } = await setup(t, 'legacy-model');
  await session.start();
  await session.setModel('auto');
  assert.equal(session.model, 'auto-smart[optimize_for=balanced]');
});

test('invalid model errors propagate without pretending a different model was selected', async t => {
  const { session } = await setup(t, 'reject-model');
  await session.start();
  await assert.rejects(session.setModel('auto'), { code: -32602, method: 'session/set_config_option' });
  assert.equal(session.model, 'composer-2.5[fast=true]');
});

test('permissions, questions, and plans block until the caller responds exactly once', async t => {
  const { session } = await setup(t, 'approval');
  await session.start();
  const permissionEvent = once(session, 'permission');
  const requests = [];
  session.on('request', request => {
    requests.push(request.method);
    if (request.method === 'cursor/ask_question') request.respond({ outcome: { outcome: 'answered', answers: [] } });
    else request.respond({ outcome: { outcome: 'rejected', reason: 'test' } });
  });
  let completed = false;
  const pending = session.prompt([{ type: 'text', text: 'hello' }]).then(value => { completed = true; return value; });
  const [permission] = await permissionEvent;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(completed, false);
  assert.equal(permission.id, 0);
  assert.equal(permission.respond({ outcome: { outcome: 'selected', optionId: 'allow-once' } }), true);
  assert.equal(permission.respond({ outcome: { outcome: 'selected', optionId: 'allow-always' } }), false);
  assert.deepEqual(await pending, { stopReason: 'end_turn' });
  assert.deepEqual(requests, ['cursor/ask_question', 'cursor/create_plan']);
});

test('an unattended permission is cancelled and never approved', async t => {
  const { session } = await setup(t, 'unhandled');
  await session.start();
  const result = await session.prompt([{ type: 'text', text: 'hello' }]);
  assert.deepEqual(result.permissionResult, { outcome: { outcome: 'cancelled' } });
});

test('an expired approval is cancelled and late replies cannot approve it', async t => {
  const { session } = await setup(t, 'approval-timeout', { permissionTimeoutMs: 25 });
  let respond;
  session.on('permission', request => { respond = request.respond; });
  await session.start();
  const result = await session.prompt([{ type: 'text', text: 'hello' }]);
  assert.deepEqual(result.permissionResult, { outcome: { outcome: 'cancelled' } });
  assert.equal(respond({ outcome: { outcome: 'selected', optionId: 'allow-once' } }), false);
});

test('an unexpected exit rejects in-flight initialization and prompts', async t => {
  const first = await setup(t, 'exit-init');
  await assert.rejects(first.session.start(), { code: 'ERR_CURSOR_EXIT' });
  const second = await setup(t, 'exit-prompt');
  await second.session.start();
  await assert.rejects(second.session.prompt([{ type: 'text', text: 'hello' }]), { code: 'ERR_CURSOR_EXIT' });
});

test('malformed protocol data rejects the active prompt and closes the process', async t => {
  const { session } = await setup(t, 'malformed');
  await session.start();
  await assert.rejects(session.prompt([{ type: 'text', text: 'hello' }]), { code: 'ERR_CURSOR_PROTOCOL' });
});

test('prompt timeout cancels work and fails the session instead of leaving a background run', async t => {
  const { session } = await setup(t, 'hang', { promptTimeoutMs: 30 });
  await session.start();
  await assert.rejects(session.prompt([{ type: 'text', text: 'hello' }]), { code: 'ERR_CURSOR_TIMEOUT' });
  assert.equal(session.state, 'failed');
});

test('concurrent prompts are rejected and cancel sends the ACP notification', async t => {
  const { session } = await setup(t, 'hang');
  await session.start();
  const pending = session.prompt([{ type: 'text', text: 'hello' }]);
  await assert.rejects(session.prompt([{ type: 'text', text: 'hello' }]), { code: 'ERR_CURSOR_BUSY' });
  assert.equal(session.cancel(), true);
  assert.deepEqual(await pending, { stopReason: 'cancelled' });
});

test('close rejects outstanding work and is idempotent', async t => {
  const { session } = await setup(t, 'hang');
  await session.start();
  const rejected = assert.rejects(session.prompt([{ type: 'text', text: 'hello' }]), { code: 'ERR_CURSOR_CLOSED' });
  await session.close();
  await rejected;
  await session.close();
  assert.equal(session.state, 'closed');
  await assert.rejects(session.start(), { code: 'ERR_CURSOR_CLOSED' });
});

test('spawn failures reject start without requiring an EventEmitter error listener', async t => {
  const { session } = await setup(t, 'normal', { agentPath: '/nonexistent/cursor-agent-test' });
  await assert.rejects(session.start(), { code: 'ERR_CURSOR_SPAWN' });
});
