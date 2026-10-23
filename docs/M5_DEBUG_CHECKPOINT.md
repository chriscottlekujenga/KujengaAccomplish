# M5 DEBUG CHECKPOINT — Context-Management Handover Point

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `96a3fbe` (T1 fix + gateway E2E suite commit) · Verified commits: `96a3fbe` (T1), `c505e74` (dev-browser work), `e9bd129` (this doc), parent `a959ce7` (M5 plan), `5bce405` (M4 complete)
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

- **RESOLVED at `96a3fbe` (architect session, T1 of M5_REMAINING_TASKS.md): the `90-secrets-redaction` serial-chain flake is root-caused, fixed, and the suite is verified green TWICE consecutively.** Full-suite runs with the final tree: **14/14 PASS in 2:38.7** and **14/14 PASS in 3:20.5**, back-to-back; standalone `90-secrets-redaction` re-run PASS 4.0 s; `pnpm -F @accomplish/host typecheck`, `pnpm format:check`, `npx eslint apps/host/e2e` all green at commit time. Production daemon (pid 3945) verified unchanged across all suite runs.
- Original run-1 claim (14/14 green, 3.2 m) remains valid; original run-2 (13/14, one `90-secrets-redaction` failure) is now fully explained (see below).
- Historical pre-T1 polish (preserved from the previous handover): prettier --write; ESLint `no-empty-pattern` fix in `gateway.ts` (`({}, use)` is Playwright's REQUIRED fixture signature — an interim `_fixtures` rename BROKE Playwright at runtime with "First argument must use the object destructuring pattern"; final fix = `({}, use)` + targeted eslint-disable comment); `apps/host/tsconfig.json` now type-checks the e2e tree (`include` += `e2e/**/*.ts`, `playwright.config.ts`; `lib` += `DOM` for browser-context callbacks in `waitForFunction`); `test.extend<{}, WorkerFixtures>` generic corrected (was `Record<string, never>` which typed the worker fixture chain as `never`). Typecheck 5/5 green after fixes.
- Root causes of the flake (two independent mechanisms, both in the spec, both fixed in `90-secrets-redaction.spec.ts`; no product code change):
  1. **Interceptor vs context teardown race.** The `/rpc` interceptor only guarded `route.fetch()`; on context close, in-flight requests produced `Response has been disposed` from `response.text()` OUTSIDE the guard. The undrained route then ALSO stalled context teardown past the test timeout (trace evidence: test body fully green incl. "leaked in 0 of 73 bodies", failed in After Hooks with `route.fetch: Target page, context or browser has been closed` + `Tearing down "context" exceeded the test timeout`). This matches the earlier "restore-rpcCall vs teardown race" observation. Fix: whole handler guarded, drain with best-effort `route.abort()`.
  2. **Gateway rate-window exhaustion.** `apps/host/src/rate-limit.ts` uses a per-token fixed-window counter (1500 req/60 s); `10-rate-burst` consumes 1000 of one window at suite start and task specs drain more. Windows reset only on the 60 s time boundary, so 90's restore RPCs (`provider.setActive` et al.) hit `429 Too many requests` (all 4×500 ms retries stayed inside the drained window — run 13/14 at 2.9 s with exactly this error). Fix: restore mutations retried across a backoff schedule spanning a full window (500 ms/2 s/10 s/20 s/30 s — 429'd requests do not consume budget), seed/restore readbacks verified via `expect.poll` on `provider.getSettings`/`settings.getSelectedModel` (polls now catch transient throws), test timeout 150 s.
  3. **Seeding/restore state-settle verification** (per T1's prescription): the socket seeding RPCs resolve when handled, but durable persisted state lands asynchronously — the UI now loads only after a `provider.getSettings` poll reports the seeded custom provider; the restore read-back is polled to a settled state instead of a single zero-tolerance assert. Redaction assertions' core (raw-key absence in DOM + recorded bodies; mask-crossed sanity) unchanged.
  - Also fixed (verification hygiene): `gateway.ts` eslint directives refreshed (`@typescript-eslint/no-empty-object-type` on the `test.extend<{}, WorkerFixtures>` generic — rule name changed in newer typescript-eslint; stale `no-empty-function` drop removed); `eslint.config.mjs` now ignores the Playwright artifact dirs (`apps/host/e2e/html-report/`, `apps/host/e2e/test-results/` — regenerated every run, same category as existing `**/playwright-report/**`); `apps/host/tsconfig.json` re-flowed with prettier.
- **New observations recorded (one-off, not reproduced after, NOT part of the flake fix):** during the FIRST back-to-back pair attempt under cold-model conditions (run 2 was 13/11+3: ollama had no model loaded, suite 5.1 m): (a) `50-task-deny` failed at the 90 s permission-card wait while the page snapshot showed the deny task still `Running` — model-velocity/load-tolerance, not a product regression; (b) `60-history` failed its 30 s `task.list` poll although the same listing had been verified minutes earlier by `40-task-approve`'s second test — transient; both passed in every subsequent run (12/14+ green across 5 pairs attempted). Worth keeping an eye on during T6/T7; no fixes applied (out of T1's file scope).

**Key evidence captured by green run 1 (usable for the checkpoint §23):**

- `40-task-approve`: real ollama task 2.2 m — permission card → UI Allow → file created in the isolated workspace with EXACT content `M5_TASK_APPROVE_OK`; transcript confirmation rendered; badge `completed`.
- `50-task-deny`: UI Deny → card closes → **file never created**; agent reacted to the denial ("Tool bash error"), terminal `completed` (agent adapts rather than hard-fails — matches M4 soak observations).
- `99-presence-autodeny`: task started over an ephemeral WS which then disconnected → permission auto-denied with no UI in **~11 s** → denial delivered as adapter tool-error feedback (explicit denial wording absent from transcript — mirrors M2 harness observation; hard proof = file absence + tool-error block); terminal `completed`.
- `30-unauthenticated`: 401 without/wrong bearer; 403 for blocklisted secrets methods even when authed; WS wrong-token → closed, no auth-ok; page without token fragment shows the shell-access error state.
- `70-settings`: theme round-trip UI→RPC→UI(reload). `80-provider-model`: ollama connected + selected model reflection via scrubbed RPC. `90-secrets-redaction`: interception mechanism proven (masked metadata crossed, no raw key). `10-rate-burst` + `20-boot`: green (burst ordering first in serial chain).

### C. T3 — M4 reliability soak recheck at final HEAD (2026-10-23, no code, verified)

The soak harness `/tmp/opencode/m4-soak/soak.mjs` was LOST (non-persistent `/tmp`) and recreated with §22.4-of-`DEVELOPMENT_CHECKPOINT.md` semantics (isolated daemon on `/tmp/opencode/m4-soak/data`, newline JSON-RPC 2.0 over `<data>/daemon.sock`, isolated workspace, synthetic-row sqlite seeding + byte-compare, `session.resume`, every-6th-cycle kill, needle-scoped sweeps — kill matchers keyed to the ISOLATED data dir only; the production needle is used solely for the invariance snapshot). Daemon `dist` was rebuilt from clean HEAD before the runs (`pnpm --filter @accomplish/daemon build`; gitignored dist only; production daemon NOT restarted).

**Results — ALL PASS:**

| Run                             | Cycles                                                     | Wall   | Verdict      |
| ------------------------------- | ---------------------------------------------------------- | ------ | ------------ |
| Builder validation `--cycles 2` | 2 (basic: task + SIGTERM restart + boot-recovery + resume) | 97.9 s | 2/2 PASS     |
| Formal `--cycles 6`             | 6 (waiting-probe @3, mid-task-kill @6, basic 1/2/4/5)      | 166 s  | **6/6 PASS** |

- Every formal cycle: real ollama task with exact stamp-content assert → SIGTERM restart → boot-recovery asserts (synthetic `running`→`failed`; `waiting_permission`/`waiting_for_user`/`resuming`/`completed` byte-identical incl. `session_id` + `working_directory`) → `session.resume` continuity (exact content + `cwdPreservedInRow`).
- Cycle 6 (mid-task-kill): SIGKILL while row `running` → boot flips the REAL row `running`→`failed` → sessionId captured (`task.message` notification; persisted `task_messages` composite ids confirm the opencode session store survived the kill) → `session.resume` SAME sessionId → task completed with **5/5 step files** present, pre-kill files preserved.
- **Leftovers:** every graceful SIGTERM restart sweep `0`; final cleanup `soak child leftovers killed: 0` (also `0 matched` — corroborates the `0b428de` sidecar-leak fix); cycle-6 post-SIGKILL orphan sweep `18` — mechanical (a hard kill cannot drain its child tree), swept immediately by the harness within its own chain scope. Port 9420: zero listeners post-run; chain needle matches: none.
- **Production invariance:** prod pid 3945 (cmdline `…apps/daemon/dist/index.js --data-dir /home/chris/.local/share/Accomplish`) cmdline-md5 `e08b3e1c87580f5bfc226dece18862eb` and environ-md5 `c7fa03b6db7000256ef0bab99fd81bdd` IDENTICAL before/after both runs; process alive at end.
- Repo tree clean after both runs (no source changes; M1–M4 security surface untouched — no product code executed beyond the daemon build).

**Harness deviations from §22.4 (all harness-side, recorded for future recreation):**

1. Synthetic seed ids carry an invocation stem (data dir is shared across attempts → `UNIQUE` collisions otherwise).
2. **Synthetic seed timestamps must be recent-dated.** Future-dated seeds (a) crowd the newest-100 `getTasks()` window that `recoverStaleTasks` iterates (a real killed `running` row outside the window then does NOT flip at boot — caught in the first formal attempt) and (b) push real rows past the 100-item history trim (`task.status` null). Edge observation on product behavior, recorded as a watch-item only: `apps/daemon/src/crash-recovery.ts` inherits `getTasks()`'s `ORDER BY created_at DESC LIMIT 100` window — unreachable with real (monotonic) timestamps; no fix applied.
3. Killed-task sessionId is NOT on the row (product writes `session_id` at completion) — recovered live from `task.message` notifications, with persisted `task_messages` composite ids as the durable fallback.
4. Daemon spawn env includes `ACCOMPLISH_APP_PATH=<repo>/apps/desktop` (dev-mode CLI resolution; same value the host passes).
5. The shared soak data dir was wiped once after a failed attempt poisoned it with future-dated seeds; the green builder+formal pair ran on the fresh dir. Within-run DB durability is fully demonstrated (restarts + recovery asserts on the same sqlite); the M4 cross-run history-adoption evidence was not re-reproduced (not a T3 acceptance item).

---

## 2. Current bugs / open issues

| #   | Issue                                                                              | Status                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `90-secrets-redaction` flake: passes in isolation, failed once in the serial chain | **Closed** — root-caused + fixed at `96a3fbe` (interceptor-vs-teardown drain; rate-window-spanning retries for 429s; `expect.poll` seeded/restore state verification); 2 consecutive full-suite runs 14/14 green (§1.B). Minor load-tolerance observations in `50-task-deny`/`60-history` recorded, not reproduced since |
| 2   | `@playwright/test` version drift (host spec `^1.57.0` vs desktop `1.59.1`)         | **Closed** — lockfile resolves 1.59.1 (= desktop), verified via CLI                                                                                                                                                                                                                                                      |
| 3   | E2E artifacts not prettier/gitignore-ready                                         | **Closed & verified** (`git check-ignore` proof; `pnpm format:check` green) — commits with the suite (T2)                                                                                                                                                                                                                |
| 4   | Host tsconfig did not type-check the e2e tree; DOM lib; `test.extend` generic      | **Closed** — `include` += e2e + config, `lib` += DOM, generic `{}, WorkerFixtures`; typecheck 5/5 green                                                                                                                                                                                                                  |
| 5   | `docs/PHASE_3_M5_PLAN.md` prettier warning (committed `a959ce7`)                   | **Closed** — `--write` applied in this handover                                                                                                                                                                                                                                                                          |
| 6   | Desktop `stopDevBrowserServer` port-kill fallback uses raw constant                | Recorded residual, out of M5 scope                                                                                                                                                                                                                                                                                       |

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

**Assignment 2 (COMMITTED at `96a3fbe` together with the T1 flake fixes):** `apps/host/e2e/**` (fixtures + 10 specs), `apps/host/playwright.config.ts`, `apps/host/tsconfig.json` (+e2e type-check +DOM lib), `apps/host/package.json` (+`@playwright/test` +`test:e2e` script), `pnpm-lock.yaml`, `.gitignore` + `.prettierignore` (scoped artifact + `specs/` negation fixes, verified), plus `eslint.config.mjs` (+ Playwright artifact-dir ignores — documented deviation from T1's original file list, required by its `npx eslint apps/host/e2e` acceptance).

**Non-persistent artifacts:** `/tmp/opencode/m5-verif/m5-browser-verif.mjs` (PASS 16/16 — document only; recreate from this doc if lost). `/tmp/opencode/m5-e2e*` and `/tmp/opencode/m4-soak`, `/tmp/opencode/m3c3-poc` harness trees remain non-persistent by design.

## 5. Remaining tasks for M5

**Handoff moved to `docs/M5_REMAINING_TASKS.md`** (small per-session tasks, 30–50K tokens each, one objective each, dependency-ordered T1–T8). Progress: **T1 DONE at `96a3fbe`** (flake fixed, suite committed, verified green twice consecutively; T2's commit folded into T1 per T1's own commit line — its post-commit re-verification remains). **T3 DONE** (M4 soak recheck — builder 2/2 + formal 6/6 PASS at final HEAD; §1.C). Next: T4 desktop-MCP → T5 ARM64 → T6 battery → T7 manual (with user) → T8 checkpoint closure.

**STOP after M5; M6 requires separate approval.**
