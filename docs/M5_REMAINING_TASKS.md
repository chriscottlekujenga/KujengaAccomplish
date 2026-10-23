# M5 REMAINING TASKS — Small-Session Handoff Plan

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `96a3fbe` (T1 done) · **Read first:** `docs/M5_DEBUG_CHECKPOINT.md` (all investigation findings — do NOT re-investigate), `docs/PHASE_3_M5_PLAN.md` (approved design).

**Session rules for every task:** one objective · 30–50K token budget · fresh session · run only the listed focused tests · commit verified results via the architect (or as instructed) · concise handoff report (state deltas only) · never touch `~/Accomplish`, `~/.local/share/Accomplish`, the production systemd daemon, or gateway policy files (`apps/host/src/policy.ts`) · never weaken M1 security.

---

## 1. Completed work (verified + committed)

| Commit    | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a959ce7` | M5 implementation plan (docs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `c505e74` | dev-browser relay-port override (`ACCOMPLISH_DEV_BROWSER_RELAY_PORT`, default 9224 unchanged + full config threading) and dev-browser-mcp integration-test repair (`ariaSnapshot`). Suites at commit: agent-core 807+1skip, daemon 345, dev-browser-mcp 111/111, typecheck 5/5, lint/format clean                                                                                                                                                                                                                                                                |
| `e9bd129` | M5 debug checkpoint (docs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `96a3fbe` | **T1 complete** — gateway E2E suite committed WITH the `90-secrets-redaction` flake fixes (interceptor teardown drain; rate-window-spanning 429 retries; `expect.poll` seeding/restore verification; eslint artifact-dir ignores + gateway lint directives + tsconfig prettier). Verified: 2 consecutive full-suite runs 14/14 green (2:38.7 / 3:20.5); standalone 90-run green; typecheck/format/eslint clean; T2's commit therefore folded into T1's commit per T1's own commit line. **Preserved-tree E2E suite is now committed; nothing else uncommitted.** |

**Verified and committed (`96a3fbe`):** the gateway E2E Playwright suite — `apps/host/e2e/` (fixtures + 10 specs), `apps/host/playwright.config.ts`, host `package.json`/`tsconfig.json`, lockfile, `.gitignore`/`.prettierignore`, `eslint.config.mjs`. T1's acceptance was met on the committed tree state (runs taken immediately before commit; post-commit standalone 90-run green; hooks only re-flowed whitespace). Post-commit double full-suite re-run remains as T2's leftover acceptance item if the user wants it closed in-session. Harness evidence: §1 previous rows unchanged.

**Harness evidence already banked (no repeat needed):** dev-browser verification harness `/tmp/opencode/m5-verif/m5-browser-verif.mjs` PASS 16/16 (sidecar lifecycle, two live navigation tasks on distinct real pages — note: example.com/.org no longer serve `<h1>`, use iana.org pages — port-override isolation, captureFrame, SIGTERM cleanup 0 orphans, lazy relaunch, explicit shutdown). E2E green-run evidence (approve/deny/autodeny/401/403/WS-auth/redaction/settings/history/burst) recorded in `docs/M5_DEBUG_CHECKPOINT.md` §1.B.

## 2. Known failures (do-not-fix list + the one open item)

| Failure                                                                                                                                                                     | Disposition                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `90-secrets-redaction` serial-chain flake (isolation PASS 4.0 s)                                                                                                            | **CLOSED by T1 at `96a3fbe`** (root causes + evidence: debug checkpoint §1.B) |
| `50-task-deny` 90 s card-wait / `60-history` task.list poll — ONE failure each under cold-model back-to-back load (recorded in debug checkpoint §1.B), not reproduced since | Record-only; watch during T6/T7 — out of T1 scope                             |
| web integration 61                                                                                                                                                          | Upstream baseline — record only                                               |
| Desktop docker e2e                                                                                                                                                          | Environment-blocked (no Docker on machine) — record only                      |
| 3 lint warnings `useExecutionEffects.ts`                                                                                                                                    | Pre-existing — do not touch                                                   |

## 3. Task queue (dependency order)

### T1 — Fix the `90-secrets-redaction` serial-chain flake — **DONE at `96a3fbe`**

- **Outcome:** root causes (both fixed in the spec only, redaction core untouched): (1) `/rpc` interceptor raced context teardown — undrained route stalled teardown past the test timeout (test body was already green); (2) gateway fixed-window rate budget (1500/60 s per token, drained by `10-rate-burst` + task specs) 429'd the restore RPCs — retries now span a full window; (3) seeding/restore now awaited-and-asserted via `expect.poll` on `provider.getSettings`/`settings.getSelectedModel`. Acceptance met: 2 consecutive full-suite runs 14/14 green (2:38.7 / 3:20.5); standalone 90-run green; typecheck/format/eslint clean. Full evidence: `docs/M5_DEBUG_CHECKPOINT.md` §1.B. Two load-tolerance one-offs (`50-task-deny`, `60-history`) recorded there, not reproduced since.
- **Note:** T2's commit folded into T1's commit (as T1's commit line anticipated). T2's unique leftover acceptance item — "suite green twice AFTER commit" — stays with T2; the committed form is unchanged behavior-wise (hooks only re-flowed whitespace) and a post-commit standalone 90-run passed.

- **Objective:** make the E2E suite stably green: 2 consecutive full-suite PASS runs.
- **Files:** `apps/host/e2e/specs/90-secrets-redaction.spec.ts` (primary); minimally `apps/host/e2e/fixtures/gateway.ts` or `task-helpers.ts` ONLY if the root cause requires a fixture-level fix.
- **Constraints:** do NOT weaken the redaction assertions' core (raw-key-absence in DOM + recorded bodies must stay); root-cause the serial failure (candidates per debug checkpoint: provider-state carry-over from `80-provider-model`, restore-`rpcCall` vs teardown race, route-interception install timing vs the previous page's pending requests). If the spec's seeding/restore steps race, make them awaited-and-asserted (`expect.poll` on `provider.getSettings` after seeding) rather than fire-and-forget.
- **Tests/commands:** `pnpm -F @accomplish/host test:e2e` (twice, consecutive, both fully green); then `pnpm -F @accomplish/host exec playwright test --config=playwright.config.ts e2e/specs/90-secrets-redaction.spec.ts` once more standalone. Then `pnpm -F @accomplish/host typecheck && pnpm format:check && npx eslint apps/host/e2e`.
- **Acceptance:** 2 consecutive green full-suite runs (record the two totals + wall times); flake root cause documented in the handoff (one paragraph); no new lint/format/type errors.
- **Commit:** YES — together with T2 below (or alone if T2 merges into it): `test(host): gateway E2E suite (M5)` staging `apps/host/e2e/**` (specs+fixtures only, artifacts are ignored), `apps/host/playwright.config.ts`, `apps/host/tsconfig.json`, `apps/host/package.json`, `pnpm-lock.yaml`, `.gitignore`, `.prettierignore`.
- **Complexity:** M (1–2 debug cycles expected; cap at ~50K tokens — stop and report after 3 failed hypotheses).

### T2 — Commit the gateway E2E suite (fold into T1's commit)

- **Objective:** land the verified suite as one commit with the T1 fix.
- **Files:** as listed in T1's commit line. Verify `git status` shows nothing extra; spec files must appear in `git add` (gitignore negation already verified — re-verify with `git check-ignore -v apps/host/e2e/specs/20-boot.spec.ts` printing nothing).
- **Acceptance:** commit created; `git show --stat` lists fixtures/specs/config; suite green twice AFTER commit; nothing else touched.
- **Tests/commands:** same as T1.
- **Complexity:** S.

### T3 — M4 reliability re-check at final HEAD (soak re-run, reduced)

- **Objective:** re-prove M4 behaviors on the final M5 tree (restart recovery, cwd preservation, waiting-state survival, crash recovery, sidecar cleanup).
- **Files:** none in repo; harness `/tmp/opencode/m4-soak/soak.mjs` (exists — read checkpoint §22.4 for semantics; recreate from that section if lost).
- **Run:** `node /tmp/opencode/m4-soak/soak.mjs --cycles 6` (builder-validation scale; a waiting-state cycle and a mid-task-kill cycle must land — if cycle placement is fixed at 3/6 this satisfies both).
- **Acceptance:** all cycles PASS; record cycle table + "child leftovers killed: 0" lines in the handoff; production daemon untouched (`pgrep`/environ check before+after).
- **Commit:** no code; paste outcomes for the checkpoint docs (T8).
- **Complexity:** S (harness is proven; runtime ~6 min).

### T4 — M3/C3 linux-desktop re-check at final HEAD

- **Objective:** prove the desktop MCP surface still works after M5 changes (it shares agent-core config generation touched by `c505e74`).
- **Files:** none in repo; harness `/tmp/opencode/m3c3-poc/driver.mjs` (exists per survey; recreate from checkpoint §21.2 if lost: MCP stdio driver → `desktop_list_windows` → launch Calculator → `desktop_find_controls` → 5 invokes → `desktop_read` → expect "20").
- **Run:** driver as recorded; do NOT include `desktop_screenshot` (portal consent needs the operator — that is a T7 checklist item).
- **Acceptance:** blocklist-deny + launch + controls + calc + read all PASS; record outcome lines. If a live Wayland prerequisite fails (at-spi down), record as environment note and defer to T7 — do not debug system services.
- **Complexity:** S.

### T5 — ARM64 compatibility record

- **Objective:** record the M5 ARM64 compatibility evidence bundle.
- **Files:** none.
- **Run/collect (all cheap):** ` uname -m`; `node -v`; `node -p process.arch`; `file apps/desktop/resources/nodejs/linux-arm64/…/bin/node` (bundled node arch); `file $(readlink -f apps/desktop/node_modules/.bin/opencode)`; `ls ~/.cache/ms-playwright` (chromium-1248 = the suite's browser); Playwright CLI version; one line: which suites ran natively on aarch64 this milestone (all).
- **Acceptance:** evidence lines collected in the handoff (no fixes expected — this machine is the ARM64 target).
- **Complexity:** S.

### T6 — Full regression battery at final HEAD

- **Objective:** final-state battery proving no regressions from M5.
- **Files:** none (read-only runs).
- **Commands (in order):** `pnpm typecheck && pnpm lint:eslint && pnpm format:check && pnpm -F @accomplish/host test && pnpm -F @accomplish/daemon test && pnpm -F @accomplish_ai/agent-core test && pnpm -F @accomplish/web test && pnpm -F @accomplish/desktop test` then `pnpm -F @accomplish/host test:e2e` once more.
- **Acceptance:** host 332+ / daemon 345 / agent-core 807+1skip / web 488 / desktop 522 (± any T1-added e2e only, which Playwright doesn't count here); typecheck 5/5; lint 0 errors (3 tolerated warnings); prettier clean; E2E suite green. Record all counts.
- **Complexity:** M runtime (~10 min), S tokens.

### T7 — Manual Firefox acceptance (with the user)

- **Objective:** execute the real-Firefox checklist; human-interactive items require explicit user confirmation.
- **Files:** NEW `docs/PHASE_3_M5_MANUAL_FIREFOX_CHECKLIST.md` written by the architect from plan §6 (launcher launch + `/client-log` zero client errors; task start→permission Allow/Deny from real UI; streaming visible; history; provider/model via real UI; pickers via Firefox; `accomplish://` deep link; optional portal-screenshot consent — the M3 AUTH-HOLD item).
- **Acceptance:** checklist executed items marked PASS/FAIL with evidence; unperformed items explicitly listed as NOT RUN — never claim passed; user confirmation recorded for each human step.
- **Complexity:** M (user-dependent wall time).

### T8 — Checkpoint + recommendations + final docs commit

- **Objective:** close M5 documentation.
- **Files:** `docs/DEVELOPMENT_CHECKPOINT.md` (§23: results, commit hashes, suite counts, harness evidence, limitations, manual-checklist results), `docs/PHASE_3_IMPLEMENTATION_PLAN.md` (M5 status line), NEW short `docs/PHASE_3_M5_DEFERRED_DESIGNS_RECOMMENDATIONS.md` (CAPTCHA/MFA assistance trigger — plan §C1 options A/B; browser-session handoff — §C2 constraints; remote assistance via Android; resume-after-human-verification — recommend prioritization for M6+ without implementing), optionally fold the manual checklist outcome in.
- **Acceptance:** docs committed in one `docs(phase3):` commit; recommendations contain a concrete next-milestone proposal; STOP after M5 (no M6).
- **Complexity:** S–M.

## 4. Dependency graph

```
T1 → (+T2 commit) ─┐
T3 ────────────────┤
T4 ────────────────┼→ T6 → T8
T5 ────────────────┤
T7 (with user) ────┘
```

T3/T4/T5/T6/T7 can run in any order after T2 (commit), but T6 must be LAST-before-T8 (final HEAD). T7 requires user availability; schedule early to avoid blocking T8.

## 5. Estimated remaining complexity

| Task  | Estimate                               |
| ----- | -------------------------------------- |
| T1+T2 | M (~1–2 h incl. 2 suite runs × ~4 min) |
| T3    | S (~10 min runtime)                    |
| T4    | S (~5 min live)                        |
| T5    | S (minutes)                            |
| T6    | S tokens / M runtime (~25 min suites)  |
| T7    | M (user session ~30 min)               |
| T8    | S–M (docs)                             |

Total ≈ one focused day. Nothing pushed/merged; stop after M5.
