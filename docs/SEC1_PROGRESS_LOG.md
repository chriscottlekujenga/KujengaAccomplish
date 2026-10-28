# SEC-1 Hardening — Progress Log

Working session log for the SEC-1 credential-collection hardening
(approved plan: `docs/SEC1_CREDENTIAL_HARDENING_DESIGN.md`).
Baseline: M6-A T7 complete (HEAD `4306651`).

---

## Implementation status — ALL LAYERS COMPLETE, FULL BATTERY GREEN (except documented pre-existing debt)

### Code delivered (uncommitted working tree; single milestone commit pending)

- **L1 Prompt rules** — `system-prompt-behaviors.ts` + `config-generator-types.ts`: the agent
  must never request/repeat/transcribe credentials and must offer manual browser auth.
- **L2 Detection module** — `packages/agent-core/src/common/credential-detection.ts`:
  - Genres: `password | mfa_code | api_key | recovery_code | credential_phrase`.
  - `detectCredentialRequest` (ask side, header-independent, warn-only),
    `containsLikelySecret` / `isCredentialUnsafeAnswer` / `assertCredentialSafeAnswer`
    (answer side, hard block), `scrubCredentialText` (masked scrub; aggressive-log mode),
    `hasOtpLikeDigits` (5–8 digit groups, evaluated ONLY on flagged asks),
    `CREDENTIAL_BLOCK_USER_MESSAGE`.
- **L3 Adapter guard** — `OpenCodeAdapter.ts`: `handleQuestionAsked` stamps
  `credentialFlagged` / `PermissionRequest.credentialRisk`; `sendResponse` asserts answer
  safety BEFORE `question.reply` (task stays parked on block) and scrubs options/customText.
- **L4 UI** — `credential-guard.ts` (isCredentialFlaggedRequest: trusts the live adapter
  stamp, re-detects for restored pre-SEC-1 records), `PermissionDialog.tsx` +
  `PermissionDialogQuestion.tsx` (warning banner `credential-warning`, block message
  `credential-blocked`, Submit hard-blocked on secret-shaped typed answers — Cancel/Decline
  never blocked), locales ×4 (`permission.credential.*`).
- **L5 Persistence hygiene** — `message-processor.ts` (question-tool rows in
  `task_messages` scrubbed), `task-assistance.ts` (`buildAssistanceContinuationPrompt`
  scrub; summaries), restart continuation prompts.
- **L6 Daemon restart guard** — `task-service.ts` (`respondToPersistedPendingRequest`):
  re-detects credentials from the STORED ask text, blocks secret answers BEFORE the
  single-flight claim (refused answer leaves the record parked + retryable).
- **L7 Host log redaction** — `gateway.ts` `handleClientLog`: bearer-token step, then
  `scrubCredentialText(text, true)` (aggressive mode) — message AND context, before size caps.
- **Types** — `permission.ts` (`credentialRisk?: boolean`), barrels `common.ts`/`index.ts`.

### Verification (all green unless noted)

- agent-core: 881 passed / 1 skipped (68 files) — incl. credential-detection (16),
  adapter SEC-1 (blocked: labeled password, labeled api key, bare MFA code on flagged ask;
  allowed: labeled code on unflagged ask), continuation/persist/prompt suites.
- daemon: 392 passed (30 files) — incl. SEC-1 restart-path block + restart-after-manual-auth.
- host: 341 passed (16 files) — incl. `/client-log` credential-redaction (caught a real gap:
  `redact()` missed prose forms "password is X" → scrubber prose mask added).
- web unit: 557 passed — incl. PermissionDialogCredential suite (warning render, submit
  block + re-enable, bare MFA block, cancel-never-blocked, manual-auth copy,
  unflagged byte-identical) + store SEC-1 log-hygiene (answer text never in logs).
- desktop: 522 passed.
- `pnpm typecheck` (5 workspaces), `pnpm lint:eslint` (0 errors; 3 pre-existing warnings in
  useExecutionEffects.ts), `pnpm format:check` — green.

### Pre-existing web-integration debt (NOT SEC-1; confirmed failing before/at baseline)

- Root cause 1: suites could not even LOAD at baseline — missing `window.accomplish`
  daemon-reconnect stubs (`onDaemonReconnected`/`onDaemonDisconnected`/
  `onDaemonReconnectFailed`/`daemonPing`). FIXED in shared `__tests__/setup.ts`
  (+ per-file stub in taskStore.integration) → net +86 passing integration tests.
- Root cause 2 (14 remaining failures at T8 re-compare, surfaced as previously-masked
  suites now load): stop-button-while-loading ×3 (TaskInputBar, Home — assertions vs
  current `TaskInputToolbar` disabled-during-loading behavior); Home provider-ready-gate
  family ×5; SettingsDialog Slack-card/regression ×3; Execution UI-staleness ×3 (Continue
  button gone, duplicate "Cancelled" text, Slack resume button). Left untouched: fixing
  requires either a product-behavior change or test-assertion maintenance — both outside
  scope (M5 §23.5#4 upstream directive).
- One benign pre-existing close-button double-call in TaskLauncher
  (`DialogPrimitive.Close` + explicit onClick) — assertion aligned with the adjacent
  Escape-test convention (test-only, idempotent call).

### Completed after this log was written

- The previously-masked integration suites were brought to RUNNABLE state with
  infrastructure-only mock fixes: `App.integration` (+`useAccomplish` export),
  `SettingsDialog` (+`getBuildCapabilities`), `Execution` (+ store-derived fields
  refetchPendingRequest / restoredRequestIds / permissionRequestErrors /
  clearPermissionRequestError / startup fields + daemon-family stubs), `Home`
  (+getBuildCapabilities/getEnabledSkills/resyncSkills + daemon family). Net: integration
  went from "8 fail / 244 pass of 252" to **371 pass / 14 fail of 385** — no test assertion
  weakened; residual 14 root-caused and recorded for the team (see root cause 2 below).
- Gap-fix recorded earlier: `/client-log` prose-form redaction ("password is X") —
  scrubber + gateway hardened; host 23/23.
- T8 closeout executed (user-directed autonomous): checkpoint §24
  (`docs/DEVELOPMENT_CHECKPOINT.md`), debug-checkpoint §8 final state, plan §5 status +
  §9 row-4 re-compare, checklist §5 numbers refreshed. Closeout battery + parity re-run at
  docs HEAD: typecheck 5/5 · lint 0E/3W (pre-existing) · format clean · agent-core
  881+1skip · daemon 392 · host 341 · web unit 557 · desktop 522 · integration 371/14 ·
  parity 99/7/138 self-checks PASS.
- Milestone commit + T8 docs commit: **`cf87104`** / **`682e719`** / this docs commit.
- **STOP reached: M6-B awaits explicit user approval.**
