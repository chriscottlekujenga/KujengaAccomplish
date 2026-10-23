import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { runDesktopHelper } from '../helper-exec.js';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecMock = ReturnType<typeof vi.fn>;
type ExecCallArgs = [string, string[], { timeout: number; maxBuffer: number }, ExecCallback];

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockExecFile = execFile as unknown as ExecMock;

/** Make execFile's mock complete with the given callback result. */
function resolveExecWith(error: Error | null, stdout: string, stderr: string): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[3] as ExecCallback;
    callback(error, stdout, stderr);
  });
}

function firstCallArgs(): ExecCallArgs {
  const call = mockExecFile.mock.calls[0];
  if (!call) {
    throw new Error('exepected execFile to have been called');
  }
  return call as unknown as ExecCallArgs;
}

describe('runDesktopHelper', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    mockExecFile.mockReset();
    mockExecFile.mockImplementation(() => {
      throw new Error('unexpected execFile call');
    });
  });

  it('parses a success JSON line into ok:true with the payload as data', async () => {
    resolveExecWith(null, '{"ok":true,"applications":[{"id":"a5"}]}\n', '');
    const result = await runDesktopHelper(['list']);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ ok: true, applications: [{ id: 'a5' }] });
  });

  it('uses the LAST parseable JSON line and tolerates stderr noise', async () => {
    const stdout = [
      'Gtk-Message: window not shown',
      '{"ok":true,"controls":[{"id":"a5/f0/p0.4.0"}]}',
    ].join('\n');
    resolveExecWith(null, `${stdout}\n`, 'some diagnostic noise\n');
    const result = await runDesktopHelper(['controls', '--window', 'Notes']);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ ok: true, controls: [{ id: 'a5/f0/p0.4.0' }] });
  });

  it('returns the error JSON payload when the process exits non-zero', async () => {
    const execError = Object.assign(new Error('Command failed: python3 helper.py'), { code: 1 });
    resolveExecWith(execError, '{"ok":false,"error":"target not found"}\n', '');
    const result = await runDesktopHelper(['invoke', '--id', 'stale']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('target not found');
  });

  it('falls back to the stderr tail when output is not JSON', async () => {
    const execError = Object.assign(new Error('python3 exited with code 1'), { code: 1 });
    resolveExecWith(execError, 'Traceback (most recent call last):', 'ModuleNotFoundError: gi');
    const result = await runDesktopHelper(['list']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ModuleNotFoundError: gi');
  });

  it('fails ok:false when the helper file is missing (path in message)', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await runDesktopHelper(['list']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('scripts/desktop-helper.py');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('passes the helper path as args[0] and respects a custom timeout', async () => {
    resolveExecWith(null, '{"ok":true}\n', '');
    await runDesktopHelper(['screenshot', '--out', '/tmp/x.png'], 123_000);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = firstCallArgs();
    expect(file).toBe('python3');
    expect(path.basename(args[0])).toBe('desktop-helper.py');
    expect(args.slice(1)).toEqual(['screenshot', '--out', '/tmp/x.png']);
    expect(options).toMatchObject({ timeout: 123_000, maxBuffer: 4 * 1024 * 1024 });
  });
});
