import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));

async function genuineCodex() {
  const candidates = [
    process.env.CURSOR_BRIDGE_TEST_REAL_CODEX,
    process.env.CURSOR_BRIDGE_REAL_CODEX,
    ...String(process.env.PATH || '').split(delimiter).map(dir => join(dir, 'codex')),
  ].filter(Boolean);
  for (const executable of candidates) {
    try { await access(executable, constants.X_OK); return executable; } catch { /* Try the next installed CLI. */ }
  }
  return null;
}

const mockSource = `#!${process.execPath}
import assert from 'node:assert/strict';
import {appendFileSync,existsSync} from 'node:fs';
import readline from 'node:readline';
assert.deepEqual(process.argv.slice(2),['acp']);
const trace=(event)=>appendFileSync(process.env.CURSOR_TEST_TRACE,JSON.stringify(event)+'\\n');
trace({lifecycle:'started',pid:process.pid});
process.on('SIGTERM',()=>{
  trace({lifecycle:'terminated',pid:process.pid,signal:'SIGTERM'});
  process.exit(0);
});
process.on('exit',code=>trace({lifecycle:'exited',pid:process.pid,code}));
const send=(value)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const reply=(id,result)=>send({id,result});
let sessionId;
let pendingPrompt;
let expectedPermission;
const models={currentModelId:'composer-2.5[fast=true]',availableModels:[
  {modelId:'composer-2.5[fast=true]',name:'Composer 2.5'},
  {modelId:'gemini-4-argon[reasoning_effort=medium]',name:'Gemini 4 Argon'},
]};
const update=(value)=>send({method:'session/update',params:{sessionId,update:value}});
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  trace({method:m.method,id:m.id,params:m.params,result:m.result});
  if(m.method==='initialize')return reply(m.id,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login'}]});
  if(m.method==='authenticate'){
    assert.equal(m.params.methodId,'cursor_login');
    return reply(m.id,{});
  }
  if(m.method==='session/new'||m.method==='session/load'){
    sessionId=m.params.sessionId||'mock-session-'+process.pid;
    if(m.method==='session/new'&&existsSync(process.env.CURSOR_TEST_DELAY_FLAG)){
      trace({lifecycle:'session-new-delayed',pid:process.pid});
      return;
    }
    return reply(m.id,{sessionId,models,modes:{currentModeId:'agent',availableModes:[{id:'agent',name:'Agent'}]}});
  }
  if(m.method==='session/set_config_option'){
    assert.ok(models.availableModels.some(model=>model.modelId===m.params.value));
    models.currentModelId=m.params.value;
    return reply(m.id,{configOptions:[{id:'model',currentValue:m.params.value}]});
  }
  if(m.method==='cursor/list_available_models')return reply(m.id,{models:process.env.CURSOR_TEST_RICH_MODELS==='1'?[
    {value:'composer-2.5',name:'Composer 2.5',configOptions:[
      {id:'fast',name:'Fast',type:'select',options:[{value:'false',name:'Off'},{value:'true',name:'Fast'}]},
    ]},
  ]:[]});
  if(m.method==='session/prompt'){
    const text=m.params.prompt.filter(block=>block.type==='text').map(block=>block.text).join('\\n');
    if(text==='WAIT_FOR_INTERRUPT'){
      pendingPrompt=m.id;
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Waiting for current turn interrupt.'}});
      return;
    }
    if(text.includes('NEEDS_APPROVAL')){
      pendingPrompt=m.id;
      expectedPermission=text.includes('FOR_SESSION')?'allow-once':'reject-once';
      update({sessionUpdate:'tool_call',toolCallId:'permission-tool',title:'Delete mock file',kind:'execute',status:'pending',rawInput:{command:'delete mock file'}});
      return send({id:'permission-1',method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'permission-tool',title:'Delete mock file'},options:[{optionId:'allow-always',kind:'allow_always'},{optionId:'allow-once',kind:'allow_once'},{optionId:'reject-once',kind:'reject_once'}]}});
    }
    if(text==='NEEDS_QUESTION'){
      pendingPrompt=m.id;
      return send({id:'question-1',method:'cursor/ask_question',params:{toolCallId:'question-tool',questions:[
        {id:'deploy-target',prompt:'Choose a host',options:[{id:'target-linux',label:'Linux'},{id:'target-mac',label:'Mac'}]},
        {id:'checks',prompt:'Choose checks',allowMultiple:true,options:[{id:'check-build',label:'Build'},{id:'check-lint',label:'Lint'},{id:'check-test',label:'Tests'}]},
      ]}});
    }
    update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Inspecting mock context.'}});
    update({sessionUpdate:'plan',entries:[{content:'Answer from Cursor',status:'in_progress'}]});
    update({sessionUpdate:'tool_call',toolCallId:'read-tool',title:'Read mock context',kind:'read',status:'in_progress',rawInput:{path:'/mock/context'}});
    update({sessionUpdate:'tool_call_update',toolCallId:'read-tool',status:'completed',content:[{type:'content',content:{type:'text',text:'mock context'}}]});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Cursor says: '}});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
    return reply(m.id,{stopReason:'end_turn'});
  }
  if(m.method==='session/cancel')return pendingPrompt&&reply(pendingPrompt,{stopReason:'cancelled'});
  if(m.id==='permission-1'){
    assert.deepEqual(m.result,{outcome:{outcome:'selected',optionId:expectedPermission}});
    const accepted=expectedPermission==='allow-once';
    update({sessionUpdate:'tool_call_update',toolCallId:'permission-tool',status:accepted?'completed':'failed',content:[{type:'content',content:{type:'text',text:accepted?'Approved once':'User declined'}}]});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:accepted?'Action approved once.':'Action declined.'}});
    return reply(pendingPrompt,{stopReason:'end_turn'});
  }
  if(m.id==='question-1'){
    assert.deepEqual(m.result,{outcome:{outcome:'answered',answers:[
      {questionId:'deploy-target',selectedOptionIds:['target-linux']},
      {questionId:'checks',selectedOptionIds:['check-test','check-build']},
    ]}});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Selected options received.'}});
    return reply(pendingPrompt,{stopReason:'end_turn'});
  }
  throw Error('Unexpected mock ACP method '+m.method);
});
`;

class RpcClient extends EventEmitter {
  constructor(env) {
    super();
    this.messages = [];
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.child = spawn(process.execPath, [join(directory, 'cli.mjs'), 'app-server', '--listen', 'stdio://'], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-20_000); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return this.emit('protocolError', new Error(`Invalid bridge output: ${line}`)); }
      this.messages.push(message);
      this.emit('message', message);
      if (message.method || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else pending.resolve(message.result);
    });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.exit = { code, signal };
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Bridge exited: ${code ?? signal}\n${this.stderr}`));
      }
      this.pending.clear();
      this.emit('closed');
      resolve();
    }));
  }

  send(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}\n${this.stderr}`));
      }, 12_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  waitFor(predicate, since = 0) {
    const existing = this.messages.slice(since).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const finish = (error, message) => {
        clearTimeout(timer);
        this.off('message', listener);
        this.off('closed', onClose);
        error ? reject(error) : resolve(message);
      };
      const listener = message => { if (predicate(message)) finish(null, message); };
      const onClose = () => finish(new Error(`Bridge closed while waiting for a notification\n${this.stderr}`));
      const timer = setTimeout(() => finish(new Error(`Notification timeout\n${this.stderr}`)), 6_000);
      this.on('message', listener);
      this.once('closed', onClose);
    });
  }

  async initialize() {
    const result = await this.call('initialize', {
      clientInfo: { name: 'cursor_bridge_integration_test', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  async close() {
    if (this.exit) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    await this.closed;
    clearTimeout(timer);
  }
}

async function setup(t, extraEnv = {}) {
  const codex = await genuineCodex();
  if (!codex) { t.skip('A genuine Codex CLI is required; set CURSOR_BRIDGE_TEST_REAL_CODEX'); return null; }
  const temp = await mkdtemp(join(tmpdir(), 'cursor-bridge-integration-'));
  const mockAgent = join(temp, 'mock-agent.mjs');
  const tracePath = join(temp, 'acp-trace.jsonl');
  await writeFile(mockAgent, mockSource);
  await chmod(mockAgent, 0o700);
  const env = {
    ...process.env,
    CODEX_HOME: join(temp, 'codex-home'),
    CURSOR_BRIDGE_CODEX_HOME: join(temp, 'codex-home'),
    CURSOR_BRIDGE_CWD: temp,
    CURSOR_BRIDGE_SYNC_INTERVAL_MS: '0',
    CURSOR_BRIDGE_MODEL: 'composer-2.5',
    CURSOR_BRIDGE_AGENT: mockAgent,
    CURSOR_BRIDGE_REAL_CODEX: codex,
    CURSOR_TEST_TRACE: tracePath,
    CURSOR_TEST_DELAY_FLAG: join(temp, 'delay-session-new'),
    CURSOR_TEST_RICH_MODELS: '0',
    ...extraEnv,
  };
  delete env.OPENAI_API_KEY;
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  const clients = [];
  const start = () => { const client = new RpcClient(env); clients.push(client); return client; };
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await rm(temp, { recursive: true, force: true });
  });
  const trace = async () => {
    try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { client: start(), start, env, temp, trace };
}

async function waitForTrace(trace, predicate) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const event = (await trace()).find(predicate);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for mock ACP lifecycle event');
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('genuine Codex handshake/config and Cursor catalog remain isolated from OpenAI models', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, env, trace } = fixture;
  const initialized = await client.initialize();
  assert.equal(initialized.codexHome, env.CODEX_HOME);
  assert.equal(typeof initialized.userAgent, 'string');
  const account = await client.call('account/read');
  assert.equal(account.requiresOpenaiAuth, false);
  const first = await client.call('model/list', { limit: 1 });
  const second = await client.call('model/list', { limit: 1, cursor: first.nextCursor });
  assert.equal(first.data[0].model, 'composer-2.5[fast=true]');
  assert.equal(first.data[0].isDefault, true);
  assert.match(first.data[0].displayName, /^Cursor · /);
  assert.equal(first.nextCursor, '1');
  assert.equal(second.data[0].model, 'gemini-4-argon[reasoning_effort=medium]');
  assert.equal(second.nextCursor, null);
  const config = await client.call('config/read', { includeLayers: false });
  assert.equal(config.config.model_provider, 'cursor');
  assert.equal(config.config.model, first.data[0].model);
  assert.equal(config.config.model_providers.cursor.requires_openai_auth, false);
  assert.equal((await trace()).some(event => event.method === 'session/prompt'), false);
});

test('toolOutput fallback produces a native turn, streamed items, and durable resumable Cursor history', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, start, temp, env, trace } = fixture;
  await client.initialize();
  const created = await client.call('thread/start', { cwd: temp, model: 'composer-2.5' });
  const threadId = created.thread.id;
  assert.equal(created.modelProvider, 'cursor');
  assert.equal(created.model, 'composer-2.5[fast=true]');
  assert.equal((await trace()).some(event => event.method === 'session/prompt'), false);
  const since = client.messages.length;
  const started = await client.call('turn/start', {
    threadId, input: [], toolOutput: { output: 'Fallback message from native app' },
    clientUserMessageId: 'native-client-message',
  });
  const completed = await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === started.turn.id, since);
  assert.equal(completed.params.turn.status, 'completed');
  const events = client.messages.slice(since);
  const startIndex = events.findIndex(message => message.method === 'turn/started');
  const userIndex = events.findIndex(message => message.method === 'item/started' && message.params.item.type === 'userMessage');
  const deltaIndex = events.findIndex(message => message.method === 'item/agentMessage/delta');
  const completedIndex = events.findIndex(message => message.method === 'turn/completed');
  assert.ok(startIndex >= 0 && startIndex < userIndex && userIndex < deltaIndex && deltaIndex < completedIndex);
  const responseIndex = events.findIndex(message => message.result?.turn?.id === started.turn.id);
  assert.ok(responseIndex >= 0 && responseIndex < deltaIndex, 'The native caller receives the turn ID before inference streams');
  assert.ok(events.some(message => message.method === 'turn/plan/updated'));
  const read = await client.call('thread/read', { threadId, includeTurns: true });
  assert.equal(read.thread.turns.length, 1);
  assert.equal(read.thread.turns[0].items[0].clientId, 'native-client-message');
  assert.equal(read.thread.turns[0].items[0].content[0].text, 'Fallback message from native app');
  assert.equal(read.thread.turns[0].items.find(item => item.type === 'agentMessage').text, 'Cursor says: Fallback message from native app');
  assert.equal(read.thread.turns[0].items.find(item => item.type === 'reasoning').summary[0], 'Inspecting mock context.');
  assert.equal(read.thread.turns[0].items.find(item => item.type === 'dynamicToolCall').success, true);
  const prompt = (await trace()).find(event => event.method === 'session/prompt');
  assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: 'Fallback message from native app' }]);
  const recordPath = join(env.CODEX_HOME, 'cursor-bridge', `${threadId}.json`);
  const persisted = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(persisted.thread.turns[0].status, 'completed');
  assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
  const cursorSessionId = persisted.cursorSessionId;
  await client.close();
  const restarted = start();
  await restarted.initialize();
  const listed = await restarted.call('thread/list', { modelProviders: ['cursor'] });
  assert.equal(listed.data.find(thread => thread.id === threadId).preview, 'Fallback message from native app');
  const restored = await restarted.call('thread/read', { threadId, includeTurns: true });
  assert.deepEqual(restored.thread.turns, read.thread.turns);
  const resumed = await restarted.call('thread/resume', { threadId });
  assert.equal(resumed.thread.id, threadId);
  assert.ok((await trace()).some(event => event.method === 'session/load' && event.params.sessionId === cursorSessionId));
});

test('provider filters, archive state, and unsupported chat calls cannot fall through to Codex inference', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  await client.call('thread/name/set', { threadId: thread.id, name: 'Cursor filter target' });
  assert.deepEqual((await client.call('thread/list', { modelProviders: ['openai'] })).data, []);
  assert.equal((await client.call('thread/list', { modelProviders: ['cursor'], searchTerm: 'FILTER TARGET' })).data[0].id, thread.id);
  assert.deepEqual((await client.call('thread/list', { cwd: '/missing-project' })).data, []);
  await client.call('thread/archive', { threadId: thread.id });
  assert.deepEqual((await client.call('thread/list')).data, []);
  assert.equal((await client.call('thread/list', { archived: true })).data[0].id, thread.id);
  await client.call('thread/unarchive', { threadId: thread.id });
  assert.equal((await client.call('thread/list')).data[0].id, thread.id);
  await assert.rejects(client.call('review/start', { threadId: thread.id }), { code: -32601 });
  await assert.rejects(client.call('thread/fork', { threadId: thread.id }), { code: -32601 });
  await assert.rejects(client.call('thread/start', { model: 'gpt-codex-not-a-cursor-model', cwd: temp }), /Choose a Cursor model/);
  assert.equal((await trace()).some(event => event.method === 'session/prompt'), false);
});

test('section filters keep unsectioned Cursor chats in Recents and paginate only matching sections', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, start, temp, env, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  const pinnedId = '00000000-0000-7000-8000-111111111111';
  const otherId = '00000000-0000-7000-8000-222222222222';
  const unknownId = '00000000-0000-7000-8000-333333333333';
  const ids = result => result.data.map(item => item.id);
  assert.deepEqual(ids(await client.call('thread/list')), [thread.id]);
  assert.deepEqual(ids(await client.call('thread/list', { sectionId: null })), [thread.id]);
  for (const sectionId of [pinnedId, unknownId]) {
    assert.deepEqual(await client.call('thread/list', { sectionId, limit: 1 }), {
      data: [], nextCursor: null, backwardsCursor: null,
    });
  }

  await client.close();
  const recordPath = join(env.CODEX_HOME, 'cursor-bridge', `${thread.id}.json`);
  const seed = JSON.parse(await readFile(recordPath, 'utf8'));
  const pinned = { id: pinnedId, name: 'Pinned' };
  const other = { id: otherId, name: 'Other section' };
  const rows = [
    { id: thread.id, recency: 60, section: null },
    { id: '00000000-0000-7000-8000-444444444444', recency: 50, section: pinned },
    { id: '00000000-0000-7000-8000-555555555555', recency: 40, section: other },
    { id: '00000000-0000-7000-8000-666666666666', recency: 30, section: pinned },
    { id: '00000000-0000-7000-8000-777777777777', recency: 20 },
    { id: '00000000-0000-7000-8000-888888888888', recency: 70, section: pinned, archived: true },
  ];
  for (const row of rows) {
    const record = structuredClone(seed);
    record.archived = Boolean(row.archived);
    Object.assign(record.thread, {
      id: row.id, sessionId: row.id, recencyAt: row.recency, updatedAt: row.recency,
      path: join(env.CODEX_HOME, 'cursor-bridge', `${row.id}.json`), section: row.section,
    });
    // Older records omit section entirely; they still belong to Recents.
    if (!Object.hasOwn(row, 'section')) delete record.thread.section;
    await writeFile(record.thread.path, JSON.stringify(record));
  }
  const restarted = start();
  await restarted.initialize();
  assert.deepEqual(ids(await restarted.call('thread/list')), rows.slice(0, 5).map(row => row.id));
  assert.deepEqual(ids(await restarted.call('thread/list', { sectionId: null })), [rows[0].id, rows[4].id]);
  assert.deepEqual(ids(await restarted.call('thread/list', { sectionId: otherId })), [rows[2].id]);
  const first = await restarted.call('thread/list', { sectionId: pinnedId, limit: 1 });
  assert.deepEqual(ids(first), [rows[1].id]);
  assert.deepEqual(first.data[0].section, pinned);
  assert.equal(first.nextCursor, '1');
  const second = await restarted.call('thread/list', { sectionId: pinnedId, limit: 1, cursor: first.nextCursor });
  assert.deepEqual(ids(second), [rows[3].id]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(ids(await restarted.call('thread/list', { sectionId: pinnedId, archived: true })), [rows[5].id]);
  assert.deepEqual(ids(await restarted.call('thread/list', { sectionId: unknownId })), []);
  assert.equal((await trace()).some(event => event.method === 'session/prompt'), false);
});

test('native approval decline is returned to Cursor without executing an approved action', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  const since = client.messages.length;
  const { turn } = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'NEEDS_APPROVAL' }] });
  const approval = await client.waitFor(message => message.method === 'item/commandExecution/requestApproval', since);
  assert.equal(approval.params.threadId, thread.id);
  assert.equal(approval.params.turnId, turn.id);
  assert.equal(approval.params.itemId, 'permission-tool');
  assert.equal(client.messages.slice(since).some(message => message.method === 'turn/completed'), false);
  client.send({ id: approval.id, result: { decision: 'decline' } });
  const completed = await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === turn.id, since);
  assert.equal(completed.params.turn.status, 'completed');
  assert.equal(completed.params.turn.items.find(item => item.id === 'permission-tool').success, false);
  const permissionResponse = (await trace()).find(event => event.id === 'permission-1' && !event.method);
  assert.deepEqual(permissionResponse.result, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
});

test('native acceptForSession approves only the current Cursor action without persisting an allowlist', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  const since = client.messages.length;
  const { turn } = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'NEEDS_APPROVAL_FOR_SESSION' }] });
  const approval = await client.waitFor(message => message.method === 'item/commandExecution/requestApproval', since);
  client.send({ id: approval.id, result: { decision: 'acceptForSession' } });
  const completed = await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === turn.id, since);
  assert.equal(completed.params.turn.status, 'completed');
  assert.equal(completed.params.turn.items.find(item => item.id === 'permission-tool').success, true);
  const permissionResponse = (await trace()).find(event => event.id === 'permission-1' && !event.method);
  assert.deepEqual(permissionResponse.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
});

test('native question labels map back to stable Cursor option IDs for single and multiple answers', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  const since = client.messages.length;
  const { turn } = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'NEEDS_QUESTION' }] });
  const question = await client.waitFor(message => message.method === 'item/tool/requestUserInput', since);
  assert.equal(question.params.threadId, thread.id);
  assert.equal(question.params.turnId, turn.id);
  assert.deepEqual(question.params.questions.map(item => item.id), ['deploy-target', 'checks']);
  assert.deepEqual(question.params.questions[0].options.map(option => option.label), ['Linux', 'Mac']);
  assert.ok(question.params.questions.every(item => item.isOther === false));
  assert.equal(client.messages.slice(since).some(message => message.method === 'turn/completed'), false);
  client.send({ id: question.id, result: { answers: {
    'deploy-target': { answers: ['Linux'] },
    checks: { answers: ['Tests', 'Build', 'Tests'] },
  } } });
  const completed = await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === turn.id, since);
  assert.equal(completed.params.turn.status, 'completed');
  const questionResponse = (await trace()).find(event => event.id === 'question-1' && !event.method);
  assert.deepEqual(questionResponse.result, { outcome: { outcome: 'answered', answers: [
    { questionId: 'deploy-target', selectedOptionIds: ['target-linux'] },
    { questionId: 'checks', selectedOptionIds: ['check-test', 'check-build'] },
  ] } });
});

test('an opening Cursor session is terminated during input EOF and service shutdown', async t => {
  for (const stopMode of ['input EOF', 'SIGTERM shutdown']) {
    await t.test(stopMode, async t => {
      const fixture = await setup(t);
      if (!fixture) return;
      const { client, env, temp, trace } = fixture;
      await client.initialize();
      // Complete the catalog probe first so the delay covers the thread's live session.
      await client.call('model/list');
      await writeFile(env.CURSOR_TEST_DELAY_FLAG, 'delay the next session/new');
      const opening = client.call('thread/start', { cwd: temp }).then(
        result => ({ result }), error => ({ error }),
      );
      const delayed = await waitForTrace(trace, event => event.lifecycle === 'session-new-delayed');
      assert.doesNotThrow(() => process.kill(delayed.pid, 0));
      if (stopMode === 'input EOF') client.child.stdin.end();
      else client.child.kill('SIGTERM');
      await within(client.closed, 3_000, `Bridge did not exit after ${stopMode} during session/new`);
      assert.equal(client.exit.code, 0, client.stderr);
      assert.equal(client.exit.signal, null);
      assert.ok((await opening).error, 'The incomplete thread/start must not succeed after shutdown');
      const events = await trace();
      assert.ok(events.some(event => event.lifecycle === 'terminated' && event.pid === delayed.pid));
      assert.ok(events.some(event => event.lifecycle === 'exited' && event.pid === delayed.pid));
      assert.throws(() => process.kill(delayed.pid, 0), { code: 'ESRCH' });
    });
  }
});

test('a stale turn interrupt cannot cancel a newer turn, while its current ID can', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  let since = client.messages.length;
  const first = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'First completed turn' }] });
  await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === first.turn.id, since);
  since = client.messages.length;
  const current = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'WAIT_FOR_INTERRUPT' }] });
  await client.waitFor(message => message.method === 'item/agentMessage/delta' && message.params.turnId === current.turn.id, since);
  const cancelsBefore = (await trace()).filter(event => event.method === 'session/cancel').length;
  await assert.rejects(client.call('turn/interrupt', { threadId: thread.id, turnId: first.turn.id }), { code: -32602 });
  const active = await client.call('thread/read', { threadId: thread.id, includeTurns: true });
  assert.equal(active.thread.turns.find(turn => turn.id === current.turn.id).status, 'inProgress');
  assert.equal((await trace()).filter(event => event.method === 'session/cancel').length, cancelsBefore);
  assert.equal(client.messages.slice(since).some(message => message.method === 'turn/completed'), false);
  await client.call('turn/interrupt', { threadId: thread.id, turnId: current.turn.id });
  const interrupted = await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === current.turn.id, since);
  assert.equal(interrupted.params.turn.status, 'interrupted');
  assert.equal((await trace()).filter(event => event.method === 'session/cancel').length, cancelsBefore + 1);
});

test('older persisted Cursor threads hydrate native queue, attachment, and goal reads without inference', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, start, env, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  await client.close();
  const recordPath = join(env.CODEX_HOME, 'cursor-bridge', `${thread.id}.json`);
  const olderRecord = JSON.parse(await readFile(recordPath, 'utf8'));
  delete olderRecord.queuedSubmissions;
  await writeFile(recordPath, JSON.stringify(olderRecord));

  const restarted = start();
  await restarted.initialize();
  assert.equal((await restarted.call('thread/read', { threadId: thread.id, includeTurns: true })).thread.id, thread.id);
  assert.deepEqual(await restarted.call('thread/queue/list', { threadId: thread.id, cursor: null, limit: null }), { data: [], nextCursor: null });
  assert.deepEqual(await restarted.call('thread/attachment/list', { threadId: thread.id, cursor: null, limit: 50 }), { data: [], nextCursor: null });
  assert.deepEqual(await restarted.call('thread/goal/get', { threadId: thread.id }), { goal: null });
  await restarted.call('thread/resume', { threadId: thread.id });
  assert.deepEqual(await restarted.call('thread/queue/list', { threadId: thread.id }), { data: [], nextCursor: null });
  assert.deepEqual((await restarted.call('thread/read', { threadId: thread.id, includeTurns: true })).thread.turns, []);
  assert.equal((await trace()).some(event => event.method === 'session/prompt'), false);
  for (const method of ['thread/queue/list', 'thread/attachment/list', 'thread/goal/get']) {
    await assert.rejects(restarted.call(method, { threadId: 'missing-thread' }), { code: -32602 });
  }
});

test('native queue CRUD preserves input, order, and notifications across a service restart', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, start, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  const activeSince = client.messages.length;
  const active = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'WAIT_FOR_INTERRUPT' }] });
  await client.waitFor(message => message.method === 'item/agentMessage/delta' && message.params.turnId === active.turn.id, activeSince);
  const mutate = async (method, params) => {
    const since = client.messages.length;
    const result = await client.call(method, { threadId: thread.id, ...params });
    await client.waitFor(message => message.method === 'thread/queue/changed' && message.params.threadId === thread.id, since);
    return result;
  };
  const first = (await mutate('thread/queue/add', { clientUserMessageId: 'queue-first', input: [{ type: 'text', text: 'First queued message', text_elements: [] }] })).queuedSubmission;
  const second = (await mutate('thread/queue/add', { clientUserMessageId: 'queue-second', input: [{ type: 'text', text: 'Second queued message' }] })).queuedSubmission;
  const third = (await mutate('thread/queue/add', { clientUserMessageId: 'queue-third', input: [{ type: 'text', text: 'Third queued message' }] })).queuedSubmission;
  const updatedInput = [{ type: 'text', text: 'Updated second message\nwith a new line', text_elements: [] }, { type: 'mention', name: 'mock-context', path: '/mock/context' }];
  const updated = (await mutate('thread/queue/update', { queuedSubmissionId: second.id, input: updatedInput })).queuedSubmission;
  assert.deepEqual(updated, { ...second, input: updatedInput });
  assert.deepEqual(await mutate('thread/queue/reorder', { queuedSubmissionIds: [third.id, second.id, first.id] }), {});
  const page = await client.call('thread/queue/list', { threadId: thread.id, limit: 1 });
  assert.deepEqual(page.data, [third]);
  assert.equal(typeof page.nextCursor, 'string');
  assert.deepEqual(await client.call('thread/queue/list', { threadId: thread.id, cursor: page.nextCursor, limit: 2 }), { data: [updated, first], nextCursor: null });
  assert.deepEqual(await mutate('thread/queue/delete', { queuedSubmissionId: first.id }), { deleted: true });
  await assert.rejects(client.call('thread/queue/reorder', { threadId: thread.id, queuedSubmissionIds: [third.id, third.id] }), { code: -32602 });
  assert.deepEqual(await client.call('thread/queue/list', { threadId: thread.id }), { data: [third, updated], nextCursor: null });
  assert.equal((await trace()).filter(event => event.method === 'session/prompt').length, 1, 'Editing a queue behind an active turn must not start another inference');

  await client.close();
  const restarted = start();
  await restarted.initialize();
  assert.deepEqual(await restarted.call('thread/queue/list', { threadId: thread.id }), { data: [third, updated], nextCursor: null });
  const restored = await restarted.call('thread/read', { threadId: thread.id, includeTurns: true });
  assert.ok(['interrupted', 'failed'].includes(restored.thread.turns[0].status));
  assert.equal((await trace()).filter(event => event.method === 'session/prompt').length, 1, 'Restoring a queue after a disconnected turn must not send its messages automatically');
});

test('queue start keeps busy submissions and sends only the selected entry with its native client message ID', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  let since = client.messages.length;
  const active = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'WAIT_FOR_INTERRUPT' }] });
  await client.waitFor(message => message.method === 'item/agentMessage/delta' && message.params.turnId === active.turn.id, since);
  const head = (await client.call('thread/queue/add', { threadId: thread.id, clientUserMessageId: 'queue-head', input: [{ type: 'text', text: 'Leave this at the head' }] })).queuedSubmission;
  const selected = (await client.call('thread/queue/add', { threadId: thread.id, clientUserMessageId: 'native-queued-selected', input: [{ type: 'text', text: 'WAIT_FOR_INTERRUPT', text_elements: [] }] })).queuedSubmission;
  const tail = (await client.call('thread/queue/add', { threadId: thread.id, clientUserMessageId: 'queue-tail', input: [{ type: 'text', text: 'Leave this at the tail' }] })).queuedSubmission;
  await assert.rejects(client.call('thread/queue/start', { threadId: thread.id, queuedSubmissionId: selected.id }), /already running/);
  assert.deepEqual((await client.call('thread/queue/list', { threadId: thread.id })).data, [head, selected, tail]);
  assert.equal((await trace()).filter(event => event.method === 'session/prompt').length, 1);
  await client.call('turn/interrupt', { threadId: thread.id, turnId: active.turn.id });
  await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === active.turn.id, since);
  assert.deepEqual((await client.call('thread/queue/list', { threadId: thread.id })).data, [head, selected, tail]);

  since = client.messages.length;
  const started = await client.call('thread/queue/start', { threadId: thread.id, queuedSubmissionId: selected.id });
  await client.waitFor(message => message.method === 'thread/queue/changed' && message.params.threadId === thread.id, since);
  await client.waitFor(message => message.method === 'item/agentMessage/delta' && message.params.turnId === started.turn.id, since);
  assert.equal(started.turn.status, 'inProgress');
  assert.deepEqual((await client.call('thread/queue/list', { threadId: thread.id })).data, [head, tail]);
  const read = await client.call('thread/read', { threadId: thread.id, includeTurns: true });
  const user = read.thread.turns.find(turn => turn.id === started.turn.id).items.find(item => item.type === 'userMessage');
  assert.equal(user.clientId, 'native-queued-selected');
  assert.deepEqual(user.content, selected.input);
  const prompts = (await trace()).filter(event => event.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[1].params.prompt, [{ type: 'text', text: 'WAIT_FOR_INTERRUPT' }]);
  await client.call('turn/interrupt', { threadId: thread.id, turnId: started.turn.id });
  await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === started.turn.id, since);
  assert.deepEqual((await client.call('thread/queue/list', { threadId: thread.id })).data, [head, tail]);
});

test('queue start preserves unsupported native input when admission validation fails', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  const since = client.messages.length;
  const active = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'WAIT_FOR_INTERRUPT' }] });
  await client.waitFor(message => message.method === 'item/agentMessage/delta' && message.params.turnId === active.turn.id, since);
  const input = [{ type: 'audio', url: 'mock://queued-audio' }];
  const queued = (await client.call('thread/queue/add', { threadId: thread.id, clientUserMessageId: 'native-unsupported-audio', input })).queuedSubmission;
  await client.call('turn/interrupt', { threadId: thread.id, turnId: active.turn.id });
  await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === active.turn.id, since);

  const failedSince = client.messages.length;
  await assert.rejects(client.call('thread/queue/start', { threadId: thread.id, queuedSubmissionId: queued.id }), /does not yet support input type: audio/);
  assert.deepEqual(await client.call('thread/queue/list', { threadId: thread.id }), { data: [queued], nextCursor: null });
  assert.equal(client.messages.slice(failedSince).some(message => message.method === 'thread/queue/changed' || message.method === 'turn/started'), false);
  const read = await client.call('thread/read', { threadId: thread.id, includeTurns: true });
  assert.equal(read.thread.turns.length, 1);
  assert.equal((await trace()).filter(event => event.method === 'session/prompt').length, 1);
});

test('adding to an idle native queue automatically sends the Cursor message once', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, start, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  const since = client.messages.length;
  const input = [{ type: 'text', text: 'Automatically drain this native queue', text_elements: [] }];
  const added = await client.call('thread/queue/add', { threadId: thread.id, clientUserMessageId: 'native-auto-drain', input });
  assert.equal(added.queuedSubmission.clientUserMessageId, 'native-auto-drain');
  const completed = await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.items.some(item => item.type === 'userMessage' && item.clientId === 'native-auto-drain'), since);
  assert.equal(completed.params.turn.status, 'completed');
  assert.deepEqual(completed.params.turn.items.find(item => item.type === 'userMessage').content, input);
  assert.deepEqual(await client.call('thread/queue/list', { threadId: thread.id }), { data: [], nextCursor: null });
  const prompts = (await trace()).filter(event => event.method === 'session/prompt');
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].params.prompt, [{ type: 'text', text: input[0].text }]);
  const read = await client.call('thread/read', { threadId: thread.id, includeTurns: true });
  assert.equal(read.thread.turns.length, 1);
  assert.ok(client.messages.slice(since).filter(message => message.method === 'thread/queue/changed' && message.params.threadId === thread.id).length >= 2, 'Both enqueue and consumption notify the native client');
  const repeated = await client.call('thread/queue/start', { threadId: thread.id, queuedSubmissionId: added.queuedSubmission.id });
  assert.equal(repeated.turn.id, completed.params.turn.id, 'Native manual start after automatic consumption returns the original turn');
  assert.equal((await trace()).filter(event => event.method === 'session/prompt').length, 1);

  await client.close();
  const restarted = start();
  await restarted.initialize();
  const restored = await restarted.call('thread/queue/start', { threadId: thread.id, queuedSubmissionId: added.queuedSubmission.id });
  assert.equal(restored.turn.id, completed.params.turn.id, 'The queue-to-turn association survives service restart');
  assert.equal((await trace()).filter(event => event.method === 'session/prompt').length, 1);
  assert.equal((await restarted.call('thread/read', { threadId: thread.id, includeTurns: true })).thread.turns.length, 1);
});

test('interrupt pauses automatic queue draining until explicit queue start resumes the remaining messages', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const { thread } = await client.call('thread/start', { cwd: temp });
  let since = client.messages.length;
  const active = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'WAIT_FOR_INTERRUPT' }] });
  await client.waitFor(message => message.method === 'item/agentMessage/delta' && message.params.turnId === active.turn.id, since);
  const first = (await client.call('thread/queue/add', { threadId: thread.id, clientUserMessageId: 'paused-first', input: [{ type: 'text', text: 'Resume the first queued message' }] })).queuedSubmission;
  const second = (await client.call('thread/queue/add', { threadId: thread.id, clientUserMessageId: 'paused-second', input: [{ type: 'text', text: 'Drain the second queued message' }] })).queuedSubmission;
  await client.call('turn/interrupt', { threadId: thread.id, turnId: active.turn.id });
  await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === active.turn.id, since);
  // Cover the scheduled busy retry, which must also honor the interrupted state.
  await new Promise(resolve => setTimeout(resolve, 2_200));
  assert.deepEqual((await client.call('thread/queue/list', { threadId: thread.id })).data, [first, second]);
  assert.equal((await trace()).filter(event => event.method === 'session/prompt').length, 1);

  since = client.messages.length;
  const started = await client.call('thread/queue/start', { threadId: thread.id, queuedSubmissionId: null });
  const firstCompleted = await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === started.turn.id, since);
  const secondCompleted = await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.items.some(item => item.type === 'userMessage' && item.clientId === 'paused-second'), since);
  assert.equal(firstCompleted.params.turn.status, 'completed');
  assert.equal(firstCompleted.params.turn.items.find(item => item.type === 'userMessage').clientId, 'paused-first');
  assert.equal(secondCompleted.params.turn.status, 'completed');
  assert.deepEqual(await client.call('thread/queue/list', { threadId: thread.id }), { data: [], nextCursor: null });
  const prompts = (await trace()).filter(event => event.method === 'session/prompt');
  assert.deepEqual(prompts.map(event => event.params.prompt[0].text), ['WAIT_FOR_INTERRUPT', first.input[0].text, second.input[0].text]);
  const read = await client.call('thread/read', { threadId: thread.id, includeTurns: true });
  assert.deepEqual(read.thread.turns.map(turn => turn.status), ['interrupted', 'completed', 'completed']);
});

test('native collaboration settings select the Cursor model when model is null and explicit model takes precedence', async t => {
  const fixture = await setup(t);
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  assert.deepEqual(await client.call('collaborationMode/list'), {
    data: [{ name: 'Agent', mode: 'default', model: null, reasoning_effort: null }],
  });
  assert.equal((await trace()).some(event => event.method === 'session/prompt'), false);
  const { thread } = await client.call('thread/start', { cwd: temp, model: 'composer-2.5' });
  const collaborationMode = {
    mode: 'default',
    settings: {
      model: 'gemini-4-argon[reasoning_effort=medium]',
      reasoning_effort: 'medium', developer_instructions: null,
    },
  };
  let traceSince = (await trace()).length;
  let since = client.messages.length;
  const first = await client.call('turn/start', {
    threadId: thread.id, model: null, collaborationMode,
    input: [{ type: 'text', text: 'Use the native collaboration model' }],
  });
  await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === first.turn.id, since);
  let events = (await trace()).slice(traceSince);
  let selections = events.filter(event => event.method === 'session/set_config_option');
  assert.deepEqual(selections.map(event => event.params.value), [collaborationMode.settings.model]);
  assert.ok(events.findIndex(event => event.method === 'session/set_config_option') < events.findIndex(event => event.method === 'session/prompt'));
  assert.equal((await client.call('thread/read', { threadId: thread.id })).thread.model, collaborationMode.settings.model);

  traceSince = (await trace()).length;
  since = client.messages.length;
  const explicitModel = 'composer-2.5[fast=true]';
  const second = await client.call('turn/start', {
    threadId: thread.id, model: explicitModel, collaborationMode,
    input: [{ type: 'text', text: 'Use the explicit native model' }],
  });
  await client.waitFor(message => message.method === 'turn/completed' && message.params.turn.id === second.turn.id, since);
  events = (await trace()).slice(traceSince);
  selections = events.filter(event => event.method === 'session/set_config_option');
  assert.deepEqual(selections.map(event => event.params.value), [explicitModel]);
  assert.ok(events.findIndex(event => event.method === 'session/set_config_option') < events.findIndex(event => event.method === 'session/prompt'));
  assert.equal((await client.call('thread/read', { threadId: thread.id })).thread.model, explicitModel);
  assert.equal((await trace()).filter(event => event.method === 'session/prompt').length, 2);
});

test('official model variants remain available as hidden metadata without permitting unavailable ACP selections', async t => {
  const fixture = await setup(t, { CURSOR_TEST_RICH_MODELS: '1' });
  if (!fixture) return;
  const { client, temp, trace } = fixture;
  await client.initialize();
  const listed = await client.call('model/list');
  const available = listed.data.find(model => model.model === 'composer-2.5[fast=true]');
  const metadata = listed.data.find(model => model.model === 'composer-2.5[fast=false]');
  assert.ok(available, 'The ACP-advertised variant is retained');
  assert.equal(available.hidden, false);
  assert.ok(metadata, 'The official ordinary Composer variant remains recognizable for existing TUI sessions');
  assert.equal(metadata.hidden, true);
  assert.equal(metadata.isDefault, false);
  assert.equal(listed.data.length, 3);
  const newSessionsBefore = (await trace()).filter(event => event.method === 'session/new').length;
  await assert.rejects(client.call('thread/start', { cwd: temp, model: metadata.model }), /Choose a Cursor model from the model picker; unavailable model/);
  assert.equal((await trace()).filter(event => event.method === 'session/new').length, newSessionsBefore, 'A hidden metadata variant cannot start an ACP session');
  const created = await client.call('thread/start', { cwd: temp, model: 'composer-2.5' });
  assert.equal(created.model, available.model);
  assert.equal((await trace()).filter(event => event.method === 'session/new').length, newSessionsBefore + 1);
  assert.equal((await trace()).some(event => event.method === 'session/prompt'), false);
});
