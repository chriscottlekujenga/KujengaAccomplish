# FIREFOX MIGRATION PLAN — KujengaAccomplish

**Project:** Migrate Accomplish from an Electron desktop app to a Firefox-based Linux application on Ubuntu ARM64.
**Status:** Phase 1 (Architecture Audit) complete — awaiting approval before implementation.
**Date:** 2026-10-20
**Approved architecture:** Host-process gateway (thin Node shell host + stock Firefox UI + unchanged daemon).

**Scope guarantees honored during this audit:**

- No application source code modified; no dependencies installed.
- Original repository `/home/chris/Accomplish` examined read-only (git commands and file reads only).
- No application databases or credentials accessed.

---

## 1. Executive Summary

The migration is far less risky than a typical Electron port because the hard work already happened upstream: **the daemon (task execution, SQLite, secure storage, `opencode serve` spawning, MCP tools, scheduler, WhatsApp) is a standalone Electron-free Node process**, and the Electron app has already been reduced to a thin UI shell (~205 preload methods proxying ~180 IPC channels to the daemon over a Unix-socket JSON-RPC). The web UI is a pure React/Vite bundle.

The migration therefore consists of:

1. Replacing the **Electron shell** with a thin Node **host process** (`apps/host`) that serves the web UI over loopback HTTP, proxies JSON-RPC to the existing daemon socket, streams daemon notifications over WebSocket, and provides Linux OS integration (launcher, scheme handler, dialogs, autostart, xdg-open).
2. Pointing **Firefox** (stock snap/deb, dedicated profile) at the host's local URL — replacing `BrowserWindow`.
3. Adding a **browser API shim** in the web app so `getAccomplish()` falls back from `window.accomplish` to the HTTP transport, leaving all Zustand stores unchanged.
4. **Porting the Kujenga custom features** (SFTP, WordPress, project orchestration, task messaging, task renaming, expert autonomy, model routing, ARM64 fixes) from `/home/chris/Accomplish` HEAD — this target repo is a clean upstream clone and contains none of them.
5. Adopting the existing **Firefox WebDriver BiDi** browser-automation backend from the Kujenga fork (already written, tested there, and Electron-independent).

Target platform: **Ubuntu ARM64 (aarch64)** — matches the current dev machine. ARM64 packaging scaffolding (bundled Node linux-arm64 downloads, per-arch `better-sqlite3` staging, native ABI checks) already exists.

---

## 2. Repository State

|                  | `KujengaAccomplish-AI` (target)                                                                             | `/home/chris/Accomplish` (source)                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Base             | Upstream `AndersHsueh/Accomplish` @ `b3140a3` (post daemon migration, post SDK cutover, daemon-only-SQLite) | Kujenga fork @ `690b447` ("Add expert prompt-defined autonomy mode", 2026-10-15)                                                           |
| Remotes          | `origin` = `chriscottlekujenga/KujengaAccomplish`, `upstream` = `AndersHsueh/Accomplish`                    | Same fork remotes                                                                                                                          |
| Kujenga features | **None present** (verified via repo-wide search)                                                            | All present at HEAD; **working tree is mid-merge with upstream v31** (626 staged entries; Kujenga daemon-side wiring partially re-applied) |

**Critical sourcing rule:** port Kujenga features from the fork's **committed HEAD (`690b447`)**, not its dirty working tree — the v31 re-application there is incomplete (only `projectMode` type, `SftpSite` export, and `handleSendMessage` were re-applied at time of audit; daemon/agent-core wiring for `task.send`, `task.rename`, project mode, and SFTP generator/storage is still at the upstream v31 state in the working tree).

Fork branches of interest: `linux-firefox-ai` (current), `backup-before-upstream-v31-20261015-163523`, `backup-arm64-bidi`. Backups of pre-BiDi files live in `/home/chris/Accomplish/.firefox-bidi-backups/20261010-171457/` (server.ts, connection.ts, browser-manager.ts, package.json, pnpm-lock snapshot).

---

## 3. Electron Dependencies Requiring Replacement

### 3.1 Package-level dependencies

| Package                                          | Electron dependency                                                                                                                                                                                                    | Disposition                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/desktop`                                   | `electron ^41.0.2` (dev), `electron-builder ^25.1.8` (dev), `vite-plugin-electron ^0.29.1` (dev), `electron-store ^8.2.0`, `electron-updater ^6.7.3`, `@sentry/electron ^7.8.0`, `@playwright/test` (uses `_electron`) | Replaced by host process + new packaging; `apps/desktop` retired in Migration Phase 6 |
| `packages/agent-core`, `apps/daemon`, `apps/web` | **None** (verified zero `electron` imports; agent-core isolates platform specifics behind a `PlatformConfig` object)                                                                                                   | No change                                                                             |
| Root `package.json`                              | Stale `@electron/rebuild>node-gyp` override; `electron` in `onlyBuiltDependencies`                                                                                                                                     | Cleanup in Phase 6                                                                    |

### 3.2 Electron API usage inventory (`apps/desktop/src/main`)

| Electron API                                                                                                           | Purpose                                                                                                                                            | Replacement                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserWindow` + preload `contextBridge`/`ipcRenderer`                                                                | Hosts React UI; exposes `window.accomplish` (~205 methods + 8 `gws` + 38 `analytics`, 27 push-event subscriptions; ~180 `ipcMain.handle` channels) | Firefox window at `http://127.0.0.1:<port>/#token=...` + browser shim implementing the same `AccomplishAPI` interface over HTTP/WS (same-origin)                            |
| `ipcMain.handle` (all handlers)                                                                                        | Thin proxies to daemon RPC                                                                                                                         | Host `/rpc` endpoint → `DaemonClient.call()` (reuses `@accomplish_ai/agent-core/desktop-main`, which is Electron-free)                                                      |
| `webContents.send` (notification forwarding)                                                                           | Daemon notifications → renderer                                                                                                                    | WebSocket `/events` endpoint (host forwards `rpc.notify()` broadcasts)                                                                                                      |
| `Tray`, `Menu`                                                                                                         | Linux tray (task count, Show/Quit), app menu                                                                                                       | DBus StatusNotifierItem in host (optional, deferrable — daemon already survives window close)                                                                               |
| `shell.openExternal` (16 sites: OAuth consent, docs), `shell.openPath/showItemInFolder`                                | External URLs, reveal files                                                                                                                        | `xdg-open` from host; DBus `org.freedesktop.FileManager1.ShowItems`                                                                                                         |
| `dialog.showMessageBox/OpenDialog/SaveDialog`                                                                          | Error modals, file/folder pickers, save-as                                                                                                         | `zenity`/GTK chooser from host; error modals move in-UI (close-confirm dialog already in-renderer)                                                                          |
| `app.setAsDefaultProtocolClient('accomplish://')`                                                                      | Deep links (OAuth callbacks)                                                                                                                       | `.desktop` with `x-scheme-handler/accomplish` + `xdg-mime`; host routes URLs                                                                                                |
| `app.requestSingleInstanceLock`                                                                                        | Single instance                                                                                                                                    | Lockfile/DBus well-known name in host                                                                                                                                       |
| `app.getPath/setPath` (userData et al.)                                                                                | Data paths (~23 call sites)                                                                                                                        | XDG path module in host (`~/.local/share/Accomplish`); daemon `--data-dir` contract unchanged                                                                               |
| `process.resourcesPath`                                                                                                | Locate `web-ui/`, `nodejs/`, `daemon/`, icons                                                                                                      | Configurable install/resources dir                                                                                                                                          |
| `app.isPackaged` (33 uses)                                                                                             | Dev vs prod behavior                                                                                                                               | Env var in host                                                                                                                                                             |
| `app.getLoginItemSettings/setLoginItemSettings`                                                                        | Start-at-login (Windows branch)                                                                                                                    | Linux already uses **systemd user unit** (`accomplish-daemon.service`) — portable as-is                                                                                     |
| `nativeTheme`                                                                                                          | Dark/light theme                                                                                                                                   | `prefers-color-scheme` + GTK settings                                                                                                                                       |
| `webUtils.getPathForFile`                                                                                              | Drag-dropped file paths                                                                                                                            | Host file picker (`pickFolder`/`pickFiles`); document that browser `File` objects cannot reveal local paths                                                                 |
| `webContents.session.webRequest.onHeadersReceived`                                                                     | CSP injection                                                                                                                                      | Response headers from host serving layer                                                                                                                                    |
| `webContents.setWindowOpenHandler`                                                                                     | Force external links to system browser                                                                                                             | `xdg-open`; in-Firefox new tab acceptable                                                                                                                                   |
| `webContents.capturePage` / `executeJavaScript`                                                                        | Bug-report screenshot + AX-tree                                                                                                                    | In-page capture (html2canvas-class) + same JS run in-page (no privilege needed)                                                                                             |
| `net.fetch` (GA4 analytics)                                                                                            | Proxy-aware fetch                                                                                                                                  | `undici`/`fetch` in host                                                                                                                                                    |
| `clipboard.writeText`                                                                                                  | Copy update URL                                                                                                                                    | `navigator.clipboard` in page or `xclip`                                                                                                                                    |
| `electron-updater` (macOS/AppImage)                                                                                    | Auto-update                                                                                                                                        | Existing **manual-manifest path** (plain HTTPS + semver + `xdg-open` download page) — extend for linux-arm64 artifacts                                                      |
| `@sentry/electron`                                                                                                     | Error reporting                                                                                                                                    | `@sentry/node` (host)                                                                                                                                                       |
| `electron-store`                                                                                                       | Analytics client id, updater throttle                                                                                                              | Plain JSON file (XDG data dir)                                                                                                                                              |
| `nativeImage`, `app.dock` (macOS), `setProgressBar`                                                                    | Icons/badges                                                                                                                                       | N/A on Linux / drop                                                                                                                                                         |
| Playwright `_electron.launch` E2E                                                                                      | Electron E2E                                                                                                                                       | Playwright **Firefox** channel against host URL; drop Electron/Chromium Docker deps                                                                                         |
| `vite-plugin-electron`, `electron-builder` (AppImage+deb, linux-arm64, extraResources: web-ui/daemon/mcp-tools/nodejs) | Build/packaging                                                                                                                                    | New packaging reusing `scripts/download-nodejs.cjs` (**linux-arm64 already supported**) and `scripts/stage-daemon-deps.cjs` (per-arch `better-sqlite3` vs bundled-Node ABI) |

**Verified NOT used** (no replacement needed): `safeStorage`, `Notification`, `powerMonitor`, `globalShortcut`, `screen`, `protocol.registerSchemes*`, `session.setPermissionRequestHandler`, `session.cookies`, `crashReporter`, `utilityProcess`, `WebContentsView`, `webview` tag, `node-pty`/xterm (removed in SDK cutover — plain `child_process.spawn` only).

**Re-homed (plain Node already, move into host):** OAuth loopback HTTP servers (`google-auth.ts`, `oauth-callback-server.ts`, MCP connector strategies), HuggingFace local model server control (`providers/huggingface-local/*`, `http.createServer` on 127.0.0.1), CDP preview client (`services/cdp-client.ts`), `gh`/`gcloud`/`systemctl`/`git` child-process helpers, device fingerprint (`/etc/machine-id` — portable).

---

## 4. Kujenga Custom Features to Preserve (port from fork HEAD)

All are daemon/agent-core/web — portable to the Firefox architecture with one systematic change: **desktop IPC handlers become daemon RPC methods** (matching the established thin-proxy pattern), consumed by the browser shim.

| Feature                            | Implementation (source: `/home/chris/Accomplish` @ `690b447`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Port notes                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SFTP sites**                     | `packages/agent-core/src/common/types/sftp.ts` (`SftpSite`), SecureStorage key `'sftp-sites'` (`factories/storage.ts`), `resolve-task-config.ts` → `generator-mcp.ts` (env `WORDPRESS_SFTP_SITES`, 120s timeout); desktop IPC `sftp:list/save/delete` (`connector-handlers.ts`); web `SftpSitesSection.tsx`                                                                                                                                                                                                                                                                     | Replace desktop IPC with daemon RPC `sftp.list/save/delete` (storage-backed); add thin desktop IPC proxies only if Electron must keep working during the bridge period |
| **WordPress SFTP MCP tool**        | `packages/agent-core/mcp-tools/wordpress-sftp/` — stdio MCP server; system `sftp` CLI (BatchMode, `accept-new`, optional `-i`); path-jailing to `remoteRoot`; tools: `wordpress_sftp_sites/list/read/write/delete`                                                                                                                                                                                                                                                                                                                                                              | Copy as-is (Electron-independent)                                                                                                                                      |
| **Project orchestration**          | `apps/daemon/src/project-orchestrator.ts` (681 lines; plan → dependency-batched execute → synthesize; ≤2 follow-up rounds; subtask-failure model escalation), `project-plan-parser.ts`, `project-scheduler.ts` (topological batching), `project-model-router.ts` (Ollama-Cloud family: `glm-5.3:cloud`, `glm-5.3-flash:cloud`, `gemma4:cloud`, `gpt-oss:120b-cloud`, `kimi-k2.7-code:cloud`), `prompt-model-router.ts`, `project-context.ts`; `task-service.ts startProjectTask`; notifications `task.projectPlan/Status/Complete`; web `ProjectModeToggle`, store wiring, i18n | Copy daemon modules; add RPC notification types; web toggle works unchanged once shim forwards the events                                                              |
| **Mid-run task messaging**         | `task.send` RPC → `TaskService.sendUserMessage` → `TaskManager.sendUserMessage` → `OpenCodeAdapter.queueUserMessage` (Ctrl+C current turn + session respawn with redirect); web mid-run input (`Execution.tsx` `execution-midrun-input`)                                                                                                                                                                                                                                                                                                                                        | Copy full chain; falls back to `session.resume` when task not running                                                                                                  |
| **Task renaming**                  | `task.rename` RPC → `storage.updateTaskSummary` (≤200 chars); web pencil button in `ConversationListItem`; **32 MB socket buffer** (`socket-transport.ts`, for large task lists)                                                                                                                                                                                                                                                                                                                                                                                                | Copy; include buffer bump                                                                                                                                              |
| **Firefox WebDriver BiDi backend** | `mcp-tools/dev-browser-mcp/src/firefox-bidi-adapter.ts` (puppeteer-core WebDriver BiDi; `ACCOMPLISH_BROWSER=firefox-bidi`; `FIREFOX_BIN`/`ACCOMPLISH_FIREFOX_PROFILE` overrides), `connection.ts` branches, `src/browser/server.ts` short-circuit                                                                                                                                                                                                                                                                                                                               | Copy (Migration Phase 5)                                                                                                                                               |
| **Expert autonomy mode**           | `ACCOMPLISH_AUTONOMY_MODE=expert`; `EXPERT_AUTONOMY_BEHAVIOR` prompt block (`system-prompt-behaviors.ts`); all-tools-allow permission policy                                                                                                                                                                                                                                                                                                                                                                                                                                    | Copy; **flag as elevated risk** in security model (§7)                                                                                                                 |
| **Other**                          | English-default agent output; fork auto-updater (`app-updater.ts` + manual manifest); ARM64 fixes (`check-native-abi.cjs`, browser `detection.ts`, daemon Node selection); `kujenga-release.yml` workflow                                                                                                                                                                                                                                                                                                                                                                       | English-default + ARM64 fixes: copy. Updater: replace with manual-manifest path extended to linux-arm64. Workflow: add Linux ARM64 jobs                                |

**Fork migration-chain divergence risk:** the fork carried Kujenga migration `v014` (desktop blocklist) which upstream `v031` drops. Existing fork users' databases cannot be assumed to migrate cleanly onto the upstream chain. Default: **fresh dataDir** for the Firefox app; write a one-time export/import tool only if fork-user data preservation becomes a requirement (open decision, §10).

---

## 5. Reusable Daemon APIs (verified Electron-free — 100% reuse)

### 5.1 Process model

- Entry `apps/daemon/src/index.ts` → tsup CJS bundle; standalone Node process (spawned detached, survives shell exit), PID lock at `<dataDir>/daemon.pid`, `--data-dir` contract: DB `<dataDir>/accomplish.db`, socket `<dataDir>/daemon.sock`, secure storage `<dataDir>/secure-storage.json`.
- Boot: PID lock → per-session auth token (`crypto.randomUUID()`, for child processes via `ACCOMPLISH_DAEMON_AUTH_TOKEN`) → SQLite + crash recovery (stale `running` → `failed`) → RPC start → WhatsApp API → scheduler.
- Graceful drain shutdown (30s); SIGINT/SIGTERM + `daemon.shutdown`; build-id version guard (`ACCOMPLISH_BUILD_ID` from `daemon.ping`) triggers respawn on mismatch.

### 5.2 Transport & API surface

- **JSON-RPC 2.0 over Unix socket, newline-delimited JSON, 1 MB buffer (fork: 32 MB), no auth** (security = filesystem perms on `0700` dataDir). Multi-client; `rpc.notify()` broadcasts to all.
- **100+ methods** (`DaemonMethodMap`, `packages/agent-core/src/common/types/daemon.ts`): `daemon.ping/shutdown`, `health.check`, `task.start/stop/cancel/interrupt/list/status/get/delete/clearHistory/getTodos/getActiveCount`, `session.resume`, `permission.respond`, `task.schedule/listScheduled/cancelScheduled/setScheduleEnabled`, `secrets.*` (API keys, Bedrock), `settings.*` (25: theme, language, debug, notifications, close behavior, sandbox, cloud browser, messaging, NIM, onboarding, per-provider configs), `provider.*`, `workspace.*`, `knowledgeNote.*`, `favorites.*`, `connectors.*` (incl. OAuth token storage + auth entries), `gwsAccount.*`, `skills.*`, `auth.openai.*`, `whatsapp.*`, `accomplish-ai.*`, `logs.getTasksForBugReport`.
- **17 notifications** (`DaemonNotificationMap`): `task.progress`, `task.message` (batched), `task.statusChange`, `task.summary`, `task.complete`, `task.error`, `permission.request`, `todo.update`, `auth.error`, `browser.frame`, `accomplish-ai.usage-update`, `whatsapp.qr`, `whatsapp.status`, `settings.changed`, `workspace.changed`, `gwsAccount.statusChanged`, `skills.changed`.
- **`rpc.hasConnectedClients()` gates permission auto-deny** (no UI → auto-deny after 5-min `PERMISSION_REQUEST_TIMEOUT_MS`). The browser client MUST register as a connected client (Migration Phase 3).

### 5.3 Supporting infrastructure (all reusable)

- **Storage:** better-sqlite3 v12, WAL, FK on; 31 migrations + future-version guard; daemon is sole DB owner.
- **Secure storage:** AES-256-GCM (`iv:tag:ciphertext`), PBKDF2-SHA256 100k iterations from machine identity + appId, `secure-storage.json` `0600`, atomic writes. (Key derivation is reversible-by-same-user — documented weakness, unchanged by migration.)
- **OpenCode:** `opencode/server-manager.ts` spawns one `opencode serve --hostname=127.0.0.1 --port=0` per task; `@opencode-ai/sdk@1.14.18` (`createOpencodeClient`) in `OpenCodeAdapter`: `session.create` → `event.subscribe` → `session.prompt`; permissions/questions via `client.permission.reply`/`question.reply`; cancel via `session.abort`; per-task `opencode-<taskId>.json` config (skills, connectors, sandbox, workspace notes, model/provider).
- **Scheduler:** 60s tick, hand-rolled 5-field cron, SQLite persistence, boot catch-up.
- **HTTP factory template:** `apps/daemon/src/http-server-factory.ts` — 127.0.0.1 bind, timing-safe bearer auth, per-IP rate limit (60 req/min), 1 MB body cap. Currently used only by WhatsApp API (`:9230`). **This is the template for the host gateway.**
- **Client stack:** `DaemonClient` + `createSocketTransport` exported from `@accomplish_ai/agent-core/desktop-main` — Electron-free; `daemon-connector.ts` logic (connect → ping → retry → spawn detached → poll 200ms×10s; reconnect backoff 200ms→5s×10) ports to the host nearly verbatim (Electron used only for `app.getPath`).
- **Autostart:** Linux = systemd user unit (Electron-free already).

### 5.4 Missing for a browser frontend (what the migration adds)

1. Browser-reachable transport (browsers cannot open Unix sockets) → **host gateway**.
2. CORS/Origin/Host validation (none exists today; the HTTP factory's bare `204` for OPTIONS de facto blocks browsers).
3. Token bootstrap to a browser page.
4. Authenticated realtime event endpoint (WS/SSE) with reconnect catch-up.
5. Connected-client registration for the permission auto-deny gate.
6. Gateway-level secrets redaction (see §7.3).

---

## 6. Browser-to-Daemon Communication Architecture (approved: host-process gateway)

### 6.1 Components

```
┌────────────────────────── Ubuntu ARM64 ──────────────────────────┐
│                                                                    │
│  Firefox (snap/deb, dedicated profile)                             │
│    loads http://127.0.0.1:<port>/#token=<random>                  │
│    └─ React UI (apps/web, unchanged)                               │
│        └─ accomplish-http shim (new) — same AccomplishAPI shape   │
│             │  same-origin fetch + WebSocket (no CORS)            │
│  ┌─────────┴─────────────────────────────────────┐                 │
│  │ apps/host (NEW, thin Node 24 process)         │                 │
│  │  • serves web-ui static files (GET /)         │                 │
│  │  • POST /rpc  → JSON-RPC proxy → Unix socket  │                 │
│  │  • WS /events ← forwards rpc.notify()        │                 │
│  │  • token auth (timing-safe), Origin+Host      │                 │
│  │    validation, strict CSP headers             │                 │
│  │  • OS integration: xdg-open, zenity pickers,   │                 │
│  │    .desktop + accomplish:// scheme, systemd,  │                 │
│  │    single-instance lock, Firefox launcher,     │                 │
│  │    OAuth loopbacks, HF server control, tray   │                 │
│  └──────────────┬────────────────────────────────┘                 │
│                 │ DaemonClient over <dataDir>/daemon.sock (reuse)   │
│  ┌──────────────┴────────────────────────────────┐                 │
│  │ apps/daemon (UNCHANGED)                        │                 │
│  │  task execution • SQLite • secure storage      │                 │
│  │  opencode serve per task • MCP tools • sched   │                 │
│  └───────────────────────────────────────────────┘                 │
└────────────────────────────────────────────────────────────────────┘
```

### 6.2 Key design decisions

- **Host = another socket client**, exactly like Electron main was. The daemon remains a pristine headless core, still serving CLI/scheduler/WhatsApp consumers. The alternative (in-daemon HTTP server) was considered and rejected to preserve the daemon's headless contract; WebExtension + native messaging was rejected as heavier Mozilla-specific plumbing with no benefit for a same-origin localhost model.
- **Same-origin serving** (UI and API both from `http://127.0.0.1:<port>`) eliminates CORS entirely; Origin/Host validation remains as defense-in-depth.
- **Token bootstrap:** host generates a 128-bit+ session token per launch and opens Firefox at `http://127.0.0.1:<port>/#token=...`. The fragment is available to page JS but never sent in HTTP request lines; the shim moves it to `sessionStorage`, strips it from the URL, and sends `Authorization: Bearer <token>` on all `/rpc` calls. WS authenticates via a first-message token exchange (browser WS cannot set headers).
- **Web shim:** `apps/web/src/client/lib/accomplish-http.ts` implements the existing 942-line `AccomplishAPI` TypeScript interface. `getAccomplish()` becomes a fallback chain: `window.accomplish` (Electron, bridge period) → HTTP transport. **All Zustand stores, hooks, and components remain unchanged.** Push events (`onTaskUpdateBatch`, `onPermissionRequest`, …) subscribe to the `/events` WS with the existing unsubscribe semantics; reconnect triggers `task.list`/`settings.getAll` catch-up (`daemon:disconnected`/`daemon:reconnected` equivalents).
- **Gateway method policy:** blocklist for plaintext-secrets methods (§7.3); everything else is a mechanical passthrough (handlers are already thin daemon-RPC proxies in Electron).
- **`respondToClose`/close-confirmation:** maps to in-page `beforeunload` (the confirm dialog already lives in the renderer).
- **UX note:** stock Firefox has no true "app mode". Default: normal window with dedicated profile; `--kiosk` available as an option. Open decision §10.

---

## 7. Security Requirements

### 7.1 Transport & auth

1. **Bind loopback only** (`127.0.0.1`; never 0.0.0.0).
2. **Host header validation** — reject requests whose `Host` is not `127.0.0.1:<port>` (DNS-rebinding defense; a bare loopback bind does NOT protect unauthenticated endpoints).
3. **Origin validation** when the header is present (reject cross-origin); combined with same-origin serving this is defense-in-depth.
4. **Bearer token** with `crypto.timingSafeEqual` (pattern already in `http-server-factory.ts`); rotated every host/daemon session; never placed in query strings or cookies; delivered only via launch-URL fragment.
5. **Strict CSP** on served UI (port of the Electron CSP: `default-src 'self' https:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws:` …) + `X-Content-Type-Options: nosniff`.
6. **Rate limiting per token** (not per-IP — all browser clients share `127.0.0.1`; the existing per-IP limiter would throttle the legitimate UI).

### 7.2 Daemon socket & side services

7. **Unix socket hardening:** `chmod 0600` `<dataDir>/daemon.sock` at listen time; optionally `SO_PEERCRED` peer checks (the socket today has **zero auth** — any local process reaching it can call every method including secret reads; filesystem perms are the only barrier).
8. **Harden currently-unauthenticated side services** (all loopback, all reachable by any local process and by DNS-rebinding from a browser): dev-browser HTTP `:9224` (incl. unauthenticated `POST /shutdown`), CDP WS `:9225` (full browser control), CDP relay `ws://…:9224/cdp`, LLM proxies `:9228/:9229`. Apply the same token + Origin checks; WhatsApp API `:9230` already tokened (add Origin checks; fix its bare-204 OPTIONS).
9. `opencode serve` instances: loopback + random port each (acceptable; document).

### 7.3 Secrets and the browser trust boundary

10. **Plaintext key material must never cross into the browser.** Gateway blocklist: `secrets.getApiKey`, `secrets.getAllApiKeys`, `connectors.getTokens`, `gwsAccount.getToken` (+ any fork equivalents). Add masked variants (provider → last-4 + has-key) so the Settings UI still renders. Rationale: an XSS in the UI becomes exfiltration of every provider key otherwise; the Electron renderer was trusted, a web page is not.
11. **Pre-existing plaintext leak paths documented (unchanged by migration, tracked separately):** decrypted keys written to `~/.local/share/opencode/auth.json` on each task start; API keys injected as env vars into `opencode serve` (readable by agent-run `bash`). Note in security docs.
12. **Permission model:** preserve bash ask-list baseline (rm/mv/chmod/interpreters/redirects ask; edits ask); the browser WS client **must** count toward `rpc.hasConnectedClients()` or permission requests will silently auto-deny when the UI is open; conversely the daemon must not treat a dead socket client as connected. Preserve 5-minute auto-deny and source-based denial.
13. **Expert autonomy mode** (`ACCOMPLISH_AUTONOMY_MODE=expert`, all-tools-allow) ships only behind explicit opt-in and is called out in the security model as elevated risk.

### 7.4 Browser-side

14. **Dedicated Firefox profiles** for both the UI host app and the BiDi automation backend (never the user's daily profile). Automation profile today sets `acceptInsecureCerts: true` — document the TLS-verification risk.
15. `0700` dataDir; `0600` secure-storage/token/log files; atomic writes (existing).

---

## 8. Required Changes for Firefox Browser Automation

The agent-facing browser tool (`dev-browser-mcp`, ~26 `browser_*` MCP tools) currently drives Chromium over CDP. The Kujenga fork already built the Firefox backend — port it (Migration Phase 5):

1. **`firefox-bidi-adapter.ts`** (404 lines): `puppeteer.launch({ browser: 'firefox', protocol: 'webDriverBiDi' })`; binary resolution `$FIREFOX_BIN` → `/snap/bin/firefox` → `/usr/bin/firefox` → `/usr/bin/firefox-esr`; profile `$ACCOMPLISH_FIREFOX_PROFILE` → snap-aware → `~/.config/Accomplish/firefox-bidi-profile`; Playwright-shaped proxies (`wrapBrowser/Context/Page/Element`) so all tools work unmodified; `BidiCdpSessionShim` emulates the CDP calls in use (`Input.insertText`, `Target.getTargetInfo`, `Page.startScreencast` via ~7fps screenshot polling, …).
2. **`connection.ts` branches** on `isFirefoxBidiEnabled()` (local page registry; bypasses the dev-browser HTTP server); **`src/browser/server.ts`** short-circuits the Chromium server spawn + Playwright install.
3. **`package.json`:** add `puppeteer-core ^25.13.0` alongside the Playwright alias.
4. **Enablement:** `ACCOMPLISH_BROWSER=firefox-bidi` (default ON for this Ubuntu ARM64 target; `FIREFOX_BIN` override).
5. **Browser preview (`browser.frame` live screencast in UI):** current path is desktop `cdp-client.ts` → CDP `Page.startScreencast`. BiDi has no native screencast. v1: **degrade to on-demand screenshots** (`browser_screenshot` results rendered in UI); stretch: expose the shim's 7fps polling through the host. The CDP client re-homes to the host and is only active in Chromium mode.
6. **E2E tooling:** Playwright Firefox channel replaces `_electron`; Docker E2E drops Electron/Chromium-specific deps (libnss, xvfb-Electron).
7. **Verify on ARM64 Firefox:** BiDi maturity differs by Firefox version; pin/verify against current Ubuntu `firefox` snap and `firefox-esr`.

---

## 9. Six-Phase Implementation Plan

All phases run on branch `firefox-migration` (one PR per phase to `main`, conventional commits, annotated tag per phase). Every phase ends with `pnpm typecheck && pnpm lint:eslint && pnpm format:check` plus the listed suites. The Electron shell remains functional through Phase 5 (bridge period) so regressions are bisectable; it is retired in Phase 6.

### Phase 1 — Browser Gateway Foundation

**Scope**

- New workspace package `apps/host` (Node 24, tsup, mirrors daemon build conventions).
- XDG path module (`~/.local/share/Accomplish` data-dir resolution; parity with daemon `--data-dir` contract).
- Port `daemon-connector` logic (connect → `daemon.ping` + build-id guard → retry → spawn detached with bundled Node → poll; reconnect backoff) — pure Node, Electron was only used for paths.
- HTTP server: `GET /` (static web-ui from `apps/web/dist/client`), `POST /rpc` (JSON-RPC proxy via `DaemonClient`), `WS /events` (forwards `rpc.notify()`).
- Auth: session token (URL-fragment bootstrap), timing-safe compare, Host/Origin validation, CSP + nosniff headers, per-token rate limit.
- Web: `lib/accomplish-http.ts` shim implementing the core subset (task/session/permission/settings/scheduler); `getAccomplish()` fallback chain; WS event wiring into existing subscription pattern.

**Acceptance tests**

- Vitest unit: auth matrix (missing/bad token, wrong Origin, wrong Host → rejected; valid → 200); token never appears in access logs/request lines.
- Vitest integration (real daemon on temp data-dir): `task.start` → `task.message` → `task.complete` round-trip over HTTP+WS; reconnect triggers `task.list` catch-up.
- `pnpm typecheck && pnpm lint:eslint && pnpm -F @accomplish/web test` green.

**Git milestone:** PR #1 merged → `git tag -a fox-phase-1` (message: gateway + shim MVP).

### Phase 2 — Ubuntu ARM64 Shell Integration

**Scope**

- `.desktop` launcher + `accomplish://` scheme registration (`x-scheme-handler` + `xdg-mime`); single-instance lock; deep-link routing to host.
- systemd user unit for daemon autostart (reuse the Linux branch of `service-manager.ts` — already Electron-free).
- `xdg-open` for external links/OAuth URLs; `zenity`/GTK file & folder pickers (`pickFolder`, `pickFiles`, `processDroppedFiles` replacement — browser `File` cannot reveal local paths).
- Firefox launcher: dedicated profile (`~/.config/Accomplish/firefox-app-profile`), `--new-window "http://127.0.0.1:<port>/#token=..."` (`--kiosk` optional flag).
- Re-home into host: OAuth loopback servers (Google accounts, MCP connector strategies, `oauth-callback-server.ts`), HuggingFace local server control, close-confirm via `beforeunload`.
- Dev entry `pnpm dev:fox` (daemon + host + Vite dev URL).

**Acceptance tests**

- Fresh Ubuntu ARM64 VM: `pnpm dev:fox` → daemon autostarts via systemd → launcher opens Firefox with UI → run a task → close Firefox → task keeps running (daemon survives) → reopen → sidebar shows completed task (catch-up).
- Deep link `accomplish://…` routes to host; `pickFolder` returns a real path; external link opens default browser.
- Daemon unit + desktop workspace tests still green (bridge period intact).

**Git milestone:** PR #2 merged → `fox-phase-2`.

### Phase 3 — Full API Parity + Security Hardening

**Scope**

- Complete the shim: all ~205 methods (analytics → batched endpoint; speech → re-home implementation or feature-flag; `captureScreenshot`/`captureAxtree` in-page; GWS; connector OAuth flows through host loopbacks).
- Gateway method policy: secrets blocklist + masked-key API (§7.3); audit every method that returns token/key material.
- WS client registers as connected client for `hasConnectedClients()` (auto-deny gate); `daemon:disconnected/reconnected` semantics.
- Harden side services per §7.2 (dev-browser `:9224`/`:9225`/relay: token + Origin checks; WhatsApp OPTIONS fix).
- Unix socket `chmod 0600`.
- Playwright **Firefox** E2E harness (replaces `_electron` fixture): port core specs — onboarding, task lifecycle, permission approve/deny, settings CRUD, connectors, scheduler, history.
- Security test battery: cross-origin fetch rejected, DNS-rebinding Host check, token rotation on restart, secrets redaction, CSP header assertions.

**Acceptance tests**

- Parity audit script: shim covers 100% of the `AccomplishAPI` interface keys (0 unimplemented).
- E2E suite green on dev machine (Ubuntu ARM64 + Playwright Firefox); security battery green.
- `pnpm -F @accomplish/web test`, `-F @accomplish/desktop test` (bridge), `-F @accomplish_ai/agent-core test` green.

**Git milestone:** PR #3 merged → `fox-phase-3`.

### Phase 4 — Kujenga Feature Port

**Scope** (source: fork **HEAD `690b447`** — never the dirty working tree)

- SFTP sites: types + SecureStorage `'sftp-sites'` + `resolve-task-config`/`generator-mcp` wiring; **new daemon RPC `sftp.list/save/delete`** (+ thin desktop IPC proxies for the bridge period); web `SftpSitesSection` + typed wrappers.
- `wordpress-sftp` MCP tool: copy verbatim.
- Project orchestration: copy the five daemon modules + `task-service.startProjectTask` + `task-event-forwarding` + RPC notification types + web toggle/store/i18n + model routing (`prompt-model-router`).
- Mid-run messaging: `task.send` chain end-to-end (adapter `queueUserMessage`, TaskManager, TaskService, RPC, web mid-run input).
- Task renaming: `task.rename` RPC + web + **32 MB socket buffer bump**.
- Expert autonomy mode, English-default output, ARM64 fixes (`check-native-abi.cjs`, browser `detection.ts` Linux paths, daemon Node selection).

**Acceptance tests**

- Ported daemon unit tests green (`project-orchestrator`, `plan-parser`, `scheduler`, `model-router`, `project-status-todos`).
- E2E (Firefox): rename a task; send mid-run message to a running task (task interrupts and redirects); create SFTP site → task invokes `wordpress_sftp_list` against a local Docker SFTP fixture (path-jail rejection tested); project-mode task with 2 subtasks completes with synthesis.
- `pnpm -F @accomplish_ai/agent-core test` green; schema/migration check (no new migrations required — SFTP sites live in SecureStorage; verify).

**Git milestone:** PR #4 merged → `fox-phase-4`.

### Phase 5 — Firefox WebDriver BiDi Automation Backend

**Scope**

- Port §8 items 1–3 (adapter, `connection.ts` branches, `server.ts` short-circuit, `puppeteer-core` dep).
- Default `ACCOMPLISH_BROWSER=firefox-bidi` on this target; `FIREFOX_BIN` override honored.
- Browser preview degradation: v1 on-demand screenshots in UI; stretch 7fps polling endpoint.
- Side-service hardening from Phase 3 applies to any preview path left enabled.
- Verify BiDi behavior on Ubuntu ARM64 Firefox (snap + ESR): pin minimum version in docs.

**Acceptance tests**

- Tool-level integration suite vs real Firefox: navigate, click, type, fill, snapshot, screenshot, drag, iframe, tabs, wait.
- Daemon task with browser tool completes a scripted web workflow (e.g., open local fixture site, fill form, assert result) via Firefox on ARM64.
- No Chromium/Playwright browser download occurs in `firefox-bidi` mode (build/CI assertion).
- `acceptInsecureCerts: true` risk documented in SECURITY.md.

**Git milestone:** PR #5 merged → `fox-phase-5`.

### Phase 6 — Packaging, Updates, Retirement

**Scope**

- New packaging (drop electron-builder): build web → host → daemon → `download-nodejs.cjs` (linux-arm64) → `stage-daemon-deps.cjs` → assemble **deb + AppImage** (dpkg-deb/appimagetool scripts) with `.desktop`, icons, autostart integration, postinst systemd unit.
- Updater: extend the manual-manifest path (HTTPS + semver + `xdg-open`) to linux-arm64 artifacts; add Linux jobs to the release workflow.
- Retire `apps/desktop`: remove from release pipeline and workspace build (archive branch `legacy-electron`); remove `vite-plugin-electron`, electron-builder config, stale pnpm overrides (`@electron/rebuild>node-gyp`), `electron` in `onlyBuiltDependencies`.
- Docs: rewrite `docs/architecture.md` (host/daemon/Firefox diagram), refresh AGENTS.md commands (`pnpm dev:fox`, host test suites), purge stale PTY references in `docs/development-viewpoint.md`.

**Acceptance tests**

- Clean Ubuntu ARM64 VM: `dpkg -i` → all Phase 2/3/4/5 E2E green against the **packaged** build.
- Update check against staging manifest works; uninstall leaves no orphan files (user dataDir preserved + documented).
- Full battery: `pnpm lint && pnpm format:check && pnpm -F @accomplish/web test && pnpm -F @accomplish_ai/agent-core test && host suites`; release workflow produces installable arm64 artifacts.

**Git milestone:** PR #6 merged → `git tag -a v1.0.0-fox` → release published.

---

## 10. Risks & Open Decisions

| #   | Risk / Decision                                                                                                        | Disposition                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | **No true Firefox app mode** — browser chrome visible; `--kiosk` loses normal controls                                 | Recommend normal window + dedicated profile; decide UX in Phase 2                   |
| 2   | BiDi coverage gaps vs CDP (no native screencast → 7fps emulation; `setWindowBounds` no-op; version-dependent maturity) | Preview degraded v1; pin Firefox version; tool tests gate Phase 5                   |
| 3   | Fork DB migration-chain divergence (Kujenga `v014` vs upstream `v031`)                                                 | Default fresh dataDir for Firefox app; optional export/import tool (needs decision) |
| 4   | Unix socket has no auth today (local-process attack surface)                                                           | Socket `0600` + optional SO_PEERCRED in Phase 3; full token auth out of scope       |
| 5   | Plaintext key APIs to renderer are trusted in Electron but must be untrusted in a browser                              | Gateway blocklist + masked API (Phase 3, mandatory)                                 |
| 6   | Permission auto-deny regression if browser client isn't a "connected client"                                           | WS registration is an explicit Phase 3 acceptance test                              |
| 7   | `webUtils.getPathForFile` drag-drop paths unavailable in browsers                                                      | Host pickers; feature parity documented (attachment flows use pickers)              |
| 8   | Tray/StatusNotifierItem adds host complexity                                                                           | Optional in Phase 2; defer without blocking (daemon survives without it)            |
| 9   | `apps/desktop` retirement order                                                                                        | Keep through Phase 5 (bisectable bridge), retire in Phase 6                         |
| 10  | Stock Firefox auto-update could change BiDi behavior                                                                   | Version-pinning smoke test in release workflow                                      |

---

## Appendix A — Key File References (target repo unless noted)

| Concern                                 | Path                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preload bridge to replace               | `apps/desktop/src/preload/index.ts` (≈205 methods); `apps/desktop/src/main/ipc/handlers/*` (~180 channels)                                                   |
| Web API contract to implement over HTTP | `apps/web/src/client/lib/accomplish.ts` (`AccomplishAPI`, 942 lines)                                                                                         |
| Daemon entry / routes / protocol        | `apps/daemon/src/index.ts`; `apps/daemon/src/daemon-routes.ts`; `packages/agent-core/src/common/types/daemon.ts`                                             |
| Transport to reuse                      | `packages/agent-core/src/daemon/{rpc-server,socket-transport,socket-path}.ts`; client: `@accomplish_ai/agent-core/desktop-main`                              |
| Daemon connector logic to port          | `apps/desktop/src/main/daemon/daemon-connector.ts`                                                                                                           |
| HTTP server template                    | `apps/daemon/src/http-server-factory.ts`                                                                                                                     |
| Secure storage                          | `packages/agent-core/src/internal/classes/secure-storage-crypto.ts`                                                                                          |
| OpenCode runtime                        | `apps/daemon/src/opencode/server-manager.ts`; `packages/agent-core/src/internal/classes/OpenCodeAdapter.ts`                                                  |
| Kujenga features (source repo HEAD)     | `apps/daemon/src/project-*.ts`; `packages/agent-core/mcp-tools/wordpress-sftp/`; `packages/agent-core/mcp-tools/dev-browser-mcp/src/firefox-bidi-adapter.ts` |
| Packaging pieces to reuse               | `scripts/download-nodejs.cjs`; `apps/desktop/scripts/stage-daemon-deps.cjs`                                                                                  |
| Architecture docs                       | `docs/daemon-final-architecture.md` (current), `docs/daemon-architecture.md` (historical)                                                                    |

---

_End of Phase 1 audit. Implementation will not begin until this plan is approved._
