import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HelperResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

interface ExecOutput {
  stdout: string;
  stderr: string;
}

/** Promisify child_process.execFile with { stdout, stderr } on both paths. */
function execFileAsync(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const DEFAULT_TIMEOUT_MS = 95_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export function resolveHelperPath(): string {
  // dist/index.mjs sits inside the package dir; scripts/ is a sibling of dist/.
  const packageDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(packageDir, '..', 'scripts', 'desktop-helper.py');
}

function parseHelperJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as HelperResult).ok === 'boolean'
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — the helper may emit stray diagnostic lines; keep scanning backwards.
    }
  }
  return null;
}

function normalizePayload(payload: Record<string, unknown>): HelperResult {
  if (payload.ok) {
    return { ok: true, data: payload };
  }
  const error =
    typeof payload.error === 'string' && payload.error ? payload.error : 'unknown helper error';
  return { ok: false, error };
}

function stderrTail(stderr: string): string {
  return (
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' | ')
      .trim() || ''
  );
}

/**
 * Run the python desktop helper and normalize its one-JSON-line stdout
 * contract into {ok, error?, data?}. Last parseable JSON line wins (the
 * helper may print stray diagnostics before the payload).
 */
export async function runDesktopHelper(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HelperResult> {
  const helperPath = resolveHelperPath();
  if (!existsSync(helperPath)) {
    return { ok: false, error: `Desktop helper script not found at ${helperPath}` };
  }

  let output: ExecOutput = { stdout: '', stderr: '' };
  try {
    output = await execFileAsync('python3', [helperPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    output = { stdout: execError.stdout ?? '', stderr: execError.stderr ?? '' };
    // Non-zero exit — the stdout JSON still carries the error contract.
    const parsed = parseHelperJson(output.stdout);
    if (parsed) {
      return normalizePayload(parsed);
    }
    const tail = stderrTail(output.stderr);
    return { ok: false, error: tail || execError.message || 'desktop helper exited with error' };
  }

  const parsed = parseHelperJson(output.stdout);
  if (parsed) {
    return normalizePayload(parsed);
  }
  const tail = stderrTail(output.stderr);
  return {
    ok: false,
    error: tail || 'desktop helper produced no parseable JSON output',
  };
}
