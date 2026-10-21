# Next OpenCode Session — Ready-to-Use Prompt

Copy everything inside the block below as the first message to a fresh
OpenCode session. The session runs as **developer** under the multi-agent
architecture (GLM-5.3 Cloud = architect; GLM-5.3 Flash = developer/this
session).

---

```
You are the developer agent for the KujengaAccomplish Firefox migration,
operating under a multi-agent architecture (GLM-5.3 Cloud is your
architect; escalate to it for complex problems). Use GLM-5.3 Flash
(glm-5.3-flash:cloud) as your default model.

CONTEXT — read these first, in order, before touching any code:
1. docs/DEVELOPMENT_CHECKPOINT.md  — the complete state checkpoint,
   including §B "Active Debugging State" (confirmed observations vs
   hypotheses vs next diagnostics).
2. .opencode/plans/FIREFOX_MIGRATION_PLAN.md — the six-phase roadmap.
3. docs/AI_DEVELOPMENT_WORKFLOW.md — model selection, context, git, and
   task-tracking rules you must follow.

Then inspect the Git state:
   git status && git log --oneline -3
Branch must be linux-firefox-ai; HEAD is 7f238d4 (Phase 1). Phase 2 work
is intentionally uncommitted (38 changed/untracked files) — do NOT commit,
reset, or discard anything without completing the acceptance below.

YOUR TASK — resume Phase 2 without repeating completed work:
Everything in checkpoint §4 and §11–§12 is DONE and verified. Do not
re-implement or re-verify it. The single open blocker is §B: the embedded
OpenCode runtime starts, generates a correct per-task ollama provider
config (baseURL http://127.0.0.1:11434/v1, model glm-5.3:cloud), but the
prompt never produces a model call (no TCP connection to 11434; task hangs
in "waiting for response"). Follow the diagnostic steps in checkpoint §B
in order: inspect OpenCodeAdapter.ts session.prompt call site and how
selectedModel reaches it, inspect config-generator model wiring, then
drive the opencode server directly (curl) to isolate adapter-vs-opencode.

Rules:
- Use GLM-5.3 Flash for investigation and fixes. Escalate to GLM-5.3 Cloud
  ONLY if the two primary hypotheses (§B H1 model-passing, H2 provider
  package loading) are eliminated or the problem proves architecturally
  deep.
- Limit retries: at most 2 focused attempts per hypothesis, then document
  and change approach. No long autonomous loops.
- Preserve the existing Firefox implementation (apps/host, gateway-bootstrap,
  the shim) — the bug is expected in the model wiring, not in the shell.
- Work only in ~/KujengaAccomplish-AI. Never modify /home/chris/Accomplish,
  production databases, or production opencode credentials
  (~/.local/share/opencode/auth.json). Isolated data dir only:
  ~/.local/share/Accomplish.

COMPLETE AI TASK EXECUTION TESTING (Phase 2 acceptance):
Once the fix lands, rebuild (daemon + agent-core if touched, host, web),
recreate the task harness from checkpoint §15 (starts a task via the
gateway HTTP+WS contract, auto-approves permission prompts, then verifies
/tmp/opencode/accomplish-phase2-test/hello_phase2.txt contains exactly
"Accomplish Phase 2 works"), and confirm:
  - the task runs to completion through the daemon
  - hello_phase2.txt exists with the correct content
  - closing Firefox mid-task does not stop the daemon; reopening restores
    history
  - the full battery passes: pnpm typecheck && pnpm lint:eslint &&
    pnpm format:check && host/web/daemon/agent-core/desktop suites
    (web-integration has 61 pre-existing baseline failures — not yours)

Then:
  - Update the checkpoint (§B resolved, results, any new findings).
  - Commit the verified Phase 2 changes on linux-firefox-ai with a
    conventional message (e.g. "feat(host): Ubuntu ARM64 Firefox shell
    integration (migration phase 2)"). Never commit credentials, databases,
    logs, or build artifacts. Do not push or merge.
  - Report the commit hash and test results, update the task list, and
    STOP.

Request my explicit approval before starting Phase 3.
```

---

## Post-session expectations

| Item               | Value                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| Must produce       | Resolved §B + AI task acceptance + Phase 2 commit hash                                  |
| May not produce    | Phase 3 work, pushes/merges, schema/migration changes                                   |
| Escalation trigger | Both §B hypotheses eliminated, or watchdog/SDK behavior proves architecturally deep     |
| Safety rails       | Isolated data dir; no production credentials; Electron regression suite must stay green |
