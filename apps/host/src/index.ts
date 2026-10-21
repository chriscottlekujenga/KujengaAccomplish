/**
 * Host entry point — starts the gateway and prints the launch URL.
 *
 * Phase 1 intentionally stops here: opening Firefox, registering the
 * accomplish:// scheme handler, and systemd integration land in Phase 2
 * (FIREFOX_MIGRATION_PLAN §9). For now the launcher contract is the
 * stdout line `ACCOMPLISH_GATEWAY_URL=<url>` followed by a human-readable
 * hint, so any future launcher (or a dev) can pick the URL up mechanically.
 */

import { startHostApp } from './host-app.js';
import { parseHostArgs } from './config.js';
import { createConsoleLogger } from './logger.js';

async function main(): Promise<void> {
  const args = parseHostArgs();
  const logger = createConsoleLogger();

  const app = await startHostApp({ ...args, logger });

  logger.info(`Gateway ready — open in Firefox:`);
  logger.info(app.appUrl);
  // Machine-readable launcher contract (Phase 2 picks this up).
  process.stdout.write(`ACCOMPLISH_GATEWAY_URL=${app.appUrl}\n`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down`);
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
