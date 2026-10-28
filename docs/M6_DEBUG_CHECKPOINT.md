# Phase 3 M6 Debug Checkpoint

This file accumulates M6 evidence per task. It is written by the executing session of each task and never rewritten retroactively — append later sections, never edit earlier ones (mirrors `M5_DEBUG_CHECKPOINT.md` conventions). No product changes: T0 is investigation-only; any `/tmp` harness stays non-persistent.

## §0 — M6-A T0: browser-preview blank-panel root cause (investigation only, 2026-10-24)

**Objective (from the M6-A plan task brief):** produce a reproducible, evidence-backed diagnosis of why the preview panel renders blank although `devBrowser.captureFrame` delivers real 1280×720 JPEGs (M5 T7 observation: frames flow, zero poll-miss breadcrumbs, wrong page). No fix implementation; T5 executes the fix after the user gate.

### §0.1 Verdict (ranked)

**Root cause — the "agent-active page" identity seam is a TASK-ID threading gap at the MCP-child env, not a registry defect.** The dev-browser-mcp tool child computes its sidecar registry page key as `${ACCOMPLISH_TASK_ID || 'default'}-main` (`connection.ts:68`), but ACCOMPLISH_TASK_ID never reaches the child: the generated opencode config's `mcp.dev-browser-mcp.environment` contains ONLY `{ACCOMPLISH_DEV_BROWSER_TOKEN, DEV_BROWSER_PORT}` (`generator-mcp.ts:154-186`) and opencode local MCP children do NOT inherit the serve child's process env (proven live). The daemon/web-shim preview side resolves a completely different key: `${task.start taskId}-main` (`dev-browser-service.ts:130`). `BrowserPageService.ensurePage` dedupes BY NAME (`browser-page-service.ts:63-97`), so the two keys produce **two distinct tabs**:

- `${taskId}-main` — created by the preview ensure (lazy Chrome launcher; reuses the startup blank tab), **navigated by nobody, stays `about:blank` forever** — this is what `captureFrame` captures → the panel shows a live stream of a blank page.
- `default-main` — created on the child's first browser tool call; **the agent navigates this one**.

This refines named hypothesis 1 (registry-external agent-active page): the agent's tab IS created through the sidecar registry (POST /pages → ensurePage), not via `getRemotePage`/`context.newPage()` — but under an IDENTITY the preview never asks for. The observed effect (agent-active ≠ preview-captured, two tabs in one sidecar) matches H1 exactly; the mechanism is the env gap, not an untracked-tab creator.

**Live proof (run 1, isolated daemon, `m6t0-run1`, glm-5.3-flash:cloud, headless):**

| Time (UTC)        | Evidence                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01:06:41.771      | Sidecar up via the preview-ensure call (lazy Chrome launch). Registry = `["m6t0-run1-main"]` ONLY; single CDP target `DF27735A…` `about:blank`.                                                    |
| 01:06:42–01:07:27 | `captureFrame` poll: **72/72 successful frames, all 1280×720, all byte-length 8212** — the blank canvas of `about:blank`. Zero misses (matches M5 T7's "real frames, zero poll-miss breadcrumbs"). |
| 01:07:27.2        | Agent's first browser tool (`dev-browser-mcp_browser_script`, actions `[goto iana.org/help/example-domains]`) starts.                                                                              |
| 01:07:27.694      | `/json/list` gains a SECOND target `F4758FB7…` title "Example Domains".                                                                                                                            |
| 01:07:27.780      | Registry gains `default-main` (child's key — no ACCOMPLISH_TASK_ID → `'default'`).                                                                                                                 |
| 01:07:29.792      | `F4758FB7…` → `https://www.iana.org/about` title "About us" (h1 "About IANA", agent-confirmed).                                                                                                    |
| post-task         | Final `devBrowser.openPreviewPage {name:"m6t0-run1-main"}` → targetId `DF27735A…` (`about:blank`); registry `["m6t0-run1-main","default-main"]`; `/json/list` = the same two page targets.         |

Frame-content proof: 9/10 sampled JPEG captures are **byte-identical** (md5 `0e0addb6…`, ~6–8 KB blank canvas) across the whole run — including frames captured during and after both agent navigations. Not one frame shows the agent's pages.

**Rejected hypotheses:**

1. **H2 (registry-entry lifecycle staleness / relaunch races) — REJECTED.** Each of the two registry entries is created exactly once (creation timestamps above; no `created:false`→re-create churn), no page close handlers fired (registry never shrank), and `wsEndpoint` is byte-identical across all ~55 preview-poll records — one browser instance throughout, no `deleteStaleEntry`/`attachPageCloseHandler` race signatures.
2. **H3 (two sidecar instances / mid-task relaunch) — REJECTED.** Single sidecar (one wsEndpoint on one ephemeral Chromium HTTP port, `getPreviewInfo` stable end-to-end), `captureFrame` 72/72 with no failure gap that a relaunch would produce, and the two CDP page targets both belong to the isolated harness sidecar (its Chromium runs under the harness's `DEV_BROWSER_PROFILE` with port override 9324 — the production sidecar on :9224 with its own profile was never touched). `ACCOMPLISH_DEV_BROWSER_RELAY_PORT=9324` kept the two chains disjoint by port and profile.

**One additional confirmed fact needed for the story:** `openPreviewPage-first` ordering in `captureFrame` (`dev-browser-service.ts:132-135`) re-ensures the SAME wrong key every 750 ms — this is why the failure is stable across a whole task (the poll "self-heals" into the blank tab).

### §0.2 Exact mechanism (code chain)

1. Daemon boots opencode serve child with `ACCOMPLISH_TASK_ID` in its env (`environment.ts:125-134`, `buildOpenCodeEnvironment`).
2. OpenCodeAdapter generates the per-task opencode config. `generator-mcp.ts:153-186` writes `mcp["dev-browser-mcp"].environment` = `{ACCOMPLISH_DEV_BROWSER_TOKEN, DEV_BROWSER_PORT}` (+`CDP_ENDPOINT`/`CDP_SECRET` only in remote mode). **TaskId is not threaded** — `GenerateOptions` has no taskId field (`config-generator-types.ts`; grep-clean).
3. opencode spawns the local MCP child WITHOUT the serve process env (live-proven step 2 in §0.1: registry key `default-main`).
4. `connection.ts:66-68`: `taskId = process.env.ACCOMPLISH_TASK_ID || 'default'` → `getFullPageName()` = `default-main`; first tool call `getBuiltinPage` POSTs `/pages {name:"default-main"}` → new registry entry → new tab.
5. Web shim/daemon `captureFrame` resolve `${taskId}-main` from the REAL task id (`accomplish-http.ts:690`, `dev-browser-service.ts:130`) → ensure the SECOND registry entry (the blank tab).
6. `ensurePage` name-dedupe keeps both identities happy and both tabs alive forever.

The startup breadcrumb exists but is invisible in headless opencode logs: `dev-browser-mcp/src/index.ts:8-9` prints `[dev-browser-mcp] ACCOMPLISH_TASK_ID: (not set)` at child startup.

### §0.3 Chosen design mechanics for the T5 fix (D7 refinement)

The pre-committed direction (sidecar-owned "agent-active page" identity consumed by preview/capture) remains sound, but the findings sharpen WHERE the fix must land: the registry is fine; the seam is that two writers hand the registry different keys. Recommend a two-layer fix:

1. **Primary — identity repair in the generated config (must-have):** set `browserEnv.ACCOMPLISH_TASK_ID = <taskId>` in `generator-mcp.ts` for `dev-browser-mcp` (and `linux-desktop`-style children only if they read it). At generation time the taskId IS available: `OpenCodeAdapter.currentTaskId` is set before config generation (`OpenCodeAdapter.ts:431-432`), and `onBeforeStartCtx.taskId` already flows to hooks (`OpenCodeAdapter.ts:464`). Effect: `getFullPageName()` in the child produces `${taskId}-main`, `ensurePage` dedupes to ONE page, the agent's navigation becomes the preview's captured tab. Note this simultaneously fixes `index.ts:520` (screencast/relay taskId), which reads the same env.
2. **Defense-in-depth — fail-loud instead of silent-'default' (recommended):** when `ACCOMPLISH_TASK_ID` is absent AND the child was launched by an opencode daemon context (heuristic: token env present), log a loud startup warning and/or surface child stderr in daemon logs, so a future env regression cannot silently recreate this seam. Optionally relax the child fallback contract: keep `'default'` for standalone dev launches only.
3. **Optional hardening (same identity seam, other shape):** `devBrowser.captureFrame` could cross-check `getPreviewInfo().pages` for a `${something}-main` entry that the requested key doesn't match and log a breadcrumb — this stays read-only diagnostic and keeps the preview self-healing (T7's zero-miss property must be preserved).

Why alternative mechanics were set aside: making the sidecar DERIVE the agent-active page from observed navigations (e.g. "most recently navigated entry") is flaky in multi-page tasks (legit second tabs) and hides single-writer responsibility; making the preview poll the child's registry name via a new RPC adds a round trip without removing the key mismatch. With layer 1, "sidecar-authoritative identity" is achieved by construction: one key, one registry entry, preview captures what the agent drives.

### §0.4 Repro recipe (recreate-able)

```bash
# Build from clean HEAD (branch linux-firefox-ai, commit at time of writing: 2b16cf0)
pnpm --filter @accomplish_ai/agent-core build && pnpm --filter @accomplish/daemon build
pnpm --filter @accomplish/desktop build:mcp-tools:dev   # refresh dev-browser(+mcp) dist/server.mjs

# Harness (non-persistent; recreate from this spec if /tmp was wiped)
mkdir -p /tmp/opencode/m6-t0   # harness.mjs lives here (see §0.6 for semantics)

# Production sidecar may be live on :9224 — never restart it; the harness is fully isolated:
#   ports 9324 (relay override) + DEV_BROWSER_PROFILE under the isolated data dir.

# Run (harness performs): spawn isolated daemon → provider setup (needs live daemon.sock) →
#   task.start {taskId:"m6t0-run1", prompt, workingDirectory} → auto-approve permission.request →
#   poll devBrowser.getPreviewInfo (1 s) / captureFrame (750 ms, shim parity incl. the
#   openPreviewPage ensure) → poll ephemeral CDP /json/list (700 ms, discovered via
#   DevToolsActivePort file) → post-task registry/targetId classification → needle-scoped sweep.
node /tmp/opencode/m6-t0/harness.mjs run glm-5.3-flash:cloud run1
# Classification prints registry pages vs final openPreviewPage targetId vs /json/list —
# the two-tab split and the 'default-main' key are the signature of the root cause.

node /tmp/opencode/m6-t0/harness.mjs sweep   # standalone needle-scoped cleanup if a run aborted
```

Harness env contract (T7 production parity): daemon spawned with `XDG_DATA_HOME=<dataDir>`, `ACCOMPLISH_APP_PATH=<repo>/apps/desktop`, `ACCOMPLISH_DEV_BROWSER_RELAY_PORT=9324`, `DEV_BROWSER_PROFILE=<dataDir>/browser-profiles`, **without DISPLAY/WAYLAND_DISPLAY** (display-less → sidecar resolves headless via `resolveHeadlessFromEnv`, exactly the T7 production systemd env). Prompt: navigate two distinct real pages and report their main headings (`iana.org/help/example-domains` → "Example Domains"; `iana.org/about` → "About IANA" — example.com no longer serves an h1, M5 finding).

### §0.5 Environment deltas vs the M5/T7 production observation, and production invariance

- **Display:** replica faithful — harness daemon env deliberately DISPLAY-less; sidecar Chromium is headless (`resolveHeadlessFromEnv`), matching the T7 display-less daemon. The harness host does have a live desktop (`DISPLAY=:0` outside the daemon env) — irrelevant because the daemon/sidecar env strips it.
- **Model:** `glm-5.3-flash:cloud` (cost-preferred per brief; instruction-following adequate for this tool-heavy task). Delta vs T7 (`glm-5.3:cloud`): the flash model chose `browser_script {goto/evaluate}` instead of `browser_navigate` — IRRELEVANT to the seam: both tool paths resolve pages through the same `getPage()`/`getBuiltinPage()` registry key (`getFullPageName`), so the split does not depend on which browser tool the model picks. (Corroboration: the seam reproduced with zero `browser_navigate`, zero `browser_tabs` switch calls in the transcript.)
- **Preview-ensure injection:** the harness itself performs the shim's `openPreviewPage` ensure (shim parity) — in T7 production the real UI did this. Same code path either way.
- **Production invariance (recorded like M5 harnesses):** prod daemon pid 3945 alive pre/post; `ps -o pid=,cmd= -p 3945 | md5sum` = `e01fee9f56f60160e88df7f8192d672e` IDENTICAL before/after the run; its sidecar (pid 234719 → :9224, chrome-headless-shell pid 234871) untouched and still listening at the end. Harness chain fully swept: 0 leftover processes, port 9324 clear, isolated data dir intact only under /tmp/opencode/m6-t0.
- **Cost:** ONE live task run total (budget was 2–3); the run reproduced the split on the first attempt and artifacts provided the timestamp correlation in lieu of a second run.

### §0.6 Harness recreation notes (non-persistent, /tmp/opencode/m6-t0/)

- `harness.mjs` — instrumented harness (this is test-only, lives in /tmp, NOT committed). Semantics per M5 checkpoint §1.A-4 and §1.C (isolated daemon, newline JSON-RPC 2.0 over `<dataDir>/daemon.sock`, isolated workspace, needle-scoped sweeps, prod-md5 invariance) PLUS the T0 instrumentation: previewInfo/CDP/captureFrame poll loops, transient JPEG dumps, artifact dump `m6t0-run1-artifacts.json` (transcript, timelines, final classification) and saved frames under `frames/`.
- **Harness deviations from M5 harnesses (all harness-side, recorded for recreation):**
  1. `setup-dev-provider.mjs` must run AFTER the daemon is up — it pushes the provider via `<dataDir>/daemon.sock` RPC (first attempt died with ENOENT).
  2. `DEV_BROWSER_PROFILE` is set to the isolated data dir — the sidecar otherwise resolves its Chromium profile under `~/.accomplish/dev-browser/profiles/` (shared with the live production sidecar; the source tree's `process.cwd()/.browser-data` fallback is NOT what the current dist does). This keeps the harness Chromium fully disjoint from production's.
  3. Known harness bug (harmless): the final needle-matching sweep matches the harness's own `node harness.mjs …` pipeline (cmdline contains `/tmp/opencode/m6-t0`) and SIGKILLs it at the very end — artifacts are already written and flushed when this happens; exclude `process.pid`/own pipeline PIDs when rerunning mid-run sweeps. The sweep never touched any process outside the BASE needle: production pid 3945 and sidecar 234719/234871 verified alive and unchanged.
  4. `/json/list` discovery follows the brief: read the DevToolsActivePort file under the profile dir (harness-scoped by deviation 2), poll `http://127.0.0.1:<ephemeral>/json/list` — read-only, same-user, loopback-only. No sidecar token read, no production data-dir access.
- **Artifacts (current session):** `/tmp/opencode/m6-t0/m6t0-run1-artifacts.json` (full evidence), `harness.log`, `frames/*.jpg` (byte-identity proof), `data/opencode/opencode-m6t0-run1.json` (generated config — `mcp.dev-browser-mcp.environment` = token+port only; CDP_ENDPOINT absent → builtin mode confirmed for THIS run).

## §1 — M6-A T2: pending-request persistence + reply-after-restart auto-resume (2026-10-24)

### §1.1 What landed

- **v033 migration** (`packages/agent-core/src/storage/migrations/v033-task-pending-request.ts`): nullable `tasks.pending_request` TEXT column; `CURRENT_VERSION` 32→33; released migrations untouched. Idempotent add (PRAGMA gate, v031/v032 convention).
- **Record shape (D4, plan-literal):** `{kind:'permission'|'question', requestId, question?, header?, options?, multiSelect?, createdAt}`. Written by `task-callbacks.onPermissionRequest` ONLY on the park branches (assistance questions → `waiting_for_user`, clarifications/tool/file permissions → `waiting_permission`); auto-deny branches persist nothing.
- **Secret hygiene (§6.4):** `createPendingRequestRecord` (agent-core `common/task-assistance.ts`) redacts every text surface via the universal `redact()` BEFORE the length caps (question ≤2000, option/description ≤2000, header ≤200); tool input, file paths, previews are deliberately dropped — the record is card-context only. Corrupt JSON in the column degrades to `null` (card just doesn't restore; task reads never fail).
- **Lifecycle clears:** live `sendResponse`, `complete`, `error`, `cancelled` (TaskService constructor listeners), `permission.respond` dead-pending claim, and crash-recovery `running→failed` flips. `saveTask` PRESERVES the stored record when the caller's task object carries no `pendingRequest` field (wiping it would silently break restart recovery); explicit `null` clears, explicit value sets/replaces.
- **Reply-after-restart (D5):** `TaskService.respondToPersistedPendingRequest`, wired into the `permission.respond` route when `taskService.hasActiveTask` is false. Precondition chain (each a distinct loud error): active/queued → live path required; unknown task → exact pre-T2 parity message (pinned by the parity suite); `resuming` → single-flight (second reply may not restart the resumption); non-`waiting_for_user` → expired-family, **never replayed** (D5: no fake allow/deny; UI offers the existing manual Resume affordance — this covers permission-kind rows AND clarification questions); `waiting_for_user` without a record (pre-T2 row) → safe refusal; stale requestId → rejected with the row untouched; missing sessionId → refuse to claim (row stays parked).
- **Single-flight mechanics:** new storage repo fn `claimPendingRequestForResume(taskId, expectedRequestId)` — read-then-conditional-`UPDATE tasks SET status='resuming', pending_request=NULL WHERE id=? AND status='waiting_for_user'` with the `changes` counter as the win-check. better-sqlite3 is synchronous per process, so two concurrent replies either diverge at the status read (`resuming` → single-flight error) or at the winner-check (changes=0 → claim error); both lose loudly, exactly one resumption.
- **Continuation prompt (D5):** `buildAssistanceContinuationPrompt` — question ≤2000, answer ≤4000, template fixed:
  `The human replied to your assistance request.` / `You had asked: <question>` / `The human replied: <answer>` / `Continue the task exactly where it left off, acting only on what the human confirmed.` Resumes the ORIGINAL persisted sessionId + cwd via the M4 `resumeSession` plumbing; the prompt is appended to the task's message history.
- **D3 honesty, restart flavor:** a dead-pending reply with NO answer (deny/allow, empty payload) is a DECLINE — the task is marked `failed` with the shared `ASSISTANCE_DECLINE_REASON` ("Human assistance declined — verification not completed"), row cleared, `complete` emitted with `status:'error'`. The adapter live-cancel mapping now also imports the shared constant (byte-identical string, one source).
- **API surface:** `TaskStorageAPI` gained `getTaskPendingRequest` / `updateTaskPendingRequest` / `claimPendingRequestForResume`; `StoredTask`/`Task` gained optional `pendingRequest` (already flows through the allowlisted `task.get`/`task.list` reads); exports via `index.ts` + browser-safe `common.ts`.

### §1.2 Plan deviations / decisions made during T2

1. **Deny-without-answer after restart = honest decline (failed), not a resume.** D5 covers answered replies only; a decline cannot be "delivered" to a dead adapter, so the D3 mapping is applied instead. Documented as the deterministic dead-pending rule: answer present → resume; no answer → decline-failed.
2. **Clarification questions after restart are NOT auto-resumed.** D5 scopes the resume to `waiting_for_user` rows (assistance questions only); clarification replies get the same expired-family rejection as permission rows (deterministic, no silent discard, UI explains).
3. **Continuation answer is persisted** as part of the (existing) task-message history via `resumeSession`'s standard `addTaskMessage` — the same class as any user chat message in that DB; the record column itself never stores answers.
4. **Route wiring detail:** the plan lists the dead-pending path under `task-service.ts`; the actual branch point is the `permission.respond` route's `hasActiveTask` gate (`daemon-routes.ts`) with the guardrails in `TaskService.respondToPersistedPendingRequest` (which re-checks activeness defensively). The unknown-task error message is byte-identical to the pre-T2 guard message.
5. **`task.getPendingRequest` daemon/host route is T4** (plan: T4 "zod route + allowlist + §5.4 paired tests"); T2 adds NO new RPC method, NO allowlist entry, NO policy edits. The restore surface already reachable by T3 is the additive `pendingRequest` field on `task.get`/`task.list`.

### §1.3 Test evidence (this task's HEAD)

- agent-core: 844 passed / 1 skipped (66 files) — includes new `v033.test.ts` (5), `task-pending-request.test.ts` (9, incl. close/reopen restart recovery + single-flight claim matrix), `common/task-assistance.test.ts` (13, incl. redaction-before-cap, multi-question answer determinism, 2000/4000 caps).
- daemon: 368 passed (28 files) — includes new `pending-request-recovery.unit.test.ts` (13, on REAL sqlite + fresh-TaskService-per-test restart simulation: happy-path auto-resume, double-reply, concurrent-reply allSettled (exactly one fulfilled), stale-id, permission-kind no-replay (Allow AND Deny), terminal races, in-flight single-flight guard, no-answer decline, unknown-task parity, pre-T2 row, no-session refusal, multi-question losslessness, route wiring contract, live-reply row clear) and extensions to `task-callbacks` (persist-on-park / never-on-auto-deny), `crash-recovery` (clear on running→failed; waiting rows keep theirs), `task-service-parity` + `presence-gate` fixture updates.
- Full battery at T2 HEAD: host 332 ✓ · daemon 368 ✓ · agent-core 845 total ✓ · web unit 491 ✓ · web integration 158 passed / 61 failed (exact upstream baseline — untouched) · desktop 522 ✓ · typecheck 5/5 ✓ · eslint 0 errors / 3 documented pre-existing warnings ✓ · prettier ✓.

### §1.4 Known bounds carried to T3–T8

- The adapter surfaces only `question.asked`'s FIRST question on the wire (committed T1 behavior); a native multi-question ask persists/replies that one. Answer-side determinism is lossless for what the UI sends. If live T7 behavior shows dropped questions, Option-A-class follow-up belongs to T6 findings.
- No wait-expiry sweep (D6) — unchanged; waiting rows live until answered/declined/terminal.
- `stopTask` on a restart-survived waiting task is a no-op today (pre-existing M4 shape): the T3 restored card's Cancel must route through the dedicated decline path (T2 `respondToPersistedPendingRequest` no-answer branch) rather than `task.cancel`.

## §2 — M6-A T3: UI assistance mode (2026-10-24)

### §2.1 What landed

- **Restore path (`apps/web/src/client/stores`):** `loadTaskById` calls the new `restorePendingRequestFromTask` action — one-shot per task open/reconnect (the record rides the already-allowlisted `task.get` payload, zero new RPC fan-out per plan §6.9; wired via the `onDaemonReconnected` handler that exists in `useExecutionEvents`). Seeding requires: `pendingRequest` present, status `waiting_permission`/`waiting_for_user`, no live entry in `permissionRequests` (a live `permission.request` notify always wins), and a question-kind record with a `requestId`.
- **Replay discipline surfaced in the UI (D5):** permission-kind records are NEVER seeded into Allow/Deny cards — the record dropped tool input/file paths by design (D4), so a restored permission card would be an unsafe "unknown allow". A task parked at a waiting\_\* status with no displayable card shows the inline `pending-request-notice` (`PendingRequestExplainer` on a Card in `ConversationView`): "This request can no longer be answered… pending permission decisions are never replayed. Resume the task to continue — the agent will re-request anything it still needs." plus the Resume button.
- **Card restore marker:** `restoredRequestIds` marks seeded cards so `PermissionDialog` shows the restored hint; `setPermissionRequest` (live notify) drops the marker; `respondToPermission`, `clearPermissionRequest`, `clearScopedTaskState` / `clearAllTaskScopedState` (task delete / history clear) and the `updateTaskStatus` `resuming`/`running` release path all remove card + marker + error together.
- **Assistance card variant (`PermissionDialog.tsx`):** `isAssistanceRequest` (D2 structural equality on the shared `ASSISTANCE_QUESTION_HEADER`) switches the question card to the assistance layout — `Hand` icon, title "Human assistance required", an explainer block (verification gate, never bypassed/automated, only the human can act), wait-age chip (D6, `formatWaitAge`, static per render; "· 5m" style), restored hint when applicable, and Decline / Submit reply buttons (`data-testid` `permission-deny-button` / `permission-allow-button` preserved so tooling stays stable). Tool/file cards keep Allow/Deny byte-identically; clarifying questions keep Cancel/Submit byte-identically (their dedicated unit suite is untouched and green).
- **Guardrail-rejection handling (D5 error states):** `respondToPermission` now CAPTURES a thrown response (instead of leaking an unhandled rejection) and records the stable daemon message in `permissionRequestErrors[taskId]` — only when the responded card still matches the requestId, and guarded by the store state token. The card renders `PendingRequestExplainer` instead of the reply controls (no Allow/Deny replay surface) with the raw daemon message shown and Resume + Dismiss buttons; Dismiss re-reveals the reply controls (retry permitted — the daemon guardrails re-check). Applies to restored AND live cards (a genuinely live reply never hits this; only dead-pending/stale replies do).
- **Waiting/resumption states:** `ExecutionHeader` status badges for `waiting_for_user` ("Needs your reply", `execution-waiting-for-user-label`) and `resuming` (spinner + "Resuming"); `status.waiting_for_user`/`status.resuming` locale keys added to en/fr/ru/zh-CN (alignment suite green). The decline→`failed` mapping (D3) shows the honest reason via the existing complete-footer alert because T2 emits `complete` with `ASSISTANCE_DECLINE_REASON`.
- **Shim surface deviation (recorded):** T3 does NOT add the `task.getPendingRequest` shim method — the parity-audit self-check (`parity-audit.mjs:1176`) requires shim `call(...)` targets to be allowlisted, and the route+allowlist entry are T4 (committed separately with its §5.4 pairing: zod route, 401/403, scrubber/no-secret, redaction, tripwire 98→99). The restore path uses the T2-committed `pendingRequest` field on `task.get`/`task.list` (T2 checkpoint §1.2 note 5 documents this as the restore surface for T3). At T4, `PendingRequestExplainer`/restore does not need code changes — the field path remains the data source; the dedicated RPC becomes available for future consumers.

### §2.2 Test evidence (this task's HEAD)

- web unit: **533 passed (34 files)** — baseline 491 + 42 new: `lib/assistance-requests.unit.test.ts` (13 — D2 equality incl. tool/file rejections, record→card reconstruction incl. non-question/missing-id nulls, wait-age formatting incl. future/invalid inputs), `stores/task-permission-actions.assistance.unit.test.ts` (14 — restoration matrix, live-wins-over-restored, no-overwrite, non-waiting skip, permission-kind never seeded, success clears card+marker+error with the pre-existing newer-request guard, rejection captured, error released by `updateTaskStatus` resuming/running), `components/execution/PermissionDialogAssistance.unit.test.tsx` (12 — assistance title/explainer/wait-age/restored hint, Decline/Submit-reply semantics incl. option + free-text payloads, submit disabled until answered, clarification-unchanged pin, expired-state replaces controls w/ resume + dismiss-reveals-retry), `pages/execution/ExecutionHeader.unit.test.tsx` (3 — waiting_for_user / resuming / waiting_permission labels).
- Full battery at T3 HEAD — zero regressions vs T2 and M5 baseline: host 332 ✓ · daemon 368 ✓ · agent-core 844/1skip ✓ · desktop 522 ✓ · web integration 158 passed / 61 failed (exact upstream baseline — untouched) · typecheck 5/5 ✓ · eslint 0 errors / 3 documented pre-existing warnings ✓ · prettier ✓ · parity audit allowlist 98 unchanged ✓.

### §2.3 Known bounds carried to T4–T8

- The explainer's Resume button routes through the pre-existing `handleContinue` (`useExecutionPauseActions.resumePausedTask('continue')` → `sendFollowUp` → daemon `session.resume`), which is the M4 recovery affordance; it is NOT the T2 single-flight claim path (that fires only on an actual `permission.respond`).
- `sendFollowUp` requires a persisted `sessionId`; a waiting row that somehow has none (never happens for M4+ assistance asks — sessionId is set at first turn) would surface the "No session to continue" store error rather than a bespoke message. Acceptable v1.
- Stale-card clicks on a terminal task (e.g. deny after auto-deny already resolved the task) surface the expired-family explainer via the daemon's stable error — no card auto-dismisses on terminal status; unchanged M5 behavior.
- Live-daemon clarification/permission restores were unit-simulated only; real-Firefox live behavior (card + answer on a parked task after page reload) awaits T6 E2E / T7 manual checklists.
- `task.getPendingRequest` RPC remains unavailable until T4; if a consumer calls `getPendingRequest` on the AccomplishAPI before T4, the method is absent (optional interface member) rather than failing.

## §3 — M6-A T4: host route + allowlist entry + Firefox interface connection (2026-10-24)

### §3.1 What landed

- **Daemon route (`apps/daemon/src/daemon-routes.ts`):** new `task.getPendingRequest` zod route (`taskIdSchema` → `{ pendingRequest: PendingRequestRecord | null }`), registered next to `task.get`. Pure storage read via `StorageAPI.getTaskPendingRequest` (T2 surface): the §5.4(a) response carrier is `{ pendingRequest: { kind, requestId, question?, header?, options?, multiSelect?, createdAt } | null }`; a corrupt stored record degrades to `null` (the store's `parsePendingRequestRecord` contract), so a card restore never fails a read. No mutation anywhere — the live-reply path (`permission.respond`) is untouched.
- **Host allowlist (`apps/host/src/policy.ts`):** EXACTLY one new entry, `task.getPendingRequest` (98 → 99), with the §5.4(a) response-shape comment and the §6.9 consumption note ("one-shot read per task open/reconnect; the assistance card re-reads on `task.statusChange` only"). **Blocklist byte-identical (7)**; no `ACCOMPLISH_PERMISSION_POLICY`/presence-gate/scrubber-internals edits.
- **Firefox interface connection (the T3-planned shim work, per the §2.1 deviation):**
  - `accomplish-http.ts` shim `core` gains `getPendingRequest(taskId)` → `task.getPendingRequest` (the 89th distinct `transport.call` target), unwrapping the `{ pendingRequest }` carrier to the record (missing carrier → `null`, never a throw).
  - `accomplish.ts` `AccomplishAPI` gains `getPendingRequest?(taskId): Promise<PendingRequestRecord | null>` — **optional** member (the Electron preload is byte-frozen; callers must guard). `PendingRequestRecord` imports from the browser-safe `common` barrel.
  - **Store route consumer (`task-permission-actions.ts`):** new `refetchPendingRequest(taskId)` action, wired from the execution page's `task.statusChange` subscription (`useExecutionEvents`) when a task parks at a waiting status — the §6.9 "the assistance card re-reads on task.statusChange only" pattern. Guardrails: method-presence guard (Electron no-ops), state-token guard, post-await fresh-status re-check (a task that resolved mid-read never gets a stale card), live notify always wins (`setPermissionRequest` drops the restored marker), failed read logs a warn and returns (never throws), permission-kind records are never seeded (T3 replay discipline shared via the extracted `seedPendingRequestCard` core).
  - The T3 field-path restore (card seeding from the `pendingRequest` field on the allowlisted `task.get`/`task.list` payloads via `loadTaskById`) remains the open/reconnect data source — byte-identical behavior, zero new fan-out on task open.
- **Parity audit:** `parity-audit.mjs` updated (M6-A deltas in `EXPECTED`, `DOMAIN_METHODS` tasks +1, `SHIM_RPC_MAP` +1, new sanity check `getPendingRequest implemented over the allowlisted task.getPendingRequest route`), `docs/PARITY_INVENTORY.md` regenerated: **declared 250 · shim implemented 142 · allowlist 99 · blocklist 7 · daemon registered 138 · shim-call ⊆ allowlist self-check PASS (89 targets)**. The M2 "204 top-level" render literal is now parsed dynamically (`parsed.topLevel.length`).

### §3.2 Test evidence (this task's HEAD)

- daemon: **375 passed (29 files)** — 368 T2 baseline + 7 new `daemon-routes-task-pending-request.test.ts` tests (route registration, zod missing/empty taskId rejection, record-carrier verbatim, corrupt→null degradation, REAL-SQLite restart-restore through the route handler: park → close DB → reopen fresh storage → route returns the record; post-clear null carrier).
- host: **340 passed (16 files)** — 332 baseline + 9 new: policy.test.ts (+1 M6-A authorization test pinning `task.getPendingRequest`, blocklist exact-array byte-shape, +1-total discipline; **tripwire updated 98 → 99** with the M6 note), gateway.test.ts (+4 — M6-A T4 describe: proxied wire-shape proof incl. no `"apiKey"`/`toolInput` in bytes, 401 without auth, forged-policy pairing, wrapper-relay stability), gateway-scrub-redaction.test.ts (+2 — secret-shaped field stripping anywhere in the record while card context survives; daemon-side `[REDACTED]` marker passthrough proof), integration (+1 — real gateway ↔ real daemon answers `{ pendingRequest: null }`).
- web unit: **546 passed (34 files)** — 533 T3 baseline + 13 new (accomplish-http shim: route mapping + unwrap + null/missing-carrier degradation — 4; permission-actions: route re-read matrix incl. live-wins, stale-status guard, Electron no-op, failed-read warn, permission-kind never seeded, stale-error drop — 9).
- Parity audit self-checks: **PASS** (shim-call ⊆ allowlist; allowlist ⊆ registered).
- **Restoration matrix (instruction 5):** daemon restart mid-wait → waiting row + `pending_request` survive (crash-recovery skips waiting rows — M4, byte-identical) → route returns the record through reopened storage (new daemon test) → UI rebuilds the card on task open / gateway reconnect (T3 `loadTaskById` field path) and on waiting statusChange re-reads (T4 route path), both unit-pinned.
- **Allow/Deny regression (instruction 7):** daemon suite green including the T2 pending-request-recovery matrix (permission-kind rows are NEVER replayed with Allow OR Deny; live sendResponse contract pinned), the task-service-parity message pins, and presence-gate fixtures; desktop suite 522/522 (Electron bridge untouched); web unit green including the untouched clarification/tool/file PermissionDialog suites. The live-model gateway E2E (40-task-approve / 50-task-deny) re-run is the T6 battery gate per plan §5.
- **Full battery at T4 HEAD** — zero regressions vs T3/M5: host 340 ✓ · daemon 375 ✓ · agent-core 844/1skip ✓ · desktop 522 ✓ · web unit 546 ✓ · web integration 158 passed / 61 failed (exact upstream baseline — untouched) · typecheck 5/5 ✓ · eslint 0 errors / 3 documented pre-existing warnings ✓ · prettier ✓ · parity audit allowlist 99 ✓.

### §3.3 Plan deviations / decisions made during T4

1. **Interface member is OPTIONAL (`getPendingRequest?`)** — plan §4 said "accomplish.ts + accomplish-http.ts (+ shim method)" without optionality; the Electron preload is M6 byte-frozen, so an optional member (browser-preview pattern) is the only safe shape for a shared interface; the store's consumer guards presence.
2. **The T3 store restore path keeps riding `task.get`** (T2 checkpoint §1.2 note 5 + §2.1 deviation, honored): no change in restore semantics, no extra fan-out per task open; the dedicated route's actual consumer is the NEW §6.9 statusChange re-read (`refetchPendingRequest`) plus future consumers (T6 E2E / M6-B).
3. **Tripwire comment extended, not rewritten** — the 98→99 pin keeps the full per-milestone ledger; M6-A's §6.2 "allowlist grows EXACTLY +1" is asserted both by the count and by the new blocklist exact-array test.

### §3.4 Known bounds carried to T5–T8

- The statusChange re-read fires once per waiting transition; a second ask replacing the first while parked re-parks via the daemon's own second `permission.request` notify (live) — the routed record at that instant is the SECOND ask (the daemon overwrote the row on the new park), so a re-seed races only the notify, losing to it by design.
- `refetchPendingRequest` resolves records for clarification questions parked at `waiting_permission` as well (same D4 record); the card copy differentiates assistance vs clarification via the existing D2 header equality (unchanged T3 logic).
- Electron (desktop) has no `getPendingRequest` — intentional; if M6-B ever promotes the bridge, the §5.4 discipline applies to that surface too.
- Live-Firefox verification of the restored card + route (real reload/restart mid-wait) is T6 E2E (`35-`/`36-` specs) + T7 manual checklist.

## §4 — M6-A T5: preview-seam fix — the agent-active page identity (2026-10-24)

### §4.1 What landed

- **Primary fix — identity repair in the generated config (checkpoint §0.3 layer 1).** `taskId?: string` added to `BuildMcpServersOptions` (`generator-mcp.ts`) and `ConfigGeneratorOptions` (`config-generator-types.ts`); `generateConfig` threads it into `buildMcpServers`, which sets `browserEnv.ACCOMPLISH_TASK_ID = taskId` on `mcp['dev-browser-mcp'].environment` (builtin AND remote modes; alongside the M1 token and M5 port threadings, all unchanged). `ResolveTaskConfigOptions.taskId?` copied verbatim into `configOptions`; the daemon's `onBeforeStart` passes `ctx.taskId` (`task-config-builder.ts`). Effect (D7 by construction): the child's `getFullPageName()` produces `<taskId>-main` — the SAME key `DevBrowserService.captureFrame` resolves — so `ensurePage` name-dedupe keeps ONE page and the preview captures the tab the agent drives. This also fixes the child's screencast `taskId` (`index.ts` reads the same env). The transient OAuth path (empty ctx) omits the env and keeps the child's standalone `default` identity — intentional.
- **Defense-in-depth — fail-loud instead of silent-`default` (checkpoint §0.3 layer 2).** `warnOnceOnMissingTaskIdentity()` in `dev-browser-mcp/src/connection.ts`: when `ACCOMPLISH_TASK_ID` is absent AND `ACCOMPLISH_DEV_BROWSER_TOKEN` is present (authenticated daemon context, per the §0.3 heuristic), one loud stderr warning (opencode surfaces MCP child stderr in its logs) naming the seam, the `default-main` divergence, and the required config threading. Guarded once-per-process (reset via `resetConnection` for tests; the guard resets AFTER the rebuild inside `resetConnection` so the reset itself never double-warns). Declaration placed BEFORE the module-load singleton init (`let _config = buildConfigFromEnv()`) — the load-time call may warn. Standalone dev launches (no token) stay silent; the `|| 'default'` fallback contract is byte-identical.
- **No sidecar changes.** `BrowserPageService.ensurePage` name-dedupe WAS and IS the load-bearing mechanism — one key now arrives from both writers, so zero dev-browser package changes were needed and the sidecar HTTP/WS auth surface (loopback + bearer + first-message) is byte-identical.
- **Optional §0.3 layer 3 (captureFrame cross-check breadcrumb) NOT implemented — decided.** A pages cross-check per 750 ms poll would add a third sidecar HTTP fetch per preview poll (§6.9 no-new-fan-out discipline, §5.4 policy if the sidecar info route grew a payload). The fail-loud child warning covers the regression-detection role at zero runtime cost. Recorded as design, not a gap.

### §4.2 Test evidence (this task's HEAD)

- **agent-core: 849 passed / 1 skipped (66 files)** — T4 baseline 844+1 + 5 new: `generator-mcp.test.ts` (+3: env threading alongside token/port, remote-mode threading, omit-on-transient-path) and `config-generator.test.ts` (+2: `generateConfig` writes `mcp['dev-browser-mcp'].environment.ACCOMPLISH_TASK_ID`, omits when no taskId).
- **dev-browser-mcp in-package: 116/116 (8 files)** — baseline 111 + 5 new connection tests: token+missing-taskId warns exactly once with the seam explanation, resets via `resetConnection`, silent for standalone launches (no token), warns in remote mode too, blank-string env keeps the `default` fallback byte-identical.
- **daemon: 380 passed (29 files)** — T4 baseline 375 + 5 new: `task-config-builder.unit.test.ts` (+2: `ctx.taskId` → env `ACCOMPLISH_TASK_ID` through the REAL `resolveTaskConfig`+`generateConfig` chain; empty-ctx omit with relay-port still threaded) and `dev-browser-service-capture.test.ts` (+3, stub sidecar upgraded with registry-faithful name-keyed mint/dedupe + CDP attach-targetId recording): both writers share ONE `<taskId>-main` entry and every capture attaches exactly its targetId; different key still mints a second tab (pre-fix split signature as stub-fidelity control); legit secondary page stays isolated from the main capture.
- **dev-browser in-package: 36/37 parallel** — the single failure is the documented M5 §23.5#3 `relay.test.ts` first-message-exchange parallel-run flake (reproduces identically with the fix stashed; **12/12 in isolation**; T5 touched no dev-browser package file). Unchanged watch item.
- typecheck 5/5 · eslint 0 errors / 3 documented pre-existing warnings · prettier clean.
- **Live harness re-run (`/tmp/opencode/m6-t0/harness.mjs`, §0.4 recipe, one run `m6t0-t5run1`, glm-5.3-flash:cloud, headless/display-less, isolated on :9324):**
  - Generated config dump `data/opencode/opencode-m6t0-t5run1.json` → `mcp.dev-browser-mcp.environment` = `{ACCOMPLISH_DEV_BROWSER_TOKEN, DEV_BROWSER_PORT: "9324", ACCOMPLISH_TASK_ID: "m6t0-t5run1"}` (the fix, live).
  - **Registry = `["m6t0-t5run1-main"]` end-to-end — the two-tab split is GONE** (T0 signature: `["m6t0-run1-main","default-main"]`; no `default-main` anywhere).
  - **`previewFinal.targetId === cdpFinal[0].id` (`85BE22EA…`) — capture targetId === agent-active targetId** through a complete two-navigation task; final target title "About us" (`https://www.iana.org/about`), task COMPLETE `status:success` with both headings extracted ("Example Domains", agent-reported h1 extraction).
  - Frame evolution (vs T0's byte-frozen blank canvas): initial polls blank (~6–8 KB, correct pre-navigation), then 12943 → 92970 → 93427 bytes as the agent's navigations land; final frame = the iana.org/about render. 100/100 captureFrame polls ok (T7 zero-miss property preserved).
  - Production invariance: prod daemon pid 3945 cmdline md5 `e01fee9f…` identical pre/post (same value as §1.5/§0.1); prod sidecar (pid 234719, :9224) untouched; harness chain fully swept, port 9324 clear, artifacts under `/tmp/opencode/m6-t0/` only.

### §4.3 Plan deviations / decisions made during T5

1. **T5 is env-threading, not a registry redesign** — §0.3's two-layer recommendation executed as written; D7's "sidecar-authoritative identity" is achieved by construction (one key), so no `context.newPage()` gating and no sidecar-owned target registry were needed. Hypothesis-1's "registry-external creation" mechanism never existed (T0 finding); the mechanics honor the refinement.
2. **`taskId` set in both builtin and remote browser modes** — remote cloud browsers don't use the sidecar registry, but the child's local page naming/prefix logic reads the same env; setting it keeps `listPages` prefixes consistent upstream of mode.
3. **§0.3 layer 3 declined** (see §4.1) — rationale recorded there; revisit only if the sidecar info route is ever extended for another reason.

### §4.4 Known bounds carried to T6–T8

- The preview poll STILL self-heals via `openPreviewPage`-first (unchanged `captureFrame` ordering); with one shared identity that ordering is now harmless (re-ensures the agent's own page).
- The transient OAuth path's opencode child (if it ever invoked a browser tool) would legitimately run under the silent standalone `default` identity; no production path invokes browser tools during OAuth today.
- Real-Firefox headful preview rendering (the user-visible panel showing live navigation) is the T7 manual item 9 — the harness proves the target identity; pixel-level verification in the real UI remains human-confirmed per M6 plan §7.9.
- The in-package relay flake (M5 §23.5#3) is unchanged and still out of scope.

## §5 — M6-A T5 defect: failed real-Firefox acceptance — stale production daemon (2026-10-24)

### §5.1 The failure and the pipeline trace

**User report:** a real task ("Navigate to https://www.iana.org/about and tell me the main heading") completed successfully ("About IANA"), but the Firefox Browser Preview showed a **plain white screen the whole task** with the green Live indicator.

**End-to-end trace (every stage verified healthy except writer identity):** agent CDP actions → sidecar registry (name-keyed; unchanged machinery) → daemon `DevBrowserService.captureFrame` (openPreviewPage ensure → GET / → CDP attach + `Page.captureScreenshot`) → host gateway `devBrowser.captureFrame` (allowlisted) → web shim 750 ms poll fan-out (`accomplish-http.ts` `previewCaptureOnce` → `dispatchPreviewFrame`) → component `handleFrame` → `imgRef.src = data:image/jpeg;base64,…` (useBrowserPreview.ts). Delivery and rendering were HEALTHY (green Live, zero 3-miss client-log breadcrumbs): the component painted exactly the frames the daemon sent — **white frames of a blank tab**. Frames were blank at CAPTURE; not lost in transport, not mis-rendered.

### §5.2 Root cause — production daemon kept pre-T5 in-memory code (a live process never reloads a rebuilt dist)

The T5 fix was verified (isolated harness: fresh daemon from the rebuilt dist → single registry page, capture targetId === agent targetId) but **never executed in production**:

| Evidence (read-only, same-user)                                                                                                                     | Finding                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ps -o lstart= -p 3945`                                                                                                                             | production daemon **started Fri Oct 23 14:32:45** — M5-T7 era; ran continuously through the M6 task                                                                                                                                                                               |
| dist mtimes                                                                                                                                         | T5 artifacts built **23:30:55–57**; commits `2263d6f`/`5ff9ed2` at **23:46** — ~9 h AFTER the daemon booted. Node loaded its modules once at boot; the rebuilt dist never reached the running process                                                                             |
| Generated config artifact `~/.local/share/Accomplish/opencode/opencode-task_1792813755767.json` (user's task, written 23:49:15 by the stale daemon) | `mcp.dev-browser-mcp.environment` = `{ACCOMPLISH_DEV_BROWSER_TOKEN, DEV_BROWSER_PORT}` — **NO `ACCOMPLISH_TASK_ID`** — the pre-T5 two-writer split regenerated verbatim                                                                                                           |
| opencode child log `opencode/log/2026-10-24T034916.log:113`                                                                                         | **the T5 fail-loud canary FIRED** in the real run: `[dev-browser-mcp] WARNING: ACCOMPLISH_DEV_BROWSER_TOKEN is set but ACCOMPLISH_TASK_ID is missing…` (+`:117` `ACCOMPLISH_TASK_ID: (not set)`) — the child fell back to `default-main` exactly as designed for defense-in-depth |
| Production sidecar CDP `/json/list` (token-free, read-only)                                                                                         | residue: **2 × `about:blank` + `'About us'` https://www.iana.org/about** — the blank captured tab(s) and the agent's actual page, still parked                                                                                                                                    |
| journald `accomplish-fox-daemon.service`                                                                                                            | only `[Browser] Dev-browser server already running (token verified)` — attaching the (unchanged, 20:23-built) sidecar; sidecar code is NOT part of the fix                                                                                                                        |

**Verdict:** T5's code is correct and was proven correct live in the harness; the deployment seam — _rebuild-without-restart_ — is a NEW defect class the harness cannot see by construction (fresh process, fresh dist). The user task at 23:49 ran entirely under pre-T5 identity semantics. Frames blank at capture; transport/render pipeline exonerated.

### §5.3 What landed (instrumentation + regression tests; no behavior change to browser isolation)

1. **Daemon runtime breadcrumbs (`DevBrowserService.captureFrame`) — journald now sees page identity:**
   - per-tick `logger.debug` trail: taskId, page name, full registry name, targetId (8-char short form), frame **byte length**, duration. No frame data, no URLs (M2 T4 pattern).
   - **one-shot-per-task WARN** (`checkRegistryIdentityOnce`): at the first successful capture, one best-effort GET /pages; a `default-*` registry name beside the captured key is the stale-build fingerprint → loud divergence WARN with a rebuild+restart hint. At most one GET per task per daemon process — no steady-state fan-out; capture stays self-healing; leftover older-task pages are correctly NOT flagged (legit multi-page/other-task residue).
2. **Daemon generation-time breadcrumb (`task-config-builder.verifyDevBrowserChildIdentity`)**: after `generateConfig`, with a real ctx taskId and a token-bearing browser env, the threaded identity logs INFO (`…child identity threaded: ACCOMPLISH_TASK_ID=<taskId>…` — the user-visible restart-confirmation line); a token present but identity missing logs a LOUD WARN naming the build/restart remediation. Empty ctx (transient OAuth) emits nothing.
3. **Regression tests reproducing the failure class:**
   - `packages/agent-core/tests/unit/opencode/generator-dist-identity.test.ts` (2): compiled `dist/opencode/generator-mcp.js` (the module non-bundled consumers actually resolve — NOT the barrel) carries the ACCOMPLISH_TASK_ID threading; bundled `mcp-tools/dev-browser-mcp/dist/index.mjs` carries the identity reader + canary warning. Skip-with-message when artifacts are absent.
   - `apps/daemon/__tests__/unit/daemon-dist-identity.test.ts` (1): the daemon bundle the production unit loads (`node apps/daemon/dist/index.js`) contains the threading + both new breadcrumb markers.
   - `apps/daemon/__tests__/unit/task-config-builder.unit.test.ts` (+3): journald INFO fired with the exact taskId; **stale-build simulation** (hoisted hook strips ACCOMPLISH_TASK_ID from the REAL generator's output → the WARN fires with taskId + "RESTART the daemon" remediation, no INFO); empty ctx emits neither.
   - `apps/daemon/__tests__/unit/dev-browser-service-capture.test.ts` (+2, registry-seeded stub): the divergence fingerprint (a seeded `default-main` beside `tsk_diag-main`) fires the WARN exactly once (older-task leftovers deliberately ignored) with context only; no divergence → silent.

### §5.4 Suite evidence (this task's HEAD)

- agent-core **851 passed / 1 skipped** (67 files; +2 artifact-freshness) · daemon **386 passed** (30 files; +5 breadcrumbs/identity tests +1 daemon-bundle freshness; dist rebuilt so the freshness assertions hold against the current bundle) · dev-browser-mcp in-package **116/116** · dev-browser in-package unchanged (36/37 parallel, relay flake documented) · typecheck 5/5 · eslint 0 errors / 3 pre-existing warnings · prettier clean.

### §5.5 Manual verification procedure (user-run; executed 2026-10-23/24 — see §5.6)

1. From the repo root: `pnpm --filter @accomplish_ai/agent-core build && pnpm --filter @accomplish/daemon build && pnpm --filter @accomplish/desktop build:mcp-tools:dev` (idempotent; ensures every artifact the unit loads is current).
2. `systemctl --user restart accomplish-fox-daemon.service` — the REQUIRED deployment step (pid 3945 was 9 h 18 m old; any restart loads the new bundle).
3. Confirm the fix is live BEFORE a task (journald positive breadcrumb is emitted at first task start): run one new browser task (e.g. the same iana.org/about prompt) and check
   `journalctl --user -u accomplish-fox-daemon.service | grep "child identity threaded"` → expect `ACCOMPLISH_TASK_ID=task_<id>`.
4. Preview panel in Firefox must show the agent's live navigation; negative check: `journalctl … | grep "identity divergence"` must NOT fire; the child canary warning must be absent from new opencode logs (`…/opencode/log/`).
5. Resident sidecar leftovers (older `about:blank`/task pages) are harmless for new tasks — they share no key; nothing needs restarting on the sidecar.

### §5.6 T5 status — **PASSED: real-Firefox acceptance confirmed by the user (2026-10-23/24, task `task_1792814312690`)**

The user executed the §5.5 procedure (rebuild → `systemctl --user restart accomplish-fox-daemon.service` at 23:58:14, new daemon pid 439523) and ran a new task navigating to the IANA About page. **User confirmation:** the task completed successfully, the agent reported the main heading "About IANA", and **the Browser Preview displayed the actual IANA webpage rather than a blank tab — matching the agent's navigation** (the M6 plan §7.9 condition re-verified; the M5 §23.5#1 directive is closed).

Live corroboration (read-only journald, same-user): at 23:58:33 the daemon emitted the §5.3-2 positive breadcrumb **twice** (start + resume config generations): `[OpenCode Config] dev-browser-mcp child identity threaded: ACCOMPLISH_TASK_ID=task_1792814312690 (M6-A T5 preview seam)`; the §5.3-1 divergence WARN **never fired**. Both negative checks clean.

**T5 fully verified**: harness + suites + artifact checks + production-configuration user acceptance all green. No known remaining seam limitations (watch items unchanged: relay.test.ts parallel-run flake; rebuild-before-restart discipline now guarded by artifact tests + runtime breadcrumbs).

## §6 — M6-A T6: E2E assistance coverage, restart soak, full battery (2026-10-24)

### §6.1 What landed

1. **`apps/host/e2e/specs/35-assistance-question.spec.ts` (2 tests)** — the LIVE same-session flow on the real ollama gateway (`glm-5.3:cloud`, serial chain fixture): a scripted `M6_ASSISTANCE` task that names a (simulated) login-wall/MFA gate → the agent calls `question` ONCE with the exact ASSISTANCE_QUESTION_HEADER → `execution-waiting-for-user-label` badge ("Needs your reply") + assistance card (`assistance-context`/`assistance-explainer`/`assistance-waiting-label`) → `task.status` = `waiting_for_user` and the allowlisted `task.getPendingRequest` returns the question-kind record (header equality, requestId, 2 options) → option click + Submit reply → card clears → (bash approval via the standard permission card) → terminal `completed` → the file contains `M6_ASSIST_CONTINUED_OK`, transcript carries the marker, **exactly one** matching task (no duplicate), `task.getPendingRequest` → `null` after the live reply. Companion test reopens the persisted task from history with the transcript and no card.
2. **`apps/host/e2e/specs/36-assistance-restart.spec.ts` (2 tests)** — the daemon-restart soak: assistance ask parked `waiting_for_user` (with sessionId persisted — see finding F1) → **SIGTERM to the pid-file daemon mid-wait** → graceful drain (parked row is NOT active-completed; adapter children die with the process) → the host's connector re-spawns the daemon (real launcher contract) → boot-time crash recovery leaves the waiting row **byte-identical** (status, sessionId, workingDirectory, pendingRequest.requestId all asserted equal via RPC after respawn) → fresh document load → assistance card restored **with the `assistance-restored-hint`** → answer (option + submit) → daemon routes `permission.respond` to the DEAD-pending guardrails → single-flight claim → `resuming`/`running` transition observed → `session.resume` on the **ORIGINAL sessionId** (asserted equal before/after) → post-resume bash approval → `completed`; **no duplicate execution**: the auto-resume continuation user message ("The human replied to your assistance request.") appears EXACTLY once, `task.getPendingRequest` → `null`, exactly one task in history, file created once. Companion history test reopens the task.
3. **T6-found defect F1 (daemon) — parked rows had no resumable session.** `session_id` only reached SQLite at `onComplete` (`task-callbacks.ts:159`), so a REAL restart while parked left the row unable to satisfy `respondToPersistedPendingRequest`'s "no persisted session — refusing to claim" guardrail; the T2 matrix seeded the row and never caught it. **Fix:** `markWaitingOnHuman` in `task-callbacks.ts` persists `taskManager.getSessionId(taskId)` at park time (both waiting kinds; auto-deny branches still write nothing; onComplete still overwrites with the final turn's session). 4 new tests in `task-callbacks.unit.test.ts` (`createTaskCallbacks — live session persisted on park (M6-A T6)`): assistance park ✓, waiting_permission park ✓, no-session null-safe ✓, auto-deny never writes ✓. Presence-gate fixture completed (its `{} as TaskManagerAPI` lacked `getSessionId`).
4. **T6-found defect F2 (web store) — restored hint lost for a page that survives the restart.** The daemon restart never reloads the SPA document; `daemon:reconnected` → `loadTaskById` → `seedPendingRequestCard` hit the "live notify always wins" guard and NO-OPed because the pre-restart LIVE card was still in `permissionRequests` — same requestId, but unre-marked, so T3's `assistance-restored-hint` never rendered (proven by a temporary per-document WS-frame recorder: zero notifications after reconnect; only the stale card). **Fix:** the shared seed core now replaces a live card whose id EQUALS the persisted record's requestId (the pre-restart ask — the record is the authoritative rebuild once the adapter is dead) and marks it restored; a DIFFERENT id (a genuinely newer live ask) still wins unchanged, byte-preserving T3/T4 replay discipline. 2 new tests in `task-permission-actions.assistance.unit.test.ts` (restart-analog same-id rebuild for `restorePendingRequestFromTask` AND `refetchPendingRequest`; all existing live-wins tests use disjoint ids and stay green untouched).
5. **Browser isolation unchanged** — T6 touched no dev-browser/sidecar/CDP file; spec 35/36 run browserless real-ollama tasks.

### §6.2 E2E evidence (real ollama gateway, isolated chain, serial)

- **Two consecutive full-suite green runs at this HEAD:**
  - Run 1 (17:18–17:25 UTC): **18/18 passed, 6.3 m** (14 baseline + 4 new).
  - Run 2 (17:25–17:32 UTC): **18/18 passed, 6.9 m** (back-to-back, same worker-per-file chain each).
- Live assistance records captured by the runs (redacted/capped D4 payloads on the wire):
  - 35 run 1: `questionreq_4fac5340…` header "Human assistance required", 2 options with descriptions, question text names the gate + what only the human can do; answer → completion, request consumed (`null` after).
  - 36 run 2: park sessionId `ses_e911…` == post-resume sessionId (SAME session reused byte-exactly); transitions `resuming/running → completed`; continuation message exactly once; file `M6_ASSIST_RESTART_OK` present.
- **Restart soak count:** 4 successful live restart-mid-wait → restored → auto-resume → completed cycles this session (2 standalone green runs of spec 36 + 2 in the consecutive suite runs), plus the 13-test REAL-SQLite restart matrix (T2) and the watchdog non-stall regression (T1) all green in the battery. "Soak: waiting rows survive + resume" is carried by live spec 36 + the unit matrix; no separate harness was written (plan T6 "IF fixture-stable" branch — the fixture WAS stable).

### §6.3 Full battery at T6 HEAD (vs T5 baseline — zero regressions)

| Suite                               | T5 baseline         | T6 result                                                                                  | Verdict                                            |
| ----------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| gateway E2E (`host test:e2e`)       | 14/14               | **18/18 × 2 consecutive**                                                                  | PASS (+4)                                          |
| host unit+integration               | 340                 | **340 passed (340)**                                                                       | PASS                                               |
| daemon (unit+integration)           | 386                 | **390 passed (30 files)**                                                                  | PASS (+4 F1 tests)                                 |
| agent-core                          | 851 + 1 skip        | **851 passed / 1 skipped (67 files)**                                                      | PASS                                               |
| web unit                            | 546                 | **548 passed (34 files)**                                                                  | PASS (+2 F2 tests)                                 |
| desktop (Electron bridge untouched) | 522                 | **522 passed (23 files)**                                                                  | PASS                                               |
| web integration                     | 158/61 (upstream)   | **158 passed / 61 failed ×3 stable re-runs at HEAD**                                       | EXACT upstream baseline (one 157/62 one-off, §6.7) |
| dev-browser-mcp (in-package)        | 116/116             | **116/116 (8 files)**                                                                      | PASS                                               |
| dev-browser (in-package)            | 36/37 (relay flake) | **36/37 parallel; relay 12/12 isolated**                                                   | documented M5 §23.5#3 watch item, unchanged        |
| typecheck                           | 5/5                 | **all workspaces Done**                                                                    | PASS                                               |
| eslint                              | 0 err / 3 warn      | **0 errors / 3 documented pre-existing warnings**                                          | PASS                                               |
| prettier                            | clean               | **clean**                                                                                  | PASS                                               |
| parity audit                        | allowlist 99        | **allowlist 99 · blocklist 7 · registered 138 · self-checks PASS (shim-call ⊆ allowlist)** | PASS                                               |

### §6.4 Security & policy verification (§6.2 of the M6 plan, re-proven)

- `apps/host/src/policy.ts` has a ZERO diff in T6 — allowlist stays EXACTLY 99 (the T4 addition is still the only M6 entry), blocklist byte-identical 7; no `ACCOMPLISH_PERMISSION_POLICY`/presence-gate/scrubber edits (`git diff` proof).
- 30-unauthenticated 401/403/WS-auth E2E and 90-secrets-redaction green in both suite runs; 99-presence-autodeny green — no-UI auto-deny semantics unchanged (and F1's fix writes nothing on the auto-deny branches — pinned by the new unit test).
- The persisted/reshaped pending data remains card-context only (D4 redaction-before-cap); the F2 rebuild delivers the SAME already-redacted record — no new secret surface.
- Production invariance: prod daemon (systemd pid 3612, booted 12:16:55 with the T5 bundle) cmdline md5 `25605d3b…` **identical pre/post every suite run**; `/home/chris/Accomplish` untouched; E2E chains isolated under `/tmp/opencode/m5-e2e` (mkdtemp, auto-swept; two forensics dirs from F1 debugging left for reference only).

### §6.5 Plan deviations / decisions made during T6

1. **Fixture was stable → both specs are committed specs** (not harness-only): both assistance E2Es run on the standard M5 serial gateway fixture unchanged.
2. **`task.get` sessionId visibility:** the restart spec asserts sessionId byte-equality through the gateway `task.get` payload (`sessionId` is not a secret-shaped field name; the scrubber's 10 names do not collide) — the same field the daemon's own recovery reads.
3. **The spec's post-restart phase interleaves** the resumption-transition poll with the approval loop: the resumed turn parks AGAIN on a bash permission (M1 policy — a resumed turn re-prompts), so status-only polling would dead-wait. This is the designed M4/M6 interplay, now exercised live.
4. **F1/F2 are T6 defect fixes, not plan changes** — D4 kept its shape (record written at park already), D5's guardrails are unchanged; F1 makes the persisted row carry what D5's claim contract already required. Both fixes are additive with paired unit tests; no migration, no API, no policy change (allowlist tripwire 99 untouched; `git diff` proves policy.ts byte-identical).
5. **Companion tests** in both specs mirror the M5 40/50 convention (history persistence without a second LLM run).

### §6.6 Known bounds carried to T7–T8

- The assistance instruction adherence is prompt-shaped here: the task prompt NAME the gate ("scripted rehearsal") on top of the T1 system-prompt instruction. glm-5.3:cloud produced the exact header and the single-question behavior in EVERY live run observed this session (5/5); a model that drops the header still parks at `waiting_permission` with graceful degradation (D1). The T7 manual checklist should include ONE unscripted real gate attempt (real page, no scripted gate text) as the honest adherence sample.
- Cold-model-load latency: the first-turn park wait is generous (240 s) per the M5 watch-item convention; the observed worst case this session was ~2 min of streaming before the ask.
- Unattended auto-deny of assistance questions and the no-answer decline mapping (D3) are unit-tested (T1/T2) but NOT E2E-exercised (whatsapp/scheduler sources + a decline answer would burn LLM runs); T7's manual Cancel→failed item covers the cancel flavor with the user.
- The restart spec answers the restored card on a RELOADED page. The equally-supported kept-open path (no reload, `daemon:reconnected` rebuild — F2 fix) is pinned by unit tests only (Playwright hash-navigation does not rebuild the document).
- Suite-count growth from M6A-T6: E2E 14→18 (both new specs + companions), daemon +4, web unit +2 — the battery table in §6.3 documents each delta; nothing else moved.

### §6.7 Stability re-check + closeout verification (post-commit, same day)

- **Web integration re-check:** 4 instrumented runs at T6 HEAD — **158 passed / 61 failed ×3** (failing set EXACTLY the upstream trio: TaskLauncher 1, taskStore 53, Home 7; no new file) plus ONE earlier reading of 157 passed / 62 failed whose single extra (unknown, un-tee'd log) test did NOT recur in any of the 4 instrumented runs. Classified once-seen one-off (M5 §23.5#6 watch class), no action.
- **Post-commit battery re-verification at `0116485`/`c6e5f34`** (after the lint-staged hooks): typecheck 5/5 workspaces Done · host 340 · daemon 390 · agent-core 851+1skip · web unit 548 · desktop 522 · eslint 0 errors/3 documented warnings · prettier clean · parity audit allowlist 99 / blocklist 7 / registered 138, self-checks PASS. Two full E2E 18/18 runs pre-committed (§6.2) — suite content identical to HEAD.
- **M1-critical surface cross-window check:** `git diff 5f509a4..HEAD` over the M6-A window shows NO diff for `policy.ts` blocklist/permission-policy objects, browser isolation (cdp/sidecar), or the watchdog/presence gate; the allowlist file's only delta remains the T4 +1 entry (`task.getPendingRequest`, 98→99) and `config-generator*` deltas are the T1 constant + T5 taskId threading — each committed, tested, and parity-audited in their own tasks (byte-additive; no de-scoping, no weakening).
- **T6 status stands COMPLETE** — every automated acceptance line (§6.3) re-verified at the committed HEAD; manual Firefox acceptance (T7) remains the only open gate before T8 closeout.

### §6.8 Known bounds — unchanged

- Watch items unchanged from M5: relay.test.ts parallel flake (12/12 isolated), web integration 61 upstream, docker e2e environment-blocked, 3 documented lint warnings, cold-model-load E2E latency (§6.5).

### §6.9 T6 status — **COMPLETE: all T6 acceptance criteria met at HEAD `0116485`/`c6e5f34`, re-verified post-commit**

E2E ≥16 with the two new assistance specs green ×2 consecutive (18/18 ×2) · battery green with zero regressions vs T5/M5 baselines · restart-soak live cycles PASS · parity audit PASS (allowlist 99) · policy surfaces untouched · counts recorded. Manual Firefox acceptance (T7) is the only remaining human gate before T8 closeout.

## §7 — M6-A T7: manual Firefox acceptance record (2026-10-26; user + architect)

Full item-by-item evidence lives in `docs/PHASE_3_M6A_MANUAL_CHECKLIST.md` (committed at the T7 milestones). Summary + follow-up ledger:

1. **Results: H1 · A1 · A2 · A3 · A4 · A5 · A6 · A7 PASS; O2 SKIPPED** (automated 99-presence-autodeny standing evidence). All user confirmations verbatim in the checklist.
2. **A6 story (the T7 center of gravity):** attempt 1 failed on an ENVIRONMENT defect — an invalid `"status": "active"` property in the GLOBAL `~/.config/opencode/opencode.json` (opencode enum violation; killed opencode-serve before ANY product surface ran; the daemon's OWN config generation stayed clean — proven raw). User-directed surgical fix + spawn-contract validation → attempt 2 completed cleanly (T5 breadcrumbs ×2, child identity receipt, ALL negatives clean). Attempt 2's agent misreported the IANA H1 ("About us" instead of "About IANA") — user directive: preview verified, misreport tracked separately. Architect regression run via the production gateway allowlisted RPC (`task.start`) reported the H1 correctly; user's live-watched run (attempt 4) PASSED the full A6 condition (preview rendered the actual page, green Live, "About IANA", completed). **Zero preview/product code changed** across the entire A6 arc (the user-directive held).
3. **T5 seam re-proven 3×** (attempts 2/3/4 + A7): breadcrumbs ×2 each, child receipts, zero divergence WARNs, zero child canaries, resident-sidecar reuse (`already running (token verified)`), post-task page still capturable (devBrowser.captureFrame → 123 KB JPEG). Nothing to patch.
4. **Completed-task preview-panel gating documented (no change):** ENG-982 live-only design — the panel renders `null` when idle+no frames (`BrowserPreview.tsx:52`) and auto-starts only on an ACTIVE `browser_*` call (`useBrowserPreview.ts:78-115`); terminal tasks show "Browser Actions" without a replay preview and no persisted-frame replay exists. Frame DATA stays capturable (data path ≠ UI gating). A replay-after-completion feature would be a new item.
5. **A5 story:** the first pair was marked INVALID (accidental Allows; M1 gate DID ask on every write — proven from child logs; artifact removed under a content-guard). Rerun proved DENY enforced: card → user deny → NO write executed (no `file.edited` events; opencode's own snapshot git error corroborates the file never existed), no bypass, terminal without hang. Terminal flavor = completed (within M5 H4 parity family).
6. **A7 (unscripted honest sample):** the agent PAUSED ITSELF at a real login wall (opencode native `question`, model-authored header/options), the user's Cancel mapped to `question.reject` → tool error → the agent ended honestly (no credentials, no login, no bypass). **Completed-correctness resolved in code:** non-assistance question cancels map to `markComplete('success')` BY DESIGN (`OpenCodeAdapter.ts:699-705`) — the D3 hard-fail branch engages ONLY on the canonical assistance header (`OpenCodeAdapter.ts:1355`). Goal-aware FAILED semantics on a blocked primary goal would be a design evolution (recorded, not implemented).
7. **Agent-accuracy tracker (documented, non-blocking):** ACC-1 intermittent heading misreport (1/4 same-model same-page runs; product mechanism = the snapshot history-line rendering the page TITLE as a markdown H1, `dev-browser-mcp/src/index.ts:1604` + `snapshot/manager.ts:112` — IANA's title is "About us"); ACC-2 bare-`return` evaluate flaws, self-recovered via graceful state capture.
8. **SEC-1 (open design follow-up, document-only):** agent-authored question options may invite credential entry through the unified dialog's custom answer field; a submitted answer enters model context + persisted transcripts; no app credential-store involvement; mitigation options recorded (never-request-credentials prompt rule; UI masking/warning; heuristic scrubbing; docs).
9. **T7 closeout:** all user confirmations verbatim recorded; invalid A5 pair + artifact removal recorded with exact evidence; policy/isolation surfaces byte-untouched throughout (§6.7 cross-window checks remain in force); nothing pushed, nothing merged, T8 not started.
