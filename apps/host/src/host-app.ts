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
import { writeInstanceInfo } from './desktop-integration.js';
import {
  createGateway,
  deepLinkEvent,
  type GatewayHandle,
  type GatewayPickers,
} from './gateway.js';
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
  /** Native pickers — defaults to the zenity implementation. */
  pickers?: GatewayPickers;
  /** accomplish:// URL captured at CLI activation (no prior instance). */
  deepLinkUrl?: string;
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

  // Phase 3 M1 §5.2: the connector re-declares gateway identity (client
  // typing + UI-presence count) on every (re)connection. The gateway handle
  // doesn't exist until after the daemon connects, so the count supplier
  // closes over a reference that is assigned once the gateway is up.
  let gatewayRef: GatewayHandle | null = null;
  const connector = new DaemonConnector({
    dataDir: config.dataDir,
    daemonEntryPath: config.daemonEntryPath,
    nodeBin: config.nodeBin,
    appPath: config.appPath,
    expectedBuildId: options.expectedBuildId,
    logger,
    uiClientCount: () => gatewayRef?.uiPresenceCount() ?? 0,
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
    pickers: options.pickers,
    appPath: config.appPath,
  });

  // Publish the instance coordinates for the .desktop launcher hand-off
  // (single-instance detection + deep-link forwarding).
  writeInstanceInfo(config.dataDir, { port: gateway.port, pid: process.pid });

  // Deep link captured before the gateway existed (launcher activation on
  // a cold start) — dispatch now that WS clients can receive it.
  if (options.deepLinkUrl) {
    const event = deepLinkEvent(options.deepLinkUrl);
    if (event) {
      gateway.broadcastControl(event, { url: options.deepLinkUrl });
    }
  }

  registerNotificationForwarding(client, gateway);
  gatewayRef = gateway;
  // Heartbeat semantics (Phase 3 M1 §5.2): re-assert the browser-UI count
  // every 30 s while the daemon socket is up; disarm on daemon disconnect;
  // re-arm on reconnect. The connector's own identity handshake covers the
  // setClientType/'gateway' declaration on initial connect and reconnects.
  gateway.startPresenceHeartbeat();

  connector.onStateChange((state) => {
    if (state === 'disconnected') {
      gateway.stopPresenceHeartbeat();
      gateway.broadcastControl('daemon:disconnected');
    } else if (state === 'connected') {
      gateway.startPresenceHeartbeat();
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
