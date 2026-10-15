# Expert Autonomy Mode

Start with:

```bash
pnpm dev:expert
```

Standard mode remains:

```bash
pnpm dev
```

In Expert Mode, the user's prompt and workspace instructions define human gates.
Built-in per-file and per-desktop-action approvals are bypassed, while the desktop
sensitive-app blocklist remains enforced.

Example:

```text
Work autonomously. You may edit files, run commands, install dependencies, commit,
and push. Ask me immediately before deleting source files, force-pushing, sending
anything externally, or changing credentials/security settings.
```

Environment variable:

```bash
ACCOMPLISH_AUTONOMY_MODE=expert
```
