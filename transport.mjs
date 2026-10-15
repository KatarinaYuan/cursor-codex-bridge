import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function bridgeHome(env = process.env) {
  return resolve(env.CURSOR_BRIDGE_CODEX_HOME || env.CODEX_HOME || `${homedir()}/.codex-cursor-bridge`);
}

export function controlSocketPath(home = bridgeHome()) {
  return resolve(home, 'app-server-control', 'app-server-control.sock');
}

export function parseListen(args, home = bridgeHome()) {
  let value = 'stdio://';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--stdio') value = 'stdio://';
    if (args[index] === '--listen') {
      value = args[++index];
      if (!value) throw new Error('--listen requires a value');
    } else if (args[index].startsWith('--listen=')) {
      value = args[index].slice('--listen='.length);
    }
  }
  if (value === 'stdio://') return { type: 'stdio' };
  if (value.startsWith('unix://')) {
    return { type: 'unix', path: value.slice(7) ? resolve(value.slice(7)) : controlSocketPath(home) };
  }
  throw new Error(`Unsupported bridge transport: ${value}. Use stdio:// or a private unix:// socket.`);
}

function deliver(bridge, text, send, log) {
  let message;
  try {
    message = JSON.parse(text);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('JSON-RPC message must be an object');
  } catch (error) {
    log(`Invalid JSON-RPC message: ${error.message}`);
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  Promise.resolve().then(() => bridge.receive(message)).catch((error) => {
    log(`Bridge receive failed: ${error.stack || error.message}`);
    if (Object.hasOwn(message, 'id') && message.method) {
      send({ id: message.id, error: { code: -32603, message: error.message || 'Bridge receive failed' } });
    }
  });
}

export function serveStdio({ createBridge, input = process.stdin, output = process.stdout, log = () => {}, onClose = async () => {} }) {
  let closed = false;
  let closePromise;
  const send = (message) => {
    if (!closed && !output.destroyed) output.write(`${JSON.stringify(message)}\n`);
  };
  const bridge = createBridge({ send, log });
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = Promise.resolve().then(async () => {
      lines.close();
      input.pause();
      try { await bridge.close(); } finally { await onClose(); }
    });
    return closePromise;
  };
  const stop = (error) => {
    if (error && error.code !== 'EPIPE') log(`Stdio error: ${error.message}`);
    close().catch((closeError) => log(closeError.message));
  };
  lines.on('line', (line) => {
    if (!closed && line.trim()) deliver(bridge, line, send, log);
  });
  lines.once('close', () => stop());
  lines.on('error', stop);
  input.on('error', stop);
  output.on('error', stop);
  output.once('close', () => stop());
  return { close };
}

async function socketExists(socketPath) {
  try { return await lstat(socketPath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function prepareSocket(socketPath) {
  const parent = dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  const uid = process.getuid?.();
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
      || (uid !== undefined && parentMetadata.uid !== uid)
      || (parentMetadata.mode & 0o077) !== 0) {
    throw new Error(`Socket parent must be a user-owned private directory (0700): ${parent}`);
  }
  const metadata = await socketExists(socketPath);
  if (!metadata) return;
  if (!metadata.isSocket() || (uid !== undefined && metadata.uid !== uid)) {
    throw new Error(`Refusing to replace a non-socket or another user's socket: ${socketPath}`);
  }
  await new Promise((resolveProbe, reject) => {
    const probe = createConnection(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error(`Bridge socket is already in use: ${socketPath}`));
    });
    probe.once('error', (error) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolveProbe();
      else reject(error);
    });
    probe.setTimeout(1000, () => {
      probe.destroy();
      reject(new Error(`Timed out checking existing bridge socket: ${socketPath}`));
    });
  });
  // Compare the inode so a competing listener cannot be unlinked after the probe.
  const current = await socketExists(socketPath);
  if (current && current.ino === metadata.ino && current.dev === metadata.dev) await unlink(socketPath);
  else if (current) throw new Error(`Bridge socket changed during startup: ${socketPath}`);
}

export async function serveUnix({ socketPath, createBridge, log = () => {}, onClose = async () => {} }) {
  await prepareSocket(socketPath);
  let isClosing = false;
  const http = createServer((_request, response) => {
    response.writeHead(isClosing ? 503 : 426, { Connection: 'close' });
    response.end(isClosing ? 'Bridge is shutting down' : 'WebSocket required');
  });
  const websocket = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  websocket.on('headers', (headers) => {
    headers.push(`x-codex-websocket-max-unfragmented-message-bytes: ${MAX_MESSAGE_BYTES}`);
  });
  const bridges = new Map();
  websocket.on('connection', (socket) => {
    if (isClosing) { socket.terminate(); return; }
    const send = (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    let bridge;
    try { bridge = createBridge({ send, log }); } catch (error) {
      log(`Bridge initialization failed: ${error.message}`);
      socket.close(1011, 'Bridge initialization failed');
      return;
    }
    let closePromise;
    const closeBridge = () => {
      if (!closePromise) {
        closePromise = Promise.resolve().then(() => bridge.close()).finally(() => bridges.delete(bridge));
      }
      return closePromise;
    };
    bridges.set(bridge, closeBridge);
    socket.on('message', (data, isBinary) => {
      if (isClosing) return;
      if (isBinary) { socket.close(1003, 'JSON text messages required'); return; }
      deliver(bridge, data.toString(), send, log);
    });
    socket.on('error', (error) => log(`WebSocket error: ${error.message}`));
    socket.once('close', () => {
      closeBridge().catch((error) => log(error.message));
    });
  });
  await new Promise((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(socketPath, resolveListen);
  });
  await chmod(socketPath, 0o600);
  const metadata = await lstat(socketPath);
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    isClosing = true;
    // Stop admission before awaiting slow Cursor shutdown. In-flight upgrades
    // are also rejected by the connection guard above and ws's closing state.
    const httpClosed = new Promise((resolveClose) => http.close(resolveClose));
    const websocketClosed = new Promise((resolveClose) => websocket.close(resolveClose));
    closePromise = Promise.resolve().then(async () => {
      try {
        const closingBridges = [...bridges.values()].map((closeBridge) => closeBridge());
        for (const client of websocket.clients) client.terminate();
        await Promise.allSettled(closingBridges);
        await websocketClosed;
        await httpClosed;
        const current = await socketExists(socketPath);
        if (current && current.ino === metadata.ino && current.dev === metadata.dev) await unlink(socketPath);
      } finally { await onClose(); }
    });
    return closePromise;
  };
  log(`Cursor bridge listening on ${socketPath}`);
  return { close, socketPath };
}
