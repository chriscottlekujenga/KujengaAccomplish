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
