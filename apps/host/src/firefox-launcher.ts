/**
 * Firefox launcher — opens the gateway URL in a dedicated app profile.
 *
 * Phase 2 of the Firefox migration (FIREFOX_MIGRATION_PLAN §9): the host
 * replaces Electron's BrowserWindow. A dedicated profile keeps the app's
 * session (cookies, localStorage, sessionStorage) separate from the user's
 * daily browsing — never the default profile.
 *
 * Re-launch semantics: launching with a profile that is already in use
 * makes Firefox hand the URL to the running instance and exit, so repeated
 * activations of the .desktop launcher just focus/open a new window.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const FIREFOX_CANDIDATES = [
  '/usr/bin/firefox',
  '/usr/bin/firefox-esr',
  '/snap/bin/firefox',
  '/usr/local/bin/firefox',
];

export interface FirefoxLauncherOptions {
  /** Explicit binary override ($FIREFOX_BIN equivalent). */
  binary?: string;
  /** Profile directory override ($ACCOMPLISH_FIREFOX_PROFILE equivalent). */
  profileDir?: string;
  /** Kiosk mode — borderless fullscreen, no browser chrome. */
  kiosk?: boolean;
  /** Test injection for the actual spawn. */
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/**
 * Resolve the Firefox binary: explicit arg → FIREFOX_BIN → common paths →
 * PATH lookup via bare name.
 */
export function resolveFirefoxBinary(explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  const fromEnv = process.env.FIREFOX_BIN;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  for (const candidate of FIREFOX_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'firefox';
}

/**
 * Dedicated app profile directory.
 *
 * Snap Firefox (Ubuntu default) cannot access hidden directories under
 * $HOME — a profile in `~/.config/...` makes it exit instantly. When the
 * snap layout exists, the profile therefore lives under
 * `~/snap/firefox/common/` (the snap's own writable area, same approach as
 * the Kujenga BiDi adapter). Non-snap installs use `~/.config/Accomplish`.
 * `$ACCOMPLISH_FIREFOX_PROFILE` overrides both.
 */
export function resolveAppProfileDir(explicit?: string): string {
  const explicitDir = explicit ?? process.env.ACCOMPLISH_FIREFOX_PROFILE;
  if (explicitDir) {
    mkdirSync(explicitDir, { recursive: true });
    return explicitDir;
  }
  const isSnap = existsSync(path.join(homedir(), 'snap', 'firefox'));
  const dir = isSnap
    ? path.join(homedir(), 'snap', 'firefox', 'common', 'accomplish-app-profile')
    : path.join(
        process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
        'Accomplish',
        'firefox-app-profile',
      );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Launch Firefox at the gateway URL with the dedicated profile.
 *
 * Detached + unref: Firefox's lifetime is independent of the host — exactly
 * like the Electron window was. Closing Firefox never affects the daemon.
 */
export function launchFirefox(url: string, options: FirefoxLauncherOptions = {}): ChildProcess {
  const binary = resolveFirefoxBinary(options.binary);
  const profileDir = resolveAppProfileDir(options.profileDir);
  const args = ['--profile', profileDir, '--new-window'];
  if (options.kiosk) {
    args.push('--kiosk');
  }
  args.push(url);

  const spawnFn =
    options.spawnFn ??
    ((command: string, argv: readonly string[], spawnOptions: SpawnOptions) =>
      spawn(command, argv as string[], spawnOptions));

  // Firefox inherits the desktop session environment (DISPLAY/Wayland) —
  // required for a real graphical launch on the user's session.
  const child = spawnFn(binary, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child;
}
