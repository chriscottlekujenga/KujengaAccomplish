import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { HelperResult } from '../helper-exec.js';
import { toolHandlers, type ToolResult } from '../index.js';

const mocks = vi.hoisted(() => ({
  runDesktopHelper: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../helper-exec.js', () => ({
  runDesktopHelper: mocks.runDesktopHelper,
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

const mockHelper = mocks.runDesktopHelper as ReturnType<typeof vi.fn>;
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

const CONTROLS_PAYLOAD: HelperResult = {
  ok: true,
  data: {
    window: { id: 'a5/f0', role: 'frame', name: 'Notes', states: ['active'] },
    application: 'GNOME Notes',
    controls: [
      {
        id: 'a5/f0/p0.0',
        role: 'push button',
        name: 'Close',
        actions: ['click'],
        states: ['sensitive'],
      },
      {
        id: 'a5/f0/p0.4.0',
        role: 'push button',
        name: 'OK',
        actions: ['click'],
        states: ['sensitive'],
      },
      { id: 'a5/f0/p0.5', role: 'text', name: 'Title field', actions: ['click'], states: [] },
    ],
  },
};

const AMBIGUOUS_CONTROLS_PAYLOAD: HelperResult = {
  ok: true,
  data: {
    window: { id: 'a7/f0', role: 'frame', name: 'Dialog', states: ['active'] },
    application: 'GTK Demo',
    controls: [
      { id: 'a7/f0/p1', role: 'push button', name: 'OK', actions: ['click'], states: [] },
      { id: 'a7/f0/p2', role: 'push button', name: 'OK', actions: ['click'], states: [] },
    ],
  },
};

const LIST_PAYLOAD: HelperResult = {
  ok: true,
  data: {
    applications: [
      {
        id: 'a5',
        name: 'GNOME Notes',
        frames: [{ id: 'a5/f0', role: 'frame', name: 'Notes', states: ['active'] }],
      },
    ],
  },
};

/** Route helper calls by command name (args[0]). */
function installHelperRouting(routes: Record<string, HelperResult>): void {
  mockHelper.mockImplementation((args: string[]) => {
    const payload = routes[args[0]];
    if (!payload) {
      throw new Error(`unexpected helper command: ${args[0]}`);
    }
    return Promise.resolve(payload);
  });
}

async function callTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const handler = toolHandlers[tool];
  if (!handler) {
    throw new Error(`missing handler: ${tool}`);
  }
  return handler(args);
}

beforeEach(() => {
  mockHelper.mockReset();
  mockExecFile.mockReset();
  mockExecFile.mockImplementation(() => {
    throw new Error('unexpected execFile call');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('toolHandlers — desktop_launch_app', () => {
  it('rejects relative and non-.desktop paths', async () => {
    for (const badPath of ['apps/firefox.desktop', '/usr/share/applications/firefox.sh', '']) {
      const result = await callTool('desktop_launch_app', { desktopFile: badPath });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('absolute path ending in .desktop');
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('denies blocklisted desktop files', async () => {
    const result = await callTool('desktop_launch_app', {
      desktopFile: '/opt/1Password/1password.desktop',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Blocked by desktop-control blocklist: 1Password');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('launches via gio and reports the basename', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      (args[3] as (err: Error | null, stdout: string, stderr: string) => void)(null, '', '');
    });
    const result = await callTool('desktop_launch_app', {
      desktopFile: '/usr/share/applications/firefox.desktop',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Launched firefox.desktop.');
    // promisify appends trailing callback args, so assert on the first three.
    const gioCall = mockExecFile.mock.calls[0] as unknown as unknown[];
    expect(gioCall.slice(0, 3)).toEqual([
      'gio',
      ['launch', '/usr/share/applications/firefox.desktop'],
      { timeout: 15000 },
    ]);
  });
});

describe('toolHandlers — desktop_list_windows', () => {
  it('returns pretty-printed applications on success', async () => {
    installHelperRouting({ list: LIST_PAYLOAD });
    const result = await callTool('desktop_list_windows', {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(LIST_PAYLOAD.data?.applications);
    expect(mockHelper).toHaveBeenCalledWith(['list']);
  });

  it('isError when the helper fails', async () => {
    mockHelper.mockResolvedValue({ ok: false, error: 'no session bus' });
    const result = await callTool('desktop_list_windows', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no session bus');
  });
});

describe('toolHandlers — desktop_find_controls', () => {
  it('passes window/depth to the helper and returns JSON', async () => {
    mockHelper.mockResolvedValue(CONTROLS_PAYLOAD);
    const result = await callTool('desktop_find_controls', { windowTitle: 'Notes', maxDepth: 4 });
    expect(mockHelper).toHaveBeenCalledWith(['controls', '--window', 'Notes', '--max-depth', '4']);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.windowTitle).toBe('Notes');
    expect(parsed.application).toBe('GNOME Notes');
    expect(parsed.controls).toHaveLength(3);
  });

  it('rejects out-of-range maxDepth', async () => {
    const result = await callTool('desktop_find_controls', { windowTitle: 'Notes', maxDepth: 13 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('between 1 and 12');
    expect(mockHelper).not.toHaveBeenCalled();
  });

  it('denies via the helper-returned application name (blocklist)', async () => {
    mockHelper.mockResolvedValue({
      ok: true,
      data: {
        window: { id: 'a9/f0', role: 'frame', name: 'My Vault' },
        application: 'Bitwarden',
        controls: [],
      },
    });
    const result = await callTool('desktop_find_controls', { windowTitle: 'My Vault' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Blocked by desktop-control blocklist: Bitwarden');
  });
});

describe('toolHandlers — desktop_invoke', () => {
  it('errors on ambiguous control names', async () => {
    installHelperRouting({ controls: AMBIGUOUS_CONTROLS_PAYLOAD });
    const result = await callTool('desktop_invoke', { windowTitle: 'Dialog', controlName: 'OK' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Ambiguous control "OK"');
    expect(result.content[0].text).toContain('OK');
  });

  it('resolves the control and invokes it with the resolved id', async () => {
    installHelperRouting({
      controls: CONTROLS_PAYLOAD,
      invoke: { ok: true, data: { invoked: true, target: { id: 'a5/f0/p0.4.0', name: 'OK' } } },
    });
    const result = await callTool('desktop_invoke', { windowTitle: 'Notes', controlName: 'ok' });
    expect(result.isError).toBeUndefined();
    expect(mockHelper).toHaveBeenNthCalledWith(2, [
      'invoke',
      '--id',
      'a5/f0/p0.4.0',
      '--action',
      'click',
    ]);
    expect(result.content[0].text).toContain("Invoked click on push button 'OK'. Result:");
    expect(result.content[0].text).toContain('a5/f0/p0.4.0');
  });

  it('isError when invoke helper fails', async () => {
    installHelperRouting({
      controls: CONTROLS_PAYLOAD,
      invoke: { ok: false, error: 'action not supported' },
    });
    const result = await callTool('desktop_invoke', { windowTitle: 'Notes', controlName: 'OK' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('action not supported');
  });
});

describe('toolHandlers — desktop_read', () => {
  it('reads the window frame node when no controlName is given', async () => {
    installHelperRouting({
      controls: CONTROLS_PAYLOAD,
      read: {
        ok: true,
        data: {
          node: {
            id: 'a5/f0',
            role: 'frame',
            name: 'Notes',
            states: ['active'],
            text: 'Hello world',
          },
        },
      },
    });
    const result = await callTool('desktop_read', { windowTitle: 'Notes' });
    expect(result.isError).toBeUndefined();
    expect(mockHelper).toHaveBeenNthCalledWith(2, [
      'read',
      '--id',
      'a5/f0',
      '--start',
      '0',
      '--end',
      '400',
    ]);
    expect(JSON.parse(result.content[0].text)).toEqual({
      name: 'Notes',
      role: 'frame',
      states: ['active'],
      text: 'Hello world',
    });
  });

  it('reads a resolved control when controlName is given', async () => {
    installHelperRouting({
      controls: CONTROLS_PAYLOAD,
      read: {
        ok: true,
        data: {
          node: {
            id: 'a5/f0/p0.5',
            role: 'text',
            name: 'Title field',
            states: [],
            text: 'Groceries',
          },
        },
      },
    });
    const result = await callTool('desktop_read', { windowTitle: 'Notes', controlName: 'title' });
    expect(mockHelper).toHaveBeenNthCalledWith(2, [
      'read',
      '--id',
      'a5/f0/p0.5',
      '--start',
      '0',
      '--end',
      '400',
    ]);
    expect(JSON.parse(result.content[0].text).text).toBe('Groceries');
  });

  it('can hit the blocklist', async () => {
    mockHelper.mockResolvedValue({
      ok: true,
      data: {
        window: { id: 'a9/f0', role: 'frame', name: 'LastPass' },
        application: 'LastPass',
        controls: [],
      },
    });
    const result = await callTool('desktop_read', { windowTitle: 'Anything' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Blocked by desktop-control blocklist: LastPass');
  });
});

describe('toolHandlers — desktop_screenshot', () => {
  it('defaults to a cw-relative .png path and passes --out', async () => {
    installHelperRouting({
      screenshot: {
        ok: true,
        data: { uri: path.join(process.cwd(), 'desktop-screenshot-1729000000000.png') },
      },
    });
    const result = await callTool('desktop_screenshot', {});
    expect(result.isError).toBeUndefined();
    const helperArgs = (mockHelper.mock.calls[0]?.[0] ?? []) as string[];
    expect(helperArgs[0]).toBe('screenshot');
    const outFlag = helperArgs.indexOf('--out');
    expect(outFlag).toBeGreaterThan(-1);
    const outPath = helperArgs[outFlag + 1];
    expect(path.dirname(outPath)).toBe(process.cwd());
    expect(path.basename(outPath)).toMatch(/^desktop-screenshot-\d+\.png$/);
    expect(result.content[0].text).toContain('Screenshot saved to');
  });

  it('rejects non-png or relative outputFile', async () => {
    for (const bad of ['relative.png', '/tmp/shot.jpg']) {
      const result = await callTool('desktop_screenshot', { outputFile: bad });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('absolute path ending in .png');
    }
    expect(mockHelper).not.toHaveBeenCalled();
  });

  it('isError with a consent message when the helper fails', async () => {
    mockHelper.mockResolvedValue({
      ok: false,
      error: 'Screenshot portal interaction declined by user',
    });
    const result = await callTool('desktop_screenshot', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Portal screenshot requires interactive user consent; it was not granted (Screenshot portal interaction declined by user)',
    );
  });
});
