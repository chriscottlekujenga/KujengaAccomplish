import { describe, it, expect, afterEach, vi } from 'vitest';

type PlatformInfoModule = typeof import('../../../src/opencode/cli-path-utils.js');

const originalPlatform = process.platform;
const originalArch = process.arch;

function setProcessTarget(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

// getWindowsPackageNames caches its result internally, so each scenario needs
// a fresh module instance. spawnSync is mocked per scenario to control the
// Windows AVX2 probe while keeping execFileSync (used by getCliVersion) real.
async function loadCliPathUtils(avx2Probes: Array<Record<string, unknown> | undefined> = []) {
  const spawnSyncMock = vi.fn();
  for (const result of avx2Probes) {
    if (result) {
      spawnSyncMock.mockReturnValueOnce(result);
    } else {
      spawnSyncMock.mockImplementationOnce(() => {
        throw new Error('spawn disabled');
      });
    }
  }
  vi.resetModules();
  vi.doMock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
      ...actual,
      spawnSync: spawnSyncMock,
    };
  });
  const module = (await import('../../../src/opencode/cli-path-utils.js')) as PlatformInfoModule;
  return { module, spawnSyncMock };
}

describe('OpenCode platform package resolution', () => {
  afterEach(() => {
    setProcessTarget(originalPlatform, originalArch);
    vi.resetModules();
    vi.doUnmock('child_process');
    vi.restoreAllMocks();
  });

  describe('Windows x64 package selection (AVX2 handling preserved)', () => {
    it('prefers the full x64 package when the AVX2 probe passes', async () => {
      setProcessTarget('win32', 'x64');
      const { module, spawnSyncMock } = await loadCliPathUtils([{ status: 0, stdout: 'true\n' }]);
      const { getWindowsPackageNames } = module;

      expect(getWindowsPackageNames()).toEqual([
        'opencode-windows-x64',
        'opencode-windows-x64-baseline',
      ]);
      expect(spawnSyncMock).toHaveBeenCalled();
    });

    it('falls back to the baseline package first when AVX2 is unsupported', async () => {
      setProcessTarget('win32', 'x64');
      const { module, spawnSyncMock } = await loadCliPathUtils([{ status: 0, stdout: 'false\n' }]);
      const { getWindowsPackageNames } = module;

      expect(getWindowsPackageNames()).toEqual([
        'opencode-windows-x64-baseline',
        'opencode-windows-x64',
      ]);
      expect(spawnSyncMock).toHaveBeenCalled();
    });

    it('treats a failed AVX2 probe as unsupported', async () => {
      setProcessTarget('win32', 'x64');
      const { module } = await loadCliPathUtils([undefined]);
      const { getWindowsPackageNames } = module;

      expect(getWindowsPackageNames()).toEqual([
        'opencode-windows-x64-baseline',
        'opencode-windows-x64',
      ]);
    });
  });

  describe('Windows ARM64 package selection', () => {
    it('selects only the native arm64 package and never resolves x64', async () => {
      setProcessTarget('win32', 'arm64');
      const { module, spawnSyncMock } = await loadCliPathUtils([{ status: 0, stdout: 'true\n' }]);
      const { getWindowsPackageNames } = module;

      expect(getWindowsPackageNames()).toEqual(['opencode-windows-arm64']);
      // The x64 AVX2 probe must not run on arm64 — its result is meaningless
      // there and could re-introduce x64 package selection semantics.
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    it('exposes the arm64 package through getOpenCodePlatformInfo with a Windows binary name', async () => {
      setProcessTarget('win32', 'arm64');
      const { module } = await loadCliPathUtils();
      const { getOpenCodePlatformInfo } = module;

      const info = getOpenCodePlatformInfo();
      expect(info.packageNames).toEqual(['opencode-windows-arm64']);
      expect(info.binaryName).toBe('opencode.exe');
    });
  });

  describe('macOS regression (launcher resolution for every arch)', () => {
    it('uses the opencode-ai launcher package on darwin arm64', async () => {
      setProcessTarget('darwin', 'arm64');
      const { module } = await loadCliPathUtils();
      const { getOpenCodePlatformInfo } = module;

      const info = getOpenCodePlatformInfo();
      expect(info.packageNames).toEqual(['opencode-ai']);
      expect(info.binaryName).toBe('opencode');
    });

    it('uses the opencode-ai launcher package on darwin x64', async () => {
      setProcessTarget('darwin', 'x64');
      const { module } = await loadCliPathUtils();
      const { getOpenCodePlatformInfo } = module;

      const info = getOpenCodePlatformInfo();
      expect(info.packageNames).toEqual(['opencode-ai']);
      expect(info.binaryName).toBe('opencode');
    });
  });

  describe('Linux package selection regression', () => {
    it('keeps arm64 musl-aware selection on linux arm64', async () => {
      setProcessTarget('linux', 'arm64');
      const { module } = await loadCliPathUtils();
      const { getOpenCodePlatformInfo } = module;

      const info = getOpenCodePlatformInfo();
      expect(info.packageNames).toEqual(['opencode-linux-arm64', 'opencode-linux-arm64-musl']);
      expect(info.binaryName).toBe('opencode');
    });

    it('keeps baseline/musl selection on linux x64', async () => {
      setProcessTarget('linux', 'x64');
      const { module } = await loadCliPathUtils();
      const { getOpenCodePlatformInfo } = module;

      const info = getOpenCodePlatformInfo();
      expect(info.packageNames).toEqual([
        'opencode-linux-x64',
        'opencode-linux-x64-baseline',
        'opencode-linux-x64-musl',
        'opencode-linux-x64-baseline-musl',
      ]);
      expect(info.binaryName).toBe('opencode');
    });
  });
});
