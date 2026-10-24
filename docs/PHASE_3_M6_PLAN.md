# PHASE 3 M6 — Human Assistance Loop v1 — Implementation Plan (Rev. 1, PROPOSAL)

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `5f509a4` (M5 complete, clean tree)
**Approved basis (proposal pending review):** M5 closeout proposal M6-A in `docs/PHASE_3_M5_DEFERRED_DESIGNS_RECOMMENDATIONS.md` (§5) **plus** the user's Milestone-6 directive of 2026-10-23 ("Human Assistance Loop v1", 6 objectives incl. the browser-preview fix).

**Scope discipline:** This document is a PLAN ONLY. Nothing is implemented; nothing is pushed/merged; `/home/chris/Accomplish` remains untouched. Implementation starts only after the user approves this plan. One new allowlisted RPC (`task.getPendingRequest`) is proposed — justified under the Phase-3 plan §5.4 expansion policy (§8 of this plan); everything else reuses committed M4/M5 machinery.

---

## 1. What M6 must do (objectives → design commitments)

| #   | User objective                                | Design commitment (decided in this plan)                                                                                                                        |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Recognize when human intervention is needed   | Assistance-question marker (structurally routed, `waiting_for_user`); agent-behavior instruction: verification gates PAUSE, never `complete_task` blocked-first |
| 2   | Pause safely and explain what is needed       | Task parks at `waiting_for_user`; QuestionCard displays agent question + options + task context; answer is human-only, human-typed                              |
| 3   | Human intervenes through the Firefox UI       | Existing gateway QuestionCard/Question flow extended with an assistance mode; no new channels (WhatsApp/Android = M6-B, NOT here)                               |
| 4   | Auto-resume the original task on confirmation | Live reply → existing same-turn continuation (works today); reply-after-restart → daemon-side auto-`session.resume` with guardrails (Design 4)                  |
| 5   | Preserve context, permissions, history        | Persisted pending-request row (v033 migration) + M4 session/cwd preservation + byte-identical waiting-row restart recovery; NO permission-policy edits          |
| 6   | Fix the browser-preview blank panel           | Preview-seam work item: root-cause first, then sidecar-owned "agent-active page" identity consumed by preview/preview-capture (§6)                              |

**M6-A is one milestone.** M6-B (remaining API parity: OAuth re-homing, GWS/WhatsApp incl. the assist channel, daemon control, bug report/speech, analytics, final parity audit) stays deferred and needs its own later approval.

---

## 2. Current committed state (what already exists — verified before planning)

Nothing below is new work; it is the M4/M5-committed foundation this plan builds on.

### 2.1 The assistance state machine is ~80% live (M4 §22.2)

- `TaskStatus` already contains `waiting_permission` (wireable, used at runtime), `waiting_for_user` (plumbing + UI badge live, **zero runtime triggers yet**) and `resuming` (first-class transient) — `packages/agent-core/src/common/types/task.ts:8`.
- Parking works: `apps/daemon/src/task-callbacks.ts:73-131` (`onPermissionRequest` → `markWaitingOnHuman()` → `waiting_permission` + `statusChange`); restore-on-reply: `apps/daemon/src/task-service.ts:453-459` (`sendResponse` flips waiting\_\* → `running`).
- Restart recovery: `apps/daemon/src/crash-recovery.ts` flips ONLY `running` → `failed`; waiting rows survive byte-identically with `session_id` + `working_directory` (soak-proven twice: M4 §22.4, M5 T3 recheck 6/6).
- Watchdog: a pending permission/question is non-stall (`sampleWatchdogState` → `inProgress:false`; human thinking time never fires the 2.5-min stall machinery) — regression-tested.

### 2.2 The question ask/reply path is END-TO-END live (desktop port, untested in Firefox)

- **Adapter:** `OpenCodeAdapter` handles `question.asked` (case at `packages/agent-core/src/internal/classes/OpenCodeAdapter.ts:998`) → `handleQuestionAsked` (`:1332-1355`) → emits a `PermissionRequest` of `type:'question'` carrying `question`, `header`, `options`, `multiSelect`; `sendResponse` (`:627-694`) routes question replies to `client.question.reply` (answers from `selectedOptions` + `customText`) or `client.question.reject` on Cancel; the cancel-hangs fix marks the task complete when the turn never idles.
- **Daemon:** questions ride the SAME `onPermissionRequest` path as permissions (currently parked at `waiting_permission` — no question/permission discrimination).
- **Gateway:** `permission.request` WS notify → shim (`apps/web/src/client/lib/accomplish-http.ts:1359`); `permission.respond` is allowlisted (`apps/host/src/policy.ts:49`).
- **UI:** `PermissionDialog.tsx` has a question mode + `PermissionDialogQuestion.tsx` (options/multi-select/custom text/Cancel → deny); `useExecutionActions.ts:94` interrupts on question-cancel.
- **Policy:** `question` is `'allow'` in `ACCOMPLISH_PERMISSION_POLICY` (`packages/agent-core/src/opencode/config-generator.ts:78`) so opencode emits `question.asked` freely.

### 2.3 What today's agent does at a verification gate — the actual v1 gap

The behavior instructions say `complete_task status:"blocked"` is for "login walls, CAPTCHAs, rate limits, site errors, missing permissions" (`packages/agent-core/src/opencode/system-prompt-behaviors.ts:164`). **Today the agent TERMINates the task at a human-verification gate instead of pausing for help.** That is objective 1's gap: recognition exists as a terminal outcome, not an assistance pause.

### 2.4 What is missing for objectives 2–5 (the gap list)

1. No instruction that a verification gate should request assistance and wait (§2.3).
2. No discrimination between clarifying questions and assistance requests → no `waiting_for_user` trigger → no distinct badge/copy.
3. The pending question/permission lives ONLY in adapter memory + the UI's in-memory `permissionRequests` map (`apps/web/src/client/stores/taskStore.ts:42`) — **nothing persists it**, so after a daemon restart the card cannot be restored and `permission.respond` answers a dead request (rpc-server returns "no pending request" — the M4 soak's waiting rows were only ever recovered by MANUAL `session.resume`).
4. No daemon-side auto-resume wiring at all: Design 4 ("a resolved verification triggers resumeSession automatically instead of waiting for a user click") is unimplemented for the restart case.
5. No wait-age surface/TTL policy for waiting rows ("human thinking time outruns the app" is invisible today).

### 2.5 The preview seam (objective 6) — recorded facts

From M5 T7 (debug checkpoint §1.G, unresolved by user directive):

- Frames ARE generated and delivered (server-side `captureFrame` pipeline verified live, real 1280×720 JPEGs; zero preview-poll miss breadcrumbs) — the panel is blank because the frames contain the **wrong page**.
- The preview poll (`allowDevBrowserCaptureFrame` shim, `BROWSER_PREVIEW_POLL_MS=750`) ensures `openPreviewPage({name: '<taskId>-main'})` then polls `devBrowser.captureFrame({taskId, pageName:'main'})`; the daemon resolves `<taskId>-main` (`apps/daemon/src/dev-browser-service.ts:122-147`) → sidecar `POST /pages` (`ensurePage`, registry-keyed by name, `packages/agent-core/mcp-tools/dev-browser/src/browser-page-service.ts:65-97`).
- The agent's `dev-browser-mcp` tools (builtin mode) POST `/pages {name:'<taskId>-main', launchIntent:'background-normal'}` (`.../dev-browser-mcp/src/connection.ts:166-187, 364-415`) — the SAME registry name — then drive the page via `connectOverCDP`.
- Observed outcome despite the name collision: **two page surfaces** — the agent navigates a tab the sidecar's registry does not match, the preview captures the registered tab.
- Named root-cause hypotheses (to be pinned live in T0, not assumed):
  1. **Registry-external page creation** — some agent path calls `context.newPage()` through the CDP connection (`getRemotePage` does exactly this in remote mode; equivalent creation may occur through `BrowserManager`/auth-detection/open-external/window-controllers), leaving a tab invisible to the sidecar registry.
  2. **Registry-entry lifecycle staleness** — a closed/stale entry (`deleteStaleEntry`, `attachPageCloseHandler` races) makes `ensurePage` re-create the tab while the agent's cached CDP page handle still points at the old one.
  3. **Two-sidecars / relay-mode contamination** — T7's display-less fix relaunched the sidecar headless; a relaunch between the agent's ensure and the preview's ensure would fork identities (mitigated by self-heal, but unverifiable in the recorded trace).
- The design decision is PRE-committed: the sidecar becomes the single authoritative **"agent-active page"** identity surface; preview capture, session handoff (M7+), and diagnostics all resolve pages THROUGH it. T0 may adjust mechanics; the direction stands unless facts contradict.

---

## 3. Proposed technical architecture

```
agent (opencode) hits a verification gate (CAPTCHA / login / MFA / challenge)
  └─ agent calls the question tool with the ASSISTANCE HEADER   ← T1 instruction
       opencode → question.asked (SDK)
         → OpenCodeAdapter.handleQuestionAsked → PermissionRequest{type:'question', header, …}
           → daemon task-callbacks.onPermissionRequest
               ├─ header === ASSISTANCE_HEADER? → updateTaskStatus('waiting_for_user')
               │    + persist pendingRequest row (v033 column)   ← T2
               └─ else → 'waiting_permission' (TODAY'S semantics, byte-identical)
             → gateway WS notify 'permission.request' + 'task.statusChange'
               → UI QuestionCard (assistance mode: wait-age, context, answer box) ← T3
human answers in Firefox
  ├─ adapter alive (no restart):
  │     permission.respond → TaskService.sendResponse → question.reply
  │     → SAME turn continues; waiting_for_user → running (existing guard)   [today]
  └─ adapter DEAD (daemon restarted mid-wait):
        permission.respond → no live pending → pendingRequest row found
          → guardrails (kind=question · row waiting_for_user · single-flight · stale-id reject)
          → status 'resuming' (precondition-checked) + row cleared at spawn
          → session.resume (SAME sessionId + cwd) with "The human replied: <answer>"   ← T2
daemon restart while waiting
  → crash recovery skips waiting rows (M4) → row + pendingRequest survive
  → UI rebuilds the AssistanceCard from task.getPendingRequest   ← T3/T4

browser preview (objective 6)
  sidecar = single authoritative page-identity surface ("agent-active page")  ← T0→T5
  preview capture resolves THROUGH it; MCP tools register/call THROUGH it
```

### 3.1 Decided design points (architect decisions in this plan)

**D1 — Trigger = Option B (question flow), instruction-level.** The system prompt instructs: when the agent reaches a human-verification gate (login wall, CAPTCHA, MFA/passkey, challenge), it must NOT terminate (`complete_task blocked`) and must NOT thrash; it must call the `question` tool ONCE with:

- `header: "Human assistance required"` (exact constant; lives in agent-core, imported by config-generator AND daemon — one constant, two consumers),
- `question`: what gate + where (URL/site + what is being verified),
- options: `["I'll complete it — please wait", "Skip this verification"]` (plus optional detail in `customText`).
  No new MCP server, no tool-name watcher (Option A stays recorded as the fallback hardening if instruction adherence proves unreliable — per the deferred-designs doc). Graceful degradation: if the model drops the header, the question still parks/works as today — only the badge/status routing differs; the loop never hard-fails.

**D2 — Status routing = structural equality, not content policy.** The daemon routes `type:'question'` requests to `waiting_for_user` IFF `header` string-equals the constant. Rationale (security): the daemon uses the header ONLY for a status label + restart-restoration routing — it is parsed for NO authorization decision and grants nothing; page-driven prompt injection can at worst cause a spurious assistance pause (annoyance, human decides). Clarifying questions keep `waiting_permission` unchanged.

**D3 — Assistance-cancel + no-UI-auto-deny honesty.** A Cancel (deny, no answer) on an assistance question, and the unattended auto-deny of an assistance question, produce question.reject → turn ends → the existing clarification-cancel fix (`markComplete('success')`) is BYPASSED for assistance-kind: the task is marked `failed` with an explicit "human assistance declined/not available — verification incomplete" message instead of dishonest `success`. Existing clarification-cancel behavior byte-identical.

**D4 — Pending-request persistence (v033 migration).** New nullable `pending_request` TEXT column on `tasks` (`CURRENT_VERSION` 32 → 33; NEW migration file only — released migrations untouched). Payload `{kind, requestId, question, header, options, multiSelect, createdAt}` written when parked, cleared on sendResponse/cancel/terminal/crash-to-failed. Never secret-shaped: universal scrubber + redaction test still apply (§5.4 policy).

**D5 — Reply-after-restart = auto-resume for assistance questions.** On `permission.respond` with no live pending AND a persisted waiting_for_user question row: daemon transitions the row to `resuming` (stored-status precondition = single-flight: a second reply fails loudly; stale requestId mismatch rejected) then resumes the SAME session (`session.resume`, persisted sessionId + cwd from M4 plumbing) with a capped continuation prompt embedding the human answer. Permission-kind stale replies are NOT replayed: no fake allow/deny — the UI instead explains the request expired with the previous session and offers Resume (existing affordance) for re-request. No auto-approve anywhere; a resumed turn re-prompts for any NEW tool use (M1 policy intact).

**D6 — Wait-age surface, no silent expiry.** Tasks expose `waitingSince` (additive read field derived from the status-change timestamp the UI already has; no clock in the daemon loop). UI shows "waiting N m". NO auto-fail/auto-deny timer in v1 — the M4 directive's "no timeout races a human reply" bound stands; an expiry sweep is deferred with an explicit note (revisit with Design-3 WhatsApp channel in M6-B).

**D7 — Preview seam = sidecar-authoritative agent-active page.** Mechanically decided AFTER T0 pins the extra-tab creator; pre-committed direction: every agent page birth/lookup routes through the sidecar registry (or an equivalent sidecar-owned target registry keyed off CDP target activity), `getRemotePage`-style raw `context.newPage()` creation removed/gated, and `devBrowser.captureFrame`/preview resolve through the authoritative surface. Sidecar HTTP/WS auth surface unchanged (loopback + bearer + first-message auth); if the sidecar HTTP API gains a read-only diagnostic endpoint, it follows the same §5.4 discipline.

**D8 — Notification surface unchanged.** Assistance waits ride the existing `permission.request` + `task.statusChange` notifies — no new notification kinds.

---

## 4. Affected components

| Area                  | Files                                                                                                                                                                                                                                                                                                                                                                                                         | Change class                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| agent-core            | `src/opencode/system-prompt-behaviors.ts` (gate→assistance instruction), `src/opencode/config-generator.ts` (+constant import/documentation), `src/internal/classes/OpenCodeAdapter.ts` (assistance-kind tagging on question requests; honest cancel/deny semantics for assistance-kind), `src/common/types/task.ts` (+`PendingRequestRecord?` shapes), new `src/common/task-assistance.ts` (shared constant) | additive; released migration files untouched |
| agent-core storage    | new `src/storage/migrations/v033-task-pending-request.ts` + `migrations/index.ts` (bump `CURRENT_VERSION`, add migration)                                                                                                                                                                                                                                                                                     | additive                                     |
| daemon                | `src/task-callbacks.ts` (assistance routing + persistence hook), `src/task-service.ts` (persist/clear pending request; reply-to-dead-pending auto-resume path; `resuming` precondition), `src/daemon-routes.ts` (+`task.getPendingRequest` zod route), `src/crash-recovery.ts` (clear pending-request on running→failed flips — waiting rows keep it)                                                         | additive; no policy edits                    |
| host                  | `src/policy.ts` (+1 allowlist entry w/ response-shape comment), `e2e/` new specs, fixture helpers if needed                                                                                                                                                                                                                                                                                                   | §5.4-paired                                  |
| web                   | `src/client/lib/accomplish.ts` + `accomplish-http.ts` (+ shim method), `PermissionDialogQuestion.tsx` (assistance mode: copy, wait-age, restored-state hint), stores restore logic, `task-utils.ts` (badge copy already exists), execution page banner (waiting-state affordance)                                                                                                                             | additive                                     |
| docs/tests            | `docs/PHASE_3_M6A_MANUAL_CHECKLIST.md` (created during execution), unit suites per area, soak-harness extension, checkpoint §24 at closeout                                                                                                                                                                                                                                                                   | follows M4/M5 conventions                    |
| sidecar/MCP (preview) | `packages/agent-core/mcp-tools/dev-browser/src/*` (page-identity surface, per T0 design) + `mcp-tools/dev-browser-mcp/src/connection.ts` (route page ops through the authoritative surface) + `apps/daemon/src/dev-browser-service.ts` + `apps/daemon/src/cdp-client.ts` consumers                                                                                                                            | T0-gated; sidecar auth semantics UNCHANGED   |

Not touched: `apps/desktop/**` (Electron byte-identical requirement — bridge paths preserved; desktop suite green at every gate), permission policy objects, blocklist, scrubber internals, presence-gate mechanics, systemd units.

---

## 5. Implementation tasks (dependency-ordered; each = one delegated developer session)

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                      | Depends on                  | Estimate    | Acceptance (verifiable)                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0  | **Preview-seam root-cause investigation** — live repro harness (isolated daemon + real ollama task), page/target dump (GET /pages + CDP Target targets + task transcript), pinpoint WHO creates the agent tab; write findings + chosen design mechanics into `docs/M6_DEBUG_CHECKPOINT.md`                                                                                                                                                | —                           | S (0.5 d)   | A named creator mechanism + repro; design note with the D7 mechanics written; NO product code committed beyond test-only diagnostic changes                                                                                                        |
| T1  | **Assistance trigger + routing** — shared constant, behavior-instruction text (verification gates pause+ask, never blocked-thrash; skip-capability honest), adapter tagging of assistance-kind (including honest cancel/deny → `failed` semantics), daemon routing to `waiting_for_user`, unit tests (adapter + task-callbacks + prompt-content guard)                                                                                    | —                           | S-M (0.5 d) | unit tests green: clarification questions byte-identical; assistance questions → waiting_for_user; assistance reject/auto-deny → failed w/ message; E2E-independent                                                                                |
| T2  | **Pending-request persistence + reply-after-restart auto-resume** — v033 migration, write/clear lifecycle, `permission.respond` dead-pending path (single-flight via stored-status precondition, stale-id rejection), continuation-prompt builder (caps: question ≤2000 ch, answer ≤4000 ch), unit tests (incl. double-reply, replay-allow rejection, terminal-state races)                                                               | T1                          | M (1 d)     | unit + integration tests green on the full question/persistence matrix; no migration-version drift; `CURRENT_VERSION`=33                                                                                                                           |
| T3  | **UI assistance mode** — shim `task.getPendingRequest` + type defs; QuestionCard assistance variant (explicit "verification gate" copy, wait-age, restored-card hint and dead-permission-request explanation); store restore wiring on task open/reconnect; unit tests (transport-mock pattern per method)                                                                                                                                | T2 (types), T4 (route live) | S-M (0.5 d) | web unit green; card restores from `task.getPendingRequest` in a restart scenario (unit-simulated); clarification UX unchanged                                                                                                                     |
| T4  | **Host route + allowlist entry** `task.getPendingRequest` — zod route in `daemon-routes.ts` (additive), policy comment with response shape, §5.4 paired tests (unauth 401/403, scrubber/no-secret proof, redaction), allowlist tripwire updated 98→99                                                                                                                                                                                     | T2 (daemon handler)         | S (0.25 d)  | host suite green incl. tripwires; parity audit self-checks PASS (shim-call ⊆ allowlist)                                                                                                                                                            |
| T5  | **Preview-seam fix per T0 design** — implement authoritative agent-active-page mechanics; make agent page ops registry-mediated; captureFrame resolves through it; focused tests for page-identity invariants + the T0 repro as a regression test; manual evidence in the verification harness (`/tmp/opencode`, non-persistent)                                                                                                          | T0                          | M-L (1 d)   | T0 repro harness no longer reproduces two-tab split: capture targetId === agent active targetId through a complete navigate task; dev-browser in-package + agent-core suites green; sidecar auth surface unchanged (loopback/bearer/first-message) |
| T6  | **E2E + soak + battery** — new gateway-E2E spec `35-assistance-question.spec.ts` (real ollama: assistance question → waiting_for_user badge → answer → same-session continuation → completed) + `36-assistance-restart.spec.ts` (restart the fixture's daemon mid-wait; restored card; answer auto-resumes) IF fixture-stable, else harness-level script + manual item; soak: waiting-for_user rows survive + resume; FULL battery re-run | T1–T5                       | M (0.5 d)   | E2E ≥16/16 (from 14) green ×2 runs; battery green with zero regressions vs M5 baseline; soak PASS; parity audit PASS; counts recorded                                                                                                              |
| T7  | **Manual Firefox acceptance WITH the user** — new `docs/PHASE_3_M6A_MANUAL_CHECKLIST.md`: live assistance question from real UI; answer resumes + completes; restart-mid-wait restore + auto-resume; Cancel → honest failed state; **preview renders the agent's actual navigation** (the §23.5#1 directive re-verification); M1 regression spot checks (Allow/Deny unchanged)                                                            | T5, T6                      | S (0.5 d)   | every human-interactive item carries the user's confirmation; nothing unperformed claimed passed                                                                                                                                                   |
| T8  | **Closeout docs** — checkpoint §24 (results + suite counts + parity numbers), M5-limitations table update (§23.5 preview row → resolved), debug-checkpoint final state, plan-status update; docs commit. STOP after M6-A                                                                                                                                                                                                                  | T7                          | S (0.25 d)  | docs committed; summary reported to user; no push/merge; M6-B not started                                                                                                                                                                          |

Parallelism: T0 ∥ (T1 + T2 chain). T3 ∥ T4. T5 strictly after T0's design gate (architect-reviewed findings + user-visible note; the D7 direction can be overridden by T0 facts only with a written rationale in the debug checkpoint).

---

## 6. Security & privacy requirements (binding; nothing here weakens M1)

1. **No CAPTCHA/MFA bypass, ever.** The agent pauses; ONLY the human completes the verification on their side. Automation never completes, never solves, never proxies a challenge. No solver service, no OCR, no third-party assistance API.
2. **No auto-approve; no permission weakening.** Allowlist grows EXACTLY +1 (`task.getPendingRequest`); blocklist 7 byte-identical; `ACCOMPLISH_PERMISSION_POLICY` byte-identical; presence gate / 5-min in-flight permission timeout / auto-deny unmodified (auto-deny semantics for assistance questions gain only the honest-status mapping, D3). Tripwire tests updated and green.
3. **§5.4 expansion policy** for the new method: response-shape documentation (`{pendingRequest: {kind:'question', question, header, options, multiSelect, createdAt} | null}`), scrubber/no-secret proof, 401-unauthorized test, redaction test.
4. **Question payloads are untrusted** (prompt-injection caveat from the deferred-designs doc, designed in): hard caps on delivered question text/options and on the human-reply continuation prompt; no secret-shaped echo (never search for or persist credential-shaped strings; never relay secrets through any channel); the reply only ever feeds BACK into the SAME already-authorized session; the daemon never parses question/answer CONTENT to make policy decisions (D2's structural-equality routing is the only content-conditioned behavior, analyzed in §3.1).
5. **Token isolation unchanged:** the sidecar bearer token never crosses the daemon boundary (gateway/desktop/UI); the preview path keeps exposing only loopback URLs/page names/targetIds; the seam fix introduces no new token-bearing surface.
6. **Sensitive-content boundary of preview frames:** a JPEG of the agent's browsing is already user-visible task context (desktop parity); v1 ships no new destinations, no persistence beyond the shim's in-memory frame, no logging of frame data (failure breadcrumbs carry none — M2 T4 pattern preserved).
7. **Waiting rows + crash recovery invariants:** crash-recovery skips wait rows (M4 byte-identical); terminal/cancelled rows clear the persisted pending request; the SQLite file's existing protections (data dir, 0600-class isolation) apply to the new column.
8. **Unattended (scheduled/WhatsApp-source) tasks:** assistance requests auto-deny with the honest mapping (D3); the task completes-as-declined rather than hanging or claiming success — matches the M1 no-UI policy and the WhatsApp bridge auto-deny (unchanged; WhatsApp assist channel = M6-B Design 3, explicitly out of scope here).
9. **Rate-limiter:** no new RPC fan-out patterns (single one-shot read per task open/reconnect; the assistance card re-reads on `task.statusChange` only) — no new 429-flake class.
10. **Token-in-journal M5 limitation #2 is NOT in M6-A scope** (recorded, user-directed; fold into a future launcher/gateway-surface work item — see §9).

---

## 7. Acceptance criteria (final milestone gate)

**Automated:**

1. `pnpm -F @accomplish/host test:e2e` — green on this aarch64 machine, **≥16 specs incl. the two new assistance specs**, TWO consecutive full-suite green runs (the M5 serial-chain convention).
2. Full regression battery green with ZERO regressions vs M5 baseline (host 332 / daemon 345 / agent-core 807+1skip / web unit 491 / desktop 522 / web integration 158/61 = exact upstream baseline / typecheck 5/5 / lint 0-error+3-documented-warnings / prettier clean, with suite-count growth from M6 additions documented at closeout).
3. dev-browser in-package + agent-core browser suites green after T5; `pnpm -F @accomplish/desktop test` green (Electron bridge untouched).
4. Parity audit: regenerated `docs/PARITY_INVENTORY.md` self-checks PASS with allowlist **99**; no shim-call outside the allowlist.
5. Migration: `CURRENT_VERSION` = 33 with forward-compat tests (old-DB rows → new column nullable-safe).
6. Watchdog interplay regression: an open assistance ask keeps the task alive indefinitely (no stall firing) — explicit test alongside T1.

**Manual (user-confirmed; `docs/PHASE_3_M6A_MANUAL_CHECKLIST.md`):**

7. A real task hits a verification gate and the Firefox UI shows the assistance card explaining exactly what is needed; the user answers; the ORIGINAL task resumes and completes (objective 1–4).
8. Daemon restart mid-wait: card restores; answer auto-resumes the session; byte-identical context preservation visible (objective 5).
9. **The preview panel renders the agent's ACTUAL browser session** — navigation visible live, the agent-active page (the direct §23.5#1 re-verification the user directed).
10. M1 regression spot-checks in the same session: permission Allow/Deny behave exactly as in M5; auto-deny-on-disconnect unchanged.

---

## 8. Complexity & risk register

**Overall estimate: ≈ 4–4.5 developer-days (M–L).** Assistance-loop sub-scope (T1–T4 + parts of T6/T7) ≈ 2.5–3 d; preview seam (T0+T5) ≈ 1.5 d.

| #   | Risk                                                                                                             | Severity   | Mitigation                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Model instruction-adherence for the assistance marker (header dropped under prompt-injection pressure)           | MEDIUM     | Graceful-degradation design (D1): without the marker the loop still parks/works; watchdog bounds flailing; Option-A tool watcher is the recorded fallback |
| 2   | Continuation-prompt quality after auto-resume (answer embedding could confuse the agent)                         | MEDIUM     | Explicit capped template + unit + live E2E; template reviewed by the architect; adjust copy after first live run                                          |
| 3   | Preview seam root cause may require sidecar API contract changes (touches the relay/auth neighborhood)           | MEDIUM     | T0 investigation FIRST; design gate before T5; §5.4 discipline if the sidecar HTTP API grows; manual re-verification mandated                             |
| 4   | Restart-recovery races (double reply, terminal-state race during resume spawn)                                   | MEDIUM     | Stored-status-precondition single-flight; tests for double-reply/stale-id/race; soak extension                                                            |
| 5   | SQLite migration friction (v033)                                                                                 | LOW        | M4's proven additive-migration path; nullable column; no edits to existing migrations                                                                     |
| 6   | E2E cold-model load sensitivity (seen once in M5 for deny/history specs)                                         | LOW        | Poll-based assertions, generous timeouts, known-watch-item treatment                                                                                      |
| 7   | Verification environment is ARM64-only; no automated real-Firefox path (structural constraint from Phase 3 plan) | STRUCTURAL | Chromium gateway E2E + harness + manual real-Firefox items with the user (M5 convention stands)                                                           |
| 8   | ollama-cloud spend on every real task run (dev-workflow constraint)                                              | LOW        | Tiny prompts, few runs per gate, GLM-5.3 Flash for routine runs per `docs/AI_DEVELOPMENT_WORKFLOW.md`                                                     |

---

## 9. Unresolved M5 limitations carried forward (explicit disposition — nothing silently closed)

| M5 §23.5 ref                                                         | Status in M6-A                                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 — preview blank panel                                              | **RESOLVED by M6-A** (T0+T5, manual re-verification T7 — the user-directed condition)                                   |
| 2 — token-fragment URL in journald                                   | **NOT in M6-A scope** (user-directed design item; revisit with the next launcher/logging work item — record stays open) |
| 3 — dev-browser relay.test flake (in-package, parallel-run)          | Unchanged; out of M6-A scope unless T5's touched files make it reproducible — then fix with evidence                    |
| 4 — web integration 61                                               | Upstream baseline — untouched, battery re-compared                                                                      |
| 5 — docker E2E environment-blocked                                   | Unchanged (no Docker on this machine)                                                                                   |
| 6 — 3 lint warnings; once-seen E2E one-offs                          | Watch items — untouched in M6-A; new E2E specs must not add warnings                                                    |
| 7 — desktop port-kill raw 9224 constant                              | Unchanged out of M6-A scope (desktop never runs isolated)                                                               |
| 8 — ModelIndicator 2-s poll fan-out; model-list refresh re-select UX | M6-B polish candidates — NOT M6-A                                                                                       |
| 9 — Playwright-Firefox impossibility pre-Phase-5                     | Structural; manual checklist remains the real-Firefox truth (M6 checklist item 9 above)                                 |

---

## 10. Execution & delegation map (for after approval)

- Every T# above = ONE focused developer session (30–50K tokens like M5's handoff pattern), each with: objective, affected files (§4), acceptance, required tests, and expected report (suite counts + evidence + modified-file list). Debug-checkpoint-first (`docs/M6_DEBUG_CHECKPOINT.md`, T0/T2) mirrors the M5 handover convention that twice saved a session.
- Architect (me) reviews each task's report against its acceptance line before the next dependent task starts; commits happen only after the relevant suites are green at that task's HEAD (verified-milestone-only rule).
- Commits: conventional, one per verified task (plus docs commits), on `linux-firefox-ai`. Nothing pushed/merged; `/home/chris/Accomplish` untouched; production daemon data untouched (isolated test data dirs only).
- Hard STOP: after T8 report, await explicit user approval before M6-B or any Phase-4/5 work.

## 11. Explicitly out of scope for M6-A

- Browser-session handoff UI (Design 2) — the seam's identity surface is BUILT here on purpose, the handoff itself is M7+.
- WhatsApp/Android assistance channel (Design 3) — M6-B with the WhatsApp parity surface.
- Option-A tool-name watcher (Design 1 hardening) — only if instruction adherence fails live.
- Assistant wait-expiry sweeper + M4's Stage-2 unattended authorization seam — deferred with D6's note.
- HuggingFace/OAuth/`getFilePath`-class API surface gaps (M6-B parity list) — deferred.
- Any Phase-4 (Kujenga port) / Phase-5 (BiDi) work.
