/**
 * Daemon Connector (host port)
 *
 * Ported from `apps/desktop/src/main/daemon/daemon-connector.ts` with all
 * Electron dependencies removed. The host is a plain Node process, so:
 *   - data-dir comes from config (XDG default), not `app.getPath('userData')`
 *   - the Node binary is `process.execPath` (or an explicit/env override),
 *     never Electron-as-Node — the daemon's better-sqlite3 is built against
 *     the normal Node ABI (M6 invariant)
 *   - reconnection state changes are surfaced via callbacks instead of
 *     `webContents.send` broadcasts
 *
 * Behaviour preserved from the desktop connector:
 *   - connect → ping (+ optional build-id guard) → short login-item retry →
 *     spawn detached (survives host exit) → poll until ready
 *   - build-id mismatch: shutdown old daemon, wait for exit, respawn
 *   - disconnect → exponential backoff (200ms→5s, 10 attempts) → respawn
 *   - suppressReconnect()/enableReconnect() bracket intentional stops
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DaemonClient,
  createSocketTransport,
  getPidFilePath,
  getSocketPath,
} from '@accomplish_ai/agent-core/desktop-main';
import type { HostLogger } from './logger.js';

export const SPAWN_READY_TIMEOUT_MS = 10_000;
export const POLL_INTERVAL_MS = 200;
export const LOGIN_ITEM_RETRY_DELAY_MS = 500;
export const RECONNECT_INITIAL_MS = 200;
export const RECONNECT_MAX_MS = 5_000;
export const RECONNECT_MAX_ATTEMPTS = 10;
const DRAIN_TIMEOUT_MS = 30_000;

type SocketTransport = Awaited<ReturnType<typeof createSocketTransport>>;

interface DaemonConnection {
  client: DaemonClient;
  transport: SocketTransport;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, args as string[], options);

export interface DaemonConnectorOptions {
  dataDir: string;
  daemonEntryPath: string;
  nodeBin: string;
  /**
   * Repo root (ACCOMPLISH_APP_PATH) so the daemon resolves the bundled
   * opencode CLI in dev mode.
   */
  appPath?: string;
  /** When set, a reachable daemon with a different buildId is restarted. */
  expectedBuildId?: string;
  logger?: HostLogger;
  /** Test injection points. */
  spawnFn?: SpawnFn;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  loginRetryDelayMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  reconnectMaxAttempts?: number;
}

export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

/**
 * Error thrown when a stale daemon could not be stopped during a
 * version-guard restart.
 */
export class DaemonRestartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonRestartError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the daemon process to exit by polling the PID file.
 * Throws DaemonRestartError if the daemon doesn't exit within timeoutMs.
 */
async function waitForDaemonExit(dataDir: string, timeoutMs: number): Promise<void> {
  const pidPath = getPidFilePath(dataDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(pidPath)) {
      return;
    }
    try {
      const content = fs.readFileSync(pidPath, 'utf8');
      const { pid } = JSON.parse(content) as { pid: number };
      process.kill(pid, 0);
      await sleep(200);
    } catch {
      return;
    }
  }
  throw new DaemonRestartError(
    'Old daemon did not exit within 30s after shutdown request. Please restart the application.',
  );
}

export class DaemonConnector {
  private connection: DaemonConnection | null = null;
  private reconnecting = false;
  private reconnectSuppressed = false;
  private stopped = false;
  private stateHandler: ((state: ConnectionState) => void) | null = null;
  private clientReplacedHandler: ((client: DaemonClient) => void) | null = null;
  private reconnectFailedHandler: (() => void) | null = null;

  constructor(private readonly opts: DaemonConnectorOptions) {}

  getClient(): DaemonClient | null {
    return this.connection?.client ?? null;
  }

  onStateChange(handler: (state: ConnectionState) => void): void {
    this.stateHandler = handler;
  }

  onClientReplaced(handler: (client: DaemonClient) => void): void {
    this.clientReplacedHandler = handler;
  }

  onReconnectFailed(handler: () => void): void {
    this.reconnectFailedHandler = handler;
  }

  suppressReconnect(): void {
    this.reconnectSuppressed = true;
  }

  enableReconnect(): void {
    this.reconnectSuppressed = false;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    const l = this.opts.logger;
    if (l) {
      l[level](`[daemon-connector] ${msg}`);
    }
  }

  private async tryConnect(dataDir: string): Promise<DaemonConnection | null> {
    let transport: SocketTransport | null = null;
    try {
      transport = await createSocketTransport({ dataDir, connectTimeout: 2000 });
      const client = new DaemonClient({ transport });
      await client.ping();
      return { client, transport };
    } catch {
      if (transport) {
        transport.close();
      }
      return null;
    }
  }

  /**
   * Connect, then verify build identity. A reachable daemon with a
   * mismatched buildId is shut down and waited on so the caller can spawn a
   * fresh one. When no expectedBuildId is configured the guard is skipped.
   */
  private async tryConnectBuildChecked(dataDir: string): Promise<DaemonConnection | null> {
    const connection = await this.tryConnect(dataDir);
    if (!connection) {
      return null;
    }
    const { client } = connection;
    try {
      if (this.opts.expectedBuildId === undefined) {
        return connection;
      }
      const pingResult = await client.ping();
      if (pingResult.buildId === this.opts.expectedBuildId) {
        return connection;
      }
      this.log(
        'info',
        `Build mismatch: daemon=${pingResult.buildId ?? 'none'}, host=${this.opts.expectedBuildId}. Restarting daemon...`,
      );
      await client.call('daemon.shutdown').catch(() => {});
      client.close();
      await waitForDaemonExit(dataDir, DRAIN_TIMEOUT_MS);
      return null;
    } catch (err) {
      client.close();
      if (err instanceof DaemonRestartError) {
        throw err;
      }
      return null;
    }
  }

  /**
   * Spawn the daemon fully detached so it survives host exit. Output goes to
   * a date-rotated log under `<dataDir>/logs/` — identical to the desktop
   * connector — because a silent daemon crash is undebuggable otherwise.
   */
  spawnDaemon(dataDir: string): ChildProcess {
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (this.opts.expectedBuildId !== undefined) {
      env.ACCOMPLISH_BUILD_ID = this.opts.expectedBuildId;
    }
    // Credential isolation: opencode's auth.json and app data live under
    // XDG_DATA_HOME, so scoping it to the data dir keeps the shell's keys
    // separate from any other opencode installation (and separate from the
    // Electron shell's profile during the migration).
    env.XDG_DATA_HOME = dataDir;
    if (this.opts.appPath !== undefined) {
      env.ACCOMPLISH_APP_PATH = this.opts.appPath;
    }

    const logPath = getDaemonLogPath(dataDir);
    const logFd = fs.openSync(logPath, 'a');
    try {
      const child = spawnFn(this.opts.nodeBin, [this.opts.daemonEntryPath, '--data-dir', dataDir], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env,
      });
      child.unref();
      this.log('info', `Daemon spawned (detached, pid=${child.pid})`);
      return child;
    } finally {
      fs.closeSync(logFd);
    }
  }

  private async waitForDaemon(dataDir: string, timeoutMs: number): Promise<DaemonConnection> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const connection = await this.tryConnect(dataDir);
      if (connection) {
        return connection;
      }
      await sleep(this.opts.pollIntervalMs ?? POLL_INTERVAL_MS);
    }
    throw new Error(
      `Daemon did not become ready within ${timeoutMs}ms. Socket path: ${getSocketPath(dataDir)}`,
    );
  }

  /**
   * Ensure a daemon is running and return a connected client, wiring
   * disconnect-driven reconnection on the transport.
   */
  async start(): Promise<DaemonClient> {
    const dataDir = this.opts.dataDir;
    const existing = await this.tryConnectBuildChecked(dataDir);
    if (existing) {
      this.log('info', 'Connected to existing daemon');
      return this.adopt(existing);
    }
    await sleep(this.opts.loginRetryDelayMs ?? LOGIN_ITEM_RETRY_DELAY_MS);
    const retried = await this.tryConnectBuildChecked(dataDir);
    if (retried) {
      this.log('info', 'Connected to daemon (login item)');
      return this.adopt(retried);
    }
    this.log('info', 'Spawning new daemon...');
    this.spawnDaemon(dataDir);
    const connection = await this.waitForDaemon(
      dataDir,
      this.opts.readyTimeoutMs ?? SPAWN_READY_TIMEOUT_MS,
    );
    this.log('info', 'Connected to newly spawned daemon');
    return this.adopt(connection);
  }

  private adopt(connection: DaemonConnection): DaemonClient {
    this.connection = connection;
    this.setupDisconnectHandler(connection);
    return connection.client;
  }

  private setupDisconnectHandler(connection: DaemonConnection): void {
    connection.transport.onDisconnect(() => {
      if (this.reconnecting || this.reconnectSuppressed || this.stopped) {
        return;
      }
      this.reconnecting = true;
      this.log('warn', 'Daemon disconnected — starting reconnection...');
      this.stateHandler?.('disconnected');
      void this.reconnectWithBackoff().finally(() => {
        this.reconnecting = false;
      });
    });
  }

  private async reconnectWithBackoff(): Promise<void> {
    const initial = this.opts.reconnectInitialMs ?? RECONNECT_INITIAL_MS;
    const max = this.opts.reconnectMaxMs ?? RECONNECT_MAX_MS;
    const attempts = this.opts.reconnectMaxAttempts ?? RECONNECT_MAX_ATTEMPTS;
    let delay = initial;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.reconnectSuppressed || this.stopped) {
        this.log('info', 'Reconnect loop cancelled (suppressed)');
        return;
      }
      this.stateHandler?.('reconnecting');
      await sleep(delay);
      if (this.reconnectSuppressed || this.stopped) {
        this.log('info', 'Reconnect loop cancelled after delay (suppressed)');
        return;
      }

      let connection: DaemonConnection | null = null;
      try {
        connection = await this.tryConnectBuildChecked(this.opts.dataDir);
      } catch (err) {
        if (err instanceof DaemonRestartError) {
          this.log('error', String(err));
          this.reconnectFailedHandler?.();
          return;
        }
      }

      if (connection) {
        this.log('info', 'Reconnected to daemon');
        this.adopt(connection);
        this.stateHandler?.('connected');
        this.clientReplacedHandler?.(connection.client);
        return;
      }
      delay = Math.min(delay * 2, max);
    }

    if (this.reconnectSuppressed || this.stopped) {
      return;
    }

    this.log('warn', 'All reconnect attempts failed — spawning new daemon...');
    this.spawnDaemon(this.opts.dataDir);
    try {
      const connection = await this.waitForDaemon(
        this.opts.dataDir,
        this.opts.readyTimeoutMs ?? SPAWN_READY_TIMEOUT_MS,
      );
      this.log('info', 'Connected to newly spawned daemon after reconnect');
      this.adopt(connection);
      this.stateHandler?.('connected');
      this.clientReplacedHandler?.(connection.client);
    } catch (err) {
      this.log('error', `Failed to reconnect: ${String(err)}`);
      this.reconnectFailedHandler?.();
    }
  }

  /**
   * Stop using the daemon. `shutdown: true` asks the daemon to drain and
   * exit first (graceful, 30s drain window handled daemon-side). Reconnect
   * is suppressed so the intentional stop is not fought by the backoff loop.
   */
  async stop(options: { shutdown?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.suppressReconnect();
    const client = this.connection?.client ?? null;
    this.connection = null;
    if (!client) {
      return;
    }
    if (options.shutdown) {
      await client.call('daemon.shutdown').catch(() => {});
    }
    client.close();
  }
}

/**
 * Path to today's daemon log file, with best-effort cleanup of logs older
 * than 7 days — mirrors the desktop connector exactly.
 */
export function getDaemonLogPath(dataDir: string): string {
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(logsDir, `daemon-${today}.log`);
  try {
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => f.startsWith('daemon-') && f.endsWith('.log'));
    if (files.length > 7) {
      files.sort();
      for (const old of files.slice(0, files.length - 7)) {
        fs.unlinkSync(path.join(logsDir, old));
      }
    }
  } catch {
    /* best-effort cleanup */
  }
  return logPath;
}
