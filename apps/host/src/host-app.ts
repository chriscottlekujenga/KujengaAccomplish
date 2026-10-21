/**
 * Host App — wires the daemon connector and the browser gateway together.
 *
 * Startup: ensure data dir → resolve/persist session token → connect (or
 * spawn) the daemon → start the gateway → forward every daemon notification
 * to authenticated WebSocket clients. Daemon reconnects transparently swap
 * the RPC client and re-register forwarding, mirroring the Electron shell's
 * notification forwarder (daemon-bootstrap.ts).
 */

import { chmodSync, writeFileSync } from 'node:fs';
import type { DaemonClient } from '@accomplish_ai/agent-core/desktop-main';
import {
  HOST_VERSION,
  ensureDataDir,
  resolveHostConfig,
  type HostArgs,
  type HostConfig,
} from './config.js';
import { DaemonConnector, type DaemonConnectorOptions } from './daemon-connector.js';
import { createGateway, type GatewayHandle } from './gateway.js';
import { createConsoleLogger, type HostLogger } from './logger.js';
import type { RateLimiterOptions } from './rate-limit.js';

/**
 * Every notification method the daemon can push (DaemonNotificationMap).
 * The connector subscribes to each on the current client; reconnects
 * re-register against the new client.
 */
export const NOTIFICATION_METHODS: readonly string[] = [
  'task.progress',
  'task.message',
  'task.statusChange',
  'task.summary',
  'task.complete',
  'task.error',
  'permission.request',
  'todo.update',
  'auth.error',
  'browser.frame',
  'accomplish-ai.usage-update',
  'whatsapp.qr',
  'whatsapp.status',
  'settings.changed',
  'workspace.changed',
  'gwsAccount.statusChanged',
  'skills.changed',
];

export interface StartHostOptions extends HostArgs {
  logger?: HostLogger;
  expectedBuildId?: string;
  rateLimiterOptions?: RateLimiterOptions;
  openExternalImpl?: (url: string) => Promise<void>;
  /** Reconnect/poll tuning — tests shorten the backoff windows. */
  connectorOptions?: Pick<
    DaemonConnectorOptions,
    | 'reconnectInitialMs'
    | 'reconnectMaxMs'
    | 'reconnectMaxAttempts'
    | 'readyTimeoutMs'
    | 'pollIntervalMs'
    | 'loginRetryDelayMs'
  >;
}

export interface HostApp {
  config: HostConfig;
  gateway: GatewayHandle;
  connector: DaemonConnector;
  client: DaemonClient;
  /** URL a browser should load (token travels in the fragment). */
  appUrl: string;
  stop(): Promise<void>;
}

export async function startHostApp(options: StartHostOptions = {}): Promise<HostApp> {
  const logger = options.logger ?? createConsoleLogger();
  const config = resolveHostConfig(options);

  ensureDataDir(config.dataDir);

  // Persist the session token for the Phase 2 launcher (systemd/Firefox
  // restart hand-off). 0600 — same sensitivity class as the daemon socket.
  writeFileSync(config.tokenFile, `${config.token}\n`, { mode: 0o600 });
  try {
    chmodSync(config.tokenFile, 0o600);
  } catch {
    /* best-effort on filesystems without POSIX modes */
  }

  const connector = new DaemonConnector({
    dataDir: config.dataDir,
    daemonEntryPath: config.daemonEntryPath,
    nodeBin: config.nodeBin,
    expectedBuildId: options.expectedBuildId,
    logger,
    ...options.connectorOptions,
  });
  const client = await connector.start();

  const gateway = await createGateway({
    port: config.port,
    token: config.token,
    webDist: config.webDist,
    rpc: {
      call: (method, params) => {
        const current = connector.getClient() ?? client;
        return current.call(method as never, params as never);
      },
    },
    version: HOST_VERSION,
    logger,
    rateLimiterOptions: options.rateLimiterOptions,
    openExternalImpl: options.openExternalImpl,
  });

  registerNotificationForwarding(client, gateway);

  connector.onStateChange((state) => {
    if (state === 'disconnected') {
      gateway.broadcastControl('daemon:disconnected');
    }
  });
  connector.onClientReplaced((newClient) => {
    registerNotificationForwarding(newClient, gateway);
    gateway.broadcastControl('daemon:reconnected');
  });
  connector.onReconnectFailed(() => {
    gateway.broadcastControl('daemon:reconnect-failed');
  });

  return {
    config,
    gateway,
    connector,
    client,
    appUrl: `http://127.0.0.1:${gateway.port}/#token=${encodeURIComponent(config.token)}`,
    async stop(): Promise<void> {
      await gateway.close();
      await connector.stop({ shutdown: true });
    },
  };
}

function registerNotificationForwarding(client: DaemonClient, gateway: GatewayHandle): void {
  for (const method of NOTIFICATION_METHODS) {
    client.onNotification(method as never, (params) => {
      gateway.broadcastNotification(method, params);
    });
  }
}
