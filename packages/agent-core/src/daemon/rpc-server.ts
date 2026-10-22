/**
 * DaemonRpcServer
 *
 * A Unix socket (or Windows named pipe) based JSON-RPC 2.0 server for the
 * standalone daemon process. Accepts multiple client connections and dispatches
 * registered method handlers.
 *
 * Unlike the in-process `DaemonServer`, this class is intentionally loosely
 * typed so that it can serve any JSON-RPC method without requiring every
 * method to be pre-declared in `DaemonMethodMap`.
 *
 * ESM module — use .js extensions on imports.
 */

import { chmodSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { getSocketPath } from './socket-path.js';
import { handleRpcLine, type AnyMethodHandler } from './rpc-message-handler.js';

export interface DaemonRpcServerOptions {
  /** Override the default Unix socket / named pipe path. */
  socketPath?: string;
  onConnection?: (clientId: string) => void;
  onDisconnection?: (clientId: string) => void;
}

/**
 * How long a gateway-typed client's last UI-presence report stays trusted.
 * Covers the host-crash failure mode: heartbeat stops → presence expires
 * ~90 s later instead of granting interactive presence forever.
 */
export const STALE_MS = 90_000;

/** Who a connected socket client is. `legacy` = trusted-shell clients
 *  (Electron main, CLI tools) whose connection itself implies UI presence;
 *  `gateway` = the host process, which must explicitly report browser UI
 *  counts. Clients default to `legacy` until they say otherwise. */
export type RpcClientType = 'legacy' | 'gateway';

interface RpcClientPresenceState {
  clientType: RpcClientType;
  /** Last browser-UI count reported by a gateway-typed client. */
  reportedCount: number;
  /** Timestamp of the last accepted presence report. */
  lastUpdate: number;
}

interface ConnectedClient {
  id: string;
  socket: Socket;
  buffer: string;
}

export class DaemonRpcServer {
  private readonly socketPath: string;
  private readonly onConnection?: (clientId: string) => void;
  private readonly onDisconnection?: (clientId: string) => void;

  private server: Server | null = null;
  private clients = new Map<string, ConnectedClient>();
  /**
   * Per-connection presence metadata. Bound to the exact socket client id so
   * a disconnect or error removes the client's count contribution instantly
   * (a crashed host cannot leave stale presence behind).
   */
  private presence = new Map<string, RpcClientPresenceState>();
  private handlers = new Map<string, AnyMethodHandler>();
  private startTime = Date.now();

  constructor(options: DaemonRpcServerOptions = {}) {
    this.socketPath = options.socketPath ?? getSocketPath();
    this.onConnection = options.onConnection;
    this.onDisconnection = options.onDisconnection;

    // Register built-in health check (buildId used for version-guard on app upgrade)
    this.registerMethod('daemon.ping', () => ({
      status: 'ok' as const,
      uptime: Date.now() - this.startTime,
      buildId: process.env.ACCOMPLISH_BUILD_ID,
    }));
  }

  /**
   * Register a handler for a JSON-RPC method.
   */
  registerMethod(method: string, handler: AnyMethodHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Whether any clients are currently connected.
   * Used to fast-fail permission requests when no UI can respond.
   */
  hasConnectedClients(): boolean {
    for (const client of this.clients.values()) {
      if (!client.socket.destroyed) {
        return true;
      }
    }
    return false;
  }

  /**
   * Classify a connected socket client as `gateway` or `legacy`.
   * Clients that never call `daemon.setClientType` stay `legacy`, which
   * preserves the historical semantics: any connected client (Electron main,
   * CLI tooling) implies an addressable UI. Called once per socket
   * connection by the host, and again after every reconnect (a reconnect is
   * a brand-new connection with fresh state).
   */
  setClientType(clientId: string, clientType: RpcClientType): void {
    const existing = this.presence.get(clientId);
    if (existing) {
      // A re-typed connection must not carry stale count state across the
      // transition — the new identity starts with a clean presence slate.
      existing.clientType = clientType;
      existing.reportedCount = 0;
      return;
    }
    this.presence.set(clientId, { clientType, reportedCount: 0, lastUpdate: 0 });
  }

  /**
   * Record a UI-presence report from a gateway-typed client. The state is
   * bound to THAT socket client connection; reports from clients that have
   * not typed themselves as `gateway` are ignored (only the host gateway may
   * speak for browser UIs).
   */
  setUiPresence(clientId: string, count: number): void {
    const state = this.presence.get(clientId);
    if (!state || state.clientType !== 'gateway') {
      return;
    }
    state.reportedCount = count;
    state.lastUpdate = Date.now();
  }

  /**
   * Whether an interactive UI could answer a permission prompt right now:
   * any connected legacy client (trusted-shell semantics — Electron main),
   * OR any gateway-typed client reporting a live browser-UI count that is
   * still fresh (younger than STALE_MS). The gateway's own persistent socket
   * never counts as UI presence on its own.
   */
  hasInteractiveClients(): boolean {
    for (const client of this.clients.values()) {
      if (client.socket.destroyed) {
        continue;
      }
      const state = this.presence.get(client.id);
      if (!state || state.clientType === 'legacy') {
        return true;
      }
      if (state.reportedCount > 0 && Date.now() - state.lastUpdate <= STALE_MS) {
        return true;
      }
    }
    return false;
  }

  /**
   * Drop a client's connection state. Called on close/error so a gateway
   * client's last reported count stops counting the instant its socket is
   * gone.
   */
  private dropClient(clientId: string): void {
    this.clients.delete(clientId);
    this.presence.delete(clientId);
  }

  /**
   * Push a notification to all connected clients.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notify(method: string, params: any): void {
    const notification = { jsonrpc: '2.0' as const, method, params };
    const data = JSON.stringify(notification) + '\n';
    for (const client of this.clients.values()) {
      if (!client.socket.destroyed) {
        client.socket.write(data);
      }
    }
  }

  /**
   * Start listening on the socket path.
   * Removes any stale socket file before binding.
   */
  async start(): Promise<void> {
    // Remove stale socket
    await this.removeStaleSocket();

    return new Promise<void>((resolve, reject) => {
      this.server = createServer((socket) => {
        const clientId = randomUUID();
        const client: ConnectedClient = { id: clientId, socket, buffer: '' };
        this.clients.set(clientId, client);
        this.onConnection?.(clientId);

        socket.setEncoding('utf8');

        socket.on('data', (chunk: string) => {
          client.buffer += chunk;
          const lines = client.buffer.split('\n');
          client.buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              void handleRpcLine(client, trimmed, this.handlers);
            }
          }
        });

        socket.on('close', () => {
          this.dropClient(clientId);
          this.onDisconnection?.(clientId);
        });

        socket.on('error', (err) => {
          console.error(`[DaemonRpcServer] Socket error for client ${clientId}:`, err.message);
          // Silent drop (no onDisconnection): the subsequent 'close' event is
          // the single authoritative teardown signal, matching pre-presence
          // behaviour. Presence state must go now — a client that errored
          // must not keep counting toward interactive presence even for the
          // instant before its close event lands.
          this.dropClient(clientId);
        });
      });

      this.server.on('error', reject);

      this.server.listen(this.socketPath, () => {
        this.restrictSocketPermissions();
        resolve();
      });
    });
  }

  /**
   * Mode 0600 on the Unix socket. The daemon socket is a trusted-control
   * surface (the host identifies itself and reports UI presence over it) —
   * it must only be reachable by the same user. POSIX only; Windows named
   * pipes have their own ACL model, so skip there. Warns non-fatally:
   * a failed chmod must not take the daemon down.
   */
  private restrictSocketPermissions(): void {
    if (process.platform === 'win32') {
      return;
    }
    try {
      chmodSync(this.socketPath, 0o600);
    } catch (err) {
      console.warn(
        `[DaemonRpcServer] Failed to chmod 600 socket ${this.socketPath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Stop the server and disconnect all clients.
   */
  async stop(): Promise<void> {
    for (const client of this.clients.values()) {
      client.socket.destroy();
    }
    this.clients.clear();
    this.presence.clear();

    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private async removeStaleSocket(): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    try {
      await unlink(this.socketPath);
    } catch {
      // File doesn't exist — that's fine
    }
  }
}
