import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pickFiles, pickFolder, MAX_PICKED_FILES } from '../../src/file-picker.js';

type ExecFn = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;

/**
 * The picker validates paths against the REAL home directory, so fixtures
 * must live under $HOME. A temp dir inside home keeps tests hermetic.
 */
function makeHomeFixture(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'picker-home-'));
  // tmpdir() may resolve outside home on some systems; pickFolder/pickFiles
  // validate against os.homedir(), so instead create under home directly.
  rmSync(dir, { recursive: true, force: true });
  const home = path.join(process.env.HOME ?? '', '.accomplish-picker-test-');
  mkdirSync(home, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(home, name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return home;
}

function cleanup(fixture: string): void {
  rmSync(fixture, { recursive: true, force: true });
}

describe('pickFolder', () => {
  it('returns the selected directory path', async () => {
    const fixture = makeHomeFixture();
    try {
      const exec: ExecFn = async () => ({ code: 0, stdout: `${fixture}\n` });
      expect(await pickFolder(exec)).toBe(fixture);
    } finally {
      cleanup(fixture);
    }
  });

  it('returns null when the user cancels (exit code 1)', async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: '' });
    expect(await pickFolder(exec)).toBeNull();
  });

  it('uses zenity --file-selection --directory', async () => {
    let seen: readonly string[] = [];
    const exec: ExecFn = async (args) => {
      seen = args;
      return { code: 1, stdout: '' };
    };
    await pickFolder(exec);
    expect(seen).toEqual(['--file-selection', '--directory']);
  });

  it('rejects paths outside the home directory', async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: '/etc\n' });
    await expect(pickFolder(exec)).rejects.toThrow(/outside allowed directories/);
  });
});

describe('pickFiles', () => {
  it('builds attachment descriptors with type, size, and text content', async () => {
    const fixture = makeHomeFixture({
      'notes.md': '# hello\n',
      'app.ts': 'export {};\n',
      'photo.png': 'not-a-real-png',
    });
    try {
      const exec: ExecFn = async () => ({
        code: 0,
        stdout: `${path.join(fixture, 'notes.md')}\n${path.join(fixture, 'app.ts')}\n${path.join(fixture, 'photo.png')}\n`,
      });
      const files = await pickFiles(exec);
      expect(files).toHaveLength(3);
      const byName = new Map(files.map((f) => [f.name, f]));
      expect(byName.get('notes.md')).toMatchObject({
        type: 'text',
        size: 8,
        content: '# hello\n',
      });
      expect(byName.get('app.ts')).toMatchObject({ type: 'code', content: 'export {};\n' });
      const png = byName.get('photo.png');
      expect(png).toMatchObject({ type: 'image' });
      expect(png?.content).toBeUndefined();
      for (const file of files) {
        expect(typeof file.id).toBe('string');
      }
    } finally {
      cleanup(fixture);
    }
  });

  it('returns an empty array on cancel', async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: '' });
    expect(await pickFiles(exec)).toEqual([]);
  });

  it('rejects more than five files', async () => {
    const fixture = makeHomeFixture();
    try {
      const many = Array.from({ length: MAX_PICKED_FILES + 1 }, (_, i) =>
        path.join(fixture, `f${i}`),
      );
      writeFileSync(many[0], 'x');
      const exec: ExecFn = async () => ({ code: 0, stdout: many.join('\n') + '\n' });
      await expect(pickFiles(exec)).rejects.toThrow(/maximum of 5 files/);
    } finally {
      cleanup(fixture);
    }
  });

  it('rejects files outside the home directory', async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: '/etc/passwd\n' });
    await expect(pickFiles(exec)).rejects.toThrow(/outside allowed directories/);
  });

  it('rejects oversized files (10 MB limit)', async () => {
    const fixture = makeHomeFixture({ 'big.txt': '' });
    try {
      const bigPath = path.join(fixture, 'big.txt');
      writeFileSync(bigPath, 'x'.repeat(10 * 1024 * 1024 + 1));
      const exec: ExecFn = async () => ({ code: 0, stdout: `${bigPath}\n` });
      await expect(pickFiles(exec)).rejects.toThrow(/10 MB size limit/);
    } finally {
      cleanup(fixture);
    }
  });
});
