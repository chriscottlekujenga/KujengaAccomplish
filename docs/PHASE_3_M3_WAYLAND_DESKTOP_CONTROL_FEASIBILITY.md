# PHASE 3 M3 — Wayland Desktop-Control Feasibility Report

**Date:** 2026-10-22 · **Branch:** `linux-firefox-ai` · **HEAD:** `62e9aca` (clean tree)
**Machine (probe target):** `chris-ubuntu-laptop` — Ubuntu 26.04.1 LTS, kernel `7.0.0-38-generic` **aarch64** (Snapdragon X Elite), GNOME Shell **50.1**, session `XDG_SESSION_TYPE=wayland` (`wayland-0`) + XWayland (`DISPLAY=:0`), user `chris` (uid 1000).
**Scope:** feasibility research only (plan §10). Read-only environment probes; **zero application-source changes, zero package installs, zero system modifications.** Prototype not implemented.
**Method:** preinstalled tools only (`busctl`, `gdbus`, `python3-gi`, `getfacl`, `git show`). Probe scripts (non-persistent, `/tmp/opencode/`): `m3-probe-atspi.py`, `m3-probe-atspi-deep.py` (+ raw `busctl`/`gdbus` calls recorded below).

---

## 1. Verdict (executive summary)

Desktop control on this machine is **feasible with zero new system packages**, using a layered stack:

| Capability                   | Technique chosen                                                                                                                                                                                          | Verdict                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Identify windows/UI controls | **AT-SPI accessibility**                                                                                                                                                                                  | **PASS — proven live** (apps → frames → named controls + actions)                               |
| Element-aware actions        | **AT-SPI action invoke**                                                                                                                                                                                  | PASS (buttons/menus expose `click` actions; needs interactive prototype confirmation of invoke) |
| Read screen/verify results   | **AT-SPI state/text reads + portal Screenshot**                                                                                                                                                           | PASS (text read needs raw-D-Bus helper on GNOME 50 — §3.3 finding)                              |
| Keyboard/mouse injection     | **XDG Desktop Portal RemoteDesktop**                                                                                                                                                                      | PASS (full D-Bus injection surface present; call-gating open question §8.1)                     |
| Fallback input injection     | **uinput (kernel-builtin, ACL already granted)**                                                                                                                                                          | PARTIAL-PASS (device writable by uid 1000; injector is small custom code, no install)           |
| Open applications            | `gio launch <desktop-file>` (preinstalled) + permission prompt                                                                                                                                            | PASS (trivially)                                                                                |
| **Not viable / not needed**  | `wtype` (mutter lacks `zwp_input_method_v1`) · GNOME Shell `Eval`/`Screenshot`/`Introspect` (locked) · `wmctrl`/`xdotool` (absent + XWayland-only) · nut.js (X11-only, upstreaam-removed — do not revive) | FAIL / recorded                                                                                 |

**Recommended architecture (simplest viable):** a daemon-owned **`linux-desktop` MCP tool** following the dev-browser pattern — a no-listening-socket **stdio helper process** (Python 3, preinstalled `python3-gi` + D-Bus) that performs AT-SPI targeting/reads and portal D-Bus calls, gated by a new daemon **`desktop` permission type** (per-action prompts, title blocklist, unattended auto-deny). Integration with OpenCode = one MCP package in `packages/agent-core/mcp-tools/`; **no other system dependency and no privileged setup is on the critical path.**

---

## 2. Session environment (prerequisite checks — all PASS)

| Probe                                | Evidence                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session type                         | `XDG_SESSION_TYPE=wayland`, `WAYLAND_DISPLAY=wayland-0`, `XDG_CURRENT_DESKTOP=ubuntu:GNOME`, `DISPLAY=:0`                                                                                                                                                                                                                                         |
| OS/kernel                            | `PRETTY_NAME="Ubuntu 26.04.1 LTS"`, `Linux ... 7.0.0-38-generic ... aarch64`                                                                                                                                                                                                                                                                      |
| GNOME                                | `gnome-shell --version` → `GNOME Shell 50.1`                                                                                                                                                                                                                                                                                                      |
| Daemon can open the user session bus | `systemctl --user show-environment` exports `DBUS_SESSION_BUS_ADDRESS=/run/user/1000/bus`; the running daemon's `/proc/<pid>/environ` contains `DBUS_SESSION_BUS_ADDRESS`, `WAYLAND_DISPLAY`, `DISPLAY`, `XDG_SESSION_TYPE=wayland`, `XDG_RUNTIME_DIR=/run/user/1000` — **the systemd-user daemon inherits the full desktop-session environment** |
| Session-bus reachability             | `busctl --user status org.freedesktop.portal.Desktop` → PID 6078, UID 1000 (successful call from a plain user process)                                                                                                                                                                                                                            |

Prerequisite consequence: any daemon-spawned helper can reach the session bus, the Wayland compositor, and XWayland without configuration changes.

---

## 3. Technique findings (plan §10.1 × §10.2 criteria)

### 3.1 AT-SPI accessibility — **PASS (primary targeting + verification path)**

| Criterion                  | Finding                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Works on this machine?     | **YES — live-proven.** `at-spi-bus-launcher` (pid 5340), a11y `dbus-daemon` (5347), `at-spi2-registryd --use-gnome-session` (5349) running; a11y bus socket `/run/user/1000/at-spi/bus`. Enumerated **8 applications / 4 frames** from a plain user process: gnome-shell, org.gnome.Terminal (`active=True` frame `OC                                                                       | M3 Wayland desktop control feasibility`), gnome-control-center, update-notifier, ibus, evolution-alarm-notify, xdg-desktop-portal-gtk. |
| Element awareness depth    | Deep probe walked one live GNOME-Terminal frame: **named controls with actions** — `button 'Minimize' actions=['click']`, `button 'Restore'`, `button 'Close'`, `button 'Find'`, `button 'New Tab'`, `toggle button 'Menu'`, `menu 'File'/'Edit'/'View'/...`, `page tab list` with 3 named tabs — i.e. **identify by role+name, invoke actions, read state** without synthetic coordinates. |
| Toolchain without installs | `python3-gi` **preinstalled** with `Atspi 2.0` GI typelib (`Atspi GI OK`) — a helper child process needs **zero new packages**. `pyatspi` module absent (not needed). `gjs` present as an OS-level alternative runtime.                                                                                                                                                                     |
| Reliability                | High for GTK apps (GNOME's own toolchain). Event-driven (ObjectAdded/Removed) avoids polling. Caveat: `toolkit-accessibility=false` did **not** block GTK3/GTK4 live exposure, but **Electron/Chromium/Firefox a11y exposure typically requires assistive-tech detection** — must be prototype-verified per-app (§8.2).                                                                     |
| Privileged setup           | **None.** (Optional flip of `gsettings org.gnome.desktop.interface toolkit-accessibility `→`true` is a user-visible settings change — propose only inside the prototype with user approval if an app refuses to expose a11y.)                                                                                                                                                               |
| Security/authorization     | Read-only queries are benign; **action invocation is a privileged operation → route every invoke through the daemon permission gate (§6)**. AT-SPI is session-scoped (user bus) — no cross-user surface.                                                                                                                                                                                    |
| ARM64 issues               | None — at-spi2/mutter/python3-gi are distro aarch64 builds running natively.                                                                                                                                                                                                                                                                                                                |
| Limitation                 | **No synthetic keyboard/mouse** (generate\*Event APIs removed); text-read GI binding churn on GNOME 50 (below).                                                                                                                                                                                                                                                                             |

**Finding (GNOME 50 binding churn):** enumeration and actions work via `Atspi` GI, but the reworked at-spi2 2.55 text API is **partially mismatched in the preinstalled pygobject bindings** (`Atspi.Accessible.get_text() takes exactly 1 argument`, `Atspi.Text.get_text_at_offset() takes exactly 3 arguments (4 given)` — signatures shuffled). The underlying **D-Bus protocol interface (`org.a11y.atspi.Text.GetText`) is stable and confirmed reachable** (tree walk via `busctl --address=unix:path=/run/user/1000/at-spi/bus` succeeded: root `GetChildren` returned all 8 app connections). Prototype consequence: implement text/state reads as **raw D-Bus on the a11y bus** (or gjs), not via the churned pygobject text wrappers.

### 3.2 XDG Desktop Portal — **PASS (screenshots + authorized input injection)**

| Component           | Evidence (live introspection of `org.freedesktop.portal.Desktop`, pid 6078 — portal-gnome 6093 + portal-gtk 6253 running)                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Screenshot**      | `org.freedesktop.portal.Screenshot` **v2** — `Screenshot(parent_window, options) → handle`, `PickColor`. Synchronous-style response writes a PNG to caller-accessible path via Request response. Interactive consent per grant (user-held). No screenshot CLI preinstalled (`gnome-screenshot` absent) → portal is the only zero-install path. **Untested interactively here** (grant dialog intrusive; deferred to prototype).                                  |
| **ScreenCast**      | **v5** — `CreateSession/SelectSources/Start/OpenPipeWireRemote`; `AvailableSourceTypes=7` (monitor+window+virtual), `AvailableCursorModes=7` (incl. cursor metadata). PipeWire stack present: `pw-cli`, `pw-dump`, `gst-launch-1.0`, `libpipewire-0.3.so.0`. Node PipeWire binding does not exist — capture consumer would live in the helper (or `gst-launch-1.0`/`pw-*` CLI) if ever needed; **out of MVP scope**.                                             |
| **RemoteDesktop**   | **v2** — `CreateSession/SelectDevices/Start`; `AvailableDeviceTypes=7` (keyboard+pointer+touch); full injection surface: `NotifyPointerMotion`, `NotifyPointerMotionAbsolute`, `NotifyPointerButton`, `NotifyPointerAxis`, `NotifyPointerAxisDiscrete`, `NotifyKeyboardKeycode`, `NotifyKeyboardKeysym`, `NotifyTouch*`; clipboard `Selection*`; **`ConnectToEIS`** (libei path; `libei.so.1`/`libeis.so.1` present on arm64).                                   |
| Authorization model | RemoteDesktop `CreateSession/SelectDevices/Start` trigger GNOME's consent dialogs; grant is **app-scoped, session-scoped, user-revocable** (Settings → Privacy). This is exactly the "explicit user authorization" property the plan requires. Per-action granularity is then enforced by **our permission layer**, not the portal.                                                                                                                              |
| Works scripted?     | Interface-level YES; **call-gating open question**: Mutter's private `org.gnome.Mutter.RemoteDesktop` is session-bus-visible to a plain client (introspection succeeded), but whether non-portal clients may invoke `Notify*` directly (vs. only `xdg-desktop-portal-gnome` doing so) is **unverifiable read-only** — if gated, options are (a) drive the portal as a libei client, or (b) fall back to uinput (§3.3). Both are already in-plan; nothing blocks. |
| ARM64               | None — distro aarch64 builds; `libportal`/`libei`/`libpipewire` all present.                                                                                                                                                                                                                                                                                                                                                                                     |

### 3.3 ydotool / uinput — **PARTIAL-PASS (fallback input path; no install required)**

| Probe                         | Evidence                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command -v ydotool ydotoold` | **absent**; no ydotool unit files anywhere (`/usr/lib/systemd/{system,user}/ydotool*` empty) → installing it would be a package install **requiring approval**; not needed given portal + uinput.                                                                                                 |
| Kernel uinput                 | `modinfo uinput` → **(builtin)** in kernel `7.0.0-38-generic` — no module loading needed.                                                                                                                                                                                                         |
| `/dev/uinput` permission      | `crw-rw----+ root:root` with **ACL `user:chris:rw-`** (uaccess udev rule); user NOT in `input`/`uinput` groups (`.crw` ACL suffices). **Write-open probe passed**: `open('/dev/uinput', O_WRONLY)` + close (no device created, no events injected) → uid 1000 can create synthetic input devices. |
| Reliability                   | Absolute (kernel-level), app-agnostic, works on any Wayland compositor; but **no element awareness** — pair with AT-SPI targeting; no per-action consent surface (weaker authorization story than portal → keep as fallback, behind the permission gate).                                         |
| Prototype role                | A ~100-line uinput virtual-device injector (Python `ioctl`/`struct` or C) covers keyboard/mouse/scroll with **zero package installs** and no service daemon (create → inject → destroy).                                                                                                          |
| ARM64                         | None — uinput is arch-neutral kernel ABI.                                                                                                                                                                                                                                                         |

### 3.4 wtype — **FAIL (expected)**

`wtype` not installed. Even if installed, mutter does not implement `zwp_input_method_v1` (the protocol wtype requires) — GNOME historically unsupported. **Recorded; do not pursue.**

### 3.5 GNOME window-management D-Bus — **FAIL direct / PARTIAL via extension (not needed for MVP)**

| Probe                                     | Evidence                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org.gnome.Shell.Eval "1+1"`              | → `(false, '')` — **locked** on GNOME 50 (unsafe-mode required).                                                                                                                                                                                                                                                                                                  |
| `org.gnome.Shell.Screenshot.Screenshot`   | → `GDBus.Error:AccessDenied: Screenshot is not allowed` — locked.                                                                                                                                                                                                                                                                                                 |
| `org.gnome.Shell.Introspect.Windows.List` | → interface not exposed to non-allowlisted callers.                                                                                                                                                                                                                                                                                                               |
| `gnome-extensions` CLI + installed exts   | Extension infrastructure works (`ding@rastersoft.com`, `tiling-assistant`, `ubuntu-dock`, …) → a purpose-built window-management shell extension _would_ work, but shipping one = system modification + approval. **Not required**: AT-SPI frames already provide enumerate/activate semantics; window focus/raise can ride the portal RemoteDesktop/AT-SPI path. |
| `wmctrl`/`xdotool`                        | absent; and XWayland-limited anyway (X11 clients see only X11 windows). **Do not install.**                                                                                                                                                                                                                                                                       |

### 3.6 Existing OpenCode desktop-automation capabilities — inventory (do-not-rebuild list)

| Already present (OpenCode 1.14.18 + repo MCP stack)                                                                                                                                                                  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`, `read/write/edit`, `glob/grep`, `webfetch/websearch`                                                                                                                                                         | Files/shell/web — desktop-adjacent but no GUI surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `dev-browser` + `dev-browser-mcp` (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_evaluate`, `browser_keyboard`, … — CDP Chromium sidecar, M1-token-authed) | **In-browser automation only** (Chromium render tree — not the native desktop)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Upstream `desktop-control` MCP tool **removed** at `05a25bc` (`fix: remove desktop-control and dead permission ports (#961)`)                                                                                        | nut.js-based: **X11-only** (unusable on Wayland), 15 action types (`click/doubleClick/rightClick/moveMouse/scroll/type/hotkey/pressKey/releaseKey/screenshot/listWindows/findWindow/focusWindow/resizeWindow/repositionWindow`), **per-action user approval**, password-manager blocklist, `needs_planning` requirement. **Design (not the library) is recoverable from git**: `SKILL.md`, `types.ts` (15 `DESKTOP_ACTION_TYPES`), `blocklist.ts` (106 lines), `PermissionDialogDesktopTool.tsx` (82 lines) — all retrievable via `git show 05a25bc^:...`. |

Conclusion: the _tool surface, permission UX, and blocklist_ are a **portable design**; the _engine_ (nut.js) is not — exactly what this report replaces.

---

## 4. Recommended architecture (prototype proposal — not implemented)

```
OpenCode task
  └─ linux-desktop MCP tool (packages/agent-core/mcp-tools/linux-desktop/)
       └─ stdio JSON-RPC ↔ daemon-owned helper process (Python 3, ZERO new packages)
            ├─ AT-SPI  : enumerate apps/frames/controls; invoke named actions;
            │            read roles/names/states (+ raw-D-Bus text reads on a11y bus)
            ├─ Portal  : RemoteDesktop session (CreateSession/SelectDevices/Start →
            │            Notify* input) ; Screenshot → PNG to task workspace
            └─ uinput  : fallback injector if portal Notify* is call-gated (§8.1)
Daemon permission layer (UNCHANGED architecture, new type):
  PermissionRequest.type = 'desktop'  → per-action UI prompt
  + title blocklist (port of upstream blocklist.ts)
  + unattended auto-deny (M1 presence gate — already in place)
```

Design choices and why:

1. **Helper process, not in-process Node bindings.** `python3-gi` (Atspi) + `python3 dbus`-class access via `gio`/`gdbus` are preinstalled; Node GI bindings (`node-gtk`) would add a native compile on arm64 for no benefit. Helper is spawned per task session with cwd in the task workspace, speaks JSON-RPC over **stdio only** (no listening socket — stronger than the M1 sidecar pattern), and dies with the task.
2. **AT-SPI = targeting + verification; portal = consent-bearing input; uinput = fallback.** Order follows authorization strength (portal grants are user-held dialogs; uinput rides an already-present ACL and is gated only by our permission layer → fallback only).
3. **Every action is a `desktop` permission request** — port the upstream gating design (per-action prompt describing the exact action + target; `needs_planning` for all `desktop.*` tasks; deny → tool error).
4. **No sandbox activation yet** — the inert `settings.sandbox` decision (plan §2.2) folds into the same Phase-5B approval gate (§7).

### 4.1 Tool surface (MVP — mapped to proven techniques)

| Tool                                                 | Backing                                           | Notes                                                     |
| ---------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `desktop.listApplications` / `listWindows`           | AT-SPI apps/frames                                | replaces upstream `listWindows`/`findWindow`              |
| `desktop.findControls(app, role?, name?)`            | AT-SPI                                            | returns id, role, name, actions, focused/toggled state    |
| `desktop.invokeAction(targetId, action)`             | AT-SPI `do_action`                                | per-action prompt; blocklist-checked                      |
| `desktop.typeText / keystroke / click(x,y)`          | portal RemoteDesktop `Notify*` (fallback: uinput) | per-action prompt; **focus-first requirement documented** |
| `desktop.readText(targetId)` / `readState(targetId)` | AT-SPI (raw D-Bus on a11y bus)                    | verification primitive                                    |
| `desktop.screenshot()`                               | portal Screenshot                                 | PNG into task workspace; returned as file path/base64     |
| `desktop.launchApp(desktopFile)`                     | `gio launch` + prompt                             | replaces upstream window-open flows                       |

---

## 5. Security requirements (binding for the future prototype)

1. **Per-action authorization:** every `desktop.*` call produces a daemon `PermissionRequest(type='desktop')` with a human-readable action description + target identity. No auto-approve; batch actions = one prompt per action (preserving upstream behavior).
2. **Unattended safety:** the M1 presence gate already auto-denies with no interactive UI — `desktop.*` inherits it; scheduled/unattended tasks are **never** allowed desktop control.
3. **Blocklist (port + extend upstream `blocklist.ts`):** password managers (1Password, Bitwarden, LastPass, KeePass, Dashlane), system credential/registry/security surfaces — matched on window title AND app id at targeting time, before any action; 403-style tool error with details; user-extendable.
4. **Credential-interception residual risk (documented):** `typeText`/`keystroke` can capture-or-enter secrets once a credential field is focused. Mitigations: blocklist-before-focus, prompt text visible in the dialog content, deny-logs, unattended denies. Prototype must additionally refuse `typeText` when the focused control's role is `password text`.
5. **Helper isolation:** stdio pipe only, no TCP/unix listener; token via daemon-owned env (M1 pattern) for parity with side-side services; helper cwd = task workspace; strict allowlisted command surface inside the helper (fixed JSON-RPC methods, no exec passthrough).
6. **Screenshots:** written only under the task workspace `/tmp`-equivalent (daemon data dir); never logged as base64 in daemon/broker logs (extend M1 redaction if needed); deleted with task data.
7. **No silent system changes:** flipping `toolkit-accessibility`, installing ydotool, or adding shell extensions are user-approved actions proposed in the UI, not helper side-effects.
8. **Allowlist/scrubber policy (§5.4):** any future gateway-facing expansion derived from this work must document response shapes and run the universal response scrubber (no secret-shaped echo from `desktop.readText` results into RPC surfaces exposed to the browser).

---

## 6. Integration with OpenCode (how it plugs in — M3-level sketch only)

- New MCP package `packages/agent-core/mcp-tools/linux-desktop/` registered by `task-config-builder.ts` exactly like `dev-browser-mcp` (spawn config + env; **no change to OpenCode itself**; `desktop.*` tools appear in the task's toolset).
- SKILL.md port: rewrite the upstream SKILL.md (§3.6) for Wayland semantics (targets by **role+name id**, not pixel guesses; `typeText` needs focus-first; screenshots via portal).
- `PermissionDialogDesktopTool.tsx` (82 lines, upstream) is recoverable nearly as-is for the Firefox UI permission-dialog variant.
- Nothing else changes: gateway/allowlist untouched until the Phase-5B implementation gate decides any browser-visible RPC.

---

## 7. Prototype plan disposition (M3 deliverable — plan §10.3)

**Chosen technique combination:** AT-SPI (targeting/verify) + portal RemoteDesktop (input, uinput fallback) + portal Screenshot (verification). **Not implemented here.** Proposed as **Phase 5B** gate together with the `settings.sandbox` decision, per plan §12. The demonstration loop the prototype must show:

1. **Open an application** — `desktop.launchApp` with permission prompt → app window appears.
2. **Identify its window** — `desktop.listWindows` shows the new frame (AT-SPI, no screenshot needed).
3. **Interact with an approved control** — `desktop.invokeAction`/`typeText` on a named control, individually prompted + blocklist-checked.
4. **Verify the result** — `desktop.readText`/`readState` and/or `desktop.screenshot`; report PASS/FAIL to the task.

**Privileged/optional-setup items (none on critical path; all require separate approval):**

| Item                                    | Needed?                     | Why listed                                          |
| --------------------------------------- | --------------------------- | --------------------------------------------------- |
| Install `ydotool`                       | No (fallback of fallback)   | package install; ACL already covers uinput directly |
| Flip `toolkit-accessibility` gsetting   | Only if an app refuses a11y | user-visible settings change                        |
| GNOME shell window-management extension | No (MVP)                    | system modification; AT-SPI suffices                |
| udev/group changes for `/dev/uinput`    | No                          | ACL `user:chris:rw-` already present                |

---

## 8. Open questions for the prototype phase (not blockers)

1. **Portal RemoteDesktop call-gating (§3.2):** may a plain session client invoke `Notify*`/`CreateSession` on the portal, or only via the GNOME consent flow as designed (expected — that IS the flow), and if direct Mutter calls are polkit-gated, is `ConnectToEIS` (libei) the supported client path? Decide in first prototype spike; uinput fallback already validated at the device layer.
2. **Per-app a11y exposure with `toolkit-accessibility=false`:** Firefox/Chromium/Electron typically enable AT-SPI on assistive-tech detection — verify per target app in prototype; fallback = user-approved gsetting flip.
3. **AT-SPI action invoke + portal consent UX timing** under scripted control (dialog focus vs. app focus races).
4. **pygobject text-API churn (§3.1):** pin helper reads to raw D-Bus/gjs; re-test if pygobject regains 2.55-signature parity.

---

## 9. Implementation acceptance tests (Phase-5B prototype gate — verbatim acceptance)

1. **Demo loop (§7) end-to-end:** launch GNOME Calculator via prompt → frame enumerated → `click` on button `5` after individual prompt → field text reads `5` → `task.complete success`. PASS = all four steps scripted in one task with prompts.
2. **Blocklist:** targeting a window titled `Bitwarden` (or KeePassX test stub) → immediate 403-style tool error, no AT-SPI invoke issued.
3. **Unattended deny:** with UI closed (presence-gate count 0) a scheduled task's `desktop.click` auto-denies ≤90 s-class latency (M1 semantics).
4. **Password-role refusal:** focused `password text` control + `desktop.typeText` → refused with explicit error even outside blocklisted apps.
5. **Zero-install proof:** `dpkg --get-selections` snapshot hash identical before/after full acceptance run; no new `~/.config` writes outside declared scopes.
6. **ARM64-native helpers:** helper runs as aarch64 python3; no build artifacts; desktop suite stays green (Electron bridge untouched).
7. **Verification evidence:** portal screenshot file exists with correct dimensions AND AT-SPI state read agrees (dual-channel verification demonstrated).
8. **Security battery:** helper stdio has no listening sockets (`ss -xlp` sweep); token/env never leaks into `desktop.readText` results (scrubber test); per-action deny produces permission rows.
9. **Electron regression:** full battery green (`pnpm typecheck && pnpm lint:eslint && pnpm -F @accomplish/desktop test` + touched suites) — desktop control adds capabilities without touching existing IPC.

---

## 10. M3 acceptance (this milestone — met)

- [x] Feasibility report checked into `docs/` with recorded probe outputs from **this machine** (§2–§3, all live-run on 2026-10-22).
- [x] Prototype plan written (§4–§7) — **not implemented**; dispositioned to Phase-5B approval gate with the sandbox decision.
- [x] **Zero application-source changes** (git tree stays clean; only this report + planning-doc status updates), **zero system modifications** (no packages installed; probes read-only; uinput probe opened/closed the device without creating one), `/home/chris/Accomplish` untouched, nothing pushed/merged.

---

## Appendix — raw probe transcript references

| Probe                             | Location / reproducer                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session/kernel/GNOME/daemon env   | `echo $XDG_SESSION_TYPE …`; `cat /etc/os-release`; `uname -a`; `gnome-shell --version`; `systemctl --user show-environment`; `/proc/$DPID/environ` (daemon pid 280549 on 2026-10-22)       |
| AT-SPI enumeration + control tree | `/tmp/opencode/m3-probe-atspi.py`, `/tmp/opencode/m3-probe-atspi-deep.py` (non-persistent; behavior specified in §3.1 for recreation)                                                      |
| Portal introspection              | `gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop` (full dump saved during session at `/tmp/opencode/portal-introspect.txt`) |
| Shell lockdown                    | `gdbus call … org.gnome.Shell.Eval "1+1"` → `(false, '')`; `…Screenshot.Screenshot false false false` → AccessDenied; `…Introspect.Windows.List` → unknown-interface                       |
| uinput                            | `ls -l /dev/uinput`; `getfacl -p /dev/uinput`; `modinfo uinput`; python `open('/dev/uinput', O_WRONLY)` open/close probe                                                                   |
| Upstream desktop-control surface  | `git show 05a25bc --stat`; `git show 05a25bc^:packages/agent-core/mcp-tools/desktop-control/SKILL.md`; `.../src/types.ts`                                                                  |
