/**
 * Worker-scoped gateway boot chain (Phase 3 M5 plan §2).
 *
 * ONE real chain per test run, mirroring the proven boot pattern of
 * apps/host/__tests__/integration/gateway-daemon.test.ts but spawning the
 * built host as a CLI process so the suite exercises the exact launcher
 * contract (`ACCOMPLISH_GATEWAY_URL=` on stdout, index.ts:136):
 *
 *   node apps/host/dist/index.js --data-dir <tmp> --port 0 \
 *        --token <hex> --web-dist apps/web/dist/client
 *
 *   → host auto-spawns the daemon (daemon-connector.ts, per-dataDir
 *     single-instance) → poll daemon.ping through the gateway →
 *     setup-dev-provider.mjs configures the isolated daemon's ollama
 *     provider over its Unix socket.
 *
 * Never touches the production data dir (~/.local/share/Accomplish): the
 * data dir is an mkdtemp under /tmp/opencode/m5-e2e and every cleanup
 * needle matches that exact path.
 */

import { test as base, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

export const M5_BASE_DIR = '/tmp/opencode/m5-e2e';
const BOOT_TIMEOUT_MS = 90_000;
const DAEMON_READY_POLL_MS = 30_000;

export interface GatewayChain {
  gatewayUrl: string;
  appUrl: string;
  token: string;
  dataDir: string;
  rpcCall(method: string, params?: unknown): Promise<unknown>;
  openEvents(tokenOverride?: string): Promise<EventsSession>;
  cleanup(): Promise<void>;
}

export interface EventsSession {
  nextMessage(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

interface ProcessNeedles {
  /** Every needle must appear in the process cmdline. */
  cmdline: string[];
  /** Optional /proc/<pid>/environ needle (exact byte sequence). */
  environ?: string;
}

function findProcessPids(matchers: ProcessNeedles): number[] {
  const found: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc').filter((e) => /^\d+$/.test(e));
  } catch {
    return found;
  }
  for (const entry of entries) {
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      const commandMatched = matchers.cmdline.every((needle) => cmdline.includes(needle));
      if (!commandMatched) {
        continue;
      }
      if (matchers.environ !== undefined) {
        const environ = readFileSync(`/proc/${entry}/environ`);
        if (!environ.includes(Buffer.from(matchers.environ))) {
          continue;
        }
      }
      found.push(Number(entry));
    } catch {
      /* process vanished mid-sweep */
    }
  }
  return found;
}

function killPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Every pid that belongs to THIS chain: host/daemon by the data-dir cmdline
 * needle, plus opencode/dev-browser children via the XDG_DATA_HOME environ
 * needle they inherit from the daemon (m4-soak pattern).
 */
function sweepChainPids(dataDir: string): number[] {
  if (dataDir.includes('.local/share/Accomplish') || dataDir.includes('.accomplish')) {
    throw new Error(`refusing to sweep production-looking data dir: ${dataDir}`);
  }
  const pidSet = new Set<number>();
  for (const pid of findProcessPids({
    cmdline: ['--data-dir', dataDir, '/dist/index.js'],
  })) {
    pidSet.add(pid);
  }
  for (const pid of findProcessPids({
    cmdline: ['opencode'],
    environ: `XDG_DATA_HOME=${dataDir}`,
  })) {
    pidSet.add(pid);
  }
  for (const pid of findProcessPids({
    cmdline: ['dev-browser'],
    environ: `XDG_DATA_HOME=${dataDir}`,
  })) {
    pidSet.add(pid);
  }
  pidSet.delete(process.pid);
  return [...pidSet];
}

async function terminatePid(pid: number, waitMs = 5_000): Promise<void> {
  killPids([pid], 'SIGTERM');
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  killPids([pid], 'SIGKILL');
}

/** Pid recorded by the daemon in `<dataDir>/daemon.pid` ({ pid }) — if alive. */
function daemonPidFromPidFile(dataDir: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, 'daemon.pid'), 'utf8')) as {
      pid?: number;
    };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pids listening on `port` (TCP, IPv4 + IPv6) via /proc/net/tcp{,6} →
 * socket inode → /proc/<pid>/fd link scan — no external tools required.
 * The gateway is a loopback-only ephemeral-port listener, so the only
 * expected owner is this chain's host process; callers must still verify
 * the data-dir needle before killing (killPortListeners does).
 */
function findPortListenerPids(port: number): number[] {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const lines = readFileSync(table, 'utf8').split('\n');
      for (const line of lines.slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 10 || columns[3] !== '0A') {
          continue; // not LISTEN
        }
        const localAddress = columns[1] ?? '';
        const localPort = Number.parseInt(localAddress.split(':')[1] ?? 'ffff', 16);
        if (localPort === port && columns[9]) {
          inodes.add(columns[9]);
        }
      }
    } catch {
      /* table absent (IPv6 off) */
    }
  }
  if (inodes.size === 0) {
    return [];
  }
  const listeners: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc').filter((e) => /^\d+$/.test(e));
  } catch {
    return listeners;
  }
  for (const entry of entries) {
    try {
      const fds = readdirSync(`/proc/${entry}/fd`);
      for (const fd of fds) {
        const target = readlinkSync(`/proc/${entry}/fd/${fd}`);
        if (target.startsWith('socket:[') && inodes.has(target.slice(8, -1))) {
          listeners.push(Number(entry));
          break;
        }
      }
    } catch {
      /* process vanished mid-sweep */
    }
  }
  return listeners;
}

/**
 * Kill whatever still LISTENS on the gateway port — but ONLY if the owner
 * carries this chain's identity (data-dir cmdline needle or inherited
 * XDG_DATA_HOME environ needle). A listener matching neither is left
 * untouched and reported loudly: an ephemeral loopback port colliding with
 * a foreign listener would be a harness bug, not something to SIGKILL
 * blindly (production processes never carry our temp dataDir needle).
 */
async function killPortListeners(port: number, dataDir: string): Promise<void> {
  for (const pid of findPortListenerPids(port)) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const environ = readFileSync(`/proc/${pid}/environ`);
      const matchesDataDir =
        cmdline.includes(dataDir) || environ.includes(Buffer.from(`XDG_DATA_HOME=${dataDir}`));
      if (!matchesDataDir) {
        console.log(
          `[m5] WARNING: port ${port} listener pid=${pid} does NOT match the chain data dir — left untouched (cmdline: ${cmdline.slice(0, 120)})`,
        );
        continue;
      }
      console.log(`[m5] cleanup: killing gateway-port listener pid=${pid}`);
      await terminatePid(pid, 3_000);
    } catch {
      /* vanished mid-sweep */
    }
  }
}

async function rpcHttpRequest(
  gatewayUrl: string,
  token: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const res = await fetch(`${gatewayUrl}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { code?: number; message?: string };
  };
  if (body.error) {
    throw new Error(`RPC ${method} failed (${res.status}): ${body.error.message ?? 'unknown'}`);
  }
  return body.result;
}

export function gatewayAppUrl(gatewayUrl: string, token: string): string {
  return `${gatewayUrl}/#token=${encodeURIComponent(token)}`;
}

async function openEventsSession(gatewayUrl: string, token: string): Promise<EventsSession> {
  const wsUrl = `${gatewayUrl.replace(/^http/, 'ws')}/events`;
  const ws = new WebSocket(wsUrl);
  const queue: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  function dispatch(message: Record<string, unknown>): void {
    const index = waiters.findIndex((w) => w.predicate(message));
    if (index !== -1) {
      const waiter = waiters[index];
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  }

  return new Promise<EventsSession>((resolveAuth, rejectAuth) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });
    ws.on('message', (data) => {
      try {
        dispatch(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      } catch {
        /* non-JSON frame */
      }
    });
    ws.on('error', (err) => rejectAuth(err));
    ws.on('close', (code) => rejectAuth(new Error(`events socket closed (code ${code})`)));
    ws.on('message', function onAuth(data) {
      try {
        const message = JSON.parse(data.toString('utf8')) as { type?: string };
        if (message.type !== 'auth-ok') {
          return;
        }
        ws.removeListener('message', onAuth);
        resolveAuth({
          nextMessage(predicate, timeoutMs = 5_000) {
            const queuedIndex = queue.findIndex(predicate);
            if (queuedIndex !== -1) {
              return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
            }
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                const idx = waiters.findIndex((w) => w.resolve === resolve);
                if (idx !== -1) {
                  waiters.splice(idx, 1);
                }
                reject(new Error('timed out waiting for events message'));
              }, timeoutMs);
              waiters.push({ predicate, resolve, reject, timer });
            });
          },
          close() {
            for (const waiter of waiters) {
              clearTimeout(waiter.timer);
              waiter.reject(new Error('socket closed'));
            }
            waiters.length = 0;
            try {
              ws.close();
            } catch {
              /* already closed */
            }
          },
        });
      } catch {
        /* ignore parse errors during auth */
      }
    });
  });
}

function safeRead(filePath: string, maxBytes: number): string {
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.length > maxBytes ? content.slice(-maxBytes) : content;
  } catch {
    return '(no output)';
  }
}

interface BootOptions {
  dataDir: string;
  token: string;
  webDist: string;
  hostEntry: string;
  logDir: string;
}

async function bootChain(options: BootOptions): Promise<GatewayChain> {
  const { dataDir, token, webDist, hostEntry, logDir } = options;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const stdoutHandle = openSync(path.join(logDir, 'host-stdout.log'), 'a');
  const stderrHandle = openSync(path.join(logDir, 'host-stderr.log'), 'a');
  const child: ChildProcess = spawn(
    process.execPath,
    [hostEntry, '--data-dir', dataDir, '--port', '0', '--token', token, '--web-dist', webDist],
    {
      stdio: ['ignore', stdoutHandle, stderrHandle],
      env: { ...process.env },
    },
  );

  // Consume the stdout launcher contract.
  let gatewayUrl = '';
  const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
  const stdoutLogPath = path.join(logDir, 'host-stdout.log');
  while (Date.now() < bootDeadline && child.exitCode === null) {
    const stdout = safeRead(stdoutLogPath, 64 * 1024);
    const match = stdout.match(/ACCOMPLISH_GATEWAY_URL=(\S+)/);
    if (match) {
      // The contract URL carries the launch fragment and a trailing slash —
      // APIs use the normalized bare origin.
      gatewayUrl = match[1].split('#')[0].replace(/\/+$/, '');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!gatewayUrl) {
    await cleanupChainProcesses(child, dataDir);
    throw new Error(
      `Host never reported ACCOMPLISH_GATEWAY_URL within ${BOOT_TIMEOUT_MS} ms ` +
        `(exit code ${String(child.exitCode)}).\nstderr tail:\n` +
        safeRead(path.join(logDir, 'host-stderr.log'), 4_000),
    );
  }

  // Wait until the daemon answers through the gateway (the host spawn gives
  // the daemon ~10 s; poll generously).
  const rpcDeadline = Date.now() + DAEMON_READY_POLL_MS;
  let lastPingError: unknown = null;
  while (Date.now() < rpcDeadline) {
    try {
      const result = (await rpcHttpRequest(gatewayUrl, token, 'daemon.ping')) as {
        status?: string;
      };
      if (result && result.status === 'ok') {
        lastPingError = null;
        break;
      }
    } catch (err) {
      lastPingError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (lastPingError) {
    await cleanupChainProcesses(child, dataDir, gatewayUrl);
    throw new Error(`daemon.ping never became ready: ${String(lastPingError)}`);
  }

  // Configure the isolated daemon's ollama provider — the same proven M2/M4
  // operator-side socket setup. Requires the daemon live.
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'setup-dev-provider.mjs');
  try {
    execFileSync(
      process.execPath,
      [
        scriptPath,
        '--provider',
        'ollama',
        '--server-url',
        'http://127.0.0.1:11434',
        '--model',
        'glm-5.3:cloud',
        '--data-dir',
        dataDir,
      ],
      { timeout: 60_000, stdio: 'pipe' },
    );
  } catch (err) {
    await cleanupChainProcesses(child, dataDir, gatewayUrl);
    const detail = (err as { stdout?: string; stderr?: string; message?: string }).message ?? '';
    throw new Error(`setup-dev-provider.mjs failed: ${detail}`);
  }

  return {
    gatewayUrl,
    appUrl: gatewayAppUrl(gatewayUrl, token),
    token,
    dataDir,
    async rpcCall(method, params) {
      return rpcHttpRequest(gatewayUrl, token, method, params);
    },
    async openEvents(tokenOverride) {
      return openEventsSession(gatewayUrl, tokenOverride ?? token);
    },
    async cleanup() {
      await cleanupChainProcesses(child, dataDir, gatewayUrl);
    },
  };
}

async function cleanupChainProcesses(
  child: ChildProcess | null,
  dataDir: string,
  gatewayUrl = '',
): Promise<void> {
  // Refuse outright anything that looks like production data.
  if (dataDir.includes('.local/share/Accomplish') || dataDir.includes('.accomplish')) {
    throw new Error(`refusing to clean up production-looking data dir: ${dataDir}`);
  }
  // 1. Graceful host stop — SIGTERM triggers index.ts's shutdown path:
  //    app.stop() → connector.stop({shutdown:true}) → daemon.shutdown RPC.
  if (child && child.pid && child.exitCode === null) {
    await terminatePid(child.pid, 8_000);
  }
  // 2. Belt: kill the daemon by its pid file (the graceful RPC path may
  //    have failed; drain gives it a bounded grace before SIGKILL).
  const pidFilePid = daemonPidFromPidFile(dataDir);
  if (pidFilePid && pidFilePid !== process.pid && isPidAlive(pidFilePid)) {
    console.log(`[m5] cleanup: terminating daemon pid=${pidFilePid} (from daemon.pid)`);
    await terminatePid(pidFilePid, 5_000);
    if (isPidAlive(pidFilePid)) {
      killPids([pidFilePid], 'SIGKILL');
    }
  }
  // 3. Belt: anything still LISTENing on the gateway port (host or a
  //    leftover listener from the same chain only — see killPortListeners).
  const port = Number.parseInt(new URL(gatewayUrl).port, 10);
  if (Number.isInteger(port) && port > 0) {
    await killPortListeners(port, dataDir);
  }
  // 4. Sweeper: anything left referencing exactly this data dir (host/
  //    daemon by cmdline needle; opencode/dev-browser children via the
  //    XDG_DATA_HOME environ needle they inherit from the daemon —
  //    m4-soak pattern).
  killPids(sweepChainPids(dataDir), 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  killPids(sweepChainPids(dataDir), 'SIGKILL');
  // 5. Drop the temp data dir last (daemon.pid is gone by now). Keep it for
  //    forensics when M5_KEEP_DATADIR=1.
  if (process.env.M5_KEEP_DATADIR === '1') {
    console.log(`[m5] kept dataDir for forensics: ${dataDir}`);
    return;
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export interface WorkerFixtures {
  chain: GatewayChain;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- {} is Playwright's documented "no test fixtures" generic for test.extend
export const test = base.extend<{}, WorkerFixtures>({
  chain: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture functions must destructure ({} = no test fixtures)
    async ({}, use) => {
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
      const hostEntry = path.join(repoRoot, 'apps', 'host', 'dist', 'index.js');
      const daemonEntry = path.join(repoRoot, 'apps', 'daemon', 'dist', 'index.js');
      const webDist =
        process.env.M5_WEB_DIST ?? path.join(repoRoot, 'apps', 'web', 'dist', 'client');

      if (!existsSync(hostEntry)) {
        throw new Error(
          `Host not built: ${hostEntry} is missing. Run "pnpm -F @accomplish/host build" first.`,
        );
      }
      if (!existsSync(daemonEntry)) {
        throw new Error(
          `Daemon not built: ${daemonEntry} is missing. Run "pnpm -F @accomplish/daemon build" first.`,
        );
      }
      if (!existsSync(path.join(webDist, 'index.html'))) {
        throw new Error(
          `Web UI build missing at ${webDist} — build with "pnpm build:web" or point M5_WEB_DIST at a client build.`,
        );
      }

      mkdirSync(M5_BASE_DIR, { recursive: true });
      const logDir = mkdtempSync(path.join(M5_BASE_DIR, 'm5-logs-'));
      const dataDir = mkdtempSync(path.join(M5_BASE_DIR, 'm5-data-'));
      const token = randomBytes(32).toString('hex');

      let chain: GatewayChain | null = null;

      // Last-resort orphan guard when the worker is torn down by a signal
      // before fixture teardown runs. Synchronous /proc sweep, then exit.
      const signalHandler = (): void => {
        if (chain) {
          killPids(sweepChainPids(dataDir), 'SIGKILL');
          process.exit(1);
        }
      };
      process.on('SIGINT', signalHandler);
      process.on('SIGTERM', signalHandler);

      chain = await bootChain({ dataDir, token, webDist, hostEntry, logDir });
      await use(chain);
      if (chain) {
        const alive = chain;
        chain = null;
        await alive.cleanup();
      }
      process.off('SIGINT', signalHandler);
      process.off('SIGTERM', signalHandler);
      try {
        rmSync(logDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
    { scope: 'worker' },
  ],
});

export { expect };
