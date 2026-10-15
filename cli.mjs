#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { bridgeHome, controlSocketPath, parseListen, serveStdio, serveUnix } from './transport.mjs';

export function planCommand(args, env = process.env) {
  const home = bridgeHome(env);
  if (['install', 'doctor', 'upgrade', 'uninstall', 'install-skill'].includes(args[0])) {
    return { type: 'manage', args, home };
  }
  if (!env.CURSOR_BRIDGE_REAL_CODEX && (args[0] === 'help' || args[0] === '--help' || args[0] === '-h')) return { type: 'help', home };
  if (!env.CURSOR_BRIDGE_REAL_CODEX && args[0] === '--version') return { type: 'version', home };
  if (args[0] === 'bridge-import-history') {
    const options = {};
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === '--help' || argument === '-h') return { type: 'import-history-help', home };
      const match = argument.match(/^--(cwd|home)(?:=(.*))?$/);
      if (!match) throw new Error(`Unknown bridge-import-history argument: ${argument}`);
      const value = match[2] ?? args[++index];
      if (!value || value.startsWith('--')) throw new Error(`--${match[1]} requires a path`);
      options[match[1]] = resolve(value);
    }
    return { type: 'import-history', home, options };
  }
  const appIndex = args.indexOf('app-server');
  if (appIndex < 0 || args.includes('--help') || args.includes('-h')) return { type: 'delegate', args, home };
  const serverArgs = args.slice(appIndex + 1);
  const subcommand = serverArgs.find((arg) => ['proxy', 'daemon', 'generate-ts', 'generate-json-schema', 'generate-internal-json-schema', 'help'].includes(arg));
  if (subcommand === 'proxy') {
    const hasSocket = serverArgs.some((arg) => arg === '--sock' || arg.startsWith('--sock='));
    return { type: 'delegate', args: hasSocket ? args : [...args, '--sock', controlSocketPath(home)], home };
  }
  if (subcommand) return { type: 'delegate', args, home };
  return { type: 'serve', transport: parseListen(serverArgs, home), home };
}

async function delegate(args, env) {
  const executable = env.CURSOR_BRIDGE_REAL_CODEX || 'codex';
  if (resolve(executable) === resolve(fileURLToPath(import.meta.url))) throw new Error('CURSOR_BRIDGE_REAL_CODEX must point to the original Codex executable');
  const child = spawn(executable, args, { stdio: 'inherit', env });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const result = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const plan = planCommand(args, env);
  if (plan.type === 'help') {
    process.stdout.write('Cursor Agent → Codex desktop bridge (experimental)\n\nUsage: cursor-codex <command> [options]\n\n  install --ssh ALIAS       Deploy using an existing SSH connection\n  doctor --ssh ALIAS        Check prerequisites and installation without model calls\n  upgrade --ssh ALIAS       Deploy the version of this CLI, preserving history\n  uninstall --ssh ALIAS     Remove managed config/programs; retain history\n  install-skill             Install the optional local Codex installation skill\n\nOptions: --alias NAME --ssh-config PATH --dry-run --json\n         --node-path PATH --agent-path PATH --codex-path PATH\n         --skill-dir PATH (install-skill only)\n\nBridge runtime: cursor-codex app-server [--listen unix://]\n');
    return;
  }
  if (plan.type === 'version') {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`); return;
  }
  if (plan.type === 'manage') {
    const { managementMain } = await import('./installer/manage.mjs');
    return managementMain(plan.args, { env });
  }
  if (plan.type === 'import-history-help') {
    process.stdout.write('Usage: cursor-codex bridge-import-history [--cwd PATH] [--home PATH]\n\n--cwd filters Cursor workspaces. --home selects the source user home containing .cursor.\nCODEX_HOME selects the destination bridge store.\n');
    return;
  }
  const serviceEnv = { ...env, CODEX_HOME: plan.home };
  await mkdir(plan.home, { recursive: true, mode: 0o700 });
  if (plan.type === 'delegate') return delegate(plan.args, serviceEnv);
  process.env.CODEX_HOME = plan.home;
  if (plan.type === 'import-history') {
    const { importCursorHistory } = await import('./bridge.mjs');
    const mappings = await importCursorHistory(plan.options);
    process.stdout.write(`${JSON.stringify(mappings)}\n`);
    process.stderr.write('[cursor-bridge] Restart the running bridge service to load imported history.\n');
    return;
  }
  // SSH may close stderr together with its input; logging must not prevent cleanup.
  process.stderr.on('error', () => {});
  const log = (message) => {
    if (!process.stderr.destroyed) process.stderr.write(`[cursor-bridge] ${message}\n`);
  };
  const { createBridge, shutdownBridge } = await import('./bridge.mjs');
  let server;
  try {
    server = plan.transport.type === 'stdio'
      ? serveStdio({ createBridge, log, onClose: shutdownBridge })
      : await serveUnix({ socketPath: plan.transport.path, createBridge, log, onClose: shutdownBridge });
  } catch (error) {
    await shutdownBridge();
    throw error;
  }
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      Promise.resolve(server.close()).then(() => { process.exitCode = 0; }).catch((error) => {
        log(error.stack || error.message);
        process.exitCode = 1;
      });
    });
  }
}

// npm/npx invokes bins through a symlink in node_modules/.bin.
const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[cursor-bridge] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
