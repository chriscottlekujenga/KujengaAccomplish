# PHASE 3 IMPLEMENTATION PLAN — KujengaAccomplish Firefox Migration (Rev. 2)

**Date:** 2026-10-21 · **Branch:** `linux-firefox-ai` · **HEAD:** `a06b0ea`
**Status:** Rev. 2 approved; **M1 (security foundation) committed `d644f92`** — results in `docs/DEVELOPMENT_CHECKPOINT.md` §18. **M2 (essential API functionality) complete 2026-10-22, commits `fcd4cc6`…`fa0e377` + docs commit** — results in checkpoint §19 (parity gate per `docs/PARITY_INVENTORY.md`). **M3 (feasibility research) complete 2026-10-22 — no code, no system changes; findings in `docs/PHASE_3_M3_WAYLAND_DESKTOP_CONTROL_FEASIBILITY.md` (checkpoint §20); prototype proposal awaits the C3 / Phase-5B approval gate.** **C3 granted → minimal linux-desktop MCP prototype implemented + live-verified 2026-10-23 (`a06b0ea`, §21). M4 (unattended reliability + human-wait state machine) complete 2026-10-23 — commits `43a68ea`, `f40db12`, `0b428de` + docs; results in checkpoint §22; deferred human-assistance designs in `docs/PHASE_3_M4_PLAN.md` §C. M5 (E2E testing, §8) complete 2026-10-23 — commits `c505e74`…`bbaa5b7` + docs: gateway E2E suite committed and green (14/14 × 3 runs), full regression battery green with zero regressions, manual Firefox checklist executed with the user (H1–H9, H11 PASS; H10 PASS for navigation + extraction; O1 portal-screenshot SKIPPED — M3 AUTH-HOLD carryover); results in checkpoint §23; deferred-designs recommendations (M6+ prioritization + concrete proposal) in `docs/PHASE_3_M5_DEFERRED_DESIGNS_RECOMMENDATIONS.md`; browser preview rendering remains unresolved per user directive (checkpoint §23.5).** M6 awaits approval. Nothing pushed/merged; `/home/chris/Accomplish` untouched.
**Inputs:** `.opencode/plans/FIREFOX_MIGRATION_PLAN.md` (six-phase roadmap), `docs/DEVELOPMENT_CHECKPOINT.md` (Phase 2 complete, AI-task acceptance PASSED), capability inventories (2026-10-21).

**Rev. 2 changes from Rev. 1 (per review):** security foundation moved ahead of all API expansion; permission-gate design corrected (presence must not be inferred from the gateway's persistent socket); milestone order = M1 security → M2 essential API → M3 desktop-control feasibility → M4 reliability → M5 E2E → M6 remaining parity; desktop-control feasibility added as a Phase 3 planning milestone (prototype not implemented); incremental parity rules; preservation constraints codified.

---

## 1. Objective & Long-Term Vision Alignment

Phase 3 turns the Firefox build into a **secure, reliable, feature-complete local AI assistant** — the Stage-1 foundation.

| Vision stage                                                              | How Phase 3 serves it                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stage 1** — AI assistant operating the local Ubuntu Snapdragon computer | Hardened local services and a corrected permission gate before any API expansion; essential provider/skills/file/browser APIs; unattended reliability; desktop-control feasibility groundwork. |
| **Stage 2** — multi-agent system                                          | OpenCode native `task` subagents, `todowrite`, skills reused (never rebuilt); daemon stays a headless multi-client core — Stage-2 agents are just additional authorized socket clients.        |
| **Stage 3** — employee-facing platform                                    | §9 defines forward-compatibility seams implemented _by design_ only (gateway as sole auth boundary, audit/usage seams, centralized policy) — the platform itself is explicitly out of scope.   |

**Preservation constraints (binding for all milestones):**

- `/home/chris/Accomplish` (fork source) remains **read-only**; ports come from committed HEAD `690b447` only.
- Electron bridge stays functional: `apps/desktop` tests green every milestone (retired in Phase 6, unchanged).
- **No OpenCode capability is disabled or re-implemented** — bash, files, web fetch/search, subagents, todos, skills, permission policy all keep working as-is.
- **No new restrictions on authorized file access outside the task workspace** — the daemon's existing bash-ask permission baseline is the only file/shell gate; side-service hardening must not impair MCP tools ↔ sidecar or LLM-proxy traffic (tokens passed via daemon-owned env).
- Isolated data dir `~/.local/share/Accomplish`; token files 0600; never push/merge/reset without approval.

---

## 2. Current State (verified 2026-10-21)

### 2.1 What works

- Firefox UI ↔ `apps/host` gateway ↔ daemon: onboarding, task lifecycle, permissions, settings core, providers (ollama verified end-to-end), scheduler, pickers, deep links, systemd daemon, single-instance launcher.
- AI task execution proven from real Firefox (`docs/DEVELOPMENT_CHECKPOINT.md` §12); default execution workspace fix committed (`9ad4b5e`).
- Battery: daemon 196/196 · agent-core 724+1skip · host 137/137 · web unit 398/398 · desktop 494/494 · web integration 158 pass/61 pre-existing upstream failures.

### 2.2 Parity & security facts (fresh inventory)

| Area                                        | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shim parity                                 | `AccomplishAPI` = **249 methods** (`accomplish.ts:67-787`). Shim implements **129** (7 no-op). **120 unavailable**: providers/secrets writes (59), skills management (7), connectors OAuth (14), GWS (8), speech (2), screenshot/logging (4), file-attach paths (2), daemon control (4), browser preview (6), analytics 37 (no-op Proxy). All 16 critical WS event subscriptions are wired.                                                                                          |
| Gateway policy                              | `RPC_METHOD_ALLOWLIST` = 62 entries; daemon exposes **125** methods → **63 blocked** today (14 settings-write, 9 provider, 6 secrets-write, 13 connectors, 7 gwsAccount, 4 auth.openai, 4 whatsapp, 4 misc incl. `task.stop`, `skills.addFromPath`, `logs.getTasksForBugReport`). Blocklist = 7 secret reads + `provider.getSettings` field scrubber.                                                                                                                                |
| **Permission auto-deny gate (broken — M1)** | `hasConnectedClients()` counts Unix-socket clients (`rpc-server.ts:67-74`). The gateway holds **one persistent daemon socket** regardless of browser state; browser WS clients are tracked only inside the gateway (`gateway.ts:234`) and never reported to the daemon → the daemon currently cannot distinguish an open UI from an idle gateway; permissions never auto-deny while the host runs. Electron's socket, by contrast, legitimately implied UI presence (trusted shell). |
| Unix socket                                 | **No chmod anywhere** (`rpc-server.ts:132` bare `listen()`; umask-dependent, typically 0755). Data dir 0700, token file 0600.                                                                                                                                                                                                                                                                                                                                                        |
| Side services                               | `:9224` dev-browser relay — **no auth** · `:9225` Chromium CDP — **no auth** · `:9228` Azure proxy / `:9229` Moonshot proxy — **no auth** · `:9230` WhatsApp API — bearer token + rate limit, bare-`204` OPTIONS.                                                                                                                                                                                                                                                                    |
| Rate limiter                                | 600 req / 60 s per token on all browser-facing routes — known flake source (UI reconnect floods; checkpoint §17).                                                                                                                                                                                                                                                                                                                                                                    |
| E2E reality                                 | Playwright 1.59.1; **no Playwright Firefox build for Ubuntu 26.04 ARM64** (cache: chromium-1248 only). All 10 E2E specs are `_electron`-based.                                                                                                                                                                                                                                                                                                                                       |
| Desktop control                             | Upstream removed a `desktop-control` MCP tool at `05a25bc`: nut.js **X11-only** (unsuitable on GNOME Wayland), actions = click/type/scroll/hotkey/window-mgmt/screenshot, gated per-action via permission POST + title blocklist (password managers). Gating/UX design is recoverable; library is not.                                                                                                                                                                               |
| Sandbox setting                             | `settings.sandbox` (`disabled                                                                                                                                                                                                                                                                                                                                                                                                                                                        | native | docker`) persists to SQLite, exposed over RPC, but is **inert**: `wrapSpawnArgs` has zero call sites; daemon never injects a sandbox provider (`task-service.ts:132`) → `DisabledSandboxProvider` always. Deferred to desktop-control/Phase 5B decision (§8.6). |

---

## 3. What Already Exists — DO NOT REBUILD

Stage-1 "operate my computer" capability is mostly already present. OpenCode 1.14.18 gives every task natively:

| Already provided                                          | Via                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Shell, file read/write/edit, glob, grep, apply_patch, LSP | OpenCode built-ins (`bash, read, write, edit, glob, grep, apply_patch, lsp`)                     |
| Web fetch + search                                        | `webfetch`, `websearch`, `codesearch`                                                            |
| **Multi-agent foundation**                                | OpenCode `task` subagent tool (with resume), `todowrite`                                         |
| Task workflow + skills + questions                        | `start-task` / `complete-task` MCP, bundled `skill` tool + SkillsManager (`skills.*` RPC)        |
| Permission enforcement                                    | Daemon `permission-handler` + bash ask-patterns (~32 patterns) — stays centralized in the daemon |
| Chromium browser automation                               | dev-browser sidecar + 26 `browser_*` MCP tools                                                   |
| Google/WhatsApp/connectors                                | GWS/gmail/calendar MCPs, WhatsApp bridge, connector token storage (daemon side)                  |
| Scheduled + unattended execution                          | Scheduler (cron + boot catch-up), systemd daemon, crash recovery                                 |
| Cost visibility (seed)                                    | `accomplish-ai.usage-update` events, provider usage rows                                         |

Conclusion: **no new shell/file/web/agent tools**. Phase 3 work fills gaps and hardens what exists only.

---

## 4. Revised Implementation Order

| #   | Milestone                               | Focus                                                                                                                 | Size (w/ Flash delegation)                                                                                                                                                                                                                                        |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Security foundation**                 | Permission-presence gate redesign, socket 0600, side-service auth, secrets-exposure fixes — _no allowlist expansion_  | L (~2–3 dev-days)                                                                                                                                                                                                                                                 |
| M2  | **Essential API functionality**         | Provider/model mgmt → skills/MCP mgmt → file attachments → browser-automation integration (incremental, paired tests) | M–L (~2–3 dev-days)                                                                                                                                                                                                                                               |
| M3  | **Wayland desktop-control feasibility** | Spike + feasibility report + prototype plan — **planning deliverable only, prototype not implemented**                | M (~0.5–1 dev-day)                                                                                                                                                                                                                                                |
| M4  | **Unattended reliability**              | Resume cwd, watchdog coverage, restart policy, rate-limit fix, soak test                                              | ✅ COMPLETE 2026-10-23 (`43a68ea`, `f40db12`, `0b428de` + docs) — checkpoint §22; + human-wait state machine (`waiting_permission` wired, `waiting_for_user`/`resuming` additive) per the M4 approval directive; deferred designs in `docs/PHASE_3_M4_PLAN.md` §C |
| M5  | **E2E testing**                         | Playwright-Chromium gateway fixture, ported core specs, extended security battery, Firefox manual checklist           | ✅ COMPLETE 2026-10-23 (`c505e74`…`bbaa5b7` + docs) — checkpoint §23; gateway E2E suite green 14/14 × 3, full battery green, manual checklist executed with the user; deferred-designs recommendations in `docs/PHASE_3_M5_DEFERRED_DESIGNS_RECOMMENDATIONS.md`   |
| M6  | **Remaining API parity**                | OAuth re-homing, GWS/WhatsApp/auth.openai, daemon control, bug report, speech, full parity audit                      | M–L (~1.5–2 dev-days)                                                                                                                                                                                                                                             |

Ordering rule: **no allowlist expansion is part of M1**; every later RPC expansion ships with paired authorization & secrets tests (§5.4). One conventional commit per milestone; full battery green before each commit; no pushes/merges.

---

## 5. Security Architecture (M1)

### 5.1 Trust model & boundaries

```
Firefox (untrusted page) ── WS + Bearer token ──▶ apps/host gateway (auth boundary)
  ├─ persistent daemon socket = INFRASTRUCTURE presence only (never UI presence)
  ├─ browser WS clients = INTERACTIVE presence, counted & reported to daemon
  ├─ allowlist+blocklist+scrubbers enforced here (defense-in-depth; policy lives in daemon)
Electron renderer (bridge period) ▶ Electron main socket client = legacy trusted-shell presence
Agent runtime (opencode) ▶ bash/file tools gated ONLY by daemon permission-handler (unchanged)
Side services (9224/9225/9228/9229/9230) ▶ loopback + per-process bearer tokens
```

### 5.2 Permission-presence gate — corrected design (M1, highest priority)

**Problem (reviewer-confirmed):** `hasConnectedClients()` counts the gateway's persistent socket, so _any_ design that requires "no socket clients" as a condition is dead — and any design that lets the gateway's socket stand for UI presence is wrong in the other direction. UI presence must be **explicit, fresh, and reported**, never inferred.

**Design: explicit client typing + reported interactive presence.**

1. **Client typing at socket connect.** Gateway identifies itself to the daemon once per socket connection (`daemon.setClientType('gateway')` — or handshake field). The daemon classifies each socket client as `gateway` or `legacy`.
2. **Gateway reports interactive presence.** On every browser WS connect → `daemon.setUiPresence({ count: n })`; on disconnect → `{ count: n' }` immediately; while any client is attached, a **30 s heartbeat** re-asserts the count. No WS clients → count 0.
3. **Daemon-side presence state & staleness.** Daemon stores `{ count, lastUpdate }` per gateway connection. `uiPresent = anyGatewayReportsCount0 && (now − lastUpdate) ≤ 90 s`. Covers both failure modes:
   - graceful disconnect → immediate count-0 → presence drops instantly;
   - host crash (no final message) → heartbeat stops → presence expires after ~90 s.
4. **Auto-deny condition (single, correct):**

   ```
   interactiveClient =
       any LEGACY socket client connected            (Electron main; trusted shell semantics preserved)
    OR any gateway-reported browser-client count > 0 and fresh
   shouldAutoDeny = !interactiveClient
   ```

   The gateway's own socket **never** satisfies `interactiveClient` on its own. Immediate auto-deny (existing `task-callbacks.ts:104-107` behavior) and the 5-min in-flight timeout (`PERMISSION_REQUEST_TIMEOUT_MS`) are unchanged — this design changes _who counts as a client_, not the deny mechanics.

5. **Backward compatibility.** If **no** gateway-typed client is connected (pure-Electron session, CLI tools), the daemon falls back to today's `hasConnectedClients()` semantics → Electron behavior identical to Phase 2. Mixed session (gateway + Electron): Electron's socket still counts as a legacy interactive client; gateway counts only when it reports live browser clients.
6. **Unattended execution preserved explicitly.** Scheduled/WhatsApp-triggered tasks run with whatever authorization they have today: with the UI open they prompt; with no interactive client they auto-deny (same _outcome_ as today, faster than the current 5-min wait). **No auto-approve is introduced.** Explicit unattended authorization remains a designed seam only: schedules are user-created records, and a future flag (`task.permissions.unattended`, settable only by the scheduler on user-created schedules) is documented as the Stage-2 extension point — not implemented in Phase 3.

**M1-1 acceptance tests (automated, daemon + host suites):**

- Gateway connected, reports 0 → permission request auto-denies immediately.
- Gateway reports ≥1 fresh → prompt delivered (no deny); 5-min timeout path still reachable.
- Tab closes gracefully → daemon notified → in-flight and subsequent requests auto-deny.
- Host killed with browser open → staleness expiry (~90 s) → auto-deny.
- Gateway restart + WS reconnect flood → presence re-registered, no flapping false denials (heartbeat grace verified).
- Pure-Electron session (no gateway) → behavior byte-identical to today (desktop suite green).
- Scheduled task: UI closed → auto-deny (as today); UI open → prompts (as today).

### 5.3 Unix socket & side services (M1)

- **Socket 0600:** chmod the daemon Unix socket after listen (`rpc-server.ts`); data dir already 0700. Test asserts socket mode `0600`.
- **Side-service bearer tokens:** dev-browser relay `:9224`, Chromium CDP `:9225`, Azure `:9228`, Moonshot `:9229` each require a per-process bearer token (generated by the spawning side — daemon/task bootstrap — passed via env; loopback bind verified; Origin checks on HTTP surfaces). MCP tools and LLM proxies receive the same env — **no functional change to authorized traffic**. WhatsApp `:9230` gets Origin validation + proper CORS preflight (replace bare-204).
- Acceptance: scripted loopback sweep — every protected endpoint returns 401 without token; existing dev-browser-driven task (Chromium `browser_*` tools) passes unchanged with tokens in place.

### 5.4 Secrets exposure (M1) and the expansion policy (M2+)

- **M1 — close the current surface before expanding it:** audit the existing 62 allowlisted methods for key material in responses; generalize the `provider.getSettings` field scrubber (`SECRET_FIELD_NAMES`) to every method whose response can carry secrets; verify host+daemon logs never contain tokens/keys (log redaction test); blocklist review (7 entries + request-body secrets accepted only on write methods).
- **Expansion policy (binds M2/M6):** a daemon method may be added to the allowlist **only** in the same change that (a) documents its response shape, (b) adds a scrubber or proves no secret fields, (c) adds an authorization test (browser cannot invoke it unauthenticated; method behaves identically for Electron), and (d) adds a redaction test for any secret-bearing path. Inventory is re-run per milestone (§6).

---

## 6. Essential & Remaining API Parity — Incremental Rules

**Parity inventory (living):** new script `apps/host/scripts/parity-audit.mjs` enumerates all `AccomplishAPI` keys and reports implemented / no-op / unavailable per domain; output checked in as the maintained inventory; re-run at M2/M6 gates. **Gate at M6: 0 methods unavailable that the UI can reach in Firefox mode** (feature-flagged-off surfaces must degrade gracefully, not throw).

### M2 — Essential API functionality (priority order fixed by review)

1. **Provider/model management** (core 59 domain): set/get provider configs (ollama, LiteLLM, LMStudio, Azure Foundry, NIM, OpenAI baseUrl), test-connection, fetch models (ollama/openrouter/litellm/lmstudio/bedrock-vertex via blocklist-safe masked paths), set/get active + connected providers, model update, debug mode. _Every config write carries the API key — read paths return masked data only (policy §5.4)._
2. **Skills and MCP management:** `getUserSkillsPath`, pick/add-from-folder (host zenity picker exists), delete, resync; connector **CRUD** that is pure daemon RPC (list/get/getEnabled/upsert/setEnabled/delete) exposing user-added remote-MCP servers; skill enable toggles existing RPCs.
3. **File attachments:** `getFilePath` / `processDroppedFiles` routed through host pickers (`pick-files` exists); document the interface change — drag-dropped browser `File` objects cannot reveal local paths; picker flow remains the authorized path. No new restrictions beyond the existing permission model.
4. **Browser automation integration:** verify the full dev-browser stack (26 `browser_*` tools) works from Firefox-run tasks unchanged; implement browser-preview APIs as **on-demand screenshot v1** (`startBrowserPreview`/`stop`/`getStatus`/`onBrowserFrame` → dev-browser screenshot fetch, no live screencast per migration plan §8.5); Chromium stays the automation browser in Phase 3 (Firefox BiDi is Phase 5 — nothing disabled).
5. **Remaining essential API functionality:** allowlist the corresponding daemon methods task-by-task **with paired tests (§5.4)**; settings CRUD that the onboarding/settings pages require; `task.stop`.

**M2 acceptance:** parity inventory shows providers + skills + file-attach + browser-preview domains fully green; unit tests per shim method (mock transport); secrets/authorization tests for every newly allowlisted method; full battery green; manual Firefox checklist (set ollama config, fetch models, add user skill from folder, attach file via picker, dev-browser task completes).

**Size: M-L.**

### M6 — Remaining API parity

- **Connector OAuth flows re-homed to host loopbacks** (Google accounts, MCP connector strategies, `oauth-callback-server.ts` from desktop main; `accomplish://` deep links already route to host): `startConnectorOAuth/completeConnectorOAuth`, `loginBuiltInConnector` (Slack MCP), `auth.openai` (4), GWS accounts (8), GitHub Copilot, OpenAI/ChatGPT login.
- **WhatsApp** (4) + WhatsApp-side-service token interplay.
- **Daemon control** (4): `daemonRestart/Stop/Start` + socket-path — host-owned; acceptance = restart-then-reconnect exercise (existing backoff in `daemon-connector.ts`).
- **Bug report & export** (4): in-page `captureScreenshot`/`captureAxtree` (no privilege needed), `generateBugReport`/`exportLogs` using `logs.getTasksForBugReport` + host logs.
- **Speech** (2): feature-flagged OFF with friendly degradation (never throws).
- **Analytics** (37): replaces Rev.-1 no-op decision with a **local batched JSONL endpoint** in the data dir (no GA4) — this is also the Stage-3 cost/usage seam (§9). If the UI cannot tolerate the endpoint in M6, ship graceful no-ops and record in the inventory.
- Complete remaining allowlist entries (target: full 125 minus intentional blocklist) each with paired tests; final `parity-audit.mjs` gate (0 unreachable).

**Size: M-L.**

---

## 7. M4 — Unattended Reliability

1. Thread `workingDirectory` through `resumeSession` turns (lazily-respawned runtimes currently inherit daemon cwd — the bug class that broke Phase 2).
2. Watchdog keep-alive exclusion becomes an extensible configurable set (`server.heartbeat`, `file.watcher.updated`, …) instead of the hard-coded single entry.
3. systemd user unit adds `Restart=on-failure` (+ `RestartSec`); build-id respawn path verified.
4. **Rate-limit fix** (checkpoint §17): exempt authenticated in-session bursts or raise the daemon-local budget; reconnect-flood regression test.
5. **Soak acceptance:** 30-min multi-step local task (writes files, runs commands, `daemonRestart` mid-task via M6 daemon control, resume) completes without hangs; crash-recovery marks orphans `failed`.
6. Optional triage-only classification of the 61 pre-existing web-integration failures (upstream debt vs Firefox-related); fix only Firefox-related ones.

**Acceptance:** daemon+agent-core tests for resume-cwd and watchdog exclusions; soak scripted (harness style, `/tmp/opencode/`, non-persistent) and documented in the checkpoint.

## 8. M5 — E2E Testing — **✅ COMPLETE 2026-10-23** (checkpoint §23)

**Outcome:** the §2-designed gateway E2E Playwright suite (`apps/host/e2e/`, 10 specs, real ollama tasks, native aarch64 Chromium) is committed and green — **14/14 × 3 full-suite runs** at final HEAD, incl. the extended security battery (`30-unauthenticated` 401/403/WS-auth, `99-presence-autodeny` ~11 s no-UI auto-deny, `90-secrets-redaction` network-level interception with the redaction core unchanged). Full regression battery green with ZERO regressions (host 332 / daemon 345 / agent-core 807+1skip / web unit 491 / desktop 522 / web integration 158/61 = exact upstream baseline). Manual real-Firefox checklist executed WITH the user: H1–H9, H11 PASS; H10 PASS for navigation + page extraction; O1 portal-screenshot consent SKIPPED by the user (M3 AUTH-HOLD carryover); three real client-side bugs found by the manual session were fixed and user-retested (`0f1c647`, `dda0077`). **Unresolved by user directive: the browser preview panel renders blank** (preview-page-vs-agent-page seam — M6 design item). ARM64, M4-soak, and linux-desktop rechecks all green at final HEAD. Harness-level evidence for Chromium automation, desktop MCP, and M4 reliability recorded in the debug checkpoint. Deferred designs (CAPTCHA/MFA trigger, browser-session handoff, Android/WhatsApp assistance, resume-after-verification) reviewed for RECOMMENDATIONS only — `docs/PHASE_3_M5_DEFERRED_DESIGNS_RECOMMENDATIONS.md` (contains the concrete M6-A/M6-B proposal). Nothing pushed/merged.

- **Playwright Chromium against the HTTP gateway** (the app is same-origin HTTP; no Playwright Firefox build exists for Ubuntu 26.04 ARM64). New fixture: spawn host (headless, temp data dir, injected token) + daemon; no `_electron`.
- Port core spec subset: onboarding, task lifecycle (start → permission approve → complete), permission **deny**, settings CRUD, history.
- Extend the M1/M2 security battery into the E2E layer (auth matrix, secrets redaction, presence-gate scenarios).
- **Real-Firefox manual checklist** remains the truth for Firefox-specific behavior (pickers, deep links, OAuth M6 flows) until Phase 5's BiDi harness (fork adapter + `puppeteer-core`) provides automated real-Firefox coverage.

**Acceptance:** MET — `pnpm -F @accomplish/host test:e2e` green (14/14 × 3); battery green; checkpoint §23 + plan + recommendations committed; deferred-designs plan delivered (this is the record of the §7 review). M6 requires separate approval.

## 9. Stage-3 Forward-Compatibility Seams (design-only)

1. **Gateway = the only user-facing auth boundary.** Multi-tenancy later = scoped tokens/roles at the gateway; daemon stays single-owner headless core. M1's client-typing is the first token-scope seam.
2. **Authorization lives only in the daemon** (permission-handler + policy); shim/UI never enforces policy.
3. **Usage & cost seams:** `accomplish-ai.usage-update` events + M6 local analytics JSONL keep usage data structured and local for Stage-3 aggregation.
4. **Audit seam:** `/client-log` + daemon journals structured & greppable; no new logging silos.
5. **Per-user scoping discipline:** new persisted records carry a natural owner/rescope path; no hard-coded single-user assumptions in new modules.

---

## 10. M3 — Wayland Desktop-Control Feasibility (planning deliverable, no prototype implementation) — **✅ COMPLETE 2026-10-22**

**Outcome:** feasibility report delivered: [docs/PHASE_3_M3_WAYLAND_DESKTOP_CONTROL_FEASIBILITY.md](PHASE_3_M3_WAYLAND_DESKTOP_CONTROL_FEASIBILITY.md) — all §10.1 techniques probed live on this machine (read-only; zero installs/changes). Verdict: **feasible with zero new system packages** — AT-SPI (targeting/verify; live control-tree evidence) + XDG portal RemoteDesktop (authorized input; uinput fallback already device-writable via ACL) + portal Screenshot; `wtype` and GNOME Shell `Eval`/`Screenshot`/`Introspect` recorded FAIL/locked; integration sketch = `linux-desktop` MCP package (dev-browser pattern) with a stdio Python helper and a new daemon `desktop` permission type. Prototype plan + acceptance battery (§ report) dispositioned to **Phase 5B / C3 approval gate** together with the inert `settings.sandbox` decision.

**Goal (from review):** determine — on _this_ Ubuntu 26.04 ARM64 (Snapdragon, GNOME/Wayland) machine — which approaches can eventually support a desktop-control capability, and produce the prototype plan for separate approval. **No prototype is implemented in Phase 3.** No package installation without explicit user approval (probe with preinstalled tools and read-only queries first).

### 10.1 Techniques under evaluation (each measured, PASS/FAIL + evidence)

| Technique                         | Probe (read-first)                                                                                                                                                                                                                                                                                                                             | Prototype-possible role                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session environment**           | `echo $XDG_SESSION_TYPE`, GNOME version, systemd user unit env (`DBUS_SESSION_BUS_ADDRESS` availability inside the daemon)                                                                                                                                                                                                                     | Prerequisite for everything; also confirms the daemon can open the _user session_ bus                                                                                                                                                                         |
| **AT-SPI accessibility**          | `busctl --user tree org.a11y.Bus`; check `gsettings org.gnome.desktop.interface toolkit-accessibility`; enumerate accessible applications → windows (`frames`) → actions via GI/busctl (no install if bindings absent — escalate, or use a tiny scripted probe); check Node/GObject binding options (e.g., `node-gtk`) vs. a privileged helper | **Element-aware interaction** (identify windows/controls by role+name; invoke actions; read state) — the most reliable path, no synthetic coordinates                                                                                                         |
| **XDG Desktop Portal**            | `busctl --user introspect org.freedesktop.portal.Desktop`; check `Screenshot`, `ScreenCast`, `RemoteDesktop` backends (`xdg-desktop-portal-gnome`)                                                                                                                                                                                             | **Screen verification** (portal Screenshot w/ interactive grant), **authorization-compatible input** (RemoteDesktop sessions request an interactive user approval dialog — matches the "explicit authorization" requirement), session-scoped screen awareness |
| **ydotool / uinput**              | `command -v ydotool ydotoold`; `/dev/uinput` ownership/permissions; group membership — _no install without approval_                                                                                                                                                                                                                           | **Compositor-level input injection** (app-agnostic key/mouse/scroll); needs session daemon + uinput perms; no element awareness — pair with AT-SPI for targeting                                                                                              |
| **wtype**                         | presence + GNOME support check (zwp_input_method_v1 — historically unsupported by GNOME)                                                                                                                                                                                                                                                       | Likely FAIL; verify & record                                                                                                                                                                                                                                  |
| **GNOME window management D-Bus** | `org.gnome.Shell` Eval restrictions (locked in modern GNOME), `Introspect` policy, `gnome-extensions` route; `wmctrl`/`xdotool` see only XWayland windows                                                                                                                                                                                      | Determine whether programmatic window enumerate/focus is possible without shell extensions; record limits                                                                                                                                                     |
| **Screenshot/verification**       | portal Screenshot; `gnome-screenshot` CLI behavior (interactive grant)                                                                                                                                                                                                                                                                         | Result verification step of the demo loop; also feeds future multimodal verification (out of scope)                                                                                                                                                           |

### 10.2 Feasibility criteria (report format)

Per technique: works on this machine? (Y/N/partial + evidence) · requires privileged setup? (packages/udev groups/services — listed for approval) · reliable for scripted use? · authorization-compatible? (fits the per-action permission gate) · ARM64-specific issues?

### 10.3 Prototype plan (delivered in M3; **not** implemented — needs explicit approval)

Demonstration loop the prototype must eventually show, with explicit per-action user authorization (port of the removed upstream gating design: `PermissionRequest.type='desktop'` + window-title blocklist incl. password managers, user-extendable):

1. **Open an application** — authorized launcher (`gio launch <desktop-file>` / direct exec) with permission prompt.
2. **Identify its window** — AT-SPI enumeration of the new application's frames/titles (no screenshots needed).
3. **Interact with an approved control** — AT-SPI action invoke on a named control (button press / text entry), each action individually prompted and blocklist-checked.
4. **Verify the result** — read back AT-SPI state (e.g., field text, toggled state, focused window) and/or portal screenshot; report PASS/FAIL to the task.

The plan deliverable specifies: chosen technique combination (driven by §10.1 findings), the `linux-desktop-mcp` tool surface, new daemon permission type + UI prompt design, blocklist/allowlist mechanics, session-environment requirements, and risks (e.g., uinput perms, portal grant dialog UX, GNOME D-Bus lockdown). **Disposition:** prototype implementation proposal → separate approval gate (likely as a new Phase 5B; desktop-control sandbox decision §2.2 folds into the same gate).

**M3 acceptance:** feasibility report checked into `docs/` with recorded probe outputs from this machine; prototype plan written; **zero application-source changes and zero system modifications without approval.**

---

## 11. Risks & Dependencies

| #   | Risk / dependency                                                                             | Milestone | Mitigation                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Presence-gate redesign could regress legitimate prompts (UI open, heartbeat lost)             | M1        | Deny only when _no legacy client_ **and** no fresh reported count; automated regression matrix (§5.2) incl. graceful/crash/reconnect |
| 2   | Socket/side-service tokens break MCP tools or LLM proxies                                     | M1        | Tokens passed via daemon-owned env to the same processes; acceptance = existing Chromium dev-browser task passes unchanged           |
| 3   | Allowlist expansion widens browser attack surface                                             | M2/M6     | Expansion policy §5.4 — paired authorization + secrets tests per method; battery gates every milestone                               |
| 4   | OAuth re-homing breaks Electron bridge                                                        | M6        | Host gains loopback servers; desktop IPC handlers unchanged; desktop suite green required                                            |
| 5   | `daemonRestart` from browser bricks gateway                                                   | M6        | Restart-then-reconnect acceptance test (existing daemon-connector backoff)                                                           |
| 6   | No Playwright Firefox on Ubuntu 26.04 ARM64                                                   | M5        | Chromium fixture (browser-agnostic HTTP app); real-Firefox automation = Phase 5 BiDi (no Playwright dependency)                      |
| 7   | Wayland desktop-control needs privileged setup (ydotool service, uinput group, portal grants) | M3→5B     | Feasibility-first; privileged items listed for explicit user approval; portal RemoteDesktop grants keep authorization user-held      |
| 8   | GNOME D-Bus lockdown may forbid window management without extensions                          | M3        | Recorded as feasibility finding; AT-SPI primary path                                                                                 |
| 9   | Mixed Electron+gateway sessions                                                               | M1        | Legacy-client semantics preserved; known-limitation note for prompt routing; tests cover both pure and mixed cases                   |
| 10  | Rate-limit change could permit flooding                                                       | M4        | Exemption limited to authenticated same-origin in-session traffic; per-token budget retained                                         |

## 12. Out of Scope / Deferred

- **Phase 4 (unchanged):** Kujenga feature port from fork HEAD `690b447` (SFTP, WordPress MCP, orchestration, mid-run messaging, renaming, expert autonomy).
- **Phase 5 (unchanged):** Firefox WebDriver BiDi backend + real-Firefox E2E.
- **Desktop-control prototype implementation** (M3 output is a plan) — separate approval, proposed as Phase 5B together with the inert `settings.sandbox` decision (activate `native`/`docker` or remove the setting).
- Electron-shell changes beyond keeping it green; upstream integration-test debt beyond triage; auto-approve for unattended tasks (no such mechanism in Phase 3).

## 13. Approval Checkpoints & Cost Plan

| Checkpoint             | Gate                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C0 — this document** | Approval to begin M1                                                                                                                                                                                                                                                                                                                                                                                             |
| **C1 — end of M1**     | Security review: presence-gate evidence, socket/side-service sweep results, secrets audit presented **before M2 expands anything**                                                                                                                                                                                                                                                                               |
| **C2 — end of M2**     | Parity inventory + paired-test evidence review                                                                                                                                                                                                                                                                                                                                                                   |
| **C3 — M3 findings**   | Desktop-control prototype (and sandbox decision) approval before any implementation — evidence ready: `docs/PHASE_3_M3_WAYLAND_DESKTOP_CONTROL_FEASIBILITY.md` (2026-10-22); ### C3 GRANTED → minimal linux-desktop MCP prototype implemented + live-verified 2026-10-23 (checkpoint §21). M4 (§7) complete 2026-10-23 (checkpoint §22). M5 (§8) complete 2026-10-23 (checkpoint §23). **M6 requires approval.** |
| **C4 — end of M6**     | Final parity audit (0 unreachable) + phase review before Phase 4                                                                                                                                                                                                                                                                                                                                                 |

Per-milestone conventional commits; checkpoint doc updated at C1–C4. **No push/merge/reset at any point without approval.**

Execution: GLM-5.3 Flash for routine implementation/testing via @developer (narrow per-assignment scope); GLM-5.3 :cloud for planning/review; local ollama for dev-task smoke tests. Worktree `/home/chris/Accomplish` stays READ-ONLY. Total rough effort: **~8–11 dev-days** across M1–M6.

---

_Implementation will not begin until this revised plan is approved._
