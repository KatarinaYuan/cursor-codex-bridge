import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class CursorRpcError extends Error {
  constructor(error, method) {
    super(error?.message || `Cursor ACP request failed: ${method}`);
    this.name = 'CursorRpcError';
    this.code = error?.code;
    this.data = error?.data;
    this.method = method;
  }
}

function clientError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * One Cursor ACP process and session. Attach approval listeners before start().
 * update: (rawUpdate, completeParams); permission/request: ({id, params, respond}).
 * respond(result, rpcError?) is single-use; unattended requests are cancelled.
 * Logs contain lifecycle information only, never protocol bodies or CLI stderr.
 */
export class CursorSession extends EventEmitter {
  constructor({
    cwd = process.cwd(), model, agentPath = 'agent', env, log,
    requestTimeoutMs = 60_000, promptTimeoutMs = 30 * 60_000,
    permissionTimeoutMs = 15 * 60_000, shutdownTimeoutMs = 2_000,
    maxMessageBytes = 16 * 1024 * 1024,
  } = {}) {
    super();
    this.cwd = cwd;
    this.model = model;
    this.agentPath = agentPath;
    this.env = env;
    this.log = log || (message => process.stderr.write(`[cursor-acp] ${message}\n`));
    this.requestTimeoutMs = requestTimeoutMs;
    this.promptTimeoutMs = promptTimeoutMs;
    this.permissionTimeoutMs = permissionTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.maxMessageBytes = maxMessageBytes;
    this.state = 'new';
    this.sessionId = null;
    this.sessionResult = null;
    this.initializeResult = null;
    this._nextId = 1;
    this._pending = new Map();
    this._incoming = new Map();
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
    this._prompting = false;
    this._startPromise = null;
    this._closePromise = null;
    this._failure = null;
  }

  async start({ sessionId } = {}) {
    if (this.state === 'closing' || this.state === 'closed') throw clientError('Cursor session cannot be restarted', 'ERR_CURSOR_CLOSED');
    if (this._startPromise) return this._startPromise;
    if (this.state !== 'new') throw this._failure || clientError('Cursor session cannot be restarted', 'ERR_CURSOR_CLOSED');
    this.state = 'starting';
    this._startPromise = this._start(sessionId);
    return this._startPromise;
  }

  async _start(sessionId) {
    try {
      this._child = spawn(this.agentPath, ['acp'], {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this._child.stdin.on('error', () => this._fail(clientError('Cursor ACP stdin failed', 'ERR_CURSOR_TRANSPORT')));
      this._child.stdout.on('data', data => this._read(data));
      this._child.stderr.on('data', data => this._log(`CLI stderr received (${data.length} bytes; content omitted)`));
      this._child.on('error', error => this._fail(clientError(`Cannot start Cursor ACP (${error.code || 'spawn error'})`, 'ERR_CURSOR_SPAWN')));
      this._child.on('close', (code, signal) => {
        this._processClosed = true;
        if (this.state !== 'closing' && this.state !== 'closed' && !this._failure) {
          this._fail(clientError(`Cursor ACP exited (code=${code}, signal=${signal || 'none'})`, 'ERR_CURSOR_EXIT'));
        }
        this.emit('exit', { code, signal });
      });
      this.initializeResult = await this._request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'cursor-app-server-bridge', version: '0.1.0' },
      });
      if (this.initializeResult.protocolVersion !== 1) {
        throw clientError('Cursor ACP negotiated an unsupported protocol version', 'ERR_CURSOR_PROTOCOL');
      }
      await this._request('authenticate', { methodId: 'cursor_login' });
      const result = await this._request(sessionId ? 'session/load' : 'session/new', {
        cwd: this.cwd, mcpServers: [], ...(sessionId ? { sessionId } : {}),
      });
      this.sessionId = sessionId || result.sessionId;
      if (typeof this.sessionId !== 'string' || !this.sessionId) {
        throw clientError('Cursor ACP did not return a session ID', 'ERR_CURSOR_PROTOCOL');
      }
      this.sessionResult = { ...result, sessionId: this.sessionId };
      this.state = 'ready';
      if (this.model) await this.setModel(this.model);
      else this.model = result.models?.currentModelId;
      this._log('Session ready');
      return this.sessionResult;
    } catch (error) {
      this._fail(error);
      throw error;
    }
  }

  async prompt(inputArray) {
    this._assertReady();
    if (this._prompting) throw clientError('Cursor session already has an active prompt', 'ERR_CURSOR_BUSY');
    if (!Array.isArray(inputArray) || !inputArray.length || inputArray.some(block => !block || typeof block.type !== 'string')) {
      throw new TypeError('prompt() requires a non-empty array of ACP content blocks');
    }
    this._prompting = true;
    try {
      return await this._request('session/prompt', { sessionId: this.sessionId, prompt: inputArray }, this.promptTimeoutMs);
    } finally {
      this._prompting = false;
    }
  }

  async listAvailableModels() {
    this._assertReady();
    return this._request('cursor/list_available_models', {}, 5000);
  }

  async setModel(model) {
    this._assertReady();
    if (this._prompting) throw clientError('Cannot change the Cursor model during a prompt', 'ERR_CURSOR_BUSY');
    if (typeof model !== 'string' || !model) throw new TypeError('A Cursor model ID is required');
    const models = this.sessionResult.models?.availableModels || [];
    const aliases = models.filter(item => item.modelId === model || item.name === model || item.modelId.split('[')[0] === model);
    const auto = model === 'auto' ? models.filter(item => /^auto(?:-|\[|$)/.test(item.modelId)) : [];
    const modelId = aliases.length === 1 ? aliases[0].modelId : auto.length === 1 ? auto[0].modelId : model;
    let result;
    try {
      result = await this._request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: modelId });
    } catch (error) {
      if (error.code !== -32601) throw error;
      result = await this._request('session/set_model', { sessionId: this.sessionId, modelId });
    }
    this.model = modelId;
    if (this.sessionResult.models) this.sessionResult.models.currentModelId = modelId;
    if (result.configOptions) this.sessionResult.configOptions = result.configOptions;
    return result;
  }

  cancel() {
    if (!this.sessionId || this.state !== 'ready') return false;
    // ACP cancellation is a notification; the outstanding prompt still returns its stopReason.
    try { this._notify('session/cancel', { sessionId: this.sessionId }); }
    catch (error) { this._fail(error); return false; }
    this._cancelIncoming();
    return true;
  }

  async close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = this._close();
    return this._closePromise;
  }

  async _close() {
    if (this.state === 'closed') return;
    if (this.state === 'ready') this.cancel();
    this.state = 'closing';
    this._cancelIncoming();
    this._rejectPending(clientError('Cursor session closed', 'ERR_CURSOR_CLOSED'));
    if (this._child && !this._processClosed) {
      const closed = new Promise(resolve => this._child.once('close', resolve));
      this._child.stdin.end();
      this._child.kill('SIGTERM');
      const timer = setTimeout(() => this._child.kill('SIGKILL'), this.shutdownTimeoutMs);
      timer.unref();
      await closed;
      clearTimeout(timer);
    }
    this.state = 'closed';
  }

  _assertReady() {
    if (this.state !== 'ready') throw this._failure || clientError('Cursor session is not ready', 'ERR_CURSOR_CLOSED');
  }

  _request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this._failure || this.state === 'closing' || this.state === 'closed') return Promise.reject(this._failure || clientError('Cursor session closed', 'ERR_CURSOR_CLOSED'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = clientError(`Cursor ACP request timed out: ${method}`, 'ERR_CURSOR_TIMEOUT');
        if (method === 'session/prompt' && this.sessionId) {
          try { this._notify('session/cancel', { sessionId: this.sessionId }); } catch { /* Failure below terminates the process. */ }
        }
        this._fail(error);
      }, timeoutMs);
      timer.unref();
      this._pending.set(id, { resolve, reject, timer, method });
      try { this._write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this._fail(error); }
    });
  }

  _notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  _write(message) {
    if (!this._child?.stdin.writable || this._processClosed) {
      throw clientError('Cursor ACP transport is closed', 'ERR_CURSOR_TRANSPORT');
    }
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _read(data) {
    if (this._failure || this.state === 'closing' || this.state === 'closed') return;
    this._buffer += this._decoder.write(data);
    let newline;
    while ((newline = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, newline).trim();
      this._buffer = this._buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > this.maxMessageBytes) return this._fail(clientError('Cursor ACP message exceeded the size limit', 'ERR_CURSOR_PROTOCOL'));
      try {
        const message = JSON.parse(line);
        if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw new Error('Invalid envelope');
        this._handle(message);
        if (this._failure || this.state === 'closing' || this.state === 'closed') return;
      } catch {
        return this._fail(clientError('Cursor ACP emitted an invalid JSON-RPC message', 'ERR_CURSOR_PROTOCOL'));
      }
    }
    if (Buffer.byteLength(this._buffer) > this.maxMessageBytes) this._fail(clientError('Cursor ACP message exceeded the size limit', 'ERR_CURSOR_PROTOCOL'));
  }

  _handle(message) {
    if (own(message, 'id') && (own(message, 'result') || own(message, 'error'))) {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error ? pending.reject(new CursorRpcError(message.error, pending.method)) : pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') throw new Error('Invalid RPC message');
    if (own(message, 'id')) return this._handleRequest(message);
    if (message.method === 'session/update') {
      if (message.params?.sessionId && this.sessionId && message.params.sessionId !== this.sessionId) return;
      const update = message.params?.update;
      if (update?.sessionUpdate === 'config_option_update' && update.configOptions && this.sessionResult) this.sessionResult.configOptions = update.configOptions;
      this.emit('update', update, message.params);
    } else {
      this.emit('notification', { method: message.method, params: message.params });
    }
  }

  _handleRequest({ id, method, params }) {
    if (this._incoming.has(id)) throw new Error('Duplicate incoming request ID');
    const permission = method === 'session/request_permission';
    const event = permission ? 'permission' : 'request';
    const respond = (result, error) => {
      const incoming = this._incoming.get(id);
      if (!incoming) return false;
      this._incoming.delete(id);
      clearTimeout(incoming.timer);
      if (this._processClosed || this._failure) return false;
      try {
        this._write({ jsonrpc: '2.0', id, ...(error ? { error: { code: error.code || -32603, message: error.message || 'Client request failed', ...(error.data === undefined ? {} : { data: error.data }) } } : { result }) });
        return true;
      } catch (writeError) {
        this._fail(writeError);
        return false;
      }
    };
    const cancel = () => {
      if (permission || method === 'cursor/ask_question' || method === 'cursor/create_plan') respond({ outcome: { outcome: 'cancelled' } });
      else respond(undefined, { code: -32601, message: 'Client does not implement this request' });
    };
    const timer = setTimeout(() => {
      this._log(`Client response timed out (${permission ? 'permission' : 'request'})`);
      cancel();
    }, this.permissionTimeoutMs);
    timer.unref();
    this._incoming.set(id, { timer, cancel });
    if (!this.listenerCount(event)) return cancel();
    try { this.emit(event, { id, method, params, respond }); }
    catch { respond(undefined, { code: -32603, message: 'Client request handler failed' }); }
  }

  _cancelIncoming() {
    for (const request of [...this._incoming.values()]) request.cancel();
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  _fail(error) {
    if (this._failure || this.state === 'closing' || this.state === 'closed') return;
    this._cancelIncoming();
    this._failure = error;
    this.state = 'failed';
    this._rejectPending(error);
    this._log(`Session failed (${error.code || 'error'})`);
    this._child?.kill('SIGTERM');
    if (this._child && !this._processClosed) {
      this._killTimer = setTimeout(() => { if (!this._processClosed) this._child.kill('SIGKILL'); }, this.shutdownTimeoutMs);
      this._killTimer.unref();
      this._child.once('close', () => clearTimeout(this._killTimer));
    }
    // EventEmitter's special error event must not crash a process without a listener.
    if (this.listenerCount('error')) this.emit('error', error);
  }

  _log(message) {
    try { this.log(message); } catch { /* A logger must not break protocol processing. */ }
  }
}
