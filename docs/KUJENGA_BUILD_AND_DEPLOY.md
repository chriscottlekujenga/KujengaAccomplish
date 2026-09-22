# KujengaAccomplish build and deployment guide

Repository: https://github.com/chriscottlekujenga/KujengaAccomplish

## Prerequisites

- Node.js 20 or newer
- Corepack/pnpm
- Git
- Ollama for local and Cloud-model use
- Windows: Visual Studio build tools may be required for native dependencies
- macOS: Xcode command-line tools; Apple signing/notarization credentials are needed for a trusted public distribution

## Install from source

```bash
git clone https://github.com/chriscottlekujenga/KujengaAccomplish.git
cd KujengaAccomplish
corepack enable
pnpm install
pnpm -F @accomplish_ai/agent-core build
pnpm -F @accomplish/web build
pnpm -F @accomplish/daemon build
```

Use the desktop package scripts in `apps/desktop/package.json` for a complete application build.

## Checks

```bash
pnpm -F @accomplish_ai/agent-core typecheck
pnpm -F @accomplish/daemon typecheck
pnpm -F @accomplish/web typecheck
```

If Vitest fails before tests start because an optional package is missing, repair the dependency installation with the lockfile intact. Do not delete `node_modules` or lockfiles as a first response on a collaborator’s machine.

## Windows release

Build from Windows with the desktop packaging command or Electron Builder. The package output is under `apps/desktop/release`.

For Windows ARM64, replace the packaged x64 OpenCode executable with an ARM64 build after packaging. Test a harmless task before distributing the build.

Package a portable directory as a ZIP for release distribution. It is unsigned unless a Windows code-signing certificate is configured.

## macOS release

Build on a Mac, not Windows:

```bash
pnpm -F @accomplish/desktop package:mac
```

For a public release, sign and notarize the app with an Apple Developer certificate. An unsigned build can be distributed for testing but macOS will require manual Gatekeeper approval.

Build separate Apple Silicon and Intel artifacts when the packaging configuration supports both.

## GitHub release process

1. Commit source changes and push `main`.
2. Create a version tag such as `v0.4.0-kujenga.1`.
3. Create a GitHub release from that tag.
4. Attach the Windows ZIP and macOS ZIP/DMG.
5. State the OS, architecture, signing status, setup steps, and known limitations in release notes.

## First-run verification

1. Start Ollama and sign in to the intended account.
2. Open KujengaAccomplish and select Ollama.
3. Confirm available Cloud models appear.
4. Run a harmless prompt such as “Reply exactly: connection works.”
5. For a running task, enter a short new instruction and press Enter. It should redirect and resume the same session. The red Stop button should still stop permanently.
