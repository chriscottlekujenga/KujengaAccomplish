# PHASE 3 M5 — Deferred-Designs Recommendations (M6+ Prioritization)

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `bbaa5b7` + this M5-closeout docs commit (T8)
**Purpose:** M5 T8 deliverable. **Recommendations only — nothing is implemented, no M6 work has started, nothing pushed/merged.** M6 requires separate user approval (plan §13).
**Sources:** `docs/PHASE_3_M4_PLAN.md` §C1–§C3 (design text recorded at M4 time), `docs/PHASE_3_M5_PLAN.md` §7 (review directive — "reviewed for recommendations only, no implementation"), M5 T7 findings (debug checkpoint §1.G — blank preview panel, denial-UX observation, model-list staleness note).
**Ground rules binding every future implementation (all four designs):**

- No CAPTCHA/MFA bypass anywhere — the human completes the verification; automation only pauses, notifies, resumes.
- No auto-approve; no permission weakening; the M1 presence gate, the 5-min permission in-flight timeout, the scrubber/redaction suites, and the allowlist/blocklist tripwires stay byte-identical.
- Every new daemon RPC / shim method follows the plan §5.4 expansion policy (response-shape docs + scrubber-or-proof + authorization test + redaction test, paired).
- The dev-browser sidecar token never leaves the daemon; the sidecar relay/CDP stays loopback + first-message/bearer auth.

---

## 1. Design 1 — CAPTCHA/MFA assistance trigger (M4 plan §C1)

**State today (committed, M4):** `waiting_for_user` exists in `TaskStatus` with full plumbing + UI badge support, but has **no runtime trigger** — nothing ever sets it. The surrounding machinery is live and soak-proven: `waiting_permission` parks tasks on human prompts, waiting rows survive daemon restarts byte-identically (session id + cwd preserved), `resuming` is a first-class transient, and `session.resume` continues the SAME opencode session (M4 soak 6/6; M5 T3 recheck 6/6).

| Option                                | Mechanics                                                                                                                                                                                                               | Pros                                                                                                                                                                                       | Cons                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — daemon-side tool-name watcher** | Register a small `human-assist` MCP server exposing one well-known tool (e.g. `request_human_assistance`); the daemon watches adapter tool-use events for that exact tool name and flips the task to `waiting_for_user` | Deterministic trigger semantics (daemon owns the state flip); zero opencode changes; works even if instruction-following degrades                                                          | New MCP surface + generated-config change + (potentially) allowlist expansion; the trigger still relies on the model choosing to call the tool; one more registration to test in every config shape         |
| **B — opencode question flow**        | Workspace instruction/skill tells the agent to raise an SDK `question` when human verification is needed; the daemon maps the question event → `waiting_for_user` and auto-resumes on reply                             | Reuses existing ask/reply plumbing end-to-end; zero new MCP servers and zero allowlist additions; smallest possible surface; the reply text can be fed back into the resumed turn verbatim | Deterministic only as far as instructions are followed (a model that silently flails instead of asking is not caught — watchdog still bounds it); question text is free-form and needs length/shape capping |

**Recommendation: Option B primary.** Rationale: the M4 approval directive made "pause and ask the human" the first-class path, and Option B is the purest realization of that with the least new surface — the M4 state machine, the resume path, and the ask/reply wire all already exist and are regression-proven. Adopt Option A later only as hardening IF live adherence to the question instruction proves unreliable (its deterministic tool-name watcher is the designed fallback).
**Prompt-injection caveat (must be designed in, not bolted on):** the question text may itself be influenced by page/tool content (e.g. page text asking the agent to "ask the human for the password"). Treat question payloads as untrusted: hard length cap, no secret-shaped echo, the reply path only ever returns human-typed text into the SAME already-authorized session, and the daemon never parses question content to make policy decisions.

## 2. Design 2 — Browser-session handoff (M4 plan §C2)

**Constraints recorded at M4 (all still accurate):** the handoff must (a) surface the **SAME daemon-owned Chromium instance** to the user — a fresh profile would not carry the session cookies or the challenge; (b) pause the affected task **safely BEFORE handoff** (a `waiting_*` state, never mid-turn); (c) restore agent control after. Implementation requires a daemon RPC + shim method + UI, i.e. an allowlist expansion under the §5.4 policy, plus sidecar window-management support (raise/focus the agent's tab on this display).

**T7 interlock (debug checkpoint §1.G):** the browser preview panel renders **blank** — frames are generated and delivered server-side, but the preview service captures its **own** fresh `${taskId}-main` tab while the agent's tools navigate a **separate** relay/CDP tab in the same sidecar. This is recorded **unresolved** (user directive — fix is an M6 design decision across the daemon page-service, relay, and MCP-tool naming/wiring; must be manually re-verified if fixed). **The seam and the handoff share one concept** — an authoritative "agent-active page" identity in the sidecar — so the preview fix should be designed/built inside the same work item rather than twice.

**Recommendation:** treat [preview-seam fix + handoff] as ONE coherent "browser-surface" work item; sequence it **after** Design 1 (which defines WHEN a handoff is ever offered — i.e., during a `waiting_for_user`/verification wait) and after the naming decision. Do not run it before Design 1.

## 3. Design 3 — Remote assistance via Android (WhatsApp bridge channel)

**What exists today (committed):** the daemon's WhatsApp integration (Baileys) — inbound messages create/continue tasks with `source='whatsapp'`; outbound messages flow via the bearer-auth `:9230` send API (the `whatsapp-send` MCP tool) or `WhatsAppService.sendMessage`; WhatsApp-source tasks hitting a permission are parked `waiting_permission` and then **auto-denied** by the task bridge (no reply-wait over WhatsApp exists — the M1 source-based dispatch policy); WhatsApp config RPCs are allowlist-blocked and deferred to M6 parity (4 methods, per PARITY_INVENTORY).
**Design sketch (for later approval):** extend the bridge's task-event vocabulary for waiting tasks — on `waiting_permission`/`waiting_for_user`, push a compact summary to the paired chat (question/permission text length-capped, optionally a `devBrowser.captureFrame` PNG of the agent's browser tab as context for question-type waits); accept a structured reply (allow / deny / text answer) and route it through the existing `sendResponse` / (Option-B) question-reply path with auto-resume via Design 4.
**Constraints & honest limits:** the gateway is loopback-only by design, so a mobile-Web gateway is NOT the route — WhatsApp is the channel that already authenticates and leaves the machine; message payloads must run the same secret-shape scrubbing (never relay credential-shaped text, even if the user offers it); the existing bridge rate limiter and `MAX_MESSAGE_LENGTH` caps apply; this channel enables **question/choice-type** assistance and evidence viewing only — solving an interactive CAPTCHA on the agent's browser remotely still requires Design 2 (handoff) at the machine, or the user doing the verification on their own device/session where possible. No CAPTCHA-solving service, ever.
**Recommendation:** after Design 1 exists (the reply plumbing and auto-resume are shared); schedule inside the M6 WhatsApp-parity window rather than before it.

## 4. Design 4 — Resume-after-human-verification

**What M4 already proved (committed):** waiting rows survive restarts byte-identically; resume reuses the SAME opencode session with the persisted cwd; the `resuming` transient is persisted/emitted; human thinking time never trips the watchdog. Today resume is **manual** (`session.resume` invoked by the user/UI).
**What remains (design level):** auto-resume wiring — a resolved verification (permission reply / question reply from Designs 1–3) triggers `resumeSession` automatically instead of waiting for a user click. Guardrails that must ship together: single-flight resume (idempotent double-reply/double-resume via the `resuming` transient), stale-reply rejection (request/ask-id + session-id match; replies after terminal/completed states are ignored), an explicit stale-wait TTL policy for `waiting_for_user` rows (notify/expire surface decision — the M4 directive's "no timeout races a human reply" bound still applies: expiry must surface, never silently deny a running turn), and no new credentials on any of these paths.
**Recommendation:** implement together with Design 1 — the trigger without the resume leaves the state machine half-closed. Do not relax the 5-min permission in-flight timeout.

## 5. Recommended prioritization + concrete next-milestone proposal

**Priority order (recommended):**

1. **Assistance loop v1** = Design 1 Option B + Design 4 (trigger + auto-resume). Small-surface, completes M4's 80%-built state machine, directly serves the background-first directive.
2. **Preview active-page seam fix** (T7's most user-visible leftover; needs the page-naming decision first — see §2). Can proceed as a standalone quick fix if the assistance loop slips.
3. **Browser-session handoff** (bigger; sidecar window management + allowlist expansion under §5.4).
4. **WhatsApp/Android assist channel** (needs WhatsApp M6 parity surface; shares loop-v1 reply plumbing).
5. **Token-in-journal hardening** (T7 user-directed record: launcher writes the token-fragment URL to the journald user journal) — fold in when the next launcher/gateway-surface work item touches logging.

**Concrete proposal (for approval — NOT an authorization to start):**

- **M6-A — Human-Assistance Loop v1 (S–M, first):** Option-B question-flow trigger + auto-resume + preview active-page seam fix. Acceptance sketch: a real ollama task that hits the question flow parks at `waiting_for_user`; a daemon restart during the wait leaves the row resumable (byte-identical, session + cwd preserved); the reply auto-resumes the SAME opencode session to completion; the preview panel renders the agent's actual page (verified in the gateway E2E harness AND re-run manually with the user, since T7 documented the failure mode there); no policy/allowlist changes; full battery green.
- **M6-B — Remaining API parity (M–L, as planned in §6 of the Phase 3 plan):** unchanged (OAuth re-homing, GWS/WhatsApp incl. its assist-channel extension, daemon control, bug report/speech, analytics, final parity audit).
- If the user prefers the plan unmodified, the assist loop becomes **M7** — the dependency graph permits either order (loop v1 depends only on committed M4 plumbing).

**Not recommended:** starting handoff (§2) before the trigger and the seam decision; implementing Option A before B; any new listener/network exposure for the gateway.

## 6. Standing out-of-scope statement

Nothing in this document authorizes implementation. No M6/M7 work was started in M5; all four designs remain deferred; M6 starts only with the user's separate approval and its own plan/review documents.
