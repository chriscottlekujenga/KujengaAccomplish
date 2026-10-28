# T8 Closeout Plan (M6-A) — Readiness Assessment + Checklist

Assessment date: 2026-10-27 (post-SEC-1 commit `cf87104`, tree clean).
**Verdict: READY — T8 is a docs-only closeout task; every input it needs is committed at
`cf87104`. Do not start M6-B before the T8 report + explicit user approval (plan §10 hard stop).**

## What T8 must deliver (per `docs/PHASE_3_M6_PLAN.md` T8 row)

1. **`docs/DEVELOPMENT_CHECKPOINT.md` §24 addendum** (mirrors the §23 M5 closeout shape):
   - 24.1 delivered-per-task table (T0–T7 + the SEC-1 hardening commit, each with its
     acceptance + result);
   - 24.2 suite counts at M6-A close — current committed-HEAD numbers:
     typecheck 5/5 · lint 0E/3W (pre-existing) · format clean · agent-core **881 pass +
     1 skip** (68 files) · daemon **392** (30 files) · host **341** (16 files) · web unit
     **557** · web integration **244 pass / 8 fail (pre-existing, root-caused in
     `docs/SEC1_PROGRESS_LOG.md`)** · desktop **522** · gateway E2E 18/18 standing from T6
     (re-run option: serial, ~3 min);
   - 24.3 parity re-audit record: allowlist/blocklist/registered counts UNCHANGED from T6
     (99/7/138) — SEC-1 touched `config-generator*` prompt rules only (byte-additive);
     re-run the parity audit test at close HEAD and record the numbers;
   - 24.4 manual-checklist reference (T7 record + checklist §5 SEC-1 closure);
   - 24.5 limitations disposition — update the M5 §23.5 / M6-plan §9 table rows (see 2 below);
   - 24.6 security posture statement — M1/M2 surfaces unchanged by SEC-1 verification;
     SEC-1 ADDS hardening (7 layers) with zero policy/allowlist deltas;
   - 24.7 git table (M6-A commits + `cf87104` SEC-1);
   - 24.8 next gate: STOP — user approval required for M6-B.
2. **M5-limitations table battery re-compare** (`docs/PHASE_3_M6_PLAN.md` §9 row 4 and the
   M5 checkpoint §23.5 row 4): replace "web integration 61 upstream" with the re-compared
   state — 158/61 pre-SEC-1-load-debt RESOLVED (shared setup stubs, +86 passing), 8
   remaining pre-existing failures root-caused (missing `useAccomplish` mock in
   App.integration's per-file mock; stop-button-while-loading assertions vs
   `TaskInputToolbar` disabled-during-loading behavior) — with the do-not-weaken note.
3. **`docs/M6_DEBUG_CHECKPOINT.md` §8 — final state** (short): closeout battery numbers,
   §6.7 cross-window checks extended over the SEC-1 commit window (policy.ts / allowlist /
   cdp/sidecar byte-untouched — already asserted in the SEC-1 progress log), SEC-1 closure
   cross-reference.
4. **Plan-status update** (`docs/PHASE_3_M6_PLAN.md`): mark T0–T8 statuses COMPLETE in the
   task table / add a closeout note "M6-A closed at <docs-commit>".
5. **Docs commit** (conventional, e.g. `docs: M6-A T8 closeout — checkpoint §24, plan
status, limitations re-compare; M6-A closed`). NO push/merge. STOP.

## New facts T8 must record that predating docs do not have

- SEC-1 commit `cf87104` (task-service restart guard, credential-detection module, UI
  block, log redaction upgrade, +5 SEC-1 test suites).
- Web-integration baseline MOVED by the SEC-1 session's shared-setup stub fix (158/61 →
  244/8) — this is a test-infrastructure fix upstream of the "upstream baseline" claim;
  T8 must re-characterize the residual 8 explicitly (root causes in the progress log).
- Host `/client-log` redaction upgraded (`redact` → `scrubCredentialText` aggressive) —
  the M1 §5.4 redaction still intact, credential layer added.
- Detection limitations statement (requirement 8): design doc §7.7 — no complete-protection
  claim; consequences for users.

## Est. effort

S (0.25–0.5 d): all content is written down already (progress log + checklist §5 closure +
checkpoint items); T8 is assembly + one battery re-run + one parity re-run + docs commit.
