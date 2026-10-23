# M5 DEBUG CHECKPOINT — Context-Management Handover Point

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `e9bd129` (M5 debug checkpoint) · Verified commits: `c505e74` (dev-browser work), `e9bd129` (this doc), parent `a959ce7` (M5 plan), `5bce405` (M4 complete)
**Reason for this document:** E2E-suite developer sessions hit the context limit twice. This preserves all findings; task handoff now uses **`docs/M5_REMAINING_TASKS.md`** (small per-session tasks, 30–50K token budget each). Nothing pushed/merged; `/home/chris/Accomplish` untouched; production data (`~/.local/share/Accomplish`) untouched (production daemon pid 3945 verified unchanged; environment sweep after the aborted run confirms no orphaned host/daemon/chromium/sidecar processes and no residual listeners).

---

## 1. Completed work (verified)

### A. Assignment 1 — dev-browser relay-port override + integration-test repair + verification harness (17 files, COMPLETE, suites re-verified green at handover)

**Verified state at handover:** agent-core **807 pass + 1 pre-existing skip** (+5) · daemon **345** (+1) · dev-browser-mcp package **111/111** (was 108 tests / 1 failed) · typecheck 5/5 · eslint clean on all 17 files · prettier clean on all 17 files.

1. **Port override (`ACCOMPLISH_DEV_BROWSER_RELAY_PORT`), default UNCHANGED 9224.** Root cause addressed: `DEV_BROWSER_PORT=9224` was hard-coded (`packages/agent-core/src/common/constants.ts:1`) and the sidecar self-heal `killProcessOnPort(9224)` (`browser/server.ts`) could kill the PRODUCTION daemon's relay when an isolated E2E daemon runs dev-browser tasks concurrently. Resolution: daemon resolves once (`browser/server-utils.ts` `resolveDevBrowserRelayPort()`, validated integer, invalid → 9224 + warning), then threads the RESOLVED value everywhere the port is consumed:
   - sidecar spawn env pins `DEV_BROWSER_PORT=<resolved>` (sidecar code UNCHANGED — its pre-existing `DEV_BROWSER_PORT||9224` read binds the override);
   - MCP child env (`generator-mcp.ts` → generated config `environment`) + child self-resolution (`dev-browser-mcp/src/connection.ts` — valid override wins, invalid warns and falls back to the legacy chain);
   - daemon consumers (`task-service-helpers.ts`, `dev-browser-service.ts`, `task-config-builder.ts` via `resolveTaskConfig.devBrowserPort`);
   - generator threading (`config-generator-types.ts`, `config-generator.ts`, `resolve-task-config.ts`, `index.ts` barrels).
   - Residual (recorded, out of M5 scope): desktop `stopDevBrowserServer` port-kill fallback still uses the raw constant (desktop never runs in this scenario).
   - **No security weakening:** loopback bind + first-message/bearer auth unchanged; this is an isolation seam mirroring the M1 `DEV_BROWSER_CDP_PORT` pattern.
2. **dev-browser-mcp integration test repair (test-only).** Root cause: test "browser_snapshot: gets accessibility snapshot" called `page.accessibility.snapshot()`, REMOVED by installed rebrowser-playwright-core 1.64.101 (package spec `^1.52.0`). Production code does NOT use that API (snapshots are built from `ariaSnapshot`, `renderAriaTree`). Fix: test now uses `page.locator('body').ariaSnapshot()` and asserts non-empty YAML + `heading "Hello World"`. Suite 111/111. (M5 plan §3.2; baseline failure → repaired.)
3. **Tests added:** `tests/unit/browser/server-utils-ready.test.ts` (+3: default/valid/6-invalid), `mcp-tools/dev-browser-mcp/src/connection.test.ts` (+3: override-honored/override-beats-DEV_BROWSER_PORT/invalid-fallback), `tests/unit/opencode/generator-mcp.test.ts` (+2: child env pin/absent), `apps/daemon/__tests__/unit/task-config-builder.unit.test.ts` (+1: end-to-end chain 9224→9324 with `vi.stubEnv`).
4. **Dev-browser verification harness `/tmp/opencode/m5-verif/m5-browser-verif.mjs` (NON-PERSISTENT, not committed) — PASS 16/16, 226 s wall.** Proves, on an ISOLATED daemon (own data dir, `ACCOMPLISH_DEV_BROWSER_RELAY_PORT=9324`, ollama glm-5.3:cloud): lazy pre-sidecar state (`captureFrame=null`, no listeners) · two real navigation tasks on the SAME sidecar session (browser_navigate ×4; h1 reads of two DISTINCT live pages: `iana.org/help/example-domains` "Example Domains" vs `iana.org/about` "About IANA") · sidecar+Chromium pids live on :9324 while up · `captureFrame` returns a real 1280×720 frame mid-session · SIGTERM → daemon drains, **0 leaked sidecar/Chromium processes, port 9324 clear** (M4 `0b428de` behavior corroborated) · reboot-of-daemon then lazy relaunch works (`devBrowser.shutdown → {"stopped":false}` pre-sidecar) · explicit `devBrowser.shutdown → {"stopped":true}` clears the listener · final sweep 0 orphans; production daemon pid unchanged throughout.
   - **Harness discoveries:** (a) `example.com/.org/.net` NO LONGER SERVE an `<h1>` (IANA redesign, verified live) — old "Example Domain" h1 assertions would be vacuous; the model also answered one prompt from memory and was caught only because live pages with distinct titles were asserted; (b) an idle dev-browser-mcp MCP tool child legitimately outlives `devBrowser.shutdown` (owned by opencode, no listener) and is reaped at daemon SIGTERM — initial harness FAIL was a harness discriminator bug, product behavior correct.
5. **M4 reliability (Assignment-1 scope observation):** sidecar cleanup after restart directly re-verified (§3 above).

### B. Assignment 2 — gateway E2E Playwright suite (work preserved in tree, NOT committed; 1 of 2 verification runs green)

Preserved files (untracked/modified):

- `apps/host/playwright.config.ts` (workers/1 serial, retries 0, chromium)
- `apps/host/e2e/fixtures/gateway.ts` (~600 lines) + `task-helpers.ts` (~278)
- `apps/host/e2e/specs/`: all 10 planned specs (`10-rate-burst` … `99-presence-autodeny`)
- `apps/host/package.json` (+ `@playwright/test ^1.57.0` devDep — **lockfile resolves 1.59.1, same as desktop; verified via CLI**) + `test:e2e` script
- `pnpm-lock.yaml`, `.gitignore`, `.prettierignore` (artifact ignores + the `specs/` negation fix — **verified** via `git check-ignore`)
- All 13 E2E files + this doc + the M5 plan are now prettier-clean; eslint clean (one targeted disable with justification).

**Verification status:**

- **Full-suite run 1: PASS 14/14 (3.2 m wall)** at the state inherited from the cancelled session.
- Architect polish applied afterwards: prettier --write; ESLint `no-empty-pattern` fix in `gateway.ts` (`({}, use)` is Playwright's REQUIRED fixture signature — an interim `_fixtures` rename BROKE Playwright at runtime with "First argument must use the object destructuring pattern"; final fix = `({}, use)` + targeted eslint-disable comment); `apps/host/tsconfig.json` now type-checks the e2e tree (`include` += `e2e/**/*.ts`, `playwright.config.ts`; `lib` += `DOM` for browser-context callbacks in `waitForFunction`); `test.extend<{}, WorkerFixtures>` generic corrected (was `Record<string, never>` which typed the worker fixture chain as `never`). Typecheck 5/5 green after fixes.
- **Full-suite run 2 (post-polish): 13/14** — `90-secrets-redaction` failed in the serial chain while **the same spec passes in isolation (4.0 s)**. Root cause NOT yet identified (candidates: provider-state carry-over from `80-provider-model`, RPC restore race in the serial chain, route-interception timing). Debugging was interrupted (user aborted a targeted re-run); **do not repeat the suite-wide debugging loop** — task T1 in M5_REMAINING_TASKS.md owns this one flake with a narrow scope.

**Key evidence captured by green run 1 (usable for the checkpoint §23):**

- `40-task-approve`: real ollama task 2.2 m — permission card → UI Allow → file created in the isolated workspace with EXACT content `M5_TASK_APPROVE_OK`; transcript confirmation rendered; badge `completed`.
- `50-task-deny`: UI Deny → card closes → **file never created**; agent reacted to the denial ("Tool bash error"), terminal `completed` (agent adapts rather than hard-fails — matches M4 soak observations).
- `99-presence-autodeny`: task started over an ephemeral WS which then disconnected → permission auto-denied with no UI in **~11 s** → denial delivered as adapter tool-error feedback (explicit denial wording absent from transcript — mirrors M2 harness observation; hard proof = file absence + tool-error block); terminal `completed`.
- `30-unauthenticated`: 401 without/wrong bearer; 403 for blocklisted secrets methods even when authed; WS wrong-token → closed, no auth-ok; page without token fragment shows the shell-access error state.
- `70-settings`: theme round-trip UI→RPC→UI(reload). `80-provider-model`: ollama connected + selected model reflection via scrubbed RPC. `90-secrets-redaction`: interception mechanism proven (masked metadata crossed, no raw key). `10-rate-burst` + `20-boot`: green (burst ordering first in serial chain).

---

## 2. Current bugs / open issues

| #   | Issue                                                                              | Status                                                                                                                 |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `90-secrets-redaction` flake: passes in isolation, failed once in the serial chain | **Open — owned by task T1** (M5_REMAINING_TASKS.md); stability bar = 2 consecutive full-suite green runs after the fix |
| 2   | `@playwright/test` version drift (host spec `^1.57.0` vs desktop `1.59.1`)         | **Closed** — lockfile resolves 1.59.1 (= desktop), verified via CLI                                                    |
| 3   | E2E artifacts not prettier/gitignore-ready                                         | **Closed & verified** (`git check-ignore` proof; `pnpm format:check` green) — commits with the suite (T2)              |
| 4   | Host tsconfig did not type-check the e2e tree; DOM lib; `test.extend` generic      | **Closed** — `include` += e2e + config, `lib` += DOM, generic `{}, WorkerFixtures`; typecheck 5/5 green                |
| 5   | `docs/PHASE_3_M5_PLAN.md` prettier warning (committed `a959ce7`)                   | **Closed** — `--write` applied in this handover                                                                        |
| 6   | Desktop `stopDevBrowserServer` port-kill fallback uses raw constant                | Recorded residual, out of M5 scope                                                                                     |

No new product bugs discovered. All M1-M4 security/protection suites green at handover (host 332, desktop 522 per developer report; agent-core 807+1skip / daemon 345 / dev-browser-mcp 111 re-verified directly at `c505e74`).

## 3. Root causes identified (summary)

1. **dev-browser-mcp integration failure** = test-side API removal (rebrowser ≥1.55 dropped `page.accessibility`), NOT a product regression. Repaired.
2. **dev-browser port hazard** = hard-coded 9224 + self-heal killProcessOnPort → isolated-instance concurrency hazard. Fixed via env override + config threading (default behavior byte-identical).
3. **gitignore `specs/`** unscoped pattern would silently drop the new E2E specs from commits (near-miss caught at handover).

## 4. Modified files (this handover point)

**Assignment 1 (verified green; ready to commit):**

- `packages/agent-core/src/browser/server-utils.ts`, `server.ts`, `index.ts`; `packages/agent-core/src/index.ts`
- `packages/agent-core/src/opencode/config-generator-types.ts`, `config-generator.ts`, `generator-mcp.ts`, `resolve-task-config.ts`
- `packages/agent-core/mcp-tools/dev-browser-mcp/src/connection.ts`, `connection.test.ts`, `integration.test.ts`
- `packages/agent-core/tests/unit/browser/server-utils-ready.test.ts`, `tests/unit/opencode/generator-mcp.test.ts`
- `apps/daemon/src/task-service-helpers.ts`, `task-config-builder.ts`, `dev-browser-service.ts`; `apps/daemon/__tests__/unit/task-config-builder.unit.test.ts`

**Assignment 2 (preserved in tree; run 1 green 14/14, run 2 13/14 — see §1.B):** `apps/host/e2e/**` (fixtures + 10 specs), `apps/host/playwright.config.ts`, `apps/host/tsconfig.json` (+e2e type-check +DOM lib), `apps/host/package.json` (+`@playwright/test` +`test:e2e` script), `pnpm-lock.yaml`, `.gitignore` + `.prettierignore` (scoped artifact + `specs/` negation fixes, verified).

**Non-persistent artifacts:** `/tmp/opencode/m5-verif/m5-browser-verif.mjs` (PASS 16/16 — document only; recreate from this doc if lost). `/tmp/opencode/m5-e2e*` and `/tmp/opencode/m4-soak`, `/tmp/opencode/m3c3-poc` harness trees remain non-persistent by design.

## 5. Remaining tasks for M5

**Handoff moved to `docs/M5_REMAINING_TASKS.md`** (small per-session tasks, 30–50K tokens each, one objective each, dependency-ordered T1–T8). Summary order: T1 redaction flake fix → T2 E2E suite commit → T3 M4 soak re-check → T4 desktop-MCP re-check → T5 ARM64 bundle → T6 full battery → T7 manual acceptance (with user) → T8 checkpoint §23 + recommendations + docs commit.

**STOP after M5; M6 requires separate approval.**
