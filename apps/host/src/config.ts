/**
 * Host configuration — CLI/env parsing and data-directory resolution.
 *
 * Data-dir contract (FIREFOX_MIGRATION_PLAN §5.1): every identity file
 * (daemon socket, PID, DB, gateway token) derives from a single dataDir so
 * dev/prod and profiles never collide.
 *
 * The host's default data directory is XDG-based
 * (`$XDG_DATA_HOME/Accomplish`, typically `~/.local/share/Accomplish`).
 * It deliberately differs from the Electron shell's userData
 * (`~/.config/Accomplish`) and from the daemon's bare dev fallback
 * (`~/.accomplish`) so a host session can never read or mutate data owned
 * by another Accomplish surface unless the user explicitly points it there
 * with --data-dir.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createSessionToken } from './auth.js';

export const HOST_VERSION = '0.1.0';

export interface HostConfig {
  dataDir: string;
  /** Gateway token file — written 0600 for the launcher hand-off. */
  tokenFile: string;
  /** Loopback HTTP port; 0 = ephemeral (resolved after listen). */
  port: number;
  /** Directory of the built web UI (`apps/web/dist/client`) or null. */
  webDist: string | null;
  /** Bearer token browsers must present. */
  token: string;
  /** Path to the daemon entry script (spawned with the Node binary). */
  daemonEntryPath: string;
  /** Node binary used to spawn the daemon. */
  nodeBin: string;
  /** Build identity for the daemon version guard; undefined skips the guard. */
  expectedBuildId?: string;
  /** Repo root passed to the daemon (ACCOMPLISH_APP_PATH) for CLI resolution. */
  appPath: string;
}

export interface HostArgs {
  dataDir?: string;
  port?: number;
  webDist?: string;
  token?: string;
  daemonEntryPath?: string;
  nodeBin?: string;
  /** accomplish:// deep link captured from argv (.desktop activation). */
  deepLinkUrl?: string;
  /** Open Firefox at the gateway URL after startup. */
  launch?: boolean;
  /** Launch Firefox in kiosk mode (requires --launch). */
  kiosk?: boolean;
  /** Install .desktop launcher + scheme, then exit. */
  installDesktop?: boolean;
  /** Remove .desktop launcher + scheme, then exit. */
  uninstallDesktop?: boolean;
  /** Register the systemd daemon service (start at login), then exit. */
  enableAutostart?: boolean;
  /** Remove the systemd daemon service, then exit. */
  disableAutostart?: boolean;
}

/**
 * Default data directory — XDG data home, never `~/.accomplish`.
 */
export function resolveDefaultDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'Accomplish');
}

/**
 * Default web-UI bundle location — `<repo>/apps/web/dist/client`,
 * resolved relative to this file so it works from both `src/` (dev/tsx)
 * and `dist/` (built output; same depth).
 */
export function resolveDefaultWebDist(): string {
  return path.resolve(__dirname, '..', '..', 'web', 'dist', 'client');
}

/**
 * Default daemon entry — `<repo>/apps/daemon/dist/index.js`, resolved
 * relative to this file (same reasoning as resolveDefaultWebDist).
 */
export function resolveDefaultDaemonEntryPath(): string {
  return path.resolve(__dirname, '..', '..', 'daemon', 'dist', 'index.js');
}

/**
 * Node binary used to spawn the daemon.
 *
 * The host is a plain Node process — never Electron — so `process.execPath`
 * is always a real Node with the ABI the daemon's better-sqlite3 was built
 * against. Unlike the Electron connector (which cannot use process.execPath),
 * the host must NOT consult `npm_node_execpath`: pnpm ≥ 10 sets it to the
 * pnpm executable itself, not Node, and spawning the daemon with it fails
 * silently. `ACCOMPLISH_NODE_BIN` / explicit arg override for packaged
 * layouts with a bundled Node distribution.
 */
export function resolveNodeBin(explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  const fromEnv = process.env.ACCOMPLISH_NODE_BIN;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  return process.execPath;
}

/**
 * App path passed to the daemon (ACCOMPLISH_APP_PATH). The daemon's CLI
 * resolver looks for `node_modules/.bin/opencode` in appPath and its
 * parent directories — pnpm links opencode-ai's bin only into the
 * workspace package that depends on it (apps/desktop), so dev mode must
 * point there, exactly like the Electron shell (app.getAppPath()).
 */
export function resolveAppPath(): string {
  return path.resolve(__dirname, '..', '..', 'desktop');
}

export function parseHostArgs(argv: string[] = process.argv.slice(2)): HostArgs {
  const result: HostArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir' && argv[i + 1]) {
      result.dataDir = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--port' && argv[i + 1]) {
      const port = Number.parseInt(argv[i + 1], 10);
      if (Number.isInteger(port) && port >= 0 && port <= 65535) {
        result.port = port;
      }
      i++;
    } else if (argv[i] === '--web-dist' && argv[i + 1]) {
      result.webDist = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--token' && argv[i + 1]) {
      result.token = argv[i + 1];
      i++;
    } else if (argv[i] === '--daemon-entry' && argv[i + 1]) {
      result.daemonEntryPath = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--node-bin' && argv[i + 1]) {
      result.nodeBin = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--launch') {
      result.launch = true;
    } else if (argv[i] === '--kiosk') {
      result.kiosk = true;
    } else if (argv[i] === '--install-desktop') {
      result.installDesktop = true;
    } else if (argv[i] === '--uninstall-desktop') {
      result.uninstallDesktop = true;
    } else if (argv[i] === '--enable-autostart') {
      result.enableAutostart = true;
    } else if (argv[i] === '--disable-autostart') {
      result.disableAutostart = true;
    } else if (argv[i].startsWith('accomplish://')) {
      result.deepLinkUrl = argv[i];
    }
  }
  return result;
}

function readTokenFile(tokenFile: string): string | null {
  try {
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (token.length > 0) {
      return token;
    }
  } catch {
    /* no persisted token yet */
  }
  return null;
}

/**
 * Resolve the full host configuration from args + environment.
 *
 * Priority: explicit args → ACCOMPLISH_HOST_* env → defaults. The token is
 * generated fresh per session unless injected (tests/launcher handoff);
 * a previously persisted token file is only reused when the host was
 * started without one, which keeps dev sessions stable across restarts.
 */
export function resolveHostConfig(args: HostArgs = {}): HostConfig {
  const dataDir = args.dataDir ?? process.env.ACCOMPLISH_HOST_DATA_DIR ?? resolveDefaultDataDir();
  const port = args.port ?? (Number.parseInt(process.env.ACCOMPLISH_HOST_PORT ?? '', 10) || 0);
  const webDist = args.webDist ?? process.env.ACCOMPLISH_HOST_WEB_DIST ?? resolveDefaultWebDist();
  const tokenFile = path.join(dataDir, 'gateway-token');

  let token = args.token ?? process.env.ACCOMPLISH_HOST_TOKEN ?? readTokenFile(tokenFile);
  if (!token) {
    token = createSessionToken();
  }

  return {
    dataDir,
    tokenFile,
    port,
    webDist: webDist && existsSync(webDist) ? webDist : null,
    token,
    daemonEntryPath: args.daemonEntryPath ?? resolveDefaultDaemonEntryPath(),
    nodeBin: resolveNodeBin(args.nodeBin),
    appPath: resolveAppPath(),
  };
}

/** Create the data directory (0700 — matches the daemon's expectations). */
export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}
