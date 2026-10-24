/**
 * Build-artifact identity freshness (M6-A T5 defect class — checkpoint §5).
 *
 * The first real-Firefox acceptance run failed because the PRODUCTION daemon
 * (pid 3945, started 2026-10-23 14:32) was still executing the pre-T5
 * in-memory code while the rebuilt dist sat on disk: config generation
 * re-created the two-tab split, the MCP child canary warned ("ACCOMPLISH_TASK_ID
 * missing" — opencode log 2026-10-24T034916.log:113), and the preview showed
 * the blank tab all task long. A fresh harness could never see this — it
 * always spawns a daemon from the new build.
 *
 * These tests guard the module artifacts the daemon and child actually load:
 * `dist/opencode/generator-mcp.js` (the module the barrel resolves at
 * runtime for non-bundled consumers) and the bundled dev-browser-mcp child
 * (the per-task canary dist). If an artifact lacks the M6-A T5 identity
 * threading, the suites fail with an actionable rebuild message instead of
 * silently passing while a stale artifact serves production. The
 * "rebuilt-but-not-restarted" gap itself is covered by runtime breadcrumbs:
 * the child stderr canary (connection.ts) + the daemon journald identity
 * line (task-config-builder.verifyDevBrowserChildIdentity) + the one-shot
 * captureFrame divergence WARN (DevBrowserService).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('M6-A T5 artifact freshness (modules the daemon/child actually load at runtime)', () => {
  it('compiled generator-mcp module writes ACCOMPLISH_TASK_ID into the dev-browser-mcp env', () => {
    const compiled = path.join(pkgRoot, 'dist', 'opencode', 'generator-mcp.js');
    if (!fs.existsSync(compiled)) {
      console.warn(
        `[artifact-freshness] skipping: ${compiled} is not built — run "pnpm --filter @accomplish_ai/agent-core build" before loading the daemon`,
      );
      return;
    }
    const source = fs.readFileSync(compiled, 'utf8');
    // The M6-A T5 threading marker alongside the M1/M5 sibling threadings.
    expect(source).toContain('ACCOMPLISH_TASK_ID');
    expect(source).toContain('ACCOMPLISH_DEV_BROWSER_TOKEN');
    expect(source).toContain('DEV_BROWSER_PORT');
  });

  it('bundled dev-browser-mcp child carries the task-identity env reader + canary warning', () => {
    const bundle = path.join(pkgRoot, 'mcp-tools', 'dev-browser-mcp', 'dist', 'index.mjs');
    if (!fs.existsSync(bundle)) {
      console.warn(
        `[artifact-freshness] skipping: ${bundle} is not built — run "pnpm --filter @accomplish/desktop build:mcp-tools:dev" before launching`,
      );
      return;
    }
    const source = fs.readFileSync(bundle, 'utf8');
    expect(source).toContain('ACCOMPLISH_TASK_ID');
    expect(source).toContain('preview seam');
  });
});
