/**
 * OpenCode CLI status — host-side replacement for the Electron
 * `opencode:check` IPC handler. Resolves the CLI the same way the daemon
 * will (repo-local node_modules in dev) and reports installed/version.
 */

import { execFile } from 'node:child_process';
import { resolveCliPath } from '@accomplish_ai/agent-core/desktop-main';

export interface CliStatus {
  installed: boolean;
  version: string | null;
  installCommand: string;
}

function getVersion(cliPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cliPath, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(String(stdout).trim() || null);
    });
  });
}

export async function getCliStatus(appPath: string): Promise<CliStatus> {
  try {
    const resolved = resolveCliPath({ isPackaged: false, appPath });
    if (!resolved) {
      return { installed: false, version: null, installCommand: 'npm install -g opencode-ai' };
    }
    const version = await getVersion(resolved.cliPath);
    return {
      installed: version !== null,
      version,
      installCommand: 'npm install -g opencode-ai',
    };
  } catch {
    return { installed: false, version: null, installCommand: 'npm install -g opencode-ai' };
  }
}
