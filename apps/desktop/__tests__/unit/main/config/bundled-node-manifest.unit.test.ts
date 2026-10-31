import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

// Raw CJS source access for stage-daemon-deps.cjs is intentional: its target
// allowlist is not exported, so we assert the contract between both packaging
// scripts here so a platform-enum mismatch fails fast in CI.
const stageDaemonSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'scripts', 'stage-daemon-deps.cjs'),
  'utf8',
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PLATFORMS } = require('../../../../scripts/node-version.cjs') as {
  PLATFORMS: Array<{ name: string; file: string; extract: string; sha256: string }>;
};

type PlatformName =
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'win32-x64'
  | 'win32-arm64';

function extractStagedList(): string[] {
  const match = stageDaemonSource.match(/SUPPORTED_TARGET_PLATFORMS = new Set\(\[([\s\S]*?)\]\)/);
  expect(match).not.toBeNull();
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('node-version.cjs bundling manifest', () => {
  it('declares entries for every supported platform/arch pair', () => {
    const names = PLATFORMS.map((entry) => entry.name);
    const expected: PlatformName[] = [
      'darwin-x64',
      'darwin-arm64',
      'linux-x64',
      'linux-arm64',
      'win32-x64',
      'win32-arm64',
    ];
    expect(names).toEqual(expect.arrayContaining(expected));
  });

  it('uses win-<arch> archive filenames on win32 (matching Node.js dist naming)', () => {
    const win32Entries = PLATFORMS.filter((entry) => entry.name.startsWith('win32-'));
    expect(win32Entries.map((entry) => ({ name: entry.name, file: entry.file }))).toEqual([
      { name: 'win32-x64', file: expect.stringMatching(/^node-v\d+\.\d+\.\d+-win-x64\.zip$/) },
      { name: 'win32-arm64', file: expect.stringMatching(/^node-v\d+\.\d+\.\d+-win-arm64\.zip$/) },
    ]);
  });

  it('pins the verified sha256 for the Windows ARM64 Node archive', () => {
    // Verified against https://nodejs.org/dist/v24.15.0/SHASUMS256.txt during
    // M1 (Windows ARM64 runtime support). If this value changes, re-download
    // and re-verify the archive through node-version.cjs before updating it.
    const entry = PLATFORMS.find((p) => p.name === 'win32-arm64');
    expect(entry?.sha256).toBe('c9eb7402eda26e2ba7e44b6727fc85a8de56c5095b1f71ebd3062892211aa116');
  });

  it('has a full-length sha256 for every manifest entry', () => {
    expect(PLATFORMS.length).toBe(6);
    for (const entry of PLATFORMS) {
      expect(`${entry.name}: ${entry.sha256}`).toMatch(/:\s[a-f0-9]{64}$/);
    }
  });

  it('declares every manifest platform in the dependency stager allowlist', () => {
    const staged = extractStagedList();
    for (const entry of PLATFORMS) {
      expect(staged).toContain(entry.name);
    }
    expect(extractStagedList()).toContain('win32-arm64');
  });
});
