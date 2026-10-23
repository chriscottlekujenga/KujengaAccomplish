# M5 DEBUG CHECKPOINT — Context-Management Handover Point

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `a959ce7` (M5 plan) · Parent: `5bce405` (M4 complete)
**Reason for this document:** the E2E-suite developer session hit the context limit mid-verification. This preserves all findings before continuing with fresh sessions. Nothing pushed/merged; `/home/chris/Accomplish` untouched; production data (`~/.local/share/Accomplish`) untouched (production daemon pid 3326 verified unchanged by the harness probes).

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

### B. Assignment 2 — gateway E2E Playwright suite (CANCELLED MID-VERIFICATION; work preserved in tree, NOT committed, NOT yet verified green)

Preserved files (untracked/modified), substantially complete per plan §4 spec inventory:

- `apps/host/playwright.config.ts` (30 lines; workers/1 serial, retries 0, chromium)
- `apps/host/e2e/fixtures/gateway.ts` (469 lines) + `task-helpers.ts` (278)
- `apps/host/e2e/specs/`: `10-rate-burst`, `20-boot`, `30-unauthenticated`, `40-task-approve`, `50-task-deny`, `60-history`, `70-settings`, `80-provider-model`, `90-secrets-redaction`, `99-presence-autodeny` (all 10 planned specs present)
- `apps/host/package.json` (+ `@playwright/test ^1.57.0` devDep + `test:e2e` script) — NOTE: installed version spec is 1.57, desktop uses 1.59.1; check what resolves in the lockfile
- `pnpm-lock.yaml` changed accordingly
- Run artifacts present (`apps/host/e2e/html-report/`, `test-results/`) → a run was IN PROGRESS when cancelled (last report 13:39–13:44); **suite final state UNKNOWN — must be re-run and stabilized by a fresh session before any commit.**
- Prettier: gateway.ts, task-helpers.ts, playwright.config.ts currently WARN (need `--write` before commit).

**Gitignore hazard found (must ship with the E2E commit):** root `.gitignore` `# Speckit` section has unscoped `specs/` which silently ignores `apps/host/e2e/specs/` (desktop specs are already tracked so unaffected). Fix = scoped negation `!apps/host/e2e/specs/` (+ children) near that section. Also needed: `apps/host/e2e/test-results/`, `apps/host/e2e/html-report/` in `.gitignore` AND `.prettierignore` (desktop equivalents already ignored).

---

## 2. Current bugs / open issues

| # | Issue | Status |
|---|-------|--------|
| 1 | E2E suite green state unknown (session cancelled mid-verify-loop) | Open → fresh session re-runs/stabilizes, then commit |
| 2 | `@playwright/test` version drift (host spec `^1.57.0` vs desktop `1.59.1`) | Open → verify resolved version + browser-cache compatibility (chromium-1248 cached) |
| 3 | E2E artifacts not prettier/gitignore-ready | Open → ship with the E2E commit |
| 4 | `docs/PHASE_3_M5_PLAN.md` has a pre-existing prettier warning (committed `a959ce7`) | Open → fix in a docs commit after E2E lands |
| 5 | Desktop `stopDevBrowserServer` port-kill fallback uses raw constant | Recorded residual, out of M5 scope |

No new product bugs discovered. All M1-M4 security/protection suites green at handover (host 332, desktop 522 per developer report; agent-core/daemon re-verified directly).

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

**Assignment 2 (preserved; NOT verified):** `apps/host/e2e/**` (12 files + artifacts), `apps/host/playwright.config.ts`, `apps/host/package.json`, `pnpm-lock.yaml`, plus `.gitignore` fix still to be made.

**Non-persistent artifacts:** `/tmp/opencode/m5-verif/m5-browser-verif.mjs` (PASS 16/16 — document only; recreate from this doc if lost).

## 5. Remaining tasks for M5

1. Commit Assignment 1 (this is done in the same handover as this doc).
2. Fresh session: re-run `pnpm -F @accomplish/host test:e2e`, stabilize to ≥2 consecutive green runs, reconcile prettier + .gitignore/.prettierignore, THEN commit (suite + config + package.json + lockfile + gitignore fixes).
3. Re-run remaining harness-level verifications at final HEAD: M4 soak (reduced) + M3/C3 linux-desktop driver re-check.
4. Full regression battery (daemon/agent-core/host/web/desktop/typecheck/lint/format) at final HEAD.
5. Manual-Firefox acceptance checklist doc + run with user (human-interactive items need explicit confirmation).
6. Deferred-designs recommendations (CAPTCHA/MFA trigger, browser-session handoff, Android remote assistance, resume-after-human-verification) → checkpoint §23.
7. Update DEVELOPMENT_CHECKPOINT (§23) + PHASE_3_IMPLEMENTATION_PLAN status; docs commit(s).

**STOP after M5; M6 requires separate approval.**