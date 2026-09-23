# KujengaAccomplish maintainer context

Repository: https://github.com/chriscottlekujenga/KujengaAccomplish

## What this fork is

KujengaAccomplish is a Windows ARM64-tested Accomplish fork configured for Ollama Cloud through the local Ollama API. It adds practical task-routing and execution improvements while retaining the upstream Electron, daemon, and OpenCode architecture.

## Current capabilities

- Ollama Cloud models are available through local Ollama:
  - `glm-5.3:cloud` for general work and coordination
  - `glm-5.3-flash:cloud` for short, lightweight work
  - `gpt-oss:120b-cloud` for careful analysis and planning
  - `kimi-k2.7-code:cloud` for coding and repository work
- Prompt suggestions select an appropriate model for ordinary tasks.
- Optional Project mode plans and routes larger work into model-specific subtasks.
- Debug Mode asks for short visible plans and progress updates. It does not expose private model reasoning.
- A running task can receive a new instruction. The current turn is interrupted and the same session resumes with the queued instruction and its existing context.

## Important architecture

`apps/web` is the React interface. `apps/desktop` is the Electron main process and preload bridge. `apps/daemon` owns task persistence and runtime RPC. `packages/agent-core` contains TaskManager, OpenCodeAdapter, storage, and provider configuration.

The normal path is:

`web UI → Electron IPC → daemon RPC → TaskService → TaskManager → OpenCodeAdapter → Ollama/OpenCode`

For mid-run instructions, the path is:

`running-task input → task:send IPC → task.send RPC → TaskService.sendUserMessage → TaskManager.sendUserMessage → OpenCodeAdapter.queueUserMessage`

The adapter sends Ctrl+C to end the current OpenCode turn, then respawns the saved session with a redirect prompt. Do not call the ordinary Stop method for this flow: Stop deliberately clears queued redirects.

## Windows ARM64 requirement

## Hardware preflight (required before installation)

Before selecting or packaging a Windows build, verify the target computer's actual CPU architecture and operating-system bitness. Do not infer ARM64 from the project name, prior deployment notes, or a Windows version alone.

- On Windows, check `PROCESSOR_ARCHITECTURE`, `PROCESSOR_IDENTIFIER`, and the system type. Common values are `AMD64` / x64 and `ARM64`.
- Use the normal Windows x64 package on an AMD64/x64 computer.
- Apply the ARM64 OpenCode replacement below only on a confirmed Windows ARM64 computer.
- Record the detected architecture in the installation handoff and use it to select the matching packaged application and OpenCode binary.

The upstream packaged application uses `opencode-windows-x64-baseline`, which crashes on this ARM64 Windows system. After each Windows package build, replace this installed file with an ARM64 OpenCode executable:

`resources/app.asar.unpacked/node_modules/opencode-windows-x64-baseline/bin/opencode.exe`

Keep a backup of the original x64 executable. This replacement is required until the build configuration packages an ARM64 OpenCode dependency natively.

## Configuration and secrets

- Ollama signs in separately and serves its local API, normally at `http://127.0.0.1:11434`.
- Never commit API keys, Ollama credentials, session files, or `.env` files.
- Each collaborator should use their own Ollama account and credentials.
- The app database is stored under `%APPDATA%\\Accomplish` on Windows.

## Current limitations

- macOS packages must be built on macOS; Electron Builder does not create valid Mac apps from Windows.
- Windows packaging currently produces x64 artifacts and needs the ARM64 executable replacement above for this machine.
- The installed dependency tree has had missing optional/test dependencies. Type checks and production builds are the dependable local verification baseline until dependencies are repaired.
- The Project-mode UI stores status but still benefits from a dedicated execution view that shows each subtask, model, output, and state.

## Before changing the app

1. Read `AGENTS.md`, then inspect the relevant application layer.
2. Preserve the source/daemon/desktop/web separation.
3. Run type checks for every affected package.
4. Rebuild the app before testing packaged behavior.
5. On Windows ARM64, restore the ARM64 OpenCode executable after packaging.
6. Do not rely on an assistant message that says “complete”; verify the stored task status and visible UI state.
