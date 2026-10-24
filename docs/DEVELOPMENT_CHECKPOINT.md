# Development Checkpoint — Firefox Migration, Phase 2 / Phase 3 M1·M2

**Date:** 2026-10-22/23 · **Repo:** `~/KujengaAccomplish-AI` · **Branch:** `linux-firefox-ai` · **HEAD:** `bbaa5b7` (+ this M5-closeout docs commit)
**Status:** Phase 2 complete (§B) AND Phase 3 M1 (security foundation) committed `d644f92` (§18) AND Phase 3 M2 (essential API functionality) complete (§19, 8 implementation commits + docs commit) AND Phase 3 M3 (Wayland desktop-control feasibility research) complete (§20, planning deliverable only). **C3 prototype (Phase-5B approval granted): COMPLETE 2026-10-23 — implemented, unit-verified, live-verified, committed `a06b0ea` (see §21). Phase 3 M4 (unattended reliability + human-wait state machine): COMPLETE 2026-10-23, commits `43a68ea` (plan), `f40db12` (implementation), `0b428de` (sidecar shutdown fix) — see §22. Phase 3 M5 (E2E testing + verification closeout): COMPLETE 2026-10-23, commits `c505e74`…`bbaa5b7` — see §23. Nothing pushed/merged; `/home/chris/Accomplish` untouched.**

---

## 1. Project Objective & Architecture

Migrate Accomplish from an Electron desktop app to a **Firefox-based Linux application on Ubuntu ARM64** (Snapdragon X Elite), preserving the React UI, daemon, OpenCode integration, SQLite storage, and task execution.

```
Firefox (dedicated snap profile) → http://127.0.0.1:<port>/#token=<random>
  └─ React UI (apps/web, unchanged) + HTTP shim (accomplish-http.ts)
       ├─ POST /rpc   → apps/host gateway → Unix socket JSON-RPC
       └─ WS  /events ← gateway forwards daemon notifications
apps/host (thin Node gateway): token auth, Host/Origin validation,
  explicit RPC allowlist + secrets blocklist, rate limiting, CSP,
  static UI serving, pickers, deep links, client-log diagnostics
apps/daemon (UNCHANGED, Electron-free): task execution, SQLite,
  opencode serve per task, scheduler, secure storage
```

Security model: loopback-only bind, timing-safe bearer token delivered in the launch URL fragment (never query strings), DNS-rebinding Host validation, cross-origin Origin validation, plaintext-secret methods blocklisted at the gateway, `provider.getSettings` response scrubber.

## 2. Six-Phase Roadmap (`.opencode/plans/FIREFOX_MIGRATION_PLAN.md`)

| Phase | Scope                                                                                              | Status                                                                                                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Browser gateway foundation (host, connector, shim)                                                 | ✅ committed `7f238d4`                                                                                                                                                                                                                   |
| 2     | Ubuntu ARM64 shell (launcher, .desktop, systemd, pickers, deep links)                              | ✅ done + AI-task acceptance PASSED (uncommitted)                                                                                                                                                                                        |
| 3     | Full API parity + hardening + Firefox E2E harness                                                  | in progress — M1 security foundation `d644f92` (§18); **M2 essential APIs complete (§19)**; **M3 feasibility report complete (§20)**; **C3 prototype complete (§21)**; **M4 complete (§22)**; **M5 complete (§23)**; M6 pending approval |
| 4     | Kujenga feature port (SFTP, WordPress, orchestration, messaging, renaming) from `main` @ `690b447` | not started                                                                                                                                                                                                                              |
| 5     | Firefox WebDriver BiDi automation backend (port from `backup-arm64-bidi` @ `be1415e`)              | not started                                                                                                                                                                                                                              |
| 6     | Packaging (deb/AppImage arm64), updater, Electron retirement                                       | not started                                                                                                                                                                                                                              |

## 3. Current Phase & Acceptance Criteria (Phase 2)

- ✅ Firefox launches and displays the React interface on Ubuntu ARM64
- ✅ The interface communicates with the daemon (proven: `onboarding_complete` reset→re-set round-trip)
- ✅ **A simple AI task can execute successfully — PASSED (§B; verified via gateway harness 2026-10-21: task completed in 16 s, `hello_phase2.txt` exact match, live TCP to ollama from the task's serve)**
- ✅ Closing Firefox does not terminate the daemon (systemd-owned)
- ✅ Reopening Firefox restores interface/session (single-instance + persistent token)
- ✅ All relevant automated tests pass

## 4. Completed Implementation Work

**Phase 1 (committed `7f238d4`):** `apps/host` package — gateway (HTTP+WS, auth, policy, rate limit), daemon connector, web HTTP shim + `getAccomplish()` fallback, 85 tests.

**Phase 2 (uncommitted):**

- `firefox-launcher.ts` — snap-aware profile `~/snap/firefox/common/accomplish-app-profile` (snap Firefox cannot read `~/.config` profiles), `--launch`/`--kiosk`
- `desktop-integration.ts` — `accomplish-fox.desktop` + `accomplish://` scheme (installed), `gateway-info.json` single-instance + deep-link forwarding
- `daemon-service.ts` — systemd unit `accomplish-fox-daemon.service` (installed, active + enabled)
- `file-picker.ts` — zenity pickers + `/pick-folder`, `/pick-files`
- Gateway: `/deep-link`, `/client-log` (client diagnostics → host log), `/cli-status`, `/autostart-status`, `provider.getSettings` secret scrubber
- Web: `gateway-bootstrap.ts` + `gateway-bootstrap-init.ts` (FIRST import in `main.tsx`) — captures token before HashRouter consumes `#token=...`, installs shim as `window.accomplish` before module-scope store subscriptions, global error reporting
- Shim: boot-path methods (provider settings, skills, CLI status, speech=unconfigured, build capabilities, autostart, AI usage, logEvent→client-log); optional-method contract fix; `onCloseRequested`/`respondToClose` no-ops
- `App.tsx` gate message (`app.openViaLauncher`, all 4 locales); `RouteErrorFallback` error reporting
- `cli-status.ts`, `provider-settings-scrubber.ts`, `setup-dev-provider.mjs` (ollama + custom modes)
- **§B blocker fixes (this session):** (1) `task-service.ts` threads `selectedModel.provider` into TaskConfig (`startTask` + `resumeSession`); (2) `OpenCodeAdapter.buildModelParam` maps provider via `PROVIDER_ID_TO_OPENCODE` and normalizes the model ref via the previously-unused `normalizeSelectedModelForSdk` (`ollama/glm-5.3:cloud` → `glm-5.3:cloud` — ollama rejects the prefixed ref); (3) continuation/nudge prompt now carries the same `model` param; (4) per-task `opencode serve` is spawned with `cwd` = task workspace (was inheriting daemon cwd → turn-start git snapshot over ~41 GB home never finished); (5) watchdog excludes `server.heartbeat` keep-alives so stalls become `task.error` in ~2.5 min instead of hanging forever.

## 5. Git Branch & History

- Branch `linux-firefox-ai`, HEAD `52c0373` (Phase 2 commit; parent `7f238d4` = Phase 1, base `b3140a3` = upstream v31)
- Worktrees: `/home/chris/Accomplish` (`main` @ `690b447`, Kujenga source — READ-ONLY), this repo is the migration target
- Nothing pushed/merged/reset. Phase 2 battery was green before each commit. The post-commit live-Firefox failure (§B2) is fixed, regression-tested, and live-verified; its fix commit is on this branch (see `git log`).

## 6. Default-Workspace Fix (post-`52c0373`, committed — 4 files)

`apps/daemon/src/task-service.ts` (default execution workspace resolution + injection), `apps/daemon/__tests__/unit/task-service-parity.test.ts` (+2 tests), `packages/agent-core/tests/unit/opencode/task-manager.test.ts` (real-executeTask working-directory tests replacing inline re-implementation), `docs/DEVELOPMENT_CHECKPOINT.md`. Full battery re-run green immediately before the commit; web integration baseline unchanged (158/61).

## 7. Current Gateway & Daemon Configuration

- Gateway: host pid 74680 on port **37959** (from `~/.local/share/Accomplish/gateway-info.json`); token persisted at `~/.local/share/Accomplish/gateway-token` (0600), stable across restarts
- Daemon: systemd `accomplish-daemon`→`accomplish-fox-daemon.service`, **active + enabled**; env `XDG_DATA_HOME=/home/chris/.local/share/Accomplish`, `ACCOMPLISH_APP_PATH=/home/chris/KujengaAccomplish-AI/apps/desktop`
- Host launch: `node apps/host/dist/index.js --launch` (single-instance aware; re-opens Firefox on the existing gateway)
- Data dir (isolated): `~/.local/share/Accomplish` — never `~/.config/Accomplish` (Electron) or `~/.accomplish`

## 8. Ollama Provider Configuration (verified via RPC)

- `selectedModel: {provider: "ollama", model: "ollama/glm-5.3:cloud"}`
- `connectedProviders.ollama.credentials: {type: "ollama", serverUrl: "http://127.0.0.1:11434"}` — **no API key** (local service)
- Configured via `node apps/host/scripts/setup-dev-provider.mjs --provider ollama --server-url http://127.0.0.1:11434 --model glm-5.3:cloud`
- Local Ollama confirmed working: `ollama run glm-5.3:cloud` (user-verified) and `curl http://127.0.0.1:11434/v1/chat/completions` responds instantly

## 9. Embedded OpenCode Runtime Architecture

- Daemon spawns one `opencode serve --hostname=127.0.0.1 --port=0` **per task** (`apps/daemon/src/opencode/server-manager.ts`), binary resolved from `apps/desktop/node_modules/.bin/opencode` (opencode-ai 1.14.18, arm64-musl)
- Per-task config `<dataDir>/opencode/opencode-<taskId>.json` generated by `task-config-builder.ts` → `generateConfig` (`provider.ollama` = `@ai-sdk/openai-compatible`, `baseURL http://127.0.0.1:11434/v1`, models `glm-5.3:cloud` + `ollama/glm-5.3:cloud`)
- Flow: `session.create` → `event.subscribe` → `session.prompt` → SDK events; permissions via `permission.asked` → WS notification → `permission.respond` RPC
- Model mapping: `normalizeSelectedModelForSdk` (`model-runtime-mapping.ts:106`) strips `ollama/` → `{providerID: 'ollama', modelID: 'glm-5.3:cloud'}`
- Dev bootstrap requirements (all done): `pnpm -F @accomplish/desktop build:mcp-tools:dev` (dev-browser server.mjs), `download:nodejs` (bundled Node v24.15.0 linux-arm64), Playwright chromium downloaded on first task

## 10. Confirmed Bugs & Unresolved Issues

**Fixed (verified):**

1. HashRouter consumed `#token=...` before the shim could read it → early bootstrap
2. `onCloseRequested` throwing stub defeated optional-method presence guards → "Something went wrong" RouteErrorFallback → optional methods now absent (`undefined`), not throwing
3. Module-scope store subscriptions no-op'd without `window.accomplish` → bootstrap installs shim early
4. "OpenCode runtime is not available" → `resolveAppPath()` now points at `apps/desktop` (pnpm links the bin only there)
5. systemd unit written to literal `~` path → `homedir()` fix
6. Snap Firefox cannot access hidden-dir profiles → snap-aware profile path
7. dev-browser server.mjs + bundled Node missing → dev bootstrap commands run
8. `selectedModel.provider` never threaded into TaskConfig → `session.prompt` sent no `model` (fix: `task-service.ts`)
9. `opencode serve` spawned without `cwd` → turn-start VCS snapshot ran `git add --all` over `$HOME` (~41 GB) and blocked the provider call forever (fix: `server-manager.ts` + `OnBeforeStartContext.workingDirectory`)
10. `normalizeSelectedModelForSdk` rewritten: `buildModelParam` now reuses it — previously the full stored ref `ollama/glm-5.3:cloud` was sent verbatim as `modelID` and the provider 404'd (`model "ollama/glm-5.3" not found`)
11. `TaskInactivityWatchdog` defeated by `server.heartbeat` keep-alives resetting its activity counter → hangs never errored (fix: explicit keep-alive exclusion set)
12. **Daemon default task cwd was `homedir()`** (`task-service.ts:150`, upstream since ENG-694): UI tasks without a picked folder resolved to `/home/chris`, so opencode's snapshot swept the whole home tree even after fix #9 (which made the cwd _explicit_). Fix: dedicated default execution workspace `<userDataPath>/task-workspace`, created idempotently at TaskService construction and injected in `startTask` (user-picked folders still override; resume turns resolve the same workspace via the TaskManager fallback) — **the live Firefox failure, now resolved (§B2)**

**Unresolved:** none — AI-task acceptance passed (see §B, §B2).

## 11. Automated Test Results

**After the §B2 default-workspace fix (current):** daemon **196/196** (+2 new: Firefox-exact default-cwd + picked-folder-override) · agent-core **724 pass / 1 pre-existing skip** (working-directory tests now drive the real `TaskManager.executeTask` instead of re-implementing the fallback inline) · typecheck 5/5 · ESLint 0 errors (3 pre-existing warnings) · prettier clean.

**Before the §B2 commit (`52c0373` gate):** host **137/137** · web unit **398/398** · daemon **194/194** · agent-core **724+1skip** · **desktop 494/494** · web integration 158 passed / **61 failed = pre-existing upstream baseline** (zero new failures; identical with changes stashed).

## 12. Manual Verification Results (real machine)

- Firefox renders the UI with **zero client errors** post-fix (verified via `/client-log` diagnostics)
- Onboarding round-trip proof: reset `onboarding_complete=0` via RPC → UI boot set it back to `1`
- Close Firefox → daemon survives; reopen → "Re-using running gateway", WS reconnects
- `.desktop` + scheme: `xdg-mime query default x-scheme-handler/accomplish` → `accomplish-fox.desktop`
- systemd: `is-active`/`is-enabled` = active/enabled; host transparently reconnected when daemon moved to systemd ownership
- AI task via gateway: **PASS** (2026-10-21) — with explicit `/tmp` workspace: `task.complete` success in 16 s; `hello_phase2.txt` exact content; live TCP serve pid ↔ 11434
- **Firefox-replica AI task (§B2): PASS** — `task.start` with `prompt + taskId` ONLY (exactly what the UI sends when no folder is picked); daemon defaults cwd to `~/.local/share/Accomplish/task-workspace` (journal: `ready in 679ms (cwd=/home/chris/.local/share/Accomplish/task-workspace)`; `/proc/<serve-pid>/cwd` confirmed); **no `git ... --work-tree` child process ever appeared** and post-run `ps | grep "work-tree /home/chris"` is empty; live ESTAB to 11434 from the task's own opencode pid; `~/kujenga-test.txt` **created** (empty file — the task prompt specified no content; the agent used `touch` and confirmed "0 bytes" back) with `task.complete status=success` (session `ses_ea07149ffffeAmkowqwwzB9sWC`).

## 13. Important Files & Directories

- Plan: `.opencode/plans/FIREFOX_MIGRATION_PLAN.md`
- Host: `apps/host/src/` — `gateway.ts` (HTTP+WS+security), `host-app.ts`, `daemon-connector.ts`, `firefox-launcher.ts`, `desktop-integration.ts`, `daemon-service.ts`, `file-picker.ts`, `cli-status.ts`, `provider-settings-scrubber.ts`, `config.ts`, `policy.ts`
- Web: `apps/web/src/client/lib/{accomplish-http.ts, gateway-bootstrap.ts, gateway-bootstrap-init.ts, accomplish.ts}`, `main.tsx` (bootstrap import), `App.tsx`, `components/ui/RouteErrorFallback.tsx`
- Daemon/agent-core: `apps/daemon/src/task-config-builder.ts`, `apps/daemon/src/task-service.ts` (model threading), `apps/daemon/src/opencode/server-manager.ts` (serve cwd), `packages/agent-core/src/opencode/{config-generator.ts, config-providers-local.ts, model-runtime-mapping.ts, cli-resolver.ts, cli-path-utils.ts}`, `packages/agent-core/src/internal/classes/OpenCodeAdapter.ts` (`session.prompt` call site ~L486; `buildModelParam` ~L766; watchdog exclusion ~L920)
- Tests: `apps/host/__tests__/`, `apps/web/__tests__/unit/renderer/lib/`
- Operator tooling: `apps/host/scripts/setup-dev-provider.mjs`; test harness `/tmp/opencode/phase2-task-test.mjs` (NON-PERSISTENT — Firefox-replica mode: `task.start` with `prompt` + `taskId` ONLY, no workingDirectory/workspaceId; auto-approves `permission.request` over WS; checks final file + journal cwd + ps/ss evidence)

## 14. Commands to Resume Development

```bash
cd ~/KujengaAccomplish-AI
pnpm install --frozen-lockfile
pnpm -F @accomplish_ai/agent-core build && pnpm -F @accomplish/daemon build && pnpm -F @accomplish/host build && pnpm build:web
pnpm -F @accomplish/desktop build:mcp-tools:dev && pnpm -F @accomplish/desktop download:nodejs   # dev bootstrap (already run)

node apps/host/dist/index.js --launch            # start host + open Firefox (single-instance)
node apps/host/dist/index.js --enable-autostart  # (already installed) systemd daemon at login
node apps/host/scripts/setup-dev-provider.mjs --provider ollama --server-url http://127.0.0.1:11434 --model glm-5.3:cloud

# Tests: pnpm -F @accomplish/host test | pnpm -F @accomplish/web test:unit | pnpm -F @accomplish/daemon test | pnpm -F @accomplish_ai/agent-core test | pnpm -F @accomplish/desktop test
# Battery: pnpm typecheck && pnpm lint:eslint && pnpm format:check
```

## 15. Exact Next Steps to Complete Phase 2

1. ✅ ~~Fix the model-passing hang~~ + the two downstream blockers — done and live-verified (§B)
2. ✅ Full battery (§11) green before the Phase 2 commit (`52c0373`; web integration: 61 pre-existing baseline failures, unchanged)
3. ✅ Phase 2 committed on `linux-firefox-ai` as `52c0373` (never push/merge without approval)
4. ✅ Post-commit live-Firefox default-cwd failure — traced, fixed, regression-tested, live-verified (§B2); full battery re-run green and fix committed (see `git log`)
5. Awaiting user approval before Phase 3
6. Optional manual smoke test from the live Firefox UI (same gateway contract the harness exercises); prompts should specify explicit paths/contents for deterministic results

## 16. Security & Database Isolation Requirements

- Isolated data dir `~/.local/share/Accomplish` only; `XDG_DATA_HOME` scoping keeps opencode credentials inside it
- **Never access** `/home/chris/Accomplish` (read-only worktree), the Electron app's `~/.config/Accomplish`, or production opencode credentials (`~/.local/share/opencode/auth.json`)
- Gateway invariants: loopback bind, token auth (fragment delivery, timing-safe), Host/Origin validation, explicit allowlist (`RPC_METHOD_ALLOWLIST`) + blocklist (`secrets.getApiKey`, `secrets.getAllApiKeys`, `connectors.getTokens`, `connectors.authEntry.read`, `gwsAccount.getToken`, `gwsAccount.refreshNow`), `provider.getSettings` scrubber, per-token rate limiting, CSP + nosniff
- Token files 0600; temp test workspaces under `/tmp/opencode/`

## 17. Known Risks & Technical Decisions

- **No Playwright Firefox build for ubuntu26.04-arm64** — real-Firefox E2E automation deferred; using `/client-log` diagnostics + manual verification instead
- Ollama `glm-5.3:cloud` is cloud-proxied (remote_host ollama.com) — per-token cost; prefer GLM-5.3 Flash for routine dev (see `AI_DEVELOPMENT_WORKFLOW.md`)
- 61 pre-existing web-integration test failures (upstream debt) — do not fix in Phase 2; revisit in Phase 3
- pnpm ≥10 sets `npm_node_execpath` to the pnpm binary — host uses `process.execPath` (Electron connector has the same latent bug)
- Electron app preserved throughout (desktop suite green, separate systemd unit name, no shared paths)
- HashRouter + fragment token is solved by the bootstrap; if the launcher URL scheme changes later, keep bootstrap-first ordering
- Task harness in `/tmp` is non-persistent — checkpoint documents its behavior for recreation
- **Gateway rate limiter is a real flake source in dev:** the shared per-token budget (600/60 s) is consumed by web-UI reconnect floods after every daemon restart — caused 429s for harness pre-flight requests and once rejected a `permission.respond`. Harness tolerates it now; consider a higher daemon-local budget or exempting in-session RPCs in Phase 3
- `resumeSession` turns still don't pass `workingDirectory` — a lazily-respawned runtime on a resumed session inherits the daemon cwd (pre-existing behavior; the common path reuses the existing runtime). Worth threading in Phase 3
- Watchdog keep-alive exclusion is explicit-but-tiny (`server.heartbeat` only); other high-frequency non-progress event types (e.g. `file.watcher.updated`) could still mask stalls
- Ordinary tasks now execute with cwd inside the daemon data dir (`~/.local/share/Accomplish/task-workspace`): agents that write relative-path outputs land there — prompts should use explicit paths (the UI attachment flow already does); snapshot history accumulates only under the per-task opencode snapshot area for this small dir

---

## B. RESOLVED — OpenCode runtime was not executing GLM-5.3:cloud tasks (three stacked causes)

### Verdict (verified end-to-end 2026-10-21; harness PASS in 16 s)

The hang required THREE fixes, discovered in sequence during live verification:

1. **Model reference dropped before the prompt.** `task-service.ts` resolved `selectedModel` (which HAS `.provider`) but copied only `.model` into TaskConfig, so `OpenCodeAdapter.buildModelParam()` returned null and `session.prompt`'s body omitted `model` entirely. At the same time the config's top-level `model` cascade is empty for ollama-only setups (`modelOverride` only fires for vertex/bedrock/commercial builders), so opencode had no model anywhere and never reached the provider. Confirmed after fix 1: SDK session messages carried `model {providerID: 'ollama', modelID: ...}` — opencode 1.14.18 does accept per-prompt `model` (`SessionPromptData.body.model`).
2. **`opencode serve` spawned with no `cwd`.** Session directory defaulted to the daemon's process cwd (`/home/chris`); at turn start opencode ran a pre-turn VCS snapshot (`git add --all --sparse --pathspec-from-file=- --work-tree /home/chris`) that ground at 98% CPU over the ~41 GB home and never finished — the turn loop waits for the snapshot _before_ the provider call, hence zero TCP to 11434 and an indefinite "Waiting for response...". (Also explains the pre-fix task `uq453dc` observation.) Fix: thread `OnBeforeStartContext.workingDirectory` from TaskConfig → adapter → `spawnOpenCodeServer(..., cwd)`; `/proc/<pid>/cwd` now shows the task workspace.
3. **Model ref normalization.** With the loop unblocked, ollama returned `AI_APICallError: model "ollama/glm-5.3" not found` — `config.modelId` carried the storage full ref (`ollama/glm-5.3:cloud`) which was forwarded verbatim. Fix: `buildModelParam` reuses the previously-unused `normalizeSelectedModelForSdk` to send the bare server-known name (`glm-5.3:cloud`); provider id additionally mapped via `PROVIDER_ID_TO_OPENCODE` (identity for ollama; corrects `zai`→`zai-coding-plan` etc.).

**Watchdog secondary fix:** `server.heartbeat` (~1/10 s) was resetting `TaskInactivityWatchdog`'s activity counter on every event, so hangs never degraded to `task.error`. Keep-alives are now excluded; future stalls will surface as task errors in ~2.5 min instead of 15+ min silent hangs.

### Evidence

- Final harness run: `task.start`(prompt+workingDirectory only) → loading/waiting → tool calls (`bash printf 'Accomplish Phase 2 works' > hello_phase2.txt`, `permission.request` auto-approved) → `task.complete status=success` in **16 s**; file content exact match; message rows show `providerId=ollama modelId=ollama/glm-5.3:cloud`.
- `ss -tnp`: ESTAB 127.0.0.1:\* ↔ 127.0.0.1:11434 owned by the task's own opencode pid (both samples).
- `/proc/<serve-pid>/cwd` = `/tmp/opencode/accomplish-phase2-test` at t+3 s and t+25 s; daemon journal: `ready in 710ms (cwd=/tmp/...)`.
- Daemon journal clean during the pass; a 15-min pre-fix task was drained by `systemctl --user restart` (crash-recovery marked it failed).

### H1/H2/H3 outcome

H1 **confirmed** (split into causes 1+3: missing model param + ref format); H2 **disproven** (config generated and typed correctly; provider loads — the earlier "no outbound connections" was the snapshot stall, not a load failure); H3 **disproven as stated then superseded** (the real mismatch was the full-ref vs bare-name format, fixed via `normalizeSelectedModelForSdk`).

### B2. Post-commit live-Firefox failure — default task cwd was the HOME directory — RESOLVED

**Symptom (user report, real Firefox run):** task "Create ~/kujenga-test.txt and confirm its contents." timed out; journal showed `Task runtime ready in 840ms (cwd=/home/chris)`; the opencode child ran `git --git-dir .../opencode/snapshot/global/... --work-tree /home/chris add --all --sparse` at ~97% CPU for minutes; no Ollama connection from the task; no `~/kujenga-test.txt`.

**Verified root cause (full trace):** the Firefox UI intentionally sends `workingDirectory: undefined` when no folder is picked (`useHomePage.ts:19`; gateway + shim are pure pass-throughs — no injection anywhere in apps/host). The daemon itself supplied the home directory: `task-service.ts:150` set `defaultWorkingDirectory: homedir()` (upstream since ENG-694), applied by `TaskManager.ts:349` (`config.workingDirectory || defaultWorkingDirectory`), threaded through `OnBeforeStartContext` into the `opencode serve` spawn cwd. The earlier fix (#9) made the cwd _explicit_ — it faithfully made this latent/default bug deterministic. The successful `/tmp` harness run masked it because it passed an explicit workspace.

**Fix (daemon-owned, 3 files):** dedicated default execution workspace `<userDataPath>/task-workspace` (`/home/chris/.local/share/Accomplish/task-workspace`), created idempotently (mkdirSync recursive, warned non-fatal failure) at TaskService construction; passed as `createTaskManager`'s `defaultWorkingDirectory`; also injected in `startTask` (`params.workingDirectory || default`) so persisted configs always carry an explicit cwd. User-picked folders still override; resume turns resolve the same stable workspace via the TaskManager fallback. No git functionality disabled; agent file tools still reach authorized paths anywhere (absolute paths in prompts/attachments are cwd-independent — `~/kujenga-test.txt` was written by tools regardless of the session cwd). Covers ALL callers (browser UI, Electron desktop, scheduler, WhatsApp bridge, resume). Workspace "tags" concept (workspace-service/storage) intentionally untouched.

**Regression tests:** daemon `task-service-parity.test.ts` — +2: Firefox-exact params (`{prompt, taskId}` only) assert config carries `<userData>/task-workspace` (~-endswith + `!== homedir()`); explicit folder preserved verbatim. agent-core `task-manager.test.ts` — working-directory describe now drives the REAL `TaskManager.executeTask` with a stub adapter (was inline re-implementation).

**Live verification (Firefox-replica harness, one run):** journal `ready in 679ms (cwd=/home/chris/.local/share/Accomplish/task-workspace)`; `/proc/<serve-pid>/cwd` confirmed; **no git child process observed at t+10s/t+20s and no `--work-tree /home/chris` after the run**; ESTAB to 11434 from the task's own opencode pid; `~/kujenga-test.txt` created (empty — prompt specified no content; agent used `touch` then confirmed "0 bytes"); `task.complete status=success`. Daemon **196/196**, agent-core **724+1skip**, typecheck 5/5, ESLint 0 errors, prettier clean.

---

## 18. Phase 3 — M1 Security Foundation (2026-10-21, committed `d644f92`)

Approved scope: `docs/PHASE_3_IMPLEMENTATION_PLAN.md` (Rev. 2) §5 — M1 ONLY. Gateway allowlist **unchanged** (62 entries; tripwire test guards it). No push/merge.

### 18.1 Changes implemented

1. **Interactive UI-presence gate (permission auto-deny fix).** New daemon RPCs `daemon.setClientType('gateway'|'legacy')` + `daemon.setUiPresence({count})`; per-socket-client presence state in agent-core `rpc-server.ts` (client typed `legacy` by default), `hasInteractiveClients()` = any legacy client OR any gateway-reporting client with `count>0` fresh ≤ `STALE_MS` (90 s); daemon probe rewired (`task-callbacks.ts` `InteractivePresenceProbe`; `apps/daemon/src/index.ts:183`). Gateway (`apps/host/src/gateway.ts` + `daemon-connector.ts` + `host-app.ts`): declares identity + reports count on connect AND every reconnect (strictly sequential, 5 s timeout, old-daemon → legacy fallback), counts **authenticated+OPEN** WS clients, reports on every WS open/close, 30 s heartbeat armed on connect / disarmed on disconnect / final 0-count on `gateway.close()`. Deny mechanics unchanged (immediate auto-deny + 5-min in-flight timeout). **No auto-approve**; scheduled/unattended tasks keep prior outcomes (deny without UI, prompt with UI; Electron = legacy client, byte-identical semantics).
2. **Unix socket `chmod 0600`** after listen (`rpc-server.ts` `restrictSocketPermissions`), test-asserted.
3. **Side-service hardening** (tokens via daemon-owned env, never RPC):
   - dev-browser launch server `:9224`: bearer token (`ACCOMPLISH_DEV_BROWSER_TOKEN`, 256-bit, env-seeded, memoized); 401 without token; 403 + explicit JSON for any request bearing an `Origin` (Node-child-only surface);
   - dev-browser relay `/cdp` + `/extension` WS: **first-message auth exchange** `{"type":"auth","token"}` → `auth-ok` / close `4401` (mirrors gateway `/events`; upgrade-header Bearer/`X-CDP-Secret` accepted for `connectOverCDP({headers})`);
   - **Chromium CDP port made ephemeral** (`--remote-debugging-port=0`, discovered via the profile's `DevToolsActivePort` file, endpoint threaded through the unchanged sidecar API; `DEV_BROWSER_CDP_PORT` explicit override keeps legacy fixed port with a loud warning). No fixed unauthenticated external CDP port remains;
   - in-daemon LLM proxies `:9228` (azure-foundry) / `:9229` (moonshot): `x-accomplish-proxy-token` required (Authorization header stays reserved for upstream credentials; proxy-token stripped before forwarding; token cap = 64 concurrent tasks; `/health` remains tokenless by design — readiness only);
   - WhatsApp `:9230`: Origin validation + proper CORS preflight (204 only when token valid AND origin allowed; else 403; replaces bare-204).
4. **Universal response scrubber + log redaction.** `scrubResponse()` now applied to **every** `/rpc` success response (deep, depth 32; `SECRET_FIELD_NAMES` extended to 9: apiKey, secretKey, secretAccessKey, sessionToken, password, refreshToken, accessToken, serviceAccountJson, token; zero (method,field) exceptions — audit found none). Gateway log redaction: outer unhandled-error handler + `/client-log` payloads sanitized via `redactToken()` before truncation; WS-auth/401 paths verified never to log request data.
5. **Electron bridge preservation.** Direct `:9225/json/version` / unauthed `:9224` HTTP calls in desktop preview replaced with daemon RPCs `devBrowser.getPreviewInfo` → `{wsEndpoint|null, pages|null}` and `devBrowser.openPreviewPage({name, viewport})` → `{targetId}|null` (sidecar token **never leaves the daemon**; page-open runs before wsEndpoint fetch because the CDP port exists only after Chrome's lazy launch; desktop's existing graceful-degradation catch semantics unchanged). Desktop never spawns the sidecar (grep-verified).
6. **Dev-browser self-heal:** a stale sidecar (outliving daemon restart) 401s the new token; `ensureDevBrowserServer` detects it, kills the stale listener, relaunches with a fresh token.

### 18.2 Tests performed (all green; full battery)

| Suite        | Result (Δ vs Phase 2)                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent-core   | **782 pass / 1 skip** (59 files; +58 — presence, sidecar-client, service-token, dev-browser-token, proxy-auth, moonshot extensions)                                        |
| daemon       | **230/230** (21 files; +34 — presence-gate 10, dev-browser-service 6, daemon-routes-devbrowser 8 incl. allowlist tripwire, whatsapp-send-api, http-server-factory rewrite) |
| host         | **208/208** (16 files; +71 — gateway-presence 10, response-scrubber 50, gateway-scrub-redaction 9, daemon-connector +2)                                                    |
| web unit     | **398/398** (unchanged)                                                                                                                                                    |
| desktop      | **512/512** (21 files; +18 — browser-preview-utils 12, browserPreview 6; Electron suite green = bridge preserved)                                                          |
| typecheck    | all workspaces Done                                                                                                                                                        |
| lint:eslint  | 0 errors (3 pre-existing warnings in `apps/web/src/client/pages/execution/useExecutionEffects.ts`)                                                                         |
| format:check | clean                                                                                                                                                                      |

Pre-existing failures (NOT introduced by M1, documented separately): **web integration 61** (upstream baseline, suite not exercised — no web changes in M1) · **dev-browser-mcp `integration.test.ts` 1 failed / 28 passed on clean HEAD** (rebrowser-playwright 1.52 removed `page.accessibility.snapshot()`) · lint 3 pre-existing warnings. Also mcp-tools/dev-browser vitest 30 passed + dev-browser-mcp unit 78 passed (run inside their package).

### 18.3 Security findings (M1 audit)

1. **`settings.getAll` legacy-import leak — CLOSED at the gateway.** `legacy-import-service.ts:175` writes electron-store `credentials` JSON into SQLite verbatim, so raw `apiKey` values previously surfaced unscrubbed. Universal scrubber now removes them; **daemon-side strip at import time is the correct root fix → M2 candidate.**
2. **`settings.getCloudBrowserConfig` plaintext `apiKey` by type — CLOSED** by universal scrub.
3. **Blocklist verified gap-free** for the current 62-method surface (7 blocked methods are exactly the plaintext READ paths; `auth.openai.getAccessToken`, `whatsapp.getConfig`, `gwsAccount.list` are not allowlisted).
4. Pre-existing leak paths OUTSIDE the gateway surface (findings only, unchanged): decrypted provider keys in opencode `auth.json` (opencode-native design); `TaskMessage.toolInput` content echo could carry credential-shaped _unkeyed_ strings through key-name-based scrubbing (identical in Electron; content already user-visible in-task); daemon log file has home-path redaction but no token-level sweep (unverified end-to-end); deep-link `mcp-callback` broadcasts OAuth callback URLs to authenticated WS clients (matches Electron behavior, never logged).
5. Relay `/extension` auth is a **breaking change for the companion browser extension** (not in this repo) — it must now send the first-message auth; token distribution to it is an M2 seam.
6. Desktop quit-time sidecar shutdown degraded but non-crashing: Electron's `shutdownDevBrowserServer` sends a non-matching token → 401 → forced port-kill fallback (`:9224` only; orphan Chrome possible). Clean fix = daemon RPC `devBrowser.shutdown` → **M2 candidate**.

### 18.4 Remaining risks

- Presence staleness window: a crashed host delays auto-deny by ≤90 s (by design, heartbeat absent).
- `DEV_BROWSER_CDP_PORT` explicit non-zero override re-opens a fixed unauthenticated loopback CDP port (loud warning; normal daemon flow never sets it).
- LLM-proxy upstream TLS behavior toward real Azure/Moonshot verified only against stub upstreams (no real credentials in this environment) — forwarding path byte-identical except token strip.
- Chrome headful ephemeral-CDP flow verified in headless live probes; headful relies on documented Chromium default (binds 127.0.0.1).
- Gateway rate-limit flake (600/60 s shared budget, checkpoint §17) — scheduled for M4; unchanged in M1.

### 18.5 Git

- M1 implementation: **`d644f92`** (`feat(daemon): UI-presence permission gate and security hardening (Firefox migration phase 3 M1)`) on `linux-firefox-ai`; parent `9ad4b5e`. Nothing pushed/merged; `/home/chris/Accomplish` untouched; Electron bridge green throughout.
- Checkpoint/plan docs committed separately (docs commit follows this one).

---

## 19. Phase 3 — M2 Essential API Functionality (2026-10-22, 8 commits `fcd4cc6`…`fa0e377` + this docs commit)

Approved scope: plan §6 M2 (Rev. 2) — provider/model management → skills/MCP → file attachments → browser automation → remaining essentials, all under the §5.4 expansion policy (every allowlist expansion paired with response-shape docs, scrubber/no-secret proof, 401-authorization tests, redaction tests). M1 protections preserved throughout (blocklist 7 untouched, universal scrubber, log redaction, presence gate, socket 0600). Electron byte-identical: desktop suite green at every gate. No push/merge; `/home/chris/Accomplish` untouched.

### 19.1 Commits (chronological, all verified green before committing)

| Commit    | Task | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fcd4cc6` | T0   | `apps/host/scripts/parity-audit.mjs` + generated `docs/PARITY_INVENTORY.md` — static parity measurer (249 declared ↔ shim ↔ daemon ↔ gateway policy), deterministic, self-checked; baseline: shim 84 functional / 45 no-op / 7 optional-absent / 113 unavailable · allowlist 62 · daemon 129                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `780301f` | T1a  | Daemon provider RPCs: `provider.testConnection`, `provider.fetchModels` (stored-key/OAuth resolution daemon-side), `provider.validateKey`, `secrets.listApiKeys` (masked `{exists,prefix}`); dispatch reuses agent-core provider library (`testOllamaConnection`, `fetchProviderModels`…); `redactProviderError` (exact-substring + pattern); allowlist 62→83; +96 paired tests                                                                                                                                                                                                                                                                                                                                                                                                              |
| `4bd6817` | T1b  | Shim ×42 methods: all provider-config get/set (ollama/litellm/lmstudio/azure-foundry/openai-baseurl), model-discovery (`saveAzureFoundryConfig` mirrors desktop's validate→store→set flow), api-key mgmt (`getApiKeys`/`getAllApiKeys` masked via `listApiKeys`, `setApiKey`/`removeApiKey`/`clearApiKey`→`deleteApiKey('anthropic')` desktop-parity, `validateApiKey(ForProvider)`, bedrock/vertex save via `secrets.storeBedrockCredentials`/`storeApiKey('vertex')` + NEW RPC `provider.validateCredentials {bedrock                                                                                                                                                                                                                                                                      | vertex, credentials}`), provider-settings (`setActiveProvider`, `setConnectedProvider`(request-body secret, one-way),`removeConnectedProvider`, `updateProviderModel`, `get/setProviderDebugMode`, `getConnectedProvider`derived from scrubbed`provider.getSettings`). HuggingFace get/set DEFERRED M6 (documented UI degradation). `getApiKey`/`getBedrockCredentials`/`getVertexCredentials` stay plaintext-blocked (zero UI call sites — no crash path). Allowlist 83→85; detectVertexProject/listVertexProjects → M6. +64 tests                                                                                                                                                                                                                         |
| `6ab738f` | T2   | Skills + connectors: shim `getUserSkillsPath`, `pickSkillFolder` (host zenity reuse), `addSkillFromFolder`→`skills.addFromPath`, `addSkillFromGitHub`→NEW RPC (agent-core `resolveGithubRawUrl`/`addFromUrl` reused — no duplication; https+github-host zod gate), `deleteSkill`→`skills.delete`; connectors CRUD (`connectors.list/upsert/setEnabled/delete`) + `disconnectConnector`→`deleteTokens+setStatus` (audited pure-RPC); **latent-bug fix**: shim `skills.setEnabled/getContent` `{id}`→`{skillId}` (daemon zod schema — first browser toggle would have failed); scrubber +`clientSecret` (DCR `clientRegistration` can ride `connectors.list`); openSkillInEditor/showSkillInFolder + all OAuth methods DEFERRED M6 (UI try/catch-guards confirmed). Allowlist 85→94; ×32 tests |
| `09cea4f` | T3   | File attachments: shim `processDroppedFiles` → authorized `/pick-files` host picker (browser `File` objects cannot reveal paths); `getFilePath` stays loud-unavailable; UI `useExecutionAttachments` re-routes path-less browser drops to the picker ONCE guarded by `!isRunningInElectron()` (Electron path byte-identical); `/pick-files` shape proven 1:1 with `FileAttachmentInfo`. +11 tests                                                                                                                                                                                                                                                                                                                                                                                            |
| `40146e2` | T4   | Browser preview v1: daemon `devBrowser.captureFrame {taskId,pageName?}`→`{data,width,height}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | null`(new minimal daemon CDP-over-WS client on Node-global WebSocket, zero runtime deps; openPreviewPage-first ordering lesson applied) +`devBrowser.shutdown {stopped}`; shim start/stop/status/onBrowserFrame via shim-local 750 ms poll (generation-guarded, 3-miss clientLog breadcrumb; no WS frame notifications in v1); browser-preview panel AUTO-ACTIVATES in Firefox (`useBrowserPreview`guards bind); desktop quit now tries RPC`devBrowser.shutdown` (6 s race) before the unchanged forced-port-kill fallback (M1 18.3.6 closed); allowlist +3 (`openPreviewPage`, `captureFrame`, `shutdown`) — `getPreviewInfo`stays internal (CDP endpoint/token never cross the boundary);`ws` added as daemon devDependency for CDP stub tests. ×46 tests |
| `03658c0` | T5   | M1-finding root fix: legacy import routes electron-store `credentials` into AES-256-GCM secure storage (api keys, bedrock docs, vertex SA docs; skip-if-exists idempotency, live-key clobber protection) and strips all 10 secret-shaped fields from the persisted blob at every depth — `settings.getAll` is clean at the SOURCE now, gateway scrubber = defense-in-depth; `task.stop` allowlisted (98; no new shim method — UI `cancelTask`→`task.cancel`, MCP-flow parity). ×9 tests                                                                                                                                                                                                                                                                                                      |
| `fa0e377` | live | Live-verification fix: `upsertConnector` (agent-core storage) now defaults `created_at`/`updated_at` server-side (`?? now()`) — timestampless connector payloads no longer hit `NOT NULL constraint failed: connectors.created_at`; INSERT-only default, update path and all timestamp-supplying callers byte-identical (every caller audited); +7 tests                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 19.2 Test results (current HEAD, all green · web integration = pre-existing upstream debt)

| Suite        | Result (Δ vs M1)                                                                 |
| ------------ | -------------------------------------------------------------------------------- |
| daemon       | **325/325** (+26 files-inclusive; M2 +95 tests vs M1's 230)                      |
| agent-core   | **785 pass / 1 pre-existing skip** (+3 — connector storage)                      |
| host         | **320/320** (allowlist 98·blocklist-7 tripwire, auth-matrix, scrubber/redaction) |
| web unit     | **485/485** (+87 — shim/hook per-method transport-mock tests)                    |
| desktop      | **522/522** (+10 — quit RPC order; Electron bridge preserved)                    |
| typecheck    | all 5 workspaces ✓                                                               |
| lint:eslint  | 0 errors (3 pre-existing warnings in `useExecutionEffects.ts`)                   |
| format:check | clean                                                                            |
| parity audit | self-checks PASS (incl. shim-call ⊆ allowlist, allowlist ⊆ registered)           |

Pre-existing failures (NOT introduced by M2, documented separately): web integration **61** (upstream baseline; verified identical when M2 stashed) · dev-browser-mcp `integration.test.ts` 1 (rebrowser-playwright regression) · lint 3 warnings.

### 19.3 Live verification (real daemon + built host, 2026-10-22)

Harness `/tmp/opencode/m2-verif.mjs` (non-persistent; gateway HTTP+WS, bearer token from `gateway-info.json`): **21/21 PASS** —

- Security negatives: unauthenticated 401; `secrets.getApiKey`/`getAllApiKeys` still 403.
- Provider: `daemon.ping` · `settings.getOllamaConfig` read (null cfg: ollama config lives in provider settings, interface-consistent) + `setOllamaConfig` null-echo accepted · secret-shape scan clean.
- **`provider.testConnection('ollama', http://127.0.0.1:11434)` → `success:true` + 3 live models** (local ollama).
- `provider.fetchModels('ollama')` → clean `{success:false, models:0}` — correct semantics (UI never calls it for ollama: `useProviderModels` gates on `modelsEndpoint`; ollama models flow via testConnection/config) — recorded, not a defect.
- `secrets.listApiKeys` → masked `{exists,prefix?}` only (plaintext scan clean).
- Skills: `addFromPath(/tmp skill fixture)` → id `custom-demo-skill` → `skills.list` contains it → `skills.delete` cleaned.
- Connectors: upsert (void RPC, client-built row) → list (row carries timestamps) → setEnabled → deleteTokens → delete — **after the `fa0e377` timestamp fix**.
- Browser: `devBrowser.captureFrame` → `null` pre-sidecar (correct) · `devBrowser.shutdown` → `{stopped:false}` (sidecar not running — correct).

**Dev-browser task (M2 acceptance item), Firefox-replica harness `/tmp/opencode/m2-browser-task.mjs`: PASS** — `task.start` with `prompt+taskId` ONLY → permission auto-approve over WS → **`task.complete status=success`** (session `ses_e9c51d8ecffewV17Wwzq7R1VL7`); task rows prove `dev-browser-mcp_browser_navigate` executed: `Navigation successful. URL: https://example.com/ Title: Example Domain Viewport: 1280x720`; agent reported the exact title "Example Domain". The 26-tool dev-browser stack works unchanged from daemon-spawned tasks.

M2 manual-Firefox checklist status: ollama config ✓ (RPC live) · fetch models ✓ (live) · add user skill from folder ✓ (live) · attach file via picker — shape + auth verified, dialog itself interactive-only (zenity needs display/user; pick-folder mechanism live-proven in Phase 2) · dev-browser task ✓ (live).

### 19.4 Remaining risks & deferred (M3+)

- `connectors.upsert` payload is `z.unknown()`: other malformed fields (missing `name`, non-string `url`) can still surface sanitized raw SQLite errors. Timestamp-tolerant, not fully schema-validated — candidate for a full `McpConnector` zod schema in M4/M6 hardening.
- Hostile-path UX degradations (logged, no crash): `getFilePath`/`openSkillInEditor`/`showSkillInFolder` unavailable; HF get/set deferred; OAuth family (connectors/gws/openai/slack/copilot) M6; `getBedrockCredentials`/`getVertexCredentials` null-derive (no UI call sites).
- `devBrowser.shutdown` from an authenticated browser CAN stop the shared sidecar (equivalent surface to `daemon.shutdown`; next task lazily relaunches — self-heal tested).
- `devBrowser.captureFrame` polling is shim-local; closed pages kill timers only via panel unmount (no stream-cleanup hook; v1-accepted).
- Audit-script comments are lexically quote-sensitive (an apostrophe in a §5.4 comment breaks its parser — hardened to be comment-blind in T5).
- daemon tests carry a `ws` devDependency (stub CDP server only; runtime uses Node-global WebSocket).
- Masked-key prefix convention: daemon 4-char (`slice(0,4)`) vs desktop display 8-char+`…` — display-only drift, no consumer today.
- Rate-limit 600/60s shared-budget flake remains scheduled for M4 (untouched in M2).
- `resumeSession` workingDirectory threading still M4.

### 19.5 Parity gate numbers (M2 acceptance)

Provider/model + skills + file-attach + browser-preview domains green per `docs/PARITY_INVENTORY.md`: provider-settings **9/9** · provider-configs **11/11** · model-discovery **15/17** (detectVertexProject/listVertexProjects → M6) · api-keys-secrets **12/15** (3 intentional plaintext-blocked reads) · skills **10/12** (2 editor-launchers → M6) · connectors **6/23** (17 OAuth-family → M6) · file-attachments **3/4** (getFilePath documented-can't-work) · browser-preview **4/6** (navigate/status events → M6+). Totals: implemented **141**, unavailable **60**, optional-absent 3, no-op 45 · allowlist **98** · blocklist **7** · daemon registered **137**.

### 19.6 Git

M2 implementation on `linux-firefox-ai`: `fcd4cc6`·`780301f`·`4bd6817`·`6ab738f`·`09cea4f`·`40146e2`·`03658c0`·`fa0e377` + docs commit. Nothing pushed/merged/reset; `/home/chris/Accomplish` untouched; working tree clean after this commit.

---

## 20. Phase 3 — M3 Wayland Desktop-Control Feasibility (2026-10-22, PLANNING DELIVERABLE — no code, no system changes)

Approved scope: plan §10 — feasibility research ONLY on this Ubuntu 26.04.1 ARM64 (Snapdragon, GNOME Shell 50.1, Wayland) machine; read-only probes; no package installs; no application-source changes; prototype NOT implemented. Full report: **`docs/PHASE_3_M3_WAYLAND_DESKTOP_CONTROL_FEASIBILITY.md`** (§10.2 criteria per technique, live evidence, prototype plan §4–§7, acceptance battery §9).

### 20.1 Verdict

**Desktop control is feasible with ZERO new system packages.** Recommended stack: AT-SPI (targeting/verification — element-aware, live-proven) + XDG portal RemoteDesktop (authorization-bearing input injection; uinput fallback already device-writable via ACL) + portal Screenshot (result verification). Integration sketch: `linux-desktop` MCP package (dev-browser pattern) with a stdio Python helper (`python3-gi` preinstalled) and a new daemon `desktop` permission type (per-action prompt + blocklist + M1 unattended auto-deny). **Disposition: Phase 5B / C3 approval gate together with the inert `settings.sandbox` decision.**

### 20.2 Evidence highlights (all probed live 2026-10-22; full transcripts in report)

1. **Environment prerequisite PASS:** daemon (`accomplish-fox-daemon`, systemd --user) `/proc/<pid>/environ` contains `DBUS_SESSION_BUS_ADDRESS`, `WAYLAND_DISPLAY`, `DISPLAY`, `XDG_SESSION_TYPE=wayland` — daemon-spawned helpers can reach session bus + compositor unchanged.
2. **AT-SPI PASS (live):** registryd running (pid 5349), a11y bus `/run/user/1000/at-spi/bus`; enumeration probe → 8 apps / 4 frames incl. active Terminal; deep probe → named, actionable control tree (`button 'Close' actions=['click']`, menus, page tabs). `python3-gi`/Atspi preinstalled (zero installs). **Finding:** GNOME 50 pygobject text-API signatures mismatched (at-spi2 2.55 churn) → prototype reads text/state via raw D-Bus on the a11y bus (protocol confirmed reachable: `busctl --address=…at-spi/bus` tree walk) or gjs.
3. **Portal PASS:** portal-gnome/-gtk running; `Screenshot` v2, `ScreenCast` v5 (`AvailableSourceTypes=7`, `AvailableCursorModes=7`), `RemoteDesktop` v2 (`AvailableDeviceTypes=7`; full `Notify*` pointer/keyboard/touch + clipboard + `ConnectToEIS`; libei/libeis/libportal/libpipewire present on arm64). Open question: plain-client `Notify*` call-gating (unverifiable read-only) — uinput fallback already validated at device layer.
4. **uinput PARTIAL-PASS:** kernel-builtin module; `/dev/uinput` ACL grants `user:chris:rw-` (O_WRONLY open probe passed, no device created); ydotool absent (install optional, approval-required, not needed).
5. **FAIL/recorded:** `wtype` (mutter lacks `zwp_input_method_v1`) · GNOME Shell `Eval` → `(false,'')` locked · Shell `Screenshot` → `AccessDenied` · `Introspect` not exposed → window mgmt via custom shell extension possible but approval-gated and NOT required for MVP.
6. **Existing capabilities (do-not-rebuild):** OpenCode 1.14.18 has no native-UI surface; `dev-browser-mcp` browser\_\* = Chromium-only (not native desktop); upstream `desktop-control` MCP removed at `05a25bc` — nut.js X11-only not to be revived, but its **design** (15 action types, per-action approval, password-manager blocklist, `needs_planning`, `SKILL.md`, `PermissionDialogDesktopTool.tsx`) is recoverable from git (`git show 05a25bc^:…`).

### 20.3 M3 acceptance

- [x] Feasibility report checked into `docs/` with probe outputs from this machine
- [x] Prototype plan written + dispositioned to separate approval gate (plan §10.3, §12)
- [x] Zero application-source changes / zero system modifications / `/home/chris/Accomplish` untouched / nothing pushed, merged, or committed beyond these docs (docs commit pending user approval)
- [x] Probe tooling non-persistent under `/tmp/opencode/` (`m3-probe-atspi.py`, `m3-probe-atspi-deep.py`, `portal-introspect.txt`)

### 20.4 Next gate

**C3 granted 2026-10-22** — the minimal desktop-control prototype was implemented (§21). Do not start M4 without approval.

---

## 21. C3 Prototype — linux-desktop MCP tool (COMPLETE 2026-10-23, committed this commit)

Approved scope: smallest viable linux-desktop MCP tool (AT-SPI discovery/verification, portal screenshot; NO synthetic input in PoC). Implementation COMPLETE, unit-verified, live-verified on the real machine (Phase-1 driver + Phase-2 full-stack opencode task, both pass), battery green, committed 2026-10-23 in THIS commit (`feat(agent-core): linux-desktop MCP tool prototype (C3 Wayland desktop control)`). `/home/chris/Accomplish` untouched; nothing pushed/merged.

### 21.1 Completed and verified (unit level)

1. **`packages/agent-core/mcp-tools/linux-desktop/`** (NEW, 11 files; `node_modules/` 65 MB + `dist/` 528 KB are build artifacts, not for commit):
   - `scripts/desktop-helper.py` — architect-written, **live-validated** AT-SPI/portal helper (stdlib+`python3-gi`): `list` / `controls --window --max-depth` / `invoke --id --action` / `read --id --start --end` / `screenshot --out`. One-JSON-line stdout contract `{"ok":..}`/`{"ok":false,"error":..}`, exit 0/1. Node ids `a<AppIdx>/f<FrameIdx>/p<i.j.k>` minted per discovery; resolution re-walks (stale ids → "target not found"). GNOME 50 text read via unbound-interface call `Atspi.Text.get_text(acc, start, end)` (proven on terminal); portal screenshot consent timeout 90 s.
   - `src/index.ts` — MCP stdio server (low-level `Server` pattern like start-task), 6 tools (exact names matter for permission keys): `desktop_launch_app` (gio launch, absolute-.desktop validation, blocklist on basename), `desktop_list_windows`, `desktop_find_controls` (default depth 12 — GTK4 nests ~11), `desktop_invoke` (exact-then-substring resolution, ambiguity error, blocklist), `desktop_read` (+ optional `nodeId` for nameless GTK4 display widgets), `desktop_screenshot` (portal consent). Exported `toolHandlers` map (testable); audit log via console.error.
   - `src/blocklist.ts` — lean port of upstream (05a25bc^) list: 1Password/Bitwarden/LastPass/KeePass/Dashlane + Keychain Access/Credential Manager/Windows Security/Registry Editor; `findBlocklistMatch()` case-insensitive substring; applied at launch, discovery, invoke, read (matched against input title + helper-returned window title + application name).
   - `src/helper-exec.ts` — `runDesktopHelper()`: `execFile('python3', …, {timeout 95 s, maxBuffer 4 MiB})`, last-parseable-JSON-line parse, non-zero-exit still honors stdout JSON contract.
   - `src/__tests__/` (26 tests) + `tsconfig.json`/`vitest.config.ts`/`package.json` (npm-installed: @modelcontextprotocol/sdk, zod; devDeps vitest, @types/node) + `README.md` (security model + PoC unsupported-ops list).
2. **Registration + permission wiring** (verified spike, below): `generator-mcp.ts` (+`platform` option; registers `linux-desktop` only on Linux, gmail-mcp-style silent skip if dist missing) · `config-generator.ts` (six `linux-desktop_desktop_*: 'ask'` keys in `ACCOMPLISH_PERMISSION_POLICY` + comment; `platform` threaded into `buildMcpServers`) · `apps/desktop/scripts/bundle-skills.cjs` (+`linux-desktop` entry + `SKILLS_FULLY_BUNDLED`).
3. **Permission spike (the load-bearing discovery):** opencode 1.14.18 raises `permission.asked` for an MCP tool iff the config `permission` block contains the `<serverKey>_<toolName>` key — event shape `{"id":"per_…","permission":"spike-echo_spike_echo","patterns":["*"],"always":["*"],"tool":{messageID,callID}}`; `client.permission.reply({requestID, reply:'once'})` proceeds pending→running→completed. Proven with /tmp spike (`spike-echo.mjs` + `spike-config.json` + `driver.mjs`, ollama glm-5.3:cloud). Existing adapter path handles ANY permission key generically (`type:'tool'`) — **zero daemon/UI changes needed.** Limitation recorded: patterns are `['*']`, so per-target descriptions ride the transcript, not the prompt card.
4. **Test/verification state (final, 2026-10-23):** in-package vitest 26/26 green (re-run after the final prettier pass) · agent-core `config-generator.test.ts`+`generator-mcp.test.ts` 67/67 green · agent-core full suite **791 pass + 1 pre-existing skip** · in-package tsc clean · `pnpm typecheck` 5/5 · `pnpm lint:eslint` 0 errors / 3 pre-existing warnings · `pnpm -F @accomplish/desktop test` 522/522 · `pnpm -F @accomplish/desktop build:mcp-tools:dev` re-bundles linux-desktop (521.8 kb) from the final source · `pnpm format:check` clean (the 3 M3 docs + `src/index.ts` prettier-formatted).

### 21.2 Live demo evidence (real machine, 2026-10-23 post-reboot — both phases PASS)

Environment restored after the reboot: Wayland session + fresh at-spi/portal processes (new pids), daemon env prerequisites unchanged. `/tmp` was cleared → driver/config scripts recreated from the checkpoint description; `/tmp` harness files remain NON-PERSISTENT by design.

**Phase 1 — driver over MCP stdio (`/tmp/opencode/m3c3-poc/driver.mjs`, `StdioClientTransport` + `env: process.env`, per-call timeout 170 s): SUMMARY `blocklist-deny=PASS launch=PASS controls=PASS calc=PASS read=PASS screenshot=AUTH-HOLD`**

1. `desktop_launch_app` on `/tmp/…/1password-stub.desktop` → `Blocked by desktop-control blocklist: 1Password` (deny BEFORE any gio call). PASS.
2. `desktop_launch_app` `/usr/share/applications/org.gnome.Calculator.desktop` → `Launched org.gnome.Calculator.desktop.` (Calculator opened). PASS.
3. `desktop_find_controls` "Calculator" (default depth 12) → **62 controls** incl. full button grid (`button:Backspace C 7 8 9 4 5 6 … ÷ × − + mod % ( ) = Basic`) — deep-button path finally proven live (was 18 at depth 8 pre-fix). PASS.
4. `desktop_invoke` ×5: `C` → `4` → `×` → `5` → `=` — every click OK with per-click resolved node ids (`a7/f0/p0.0.0.0.0.0.1.0.0.0.0.{0,6,17,7,23}`). PASS.
5. `desktop_read` via the nameless display widget's nodeId `a7/f0/p0.0.0.0.0.0.0.1.0.0.0` (role `text`, clipboard actions) → **text="20"** (4 × 5 = 20 verified). PASS.
6. `desktop_screenshot` → portal dialog surfaced; consent not granted within the 90 s helper window → `Response code=None`; recorded **AUTH-HOLD** (authorization-bearing, not a bug — the operator wasn't watching). PASS-as-evidence.

**Phase 2 — full-stack task through a REAL `opencode serve` (`/tmp/opencode/m3c3-poc/fullstack/m3c3-fullstack.mjs`, run twice — both complete in ~140 s):**

- Config generated by the REPO's own `generateConfig` (agent-core dist, `platform:'linux'`, ollama glm-5.3:cloud, `browser:{mode:'none'}`): permission block carries all six `linux-desktop_desktop_*: 'ask'` keys; `mcp['linux-desktop']` registered with the bundled Node bin + `dist/index.mjs`.
- Task flow: `opencode serve` (cwd=workspace, isolated `XDG_DATA_HOME`) → `event.subscribe` → `session.create` (`ses_e96d32883ffefKPkPG4d5687gy`) → `session.prompt({agent:'accomplish', parts:[text], model:{providerID:'ollama', modelID:'glm-5.3:cloud'}})` → **12 × `permission.asked`** (each desktop action individually: 1× list*windows, 1× launch_app, 2× find_controls, 5× invoke, 2× read, 1× screenshot — keys exactly `linux-desktop_desktop*_`, patterns `["_"]`) → each auto-approved via `permission.reply({requestID, reply:'once'})`→ tools executed →`complete-task_complete_task`completed →`session.idle`. ZERO daemon/UI changes — the existing adapter path handled every ask generically, as the spike predicted.
- Agent's own verification (from its transcript): windows enumerated → Calculator launched → controls discovered (node ids for C/4/×/5/=) → clicked in strict order → re-enumerated for FRESH node ids → read the focused nameless display node `a7/f0/p0.0.0.0.0.0.0.1.0.0.0` → **"The Calculator display reads 20 — 4 × 5 = 20 confirmed"** → screenshot attempt reported as a permission consent outcome (denied, portal timeout), no file written. The full four-step C3 demonstration (open → identify → interact → verify) passed with per-action authorization.

### 21.3 REMAINING WORK — none (all items completed 2026-10-23)

1. ✅ Phase-1 driver re-run (recreated after /tmp reboot-clear) — outcomes recorded verbatim in §21.2.
2. ✅ Phase-2 full-stack demo — §21.2 (2 runs, 12 asks each, task completes, verification "20").
3. ✅ Battery re-run at final state — §21.1 item 4 (prettier applied to the 3 docs + `src/index.ts`).
4. ✅ Commit: `packages/agent-core/mcp-tools/linux-desktop/` MINUS `node_modules/`, `dist/`, `package-lock.json` (gitignore covers all three) + `tests/unit/opencode/generator-mcp.test.ts` + 4 modified files + 3 docs — single conventional commit, this commit.
5. ✅ Report to user; **M4 requires separate approval.**

### 21.4 Known notes & caveats for resumption

- MCP SDK in the new package resolved to 1.32.x (`^1.0.0`); ToolResult is a type-alias (SDK index-signature constraint). `tsconfig` adds `"types": ["node"]` (npm-isolated package; no tsc in its own node_modules — check with the repo-level `pnpm exec tsc -p …/linux-desktop/tsconfig.json`).
- `desktop_read` on the GTK4 Calculator display REQUIRES `nodeId` (display widget is nameless); name-based resolution can't reach it. Verify channel: display text node id from find_controls (role `text` with clipboard actions, deep path ~`p0.0.0.0.0.0.0.1.0.0.0`).
- Helper blocks up to 90 s on portal consent; killed client auto-cancels the pending portal request (dialog disappears).
- **Portal-consent vs opencode MCP timeout mismatch (Phase-2 finding):** inside a real task, opencode's MCP client errored the screenshot call at ~60 s (`MCP error -32001: Request timed out`) BEFORE the helper's 90 s consent window elapsed — in-task screenshot consent effectively needs the user to approve quickly. Phase-5B tuning item (raise `experimental.mcp_timeout` per tool, shorten helper window, or surface a "watch for the GNOME dialog" hint in the task prompt).
- Calculator button grid lives at ≤12 depth; default depth changed 8→12 (helper constant + discoverWindow + findControls) — live-proven at 62 controls.
- Environment note (transparency): the FIRST Phase-2 run inherited the default `XDG_DATA_HOME`, so one demo session row landed in opencode's own session store (`~/.local/share/opencode` — opencode-native, no credentials involved); the second run scoped `XDG_DATA_HOME` to the /tmp userdata. Driver scripts now isolate storage by default.
- Reboot kills the session: at-spi/portal processes (`at-spi-bus-launcher` pid 5340 etc.) respawn at next login with fresh pids/sockets — helper does not cache handles across calls (by design). Proven across the 2026-10-22→23 reboot boundary (fresh pids 16986+; no residue).

---

## 22. Phase 3 — M4 Unattended Reliability + Human-Wait State Machine (2026-10-23, commits `43a68ea`, `f40db12`, `0b428de`)

Approved basis: Phase 3 plan §7 (M4) + the M4 approval directive's background-first / human-in-the-loop principles. Plan of record: `docs/PHASE_3_M4_PLAN.md` (Rev. 1; A/B/C separation honored — no silent scope expansion). Scope discipline: (A) approved M4 reliability work + (B) ONLY the minimal human-assistance infrastructure M4 requires; browser-session handoff and the agent-side assistance-request trigger are DESIGNED, NOT IMPLEMENTED (§C of the plan, dispositioned for later approval). M1 security surface untouched: allowlist 98 · blocklist 7 unchanged, scrubber/redaction/presence gate/socket 0600 intact (host suite green incl. tripwires).

### 22.1 What was implemented (A — reliability)

1. **Resume-time working-directory preservation (plan §7.1).** Migration `v032-task-working-directory` (`tasks.working_directory TEXT`, nullable, `CURRENT_VERSION`=32); `Task.workingDirectory?`; `saveTask` + `updateTaskWorkingDirectory`; `startTask` persists the injected cwd on the task row; `resumeSession` cwd resolution = explicit `params.workingDirectory` → the ORIGINAL task's stored `working_directory` → undefined (TaskManager default fallback — pre-migration rows behave exactly as before). `resumeSessionSchema` gained optional `workingDirectory` (additive; the daemon `session.resume` handler passes it through; both UI shims typecheck unchanged). Kills the checkpoint §17 debt item "resumeSession workingDirectory threading still M4": a resumed turn no longer risks (a) re-spawning `opencode serve` with the daemon cwd or (b) losing a user-picked folder.
2. **Extensible watchdog keep-alive set (plan §7.2).** `AdapterOptions.watchdogKeepAliveEventTypes?: ReadonlySet<string>` merged over new defaults `['server.heartbeat', 'file.watcher.updated']` (the §17 "extensible set" item; a second high-frequency no-progress event can no longer mask stalls). `TaskInactivityWatchdog` itself unchanged.
3. **systemd restart policy (plan §7.3) — verified already present, now locked.** Generator + installed unit both carried `Restart=on-failure` + `RestartSec=5`; host regression test now asserts both (`daemon-service.test.ts`), so the fields cannot silently regress. Restart behavior = 5 s respawn → PID-lock reclaim → crash-recovery sweep.
4. **Rate-limiter reliability (plan §7.4, checkpoint §17 flake).** Per-token budget 600 → **1500**/60 s (fixed-window algorithm + keying unchanged; abuse cap retained) + env override `ACCOMPLISH_GATEWAY_RATE_LIMIT` (validated 60..100000, strict integer parse, invalid → default + `[host]` warning). Gateway resolves env only when the caller did not inject explicit options (tests always win). +12 tests incl. the reconnect-flood regression (1000-burst all allowed) and abuse-throttle (limit 5 → 6th throttled).
5. **Correct restart behavior (plan §7.5 / directive §4).** Crash recovery extracted to `apps/daemon/src/crash-recovery.ts` (`recoverStaleTasks`) — semantics: ONLY stale `running` → `failed`; waiting/resuming/terminal rows survive byte-identically. New unit suite (10 seeded statuses) locks this. A `running` row remains the true-orphan signal; a waiting task is preserved with `session_id` + cwd so `session.resume` is the recovery path. Sidecar leak found by the soak and fixed (`0b428de`): daemon `shutdown()` now calls `devBrowserService.shutdown()` (self-healing POST/`port-kill` → `{stopped:false}` when absent) after task drain — previously one dev-browser orphan per daemon lifetime.
6. **30-minute soak — see 22.4.**

### 22.2 What was implemented (B — minimal human-assistance infrastructure)

**State machine (additive, backward-compatible; existing 8 statuses untouched) — `TaskStatus` gains:**

| Status               | Meaning                                                                                                                   | Set by (daemon)                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting_permission` | (existing member, NOW WIREABLE — previously never set at runtime) permission/question prompt delivered to a human surface | `task-callbacks.onPermissionRequest` in BOTH emit branches (interactive-UI, WhatsApp-bridge); auto-deny branches never set it; restore via `sendResponse` |
| `waiting_for_user`   | reserved general human-verification state (CAPTCHA/MFA/passkey); plumbing + UI live, trigger DEFERRED (plan §C1)          | none yet                                                                                                                                                  |
| `resuming`           | transient: resume turn starting on a previously-waiting task                                                              | `resumeSession` when prior status ∈ {`waiting_permission`,`waiting_for_user`} (event + persisted; final status persists at completion as before)          |

Transitions: `waiting_permission` → set on emit-to-human; → restored to `running` when `taskService.sendResponse` completes AND the stored status is a waiting\_\* status (never stomps completion states; auto-deny path unaffected). All three statuses ride the existing `statusChange` → `task.statusChange` RPC notification chain, and the SQLite UPDATE path (statuses are TEXT — no CHECK constraint). UI compatibility (additive only): `task-utils.ts` STATUS_COLORS + `useExecutionActions` active list + `TaskHistory.tsx` exhaustive record gained the two new members; no layout/flow changes, no new locales (header badge degrades via default).

**Watchdog & timeout coverage of human wait (B2):** the watchdog already treats a pending permission/question as non-stall (`sampleWatchdogState` → `inProgress:false` when `pendingRequest !== null`) — human thinking time never fires the 90 s/2.5 min stall machinery; regression-tested. The 5-min in-flight permission timeout (M1 mechanics) and the M1 no-interactive-clients auto-deny (≥90 s-class latency) are unchanged — a waiting task with a live UI stays alive indefinitely without being marked hung.

**Session preservation (B3):** waiting tasks survive daemon restarts with `session_id` + `working_directory` intact (crash-recovery skip + v032) — `session.resume` reuses the SAME opencode session (conversation + browser-session state live in the untouched opencode/sidecar stores); soak-proven end-to-end across mid-task kills.

### 22.3 Test results (HEAD `0b428de`, full battery green)

| Suite                     | Result (Δ vs M3 battery)                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon                    | **344/344** (+19: cwd persistence/resume-threads, `resuming` transitions, `sendResponse` restore + no-overwrite, crash-recovery suite, task-callbacks waiting-parking + auto-deny no-status) |
| agent-core                | **802 pass + 1 pre-existing skip** (+11: v032 migration + round-trips + watchdog exclusion set)                                                                                              |
| host                      | **332/332** (+12: rate-limit flood/abuse/env-override + `Restart=` unit lock)                                                                                                                |
| web unit                  | **488/488** (+3: status-map entries; `FAVORITABLE_STATUSES` guard)                                                                                                                           |
| desktop (Electron bridge) | **522/522** (unchanged — zero desktop code touched)                                                                                                                                          |
| typecheck                 | all 5 workspaces ✓ (incl. additive `resumeSessionSchema` field, no downstream break)                                                                                                         |
| lint:eslint               | 0 errors (3 pre-existing `useExecutionEffects.ts` warnings)                                                                                                                                  |
| format:check              | clean                                                                                                                                                                                        |

Pre-existing failures unchanged (not M4's): web integration 61 (upstream baseline), dev-browser-mcp integration 1 (rebrowser regression), lint 3 warnings. `/home/chris/Accomplish` untouched; nothing pushed/merged.

### 22.4 Soak (30-minute stability test)

Harness `/tmp/opencode/m4-soak/soak.mjs` (non-persistent, cycles ≈ 2 min: isolated daemon on `/tmp/opencode/m4-soak/data`, newline-delimited JSON-RPC 2.0 over `<data>/daemon.sock`, zero production-data contact; per-cycle verdicts in `soak-results.jsonl`, full RPC log `soak.log`). Cycle content: short real ollama task (file write + exact-content assert) · SIGTERM restart → boot-recovery asserts (only `running`→`failed`; synthetic `waiting_permission`/`waiting_for_user`/`resuming` rows survive byte-identically — verified pre-start sqlite seeding + post-boot sqlite compare) · `session.resume` continuity (cwd thread + completion) · every-6th-cycle mid-task kill → `running`→`failed` → resume from captured sessionId → task continues to completion with all step files present.

RESULTS (two formal runs + the 2-cycle builder validation, ~30 min of harness activity total; **ALL PASS**):

| Run                          | Cycles                                                                                   | Wall     | Verdict                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| Builder validation (2-cycle) | 2                                                                                        | ~2 min   | 2/2 PASS                                                             |
| Soak run 1 (`--cycles 12`)   | 12 (incl. mid-task kill @6, waiting-protection @3/7/11)                                  | 10.7 min | 11/12 PASS¹ — cycle 12 mechanically flagged; outcome CORRECT (see ¹) |
| Soak run 2 (`--cycles 14`)   | 14 (incl. mid-task kill @6; @12 task finished before kill window — correctly not forced) | 12.1 min | **14/14 PASS**                                                       |

¹ **Run 1 cycle 12 — graceful drain, not a reliability defect:** the 12-step task was parked in `waiting_permission` when SIGTERM landed; the daemon's drain phase kept the connected client alive long enough for the pending permission to be answered and the task COMPLETED (12/12 files; boot sweep had no `running` row to flip). This is the designed behavior — a waiting task was resolved, not failed — and directly evidences the directive's "waiting tasks are not incorrectly treated as hung or failed." The mechanical verdict flag is a harness expectation artifact (it assumed `running`-at-kill), corrected in run 2's leniency.

Verified across ~30 daemon lifecycle events (starts, 25+ SIGTERM restarts, cleanups):

- **Crash recovery:** ONLY `running` rows flip to `failed` at boot (live + synthetic probes at cycles 3/7/11 in both runs; `waiting_permission`/`waiting_for_user`/`resuming`/terminal rows byte-identical — status, `session_id`, `working_directory` preserved).
- **Mid-task kill + recovery resume (run 1 cycle 6, run 2 cycle 6):** task killed mid-tool-execution → row `running`→`failed` at boot → sessionId captured (proves opencode session store survives the daemon) → `session.resume` continues the SAME opencode session → task completes with ALL step files present (continuity across process death).
- **Resume-time cwd preservation:** every `session.resume` reused the persisted row cwd (`cwdPreservedInRow` true throughout; content-continuity asserted per cycle).
- **Repeated-task durability:** ~30 real ollama tasks completed over both runs; every cycle's short task returned exact file content; run 2 adopted run 1's history rows (`noise` probes read prior tasks' statuses through the SAME sqlite — DB durability across harness runs proven).
- **Sidecar-leak fix (`0b428de`) corroborated:** "soak child leftovers killed: 0" at every final cleanup across both runs (pre-fix validation had observed one leaked dev-browser sidecar).
- Watchdog stall/fire behavior remains unit-verified (watchdog exclusion-set tests); the soak's LLM tasks don't deterministically stall, so no dedicated stall cycle was attempted (documented limitation of the live harness — behavior covered by agent-core regression tests).

### 22.5 Designed but NOT implemented (deferred for later approval — no silent expansion)

- **Agent-triggered assistance (plan §C1):** no agent-callable `request_human_assistance` tool exists; `waiting_for_user` has plumbing/UI/live-but-no-trigger. Two trigger designs recorded in the plan (daemon-side tool-name watcher vs. opencode question flow) awaiting milestone approval (proposed for M5 alongside E2E work).
- **Browser-session handoff (plan §C2):** constraints documented (SAME sidecar profile required — a different browser profile would not carry the verification challenge; task must pause safely first; daemon RPC + shim + allowlist expansion per §5.4 policy when implemented). Phase 5/5B or M6 candidate.
- **Unattended authorization seam** (`task.permissions.untrusted`-class flags): still the documented Stage-2 extension-point only (plan §5.2.6); no auto-approve introduced anywhere.

### 22.6 Next gate

**M5 (E2E testing, plan §8) requires separate approval.** Soak evidence complete; the deferred designs in §22.5 are ready to be reviewed as part of that approval. Nothing pushed/merged; no M5 work started.

---

## 23. Phase 3 — M5 E2E Testing + Verification Closeout (2026-10-23, COMPLETE, commits `c505e74`…`bbaa5b7` + this docs commit)

Approved basis: Phase 3 plan §8 + `docs/PHASE_3_M5_PLAN.md` Rev. 1 (`a959ce7`) — a **verification-and-harness milestone**: no feature changes, no permission weakening, no deferred-designs implementation. Two test-enabling changes explicitly justified in the plan §3 (dev-browser relay-port env override with unchanged default; test-only `ariaSnapshot` repair). Session discipline: task handoff in `docs/M5_REMAINING_TASKS.md` (T1–T8), investigation record in `docs/M5_DEBUG_CHECKPOINT.md` §1.A–§1.G. `/home/chris/Accomplish` untouched; production daemon (systemd pid 3945) never restarted; nothing pushed/merged.

### 23.1 What was delivered (T1–T7; all acceptances met, evidence in the debug checkpoint)

| #      | Deliverable                                                                                                                                                                                                                                                                                    | Code commits          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-T1 | dev-browser relay-port override `ACCOMPLISH_DEV_BROWSER_RELAY_PORT` (default 9224 unchanged) + dev-browser-mcp `ariaSnapshot` repair + verification harness                                                                                                                                    | `c505e74`             | agent-core 807+1skip · daemon 345 · dev-browser-mcp **111/111** (was 1 failed) · harness PASS 16/16                                                                                                                                                                                                                                                                                                                                      |
| T1+T2  | **Gateway E2E Playwright suite committed** (`apps/host/e2e/`: fixtures + 10 specs) WITH the `90-secrets-redaction` serial-chain flake fixes (interceptor-vs-teardown drain; rate-window-spanning 429 retries; `expect.poll` seeding/restore) — test-only, redaction assertions' core unchanged | `96a3fbe`             | **14/14 PASS twice consecutively** (2:38.7 / 3:20.5) + standalone 90-run green + T6 re-run 14/14 (3.1 m) · typecheck 5/5 · lint/format clean                                                                                                                                                                                                                                                                                             |
| T3     | M4 soak recheck at final HEAD (harness recreated from §22.4 semantics) — no code                                                                                                                                                                                                               | none (docs `a709b19`) | builder 2/2 + formal **6/6 PASS** (166 s) · every SIGTERM sweep 0 · prod pid 3945 invariant                                                                                                                                                                                                                                                                                                                                              |
| T4     | M3/C3 linux-desktop MCP recheck at final HEAD (driver recreated from §21.2) — no code                                                                                                                                                                                                          | none (docs `d9b1af8`) | `blocklist-deny=PASS list_windows=PASS launch=PASS controls=PASS calc=PASS read=PASS` — 62 controls, "20" display verified; screenshot EXCLUDED (portal consent = T7/O1)                                                                                                                                                                                                                                                                 |
| T5     | ARM64 compatibility evidence bundle — no code, no fixes (this machine is the ARM64 target)                                                                                                                                                                                                     | none (docs `dbbdc1f`) | all suites native on aarch64 (`uname -m` = aarch64; no emulators; bundled linux-arm64 Node v24.15.0 + opencode arm64 ELF + chromium-1248 aarch64 all live-proven) — debug checkpoint §1.E                                                                                                                                                                                                                                                |
| T6     | Full regression battery at final HEAD — no code                                                                                                                                                                                                                                                | none (docs `68a5325`) | typecheck 5/5 · lint 0E/3W · prettier clean · host 332 · daemon 345 · agent-core 807+1skip · web unit 488 · desktop 522 · web integration 158/61 = exact upstream baseline · gateway E2E 14/14 (3.1 m) — debug checkpoint §1.F                                                                                                                                                                                                           |
| T7     | Manual Firefox acceptance executed WITH the user (`docs/PHASE_3_M5_MANUAL_FIREFOX_CHECKLIST.md`) + three real client-side bugs found, fixed, retested by the user (detail: debug checkpoint §1.G)                                                                                              | `0f1c647`, `dda0077`  | (1) `getAccomplish()` identity churn → ~2,000 RPC/10 s refetch storms → gateway 429s (memoized API surfaces; +3 tests); (2) web `vite build` broken at HEAD (`sanitizeString`/`validateHttpUrl` missing from the browser-safe `common.ts` barrel; re-exported, dist rebuilt); (3) dev-browser sidecar headed-by-default fails display-less (`resolveHeadlessFromEnv()` — display-aware default, `HEADLESS` override preserved; +7 tests) |

### 23.2 Suite counts at M5 close (final HEAD `bbaa5b7`; doc-only commits since the T6 code state)

| Suite           | Result                                                                                                                          | Δ vs baseline                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| typecheck       | 5/5 workspaces                                                                                                                  | unchanged                                                         |
| lint:eslint     | 0 errors + exactly the 3 pre-existing `useExecutionEffects.ts` warnings                                                         | unchanged                                                         |
| format:check    | clean                                                                                                                           | unchanged                                                         |
| host unit       | **332/332** (16 files)                                                                                                          | baseline 332 (E2E suite not counted; separate Playwright command) |
| daemon unit     | **345/345** (27 files)                                                                                                          | baseline 345                                                      |
| agent-core      | **807 pass + 1 skip** (63 files)                                                                                                | baseline 807+1skip                                                |
| web unit        | **491/491** (30 files)                                                                                                          | 488 baseline + 3 T7 identity-cache tests                          |
| desktop unit    | **522/522** (23 files)                                                                                                          | baseline 522 (Electron bridge green throughout)                   |
| web integration | 158 pass / **61 fail = exact documented upstream baseline** (Phase 2 debt; distribution taskStore 52 / Home 8 / TaskLauncher 1) | zero new failures                                                 |
| gateway E2E     | **14/14** (10 specs, serial, real ollama tasks, native aarch64 Chromium)                                                        | new in M5; green 3 consecutive full runs                          |
| dev-browser-mcp | **111/111** in-package (was 1 failing)                                                                                          | repaired (`ariaSnapshot`)                                         |

### 23.3 Harness evidence banked (recreate-on-demand; `/tmp` harnesses non-persistent by design)

- **Gateway E2E:** 3 full-suite green runs total (2 at T1, 1 at T6, 3.1 m) — real ollama tasks incl. permission Allow/Deny from the UI, file-exact asserts, presence auto-deny in ~11 s on a disconnected client, 401/403 auth matrix, rate burst (1000 fast requests unthrottled), redaction interception, settings/provider round-trips, history.
- **Dev-browser verification harness** `/tmp/opencode/m5-verif/m5-browser-verif.mjs` PASS **16/16** (226 s): lazy sidecar lifecycle, two live navigation tasks on distinct real pages (IANA — note: example.com no longer serves `<h1>`), port-override isolation (9324), captureFrame 1280×720 mid-session, SIGTERM 0 orphans, lazy relaunch, explicit shutdown.
- **M4 soak recheck 6/6** (§1.C): boot-recovery asserts byte-identical waiting rows, `session.resume` continuity, cycle-6 mid-task SIGKILL → failed flip → same-session resume → 5/5 step files.
- **linux-desktop driver ALL-PASS** (§1.D): §21.2 parity incl. live M1 blocklist deny before any `gio` call.
- **ARM64 bundle** (§1.E): everything this milestone ran natively on aarch64; other-platform bundles are present on disk by design and never selected here.

### 23.4 Manual Firefox checklist result (executed one item at a time with the user; nothing unperformed is claimed passed)

**FINAL: H1–H9, H11 PASS · H10 PASS for navigation + page extraction · O1 (portal-screenshot consent) SKIPPED by the user — the M3 AUTH-HOLD carries over explicitly.** Highlights: zero client errors via `/client-log` (channel proven live); permission **Allow** byte-verified (`M5_T7_ALLOW_OK`); **Deny** verified including on a resumed session (bonus find); streaming, history, provider/model set from the real UI (after fix 1), native GTK folder + file pickers, dev-browser task Completed with live-page content ("About IANA", after fix 3), `accomplish://` deep-link probes. Full per-item statuses + user confirmations: `docs/PHASE_3_M5_MANUAL_FIREFOX_CHECKLIST.md`.

### 23.5 Known limitations — explicitly unresolved (do NOT silently mark fixed)

| #   | Limitation                                                                                                                                                                                                                            | Disposition                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | **Browser preview panel renders blank**: frames generated + delivered server-side, but `openPreviewPage` captures its own `${taskId}-main` tab while agent tools drive a separate relay/CDP tab (preview-page-vs-agent-page seam)     | **Unresolved** (user directive); M6 design item + manual re-verification required; see recommendations §2 |
| 2   | Token-fragment gateway URL written to the journald user journal by `.desktop` launcher launches (pre-M5 `logger.info(app.appUrl)` behavior)                                                                                           | Recorded at the user's explicit directive (T7); future redaction fix requires design (recommendations §5) |
| 3   | dev-browser in-package `relay.test.ts` first-message-exchange flake in full-suite parallel runs (passes in isolation; identical with fixes stashed) + 3 in-package tsc-noise files outside the repo typecheck surface                 | Pre-existing, in-package only; not part of the M5 baselines — record only                                 |
| 4   | Web integration 61 failures (taskStore 52 / Home 8 / TaskLauncher 1)                                                                                                                                                                  | Established upstream baseline (identical since Phase 2, with M-work stashed) — do not fix here            |
| 5   | Desktop docker E2E runnable only under Docker (absent on this machine)                                                                                                                                                                | Environment-blocked, not a code defect — record only                                                      |
| 6   | Lint: 3 pre-existing `useExecutionEffects.ts` warnings; `50-task-deny`/`60-history` E2E one-offs observed once under cold-model load (§1.B), green in every run since                                                                 | Do-not-touch / watch items                                                                                |
| 7   | Desktop `stopDevBrowserServer` port-kill fallback still uses the raw 9224 constant (desktop never runs in the isolated-instance scenario)                                                                                             | Recorded residual, out of M5 scope                                                                        |
| 8   | UI polish notes from T7: ModelIndicator's 2 s per-instance poll (harmless vs the 1500/60 s budget; a shared poll would remove the fan-out); provider re-select needed for the fresh model list to render after the Refresh flow works | M6 candidates; functional behavior verified working                                                       |
| 9   | Real-Firefox automated E2E remains impossible before Phase 5 BiDi (no Playwright Firefox build for Ubuntu 26.04 ARM64) — real-Firefox behavior covered by the manual checklist only                                                   | Structural constraint, by design (plan §2)                                                                |

### 23.6 Security posture (unchanged by M5 + two explicitly justified test-enabling changes)

- M1/M2/M4 protect surfaces intact through the whole battery: allowlist **98** / blocklist **7** with tripwires, universal scrubber + `/client-log` redaction, presence gate + auto-deny, socket 0600, side-service bearer tokens (relay/CDP, LLM proxies, WhatsApp), systemd `Restart=on-failure` lock. The E2E battery itself re-proves 401/403/WS-auth + redaction live (§1.F).
- No policy edits, no new grants, no auto-approve anywhere; the sidecar token isolation was honored even during T7 debugging (direct page-list probing abandoned rather than extracting the sidecar token from the daemon environ).
- The §3-justified test-enabling changes: `ACCOMPLISH_DEV_BROWSER_RELAY_PORT` (default 9224 byte-identical; isolation seam mirroring the M1 CDP-port override) and the dev-browser-mcp `ariaSnapshot` test repair (rebrowser 1.64 removed `page.accessibility`; production code never used it).

### 23.7 Git — M5 commits (chronological, on `linux-firefox-ai`; nothing pushed/merged)

| Commit    | Content                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `a959ce7` | docs: M5 implementation plan                                                             |
| `c505e74` | fix: dev-browser relay-port override + dev-browser-mcp integration repair (17 files)     |
| `e9bd129` | docs: M5 debug checkpoint (developer-session handover)                                   |
| `645c023` | docs: M5 task handoff plan (T1–T8 queue)                                                 |
| `96a3fbe` | test(host): gateway E2E suite + T1 redaction-flake fixes                                 |
| `e6c2400` | docs: T1 complete                                                                        |
| `a709b19` | docs: T3 soak recheck complete                                                           |
| `d9b1af8` | docs: T4 linux-desktop recheck complete                                                  |
| `dbbdc1f` | docs: T5 ARM64 evidence bundle complete                                                  |
| `68a5325` | docs: T6 regression battery complete                                                     |
| `0f1c647` | fix(web,agent-core): getAccomplish identity + browser-safe barrel exports (T7 bugs 1+2)  |
| `408fd56` | docs: T7 manual checklist H1–H7 record                                                   |
| `dda0077` | fix(agent-core): display-aware sidecar headless default (T7 bug 3)                       |
| `bbaa5b7` | docs: T7 closeout (H8–H11, O1 skipped; battery at closeout)                              |
| (this)    | docs: T8 checkpoint §23 + plan status + deferred-designs recommendations — **M5 closed** |

### 23.8 Next gate

**M5 is closed. M6 requires the user's separate approval** (plan §13). Deferred-designs disposition + a concrete next-milestone proposal (M6-A human-assistance loop v1 / M6-B remaining parity): `docs/PHASE_3_M5_DEFERRED_DESIGNS_RECOMMENDATIONS.md`. STOP after M5 — no M6/M7 work has started; nothing pushed/merged.
