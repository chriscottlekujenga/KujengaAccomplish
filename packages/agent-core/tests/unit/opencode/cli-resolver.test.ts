import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveCliPath,
  isCliAvailable,
  getCliVersion,
} from '../../../src/opencode/cli-resolver.js';

const itIfWindows = process.platform === 'win32' ? it : it.skip;

const originalPlatform = process.platform;
const originalArch = process.arch;

function setProcessTarget(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

describe('CLI Resolver', () => {
  let testDir: string;
  const originalAppRoot = process.env.APP_ROOT;

  function createLocalCli(appRoot: string): { cliPath: string; cliDir: string; binName: string } {
    if (process.platform === 'win32') {
      const binName = 'opencode.exe';
      const cliDir = path.join(appRoot, 'node_modules', 'opencode-windows-x64', 'bin');
      const cliPath = path.join(cliDir, binName);
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(cliPath, 'binary');
      return { cliPath, cliDir, binName };
    }

    const binName = 'opencode';
    const cliDir = path.join(appRoot, 'node_modules', '.bin');
    const cliPath = path.join(cliDir, binName);
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(cliPath, '#!/bin/bash\necho "opencode"');
    return { cliPath, cliDir, binName };
  }

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `cli-resolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    delete process.env.APP_ROOT;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    if (originalAppRoot === undefined) {
      delete process.env.APP_ROOT;
    } else {
      process.env.APP_ROOT = originalAppRoot;
    }
    setProcessTarget(originalPlatform, originalArch);
    vi.restoreAllMocks();
  });

  describe('resolveCliPath', () => {
    it('resolves bundled CLI from packaged resources', () => {
      const binName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
      let packageName: string;
      if (process.platform === 'win32') {
        packageName = 'opencode-windows-x64';
      } else if (process.platform === 'linux') {
        packageName = process.arch === 'arm64' ? 'opencode-linux-arm64' : 'opencode-linux-x64';
      } else {
        packageName = 'opencode-ai';
      }
      const cliDir = path.join(
        testDir,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        packageName,
        'bin',
      );
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(path.join(cliDir, binName), '#!/bin/bash\necho "opencode"');

      const result = resolveCliPath({
        isPackaged: true,
        resourcesPath: path.join(testDir, 'resources'),
      });

      expect(result).not.toBeNull();
      expect(result?.source).toBe('bundled');
      expect(result?.cliPath).toContain(binName);
    });

    it('returns null for packaged mode when bundled CLI is missing', () => {
      const result = resolveCliPath({
        isPackaged: true,
        resourcesPath: path.join(testDir, 'missing-resources'),
      });

      expect(result).toBeNull();
    });

    it('resolves development CLI from appPath local node_modules', () => {
      const appRoot = path.join(testDir, 'app');
      const { binName } = createLocalCli(appRoot);

      const result = resolveCliPath({
        isPackaged: false,
        appPath: appRoot,
      });

      expect(result).not.toBeNull();
      expect(result?.source).toBe('local');
      expect(result?.cliPath).toContain(binName);
    });

    it('resolves development CLI from APP_ROOT when appPath does not contain it', () => {
      const appRoot = path.join(testDir, 'app-root');
      const { cliPath } = createLocalCli(appRoot);
      process.env.APP_ROOT = appRoot;

      const result = resolveCliPath({
        isPackaged: false,
        appPath: path.join(testDir, 'other-app-path'),
      });

      expect(result).not.toBeNull();
      expect(result?.source).toBe('local');
      expect(result?.cliPath).toBe(cliPath);
    });

    it('returns null in development mode when local CLI is missing', () => {
      const result = resolveCliPath({
        isPackaged: false,
        appPath: path.join(testDir, 'app-without-cli'),
      });

      expect(result).toBeNull();
    });

    describe('Windows ARM64 resolution (native package, no x64 fallback)', () => {
      function createPackagedFixture(resourcesPath: string, packageName: string, binName: string) {
        const cliDir = path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          packageName,
          'bin',
        );
        fs.mkdirSync(cliDir, { recursive: true });
        const cliPath = path.join(cliDir, binName);
        fs.writeFileSync(cliPath, 'binary');
        return cliPath;
      }

      it('resolves the packaged arm64 opencode.exe on windows-arm64', () => {
        setProcessTarget('win32', 'arm64');
        const cliPath = createPackagedFixture(
          path.join(testDir, 'resources'),
          'opencode-windows-arm64',
          'opencode.exe',
        );

        const result = resolveCliPath({
          isPackaged: true,
          resourcesPath: path.join(testDir, 'resources'),
        });

        expect(result).not.toBeNull();
        expect(result?.source).toBe('bundled');
        expect(result?.cliPath).toBe(cliPath);
      });

      it('returns null on windows-arm64 when only the x64 package is packaged', () => {
        // Regression guard: on Windows ARM64 the resolver must never silently
        // fall back to the x64 engine (which would only run under OS-level
        // binary emulation). The x64 binary being present must not change that.
        setProcessTarget('win32', 'arm64');
        createPackagedFixture(
          path.join(testDir, 'resources'),
          'opencode-windows-x64',
          'opencode.exe',
        );
        createPackagedFixture(
          path.join(testDir, 'resources'),
          'opencode-windows-x64-baseline',
          'opencode.exe',
        );

        const result = resolveCliPath({
          isPackaged: true,
          resourcesPath: path.join(testDir, 'resources'),
        });

        expect(result).toBeNull();
      });

      it('resolves the native arm64 package in development mode on windows-arm64', () => {
        setProcessTarget('win32', 'arm64');
        const appRoot = path.join(testDir, 'app');
        const cliDir = path.join(appRoot, 'node_modules', 'opencode-windows-arm64', 'bin');
        fs.mkdirSync(cliDir, { recursive: true });
        fs.writeFileSync(path.join(cliDir, 'opencode.exe'), 'binary');

        const result = resolveCliPath({
          isPackaged: false,
          appPath: appRoot,
        });

        expect(result).not.toBeNull();
        expect(result?.source).toBe('local');
        expect(result?.cliPath).toContain('opencode-windows-arm64');
      });

      it('returns null in development mode on windows-arm64 when only x64 is installed', () => {
        setProcessTarget('win32', 'arm64');
        const appRoot = path.join(testDir, 'app');
        const cliDir = path.join(appRoot, 'node_modules', 'opencode-windows-x64', 'bin');
        fs.mkdirSync(cliDir, { recursive: true });
        fs.writeFileSync(path.join(cliDir, 'opencode.exe'), 'binary');

        const result = resolveCliPath({
          isPackaged: false,
          appPath: appRoot,
        });

        expect(result).toBeNull();
      });

      it('still resolves the x64 package on windows-x64', () => {
        setProcessTarget('win32', 'x64');
        createPackagedFixture(
          path.join(testDir, 'resources'),
          'opencode-windows-x64',
          'opencode.exe',
        );
        // Baseline ordering depends on the local AVX2 probe result, so both
        // candidates are provided to keep the assertion arch-outcome-agnostic.
        createPackagedFixture(
          path.join(testDir, 'resources'),
          'opencode-windows-x64-baseline',
          'opencode.exe',
        );

        const result = resolveCliPath({
          isPackaged: true,
          resourcesPath: path.join(testDir, 'resources'),
        });

        expect(result).not.toBeNull();
        expect(result?.cliPath).toContain('opencode-windows-x64');
      });

      it('resolves the launcher package on darwin arm64 (regression)', () => {
        setProcessTarget('darwin', 'arm64');
        createPackagedFixture(path.join(testDir, 'resources'), 'opencode-ai', 'opencode');

        const result = resolveCliPath({
          isPackaged: true,
          resourcesPath: path.join(testDir, 'resources'),
        });

        expect(result).not.toBeNull();
        expect(result?.source).toBe('bundled');
        expect(result?.cliPath).toContain('opencode-ai');
      });
    });

    itIfWindows('resolves development CLI via opencode-ai launcher realpath in pnpm layout', () => {
      const appRoot = path.join(testDir, 'app');
      const launcherPath = path.join(appRoot, 'node_modules', 'opencode-ai');
      const launcherStoreRoot = path.join(testDir, '.pnpm', 'opencode-ai@1.14.18', 'node_modules');
      const realLauncherPath = path.join(launcherStoreRoot, 'opencode-ai');
      const cliPath = path.join(launcherStoreRoot, 'opencode-windows-x64', 'bin', 'opencode.exe');

      fs.mkdirSync(launcherPath, { recursive: true });
      fs.mkdirSync(realLauncherPath, { recursive: true });
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.writeFileSync(cliPath, 'binary');

      const originalRealpathSync = fs.realpathSync;
      const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((
        inputPath: fs.PathLike,
      ) => {
        if (String(inputPath) === launcherPath) {
          return realLauncherPath;
        }
        return originalRealpathSync(inputPath);
      }) as typeof fs.realpathSync);

      const result = resolveCliPath({
        isPackaged: false,
        appPath: appRoot,
      });

      expect(result).not.toBeNull();
      expect(result?.source).toBe('local');
      expect(result?.cliPath).toBe(cliPath);

      realpathSpy.mockRestore();
    });
  });

  describe('isCliAvailable', () => {
    it('returns true when local CLI is present', () => {
      const appRoot = path.join(testDir, 'app');
      createLocalCli(appRoot);

      expect(
        isCliAvailable({
          isPackaged: false,
          appPath: appRoot,
        }),
      ).toBe(true);
    });

    it('returns false when CLI is absent', () => {
      expect(
        isCliAvailable({
          isPackaged: false,
          appPath: path.join(testDir, 'missing-cli'),
        }),
      ).toBe(false);
    });
  });

  describe('getCliVersion', () => {
    it('returns null and does not throw when called with a path that has spaces', async () => {
      // Regression test for Issue #596.
      // execFileSync (no shell) must be used so the path is passed to the OS
      // verbatim rather than through cmd.exe quoting, which fails with
      // double-leading-quote errors when spaces appear in the username.
      const pathWithSpaces =
        process.platform === 'win32'
          ? 'C:\\Users\\Anish Maheshwari\\AppData\\Local\\Programs\\opencode.exe'
          : '/home/my user with spaces/opencode';

      const version = await getCliVersion(pathWithSpaces);

      // Must return null (file not found) rather than throwing
      expect(version).toBeNull();
    });

    it('returns version from package.json when available', async () => {
      let packageName: string;
      if (process.platform === 'win32') {
        packageName = 'opencode-windows-x64';
      } else if (process.platform === 'linux') {
        packageName = process.arch === 'arm64' ? 'opencode-linux-arm64' : 'opencode-linux-x64';
      } else {
        packageName = 'opencode-ai';
      }
      const packageDir = path.join(testDir, 'node_modules', packageName);
      const binDir = path.join(testDir, 'node_modules', '.bin');
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({ name: packageName, version: '1.2.3' }),
      );

      const binName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
      const cliPath =
        process.platform === 'win32'
          ? path.join(packageDir, 'bin', binName)
          : path.join(binDir, binName);
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.writeFileSync(cliPath, '#!/bin/bash\necho "1.2.3"');

      const version = await getCliVersion(cliPath);
      expect(version).toBe('1.2.3');
    });

    it('returns null for non-existent CLI path', async () => {
      const version = await getCliVersion('/nonexistent/path/opencode');
      expect(version).toBeNull();
    });
  });
});
