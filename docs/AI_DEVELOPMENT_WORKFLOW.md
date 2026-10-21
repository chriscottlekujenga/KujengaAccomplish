# AI Development Workflow — KujengaAccomplish Firefox Migration

Operating strategy for AI agents working on this repository. Goal: minimize
Ollama Cloud spend without sacrificing quality or progress.

## Model Selection

**GLM-5.3 Flash Cloud (`glm-5.3-flash:cloud`) — default for:**

- Routine coding and small features
- Unit tests, TypeScript fixes, lint/format corrections
- Documentation and checkpoints
- Simple debugging (clear stack traces, missing imports, config tweaks)
- Build error corrections
- Re-running established test suites and reporting results

**GLM-5.3 Cloud (`glm-5.3:cloud`) — reserved for:**

- Architecture decisions and design tradeoffs
- Complex debugging (multi-process, race conditions, protocol-level failures)
- Difficult integration problems (e.g., the current OpenCode runtime/model-passing hang)
- Reviewing major changes before commit

**Local models:** use only for trivial tasks where reliability is already
proven (e.g., formatting, grep-style lookups). Do not hand complex work to
underperforming local models — a failed cheap attempt costs more than one
good expensive attempt.

**Rule:** start with Flash. Escalate to GLM-5.3 Cloud only when Flash has
made a focused attempt and the problem is genuinely hard. State the model
choice when beginning a session.

## Context Management

- **Start a fresh session at phase boundaries.** Read
  `docs/DEVELOPMENT_CHECKPOINT.md` first — never re-derive established state.
- **Checkpoint before switching sessions** — update
  `docs/DEVELOPMENT_CHECKPOINT.md` so the next session resumes, not repeats.
- **Instructions live in repository documents** (checkpoint, migration plan,
  this file) — not in chat history.
- **Read only relevant files.** Do not re-analyze the whole repository;
  the checkpoint lists the important files per area.
- **Summarize previous investigations** (§B of the checkpoint) instead of
  repeating them. Confirmed observations are facts; hypotheses are labeled.
- **Focused debugging first:** one hypothesis → one targeted test → evaluate.
  Prefer targeted single-file test runs over full batteries mid-debug.
- **Limit retries:** the same failing operation gets at most 2 focused
  attempts per hypothesis; then document and change approach.
- **No long autonomous loops:** cap any single debugging loop at ~15 minutes
  of tool calls; checkpoint and stop if unresolved.
- **Expensive operations require justification:** real AI task runs,
  repository-wide test batteries, downloads.

## Git Management

- **Commit verified milestones only** — a commit means: relevant tests pass
  AND verification evidence exists (documented in the checkpoint).
- **Never commit** credentials, tokens, `gateway-token` files, databases,
  logs, build artifacts, Playwright/browser caches.
- **No automatic commits of broken or unverified work.** If acceptance
  fails, the work stays uncommitted with state documented in the checkpoint.
- **Never reset, discard, or force anything without explicit user approval.**
- No pushes, merges, or branch creation without instruction. Phase 1 commit:
  `7f238d4`. Phase 2 commit happens only after AI-task acceptance passes.

## Task Tracking

Maintain a live task list (OpenCode task-tracking tools) with four sections
and update it as work proceeds:

```
Completed:  [verified items with evidence]
Current:    [the single active task]
Remaining:  [ordered next steps]
Blockers:   [anything requiring user input or escalation]
```

**Current task list for Phase 2 (as of this checkpoint):**

- Completed: Phase 2 shell implementation (launcher, .desktop, systemd,
  pickers, deep links, bootstrap fix, diagnostics channel) · startup crashes
  fixed and verified · full test battery green · manual Firefox verification
- Current: resolve the OpenCode model-passing hang (checkpoint §B),
  then complete AI task execution acceptance
- Remaining: rerun task harness → verify `hello_phase2.txt` → mid-task
  Firefox-close survival check → full battery → commit on `linux-firefox-ai`
- Blockers: none requiring user input; GLM-5.3 Cloud is recommended for the
  debugging step itself

## Cost Discipline Summary

| Activity                             | Model         | Budget                 |
| ------------------------------------ | ------------- | ---------------------- |
| Docs, tests, lint, builds            | Flash         | generous               |
| Focused debugging                    | Flash first   | ≤2 attempts/hypothesis |
| Hard problems, architecture, reviews | GLM-5.3 Cloud | when justified         |
| Full test battery                    | Flash         | at milestones only     |
| Real AI task runs                    | GLM-5.3 Cloud | acceptance tests only  |
