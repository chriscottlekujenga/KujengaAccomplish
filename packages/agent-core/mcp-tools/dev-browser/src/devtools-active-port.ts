/**
 * Reader for Chrome's DevToolsActivePort file.
 *
 * When Chromium is launched with `--remote-debugging-port=0` (Phase 3 M1 §5.3
 * — no fixed, unauthenticated CDP port), it picks an ephemeral port and
 * persists the actual endpoint into `DevToolsActivePort` inside the
 * user-data-dir: line 1 is the port, line 2 is the browser-target path
 * (`/devtools/browser/<uuid>`). Chrome deletes the file on exit.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export interface DevToolsActivePortInfo {
  port: number;
  browserPath: string;
}

/**
 * Poll for the DevToolsActivePort file the child Chrome process writes.
 * Throws if the file does not appear (and parse) before timeout.
 */
export async function readDevToolsActivePort(
  userDataDir: string,
  timeoutMs = 20000,
  pollIntervalMs = 100,
): Promise<DevToolsActivePortInfo> {
  const filePath = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      try {
        const content = (await readFile(filePath, 'utf8')).trim();
        const [portLine, pathLine] = content.split('\n');
        const port = parseInt(portLine, 10);
        const browserPath = (pathLine ?? '').trim();
        if (Number.isInteger(port) && port > 0 && port < 65536 && browserPath.startsWith('/')) {
          return { port, browserPath };
        }
      } catch {
        // File may be mid-write by Chrome — keep polling until the deadline.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for DevToolsActivePort (CDP endpoint file) at ${filePath}. ` +
      'Chromium must be launched with --remote-debugging-port=0 for the ephemeral-port flow.',
  );
}
