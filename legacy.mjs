import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function buildLegacyArgs({ sessionId, model, prompt }) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('A native Cursor chat ID is required to resume history');
  const args = ['--resume', sessionId, '--print', '--output-format', 'stream-json', '--stream-partial-output'];
  // The current CLI accepts the same quoted bracket overrides as ACP model IDs.
  if (model) args.push('--model', model);
  args.push('--', prompt);
  return args;
}

function promptText(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('Cursor history continuation requires a text prompt');
  if (blocks.some((block) => block?.type !== 'text' || typeof block.text !== 'string')) {
    throw new Error('Cursor legacy history continuation currently supports text prompts only');
  }
  const text = blocks.map((block) => block.text).join('\n');
  if (!text.trim()) throw new Error('Cursor history continuation requires a non-empty text prompt');
  return text;
}

function describeTool(event) {
  const raw = event.tool_call ?? {};
  const [key, value] = Object.entries(raw)[0] ?? ['unknown', {}];
  const name = raw.function?.name ?? value?.name ?? key;
  let input = raw.function?.arguments ?? value?.args ?? {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { text: input }; } }
  const kind = /shell|bash|command/i.test(name) ? 'execute' : /write|edit|delete/i.test(name) ? 'edit'
    : /read|list/i.test(name) ? 'read' : /search|grep|glob/i.test(name) ? 'search' : 'other';
  const result = value?.result ?? raw.result;
  return { name, input, kind, result };
}

function toolError(result) {
  if (!result || typeof result !== 'object') return false;
  return Boolean(result.error ?? result.failure ?? result.failed ?? result.is_error);
}

/** A deliberately separate continuation path for pre-ACP Cursor CLI chats. */
export class LegacySession extends EventEmitter {
  constructor({ cwd, model, agentPath = 'agent', log = () => {}, env = process.env, spawnProcess = spawn } = {}) {
    super();
    this.cwd = cwd;
    this.model = model;
    this.agentPath = agentPath;
    this.log = log;
    this.env = env;
    this.spawnProcess = spawnProcess;
    this.sessionId = null;
    this.child = null;
    this.cancelled = false;
    this.killTimer = null;
  }

  async start({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('A native Cursor chat ID is required');
    this.sessionId = sessionId;
    return { sessionId };
  }

  async setModel(model) {
    if (this.child) throw new Error('Wait for the current Cursor turn before changing models');
    this.model = model;
    return { currentModelId: model };
  }

  async prompt(blocks) {
    if (this.child) throw new Error('A Cursor turn is already running');
    const args = buildLegacyArgs({ sessionId: this.sessionId, model: this.model, prompt: promptText(blocks) });
    this.cancelled = false;
    let child;
    try { child = this.spawnProcess(this.agentPath, args, { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false }); }
    catch (error) { throw new Error(`Unable to start Cursor CLI: ${error.message}`, { cause: error }); }
    this.child = child;
    return new Promise((resolve, reject) => {
      let failure;
      let terminal;
      let streamedText = '';
      let stderr = '';
      let settled = false;
      const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const fail = (message) => {
        if (!failure) failure = new Error(message);
        this.stopChild();
      };
      const emitText = (text) => {
        if (!text) return;
        streamedText += text;
        this.emit('update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      };
      output.on('line', (line) => {
        if (!line.trim() || failure || this.cancelled) return;
        let event;
        try { event = JSON.parse(line); }
        catch { fail('Cursor CLI emitted non-JSON output; interactive approval or workspace trust must be handled in Cursor CLI before resuming'); return; }
        if (event.type === 'system' && event.subtype === 'init' && event.session_id && event.session_id !== this.sessionId) {
          fail('Cursor CLI opened a different session instead of resuming the requested chat');
        } else if (/^(permission|approval|permission_request|approval_request)$/.test(event.type)) {
          fail('Cursor requested an interactive approval that legacy continuation cannot answer; continue this turn in Cursor CLI');
        } else if (event.type === 'assistant') {
          // Cursor documents the other two forms as duplicate buffered flushes.
          if (event.timestamp_ms !== undefined && event.model_call_id === undefined) {
            emitText((event.message?.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text ?? '').join(''));
          }
        } else if (event.type === 'tool_call') {
          const tool = describeTool(event);
          if (/ask.?question|ask_user_question/i.test(tool.name)
            || JSON.stringify(tool.result ?? '').includes('Questions skipped by the user, continue with the information you already have')) {
            fail('Cursor requested a question that legacy print mode cannot present; no user answer or approval was supplied. Continue this turn in Cursor CLI');
            return;
          }
          const toolCallId = event.call_id ?? event.id;
          if (!toolCallId) return;
          const finished = event.subtype === 'completed';
          this.emit('update', {
            sessionUpdate: finished ? 'tool_call_update' : 'tool_call',
            toolCallId,
            title: tool.name,
            kind: tool.kind,
            status: finished ? (toolError(tool.result) ? 'failed' : 'completed') : 'in_progress',
            rawInput: tool.input,
            ...(tool.result === undefined ? {} : { rawOutput: tool.result, content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(tool.result) } }] }),
            ...(typeof tool.input?.path === 'string' ? { locations: [{ path: tool.input.path }] } : {}),
          });
        } else if (event.type === 'result') {
          terminal = event;
          if (event.is_error || (event.subtype && event.subtype !== 'success')) {
            fail(`Cursor CLI failed: ${event.error?.message ?? event.error ?? event.result ?? event.subtype}`);
          } else if (typeof event.result === 'string') {
            if (!streamedText) emitText(event.result);
            else if (event.result.startsWith(streamedText)) emitText(event.result.slice(streamedText.length));
          }
        } else if (event.type === 'error') {
          fail(`Cursor CLI failed: ${event.message ?? event.error?.message ?? event.error ?? 'unknown error'}`);
        }
      });
      child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-32_768); });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        output.close();
        clearTimeout(this.killTimer);
        this.killTimer = null;
        if (this.child === child) this.child = null;
        if (error) reject(error); else resolve(value);
      };
      child.once('error', (error) => finish(new Error(`Unable to run Cursor CLI: ${error.message}`, { cause: error })));
      child.once('close', (code, signal) => {
        if (failure) return finish(failure);
        if (this.cancelled) return finish(null, { stopReason: 'cancelled' });
        if (code !== 0) return finish(new Error(`Cursor CLI exited ${code ?? signal}: ${stderr.trim() || 'No error details were provided'}`));
        if (!terminal) return finish(new Error(`Cursor CLI ended without a terminal result${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        finish(null, { stopReason: 'end_turn' });
      });
    });
  }

  stopChild() {
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    if (!this.killTimer) {
      this.killTimer = setTimeout(() => { if (this.child === child) child.kill('SIGKILL'); }, 2_000);
      this.killTimer.unref?.();
    }
  }

  async cancel() { this.cancelled = true; this.stopChild(); }
  async close() { await this.cancel(); }
}
