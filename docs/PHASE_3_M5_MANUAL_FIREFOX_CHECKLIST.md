# M5 T7 — Manual Firefox Acceptance Checklist (run with the user)

**Date:** 2026-10-23 · **Branch:** `linux-firefox-ai` · **HEAD:** `68a5325` · **Plan source:** `docs/PHASE_3_M5_PLAN.md` §6 · **Task:** T7 of `docs/M5_REMAINING_TASKS.md`
**Session rules:** one item at a time · every human-interactive item waits for the user's explicit confirmation before its status may change from NOT RUN to PASS · an unperformed item is recorded NOT RUN / SKIPPED and is never claimed passed · production data, policy (`apps/host/src/policy.ts`), security surface, and the running production daemon are preserved exactly as they are.

---

## 1. Runtime provenance & safety preconditions (verified by the architect before the session)

| Check                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production daemon                               | pid **3945** alive — `…/apps/daemon/dist/index.js --data-dir /home/chris/.local/share/Accomplish`, started 2026-10-23 14:32:45 EDT. **Untouched by all M5 automated tasks** (T3–T6 cmdline/environ invariance recorded). We will never SIGTERM, restart, or signal this process.                                                                                                                                                                                        |
| Production daemon code provenance (honest note) | The daemon dist was rebuilt from M5 HEAD at 15:28 (T3 soak prep), i.e. **after** the running daemon (14:32:45) loaded its code into memory. In-memory daemon is pre-M5-dist. M5's only daemon product change is the dev-browser relay-port override, which is env-gated and byte-identical at defaults (9224) — no behavioral delta for any item below; the M5 daemon source itself is proven by T6 (daemon 345/345) and T3 (soak 6/6). Recorded here for transparency. |
| Gateway host                                    | **Not running** at session start (staleness: `gateway-info.json` pid 270909 dead; `GET /health` connection refused). T7's first item is therefore a genuine fresh launch. Host dist `apps/host/dist/index.js` built 12:09, web dist `apps/web/dist/client` built 12:11 — M5 changed **no** `apps/host/src` or `apps/web/src` files (verified via git log), so the served build is current-behavior.                                                                     |
| Launcher                                        | `~/.local/share/applications/accomplish-fox.desktop` installed; Exec = `/usr/bin/node ~/KujengaAccomplish-AI/apps/host/dist/index.js --launch --data-dir ~/.local/share/Accomplish --web-dist ~/KujengaAccomplish-AI/apps/web/dist/client %u`; `xdg-mime query default x-scheme-handler/accomplish` → `accomplish-fox.desktop`.                                                                                                                                         |
| Firefox / tooling                               | `/usr/bin/firefox` v153.0 (dedicated app profile resolution treats the machine as snap → `~/snap/firefox/common/accomplish-app-profile`); `zenity`, `gtk-launch`, `gio`, `xdg-open` all present (pickers + scheme probes possible).                                                                                                                                                                                                                                     |
| linux-desktop MCP dist (optional item only)     | `packages/agent-core/mcp-tools/linux-desktop/dist/index.mjs` present. All six `linux-desktop_desktop_*` tools are permission `ask` (config-generator policy).                                                                                                                                                                                                                                                                                                           |
| Dev-browser tools permission                    | No dev-browser permission keys in `ACCOMPLISH_PERMISSION_POLICY` → dev-browser tools execute without a permission card (by design; opencode raises `permission.asked` only for keys present in the policy).                                                                                                                                                                                                                                                             |
| Safety invariants for this session              | No edits to `~/Accomplish`, `~/.local/share/Accomplish` beyond what the UI's own flows write (test task rows, two tiny test files in the default workspace, transient settings change restored in H7). No policy edits, no systemd operations, no daemon/gateway restarts beyond the launcher's own semantics, no pushing/merging.                                                                                                                                      |

**Evidence capture layout:** `/tmp/opencode/t7/` (non-persistent, not committed) — host stdout logs, journal captures, test-file state. Gateway URL/token never recorded in this document or in evidence transcripts; token lives only in `~/.local/share/Accomplish/gateway-token` (0600).

---

## 2. Checklist

Statuses: **NOT RUN** → PASS (with user confirmation + architect evidence) / FAIL (with diagnosis) / SKIPPED (with reason) / N/A-deviation noted.

### H1 — Launch via the desktop launcher; gateway reachable — status: **PASS**

- **Who/How (user):** Launched "Accomplish" from the Ubuntu application launcher (GNOME app grid) — the daily-use path.
- **Result / evidence:** Firefox opened at the gateway and the UI loaded fully; user observed previous task history in the sidebar, "GLM-5.3 Cloud" selected, daemon connection indicator green, no errors/unexpected behavior. Architect evidence: fresh `gateway-info.json` {port 45467, pid 125533}; host pid 125533 alive 17:23:45 EDT via the exact launcher Exec chain (`…host/dist/index.js --launch --data-dir ~/.local/share/Accomplish --web-dist …/web/dist/client`); `GET /health` on the live port → `{"ok":true,"version":"0.1.0","platform":"linux"}` (stale port 42983/dead pid 270909 confirmed gone); `journalctl --user` captured launcher stdout — `[daemon-connector] Connected to existing daemon` (production daemon pid 3945 ADOPTED, not respawned), `Gateway listening {"port":45467}`, `ACCOMPLISH_GATEWAY_URL=…#token=[REDACTED]`.
- **User confirmation:** "H1 PASS … Firefox opened successfully and loaded the Accomplish main interface. Previous task history is visible in the sidebar. GLM-5.3 Cloud is selected. The daemon connection indicator is green. No errors or unexpected behavior observed."
- **Security note (pre-existing, recorded for the checkpoint):** the boot's `logger.info(app.appUrl)` + machine-readable stdout line carry the token fragment into the journald user journal on every launcher launch (pre-M5 behavior — M1 redaction covers `/client-log` payloads and error paths, not this boot line). Same-user exposure class as the 0600 token file; no product change in T7; hardening observation for future milestones. The token is redacted everywhere in this document and evidence transcripts.

### H2 — Zero client errors via `/client-log` — status: **PASS**

- **Who/How:** Architect-side capture; no host restart needed (journal capture proved sufficient; the relay option was explicitly NOT taken at the user's direction — the production daemon must never be restarted/terminated without explicit user authorization).
- **Result / evidence:** Complete host journal session (pid 125533, since 17:23:40) = 6 lines, all healthy (`Connected to existing daemon`, `Gateway listening {"port":45467}`, ready/URL, `ACCOMPLISH_GATEWAY_URL` (token redacted), `Gateway identity declared`); **zero error-level entries; zero `[client]` error reports**. Channel proven live (not merely silent) via a benign architect probe: `POST /client-log` → `{"recorded":true}` → journal `[client] T7 client-log channel probe (architect, benign)` at 17:25:51. Phase-2 §12 "zero client errors" standard met.
- **User confirmation:** "H2 PASS. Accept the zero-client-errors verification based on the captured evidence."
- **User directive recorded (goes to the checkpoint as a separate security-hardening issue):** the token-fragment boot URL in the local journald user journal is to be tracked for future hardening; no tokens in future logs (no product change made in T7).

### A1 — Launcher re-launch semantics (auxiliary; Phase-2 §12 parity) — status: **PASS**

- **Who/How (user):** Closed the Accomplish Firefox window, re-launched from the Ubuntu application launcher.
- **Result / evidence:** Firefox reopened on the Accomplish UI; task history intact; daemon indicator green; no errors. Architect evidence: `gateway-info.json` UNCHANGED (pid 125533, port 45467 — no second gateway started), `/health` → 200 on the same port, exactly one host process alive; the transient second activation's stdout was not attributed in journald (known short-lived-process gap) so the exact launcher Exec was re-executed capture-side: `Re-using running gateway: http://127.0.0.1:45467/#token=[REDACTED]` → transient exits after handing the URL to Firefox — single-instance reopen semantics re-proven at M5 HEAD. Production daemon pid 3945 alive/unchanged throughout.
- **User confirmation:** "A1 PASS. I closed the Accomplish Firefox window and reopened Accomplish from the Ubuntu application launcher. Firefox reopened successfully. The Accomplish interface loaded. Previous task history is intact. The daemon connection indicator is green. No errors or unexpected behavior."

### H3 — Task start → permission card → **Allow** (human-interactive) — status: **PASS**

- **Who/How (user):** Submitted the file-creation task through the Accomplish Firefox UI.
- **Result / evidence:** Permission card appeared in the real UI; the user explicitly clicked **Allow**; task resumed and completed; UI showed Completed with agent read-back verification. Architect evidence: `~/.local/share/Accomplish/task-workspace/t7-allow.txt` exists — **14 bytes, exactly `M5_T7_ALLOW_OK`** (od dump: no stray/trailing bytes), created 2026-10-23 17:32 EDT (matches the live run window).
- **User confirmation:** "H3 PASS. User-confirmed. … A permission approval card appeared, and I explicitly clicked Allow. The task resumed and completed successfully. File: t7-allow.txt. Expected contents: M5_T7_ALLOW_OK. The UI showed Completed, and the task transcript confirmed successful read-back verification. Please independently verify the file and record H3 as PASS." (Verified per above.)

### H4 — Permission **Deny** from real UI (human-interactive) — status: **PASS**

- **Who/How (user):** Started the deny task in the UI; clicked **Deny** on the card; task reached its terminal state. (Two runs — see observations; final PASS based on the dedicated new task.)
- **Result / evidence:** User's dedicated run: new task started; **"File Permission Required" card requesting MODIFY access to t7-deny.txt** appeared (write tool rendered as a MODIFY request); user clicked **Deny**; dialog closed; task reached **Completed without hanging**; transcript showed the write invocation with **no successful file-creation confirmation**. Architect evidence: `t7-deny.txt` **absent** in `~/.local/share/Accomplish/task-workspace/` and in the home directory (two independent finds); `t7-allow.txt` intact (14 bytes); production daemon pid 3945 untouched. Matches the E2E `50-task-deny` verdict (denial blocked creation; task terminal via adaptation).
- **Observation 1 (UX, user-directed record):** **No visible denial explanation** in the transcript ("The agent did not visibly explain the denial"). Consistent with the already-recorded behavior that denial wording arrives as adapter tool-error feedback rather than explicit UI wording (E2E auto-deny evidence, §1.B); denial itself is provably enforced (file absent). UI-level denial-explanation wording = UX observation for the checkpoint, no bug claim from this evidence.
- **Observation 2 (bonus data point):** the user accidentally submitted the deny instruction as a **follow-up to the completed H3 task** (i.e., through a RESUMED session). A write invocation appeared, was denied, and returned to the completed view — **no file created**. This incidentally re-proves that deny blocking also works on the resumed-session path (M4 session-resume flow) with the real UI.
- **User confirmation:** "H4 user-observed PASS … A File Permission Required card appeared requesting MODIFY access to t7-deny.txt. I clicked Deny. The permission dialog closed, and the task reached Completed without hanging. The transcript showed a write tool invocation but no successful file creation confirmation. The agent did not visibly explain the denial. Please independently verify that t7-deny.txt does NOT exist … If the file is absent, mark H4 PASS." (Verified absent per above.)

### H5 — Streaming visible (human-interactive) — status: **PASS**

- **Who/How (user):** Option A — confirmed from the live observations of the H3 (allow) and H4 (deny) runs; no extra task needed.
- **Result / evidence:** Task progressed live: status showed **Running**; **permission requests appeared during execution** (card surfaced mid-run while the work waited); **transcript updated incrementally as the AI worked**; terminal state reached. Nothing collapsed into a single lump at the end.
- **User confirmation:** "H5 PASS. Option A. During H3 and H4, I observed the task progressing live. The task showed Running, permission requests appeared during execution, and the transcript updated incrementally as the AI worked. The task eventually reached Completed. Please record H5 as PASS."

### H6 — History visible (human-interactive) — status: **PASS**

- **Who/How (user):** Opened the task list/history view in the real UI.
- **Result / evidence:** Both test tasks appear in history with **Completed** status; the accidental follow-up instruction is preserved in the earlier task; the user's previous production task history remains intact; an older completed task reopened with its transcript still rendered (persisted).
- **User confirmation:** "H6 PASS. Both t7-allow and t7-deny tasks appear in history with Completed status. The accidental follow-up instruction is preserved in the earlier task. My previous task history remains intact. I reopened an older completed task and confirmed its transcript is still visible. Please record H6 as PASS."

### H7 — Provider/model set from the real UI (human-interactive; transient + restored) — status: **PASS** (after a real client-side bug was root-caused and fixed mid-item; retested by the user)

- **Who/How (user):** Opened Settings → providers/models. **Blocked:** the Ollama model dropdown listed only `glm-5.3:cloud`, and the UI displayed `Gateway rejected provider.testConnection (HTTP 429)`.
- **User-directed investigation (done live):**
  1. **The 429 IS the gateway rate limiter** (the `Gateway rejected … (HTTP 429)` wording can only be produced by the gateway's per-token 1500 req/60 s fixed window; no `ACCOMPLISH_GATEWAY_RATE_LIMIT` in the host env; limiter in-memory fresh since 17:23 — the drain had to come from a request burst).
  2. **The model list is NOT live** — by design the dropdown is fed from the **stored** `availableModels` (one model, from the original ollama connect at setup time). The user's real ollama at 127.0.0.1:11434 serves **3 models** (`qwen3.5:4b`, `glm-5.3-flash:cloud`, `glm-5.3:cloud`). The live refresh path exists — the Ollama-card Refresh flow re-tests the connection and saves the fresh full model list while **preserving the selected model** — but that exact call was 429'd.
  3. **Root cause caught in the act** (passive `ss` byte-delta sampling while the user reproduced): opening the Settings dialog triggered a fetch-chain spin of **~1.3 MB / ~2,000+ /rpc requests in ~10 s (~200-600 req/s)**, draining the 1500-budget window and 429-ing subsequent calls (testConnection's error is what the UI displayed; the spin then starves itself and re-arms on the next click). Idle baseline before/after: ~1.2 req/s (the per-instance 2 s `ModelIndicator` poll — a separate, far slower contributor, harmless vs. the 1500 budget).
  4. **Root causes fixed (2 files):**
     - `apps/web/src/client/lib/accomplish.ts` — `getAccomplish()` rebuilt a fresh API object (Electron wrapper or HTTP shim) on **every call**; any effect with `accomplish` in its dep array re-fired per render — `useSettingsDialog`'s mount effect fetched **4 RPCs per render** (`provider.getSettings` + debug + notifications + version). **Fix: memoize both surfaces module-wide** (+ `__resetAccomplishApiCacheForTests()` test hook). Existing effect-deps patterns (`accomplish`, `refetch`) are now stable → no per-render refetch.
     - `packages/agent-core/src/common.ts` — pre-existing **web-build breakage at HEAD, invisible to the M5 battery**: `vite` resolves bare `@accomplish_ai/agent-core` to the browser-safe `common.ts` barrel (by design), but `sanitizeString`/`validateHttpUrl` (pure, import-free utils used by `accomplish-http.ts` since Oct 21) were never re-exported there → `vite build` failed with missing exports (the last successful bundle predates M5; T6 covers typecheck/vitest/E2E-with-fixture, none of which run vite). **Fix: added the two util re-exports to `common.ts`.** Web bundle rebuilt from HEAD (dist restored 19:06:11).
  - **Verification: web unit 491/491** (488 baseline + 3 new identity tests: repeated calls return the same instance on both surfaces; a later-arriving Electron bridge wins over a cached shim; reset hook clears caches) · agent-core **807 pass + 1 skip** (baseline) · typecheck/eslint/prettier clean · web integration **158/61 = exact upstream baseline** · gateway + daemon untouched (no restarts; production data unchanged).
- **Status update (user retest after the fixes): PASS.** "H7 manual Firefox verification: PASS. I refreshed KujengaAccomplish and tested model selection. Results: No HTTP 429 errors. Model switching works in Settings. Model switching works on conversation cards. Initially, the Ollama models weren't all visible. After selecting another provider and switching back to Ollama, the models appeared and worked normally. Everything appears functional now."
- **Observation (UX, recorded):** on first open after the fix, the Ollama model list was not fully visible until the user selected another provider and switched back to Ollama — the model list rendered after that provider re-selection. Harmless recovery path via normal UI navigation; candidate M6 polish (list freshness at dialog open).
- **End state:** production selection = `ollama/glm-5.3:cloud` (user restored via the real UI); no 429s; settings intact.

### H8 — Folder picker via real Firefox (human-interactive) — status: NOT RUN

- **Who/How (user):** On the Home composer, trigger the folder picker (the "+" menu → folder / "Select folder" style entry). A **zenity GTK folder dialog** (spawned by the host) must appear. Pick a scratch folder (e.g. `~/Desktop` or any harmless one), confirm.
- **Expected:** the dialog is a native GTK dialog (not an Electron window since Electron is not part of this path); the UI shows/uses the picked absolute path. Cancel the flow afterward (no task needs to run from it) — or optionally leave it if the user wants to run a task from the folder.
- **Result / evidence:** _pending_
- **User confirmation:** _pending_

### H9 — File picker via real Firefox (human-interactive) — status: NOT RUN

- **Who/How (user):** In the task composer attachments control, trigger the file picker. The **zenity multi-file dialog** appears. Select one small text file (≤ 10 MB).
- **Expected:** the attachment chip/preview appears in the composer with the correct file name.
- **Result / evidence:** _pending_
- **User confirmation:** _pending_

### H10 — Dev-browser task via real UI (human-interactive; browser interaction) — status: NOT RUN

- **Who/How (user):** Start the task:
  > Navigate to https://www.iana.org/about and tell me the main heading of the page.
- **Expected:** the agent uses its dev-browser tools (no permission card for browser actions — by design); the dev-browser sidecar + headless Chromium run background-first (headful visibility NOT required); the answer must reflect the REAL page content ("About IANA" heading), not a memorized answer. The sidecar/Chromium may legitimately persist across tasks (reuse lifecycle); post-task residue checks apply to the daemon-shutdown path, already M4-proven, not asserted here.
- **Architect evidence:** listeners/processes on the dev-browser relay port while the task runs; final answer text recorded.
- **Result / evidence:** _pending_
- **User confirmation:** _pending_

### H11 — `accomplish://` deep link probes (human-interactive, low-intrusion) — status: NOT RUN

- **Who/How:** Architect runs from a terminal (user watches):
  1. `xdg-open 'accomplish://callback/mcp/t7-probe'` — scheme handler → host CLI single-instance → forward to `/deep-link` (bearer-authenticated) → host log `Deep link forwarded` + gateway `{"accepted":true}`; UI receives the control event (no crash; no visible reaction asserted).
  2. `xdg-open 'accomplish://t7-noncallback'` — non-callback host → host CLI logs `Deep link ignored`, exits, and Firefox is NOT asked to open.
- **User confirmation required:** nothing unexpected appeared / nothing broke.
- **Result / evidence:** _pending_
- **User confirmation:** _pending_

### O1 — OPTIONAL: portal-screenshot consent (the M3 AUTH-HOLD item; requires the operator present) — status: NOT RUN (optional; declining is recorded as SKIPPED with no penalty)

- **Who/How (user):** User starts the task:
  > Take a screenshot of my desktop using the desktop screenshot tool and tell me whether it succeeded.
  > The UI shows a permission card (`linux-desktop_desktop_screenshot`) → click **Allow** → the **GNOME portal consent dialog** appears — approve it **quickly** (in-task MCP timeout ~60 s precedes the helper's 90 s window; a slow approval fails with a tool timeout, which would be the known Phase-2 caveat, not a product bug — record exactly what is observed either way).
- **Expected:** card → Allow → portal dialog → consent → agent reports the screenshot attempt outcome in its transcript.
- **Architect evidence:** sidecar/MCP process observations + user description of the dialogs.
- **Result / evidence:** _pending_
- **User confirmation:** _pending_

---

## 3. Final closeout (after all items)

1. Fill every status above; anything not performed stays NOT RUN / SKIPPED with the reason — **never claimed passed**.
2. Record results into `docs/M5_DEBUG_CHECKPOINT.md` (§1.G) and mark T7 DONE in `docs/M5_REMAINING_TASKS.md`; final doc commit `docs(phase3): M5 T7 complete — manual Firefox checklist …`. No push, no merge; stop after this commit.
3. Optional post-test cleanup (only if the user asks): the two tiny test files in the default task workspace may be removed; task history rows remain (production data).
