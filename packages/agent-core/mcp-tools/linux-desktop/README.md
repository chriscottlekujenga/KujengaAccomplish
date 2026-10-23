# linux-desktop MCP tool (Wayland desktop control PoC)

C3 prototype that lets the Accomplish agent read and act on the Linux/Wayland
desktop: list open windows, enumerate a window's actionable controls
(AT-SPI2 accessibility tree), invoke controls, read text, launch
applications, and capture screenshots via the XDG desktop portal.

A python helper (`scripts/desktop-helper.py`, requires `python3-gi`/Atspi and
a Wayland session with an accessibility registry) does the discovery and
speaks a one-JSON-line stdout contract; this stdio MCP server wraps it.

## Security model

- **Per-action permission asks.** The opencode config registers the tools as
  `linux-desktop_<toolName>` permission keys with `ask` (`config-generator.ts`);
  every call surfaces the renderer PermissionCard before execution.
- **Portal consent.** `desktop_screenshot` triggers the GNOME portal consent
  dialog on top; a denial or timeout is surfaced as a tool error.
- **Blocklist.** Password managers (1Password, Bitwarden, LastPass, KeePass,
  Dashlane) and credential/security surfaces (Keychain Access, Credential
  Manager, Windows Security, Registry Editor) are hard-blocked in code,
  never just by permission policy.
- **No synthetic input.** No synthetic keyboard/mouse injection in this PoC —
  only AT-SPI action invocation and read-only discovery.

## Requirements

- `python3-gi` with Atspi bindings (preinstalled helper, not installed here)
- Wayland session with a running accessibility registry
- `gio` (GLib) for launching `.desktop` files

## Not supported in this PoC

- Typing/keyboard text injection
- Portal RemoteDesktop session input
- `uinput` fallback for synthetic input
- Rich per-target permission descriptions (per-target details arrive only via
  the tool call transcript; Phase-5B item)
- `SKILL.md` skill registration
