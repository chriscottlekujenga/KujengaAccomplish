import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DESKTOP_FILE_NAME,
  GATEWAY_INFO_FILE,
  findExistingInstance,
  forwardDeepLink,
  getDesktopFileContent,
  getDesktopFilePath,
  installDesktopIntegration,
  uninstallDesktopIntegration,
  writeInstanceInfo,
  readInstanceInfo,
} from '../../src/desktop-integration.js';
import { deepLinkEvent } from '../../src/gateway.js';

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    dataDir: '/tmp/accomplish-data',
    nodeBin: '/usr/bin/node',
    hostEntryPath: '/repo/apps/host/dist/index.js',
    webDist: '/repo/apps/web/dist/client',
    ...overrides,
  } as Parameters<typeof getDesktopFileContent>[0] & { dataHome?: string };
}

describe('desktop file content', () => {
  it('references the host CLI with the isolated data dir and %u for deep links', () => {
    const content = getDesktopFileContent(makeOptions());
    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain(
      'Exec=/usr/bin/node /repo/apps/host/dist/index.js --launch --data-dir /tmp/accomplish-data --web-dist /repo/apps/web/dist/client %u',
    );
    expect(content).toContain('MimeType=x-scheme-handler/accomplish;');
    expect(content).toContain('Terminal=false');
  });

  it('omits the web-dist argument when not built', () => {
    const content = getDesktopFileContent(makeOptions({ webDist: null }));
    expect(content).not.toContain('--web-dist');
  });

  it('includes the icon only when the file exists', () => {
    const iconPath = path.join(mkdtempSync(path.join(tmpdir(), 'icon-')), 'icon.png');
    try {
      writeFileSync(iconPath, 'png');
      const content = getDesktopFileContent(makeOptions({ iconPath }));
      expect(content).toContain(`Icon=${iconPath}`);
    } finally {
      rmSync(path.dirname(iconPath), { recursive: true, force: true });
    }
  });

  it('skips the icon when missing', () => {
    const content = getDesktopFileContent(makeOptions({ iconPath: '/nonexistent/icon.png' }));
    expect(content).not.toContain('Icon=');
  });
});

describe('install/uninstall', () => {
  it('writes the .desktop file and registers the scheme', () => {
    const dataHome = mkdtempSync(path.join(tmpdir(), 'apps-'));
    const commands: string[] = [];
    try {
      installDesktopIntegration({
        ...makeOptions({ dataHome }),
        exec: (command: string) => {
          commands.push(command);
          return '';
        },
      });
      const desktopPath = path.join(dataHome, 'applications', DESKTOP_FILE_NAME);
      expect(existsSync(desktopPath)).toBe(true);
      expect(commands).toContain(
        `xdg-mime default ${DESKTOP_FILE_NAME} x-scheme-handler/accomplish`,
      );
      expect(commands.some((c) => c.startsWith('update-desktop-database'))).toBe(true);

      uninstallDesktopIntegration({
        ...makeOptions({ dataHome }),
        exec: () => '',
      });
      expect(existsSync(desktopPath)).toBe(false);
    } finally {
      rmSync(dataHome, { recursive: true, force: true });
    }
  });
});

describe('instance info', () => {
  it('round-trips { port, pid } and tolerates missing files', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'instance-'));
    try {
      expect(readInstanceInfo(dataDir)).toBeNull();
      writeInstanceInfo(dataDir, { port: 41999, pid: 123 });
      expect(readInstanceInfo(dataDir)).toEqual({ port: 41999, pid: 123 });
      const mode =
        (readFileSync(path.join(dataDir, GATEWAY_INFO_FILE)) as unknown as { mode?: number }) ??
        null;
      void mode;
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('treats malformed info as absent', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'instance-'));
    try {
      writeFileSync(path.join(dataDir, GATEWAY_INFO_FILE), '{not json');
      expect(readInstanceInfo(dataDir)).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('findExistingInstance', () => {
  it('returns null without info or with a dead pid', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'instance-'));
    try {
      expect(await findExistingInstance(dataDir)).toBeNull();
      writeInstanceInfo(dataDir, { port: 41999, pid: -1 });
      expect(await findExistingInstance(dataDir)).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('returns the info when the pid is alive and /health responds ok', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'instance-'));
    try {
      writeInstanceInfo(dataDir, { port: 41999, pid: process.pid });
      const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
      const found = await findExistingInstance(dataDir, { fetchImpl: fetchImpl as never });
      expect(found).toEqual({ port: 41999, pid: process.pid });
      expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:41999/health', { method: 'GET' });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('returns null when health does not respond ok', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'instance-'));
    try {
      writeInstanceInfo(dataDir, { port: 41999, pid: process.pid });
      const fetchImpl = vi.fn(async () => new Response('gone', { status: 503 }));
      expect(await findExistingInstance(dataDir, { fetchImpl: fetchImpl as never })).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('deep links', () => {
  it('classifies callback URLs like the Electron protocol handler', () => {
    expect(deepLinkEvent('accomplish://callback/mcp?state=x')).toBe('mcp-callback');
    expect(deepLinkEvent('accomplish://callback/google?code=y')).toBe('auth-callback');
    expect(deepLinkEvent('accomplish://other/thing')).toBeNull();
    expect(deepLinkEvent('https://evil.example.com')).toBeNull();
  });

  it('forwards callback URLs to the running gateway with the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"accepted":true}', { status: 200 }));
    const ok = await forwardDeepLink(41999, 'tok', 'accomplish://callback/mcp?state=1', {
      fetchImpl: fetchImpl as never,
    });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:41999/deep-link');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse(String(init.body))).toEqual({ url: 'accomplish://callback/mcp?state=1' });
  });
});

describe('getDesktopFilePath', () => {
  it('lives under the applications directory', () => {
    const dataHome = '/tmp/fake-data-home';
    expect(getDesktopFilePath(makeOptions({ dataHome }))).toBe(
      path.join('/tmp/fake-data-home', 'applications', DESKTOP_FILE_NAME),
    );
  });
});
