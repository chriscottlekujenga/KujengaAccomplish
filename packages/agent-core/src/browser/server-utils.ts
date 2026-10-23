/**
 * Browser server utility functions:
 * - Node environment setup
 * - Node executable resolution
 * - Playwright CLI path resolution
 * - Playwright Chromium installation
 * - Dev-browser server health checks
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DEV_BROWSER_PORT } from '../common/constants.js';
import { createConsoleLogger } from '../utils/logging.js';
import { ACCOMPLISH_DEV_BROWSER_TOKEN_ENV, getDevBrowserToken } from './dev-browser-token.js';

export interface BrowserServerConfig {
  mcpToolsPath: string;
  bundledNodeBinPath?: string;
  devBrowserPort: number;
  devBrowserCdpPort?: number;
  /**
   * Bearer token the sidecar requires on every HTTP request (Phase 3 M1 §5.3).
   * When omitted, a per-process token is generated (the value must match the
   * one distributed to the dev-browser-mcp MCP tool child).
   */
  devBrowserToken?: string;
}

function resolveBrowserToken(explicit: string | undefined): string {
  return explicit ?? getDevBrowserToken();
}

export function buildBrowserSpawnEnvironment(
  bundledNodeBinPath: string | undefined,
  devBrowserToken?: string,
): NodeJS.ProcessEnv {
  const spawnEnv = buildNodeEnvironment(bundledNodeBinPath);
  spawnEnv[ACCOMPLISH_DEV_BROWSER_TOKEN_ENV] = resolveBrowserToken(devBrowserToken);
  return spawnEnv;
}

function authHeaders(devBrowserToken?: string): Record<string, string> {
  return { Authorization: `Bearer ${resolveBrowserToken(devBrowserToken)}` };
}

const log = createConsoleLogger({ prefix: 'Browser' });

/**
 * M5 §3.1 — isolation seam for the dev-browser relay (sidecar HTTP) port.
 *
 * The relay port used to be the hard-coded DEV_BROWSER_PORT constant, so an
 * isolated E2E daemon ran its sidecar — and its boot self-heal, which kills
 * whatever listener owns the port it is about to bind — against the same
 * loopback port the production daemon's sidecar occupies. An explicit env
 * override shifts the whole stack (sidecar bind, daemon probes/shutdown
 * port-kill, MCP child sidecar URLs) to a different loopback port.
 */
export const ACCOMPLISH_DEV_BROWSER_RELAY_PORT_ENV = 'ACCOMPLISH_DEV_BROWSER_RELAY_PORT';

export function resolveDevBrowserRelayPort(): number {
  const raw = process.env[ACCOMPLISH_DEV_BROWSER_RELAY_PORT_ENV];
  const trimmed = raw === undefined || raw === null ? undefined : raw.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return DEV_BROWSER_PORT;
  }
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    log.warn(
      `Ignoring invalid ${ACCOMPLISH_DEV_BROWSER_RELAY_PORT_ENV} "${raw}" — ` +
        `using the default relay port ${DEV_BROWSER_PORT}`,
    );
    return DEV_BROWSER_PORT;
  }
  return parsed;
}

export function buildNodeEnvironment(bundledNodeBinPath?: string): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env };

  if (bundledNodeBinPath) {
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const existingPath = process.env.PATH ?? process.env.Path ?? '';
    const combinedPath = existingPath
      ? `${bundledNodeBinPath}${delimiter}${existingPath}`
      : bundledNodeBinPath;
    spawnEnv.PATH = combinedPath;
    if (process.platform === 'win32') {
      spawnEnv.Path = combinedPath;
    }
    spawnEnv.NODE_BIN_PATH = bundledNodeBinPath;
  }

  return spawnEnv;
}

export function getNodeExecutable(bundledNodeBinPath?: string): string {
  if (!bundledNodeBinPath) {
    throw new Error(
      '[Browser] Bundled Node.js path is missing. ' +
        'Run "pnpm -F @accomplish/desktop download:nodejs" and rebuild artifacts.',
    );
  }

  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodePath = path.join(bundledNodeBinPath, nodeName);
  if (fs.existsSync(nodePath)) {
    return nodePath;
  }

  throw new Error(
    `[Browser] Missing bundled Node.js executable: ${nodePath}. ` +
      'Run "pnpm -F @accomplish/desktop download:nodejs" and rebuild artifacts.',
  );
}

export function resolvePlaywrightCliPath(mcpToolsPath: string): string {
  const candidates = [
    path.join(mcpToolsPath, 'dev-browser', 'node_modules', 'playwright', 'cli.js'),
    path.join(mcpToolsPath, 'node_modules', 'playwright', 'cli.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    '[Browser] Playwright CLI not found for dev-browser setup. ' +
      `Checked: ${candidates.join(', ')}. ` +
      `Run "npm --prefix \\"${mcpToolsPath}\\" install --omit=dev".`,
  );
}

export async function installPlaywrightChromium(
  config: BrowserServerConfig,
  onProgress?: (message: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const devBrowserDir = path.join(config.mcpToolsPath, 'dev-browser');
    if (!fs.existsSync(devBrowserDir)) {
      const message =
        `[Browser] Missing dev-browser directory: ${devBrowserDir}. ` +
        'Run "pnpm -F @accomplish/desktop build:mcp-tools:dev" and rebuild artifacts.';
      onProgress?.(message);
      reject(new Error(message));
      return;
    }

    const nodeExe = getNodeExecutable(config.bundledNodeBinPath);
    const playwrightCliPath = resolvePlaywrightCliPath(config.mcpToolsPath);
    const spawnEnv = buildNodeEnvironment(config.bundledNodeBinPath);

    onProgress?.('Downloading browser...');

    const child = spawn(nodeExe, [playwrightCliPath, 'install', 'chromium'], {
      cwd: devBrowserDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
      shell: false,
    });

    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        log.info(`[Playwright Install] ${line}`);
        if (line.includes('%') || line.toLowerCase().startsWith('downloading')) {
          onProgress?.(line);
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        log.info(`[Playwright Install] ${line}`);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        log.info('[Browser] Playwright Chromium installed successfully');
        onProgress?.('Browser installed successfully!');
        resolve();
      } else {
        reject(new Error(`Playwright install failed with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

export async function isDevBrowserServerReady(
  port: number,
  devBrowserToken?: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    // Use 127.0.0.1 instead of localhost: avoids macOS Local Network permission
    // dialog (triggered by mDNS resolution of "localhost" on some macOS versions)
    // and ensures IPv4 loopback is used consistently.
    const res = await fetch(`http://127.0.0.1:${port}`, {
      signal: controller.signal,
      headers: authHeaders(devBrowserToken),
    });
    if (res.status === 401) {
      // Server is up but our token is not its token: a stale sidecar from a
      // previous daemon lifetime (or a foreign process squatting the port).
      // Callers re-spawn with the current token and start-server.mjs kills
      // the stale listener first.
      log.info('[Browser] Dev-browser server responded 401 — token mismatch (stale server)');
      return false;
    }
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForDevBrowserServer(
  port: number,
  maxWaitMs = 15000,
  pollIntervalMs = 500,
  devBrowserToken?: string,
): Promise<boolean> {
  const startTime = Date.now();
  let attempts = 0;
  while (Date.now() - startTime < maxWaitMs) {
    attempts++;
    if (await isDevBrowserServerReady(port, devBrowserToken)) {
      log.info(
        `[Browser] Dev-browser server ready after ${attempts} attempts (${Date.now() - startTime}ms)`,
      );
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  log.info(
    `[Browser] Dev-browser server not ready after ${attempts} attempts (${maxWaitMs}ms timeout)`,
  );
  return false;
}
