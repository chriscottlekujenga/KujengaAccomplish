# PHASE 3 M4 — Unattended Reliability Implementation Plan (Rev. 1)

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `a06b0ea` (M3/C3 prototype, clean tree)
**Approved basis:** Phase 3 plan §7 (M4) + the M4 directive's background-first / human-in-the-loop design principles.
**Scope discipline:** This milestone implements (A) M4 reliability and (B) only the minimal human-assistance infrastructure M4 requires. Larger human-assistance UX and browser-session handoff design are recorded in §C for later approval. M4 is not expanded into a new project.

---

## 0. Architecture context (background-first mapping)

The execution-method preference order (directive §1) is already embodied by the existing stack and is preserved, not rebuilt:

| Preference order                  | Where it lives today                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| 1. Direct API/MCP                 | Daemon RPC surface + bundled MCP tools (start-task, skill, gmail/gws, connectors)        |
| 2. Background browser automation  | dev-browser sidecar + 26 `browser_*` MCP tools (headless/headful Chromium, daemon-owned) |
| 3. Background file/terminal       | OpenCode built-ins (`bash`, `read/write/edit`), cwd isolation per task                   |
| 4. Isolated graphical app control | `linux-desktop` MCP (M3/C3 prototype; per-action `ask` permissions, blocklist)           |
| 5. Active desktop control         | Same permission gate; unrestricted expansion explicitly out of scope                     |

No task in M4 steals keyboard/mouse focus during ordinary background work: dev-browser stays a background Chromium instance; linux-desktop actions remain individually permission-gated (M1 presence-gate auto-deny when no UI).

**Human-verification principle (directive §2):** no CAPTCHA/MFA bypass is added anywhere in M4. The task-pause state machine below makes "pause and ask the human" the reliable, first-class path.

---

## A. M4 reliability requirements (implement now)

### A1. Resume-time working-directory preservation (plan §7.1)

**Current bug:** `resumeSession` builds its TaskConfig without `workingDirectory`; the tasks table has no `working_directory` column. Consequences: (a) a lazily-respawned `opencode serve` on a resumed session is spawned with the daemon's cwd (`server-manager.ts:421` passes `ctx.workingDirectory ?? <inherited>`); (b) a user-picked folder on the original task is lost on resume (TaskManager falls back to the daemon default workspace).

**Fix:**

1. Migration `v032-task-working-directory.ts`: `ALTER TABLE tasks ADD COLUMN working_directory TEXT` (nullable). Bump `CURRENT_VERSION` → 32.
2. Persist cwd at task start (`task-service.startTask` already injects it into the config — also write it to the task row).
3. `resumeSession` resolution order: explicit `params.workingDirectory` → `storage.getTask(existingTaskId).workingDirectory` → undefined (TaskManager default fallback = today's behavior; pre-migration rows behave exactly as now).
4. `resumeSessionSchema` gains an optional `workingDirectory` param (additive; no caller forced to change).
5. Thread into `_runTask` TaskConfig so `OnBeforeStartContext.workingDirectory` reaches `ensureTaskRuntime` (lazy respawn gets the right cwd).

**Tests:** migration v032 (fresh + upgraded DB), save/read round-trip, `resumeSession` picks stored folder (Firefox-exact `{sessionId, prompt}` only params), explicit param wins, undefined falls back. Daemon parity tests + agent-core task-manager tests.

### A2. Watchdog keep-alive exclusion becomes extensible (plan §7.2)

**Current:** `OpenCodeAdapter.ts:231` hard-codes `new Set(['server.heartbeat'])` — checkpoint §17 flagged `file.watcher.updated` as another high-frequency non-progress event that can mask stalls.

**Fix:** `AdapterOptions.watchdogKeepAliveEventTypes?: ReadonlySet<string>` merged over defaults `['server.heartbeat', 'file.watcher.updated']`. TaskManager/daemon do not need changes (defaults apply); the seam makes future event types configurable without code churn.

**Tests:** keep-alive events do NOT advance the fingerprint; excluded types trigger hard-timeout in the stalled scenario; custom set honored.

### A3. systemd restart policy (plan §7.3)

**Already in place** (verified): the installed `accomplish-fox-daemon.service` and the generator `apps/host/src/daemon-service.ts` both carry `Restart=on-failure` + `RestartSec=5`. M4 adds a regression **test lock** on the generated unit text so the fields cannot silently regress, and documents the verified restart behavior (crash → 5 s → respawn → PID lock reclaim → crash-recovery sweep).

### A4. Rate-limiter reliability (plan §7.4 — checkpoint §17 flake)

**Current:** `apps/host/src/rate-limit.ts` per-token fixed window 600 req/60 s. UI reconnect floods (web boot after every daemon restart) consume a large fraction of the shared budget → 429s for harness pre-flight and once for a `permission.respond`.

**Fix (plan-approved option): raise the per-token budget, keep the cap.**

1. Default `600 → 1500` per 60 s per token (2.5× headroom; abuse cap retained).
2. Env override `ACCOMPLISH_GATEWAY_RATE_LIMIT` (integer) parsed at gateway construction; invalid values fall back to the default with a logged warning.
3. No algorithm change (fixed window stays; per-token keying stays).

**Tests:** flood regression (500 rapid requests within one window → none throttled), abuse still throttled (custom small limit), env override honored, invalid env → default + warning.

### A5. Correct restart behavior for tasks waiting on humans

**Current:** crash recovery (`apps/daemon/src/index.ts:116-122`) marks only `status === 'running'` tasks failed at boot. A task awaiting a permission/question reply is still recorded `running` today → a daemon restart marks it failed even though its session is fully resumable. This is precisely the "waiting tasks are incorrectly treated as hung or failed" hazard.

**Fix:** once the waiting states are persisted (B1 below), waiting tasks are no longer recorded `running`, so crash recovery naturally skips them. Added explicit regression coverage:

- running task → marked `failed` on restart (existing behavior, now tested);
- `waiting_permission`/`waiting_for_user` task → left as-is (resumable; sessionId preserved — resumeSession is the recovery path);
- `resuming` task → left as-is;
- terminal statuses untouched.

Soak/stability harness (§D) exercises a mid-task daemon restart + resume end-to-end.

---

## B. Human-assistance infrastructure required for M4 (minimal)

Goal: tasks paused for human verification are a **first-class persisted state**, not an in-memory accident of the watchdog.

### B1. Task-state machine (additive, backward-compatible)

`TaskStatus` gains two members (existing seven unchanged; DB statuses are TEXT — no CHECK constraints):

| Status               | Meaning                                                                    | Set by                                                                   |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `waiting_permission` | (EXISTS — now actually used) permission/question prompt pending on a human | `task-callbacks.onPermissionRequest` when the request is emitted to a UI |
| `waiting_for_user`   | designed general "needs human verification" state (CAPTCHA/MFA/passkey)    | reserved member + plumbing; trigger mechanism deferred (§C1)             |
| `resuming`           | transient state while a waiting/failed task's resume turn starts           | `resumeSession` before the turn                                          |

**Transition rules (daemon-owned, enforced in task callbacks):**

- `permission request emitted to UI` → `waiting_permission`.
- `permission/question resolved (allow/deny reply)` → back to `running` (the turn continues).
- `auto-deny (no interactive UI)` → stays `running` (brief transient; immediate deny means no human wait).
- `resume turn on task with prior status ∈ {waiting_permission, waiting_for_user}` → emit `resuming` (event + storage), then the turn proceeds (`running` semantics inside TaskManager); final status persisted at completion as today.
- New statuses are emitted through the existing `statusChange` → RPC `task.statusChange` notification chain, so the WS event path is unchanged.

### B2. Watchdog & timeout coverage of human wait (reliability requirement)

- Watchdog already treats a pending permission/question as non-stall (`sampleWatchdogState` → `inProgress: false`) — human thinking time never counts as inactivity. Regression-tested as part of A2.
- No new timeout races a human reply: the 5-min permission in-flight timeout (M1 mechanics, unchanged) continues to bound forgotten prompts, and auto-deny only applies when no interactive UI is present — a waiting task with a live UI stays alive arbitrarily long without being marked hung.

### B3. Session preservation across a pause and a daemon restart

- Task row keeps `session_id` (existing `updateTaskSessionId` on completion) — a waiting task that survives a restart can be resumed via `resumeSession({sessionId, ...})`, reusing the same opencode session (conversation + browser session state live in the session store / sidecar, untouched by the daemon lifecycle).
- A1's persisted `working_directory` ensures the resumed turn re-spawns the runtime in the original workspace.

### B4. UI compatibility (2-line additive change)

`apps/web/src/client/lib/task-utils.ts` badge map gains `waiting_for_user` and `resuming` entries; `useExecutionActions` active-status list already includes `waiting_permission`. No layout/flow changes; unknown statuses already degrade gracefully.

### B5. What deliberately does NOT ship in M4 (see §C)

No agent-callable assistance-request tool, no CAPTCHA notification banner, no browser-session take-over UI, no unattended-authorization flags. The daemon never auto-approves and never bypasses verification.

---

## C. Designed now, approved later (not implemented in M4)

### C1. Agent-triggered human assistance (proposed next milestone, M5 candidate)

Trigger options evaluated (decision deferred by design):

- **Option A — daemon-side tool-name watcher:** the daemon watches adapter tool-use events for a well-known MCP tool call (e.g. `request_human_assistance`) and flips the task to `waiting_for_user`. Zero opencode changes; relies on the config generator registering a small `human-assist` MCP server whose tool implementation the daemon can recognize.
- **Option B — opencode question flow:** the agent is instructed (via system prompt / workspace instructions) to raise an SDK `question` when verification is needed; the daemon maps `question.asked` → `waiting_for_user` and auto-resumes on reply. Simplest, reuses existing ask/reply plumbing end-to-end.

Dependency for either: the M4 waiting-state plumbing above (done in this milestone).

### C2. Browser-session handoff (user interacts with the agent's Chromium)

Design constraints recorded: the dev-browser sidecar owns the profile (`ACCOMPLISH_DEV_BROWSER_*` auth, ephemeral CDP). Handoff must (a) surface the SAME daemon-owned Chromium instance to the user (not a fresh profile — a different profile would not carry the session and the challenge), (b) pause the affected task safely before handoff, (c) restore agent control after. Requires a daemon RPC + shim + UI (allowlist expansion per §5.4 policy) and sidecar window-management support. Phase 5/5B or M6 candidate; M1 security model untouched (no token/credential exposure — the user is local and the CDP endpoint remains loopback+authed).

### C3. Unattended authorization seam

`task.permissions.unattended` (settable only by the scheduler on user-created schedules) remains a documented Stage-2 extension point (plan §5.2.6) — unchanged.

---

## D. Testing & verification

1. **Regression tests for every behavior above** (agent-core, daemon, host, web unit).
2. **Full battery:** `pnpm typecheck && pnpm lint:eslint && pnpm format:check && pnpm -F @accomplish/web test && pnpm -F @accomplish/desktop test && pnpm -F @accomplish_ai/agent-core test` + `pnpm -F @accomplish/daemon test`, `pnpm -F @accomplish/host test`.
3. **30-minute soak** (harness style, `/tmp/opencode/`, non-persistent): multi-step local task (file writes + shell) with periodic daemon restarts and a resume; waiting-state task survives restart; crash recovery marks only true orphans failed; watchdog exclusions verified. Run when practical; results in the checkpoint.
4. Existing failures triaged and distinguished (web integration 61 = upstream baseline; dev-browser-mcp 1 = rebrowser regression; lint 3 warnings).

---

## E. Execution order (delegation)

1. A1 (agent-core: types + migration + watchdog options) ∥ A4 (host: rate limit + unit lock test) — independent.
2. A2 (daemon: resume cwd + waiting/resuming plumbing + crash-recovery tests) ∥ A3 (web badges) — after A1.
3. Full battery → fix → commit (conventional, verifiable milestone; no push/merge).
4. Soak harness + run; checkpoint update (this plan + results) as docs commit.

**Approval gates honored:** nothing pushed/merged; `/home/chris/Accomplish` untouched; M5 not started without approval; desktop-control not expanded.
