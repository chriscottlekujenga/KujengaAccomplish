import path from 'path';

/**
 * Accomplish profile isolation.
 *
 * The application keeps all per-user state under `app.getPath('userData')`,
 * which is derived from a single `app.setPath('userData', ...)` call at
 * main-process startup (apps/desktop/src/main/index.ts). Everything that
 * matters for a clean acceptance run keys off that directory:
 *
 *   - SQLite database (store/storage.ts)
 *   - secure storage / credentials
 *   - daemon socket (hashed from the dataDir on Windows named pipes,
 *     filesystem socket on POSIX) and daemon pid file (agent-core
 *     `getSocketPath`/`getPidFilePath`), so parallel profiles never collide
 *   - logs, settings, OpenCode environment resolution
 *
 * An override via the `ACCOMPLISH_PROFILE` environment variable therefore
 * isolates ALL of the above in one place — a test build must never silently
 * fall back to the production profile (`Accomplish`), so an invalid override
 * fails closed (process exit), not "default-with-a-log-line".
 */

/** Directory (inside the OS app-data dir) used when no profile is selected. */
export const DEFAULT_DATA_DIR_NAME = 'Accomplish';

/** Test profiles live in sibling directories named `Accomplish-<profile>`. */
export const PROFILE_DATA_DIR_PREFIX = 'Accomplish-';

/**
 * Only plain identifiers are allowed: no separators, no absolute paths, no
 * traversal, no whitespace, no non-ASCII, 1..48 chars, must start
 * alphanumeric. The prefix keeps every profile directory distinct from the
 * production `Accomplish` directory no matter what value is chosen.
 */
const PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/i;

/**
 * Device/legacy reserved names on Windows: the resulting directory name can
 * be treated as a device name (cmd.exe and some APIs), so reject them outright
 * for portability regardless of the host OS.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export class InvalidProfileError extends Error {}

/**
 * Validate and normalize `ACCOMPLISH_PROFILE`.
 *
 * Returns `null` when the variable is unset (production/default profile).
 * Throws `InvalidProfileError` for anything invalid — the caller must fail
 * closed rather than fall back to the default profile.
 */
export function resolveAccomplishProfile(rawValue: string | undefined): string | null {
  if (rawValue === undefined) {
    return null;
  }
  const name = rawValue.trim();
  if (name === '') {
    throw new InvalidProfileError(
      'ACCOMPLISH_PROFILE is set but empty. Unset it for the production profile, or use a name matching /[a-z0-9][a-z0-9._-]{0,47}/i.',
    );
  }
  if (!PROFILE_RE.test(name)) {
    throw new InvalidProfileError(
      `ACCOMPLISH_PROFILE '${rawValue}' is not a valid profile name. ` +
        'Allowed: 1-48 chars, starting with an alphanumeric, then alphanumerics, dots, dashes, ' +
        'underscores. Path separators, absolute paths, traversal sequences, and whitespace are rejected.',
    );
  }
  if (name.includes('..')) {
    throw new InvalidProfileError(
      `ACCOMPLISH_PROFILE '${name}' contains a traversal sequence ('..') and is rejected.`,
    );
  }
  if (name.endsWith('.') || name.endsWith('-') || name.endsWith('_')) {
    throw new InvalidProfileError(
      `ACCOMPLISH_PROFILE '${name}' ends with '.'/-'/'_' which Windows filesystems may mangle.`,
    );
  }
  if (name.toLowerCase() === 'accomplish') {
    throw new InvalidProfileError(
      "ACCOMPLISH_PROFILE 'accomplish' would collide with the production data directory. " +
        'Leave the variable unset to use the production profile.',
    );
  }
  if (WINDOWS_RESERVED_NAMES.has(name.toLowerCase())) {
    throw new InvalidProfileError(
      `ACCOMPLISH_PROFILE '${name}' is a reserved Windows device name and is rejected.`,
    );
  }
  return name;
}

/** Profile-isolated data directory name (e.g. `Accomplish-acceptance-arm64`). */
export function profileDataDirName(profileName: string): string {
  return PROFILE_DATA_DIR_PREFIX + profileName;
}

/**
 * Full data directory for a profile. `appDataPath` is the OS app-data root
 * (Electron's `app.getPath('appData')`); `profileName === null` selects the
 * production profile directory.
 */
export function resolveProfileDataDir(appDataPath: string, profileName: string | null): string {
  return path.join(
    appDataPath,
    profileName === null ? DEFAULT_DATA_DIR_NAME : profileDataDirName(profileName),
  );
}

export type CleanStartDecision =
  /** Delete the explicitly selected override profile. */
  | 'delete'
  /** Refuse: the default Accomplish profile is never destructively wiped. */
  | 'refuse';

/**
 * CLEAN_START=1 is a *destructive* operation (rmSync of the data dir). It
 * only ever applies to an explicitly selected, validated override profile.
 * The default `Accomplish` directory (packaged builds, dev builds, CI, and
 * local E2E alike) is refused: callers that need a wipe must set
 * ACCOMPLISH_PROFILE, so a flag can no longer be the thing that deletes
 * user data — in production or in development.
 */
export function resolveCleanStartDecision(opts: {
  profileName: string | null;
}): CleanStartDecision {
  return opts.profileName === null ? 'refuse' : 'delete';
}
