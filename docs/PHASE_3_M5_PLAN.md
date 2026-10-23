# PHASE 3 M5 — E2E Testing Implementation Plan (Rev. 1)

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `5bce405` (M4 complete, clean tree)
**Approved basis:** user directive 2026-10-23 — "Proceed with Phase 3 M5 end-to-end testing" (7 priorities: Firefox integration, Chromium browser automation, security, desktop integration, M4 reliability, automated testing, manual acceptance).
**Scope discipline:** M5 is a verification-and-harness milestone. No feature changes, no permission weakening, no deferred-designs implementation (§C of the M4 plan stays deferred). Two small test-enabling changes are explicitly justified in §3. Nothing pushed/merged; `/home/chris/Accomplish` untouched.

---

## 1. What M5 must prove

KujengaAccomplish works reliably as an **end-to-end AI execution environment** on Ubuntu ARM64 (Snapdragon, GNOME/Wayland) with Firefox (UI shell), Chromium (automation), OpenCode, Ollama, and desktop-control capabilities:

1. **Firefox integration** — authenticated gateway launch; task create → execute → complete; streaming; permission/approval workflows; provider/model selection; task history + recovery.
2. **Chromium browser automation** — sidecar startup/shutdown; navigation/interaction; browser-session persistence (within sidecar lifetime); cleanup after failures/daemon restarts; disposition of the failing dev-browser-mcp integration test.
3. **Security** — M1 protections intact at every layer; unauthorized requests rejected; disconnected-UI permission auto-deny; credentials never leave protected paths. **No permission weakening to make tests pass.**
4. **Desktop integration** — M3/C3 `linux-desktop` MCP tools still work; AT-SPI discovery/interaction; per-action permission enforcement (no unrestricted mouse/keyboard).
5. **M4 reliability** — restart recovery; working-directory preservation; `waiting_for_user`/`resuming` states; watchdog; rate limiting; browser-sidecar cleanup.
6. **Automated testing** — the M5 gateway E2E harness implemented/repaired; baseline-vs-regression triage; full regression suites; ARM64 compatibility.
7. **Manual acceptance** — real-Firefox checklist executed where feasible; human-interactive items require explicit user confirmation.

---

## 2. Harness design (Playwright Chromium against the HTTP gateway)

**Reality that shapes the design:** no Playwright Firefox build exists for Ubuntu 26.04 ARM64 (`~/.cache/ms-playwright` has Chromium 1248 only), Docker is unavailable, and `E2E_MOCK_TASK_EVENTS` intercepts at desktop-main only (no mock over the gateway — gateway tasks are REAL). Therefore:

- **Browser:** Playwright Chromium (same-origin HTTP app; browser-agnostic by design — this is the plan §8 approved approach). Real-Firefox-specific behavior remains covered by the manual checklist + prior live verifications until Phase 5 BiDi.
- **Task strategy:** REAL ollama tasks (`glm-5.3:cloud`) with small prompts against an isolated data dir — the same proven pattern as M2 live verification and the M4 soak. Keep prompts tiny and file targets explicit under the test workspace.
- **Fixture home:** `apps/host/e2e/` co-located with the existing gateway code and its `__tests__/integration` conventions. `@playwright/test` is already a pnpm-store package (apps/desktop devDep) — added to `apps/host` devDependencies at the same version; the shared browser cache needs no new download. The Electron suite (`apps/desktop/e2e`) stays byte-identical (it is Docker/native-run, out of M5 scope).

**Isolated instance recipe (per worker run, serial):**

```
dataDir = mkdtemp('/tmp/opencode/m5-e2e/…')
host: node apps/host/dist/index.js --data-dir <dataDir> --port 0 \
        --token <test token> --web-dist apps/web/dist/client
  → stdout contract 'ACCOMPLISH_GATEWAY_URL=<url>' (index.ts:136) → poll daemon ready
  → host auto-spawns the daemon (daemon-connector.ts start() → spawn → ready poll)
provider: node apps/host/scripts/setup-dev-provider.mjs --provider ollama \
        --server-url http://127.0.0.1:11434 --model glm-5.3:cloud --data-dir <dataDir>
browser: chromium.launch() → page.goto(<gatewayUrl>#token=<test token>)
```

Single-instance detection is per-dataDir, the daemon derives socket/SQLite/PID from the same dataDir, and the token file is 0600 — production data (`~/.local/share/Accomplish`) is never touched. Serial workers (one dataDir chain per worker) mirror the Electron config.

## 3. Two explicit, justified test-enabling changes (no permission weakening)

1. **dev-browser relay port env override** — `DEV_BROWSER_PORT = 9224` is a hard-coded constant and the sidecar self-heal `killProcessOnPort(9224)` could **kill the production daemon's relay** when an isolated E2E daemon runs a dev-browser task concurrently. Fix mirrors the existing M1 `DEV_BROWSER_CDP_PORT` override pattern: env override (e.g. `ACCOMPLISH_DEV_BROWSER_PORT`, default unchanged 9224, loud warning for non-default explicit use is NOT needed here — this is an isolation seam for loopback tests). Loopback + first-message/bearer auth unchanged. Provenance: `packages/agent-core/src/common/constants.ts:1`, `browser/server.ts:189`.
2. **dev-browser-mcp integration test repair** — the failing test (`Remote CDP Integration › browser_snapshot: gets accessibility snapshot`) calls the deprecated `page.accessibility.snapshot()`, **removed by installed rebrowser-playwright-core 1.64.101** (package spec still says `^1.52.0`). Production code does NOT use the removed API (snapshots are built from `ariaSnapshot`, `src/index.ts` `renderAriaTree`). Fix is test-side: assert via `page.locator('body').ariaSnapshot()` (or equivalent). This converts a known baseline failure into a green suite; it is a regression repair of the M5 harness, not a product change.

Everything else — allowlist (98), blocklist (7), scrubber/redaction, presence gate, socket 0600, watchdog, rate limiter (1500/60 s + env override), `Restart=on-failure` — must remain **exactly as committed**; tripwire tests already guard the policy.

---

## 4. Spec inventory (target state, `apps/host/e2e/`)

**A. Boot & auth (no LLM):**

| Spec                      | Asserts                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot.spec.ts`            | Gateway URL loads; UI renders (no error page); token captured from fragment (fragment stripped); `daemon.ping` alive; onboarding auto-completes (`onboarding_complete=1`) |
| `unauthenticated.spec.ts` | Page without `#token` → shell-access error page (not the app); HTTP without bearer → 401; `secrets.getApiKey`/`getAllApiKeys` → 403 via WS/RPC path even when authed      |
| `rate-burst.spec.ts`      | ~1000 rapid authed requests → none throttled (1500/60 s budget; complements the M4 host unit test at the real gateway layer)                                              |

**B. Core lifecycle (real ollama tasks, isolated workspace under the temp data dir):**

| Spec                     | Asserts                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-approve.spec.ts`   | Prompt → submit → execution page; permission card for bash/write; **Allow via UI**; streaming transcript renders assistant content before completion; terminal status success; exact file created |
| `task-deny.spec.ts`      | Task requested; **Deny via UI**; card closes; terminal state reached (agent reacts to denial); no file created (or denial surfaced in transcript)                                                 |
| `history.spec.ts`        | After a completed task, history page lists it with correct status (SQLite persistence through the UI)                                                                                             |
| `settings.spec.ts`       | Settings page loads over the gateway; a non-secret setting change round-trips (UI → RPC → UI), verified additionally via direct HTTP `/rpc`                                                       |
| `provider-model.spec.ts` | Ollama visible as connected provider; model selection change persists (`provider.getSettings` selectedModel via scrubbed HTTP read)                                                               |

**C. Security battery (extends M1/M2 → E2E layer):**

| Spec                        | Asserts                                                                                                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence-autodeny.spec.ts` | Task started by a transient WS client which then disconnects → permission request → **auto-deny with no UI** → denial delivered to opencode → task reaches terminal state (M1 §5.2 browser-layer proof). A second page-open variant: close page while prompt pending → auto-deny; reopen → UI consistent |
| `secrets-redaction.spec.ts` | Network-level Playwright interception of `/rpc` responses during settings/provider browsing → response bodies contain no raw secret values (only masked shapes); DOM contains no plaintext secrets                                                                                                       |

**D. Harness-level (daemon/socket scripts, `/tmp/opencode/`, non-persistent — NOT Playwright):**

Reused proven patterns from `/tmp/opencode/` (m4-soak harness, m3c3-poc driver) to verify — recorded in the checkpoint, not part of the committed suite:

- **Chromium automation end-to-end:** dev-browser task (navigate + interact + read `example.com` title) on an ISOLATED daemon with the §3.1 port override; sidecar startup/shutdown semantics (`captureFrame` null pre-sidecar; `shutdown {stopped}`); browser-session persistence within the sidecar lifetime (cookie/localStorage survives steps in one task/session); cleanup after daemon restart (no sidecar/Chromium orphans — M4 `0b428de` corroborated); self-heal relaunch after a stale-sidecar kill.
- **M3/C3 desktop integration:** re-run the existing m3c3-poc driver (AT-SPI list/launch/controls/invoke/read on Calculator; blocklist deny) — proves the linux-desktop tool works at HEAD with per-action permission gating; portal-screenshot consent stays a MANUAL checklist item (human grant required).
- **M4 reliability:** reduce-re-run of the m4-soak harness (restart recovery, cwd preservation, waiting-state survival, crash recovery) at M5 HEAD + full unit coverage already committed (M4 §22.3).

## 5. Triage of pre-existing failures (baseline vs regression)

| Failure                                    | Disposition                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| web integration 61                         | Upstream baseline (documented since Phase 2; identical with M-work stashed annually) — record, do not fix in M5 |
| dev-browser-mcp integration 1              | **Fix in M5** (§3.2 — test-side API removal repair)                                                             |
| lint 3 warnings (`useExecutionEffects.ts`) | Pre-existing; untouched                                                                                         |
| Desktop docker E2E                         | Unavailable (no Docker on this machine) — not a code defect; documented                                         |

## 6. Manual acceptance (real Firefox, real machine)

`docs/PHASE_3_M5_MANUAL_FIREFOX_CHECKLIST.md` — fresh run against current HEAD production instance: launch via launcher (zero client errors via `/client-log`), task start + permission Allow/Deny from the real UI, streaming visible, history visible, provider/model set from real UI, dev-browser task from real UI (headful Chromium visible is optional/background-first), pickers (folder/file) via real Firefox, `accomplish://` deep link, and the **optional** portal-screenshot consent item (requires the operator present — M3 AUTH-HOLD path). Every human-interactive item waits for explicit user confirmation and is never claimed passed without it.

## 7. Out of scope / deferred (per directive + M4 §C)

Deferred designs reviewed for recommendations only (no implementation): CAPTCHA/MFA assistance requests (`waiting_for_user` trigger — plan §C1), browser-session handoff (§C2), remote assistance via Android, resuming after human verification. No M6 work. No new permission grants; no auto-approve anywhere; Electron suite untouched; production data/daemon untouched.

## 8. Acceptance criteria

1. `pnpm -F @accomplish/host test:e2e` green on this aarch64 machine (the gateway E2E suite; the Electron suite is environment-blocked only, unchanged).
2. Full regression battery green: daemon 344 / agent-core 802+1skip / host 332 / web unit 488 / desktop 522 / typecheck 5/5 / lint 0 errors / prettier clean (± M5 additions only).
3. dev-browser-mcp suite green (29/29) after the §3.2 repair.
4. Harness-level evidence recorded: Chromium automation, desktop MCP, M4 reliability re-checks.
5. Manual checklist run with the user; human-interactive items confirmed by the user.
6. Checkpoint §23 + plan + docs committed; commit hashes reported. STOP after M5.
