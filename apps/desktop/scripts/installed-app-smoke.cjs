#!/usr/bin/env node

/**
 * installed-app-smoke.cjs — acceptance smoke test for an INSTALLED build.
 *
 * Verifies, for a packaged Windows NSIS install or macOS .app:
 *   static:  main executable exists with the expected architecture, bundled
 *            Node.js / OpenCode / native SQLite module are present and
 *            architecture-correct (PE machine / Mach-O cputype probes run on
 *            the actual files shipped inside the installed app).
 *   runtime: the app boots on an ISOLATED test profile
 *            (ACCOMPLISH_PROFILE -> <appData>/Accomplish-<profile>), the
 *            daemon actually becomes reachable via its profile-scoped socket
 *            (a spawned Electron process is NOT treated as proof of daemon
 *            operation), the app exits cleanly on request, and cleanup
 *            deletes ONLY the profile directory this run created.
 *
 * Profile ownership (M3a review): the profile name is generated fresh per
 * run (no --profile override — cleanup must never be aimable at a
 * pre-existing directory). A directory that already exists is never reused
 * or deleted; cleanup deletes only the owned directory and skips deletion
 * when ownership cannot be established.
 *
 * No AI providers, no browser automation. Every wait is bounded; all process
 * cleanup happens in a finally block (app SIGTERM/WM_CLOSE then daemon RPC
 * shutdown), so a failing run cannot leak the app or daemon. Evidence
 * (steps, logs, exit codes) is preserved on failure.
 *
 * Usage:
 *   node scripts/installed-app-smoke.cjs \
 *     --install-dir="<install root>" \
 *     --expected-arch=arm64|x64 \
 *     [--evidence-dir=<dir>] \
 *     [--launch-timeout-ms=60000] \
 *     [--skip-launch]
 *
 * Windows install root:   e.g. %LOCALAPPDATA%\Programs\Accomplish
 * macOS install root:     the .app bundle (e.g. /Applications/Accomplish.app)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { spawn, execFileSync } = require('child_process');
const net = require('net');

const {
  findUniqueProfileDataDir,
  deleteOwnedProfileDataDir,
  ProfileSelectionError,
} = require('./installed-app-smoke-lib.cjs');

function isDarwin() {
  return process.platform === 'darwin';
}

function isWindows() {
  return process.platform === 'win32';
}

function appDataRoot() {
  if (isDarwin()) {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (isWindows()) {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function log(message) {
  console.log(`[installed-app-smoke] ${message}`);
}

function fail(code, message, extra) {
  console.error(`[installed-app-smoke] FAIL: ${message}`);
  if (extra) {
    console.error(extra);
  }
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * Static layout checks against the installed app
 * ------------------------------------------------------------------ */

function assertArch(label, filePath, expectedArch) {
  const { readPeMachine, readMachOCpuType } = require('./installed-app-smoke-lib.cjs');
  let arch = readPeMachine(filePath);
  if (arch === null) {
    arch = readMachOCpuType(filePath);
  }
  if (arch === null) {
    arch = 'unreadable-not-pe-or-macho';
  }
  // On macOS a universal ('fat') binary also satisfies an arch expectation
  // (it embeds the native slice); elsewhere the machine type must match
  // exactly.
  const satisfies =
    arch === expectedArch ||
    (isDarwin() && arch === 'fat' && (expectedArch === 'arm64' || expectedArch === 'x64'));
  if (!satisfies) {
    fail(1, `${label} architecture mismatch: expected ${expectedArch}, got '${arch}'`, filePath);
  }
  log(`${label} arch OK (${arch}): ${filePath}`);
}

function locateInstallPaths(installDir) {
  const resourcesCandidates = [
    path.join(installDir, 'resources'),
    path.join(installDir, 'Contents', 'Resources'),
  ];
  const resourcesDir = resourcesCandidates.find((candidate) => fs.existsSync(candidate));
  const exeCandidates = isDarwin()
    ? [path.join(installDir, 'Contents', 'MacOS', 'Accomplish')]
    : [path.join(installDir, 'Accomplish.exe'), path.join(installDir, 'App', 'Accomplish.exe')];
  const exePath = exeCandidates.find((candidate) => fs.existsSync(candidate)) || null;
  if (!resourcesDir || !exePath) {
    const checked = [...resourcesCandidates, ...exeCandidates].join(', ');
    fail(1, `Could not locate app resources and/or main executable under ${installDir}`, checked);
  }
  return { resourcesDir, exePath };
}

function checkBinaryOrDie(resourcesDir, label, relativeCandidates, expectedArch) {
  const filePath = relativeCandidates
    .map((relative) => path.join(resourcesDir, ...relative))
    .find((candidate) => fs.existsSync(candidate));
  if (!filePath) {
    fail(
      1,
      `${label} not found in installed app (looked for: ${relativeCandidates
        .map((parts) => path.join(...parts))
        .join(', ')})`,
    );
  }
  assertArch(label, filePath, expectedArch);
  return filePath;
}

function runStaticChecks(installDir, expectedArch) {
  const { resourcesDir, exePath } = locateInstallPaths(installDir);
  const result = { resourcesDir, exePath };

  assertArch('Main executable', exePath, expectedArch);

  result.bundledNode = checkBinaryOrDie(
    resourcesDir,
    'Bundled Node.js',
    [
      isDarwin()
        ? ['nodejs', `darwin-${expectedArch}`, 'bin', 'node']
        : ['nodejs', `win32-${expectedArch}`, 'node.exe'],
    ],
    expectedArch,
  );

  const exeName = isDarwin() ? 'opencode' : 'opencode.exe';
  // ARM64 must resolve to the dedicated ARM64 package only; x64 keeps both
  // AVX2-capable variants as valid candidates.
  const opencodePackages = isDarwin()
    ? ['opencode-ai']
    : expectedArch === 'arm64'
      ? ['opencode-windows-arm64']
      : ['opencode-windows-x64', 'opencode-windows-x64-baseline'];
  result.opencodePackages = opencodePackages;
  result.bundledOpenCode = checkBinaryOrDie(
    resourcesDir,
    'Bundled OpenCode',
    opencodePackages.map((pkg) => ['app.asar.unpacked', 'node_modules', pkg, 'bin', exeName]),
    expectedArch,
  );

  result.bundledSqlite = checkBinaryOrDie(
    resourcesDir,
    'Bundled better-sqlite3',
    [['daemon', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node']],
    expectedArch,
  );

  return result;
}

/* ------------------------------------------------------------------ *
 * Daemon reachability (profile-scoped socket)
 * ------------------------------------------------------------------ */

/**
 * Local copy of agent-core getSocketPath(): the socket is scoped by the
 * profile dataDir (hashed named pipe on Windows, filesystem socket on POSIX),
 * so two profiles never cross-connect.
 */
function getSocketPath(dataDir) {
  if (isWindows()) {
    const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\accomplish-daemon-${hash}`;
  }
  return path.join(dataDir, 'daemon.sock');
}

function tryConnect(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(2000, () => finish(false));
  });
}

/**
 * Bounded wait for the daemon's pid file AND an accepted socket connect — a
 * spawned process is not sufficient evidence on its own.
 */
async function waitForDaemonReachable(profileDataDir, timeoutMs) {
  const pidPath = path.join(profileDataDir, 'daemon.pid');
  const socketPath = getSocketPath(profileDataDir);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (appProcess && appProcess.exitCode !== null) {
      fail(
        1,
        `App exited (code ${appProcess.exitCode}) before its daemon became reachable`,
        `app log: ${appLogPath}`,
      );
    }
    if (fs.existsSync(pidPath) && (await tryConnect(socketPath))) {
      return { pidPath, socketPath };
    }
    await sleep(1000);
  }
  const pidFileState = fs.existsSync(pidPath)
    ? 'existed but socket connect failed'
    : 'never appeared';
  fail(
    1,
    `Daemon unreachable after ${timeoutMs}ms (socket: ${socketPath})`,
    `pid file: ${pidPath} ${pidFileState}; app log: ${appLogPath}`,
  );
}

/** Bounded RPC shutdown of the detached daemon (same RPC the main process uses). */
async function shutdownDaemon(profileDataDir, timeoutMs) {
  let client;
  let transport;
  try {
    const agentCore = require('@accomplish_ai/agent-core/desktop-main');
    transport = await agentCore.createSocketTransport({
      dataDir: profileDataDir,
      connectTimeout: 2000,
    });
    client = new agentCore.DaemonClient({ transport });
    await client.call('daemon.shutdown', undefined, { timeoutMs });
    log('Detached daemon shut down via shutdown RPC');
    return true;
  } catch (err) {
    log(`daemon.shutdown best-effort attempt failed (non-fatal): ${err}`);
    return false;
  } finally {
    try {
      client?.close();
    } catch {
      /* best-effort */
    }
    try {
      transport?.close();
    } catch {
      /* best-effort */
    }
  }
}

/* ------------------------------------------------------------------ *
 * App lifecycle with bounded cleanup
 * ------------------------------------------------------------------ */

let appProcess = null;
let appLogPath = null;

function attemptGracefulKill(pid) {
  try {
    if (isWindows()) {
      // taskkill without /f posts WM_CLOSE to top-level windows (graceful
      // Electron quit); /t covers child processes.
      execFileSync('taskkill', ['/pid', String(pid), '/t'], { stdio: 'pipe' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function forceKill(pid) {
  try {
    if (isWindows()) {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'pipe' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

/**
 * Stop the app: graceful first (SIGTERM / WM_CLOSE), bounded grace period,
 * then hard kill. Returns true only if the graceful path sufficed.
 */
async function stopApp() {
  if (!appProcess || appProcess.exitCode !== null) {
    return true;
  }
  attemptGracefulKill(appProcess.pid);
  const graceDeadline = Date.now() + 15000;
  while (Date.now() < graceDeadline && appProcess.exitCode === null) {
    await sleep(250);
  }
  if (appProcess.exitCode !== null) {
    return true;
  }
  forceKill(appProcess.pid);
  await sleep(1000);
  return false;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const args = {};
  args.skipLaunch = process.argv.includes('--skip-launch');
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      args[match[1]] = match[2];
    } else if (arg !== '--skip-launch') {
      fail(2, `Unrecognized argument: ${arg}`);
    }
  }

  const expectedArch = args['expected-arch'];
  if (expectedArch !== 'arm64' && expectedArch !== 'x64') {
    fail(2, `--expected-arch must be 'arm64' or 'x64' (got '${expectedArch ?? ''}')`);
  }
  const installDirArg = args['install-dir'];
  if (!installDirArg) {
    fail(2, 'Missing required --install-dir=<path>');
  }
  const installDir = path.isAbsolute(installDirArg)
    ? installDirArg
    : path.resolve(process.cwd(), installDirArg);
  if (!fs.existsSync(installDir)) {
    fail(2, `--install-dir does not exist: ${installDir}`);
  }

  // The profile is always generated FRESH per run; there is deliberately no
  // CLI override so cleanup can never be pointed at a pre-existing profile.
  let profileInfo;
  try {
    profileInfo = findUniqueProfileDataDir(appDataRoot());
  } catch (err) {
    fail(
      2,
      `Profile selection failed: ${err instanceof ProfileSelectionError ? err.message : err}`,
    );
  }
  const profileName = profileInfo.profileName;
  const profileDataDir = profileInfo.dataDir;
  const evidenceDirArg =
    args['evidence-dir'] ?? path.join(process.cwd(), 'installed-smoke-evidence');
  const evidenceDir = path.isAbsolute(evidenceDirArg)
    ? evidenceDirArg
    : path.resolve(process.cwd(), evidenceDirArg);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const launchTimeoutMs = args['launch-timeout-ms']
    ? parseInt(args['launch-timeout-ms'], 10)
    : 60000;

  log(`Install dir: ${installDir}`);
  log(`Expected arch: ${expectedArch}`);
  log(`Generated test profile: ${profileName} -> ${profileDataDir}`);
  log(`Evidence dir: ${evidenceDir}`);
  log('NOTE: --skip-launch and this generated profile never reuse or delete existing profiles');

  const steps = [];
  const writeEvidence = (error) => {
    const payload = {
      timestamp: new Date().toISOString(),
      platform: process.platform,
      node: process.version,
      installDir,
      expectedArch,
      profileName,
      profileDataDir,
      error: error === null ? null : String(error?.stack ?? error),
      steps,
    };
    fs.writeFileSync(path.join(evidenceDir, 'smoke-result.json'), JSON.stringify(payload, null, 2));
  };

  // Static checks first: they need no user state and no processes.
  let staticChecks;
  try {
    staticChecks = runStaticChecks(installDir, expectedArch);
    steps.push({ step: 'static-checks', ok: true, ...staticChecks });
    log('Static layout + architecture checks: OK');
  } catch (err) {
    writeEvidence(err);
    throw err;
  }
  if (args.skipLaunch) {
    writeEvidence(null);
    log('--skip-launch given: runtime phase skipped (static checks only)');
    process.exit(0);
  }

  // Ownership: the run may delete the profile dir only when it did not exist
  // before launch. With generated names it never exists — assert that, and
  // refuse (never reusing or deleting anything) if the invariant is broken.
  const profileExistedAtStart = fs.existsSync(profileDataDir);
  if (profileExistedAtStart) {
    writeEvidence(new Error('profile directory already exists'));
    fail(
      2,
      `Profile dir for a generated name unexpectedly exists: ${profileDataDir} — refusing to reuse or delete it`,
    );
  }

  try {
    appLogPath = path.join(evidenceDir, `app-stdout-stderr-${process.pid}.log`);
    const logStream = fs.createWriteStream(appLogPath, { flags: 'w' });
    const env = { ...process.env, ACCOMPLISH_PROFILE: profileName, E2E_SKIP_AUTH: '1' };
    delete env.CLEAN_START;
    appProcess = spawn(staticChecks.exePath, ['--e2e-skip-auth'], {
      cwd: installDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    appProcess.stdout?.pipe(logStream);
    appProcess.stderr?.pipe(logStream);
    steps.push({ step: 'app-launched', pid: appProcess.pid, appLogPath });
    log(`Launched: ${staticChecks.exePath} (pid ${appProcess.pid}), log: ${appLogPath}`);

    const daemon = await waitForDaemonReachable(profileDataDir, launchTimeoutMs);
    steps.push({ step: 'daemon-reachable', ok: true, ...daemon });
    log(
      `Daemon reachable: pid=${fs.readFileSync(daemon.pidPath, 'utf-8').trim()} socket=${daemon.socketPath}`,
    );

    const exitedCleanly = await stopApp();
    steps.push({ step: 'app-exit', graceful: exitedCleanly, exitCode: appProcess?.exitCode });
    if (!exitedCleanly) {
      writeEvidence(new Error('app did not exit cleanly within the grace period'));
      fail(1, 'Application required a forced kill — clean-exit requirement failed');
    }
    log(`App exited cleanly (code ${appProcess?.exitCode ?? 0})`);

    const daemonStopped = await shutdownDaemon(profileDataDir, 15000);
    steps.push({ step: 'daemon-shutdown', ok: daemonStopped });

    const cleanup = deleteOwnedProfileDataDir(profileDataDir, profileExistedAtStart, fs.rmSync);
    steps.push({ step: 'profile-cleanup', dir: profileDataDir, ...cleanup });
    log(`Profile cleanup: ${cleanup.deleted ? 'removed' : `skipped (${cleanup.reason})`}`);

    writeEvidence(null);
    log('ALL CHECKS PASSED');
  } catch (err) {
    steps.push({ step: 'runtime-error', error: String(err) });
    writeEvidence(err);
    throw err;
  } finally {
    const stopped = await stopApp();
    if (!stopped) {
      log('WARNING: app pid may still be alive after forced cleanup attempt');
    }
    const daemonKilled = await shutdownDaemon(profileDataDir, 5000);
    if (!daemonKilled) {
      log('WARNING: detached daemon shutdown inconclusive during cleanup');
    }
    // Ownership-gated: only the dir THIS run created; never anything else.
    const cleanup = deleteOwnedProfileDataDir(profileDataDir, profileExistedAtStart, fs.rmSync);
    if (!cleanup.deleted && cleanup.reason !== 'nothing to remove (directory absent)') {
      log(`Profile cleanup skipped: ${cleanup.reason}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[installed-app-smoke] FAIL: ${err?.message ?? err}`);
    process.exit(1);
  });
