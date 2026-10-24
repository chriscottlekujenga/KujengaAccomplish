import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  buildMcpServers,
  type BuildMcpServersOptions,
} from '../../../src/opencode/generator-mcp.js';

// Always-registered MCP tools — their dist entries must exist on disk for
// buildMcpServers to succeed, so the tests materialize them in a temp dir.
const REQUIRED_MCP_DIST_ENTRIES: Array<[string, string]> = [
  ['request-connector-auth', 'dist/index.mjs'],
  ['complete-task', 'dist/index.mjs'],
  ['start-task', 'dist/index.mjs'],
];

describe('buildMcpServers — linux-desktop', () => {
  let testDir: string;
  let mcpToolsPath: string;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `generator-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mcpToolsPath = path.join(testDir, 'mcp-tools');
    for (const [toolName, relEntry] of REQUIRED_MCP_DIST_ENTRIES) {
      const entryPath = path.join(mcpToolsPath, toolName, relEntry);
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      fs.writeFileSync(entryPath, `// ${toolName} bundled entry`);
    }
    // Browser-config scenarios register dev-browser-mcp; materialize its dist
    // entry up front so those tests don't have to re-create it.
    const devBrowserEntry = path.join(mcpToolsPath, 'dev-browser-mcp', 'dist', 'index.mjs');
    fs.mkdirSync(path.dirname(devBrowserEntry), { recursive: true });
    fs.writeFileSync(devBrowserEntry, '// dev-browser-mcp bundled entry');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function makeOptions(overrides: Partial<BuildMcpServersOptions> = {}): BuildMcpServersOptions {
    return {
      mcpToolsPath,
      nodeExe: path.join(testDir, 'node'),
      browserConfig: { mode: 'none' },
      ...overrides,
    };
  }

  function withLinuxDesktopDist(): void {
    const entryPath = path.join(mcpToolsPath, 'linux-desktop', 'dist', 'index.mjs');
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, '// linux-desktop bundled entry');
  }

  it('registers linux-desktop on linux when dist exists', () => {
    withLinuxDesktopDist();
    const result = buildMcpServers(makeOptions({ platform: 'linux' }));

    expect(result['linux-desktop']).toEqual({
      type: 'local',
      command: [
        path.join(testDir, 'node'),
        path.join(mcpToolsPath, 'linux-desktop', 'dist', 'index.mjs'),
      ],
      enabled: true,
      timeout: 30000,
    });
  });

  it('linux-desktop command array starts with the bundled node binary', () => {
    withLinuxDesktopDist();
    const result = buildMcpServers(makeOptions({ platform: 'linux' }));
    expect(result['linux-desktop'].command?.[0]).toBe(path.join(testDir, 'node'));
    expect(result['linux-desktop'].command?.[1]).toContain(
      path.join('linux-desktop', 'dist', 'index.mjs'),
    );
  });

  it('omits linux-desktop on darwin', () => {
    withLinuxDesktopDist();
    const result = buildMcpServers(makeOptions({ platform: 'darwin' }));
    expect(result['linux-desktop']).toBeUndefined();
  });

  it('omits linux-desktop on win32', () => {
    withLinuxDesktopDist();
    const result = buildMcpServers(makeOptions({ platform: 'win32' }));
    expect(result['linux-desktop']).toBeUndefined();
  });

  it('omits linux-desktop when platform is undefined', () => {
    withLinuxDesktopDist();
    const result = buildMcpServers(makeOptions());
    expect(result['linux-desktop']).toBeUndefined();
  });

  it('omits linux-desktop when its dist file does not exist', () => {
    const result = buildMcpServers(makeOptions({ platform: 'linux' }));
    expect(result['linux-desktop']).toBeUndefined();
  });
});

describe('buildMcpServers — dev-browser-mcp relay port threading (M5 §3.1)', () => {
  let testDir: string;
  let mcpToolsPath: string;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `generator-mcp-port-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mcpToolsPath = path.join(testDir, 'mcp-tools');
    for (const [toolName, relEntry] of REQUIRED_MCP_DIST_ENTRIES) {
      const entryPath = path.join(mcpToolsPath, toolName, relEntry);
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      fs.writeFileSync(entryPath, `// ${toolName} bundled entry`);
    }
    const devBrowserEntry = path.join(mcpToolsPath, 'dev-browser-mcp', 'dist', 'index.mjs');
    fs.mkdirSync(path.dirname(devBrowserEntry), { recursive: true });
    fs.writeFileSync(devBrowserEntry, '// dev-browser-mcp bundled entry');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function browserOptions(overrides: Partial<BuildMcpServersOptions> = {}): BuildMcpServersOptions {
    return {
      mcpToolsPath,
      nodeExe: path.join(testDir, 'node'),
      browserConfig: { mode: 'builtin' },
      ...overrides,
    };
  }

  it('threads the resolved devBrowserPort into the child env as DEV_BROWSER_PORT', () => {
    const result = buildMcpServers(
      browserOptions({ devBrowserToken: 'tok', devBrowserPort: 9324 }),
    );
    expect(result['dev-browser-mcp'].environment?.DEV_BROWSER_PORT).toBe('9324');
    expect(result['dev-browser-mcp'].environment?.ACCOMPLISH_DEV_BROWSER_TOKEN).toBe('tok');
  });

  it('omits DEV_BROWSER_PORT from the child env when no port is resolved', () => {
    const result = buildMcpServers(browserOptions({ devBrowserToken: 'tok' }));
    expect(result['dev-browser-mcp'].environment?.DEV_BROWSER_PORT).toBeUndefined();
    expect(result['dev-browser-mcp'].environment?.ACCOMPLISH_DEV_BROWSER_TOKEN).toBe('tok');
  });
});

describe('buildMcpServers — dev-browser-mcp task-identity threading (M6-A T5 preview seam)', () => {
  let testDir: string;
  let mcpToolsPath: string;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `generator-mcp-taskid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mcpToolsPath = path.join(testDir, 'mcp-tools');
    for (const [toolName, relEntry] of REQUIRED_MCP_DIST_ENTRIES) {
      const entryPath = path.join(mcpToolsPath, toolName, relEntry);
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      fs.writeFileSync(entryPath, `// ${toolName} bundled entry`);
    }
    const devBrowserEntry = path.join(mcpToolsPath, 'dev-browser-mcp', 'dist', 'index.mjs');
    fs.mkdirSync(path.dirname(devBrowserEntry), { recursive: true });
    fs.writeFileSync(devBrowserEntry, '// dev-browser-mcp bundled entry');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function browserOptions(overrides: Partial<BuildMcpServersOptions> = {}): BuildMcpServersOptions {
    return {
      mcpToolsPath,
      nodeExe: path.join(testDir, 'node'),
      browserConfig: { mode: 'builtin' },
      ...overrides,
    };
  }

  it('threads the per-task taskId into the child env as ACCOMPLISH_TASK_ID', () => {
    const result = buildMcpServers(
      browserOptions({ devBrowserToken: 'tok', devBrowserPort: 9324, taskId: 'tsk_t5' }),
    );
    expect(result['dev-browser-mcp'].environment?.ACCOMPLISH_TASK_ID).toBe('tsk_t5');
    // The other M1/M5 threadings survive alongside the identity env.
    expect(result['dev-browser-mcp'].environment?.ACCOMPLISH_DEV_BROWSER_TOKEN).toBe('tok');
    expect(result['dev-browser-mcp'].environment?.DEV_BROWSER_PORT).toBe('9324');
  });

  it('threads the identity env in remote (cloud browser) mode too', () => {
    const result = buildMcpServers(
      browserOptions({
        taskId: 'tsk_cloud',
        browserConfig: {
          mode: 'remote',
          cdpEndpoint: 'https://cloud-browser.example.com/cdp',
          cdpHeaders: { 'X-CDP-Secret': 'secret' },
        },
      }),
    );
    expect(result['dev-browser-mcp'].environment?.ACCOMPLISH_TASK_ID).toBe('tsk_cloud');
    expect(result['dev-browser-mcp'].environment?.CDP_ENDPOINT).toBe(
      'https://cloud-browser.example.com/cdp',
    );
  });

  it('omits ACCOMPLISH_TASK_ID when no taskId is provided (transient OAuth path)', () => {
    const result = buildMcpServers(browserOptions({ devBrowserToken: 'tok' }));
    expect(result['dev-browser-mcp'].environment?.ACCOMPLISH_TASK_ID).toBeUndefined();
    expect(result['dev-browser-mcp'].environment?.ACCOMPLISH_DEV_BROWSER_TOKEN).toBe('tok');
  });
});
