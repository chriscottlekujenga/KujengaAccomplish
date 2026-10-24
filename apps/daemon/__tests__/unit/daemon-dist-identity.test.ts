/**
 * Daemon-bundle identity freshness (M6-A T5 defect class — checkpoint §5).
 *
 * The production daemon runs `node apps/daemon/dist/index.js`. During the
 * failed Firefox acceptance that RUNNING process (pid 3945, started
 * 2026-10-23 14:32) held pre-T5 code while this fresh bundle sat on disk —
 * config generation lacked ACCOMPLISH_TASK_ID and the preview split re-formed.
 * The only artifact-level guard possible asserts the BUNDLE ON DISK contains
 * the identity machinery; the "rebuilt-but-not-restarted" gap is detected at
 * runtime instead (child canary + journald identity breadcrumb + divergence
 * WARN). Skip when the bundle is absent (source-only test environments).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const daemonBundle = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'index.js',
);

describe('M6-A T5 daemon-bundle freshness (the file the production daemon loads)', () => {
  it('daemon dist bundle carries the dev-browser child-identity machinery', () => {
    if (!fs.existsSync(daemonBundle)) {
      console.warn(
        `[artifact-freshness] skipping: ${daemonBundle} is not built — run "pnpm --filter @accomplish/daemon build"; a running daemon must be RESTARTED to load it`,
      );
      return;
    }
    const source = fs.readFileSync(daemonBundle, 'utf8');
    expect(source).toContain('ACCOMPLISH_TASK_ID');
    expect(source).toContain('dev-browser-mcp child identity threaded');
    expect(source).toContain('preview-seam identity divergence');
  });
});
