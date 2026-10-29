# M-CX1 Milestone Report — Cross-Platform Release Pipeline Repair + CI Expansion

Date: 2026-10-28 · Branch: `feature/cross-platform` (HEAD `d481a63` + this change, uncommitted)
Charter: Phase 1 audit §E milestone M-CX1. No runtime source code, no security policy, no
feature behavior modified.

## Files changed

| File                            | Change                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/release.yml` | All five build jobs (mac-arm64, mac-x64, linux-arm64, linux-x64, win-x64) now run the complete packaging chain and two post-pack verification gates. Artifact names, triggers, and the create-release job are unchanged.                          |
| `.github/workflows/ci.yml`      | Added `apps/web`, `apps/host`, `apps/daemon` suites as first-class CI jobs; widened the push/PR path filter to those apps; added the daemon suite to the Windows job.                                                                             |
| `apps/desktop/package.json`     | Added `package:mac:arm64` / `package:mac:x64` chains; CI-facing chains (`package:win`, `package:linux:*`) now download only their target platform's Node binary. Local host-arch chains (`package`, `package:mac`) and artifact naming untouched. |

## Defects repaired

1. **Release build chain was out of sync with the packaging chain** (pre-existing): the
   release build jobs ran only `download:nodejs` → `pnpm -F @accomplish/desktop build` →
   `package.cjs`, which never builds `apps/daemon` (desktop `build` = `build:base` +
   developer-mode MCP bundling only, `apps/desktop/package.json:25`), never stages the
   daemon's native deps (`stage-daemon-deps.cjs` — required for
   `daemon/node_modules/better-sqlite3`), and never switches MCP tools to packaged-mode
   bundling. `package.cjs` performs none of these either (symlink surgery + electron-builder
   only), so a fresh runner produced a broken/empty daemon payload (invariant 2 of
   `assert-packaging-invariants.cjs` would fail). Every build job now invokes the repo's own
   per-target chain scripts in `apps/desktop/package.json` — the identical steps used by
   local `pnpm package:*` builds.
2. **Missing per-arch Node downloads / MCP package-mode env on new chains**: new
   `package:mac:arm64|x64` pass `--target-platform` to `stage-daemon-deps.cjs` and set
   `ACCOMPLISH_BUNDLED_MCP=1` around `build:mcp-tools:package` (linux chains already did
   this; `package:win` intentionally does not use the env-prefix form — Windows script
   shells do not support `FOO=1 cmd`).
3. **CI blind spot**: `apps/web`, `apps/host`, `apps/daemon` test suites (and the host
   gateway's security-critical policy/scrubber/presence suites) never ran in GitHub Actions,
   and web/host/daemon-only PRs produced no CI signal at all. New jobs close the gap.

## New CI jobs

| Job                     | Suite                                | Note                                                                                                                                                                 |
| ----------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-tests`             | `pnpm -F @accomplish/web test:unit`  | Integration suite intentionally excluded (14 root-caused upstream failures, `DEVELOPMENT_CHECKPOINT.md` §24.4); unit aliases point at sources, no build step needed. |
| `daemon-tests`          | `pnpm -F @accomplish/daemon test`    | With `pnpm rebuild better-sqlite3 --recursive` for real SQLite coverage.                                                                                             |
| `host-tests`            | `pnpm -F @accomplish/host test:unit` | Unit only. Gateway Playwright E2E requires a local ollama server (`apps/host/e2e/fixtures/gateway.ts:442-454`) — pending, see below.                                 |
| `windows-ci` (extended) | + `pnpm -F @accomplish/daemon test`  | Exercises the Windows named-pipe transport (`packages/agent-core/src/daemon/socket-path.ts:30-34`) and win32 spawn paths.                                            |

## Verification executed (all on this machine, Ubuntu ARM64 / Snapdragon)

| Check                                                                                                                                                                                                          | Result                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                                                                                                               | PASS (pinned lockfile, no upgrades)                                                                                                                                                                                       |
| `pnpm format:check`                                                                                                                                                                                            | PASS (all files)                                                                                                                                                                                                          |
| `pnpm typecheck` (all 5 workspaces)                                                                                                                                                                            | PASS                                                                                                                                                                                                                      |
| `pnpm lint:eslint`                                                                                                                                                                                             | PASS — 0 errors + the 3 pre-existing `useExecutionEffects.ts` warnings (baseline unchanged)                                                                                                                               |
| `pnpm -F @accomplish/host test:unit`                                                                                                                                                                           | PASS — 329/329 (15 files)                                                                                                                                                                                                 |
| `pnpm -F @accomplish/daemon test`                                                                                                                                                                              | PASS — 392/392 (30 files)                                                                                                                                                                                                 |
| `pnpm -F @accomplish/web test:unit`                                                                                                                                                                            | PASS — 557/557 (35 files)                                                                                                                                                                                                 |
| Full packaging chain `pnpm -F @accomplish/desktop build:unpack` (bundled-Node download → web/electron build → daemon tsup build → `stage-daemon-deps` → packaged-mode MCP bundling → electron-builder `--dir`) | PASS — produced `release/linux-arm64-unpacked`                                                                                                                                                                            |
| `assert-packaging-invariants.cjs --app-root …/resources`                                                                                                                                                       | PASS — no better-sqlite3 in asar.unpacked; daemon native binary present; bundled Node ABI match                                                                                                                           |
| `smoke-packaged-opencode.cjs --artifact-dir=… --expected-version=1.14.18`                                                                                                                                      | PASS — packaged `opencode-linux-arm64` binary reports 1.14.18 and `opencode serve --port=0` reaches the ready line                                                                                                        |
| Parity audit re-run (`apps/host/scripts/parity-audit.mjs`)                                                                                                                                                     | UNCHANGED — allowlist 99 · blocklist 7 · daemon registered 138 · declared 250 · shim implemented 142; regenerated doc is byte-identical to the committed one except the generated run-date line (2026-10-27 → 2026-10-28) |
| `git status` after packaging                                                                                                                                                                                   | Only the three intended files modified; a build side-effect on `packages/agent-core/mcp-tools/dev-browser/package-lock.json` (regenerated npm lockfile) was restored to HEAD                                              |

## Remaining platform-specific verification (pending)

- **Windows and macOS packaging has NOT been run.** The repaired chain cannot be claimed
  green on those runners from this machine; GitHub Actions verification is pending (no run
  triggered — no pushes allowed during this milestone). First exercising on win/mac runners
  is the acceptance step for this milestone.
- Full Linux artifacts (AppImage/deb) unverified locally — only the unpacked layout is
  locally reproducible (`build:unpack`); the local environment lacks `fpm` (deb backend);
  electron-builder's AppImage/deb targets run only inside the release jobs.

## Known limitations

1. Host gateway E2E (12 specs, incl. the secrets-redaction and presence auto-deny security
   fixtures) still requires a live ollama endpoint; adding it to CI needs an ollama service
   container or a fixture-mode model server — follow-up change, not done here.
2. Web integration suite (371 pass / 14 fail baseline) deliberately not added to CI to keep
   the gate green; the 14 failures are root-caused upstream debt (checkpoint §24.4).
3. `pnpm download:nodejs -- --platform=<target>` relies on pnpm flag pass-through (the `--`
   separator); the flag-bearing form is now confined to the five tested chain scripts.
4. Packaging scripts are not unit-tested; their correctness is enforced by the two added
   post-pack verification gates (invariants + smoke) which run in all five release jobs.

## Suite-count baseline delta

None by intent: no runtime source changed. All executed suites match the M6-A closeout
baseline (`DEVELOPMENT_CHECKPOINT.md` §24.2) where comparable (daemon 392, host unit subset
329 = 341−12 integration, web unit 557).
