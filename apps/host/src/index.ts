/**
 * Host entry point — CLI orchestration for the Firefox shell.
 *
 * Phase 2 responsibilities (FIREFOX_MIGRATION_PLAN §9):
 *   - `--install-desktop` / `--uninstall-desktop`: .desktop launcher and
 *     accomplish:// scheme registration
 *   - `--enable-autostart` / `--disable-autostart`: systemd user unit for
 *     the daemon (start at login)
 *   - `--launch` (optionally `--kiosk`): open Firefox at the gateway URL
 *   - single-instance: a second activation forwards its accomplish:// deep
 *     link to the running gateway or just re-opens Firefox
 *
 * Machine-readable launcher contract (kept from Phase 1):
 * `ACCOMPLISH_GATEWAY_URL=<url>` on stdout after startup.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ensureDataDir,
  parseHostArgs,
  resolveDefaultDaemonEntryPath,
  resolveHostConfig,
} from './config.js';
import {
  DESKTOP_FILE_NAME,
  findExistingInstance,
  forwardDeepLink,
  installDesktopIntegration,
  uninstallDesktopIntegration,
} from './desktop-integration.js';
import { installDaemonService, uninstallDaemonService } from './daemon-service.js';
import { launchFirefox } from './firefox-launcher.js';
import { startHostApp, type HostApp } from './host-app.js';
import { createConsoleLogger } from './logger.js';

/** Built host entry referenced by the .desktop Exec — resolvable from src/ or dist/. */
const HOST_ENTRY_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');

/** Repo icon referenced by the .desktop entry (copied verbatim, not modified). */
const ICON_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'web',
  'public',
  'assets',
  'accomplish-icon.png',
);

function readPersistedToken(dataDir: string): string | null {
  try {
    const token = readFileSync(path.join(dataDir, 'gateway-token'), 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseHostArgs();
  const logger = createConsoleLogger();
  const config = resolveHostConfig(args);

  // ── Desktop-integration management commands (then exit) ──
  if (args.installDesktop) {
    ensureDataDir(config.dataDir);
    installDesktopIntegration({
      dataDir: config.dataDir,
      nodeBin: config.nodeBin,
      hostEntryPath: HOST_ENTRY_PATH,
      webDist: config.webDist,
      iconPath: ICON_PATH,
    });
    logger.info(`Desktop launcher installed (${DESKTOP_FILE_NAME}, accomplish:// scheme)`);
    return;
  }
  if (args.uninstallDesktop) {
    uninstallDesktopIntegration({
      dataDir: config.dataDir,
      nodeBin: config.nodeBin,
      hostEntryPath: HOST_ENTRY_PATH,
      webDist: config.webDist,
      iconPath: ICON_PATH,
    });
    logger.info('Desktop launcher removed');
    return;
  }
  if (args.enableAutostart) {
    ensureDataDir(config.dataDir);
    installDaemonService({
      dataDir: config.dataDir,
      nodeBin: config.nodeBin,
      daemonEntryPath: args.daemonEntryPath ?? resolveDefaultDaemonEntryPath(),
      appPath: config.appPath,
    });
    logger.info('Daemon systemd user service installed and started');
    return;
  }
  if (args.disableAutostart) {
    uninstallDaemonService({
      dataDir: config.dataDir,
      nodeBin: config.nodeBin,
      daemonEntryPath: args.daemonEntryPath ?? resolveDefaultDaemonEntryPath(),
      appPath: config.appPath,
    });
    logger.info('Daemon systemd user service removed');
    return;
  }

  // ── Single-instance hand-off ──
  const existing = await findExistingInstance(config.dataDir);
  if (existing) {
    const token = readPersistedToken(config.dataDir) ?? config.token;
    if (args.deepLinkUrl) {
      const forwarded = await forwardDeepLink(existing.port, token, args.deepLinkUrl);
      logger.info(forwarded ? 'Deep link forwarded to running instance' : 'Deep link ignored');
      return;
    }
    const url = `http://127.0.0.1:${existing.port}/#token=${encodeURIComponent(token)}`;
    launchFirefox(url, { kiosk: args.kiosk });
    logger.info(`Re-using running gateway: ${url}`);
    return;
  }

  // ── Normal start ──
  const app: HostApp = await startHostApp({
    ...args,
    deepLinkUrl: args.deepLinkUrl,
    logger,
  });

  logger.info('Gateway ready — open in Firefox:');
  logger.info(app.appUrl);
  // Machine-readable launcher contract.
  process.stdout.write(`ACCOMPLISH_GATEWAY_URL=${app.appUrl}\n`);

  if (args.launch) {
    launchFirefox(app.appUrl, { kiosk: args.kiosk });
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down (daemon keeps running)`);
    void app
      .stop()
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

main().catch((err) => {
  console.error('[host] Fatal startup error:', err);
  process.exit(1);
});
