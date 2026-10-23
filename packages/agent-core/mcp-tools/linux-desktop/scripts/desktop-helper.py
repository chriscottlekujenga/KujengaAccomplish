#!/usr/bin/env python3
"""
Accomplish linux-desktop MCP helper — AT-SPI discovery/action + portal screenshot.

C3 prototype (Wayland desktop control). Read-only discovery plus explicit
action invocation; no synthetic keyboard/mouse injection.

Output contract (stable — the TypeScript server parses this):
  stdout: exactly one JSON object, nothing else. All diagnostics -> stderr.
  Every command: {"ok": true, ...payload} or {"ok": false, "error": "..."}.
  Exit code: 0 on ok, 1 on error. Malformed environments (no session bus /
  no accessibility registry) must STILL emit the JSON error shape.

Commands:
  list                     apps -> frames (id/title/role/active)
  controls --window TITLE [--max-depth N]   actionable control tree
  invoke --id ID [--action click]           do_action on a discovered node
  read --id ID [--start S --end E]          node state + best-effort text
  screenshot --out PATH                     XDG portal Screenshot (consent dialog)

Node ids are minted per discovery call: "a<AppIdx>/f<FrameIdx>/p<i.j.k>".
Between calls applications may change; resolution re-walks and fails with
"target not found" rather than acting on a shifted node.
"""
import argparse
import json
import os
import sys
import time

gi_required = False
try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    gi_required = True
except Exception as exc:  # noqa: BLE001 - any import failure must produce JSON
    emit_error(f"python3-gi/Atspi unavailable: {exc}")

MAX_WALK_DEPTH_DEFAULT = 12
MAX_FRAME_CHILDREN = 60
TEXT_READ_LIMIT = 2000
INVOKE_AFTER_SETTLE_S = 0.4

_REPORTED_STATES = [
    "ACTIVE",
    "FOCUSED",
    "SHOWING",
    "ENABLED",
    "VISIBLE",
    "CHECKED",
    "PRESSED",
    "SELECTED",
    "SENSITIVE",
    "FOCUSABLE",
]


def emit_error(message: str) -> None:
    json.dump({"ok": False, "error": message}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(1)


def _safe(fn, default=None):
    try:
        value = fn()
        return default if value is None else value
    except Exception:  # noqa: BLE001 - accessibility tree access is best-effort
        return default


def _node_states(acc) -> list:
    states = []
    try:
        state_set = acc.get_state_set()
        if state_set is None:
            return states
        for name in _REPORTED_STATES:
            state_type = getattr(Atspi.StateType, name, None)
            if state_type is not None and state_set.contains(state_type):
                states.append(name.lower())
    except Exception:  # noqa: BLE001
        pass
    return states


def _node_summary(acc, node_id: str) -> dict:
    role = _safe(acc.get_role_name, "") or ""
    name = _safe(acc.get_name, "") or ""
    actions = []
    try:
        count = acc.get_n_actions()
        if isinstance(count, int):
            for index in range(count):
                action_name = acc.get_action_name(index)
                if action_name:
                    actions.append(action_name)
    except Exception:  # noqa: BLE001
        pass
    states = _node_states(acc)
    return {
        "id": node_id,
        "role": role,
        "name": name,
        "actions": actions,
        "states": states,
    }


def _walk_children(acc):
    """Yield (child, child_index) for accessible children, bounded."""
    try:
        count = acc.get_child_count()
        if not isinstance(count, int) or count <= 0:
            return
        limit = min(count, MAX_FRAME_CHILDREN)
        for index in range(limit):
            child = _safe(lambda: acc.get_child_at_index(index))
            if child is not None:
                yield child, index
    except Exception:  # noqa: BLE001
        return


def _find_desktop():
    try:
        return Atspi.get_desktop(0)
    except Exception as exc:  # noqa: BLE001
        emit_error(f"AT-SPI desktop unavailable (Wayland session required): {exc}")


def _resolve_path(app_index: int, frame_index: int, path: list):
    """Walk desktop -> app -> frame -> child path; return node or None."""
    desktop = _find_desktop()
    try:
        count = desktop.get_child_count()
        if not isinstance(count, int) or app_index >= count:
            return None
        app = desktop.get_child_at_index(app_index)
        if app is None:
            return None
        frame_count = _safe(lambda: app.get_child_count(), 0)
        if not isinstance(frame_count, int) or frame_index >= frame_count:
            return None
        node = app.get_child_at_index(frame_index)
        for child_index in path:
            child_count = _safe(lambda: node.get_child_count(), 0)
            if not isinstance(child_count, int) or child_index >= child_count:
                return None
            node = node.get_child_at_index(child_index)
            if node is None:
                return None
        return node
    except Exception:  # noqa: BLE001
        return None


def _parse_node_id(node_id: str):
    try:
        head, _, rest = node_id.partition("/p")
        app_part, frame_part = head.split("/f")
        app_index = int(app_part[1:])
        frame_index = int(frame_part)
        path = [int(x) for x in rest.split(".") if x != ""] if rest else []
        return app_index, frame_index, path
    except (ValueError, AttributeError):
        emit_error(f"malformed node id: {node_id}")


def _window_matches(frame, wanted: str) -> bool:
    title = (_safe(frame.get_name, "") or "").lower()
    wanted_lower = wanted.strip().lower()
    return wanted_lower in title if wanted_lower else bool(title)


def cmd_list() -> None:
    desktop = _find_desktop()
    applications = []
    try:
        count = desktop.get_child_count()
        if not isinstance(count, int):
            count = 0
        for app_index in range(min(count, 40)):
            app = desktop.get_child_at_index(app_index)
            if app is None:
                continue
            frames = []
            frame_count = _safe(lambda: app.get_child_count(), 0)
            if not isinstance(frame_count, int):
                frame_count = 0
            for frame_index in range(min(frame_count, 12)):
                frame = _safe(lambda: app.get_child_at_index(frame_index))
                if frame is None:
                    continue
                summary = _node_summary(frame, f"a{app_index}/f{frame_index}")
                summary.pop("actions", None)
                frames.append(summary)
            applications.append(
                {
                    "id": f"a{app_index}",
                    "name": _safe(app.get_name, "") or "(unnamed)",
                    "frames": frames,
                }
            )
    except Exception as exc:  # noqa: BLE001
        emit_error(f"AT-SPI enumeration failed: {exc}")
    json.dump({"ok": True, "applications": applications}, sys.stdout)
    sys.stdout.write("\n")


def cmd_controls(window: str, max_depth: int) -> None:
    desktop = _find_desktop()
    try:
        count = desktop.get_child_count()
        if not isinstance(count, int):
            count = 0
        for app_index in range(min(count, 40)):
            app = desktop.get_child_at_index(app_index)
            if app is None:
                continue
            frame_count = _safe(lambda: app.get_child_count(), 0)
            if not isinstance(frame_count, int):
                frame_count = 0
            for frame_index in range(min(frame_count, 12)):
                frame = _safe(lambda: app.get_child_at_index(frame_index))
                if frame is None or not _window_matches(frame, window):
                    continue
                controls = []
                stack = [(frame, [])]
                while stack:
                    node, path = stack.pop()
                    node_id = f"a{app_index}/f{frame_index}/p" + ".".join(
                        str(x) for x in path
                    )
                    if path:
                        summary = _node_summary(node, node_id)
                        if summary["name"] or summary["actions"] or summary["role"]:
                            controls.append(summary)
                    if len(path) >= max_depth:
                        continue
                    for child, child_index in reversed(list(_walk_children(node))):
                        stack.append((child, path + [child_index]))
                result = {
                    "ok": True,
                    "window": _node_summary(frame, f"a{app_index}/f{frame_index}"),
                    "application": _safe(app.get_name, "") or "(unnamed)",
                    "controls": controls,
                }
                json.dump(result, sys.stdout)
                sys.stdout.write("\n")
                return
    except Exception as exc:  # noqa: BLE001
        emit_error(f"AT-SPI enumeration failed: {exc}")
    emit_error(f"no open window matched title: {window!r}")


def cmd_invoke(node_id: str, action: str) -> None:
    app_index, frame_index, path = _parse_node_id(node_id)
    node = _resolve_path(app_index, frame_index, path)
    if node is None:
        emit_error(
            "target not found (applications changed since discovery — repeat "
            "desktop_find_controls and use fresh ids)"
        )
    actions = []
    try:
        n = node.get_n_actions()
        if isinstance(n, int):
            actions = [node.get_action_name(i) for i in range(n)]
    except Exception as exc:  # noqa: BLE001
        emit_error(f"action enumeration failed: {exc}")
    if action not in actions:
        emit_error(f"action {action!r} not available on node; available={actions}")
    action_index = actions.index(action)
    try:
        result = node.do_action(action_index)
    except Exception as exc:  # noqa: BLE001
        emit_error(f"invoke failed: {exc}")
    time.sleep(INVOKE_AFTER_SETTLE_S)
    after = _node_summary(node, node_id)
    json.dump({"ok": True, "invoked": bool(result), "target": after}, sys.stdout)
    sys.stdout.write("\n")


def cmd_read(node_id: str, start: int, end: int) -> None:
    app_index, frame_index, path = _parse_node_id(node_id)
    node = _resolve_path(app_index, frame_index, path)
    if node is None:
        emit_error(
            "target not found (applications changed since discovery — repeat "
            "desktop_find_controls and use fresh ids)"
        )
    summary = _node_summary(node, node_id)
    text = None
    try:
        role = summary.get("role") or ""
        if role in ("terminal", "text", "paragraph", "document web", "label"):
            # GNOME 50 / at-spi2 2.55 pygobject bindings expose the reworked
            # text API with mismatched signatures on Accessible; the unbound
            # Atspi.Text interface call routes the (start, end) arguments
            # correctly. Proven against gnome-terminal on this machine.
            text = Atspi.Text.get_text(node, start, min(end, TEXT_READ_LIMIT))
    except Exception as exc:  # noqa: BLE001 - text read is best-effort
        summary["textError"] = str(exc)
    if text is not None:
        summary["text"] = text
    json.dump({"ok": True, "node": summary}, sys.stdout)
    sys.stdout.write("\n")


def cmd_screenshot(out_path: str) -> None:
    try:
        import shutil

        import gi

        from gi.repository import Gio, GLib

        token = f"accomplish_linux_desktop_screenshot_{os.getpid()}"
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        options = {"handle_token": GLib.Variant("s", token)}
        reply = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Screenshot",
            "Screenshot",
            GLib.Variant("(sa{sv})", ["", options]),
            GLib.VariantType("(o)"),
            Gio.DBusCallFlags.NONE,
            -1,
            None,
        )
        request_handle = reply[0]

        loop = GLib.MainLoop()
        result = {"done": False}

        def response_received(bus_obj, sender, path, iface, signal, params):
            if str(params[0]) != request_handle:
                return
            response_code = params[1]
            values = params[2]
            result["code"] = response_code
            if response_code == 0:
                uri_variant = values.get("uri")
                if uri_variant is None:
                    result["error"] = "portal Response succeeded without uri"
                else:
                    result["uri"] = uri_variant.get_string()
            result["done"] = True
            loop.quit()

        bus.signal_subscribe(
            None,
            "org.freedesktop.portal.Request",
            "Response",
            None,
            None,
            Gio.DBusSignalFlags.NONE,
            response_received,
        )

        def consent_timeout() -> int:
            result["done"] = True
            result.setdefault("error", "portal screenshot timed out awaiting user consent")
            loop.quit()
            return GLib.SOURCE_REMOVE

        GLib.timeout_add_seconds(90, consent_timeout)
        loop.run()

        if not result.get("done", False):
            emit_error("portal screenshot timed out awaiting user consent")
        code = result.get("code")
        if code != 0:
            # 1 = user cancelled, 2 etc. — authorization held; record it.
            emit_error(f"portal screenshot not granted (Response code={code})")
        uri = result.get("uri")
        if not uri or not uri.startswith("file://"):
            emit_error(f"portal returned unusable uri: {uri!r}")
        source = uri[len("file://") :]
        if not os.path.exists(source):
            emit_error(f"portal screenshot file missing: {source}")
        shutil.copyfile(source, out_path)
        json.dump({"ok": True, "uri": out_path, "portalUri": uri}, sys.stdout)
        sys.stdout.write("\n")
    except Exception as exc:  # noqa: BLE001 - portal surface is environment-dependent
        emit_error(f"portal screenshot failed: {exc}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="desktop-helper.py", add_help=False)
    parser.add_argument("command", choices=["list", "controls", "invoke", "read", "screenshot"])
    parser.add_argument("--window", default="")
    parser.add_argument("--max-depth", type=int, default=MAX_WALK_DEPTH_DEFAULT)
    parser.add_argument("--id", default="")
    parser.add_argument("--action", default="click")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--end", type=int, default=400)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    if args.command == "list":
        cmd_list()
    elif args.command == "controls":
        if not args.window:
            emit_error("--window is required for controls")
        cmd_controls(args.window, max(1, min(args.max_depth, 12)))
    elif args.command == "invoke":
        if not args.id:
            emit_error("--id is required for invoke")
        cmd_invoke(args.id, args.action)
    elif args.command == "read":
        if not args.id:
            emit_error("--id is required for read")
        cmd_read(args.id, args.start, args.end)
    elif args.command == "screenshot":
        if not args.out:
            emit_error("--out is required for screenshot")
        cmd_screenshot(args.out)


if __name__ == "__main__":
    main()