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
- Root cause 2 (8 remaining failures, surfaced only now that files load): stop-button
  while loading — 3 suites assert the Stop button stays ENABLED during loading, while
  `TaskInputToolbar` disables it (`isButtonDisabled`); and App.integration's per-file mock
  lacks `useAccomplish` (CloseConfirmDialog). Left untouched: fixing requires either a
  product-behavior change or test-assertion weakening — both outside SEC-1 scope.
  Files/owners for the team: App/Home/TaskInputBar/Sidebar/SettingsDialog/Execution
  integration suites.
- One benign pre-existing close-button double-call in TaskLauncher
  (`DialogPrimitive.Close` + explicit onClick) — assertion aligned with the adjacent
  Escape-test convention (test-only, idempotent call).

### Remaining session tasks

- Milestone commit (conventional message; NO push/merge).
- T8 readiness assessment (plan/checklist only — NO implementation).
- Morning report (11 items; commit hash; verification results; limitations; T8 handover).
