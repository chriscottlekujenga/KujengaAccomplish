import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  launchFirefox,
  resolveAppProfileDir,
  resolveFirefoxBinary,
} from '../../src/firefox-launcher.js';

function fakeChild() {
  return {
    pid: 31337,
    unref: vi.fn(),
  } as unknown as ChildProcess;
}

describe('resolveFirefoxBinary', () => {
  const saved = process.env.FIREFOX_BIN;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.FIREFOX_BIN;
    } else {
      process.env.FIREFOX_BIN = saved;
    }
  });

  it('prefers the explicit argument', () => {
    expect(resolveFirefoxBinary('/opt/firefox')).toBe('/opt/firefox');
  });

  it('uses FIREFOX_BIN when the binary exists', () => {
    process.env.FIREFOX_BIN = process.execPath;
    expect(resolveFirefoxBinary()).toBe(process.execPath);
  });

  it('falls back to a common Linux path, then the bare name', () => {
    delete process.env.FIREFOX_BIN;
    const resolved = resolveFirefoxBinary();
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe('resolveAppProfileDir', () => {
  const saved = process.env.ACCOMPLISH_FIREFOX_PROFILE;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'fx-profile-'));
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.ACCOMPLISH_FIREFOX_PROFILE;
    } else {
      process.env.ACCOMPLISH_FIREFOX_PROFILE = saved;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the dedicated profile directory', () => {
    process.env.ACCOMPLISH_FIREFOX_PROFILE = path.join(tmp, 'app-profile');
    const dir = resolveAppProfileDir();
    expect(dir).toBe(path.join(tmp, 'app-profile'));
  });

  it('prefers the snap-writable layout when snap Firefox is installed', () => {
    delete process.env.ACCOMPLISH_FIREFOX_PROFILE;
    const isSnap = existsSync(path.join(homedir(), 'snap', 'firefox'));
    const dir = resolveAppProfileDir();
    // The snap layout is snap-aware (~/snap/firefox/common); the non-snap
    // layout stays under ~/.config/Accomplish. Never the default profile.
    if (isSnap) {
      expect(dir).toMatch(/snap[/\\]firefox[/\\]common[/\\]accomplish-app-profile$/);
    } else {
      expect(dir).toMatch(/Accomplish[/\\]firefox-app-profile$/);
    }
    expect(dir).not.toContain('snap/firefox/default');
  });
});

describe('launchFirefox', () => {
  it('spawns firefox detached with the dedicated profile and the gateway URL', () => {
    const spawnFn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) =>
      fakeChild(),
    );
    const url = 'http://127.0.0.1:41999/#token=abc';
    launchFirefox(url, {
      spawnFn: spawnFn as never,
      binary: '/usr/bin/firefox',
      profileDir: '/tmp/fx-app-profile',
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      SpawnOptions,
    ];
    expect(command).toBe('/usr/bin/firefox');
    expect(args).toEqual(['--profile', '/tmp/fx-app-profile', '--new-window', url]);
    expect(options.detached).toBe(true);
  });

  it('adds --kiosk before the URL in kiosk mode', () => {
    const spawnFn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) =>
      fakeChild(),
    );
    launchFirefox('http://127.0.0.1:2/#token=x', {
      spawnFn: spawnFn as never,
      binary: 'firefox',
      profileDir: '/tmp/fx-app-profile',
      kiosk: true,
    });
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args).toEqual([
      '--profile',
      '/tmp/fx-app-profile',
      '--new-window',
      '--kiosk',
      'http://127.0.0.1:2/#token=x',
    ]);
  });
});
