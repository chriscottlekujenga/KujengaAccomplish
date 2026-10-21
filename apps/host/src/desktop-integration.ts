/**
 * Ubuntu desktop integration — .desktop launcher, `accomplish://` scheme
 * registration, and the single-instance/deep-link entry protocol.
 *
 * The .desktop `Exec` line points straight at the host CLI. The host itself
 * is the single-instance arbiter (see `findExistingInstance`): a second
 * activation either forwards an `accomplish://` deep link to the running
 * gateway or just re-opens Firefox at the existing URL. That mirrors the
 * Electron `requestSingleInstanceLock` + `second-instance` behavior from
 * `protocol-handlers.ts` without any extra IPC machinery.
 *
 * A `gateway-info.json` file in the data dir (0600, alongside the token
 * file) carries { port, pid } — same sensitivity class as the token.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DESKTOP_FILE_NAME = 'accomplish-fox.desktop';
export const SCHEME = 'accomplish';
export const GATEWAY_INFO_FILE = 'gateway-info.json';

export interface DesktopIntegrationOptions {
  dataDir: string;
  nodeBin: string;
  hostEntryPath: string;
  webDist: string | null;
  /** Absolute icon path referenced by the .desktop file. */
  iconPath?: string | null;
  /** Override for the applications dir (tests). */
  dataHome?: string;
  /** Injectable shell (tests). */
  exec?: (command: string) => string;
}

type ExecFn = (command: string) => string;
const defaultExec: ExecFn = (command) => execSync(command, { stdio: 'pipe', encoding: 'utf-8' });

function getDataHome(options: DesktopIntegrationOptions): string {
  return options.dataHome ?? process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share');
}

export function getDesktopFilePath(options: DesktopIntegrationOptions): string {
  return path.join(getDataHome(options), 'applications', DESKTOP_FILE_NAME);
}

/**
 * .desktop content. `%u` is the freedesktop URL placeholder — the desktop
 * environment substitutes the `accomplish://...` link, which the host CLI
 * recognizes and routes (deep link) even while another instance runs.
 */
export function getDesktopFileContent(options: DesktopIntegrationOptions): string {
  const { dataDir, nodeBin, hostEntryPath, webDist } = options;
  const args = ['--launch', '--data-dir', dataDir];
  if (webDist) {
    args.push('--web-dist', webDist);
  }
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Accomplish',
    'Comment=The open source AI coworker (Firefox shell)',
    'Exec=' + [nodeBin, hostEntryPath, ...args, '%u'].join(' '),
    ...(options.iconPath && existsSync(options.iconPath) ? [`Icon=${options.iconPath}`] : []),
    'Terminal=false',
    'Categories=Utility;',
    `MimeType=x-scheme-handler/${SCHEME};`,
    'StartupNotify=true',
    '',
  ].join('\n');
}

export function installDesktopIntegration(options: DesktopIntegrationOptions): void {
  const exec = options.exec ?? defaultExec;
  const desktopPath = getDesktopFilePath(options);
  mkdirSync(path.dirname(desktopPath), { recursive: true });
  writeFileSync(desktopPath, getDesktopFileContent(options), { mode: 0o644 });

  try {
    exec(`xdg-mime default ${DESKTOP_FILE_NAME} x-scheme-handler/${SCHEME}`);
  } catch {
    /* xdg-mime may be absent in minimal environments — the file is still registered */
  }
  try {
    exec(`update-desktop-database ${path.dirname(desktopPath)}`);
  } catch {
    /* best effort */
  }
}

export function uninstallDesktopIntegration(options: DesktopIntegrationOptions): void {
  const desktopPath = getDesktopFilePath(options);
  if (existsSync(desktopPath)) {
    unlinkSync(desktopPath);
  }
  try {
    (options.exec ?? defaultExec)(`xdg-mime default none x-scheme-handler/${SCHEME}`);
  } catch {
    /* best effort */
  }
}

// =============================================================================
// Single-instance + deep-link protocol
// =============================================================================

export interface GatewayInstanceInfo {
  port: number;
  pid: number;
}

export function getInstanceInfoPath(dataDir: string): string {
  return path.join(dataDir, GATEWAY_INFO_FILE);
}

export function writeInstanceInfo(dataDir: string, info: GatewayInstanceInfo): void {
  writeFileSync(getInstanceInfoPath(dataDir), JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function readInstanceInfo(dataDir: string): GatewayInstanceInfo | null {
  try {
    const raw = JSON.parse(
      readFileSync(getInstanceInfoPath(dataDir), 'utf8'),
    ) as GatewayInstanceInfo;
    if (typeof raw.port === 'number' && typeof raw.pid === 'number') {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether the recorded instance is still alive and serving /health on its
 * port. Liveness alone is not enough — a crashed host leaves a stale pid
 * entry; the health probe is authoritative.
 */
export async function findExistingInstance(
  dataDir: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<GatewayInstanceInfo | null> {
  const info = readInstanceInfo(dataDir);
  if (!info) {
    return null;
  }
  try {
    process.kill(info.pid, 0);
  } catch {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${info.port}/health`, { method: 'GET' });
    if (res.ok) {
      return info;
    }
  } catch {
    /* not listening */
  }
  return null;
}

/**
 * Forward an accomplish:// deep link to a running instance's gateway.
 * Mirrors `dispatchProtocolUrl` in the Electron protocol-handlers:
 * `accomplish://callback/mcp*` is the MCP OAuth callback, any other
 * `accomplish://callback*` a generic auth callback; other hosts are
 * ignored. Returns true when the link was accepted.
 */
export async function forwardDeepLink(
  port: number,
  token: string,
  url: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  if (!url.startsWith('accomplish://callback')) {
    return false;
  }
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const res = await fetchImpl(`http://127.0.0.1:${port}/deep-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url }),
  });
  return res.ok;
}
