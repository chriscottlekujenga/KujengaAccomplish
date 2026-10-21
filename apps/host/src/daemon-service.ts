/**
 * systemd user service for the daemon — "start at login" for the Firefox
 * shell. Ported from the Linux branch of
 * `apps/desktop/src/main/daemon/service-manager.ts` (Electron-free by
 * construction).
 *
 * The unit name is `accomplish-fox-daemon.service` (not the Electron app's
 * `accomplish-daemon.service`) so the two shells can coexist during the
 * migration without overwriting each other's unit.
 *
 * The unit starts the daemon with `XDG_DATA_HOME=<dataDir>` so opencode
 * auth/state stays inside the isolated data directory — the same contract
 * the host's own spawn uses (see daemon-connector.ts).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const SYSTEMD_UNIT_NAME = 'accomplish-fox-daemon.service';

export interface DaemonServiceOptions {
  dataDir: string;
  nodeBin: string;
  daemonEntryPath: string;
  appPath: string;
  /** Override the unit/config directories (tests). */
  configHome?: string;
  /** Injectable shell (tests). */
  exec?: (command: string) => string;
}

type ExecFn = (command: string) => string;
const defaultExec: ExecFn = (command) => execSync(command, { stdio: 'pipe', encoding: 'utf-8' });

function getConfigHome(options: DaemonServiceOptions): string {
  return options.configHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
}

export function getUnitPath(options: DaemonServiceOptions): string {
  return path.join(getConfigHome(options), 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

/**
 * Unit content — daemon binary with the isolated data dir, restart-on-
 * failure, and the opencode credential isolation env. ACCOMPLISH_APP_PATH
 * must point at the CLI-owning workspace package (apps/desktop) so the
 * daemon resolves `node_modules/.bin/opencode` in dev mode.
 */
export function getUnitContent(options: DaemonServiceOptions): string {
  const { dataDir, nodeBin, daemonEntryPath, appPath } = options;
  return [
    '[Unit]',
    'Description=Accomplish AI Daemon (Firefox shell)',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${nodeBin} ${daemonEntryPath} --data-dir ${dataDir}`,
    'Restart=on-failure',
    'RestartSec=5',
    `Environment=XDG_DATA_HOME=${dataDir}`,
    `Environment=ACCOMPLISH_APP_PATH=${appPath}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function installDaemonService(options: DaemonServiceOptions): void {
  const exec = options.exec ?? defaultExec;
  const unitPath = getUnitPath(options);
  mkdirSync(path.dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, getUnitContent(options), { mode: 0o644 });

  exec('systemctl --user daemon-reload');
  exec(`systemctl --user enable ${SYSTEMD_UNIT_NAME}`);
  exec(`systemctl --user start ${SYSTEMD_UNIT_NAME}`);
}

export function uninstallDaemonService(options: DaemonServiceOptions): void {
  const exec = options.exec ?? defaultExec;
  const unitPath = getUnitPath(options);
  try {
    exec(`systemctl --user disable ${SYSTEMD_UNIT_NAME}`);
    exec(`systemctl --user stop ${SYSTEMD_UNIT_NAME}`);
  } catch {
    /* may not be running — that's fine */
  }
  if (existsSync(unitPath)) {
    unlinkSync(unitPath);
  }
  try {
    exec('systemctl --user daemon-reload');
  } catch {
    /* best effort */
  }
}

export function isDaemonServiceEnabled(options: DaemonServiceOptions): boolean {
  const exec = options.exec ?? defaultExec;
  try {
    return exec(`systemctl --user is-enabled ${SYSTEMD_UNIT_NAME}`).trim() === 'enabled';
  } catch {
    return false;
  }
}

export function isDaemonServiceActive(options: DaemonServiceOptions): boolean {
  const exec = options.exec ?? defaultExec;
  try {
    return exec(`systemctl --user is-active ${SYSTEMD_UNIT_NAME}`).trim() === 'active';
  } catch {
    return false;
  }
}
