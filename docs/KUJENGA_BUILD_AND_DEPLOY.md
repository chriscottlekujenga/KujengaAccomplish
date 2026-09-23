# KujengaAccomplish build and deployment guide

Repository: https://github.com/chriscottlekujenga/KujengaAccomplish

## Automatic application updates

Packaged builds check the [KujengaAccomplish releases](https://github.com/chriscottlekujenga/KujengaAccomplish/releases) shortly after startup. When a newer release exists for that operating system, Accomplish downloads it in the background and installs it when the person quits the app.

To publish a shared Windows/macOS update, bump the desktop version, merge the change to `main`, and push a tag such as `v0.3.9`. The `Publish Kujenga Accomplish release` workflow builds the Windows installer and macOS disk image, then attaches the updater metadata to the same GitHub release.

Windows releases can update automatically from the installer. macOS automatic updates require a signed and notarized release: configure `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` as repository secrets before publishing a production Mac release. Unsigned Mac artifacts remain usable after Gatekeeper approval but cannot be relied on for automatic in-place updating.

## Prerequisites

- Node.js 20 or newer
- Corepack/pnpm
- Git
- Ollama for local and Cloud-model use
- Windows: Visual Studio build tools may be required for native dependencies
- macOS: Xcode command-line tools; Apple signing/notarization credentials are needed for a trusted public distribution

## Hardware preflight (required before installation)

Verify the target machine architecture before choosing an artifact or modifying a packaged OpenCode executable. On Windows, confirm `PROCESSOR_ARCHITECTURE`, `PROCESSOR_IDENTIFIER`, and system type:

- `AMD64` / x64: install the normal Windows x64 package. Do not apply the ARM64 OpenCode replacement.
- `ARM64`: use the Windows package compatible with the device and follow the ARM64 OpenCode replacement instructions below after packaging.

Do not infer the processor architecture from Windows edition, a previous machine, or this repository's ARM64 deployment notes.

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
