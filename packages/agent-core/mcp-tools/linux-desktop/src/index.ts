#!/usr/bin/env node
/**
 * linux-desktop MCP stdio server — Wayland desktop control PoC (C3 prototype).
 *
 * Reads and acts on the accessibility tree via the python desktop-helper
 * (AT-SPI) and takes screenshots via the XDG desktop portal. No synthetic
 * keyboard/mouse injection in this PoC.
 *
 * Security model: every tool call needs explicit user approval via the
 * opencode permission keys (`linux-desktop_<toolName>` — see config-generator).
 * Password managers and credential surfaces are hard-blocked in code.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { findBlocklistMatch } from './blocklist.js';
import { runDesktopHelper } from './helper-exec.js';

const execFileP = promisify(execFile);

const SERVER_NAME = 'linux-desktop';
const SERVER_VERSION = '1.0.0';
const PERMISSION_NOTE =
  'Requires explicit user approval per action (permission ask). Password managers and credential surfaces are blocked.';
const MAX_CONTROL_LIMIT = 300;
const GIO_LAUNCH_TIMEOUT_MS = 15_000;
const AUDIT_LOG_MAX_LEN = 200;

// Object-literal type (not an interface): the SDK's zod-inferred result types
// carry `[x: string]: unknown` index signatures, which interfaces cannot satisfy.
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs) => Promise<ToolResult>;

interface HelperNode {
  id?: unknown;
  role?: unknown;
  name?: unknown;
  states?: unknown;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logAudit(tool: string, args: ToolArgs): void {
  let argsJson = JSON.stringify(args) ?? '{}';
  if (argsJson.length > AUDIT_LOG_MAX_LEN) {
    argsJson = `${argsJson.slice(0, AUDIT_LOG_MAX_LEN)}...`;
  }
  console.error(`[${SERVER_NAME}] ${tool} args=${argsJson}`);
}

async function withAudit(
  tool: string,
  args: ToolArgs,
  impl: () => Promise<ToolResult>,
): Promise<ToolResult> {
  logAudit(tool, args);
  try {
    return await impl();
  } catch (error) {
    return err(`${tool} failed: ${errorMessage(error)}`);
  }
}

async function launchApp(args: ToolArgs): Promise<ToolResult> {
  const desktopFile = asString(args.desktopFile);
  if (!desktopFile || !path.isAbsolute(desktopFile) || !desktopFile.endsWith('.desktop')) {
    return err('desktop_launch_app requires desktopFile: an absolute path ending in .desktop');
  }
  const base = path.basename(desktopFile);
  const blockMatch = findBlocklistMatch(base);
  if (blockMatch) {
    return err(`Blocked by desktop-control blocklist: ${blockMatch}`);
  }
  await execFileP('gio', ['launch', desktopFile], { timeout: GIO_LAUNCH_TIMEOUT_MS });
  return ok(`Launched ${base}.`);
}

interface WindowDiscovery {
  application: string;
  frameId: string;
  controls: HelperNode[];
}

type DiscoveryResult = { ok: true; discovery: WindowDiscovery } | { ok: false; result: ToolResult };

async function discoverWindow(windowTitle: string, maxDepth = 12): Promise<DiscoveryResult> {
  const result = await runDesktopHelper([
    'controls',
    '--window',
    windowTitle,
    '--max-depth',
    String(maxDepth),
  ]);
  if (!result.ok || !result.data) {
    return {
      ok: false,
      result: err(`Desktop discovery failed: ${result.error ?? 'unknown error'}`),
    };
  }
  const application = asString(result.data.application);
  const windowNode = (result.data.window ?? {}) as HelperNode;
  const blockMatch =
    findBlocklistMatch(windowTitle) ??
    findBlocklistMatch(asString(windowNode.name)) ??
    findBlocklistMatch(application);
  if (blockMatch) {
    return { ok: false, result: err(`Blocked by desktop-control blocklist: ${blockMatch}`) };
  }
  return {
    ok: true,
    discovery: {
      application,
      frameId: asString(windowNode.id),
      controls: Array.isArray(result.data.controls) ? (result.data.controls as HelperNode[]) : [],
    },
  };
}

interface ControlResolution {
  control: HelperNode;
}

function resolveControl(
  controls: HelperNode[],
  controlName: string,
): ControlResolution | { error: string } {
  const target = controlName.toLowerCase();
  const nameOf = (node: HelperNode) => asString(node.name);
  const describe = (node: HelperNode) => `"${nameOf(node)}" (<${asString(node.role)}>)`;

  const exact = controls.filter((node) => nameOf(node).toLowerCase() === target);
  if (exact.length === 1) {
    return { control: exact[0] };
  }
  if (exact.length > 1) {
    const candidates = exact.slice(0, 20).map(describe).join(', ');
    return { error: `Ambiguous control "${controlName}" (${candidates})` };
  }

  const partial = controls.filter((node) => nameOf(node).toLowerCase().includes(target));
  if (partial.length === 1) {
    return { control: partial[0] };
  }
  if (partial.length > 1) {
    const candidates = partial.slice(0, 20).map(describe).join(', ');
    return { error: `Ambiguous control "${controlName}" (${candidates})` };
  }
  return { error: `No control matching "${controlName}" found` };
}

async function findControls(args: ToolArgs): Promise<ToolResult> {
  const windowTitle = asString(args.windowTitle);
  if (!windowTitle) {
    return err('desktop_find_controls requires windowTitle: string');
  }
  const maxDepthArg = args.maxDepth;
  let maxDepth = 12;
  if (maxDepthArg !== undefined) {
    maxDepth = Number(maxDepthArg);
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 12) {
      return err('maxDepth must be an integer between 1 and 12');
    }
  }
  const result = await runDesktopHelper([
    'controls',
    '--window',
    windowTitle,
    '--max-depth',
    String(maxDepth),
  ]);
  if (!result.ok || !result.data) {
    return err(`desktop_find_controls failed: ${result.error ?? 'unknown error'}`);
  }
  const windowNode = (result.data.window ?? {}) as HelperNode;
  const application = asString(result.data.application);
  const blockMatch =
    findBlocklistMatch(windowTitle) ??
    findBlocklistMatch(asString(windowNode.name)) ??
    findBlocklistMatch(application);
  if (blockMatch) {
    return err(`Blocked by desktop-control blocklist: ${blockMatch}`);
  }
  const controls = Array.isArray(result.data.controls)
    ? (result.data.controls as HelperNode[])
    : [];
  return ok(
    JSON.stringify(
      { windowTitle, application, controls: controls.slice(0, MAX_CONTROL_LIMIT) },
      null,
      2,
    ),
  );
}

async function listWindows(_args: ToolArgs): Promise<ToolResult> {
  const result = await runDesktopHelper(['list']);
  if (!result.ok || !result.data) {
    return err(`desktop_list_windows failed: ${result.error ?? 'unknown error'}`);
  }
  const applications = Array.isArray(result.data.applications) ? result.data.applications : [];
  return ok(JSON.stringify(applications, null, 2));
}

async function invokeControl(args: ToolArgs): Promise<ToolResult> {
  const windowTitle = asString(args.windowTitle);
  const controlName = asString(args.controlName);
  if (!windowTitle || !controlName) {
    return err('desktop_invoke requires windowTitle and controlName: string');
  }
  const action = asString(args.action) || 'click';

  const discovered = await discoverWindow(windowTitle);
  if (!discovered.ok) {
    return discovered.result;
  }
  const { controls } = discovered.discovery;
  const resolution = resolveControl(controls, controlName);
  if ('error' in resolution) {
    return err(`desktop_invoke failed: ${resolution.error}`);
  }

  const control = resolution.control;
  const result = await runDesktopHelper([
    'invoke',
    '--id',
    asString(control.id),
    '--action',
    action,
  ]);
  if (!result.ok || !result.data) {
    return err(`desktop_invoke failed: ${result.error ?? 'unknown error'}`);
  }
  const targetJson = JSON.stringify(result.data.target ?? result.data);
  return ok(
    `Invoked ${action} on ${asString(control.role)} '${asString(control.name)}'. Result: ${targetJson}`,
  );
}

async function readControl(args: ToolArgs): Promise<ToolResult> {
  const windowTitle = asString(args.windowTitle);
  if (!windowTitle) {
    return err('desktop_read requires windowTitle: string');
  }
  const controlName = asString(args.controlName);
  const nodeIdArg = asString(args.nodeId);
  let start = 0;
  let end = 400;
  if (args.start !== undefined) {
    const value = Number(args.start);
    if (!Number.isInteger(value) || value < 0) {
      return err('start must be a non-negative integer');
    }
    start = value;
  }
  if (args.end !== undefined) {
    const value = Number(args.end);
    if (!Number.isInteger(value) || value < 0) {
      return err('end must be a non-negative integer');
    }
    end = value;
  }

  let nodeId = '';
  const discovered = await discoverWindow(windowTitle);
  if (!discovered.ok) {
    return discovered.result;
  }
  const { frameId, controls } = discovered.discovery;
  if (nodeIdArg) {
    // Direct id read (from a prior desktop_find_controls) — GTK4 display
    // widgets are nameless, so name-based resolution cannot reach them.
    nodeId = nodeIdArg;
  } else if (controlName) {
    const resolution = resolveControl(controls, controlName);
    if ('error' in resolution) {
      return err(`desktop_read failed: ${resolution.error}`);
    }
    nodeId = asString(resolution.control.id);
  } else {
    nodeId = frameId;
  }
  if (!nodeId) {
    return err('desktop_read failed: window frame node id not available');
  }

  const result = await runDesktopHelper([
    'read',
    '--id',
    nodeId,
    '--start',
    String(start),
    '--end',
    String(end),
  ]);
  if (!result.ok || !result.data) {
    return err(`desktop_read failed: ${result.error ?? 'unknown error'}`);
  }
  const node = (result.data.node ?? {}) as HelperNode & { text?: unknown; textError?: unknown };
  const summary = {
    name: node.name,
    role: node.role,
    states: node.states,
    text: node.text,
  };
  if (node.textError) {
    Object.assign(summary, { textError: node.textError });
  }
  return ok(JSON.stringify(summary, null, 2));
}

async function screenshot(args: ToolArgs): Promise<ToolResult> {
  const outputFile = asString(args.outputFile);
  if (outputFile && (!path.isAbsolute(outputFile) || !outputFile.toLowerCase().endsWith('.png'))) {
    return err('desktop_screenshot requires outputFile: an absolute path ending in .png');
  }
  let outPath = outputFile;
  if (!outPath) {
    outPath = path.join(process.cwd(), `desktop-screenshot-${Date.now()}.png`);
  }

  // Portal consent can take a minute — keep the default 95 s execFile timeout.
  const result = await runDesktopHelper(['screenshot', '--out', outPath]);
  if (!result.ok || !result.data) {
    return err(
      `Portal screenshot requires interactive user consent; it was not granted (${result.error ?? 'unknown error'})`,
    );
  }
  const uri = asString(result.data.uri) || outPath;
  return ok(`Screenshot saved to ${uri}`);
}

export const toolHandlers: Record<string, ToolHandler> = {
  desktop_launch_app: (args) => withAudit('desktop_launch_app', args, () => launchApp(args)),
  desktop_list_windows: (args) => withAudit('desktop_list_windows', args, () => listWindows(args)),
  desktop_find_controls: (args) =>
    withAudit('desktop_find_controls', args, () => findControls(args)),
  desktop_invoke: (args) => withAudit('desktop_invoke', args, () => invokeControl(args)),
  desktop_read: (args) => withAudit('desktop_read', args, () => readControl(args)),
  desktop_screenshot: (args) => withAudit('desktop_screenshot', args, () => screenshot(args)),
};

async function main(): Promise<void> {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'desktop_launch_app',
        description: `Launch a Linux desktop application (.desktop file) via gio. ${PERMISSION_NOTE}`,
        inputSchema: {
          type: 'object',
          required: ['desktopFile'],
          properties: {
            desktopFile: {
              type: 'string',
              description:
                'Absolute path to the .desktop file (e.g. /usr/share/applications/firefox.desktop)',
            },
          },
        },
      },
      {
        name: 'desktop_list_windows',
        description: `List open desktop application windows (AT-SPI discovery). ${PERMISSION_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'desktop_find_controls',
        description: `Discover the actionable controls (buttons, menus, ...) of an open window by title. ${PERMISSION_NOTE}`,
        inputSchema: {
          type: 'object',
          required: ['windowTitle'],
          properties: {
            windowTitle: {
              type: 'string',
              description: 'Exact window title to inspect',
            },
            maxDepth: {
              type: 'number',
              description:
                'Maximum accessibility-tree walk depth (1-12, default 12; GTK4 apps nest ~11 deep)',
            },
          },
        },
      },
      {
        name: 'desktop_invoke',
        description: `Invoke an action (default click) on a named control of an open window. ${PERMISSION_NOTE}`,
        inputSchema: {
          type: 'object',
          required: ['windowTitle', 'controlName'],
          properties: {
            windowTitle: {
              type: 'string',
              description: 'Exact window title containing the control',
            },
            controlName: {
              type: 'string',
              description:
                'Control label, resolved case-insensitively (exact match first, then substring)',
            },
            action: {
              type: 'string',
              description: 'AT-SPI action to invoke (default: click)',
            },
          },
        },
      },
      {
        name: 'desktop_read',
        description: `Read the text content of a window or named control. ${PERMISSION_NOTE}`,
        inputSchema: {
          type: 'object',
          required: ['windowTitle'],
          properties: {
            windowTitle: {
              type: 'string',
              description: 'Exact window title to read',
            },
            controlName: {
              type: 'string',
              description: 'Optional control label; omit to read the whole window frame',
            },
            nodeId: {
              type: 'string',
              description:
                'Optional control id from a prior desktop_find_controls (needed for nameless widgets like GTK4 displays)',
            },
            start: {
              type: 'number',
              description: 'Text offset to start reading from (default 0)',
            },
            end: {
              type: 'number',
              description: 'Text offset to stop reading at (default 400)',
            },
          },
        },
      },
      {
        name: 'desktop_screenshot',
        description: `Capture the screen via the desktop portal; shows a user-consent dialog that must be approved. ${PERMISSION_NOTE}`,
        inputSchema: {
          type: 'object',
          properties: {
            outputFile: {
              type: 'string',
              description:
                'Absolute .png path for the capture (default: workspace desktop-screenshot-<epoch>.png)',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const handler = toolHandlers[toolName];
    if (!handler) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return handler((request.params.arguments ?? {}) as ToolArgs);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] MCP server running`);
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] Fatal error:`, error);
  process.exit(1);
});
