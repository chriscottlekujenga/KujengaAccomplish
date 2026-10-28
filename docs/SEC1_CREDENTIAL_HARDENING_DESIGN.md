# SEC-1 — Credential-Request Hardening: Investigation Findings & Implementation Plan

- **Tracker item:** SEC-1 (documented in `PHASE_3_M6A_MANUAL_CHECKLIST.md` §5 and `M6_DEBUG_CHECKPOINT.md` §8.8) — OPEN design follow-up.
- **Baseline:** M6-A T7 acceptance complete; HEAD `4306651`; H1 + A1–A7 PASS; ACC-1/ACC-2 documented; no T8 work.
- **Objective:** prevent Accomplish agents from requesting, collecting, displaying, or persisting passwords, MFA/OTP codes, API keys, recovery codes, or other authentication secrets through human-assistance/question dialogs — while preserving legitimate human assistance, clarification questions, permission handling, and connector-auth workflows.
- **Status of this document:** Phase 1 + Phase 2 deliverable. NO code has been changed. Implementation begins only after user approval of §4–§7.

---

## 1. Threat summary (observed, A7 `task_1793147562073`)

An unscripted task reached GitHub's real login page and the agent paused itself with a native
`question` call whose user-shown options included:

> "Share your GitHub username and password via the custom answer box; I'll fill the form for you"
> "You enter them yourself in the automation browser"

The unified request dialog renders a free-text custom answer field for every question-kind
request; a submitted answer crosses the adapter → opencode → model-context → transcripts → logs
chain. Nothing in the product flags or blocks that today. The user held the line manually
(declined); the product must hold it structurally. Prompt instructions alone are explicitly
NOT sufficient (user directive: defense in depth).

---

## 2. Phase 1 — Investigation findings

### 2.1 Ask path (agent → UI), and where detection must attach

1. Adapter converts the SDK question request into a `PermissionRequest`:
   `handleQuestionAsked` (`packages/agent-core/src/internal/classes/OpenCodeAdapter.ts:1347-1371`)
   — `type:'question'`, `question: first?.question`, `header: first?.header`, options labels/
   descriptions, and the `assistance` tag (`:1355`, equality with
   `ASSISTANCE_QUESTION_HEADER`, `packages/agent-core/src/common/task-assistance.ts:17`).
   **Critical:** `assistance` keys on the model-authored header. A7's ask used header
   `"GitHub login"` — so any credential guard keyed on the assistance header misses the exact
   attack shape. Detection must scan the text surfaces (header + question + option labels),
   not the header marker.
2. TaskManager forwards: `TaskManager.ts:279` → `onPermissionRequest` (`apps/daemon/src/task-callbacks.ts:75-163`).
   Assistance asks park the task `waiting_for_user` (`:115-118`), persist the live sessionId
   (`:126-129`) and the pending-request record (`:135` → `createPendingRequestRecord`,
   redaction-before-cap on every text surface, `task-assistance.ts:57-89`). Then emit
   `permission` (`:152/:162`) → RPC notify `permission.request` → web dialog.
3. UI: `PermissionDialog.tsx` + `PermissionDialogQuestion.tsx`
   (`apps/web/src/client/components/execution/`) render question text, option buttons, and a
   free-text textarea (`:77-101`, `maxLength 10000`). No credential warning, no masking, no
   detection anywhere. Restored cards are rebuilt from the redacted persisted record
   (`assistance-requests.ts:42-59`, question-kind only).

### 2.2 Reply path (UI → agent → model context)

UI `onRespond` → `respondToPermission` (`apps/web/src/client/stores/task-permission-actions.ts:140-193`)
→ `accomplish.respondToPermission` (HTTP `permission.respond` / Electron IPC proxy) → daemon route
(`apps/daemon/src/daemon-routes.ts:717-761`, zod-validated) → `taskService.sendResponse`
(`task-service.ts:463-477`) → `TaskManager.sendResponse` → adapter
`OpenCodeAdapter.sendResponse:633-709` → `client.question.reply({ answers })` where
`answers = [[...selectedOptions], [customText]]` **raw, unscrubbed** (`:662-681`) → the opencode
session context (the model reads the answer in the continuation).
Live decline/cancel semantics: empty+deny → `question.reject` + cancel mapping
(assistance → `markComplete('error', ASSISTANCE_DECLINE_REASON)` `:696-707`; clarification →
`success`). Restart-flavored decline: `respondToPersistedPendingRequest`
(`task-service.ts:501-591`, single-flight claim + stale-requestId/never-replay guardrails).

### 2.3 Persistence paths (answer / ask text into storage)

- **EP-1 — `question` tool row (ask + answers):** the `question` tool is NOT hidden
  (`tool-classification.ts`; `getToolDisplayName` falls through → `'question'`), so
  `toTaskMessage` (`packages/agent-core/src/opencode/message-processor.ts:125-165`) persists a
  `tool` row carrying raw `toolInput` (agent's question + credential-inviting options text,
  `:132/:159`) and `content` = sanitized tool output (`:133,:149-156`) — opencode's
  question-tool result, which embeds the human's answers. `sanitizeToolOutput` removes ANSI/
  refs/URLs for display but does NO credential scrubbing
  (`message-sanitization.ts:57-91`). The row lands in `task_messages` via
  `taskHistory.addTaskMessage:166-236` (toolInput JSON-stringified at `:209`).
- **EP-2 — assistant continuation echo:** whatever the model then repeats (echoing typed
  secrets) persists as assistant text rows — `sanitizeAssistantTextForDisplay` strips internal
  tags only (`message-sanitization.ts:27-41`).
- **EP-3 — restart-continuation user message:** the persisted pending record never holds the
  answer; but on reply-after-restart the answer is embedded in a continuation prompt:
  `buildAssistanceContinuationPrompt` (`task-assistance.ts:126-143`, `redact()` + 4000-cap) →
  `resumeSession` persists it as a `user` message (`task-service.ts:354-360`) → `task_messages.content`.
  `redact()` (`packages/agent-core/src/utils/redact.ts`) matches only narrow shapes
  (`sk-*`, `xai-*`, `AIza*`, `AKIA*`, labeled `password/secret/token/key = value(16+)`,
  `Bearer *`, base64-32) — an MFA/OTP code, a bare passphrase, or a "verification code: 482913"
  survive.

### 2.4 Log paths (answer text into app logs)

- **EP-4 — renderer `UI permission response`:** `respondToPermission` logs the ENTIRE
  response — `context: { ...response }` including `customText` and `selectedOptions`
  (`task-permission-actions.ts:145-149`).
  - Electron path: `log:event` → `LogCollector` → `LogFileWriter.write` applies `redact()`
    (`LogFileWriter.ts:55`) — narrow patterns only (EP-3 gap applies here too).
  - Browser/gateway path: `POST /client-log` → `handleClientLog`
    (`apps/host/src/gateway.ts:746-786`) redacts ONLY the session bearer token
    (`:778-784`) — the answer text would reach the host log **verbatim**.
- daemon logger (`apps/daemon/src/logger.ts`) is raw console, but no daemon log site records
  answer text today (only requestIds/sessionIds).
- RPC _responses_ are already cross-scrubbed field-wise by the host universal scrubber
  (`apps/host/src/provider-settings-scrubber.ts`, applied at `gateway.ts:658-662`) — the leak
  is the client-log upload, not RPC.

### 2.5 Explicitly NOT exposed (verified)

- The app credential store (AES-256-GCM secrets) is not on this path — the danger is plain
  secret TEXT in model context/transcripts/logs (exfiltration/retention surface).
- Persisted pending-request records are redacted card-context only
  (`task-assistance.ts:57-89`; `pending_request` column), tool input/files dropped.
- Connector OAuth tokens never transit the agent: `request_connector_auth` marker
  (`common/constants.ts:19`) → adapter `auth-error` → toast/Settings → out-of-band OAuth →
  secure storage (`connector-service.ts:46,:97-138`); the agent sees only connection STATUS
  (`formatBuiltInConnectorStatusSection`, `config-generator.ts:326`).

### 2.6 Existing protections reusable

- `redact()` util + call-site pattern (`utils/redact.ts`; barrels `common.ts`, `index.ts`,
  `utils/index.ts`) — reuse and extend, do not fork.
- D4 redaction-before-cap discipline (`createPendingRequestRecord`) as the template for a new
  answer-transport scrubber.
- The connector-auth flow as the canonical "safe alternative" (authenticate out-of-band,
  never type secrets to the agent).
- System-prompt section assembly + content-assertion tests
  (`config-generator.test.ts:1139-1189`, human-verification-gate blocks in
  `system-prompt-behaviors.ts:174-191` and `config-generator-types.ts:183-188`).
- Replay guardrails + `PendingRequestExplainer` error surfacing on the card — reuse for
  blocked-answer messaging (secret-shaped answer → daemon-side fault → card explainer).
- i18n 4-locale suite (en/fr/ru/zh-CN) with alignment tests.
- E2E assets: `apps/host/e2e/specs/35-assistance-question.spec.ts` (live legit ask),
  `36-assistance-restart.spec.ts` (restart recovery), `90-secrets-redaction.spec.ts`
  (DOM/log secret checks).

---

## 3. Phase 2 — Design: defense-in-depth layers

Principle: every layer is independent; a prompt-injection-resistant model, an obedient model,
the UI, and the storage/log surfaces each hold the line alone. All new logic is deterministic
code (regex/classification), never model-dependent.

### L1 — Agent instructions (prompt rule)

- `packages/agent-core/src/opencode/system-prompt-behaviors.ts` — extend
  `TASK_COMPLETION_BEHAVIOR` (next to the HUMAN VERIFICATION GATES block) and add a dedicated
  `<important name="credential-rules">`-style section:
  - NEVER request, collect, repeat, or transcribe passwords, passphrases, MFA/2FA/OTP codes,
    API keys, tokens, recovery/backup codes, or any other authentication secret — not via the
    `question` tool, not via any option, not via free text, not in any tool argument.
  - NEVER author options inviting credential entry (no "share your password", no "type it
    into the browser for me").
  - When a task requires authentication: ask the human to authenticate MANUALLY (their own
    browser, or the site's own login page in the automation browser where the HUMAN types),
    use the canonical pause options `["I'll complete it — please wait", "Skip this verification"]`,
    and continue after confirmation.
- `packages/agent-core/src/opencode/config-generator-types.ts` — mirror the rule inside
  `getBrowserBehaviorInstructions()` (browser tasks are the A7 surface).
- Extend `packages/agent-core/tests/unit/opencode/config-generator.test.ts:1139-1189`
  assertions for the new wording.

### L2 — Deterministic detection (agent-core, browser-safe)

- NEW `packages/agent-core/src/common/credential-detection.ts` (ESM, `.js` imports):
  - `detectCredentialRequest(texts: { value: string; kind: 'header'|'question'|'option' }[]):
{ flagged: boolean; matchedGenres: CredentialGenre[] }` — genre-based cover: password/
    passphrase, OTP/MFA/2FA codes ("verification code", "one-time", "authentication code"),
    API keys/tokens/secrets, recovery/backup codes, credential phrasing ("enter/share/send
    your credentials", "log me in with my…"). Optimized for precision on the ASK side
    (username-only or "account" alone must NOT flag).
  - `containsLikelySecret(text): boolean` — high-confidence ANSWER-side shapes (labeled
    `password: …`, `Bearer …`, `sk-…`, `AKIA…`, base64-32, 4–8-digit OTP preceded by code
    context, etc.).
  - Export via `common.ts` + `index.ts` barrels.
- Type: optional `credentialRisk?: boolean` added to `PermissionRequest`
  (`packages/agent-core/src/common/types/permission.ts`). Non-breaking.
- Adapter: `handleQuestionAsked` runs detection over header+question+option labels and stamps
  the emitted request (`OpenCodeAdapter.ts:1347-1371`).

### L3 — UI warnings + answer blocking (web)

- NEW `apps/web/src/client/lib/credential-guard.ts` (browser-safe): uses the agent-core common
  barrel; `isCredentialFlaggedRequest(request)` trusts `credentialRisk` when present and
  re-runs detection otherwise (restored cards from pre-SEC-1 rows).
- `PermissionDialogQuestion.tsx` / `PermissionDialog.tsx`:
  - When flagged: render a warning banner (AlertTriangle styling consistent with delete-warn)
    — "This question appears to be asking for a password or code. Accomplish agents never
    need your secrets. Authenticate directly on the site instead." + a safe-alternative line
    ("Authenticate manually in your browser, then tell the agent to continue").
  - **Submit block:** if the composed answer (customText or option choice) hits
    `containsLikelySecret`, the Submit button is disabled and the banner states the answer
    was detected as secret-shaped. Editing to a safe answer re-enables Submit. Cancel/Decline
    never blocked.
  - Legitimate free text ("I completed the login in Firefox; continue") passes untouched.
- i18n keys under `permission.credential.*` in all 4 locales + alignment suite.

### L4 — Transport scrubbing + hard block (agent-core adapter, all reply surfaces)

- NEW scrubber in `credential-detection.ts` (or alongside): `scrubAnswerText(text, flagged)`
  — always `redact()` (existing) + flagged-context masking of OTP-digit groups and labeled
  secret values.
- `OpenCodeAdapter.sendResponse` question branch (`:659-681`): redact `customText` unconditionally;
  when the parked ask was flagged → scrub free text; when `containsLikelySecret` on the final
  answer → throw a dedicated blocking error BEFORE any `question.reply` — the task stays
  `waiting_for_user`, nothing is transmitted, the web store seeds the existing
  `PendingRequestExplainer` with a user-friendly message
  (task-permission-actions `:152-174` path), and the user can Cancel (D3 mapping unchanged)
  or submit a safe answer.
  - Covers live UI AND WhatsApp-bridge replies (all live replies cross `sendResponse`).
- Restart path: same guard in `respondToPersistedPendingRequest` before
  `claimPendingRequestForResume` — secret-shaped answer refuses to claim (record stays
  parked, user prompted), legit answers proceed through the already-redacted
  `buildAssistanceContinuationPrompt` (`formatAssistanceAnswer` extended to run
  `scrubAnswerText` on options/custom text — `task-assistance.ts:99-118`).

### L5 — Persistence hygiene (question tool row)

- `packages/agent-core/src/opencode/message-processor.ts` — for `tool_use` rows where
  `tool === 'question'`: run `redact()` + `scrubAnswerText` over the output-derived `content`
  (answers embedded there) and `redact()` the string fields inside `toolInput`
  (agent question/options). Structural fields preserved; other tools untouched (scope
  discipline).
- `task-assistance.ts` — continuation path already redacted; add the scrub (flag-aware via
  the persisted record's question text when claimable).

### L6 — Log hygiene

- `apps/web/src/client/stores/task-permission-actions.ts:145-149` — log
  `{ requestId, taskId, type, decision, selectedOptionCount, customTextLength, credentialRisk }`
  — NEVER the answer text. (Both desktop and gateway log paths lose the leak source.)
- `apps/host/src/gateway.ts` `handleClientLog` — run the shared agent-core `redact()` over
  message + context (deps already present), keeping the 4000/2000 caps and bearer-token step.
- Daemon log sites: no answer text today; keep, and note invariant in the doc.

### L7 — Rejected/blocked request clarity

- Blocked answers surface through the existing card explainer pipeline with explicit copy;
  decline/cancel semantics byte-identical to M6-A T7 (assistance cancel → failed with
  `ASSISTANCE_DECLINE_REASON`; clarification cancel → success; restart-flavor declines →
  `task-service.ts:564`).

### Preservation guarantees

- Tool/file permission cards: untouched (Allow/Deny byte-identical).
- Clarification questions: untouched unless credential-language detected; then warn-only at
  the ask side, block only secret-shaped ANSWERS with a safe re-edit path.
- Connector auth (Slack OAuth): untouched (it is the safe pattern; doc notes parity).
- Assistance lifecycle D1–D5: statuses, header matching, persistence shape, replay
  guardrails, restart auto-resume — unchanged; only warning/scrub layers added.

---

## 4. Affected files (proposed change set)

**New**

- `packages/agent-core/src/common/credential-detection.ts` (+ tests)
- `apps/web/src/client/lib/credential-guard.ts`

**Modified — agent-core**

- `src/common/types/permission.ts` (optional `credentialRisk`)
- `src/common/task-assistance.ts` (scrub in `formatAssistanceAnswer`)
- `src/internal/classes/OpenCodeAdapter.ts` (ask flagging; reply scrub/block)
- `src/opencode/message-processor.ts` (question-row scrub)
- `src/opencode/system-prompt-behaviors.ts`, `src/opencode/config-generator-types.ts` (L1)
- barrels `src/common.ts`, `src/index.ts`

**Modified — web**

- `components/execution/PermissionDialog.tsx`, `PermissionDialogQuestion.tsx` (L3)
- `stores/task-permission-actions.ts` (L6 log shape)
- 4 locale files (`execution.json`)

**Modified — host**

- `src/gateway.ts` (`/client-log` redact)

**Docs**

- `docs/PHASE_3_M6A_MANUAL_CHECKLIST.md` §5 (SEC-1 closure record),
  `docs/M6_DEBUG_CHECKPOINT.md` §8.8 status, `docs/architecture.md` security note.

## 5. Regression strategy (existing behavior must not move)

- M6-A T7 surfaces: `opencode-adapter-permissions.unit.test.ts` (assistance tagging +
  decline mapping), `pending-request-recovery.unit.test.ts` (restart matrix),
  `task-assistance.test.ts`, `task-pending-request.test.ts` (persist shape),
  `daemon-routes-task-pending-request.test.ts`, web `PermissionDialog*` suites +
  `task-permission-actions.assistance` suite — ALL must stay green without edits except
  where explicitly extended (prompt assertions; new log-shape test replaces the old logEvent
  assertion in `task-permission-actions.assistance.unit.test.ts:443,450-456`).
- Live e2e continuity: `35-assistance-question.spec.ts` + `36-assistance-restart.spec.ts`
  (legit asks must still park/resume identically); `90-secrets-redaction.spec.ts` extended
  with a scripted credential-ask scenario where feasible.
- Full battery before milestone: `pnpm typecheck && pnpm lint:eslint && pnpm format:check`,
  agent-core + web + daemon suites, desktop suite untouched-but-green.

## 6. New automated tests (Phase 3 map)

| Genre covered                                                                                                                | Where                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Password ask detection                                                                                                       | `credential-detection.test.ts`              |
| MFA/OTP ask detection                                                                                                        | `credential-detection.test.ts`              |
| API key / token / secret ask detection                                                                                       | `credential-detection.test.ts`              |
| Recovery/backup-code ask detection                                                                                           | `credential-detection.test.ts`              |
| Legit questions NOT flagged (usernames, dates, amounts, "log in and check order status")                                     | `credential-detection.test.ts`              |
| Answer-side high-confidence secret shapes + legit text passes                                                                | `credential-detection.test.ts`              |
| Adapter flags ask (`credentialRisk`), scrubs reply, blocks secret reply (no `question.reply` call), cancel mapping unchanged | `opencode-adapter-*` unit tests             |
| Password / MFA / API key / recovery-code replies blocked across live + restart                                               | daemon `pending-request-recovery` extension |
| Question-row content/toolInput scrubbed on persist                                                                           | `message-processor` unit test               |
| UI warning renders; secret answer blocks Submit; safe answer passes; cancel unaffected                                       | web dialog component tests                  |
| Manual-browser-auth guidance copy present when flagged                                                                       | web dialog test                             |
| Renderer log payload excludes answer text                                                                                    | web store test                              |
| `/client-log` redacts credential-shaped context                                                                              | host gateway scrub test                     |
| Restart task recovery with legit answer unchanged; blocked keeps task parked                                                 | daemon unit matrix                          |
| Prompt contains never-request + manual-auth rule                                                                             | `config-generator.test.ts`                  |

## 7. Security tradeoffs (explicit)

1. **Heuristic detection:** ask-side detection is precision-tuned; a novel phrasing could be
   missed by regex (layered behind prompt rule + transport scrub so a missed detection still
   gets `redact()` + manual-auth guidance). Ask side never blocks (warn-only) — transparency
   preserved.
2. **Answer-side hard block could refuse a secret the user truly wants to send** (e.g. a
   deliberate API key share). Intentional: Accomplish's safe path is Settings/connectors
   storage or out-of-band auth; sharing secrets through the agent transcript is the thing
   SEC-1 exists to prevent. The block is always escapable via Cancel/safe re-edit.
3. **Scrubbed answers degrade agent context:** if a flagged ask's answer gets scrubbed
   (`[REDACTED]` fragments) the agent may need a rephrase — acceptable; the correct route is
   manual authentication.
4. **OTP digit-pattern risk:** digit groups masked only in flagged-ask context to avoid
   corrupting legitimate numbers (dates, counts) in unflagged conversations.
5. **Log hygiene reduces debuggability:** answer text no longer reaches any log; we keep
   lengths/counters/flags for diagnosing reply flows without retention risk.
6. **Prompt layer honesty:** no prompt change can guarantee model compliance; it is the
   outermost of 5 independent layers, never the only one (per user directive).
7. **DETECTION LIMITATIONS — no complete-protection claim (requirement 8):** this module is
   heuristic and inductive. Both false negatives and false positives are expected:
   - **False positives (over-blocking):** a text that merely LOOKS secret-shaped is blocked —
     e.g. "the promo code is SAVE20" on a flagged ask, a quoted finding ("the leaked password
     is X" pasted from a breach report), long base64 blobs in legitimate answers. The host
     log channel masks aggressively on purpose (over-masking a log is harmless);
     answer surfaces bound over-masking to flagged asks.
   - **Evasions (under-blocking):** paraphrase/synonym asks, foreign-language asks
     (patterns are English-only), unlabeled secrets on unflagged asks (by design — bare
     digits/strings on ordinary asks are never corrupted), secrets split across an option
     - custom text, or a user pasting a secret in a form the patterns do not characterize
       (e.g. a webauthn/discovery URL). Detection is per-part; cross-part reassembly is not
       attempted.
   - **Consequence:** SEC-1 layers reduce the credential-collection surface substantially
     but are NOT a guarantee. Defense-in-depth layering (prompt rule, ask warn, answer
     block, persist scrub, daemon guard, log redaction) plus user education remain the
     controls; users must continue to treat any agent chat as a place where secrets do
     not belong.

## 8. Delivery workflow after approval (Phase 3 + 4)

1. Implement L1–L7 (+ docs) with no other-scope changes.
2. Run full verification battery (§5) + new tests.
3. Regression review of M6-A T7 surfaces (§5 list, all green).
4. Update docs (§4 docs list) and record SEC-1 closure in the checkpoint.
5. Single milestone commit, conventional message (e.g.
   `feat(security): SEC-1 — block credential collection via agent question dialogs`).
6. Report commit hash + verification results. **No push, no merge, no T8.**
