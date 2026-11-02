import { describe, it, expect } from 'vitest';
import { join as pathJoin } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import {
  resolveAccomplishProfile,
  profileDataDirName,
  resolveProfileDataDir,
  resolveCleanStartDecision,
  InvalidProfileError,
  DEFAULT_DATA_DIR_NAME,
  PROFILE_DATA_DIR_PREFIX,
} from '../../../../src/main/config/profile';

type SmokeLib = typeof import('../../../../scripts/installed-app-smoke-lib.cjs');
const smokeLib = createRequire(import.meta.url)(
  '../../../../scripts/installed-app-smoke-lib.cjs',
) as SmokeLib;

describe('accomplish profile selection', () => {
  const resolve = (raw: string | undefined) => resolveAccomplishProfile(raw);

  describe('default behavior', () => {
    it('returns null when the variable is unset', () => {
      expect(resolve(undefined)).toBeNull();
    });

    it('rejects empty and whitespace-only values instead of falling back', () => {
      expect(() => resolve('')).toThrow(InvalidProfileError);
      expect(() => resolve('   ')).toThrow(InvalidProfileError);
    });
  });

  describe('valid test profile names', () => {
    it.each(['acceptance-smoke', 'acceptance-arm64', 'Accomplish-E2E-1', 'a', 'x.y_z-1'])(
      'accepts %s',
      (name: string) => {
        expect(resolve(name)).toBe(name);
      },
    );

    it('trims surrounding whitespace out of a valid value', () => {
      expect(resolve('  e2e-term  ')).toBe('e2e-term');
    });
  });

  describe('invalid profile names', () => {
    it.each([
      '/abs/path',
      'C:\\data',
      'with space',
      'has/slash',
      'has\\backslash',
      '../escape',
      'a..b',
      'ends.',
      'ends-',
      'ends_',
      'ёнcode',
      'prof:ile',
      '',
    ])('rejects %s', (name: string) => {
      expect(() => resolve(name)).toThrow(InvalidProfileError);
    });

    it('rejects names longer than 48 chars', () => {
      expect(() => resolve('x'.repeat(49))).toThrow(InvalidProfileError);
      expect(resolve('x'.repeat(48))).toBe('x'.repeat(48));
    });

    it('rejects names that start with a non-alphanumeric character', () => {
      expect(() => resolve('.hidden')).toThrow(InvalidProfileError);
      expect(() => resolve('-dash')).toThrow(InvalidProfileError);
      expect(() => resolve('_under')).toThrow(InvalidProfileError);
    });

    it('rejects the production profile name in any casing (no shadowing)', () => {
      expect(() => resolve('accomplish')).toThrow(InvalidProfileError);
      expect(() => resolve('Accomplish')).toThrow(InvalidProfileError);
      expect(() => resolve('ACCOMPLISH')).toThrow(InvalidProfileError);
    });

    it('rejects reserved Windows device names in any casing', () => {
      for (const reserved of ['con', 'nul', 'Com1', 'COM9', 'lpt3', 'aux', 'prn']) {
        expect(() => resolve(reserved)).toThrow(InvalidProfileError);
      }
    });

    it('traversal rejection covers the sneeky mixed separators', () => {
      expect(() => resolve('a/../b')).toThrow(InvalidProfileError);
    });
  });

  describe('data directory derivation and isolation', () => {
    it('uses the fixed production directory when no profile is selected', () => {
      const appData =
        process.platform === 'win32' ? 'C:\\Users\\x\\AppData\\Roaming' : '/Users/x/appdata';
      expect(resolveProfileDataDir(appData, null)).toBe(pathJoin(appData, DEFAULT_DATA_DIR_NAME));
    });

    it('prefixes override profiles so they can never equal the production directory', () => {
      const dir = resolveProfileDataDir('/appdata', 'acceptance-arm64');
      expect(dir).toBe(pathJoin('/appdata', `${PROFILE_DATA_DIR_PREFIX}acceptance-arm64`));
      expect(dir).not.toBe(pathJoin('/appdata', DEFAULT_DATA_DIR_NAME));
    });

    it('gives different profiles separate directories (no cross-talk)', () => {
      const a = resolveProfileDataDir('/appdata', 'profile-a');
      const b = resolveProfileDataDir('/appdata', 'profile-b');
      expect(a).not.toBe(b);
      expect(profileDataDirName('profile-a')).toBe(`${PROFILE_DATA_DIR_PREFIX}profile-a`);
    });
  });

  describe('CLEAN_START destructive-cleanup decisions', () => {
    it('refuses on the default profile in packaged mode (user data protection)', () => {
      expect(resolveCleanStartDecision({ profileName: null, isPackaged: true })).toBe('refuse');
    });

    it('refuses on the default profile in development and CI/E2E modes too', () => {
      // The default Accomplish profile is protected in EVERY mode: dev/CI
      // flows that need a wipe must select an explicit override profile.
      expect(resolveCleanStartDecision({ profileName: null, isPackaged: false })).toBe('refuse');
    });

    it('allows destructive cleanup for override profiles on any build type', () => {
      expect(resolveCleanStartDecision({ profileName: 'acceptance-smoke', isPackaged: true })).toBe(
        'delete',
      );
      expect(
        resolveCleanStartDecision({ profileName: 'acceptance-smoke', isPackaged: false }),
      ).toBe('delete');
    });
  });
});

describe('installed-app-smoke profile ownership (installed-app-smoke-lib.cjs)', () => {
  it('generates validation-passing acceptance profile names', () => {
    for (const date of [new Date('2026-11-02T10:00:00Z'), new Date()]) {
      const name = smokeLib.generateProfileName(date);
      expect(name).toMatch(/^acceptance-/);
      expect(smokeLib.isValidProfileName(name)).toBe(true);
    }
  });

  it('generates distinct names one millisecond apart (collision-retry safety)', () => {
    const first = smokeLib.generateProfileName(new Date('2026-11-02T10:00:00.000Z'));
    const second = smokeLib.generateProfileName(new Date('2026-11-02T10:00:00.001Z'));
    expect(second).not.toBe(first);
  });

  it('colliding candidate directories are skipped, never reused or deleted', () => {
    // First candidate "exists" (collision) → generator must move on to a
    // fresh candidate instead of pointing cleanup at a pre-existing dir.
    const appDataRoot = '/appdata-ro-test';
    let calls = 0;
    const collidingExists = () => calls++ === 0;
    const selection = smokeLib.findUniqueProfileDataDir(appDataRoot, collidingExists);
    expect(calls).toBe(2); // first candidate refused, second accepted
    expect(selection.profileName).toMatch(/^acceptance-/);
  });

  it('selection returns a directory that does not exist (real fs)', () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'smoke-sel-'));
    try {
      const selection = smokeLib.findUniqueProfileDataDir(tmp, existsSync);
      expect(existsSync(selection.dataDir)).toBe(false);
      expect(selection.dataDir).toMatch(/Accomplish-acceptance-/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails closed when no unique profile can be generated', () => {
    expect(() => smokeLib.findUniqueProfileDataDir('/appdata-test', () => true, 4)).toThrow(
      smokeLib.ProfileSelectionError,
    );
  });

  it('deletes only an owned, existing directory (real fs)', () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'smoke-own-'));
    try {
      const ownedDir = pathJoin(tmp, 'Accomplish-acceptance-owned');
      mkdirSync(ownedDir, { recursive: true });
      writeFileSync(pathJoin(ownedDir, 'marker.txt'), 'probe');

      const result = smokeLib.deleteOwnedProfileDataDir(ownedDir, false, rmSync);
      expect(result.deleted).toBe(true);
      expect(existsSync(ownedDir)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses cleanup when ownership is uncertain (pre-existing directory)', () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'smoke-noown-'));
    try {
      const preExistingDir = pathJoin(tmp, 'Accomplish-acceptance-preexisting');
      mkdirSync(preExistingDir, { recursive: true });
      writeFileSync(pathJoin(preExistingDir, 'user-data.txt'), 'must survive');

      const result = smokeLib.deleteOwnedProfileDataDir(preExistingDir, true, rmSync);
      expect(result.deleted).toBe(false);
      expect(existsSync(preExistingDir)).toBe(true);
      expect(readFileSync(pathJoin(preExistingDir, 'user-data.txt'), 'utf-8')).toBe('must survive');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ownership rule: only a run-created directory is deletable', () => {
    expect(smokeLib.resolveCleanupOwnership(false).mayDelete).toBe(true);
    expect(smokeLib.resolveCleanupOwnership(true).mayDelete).toBe(false);
  });

  it('PE probe detects ARM64 machine type on a synthetic PE file', () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'smoke-pe-'));
    try {
      const filePath = pathJoin(tmp, 'node.exe');
      const header = Buffer.alloc(0x100, 0);
      header.write('MZ', 0, 'ascii'); // DOS magic
      header.writeInt32LE(0x80, 0x3c); // e_lfanew -> 0x80
      header.write('PE', 0x80, 'ascii'); // PE signature
      header.writeUInt16LE(0xaa64, 0x80 + 4); // IMAGE_FILE_MACHINE_ARM64
      writeFileSync(filePath, header);
      expect(smokeLib.readPeMachine(filePath)).toBe('arm64');

      const x64Path = pathJoin(tmp, 'node-x64.exe');
      header.writeUInt16LE(0x8664, 0x80 + 4); // IMAGE_FILE_MACHINE_AMD64
      writeFileSync(x64Path, header);
      expect(smokeLib.readPeMachine(x64Path)).toBe('x64');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Mach-O probe detects x64 cputype and rejects non-Mach-O files', () => {
    const tmp = mkdtempSync(pathJoin(tmpdir(), 'smoke-macho-'));
    try {
      const filePath = pathJoin(tmp, 'node');
      const header = Buffer.alloc(0x20, 0);
      header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
      header.writeUInt32LE(0x01000007, 4); // CPU_TYPE_X86_64
      writeFileSync(filePath, header);
      expect(smokeLib.readMachOCpuType(filePath)).toBe('x64');

      const arm64Path = pathJoin(tmp, 'node-arm64');
      header.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
      writeFileSync(arm64Path, header);
      expect(smokeLib.readMachOCpuType(arm64Path)).toBe('arm64');

      const junkPath = pathJoin(tmp, 'junk');
      writeFileSync(junkPath, 'not a binary');
      expect(smokeLib.readMachOCpuType(junkPath)).toBeNull();
      expect(smokeLib.readPeMachine(junkPath)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
