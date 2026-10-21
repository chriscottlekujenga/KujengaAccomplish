# Development Checkpoint — Firefox Migration, Phase 2

**Date:** 2026-10-21 · **Repo:** `~/KujengaAccomplish-AI` · **Branch:** `linux-firefox-ai` · **HEAD:** `7f238d4`
**Status:** Phase 2 complete — AI-task acceptance PASSED (see §B). Uncommitted; commit awaits battery + user approval (§15).

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

| Phase | Scope                                                                                              | Status                                            |
| ----- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1     | Browser gateway foundation (host, connector, shim)                                                 | ✅ committed `7f238d4`                            |
| 2     | Ubuntu ARM64 shell (launcher, .desktop, systemd, pickers, deep links)                              | ✅ done + AI-task acceptance PASSED (uncommitted) |
| 3     | Full API parity + hardening + Firefox E2E harness                                                  | not started                                       |
| 4     | Kujenga feature port (SFTP, WordPress, orchestration, messaging, renaming) from `main` @ `690b447` | not started                                       |
| 5     | Firefox WebDriver BiDi automation backend (port from `backup-arm64-bidi` @ `be1415e`)              | not started                                       |
| 6     | Packaging (deb/AppImage arm64), updater, Electron retirement                                       | not started                                       |

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

- Branch `linux-firefox-ai`, HEAD `7f238d4` (Phase 1), base `b3140a3` (upstream v31)
- Worktrees: `/home/chris/Accomplish` (`main` @ `690b447`, Kujenga source — READ-ONLY), this repo is the migration target
- Nothing pushed/merged. Phase 2 is committed on this branch in a single commit (see `git log`); the pre-commit battery (§11) was green at commit time.

## 6. Uncommitted Changes (49 entries: 29 modified, 20 untracked)

Modified: app+daemon fixes above plus prior-session files — `apps/daemon/src/{task-service.ts, opencode/server-manager.ts}`, `apps/daemon/__tests__/unit/task-service-parity.test.ts`, `packages/agent-core/src/{internal/classes/OpenCodeAdapter.ts, types/task-manager.ts}`, `packages/agent-core/tests/unit/internal/classes/{opencode-adapter-agent-selection,opencode-adapter-watchdog}.unit.test.ts`, `apps/host/src/{gateway,host-app,config,policy,daemon-connector,index}.ts`, `apps/web/src/client/{main.tsx,App.tsx,lib/accomplish-http.ts}`, `apps/web/locales/*/errors.json`, `eslint.config.mjs`, `package.json`, `pnpm-lock.yaml`, web/host test files.
Untracked: `apps/host/{scripts,src/cli-status.ts,src/provider-settings-scrubber.ts}` + Phase 2 test files, `apps/web/src/client/lib/gateway-bootstrap*.ts`, `.opencode/`.
Not included/excluded: no credentials, no DB files, no logs, no build artifacts (`dist/`, `node_modules/`, Playwright/browser caches are gitignored).

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

**Unresolved:** none — AI-task acceptance passed (see §B).

## 11. Automated Test Results

**Re-verified after the §B fixes (this session):** daemon **194/194** (+2 new) · agent-core **724 pass / 1 pre-existing skip** (+4 new) · typecheck 5/5 workspaces · ESLint 0 errors (3 pre-existing warnings) · prettier clean (6 stale pre-session files reformatted).

**From the prior session (unchanged areas, still valid):** host: **137/137** (13 files, incl. real-daemon integration) · web unit: **398/398** (28 files) · **desktop (Electron regression): 494/494** · web integration: 158 passed / **61 failed = pre-existing upstream baseline** (identical with changes stashed; mocks lack daemon-lifecycle methods; zero new failures). Re-run host/web/desktop suites before the Phase 2 commit as the final gate (§15).

## 12. Manual Verification Results (real machine)

- Firefox renders the UI with **zero client errors** post-fix (verified via `/client-log` diagnostics)
- Onboarding round-trip proof: reset `onboarding_complete=0` via RPC → UI boot set it back to `1`
- Close Firefox → daemon survives; reopen → "Re-using running gateway", WS reconnects
- `.desktop` + scheme: `xdg-mime query default x-scheme-handler/accomplish` → `accomplish-fox.desktop`
- systemd: `is-active`/`is-enabled` = active/enabled; host transparently reconnected when daemon moved to systemd ownership
- AI task via gateway: **PASS** (2026-10-21) — `task.start` with prompt + workingDirectory only; daemon picks the storage selected model itself (ollama / glm-5.3:cloud); permission.request auto-approved; `task.complete` `{"status":"success",...}` in 16 s; `hello_phase2.txt` content exact; `ss` showed ESTAB pairs from the task's own opencode serve pid ↔ 127.0.0.1:11434; serve `/proc/<pid>/cwd` = the task workspace; 60 s idle cleanup reclaimed the serve. Remaining: one manual smoke test from a live Firefox UI (same gateway contract; §15).

## 13. Important Files & Directories

- Plan: `.opencode/plans/FIREFOX_MIGRATION_PLAN.md`
- Host: `apps/host/src/` — `gateway.ts` (HTTP+WS+security), `host-app.ts`, `daemon-connector.ts`, `firefox-launcher.ts`, `desktop-integration.ts`, `daemon-service.ts`, `file-picker.ts`, `cli-status.ts`, `provider-settings-scrubber.ts`, `config.ts`, `policy.ts`
- Web: `apps/web/src/client/lib/{accomplish-http.ts, gateway-bootstrap.ts, gateway-bootstrap-init.ts, accomplish.ts}`, `main.tsx` (bootstrap import), `App.tsx`, `components/ui/RouteErrorFallback.tsx`
- Daemon/agent-core: `apps/daemon/src/task-config-builder.ts`, `apps/daemon/src/task-service.ts` (model threading), `apps/daemon/src/opencode/server-manager.ts` (serve cwd), `packages/agent-core/src/opencode/{config-generator.ts, config-providers-local.ts, model-runtime-mapping.ts, cli-resolver.ts, cli-path-utils.ts}`, `packages/agent-core/src/internal/classes/OpenCodeAdapter.ts` (`session.prompt` call site ~L486; `buildModelParam` ~L766; watchdog exclusion ~L920)
- Tests: `apps/host/__tests__/`, `apps/web/__tests__/unit/renderer/lib/`
- Operator tooling: `apps/host/scripts/setup-dev-provider.mjs`; test harness `/tmp/opencode/phase2-task-test.mjs` (NON-PERSISTENT — recreate from §15)

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
2. Optional manual smoke test: launch Firefox via `node apps/host/dist/index.js --launch`, send one simple task from the UI, confirm completion + history restore (same gateway contract the harness exercises)
3. ✅ Full battery (§11) re-run green before the Phase 2 commit (web integration: 61 pre-existing baseline failures, unchanged)
4. ✅ Phase 2 committed on `linux-firefox-ai` (never push/merge without approval)
5. Awaiting user approval before Phase 3

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
