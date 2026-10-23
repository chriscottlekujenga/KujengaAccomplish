import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SYSTEMD_UNIT_NAME,
  getUnitContent,
  getUnitPath,
  installDaemonService,
  uninstallDaemonService,
  isDaemonServiceEnabled,
} from '../../src/daemon-service.js';

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    dataDir: '/tmp/accomplish-data',
    nodeBin: '/usr/bin/node',
    daemonEntryPath: '/repo/apps/daemon/dist/index.js',
    appPath: '/repo',
    ...overrides,
  } as Parameters<typeof getUnitContent>[0];
}

describe('getUnitContent', () => {
  it('starts the daemon with the isolated data dir and isolation env', () => {
    const content = getUnitContent(makeOptions());
    expect(content).toContain(
      `ExecStart=/usr/bin/node /repo/apps/daemon/dist/index.js --data-dir /tmp/accomplish-data`,
    );
    expect(content).toContain('Restart=on-failure');
    // M4 regression lock: the unit must self-restart after a daemon failure.
    expect(content).toContain('RestartSec=5');
    expect(content).toContain('Environment=XDG_DATA_HOME=/tmp/accomplish-data');
    expect(content).toContain('Environment=ACCOMPLISH_APP_PATH=/repo');
    expect(content).toContain('WantedBy=default.target');
  });
});

describe('install/uninstall', () => {
  it('writes the unit, reloads systemd, and enables it', () => {
    const configHome = mkdtempSync(path.join(tmpdir(), 'systemd-'));
    const commands: string[] = [];
    try {
      installDaemonService({
        ...makeOptions({ configHome }),
        exec: (command: string) => {
          commands.push(command);
          return '';
        },
      });
      const unitPath = path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT_NAME);
      expect(existsSync(unitPath)).toBe(true);
      expect(readFileSync(unitPath, 'utf8')).toContain('ExecStart=');
      expect(commands).toContain('systemctl --user daemon-reload');
      expect(commands).toContain(`systemctl --user enable ${SYSTEMD_UNIT_NAME}`);
      expect(commands).toContain(`systemctl --user start ${SYSTEMD_UNIT_NAME}`);

      uninstallDaemonService({
        ...makeOptions({ configHome }),
        exec: (command: string) => {
          commands.push(command);
          return '';
        },
      });
      expect(existsSync(unitPath)).toBe(false);
      expect(commands).toContain(`systemctl --user disable ${SYSTEMD_UNIT_NAME}`);
      expect(commands).toContain(`systemctl --user stop ${SYSTEMD_UNIT_NAME}`);
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it('uses a unit name distinct from the Electron app during migration', () => {
    expect(SYSTEMD_UNIT_NAME).not.toBe('accomplish-daemon.service');
  });
});

describe('isDaemonServiceEnabled', () => {
  it('reports enabled only when systemctl says so', () => {
    const enabled = vi.fn(() => 'enabled\n');
    expect(isDaemonServiceEnabled(makeOptions({ exec: enabled }))).toBe(true);
    const disabled = vi.fn(() => 'disabled\n');
    expect(isDaemonServiceEnabled(makeOptions({ exec: disabled }))).toBe(false);
    const failing = vi.fn(() => {
      throw new Error('not found');
    });
    expect(isDaemonServiceEnabled(makeOptions({ exec: failing }))).toBe(false);
  });
});

describe('getUnitPath', () => {
  it('lives under the systemd user directory', () => {
    expect(getUnitPath(makeOptions({ configHome: '/cfg' }))).toBe(
      path.join('/cfg', 'systemd', 'user', SYSTEMD_UNIT_NAME),
    );
  });
});
