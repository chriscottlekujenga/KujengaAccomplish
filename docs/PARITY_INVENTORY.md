# API Parity Inventory — Firefox migration (Phase 3)

> **Generated file — do not hand-edit.** Regenerate with `node apps/host/scripts/parity-audit.mjs` from the repo root (deterministic; same sources → same bytes).
> Generated: 2026-10-21 (run date)

Sources parsed at generation time:

- `apps/web/src/client/lib/accomplish.ts` — `AccomplishAPI` interface (+ nested `GwsAPI`, inline `analytics` object)
- `apps/web/src/client/lib/accomplish-http.ts` — gateway shim (`core` object, `OPTIONAL_NOT_SUPPORTED`)
- `apps/host/src/policy.ts` — `RPC_METHOD_ALLOWLIST` / `RPC_METHOD_BLOCKLIST`
- `apps/daemon/src/daemon-routes.ts` + `apps/daemon/src/index.ts` + builtin `daemon.ping` in `packages/agent-core/src/daemon/rpc-server.ts`

## Status semantics

| Status                 | Meaning                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| implemented            | shim `core` key backed by transport/call/events (real functionality)                                         |
| no-op                  | shim `core` key that resolves locally (no transport/events use), incl. all `analytics.*` via the no-op Proxy |
| optional-absent        | declared optional `?`, listed in shim `OPTIONAL_NOT_SUPPORTED`; UI guards skip it                            |
| unavailable            | shim Proxy throws `HttpShimNotSupportedError`                                                                |
| allowlisted            | backing RPC in gateway allowlist (proxied)                                                                   |
| registered-blocked     | registered on daemon, not allowlisted, not blocklisted (gateway default-deny)                                |
| registered-blocklisted | registered but blocklisted (plaintext secret read; blocklist wins)                                           |
| unregistered           | backing RPC named but not registered on any daemon surface (must be added)                                   |
| no-backing             | `SHIM_RPC_MAP` = null (host HTTP endpoint, WS notification, local constant, or to-be-built)                  |

Nestings are flattened: `gws.*` and `analytics.*` per sub-method; the namespace properties themselves are not methods (the `gws` absence is tracked via OPTIONAL_NOT_SUPPORTED).

## Measured totals

| Measure                                                 | Value                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Declared AccomplishAPI entries                          | **249** (204 top-level methods + 8 gws._ + 37 analytics._)     |
| Shim functional (implemented)                           | **84**                                                         |
| Shim no-op                                              | **45**                                                         |
| Shim optional-absent                                    | **7**                                                          |
| Shim unavailable                                        | **113**                                                        |
| Shim-implemented not declared on AccomplishAPI (extras) | 2                                                              |
| Gateway allowlist entries                               | **83**                                                         |
| Gateway blocklist entries                               | 7                                                              |
| Daemon registered methods                               | **133** (131 daemon-routes.ts + 1 daemon/index.ts + 1 builtin) |
| Daemon registered not allowlisted                       | 50                                                             |

### Reconciliation with plan §2.2 (measured vs known facts)

Plan §2.2 (verified 2026-10-21) states: AccomplishAPI = 249 methods · shim implements 129 (7 no-op) · 120 unavailable · allowlist 62 · daemon exposes 125. The checked-in numbers below are THIS run's real measure; each line reconciles the two accountings or flags drift.

- ✓ plan "129 implemented" = 84 functional + 45 no-op; measured no-op 45 = 8 top-level no-ops (`onHuggingFaceDownloadProgress`, `isE2EMode`, `onDebugLog`, `speechIsConfigured`, `speechGetConfig`, `onCloseRequested`, `respondToClose`, `getBuildCapabilities`) + 37 analytics.\*. Plan's parenthetical "(7 no-op)" = the deliberate top-level no-op family (treating onHuggingFaceDownloadProgress — also a no-op — under the same family). Arithmetic matches.
- ✓ plan "120 unavailable" = 113 unavailable + 7 optional-absent (browser-preview 6 + onWorkspaceDeleted). Plan's "GWS (8)" = the 8 gws.\* sub-methods (shim-side they throw while the parent namespace is absent). Arithmetic matches.
- ✓ allowlist 83 vs plan 62 + 21 M2 T1a entries = 83 — matches the M2 T1a expansion
- ✓ daemon registered 133 (131 daemon-routes.ts + 1 daemon/index.ts daemon.shutdown + 1 builtin daemon.ping) vs plan 125 = pre-M1 123 routes + shutdown + ping, +4 M1-internal methods (daemon.setClientType, daemon.setUiPresence, devBrowser.getPreviewInfo, devBrowser.openPreviewPage — deliberately not allowlisted), +4 M2 T1a methods (provider.testConnection, provider.fetchModels, provider.validateKey, secrets.listApiKeys) = 133. Arithmetic matches.

## Summary per domain

Shim counts are per method entry; RPC counts are per DISTINCT backing RPC named in the domain (null backing rows are counted as `no-backing`, not in RPC buckets).

| Domain              | Entries | implemented | no-op | optional-absent | unavailable | allowlisted | registered-blocked | registered-blocklisted | unregistered | no-backing |
| ------------------- | ------: | ----------: | ----: | --------------: | ----------: | ----------: | -----------------: | ---------------------: | -----------: | ---------: |
| app-shell           |       9 |           6 |     3 |               0 |           0 |           0 |                  0 |                      0 |            0 |          9 |
| tasks               |      14 |          14 |     0 |               0 |           0 |           8 |                  0 |                      0 |            0 |          6 |
| session-permissions |       3 |           3 |     0 |               0 |           0 |           2 |                  0 |                      0 |            0 |          1 |
| settings            |      19 |          19 |     0 |               0 |           0 |          14 |                  0 |                      0 |            0 |          2 |
| provider-settings   |       9 |           2 |     0 |               0 |           7 |           7 |                  0 |                      0 |            0 |          1 |
| api-keys-secrets    |      15 |           3 |     0 |               0 |          12 |           5 |                  2 |                      2 |            0 |          2 |
| provider-configs    |      11 |           0 |     0 |               0 |          11 |          10 |                  0 |                      0 |            0 |          1 |
| model-discovery     |      17 |           0 |     0 |               0 |          17 |           2 |                  0 |                      0 |            0 |          4 |
| huggingface         |      10 |           0 |     1 |               0 |           9 |           0 |                  2 |                      0 |            0 |          8 |
| skills              |      12 |           5 |     0 |               0 |           7 |           6 |                  2 |                      0 |            0 |          4 |
| connectors          |      23 |           1 |     0 |               0 |          22 |           0 |                  4 |                      0 |            0 |         19 |
| gws                 |       8 |           0 |     0 |               0 |           8 |           0 |                  5 |                      0 |            0 |          2 |
| whatsapp            |       6 |           2 |     0 |               0 |           4 |           0 |                  4 |                      0 |            0 |          2 |
| speech              |       4 |           0 |     2 |               0 |           2 |           0 |                  0 |                      0 |            0 |          4 |
| file-attachments    |       4 |           2 |     0 |               0 |           2 |           0 |                  0 |                      0 |            0 |          4 |
| browser-preview     |       6 |           0 |     0 |               6 |           0 |           0 |                  0 |                      0 |            0 |          6 |
| daemon-control      |       5 |           1 |     0 |               0 |           4 |           2 |                  0 |                      0 |            0 |          3 |
| bug-report          |       6 |           1 |     1 |               0 |           4 |           0 |                  1 |                      0 |            0 |          4 |
| analytics           |      37 |           0 |    37 |               0 |           0 |           0 |                  0 |                      0 |            0 |         37 |
| scheduler           |       5 |           5 |     0 |               0 |           0 |           4 |                  0 |                      0 |            0 |          1 |
| workspace           |       8 |           7 |     0 |               1 |           0 |           6 |                  0 |                      0 |            0 |          2 |
| knowledge-notes     |       4 |           4 |     0 |               0 |           0 |           4 |                  0 |                      0 |            0 |          0 |
| favorites           |       3 |           3 |     0 |               0 |           0 |           3 |                  0 |                      0 |            0 |          0 |
| accomplish-ai       |       6 |           2 |     0 |               0 |           4 |           3 |                  0 |                      0 |            0 |          2 |
| build-capabilities  |       1 |           0 |     1 |               0 |           0 |           0 |                  0 |                      0 |            0 |          1 |
| onboarding          |       2 |           2 |     0 |               0 |           0 |           2 |                  0 |                      0 |            0 |          0 |
| opencode-cli        |       2 |           2 |     0 |               0 |           0 |           0 |                  0 |                      0 |            0 |          2 |
| **TOTAL**           |     249 |          84 |    45 |               7 |         113 |          78 |                 20 |                      2 |            0 |        127 |

## Per-domain detail

### app-shell

Entries 9 — implemented 6 · no-op 3 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 0 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 9

| Method                    | Shim status | Backing RPC | RPC policy status | Note                                                                    |
| ------------------------- | ----------- | ----------- | ----------------- | ----------------------------------------------------------------------- |
| `getVersion`              | implemented | —           | —                 | host /health (HTTP, not RPC)                                            |
| `getPlatform`             | implemented | —           | —                 | host /health (HTTP, not RPC)                                            |
| `openExternal`            | implemented | —           | —                 | host /open-external (HTTP)                                              |
| `isE2EMode`               | no-op       | —           | —                 | local constant (false over gateway)                                     |
| `onCloseRequested?`       | no-op       | —           | —                 | no-op — browser close is always keep-daemon (daemon is systemd-managed) |
| `respondToClose?`         | no-op       | —           | —                 | no-op — pairs with onCloseRequested                                     |
| `onDaemonDisconnected`    | implemented | —           | —                 | WS control event daemon:disconnected                                    |
| `onDaemonReconnected`     | implemented | —           | —                 | WS control event daemon:reconnected                                     |
| `onDaemonReconnectFailed` | implemented | —           | —                 | WS control event daemon:reconnect-failed                                |

### tasks

Entries 14 — implemented 14 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 8 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 6

| Method                | Shim status | Backing RPC         | RPC policy status | Note                                        |
| --------------------- | ----------- | ------------------- | ----------------- | ------------------------------------------- |
| `startTask`           | implemented | `task.start`        | allowlisted       |                                             |
| `cancelTask`          | implemented | `task.cancel`       | allowlisted       |                                             |
| `interruptTask`       | implemented | `task.interrupt`    | allowlisted       |                                             |
| `getTask`             | implemented | `task.get`          | allowlisted       |                                             |
| `listTasks`           | implemented | `task.list`         | allowlisted       |                                             |
| `deleteTask`          | implemented | `task.delete`       | allowlisted       |                                             |
| `clearTaskHistory`    | implemented | `task.clearHistory` | allowlisted       |                                             |
| `getTodosForTask`     | implemented | `task.getTodos`     | allowlisted       |                                             |
| `onTaskUpdate`        | implemented | —                   | —                 | WS notifications task.complete + task.error |
| `onTaskUpdateBatch?`  | implemented | —                   | —                 | WS notification task.message                |
| `onTaskProgress`      | implemented | —                   | —                 | WS notification task.progress               |
| `onTaskStatusChange?` | implemented | —                   | —                 | WS notification task.statusChange           |
| `onTaskSummary?`      | implemented | —                   | —                 | WS notification task.summary                |
| `onTodoUpdate?`       | implemented | —                   | —                 | WS notification todo.update                 |

### session-permissions

Entries 3 — implemented 3 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 2 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 1

| Method                | Shim status | Backing RPC          | RPC policy status | Note                               |
| --------------------- | ----------- | -------------------- | ----------------- | ---------------------------------- |
| `respondToPermission` | implemented | `permission.respond` | allowlisted       |                                    |
| `resumeSession`       | implemented | `session.resume`     | allowlisted       |                                    |
| `onPermissionRequest` | implemented | —                    | —                 | WS notification permission.request |

### settings

Entries 19 — implemented 19 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 14 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 2

| Method                    | Shim status | Backing RPC                        | RPC policy status | Note                                                   |
| ------------------------- | ----------- | ---------------------------------- | ----------------- | ------------------------------------------------------ |
| `getNotificationsEnabled` | implemented | `settings.getNotificationsEnabled` | allowlisted       |                                                        |
| `setNotificationsEnabled` | implemented | `settings.setNotificationsEnabled` | allowlisted       |                                                        |
| `getDebugMode`            | implemented | `settings.getAll`                  | allowlisted       | derived — debugMode rides the settings.getAll snapshot |
| `setDebugMode`            | implemented | `settings.setDebugMode`            | allowlisted       |                                                        |
| `getTheme`                | implemented | `settings.getAll`                  | allowlisted       | derived — theme rides the settings.getAll snapshot     |
| `setTheme`                | implemented | `settings.setTheme`                | allowlisted       |                                                        |
| `onThemeChange?`          | implemented | —                                  | —                 | WS notification settings.changed (theme key)           |
| `getLanguage`             | implemented | `settings.getAll`                  | allowlisted       | derived                                                |
| `setLanguage`             | implemented | `settings.setLanguage`             | allowlisted       |                                                        |
| `getAppSettings`          | implemented | `settings.getAll`                  | allowlisted       | derived snapshot                                       |
| `getCloudBrowserConfig`   | implemented | `settings.getCloudBrowserConfig`   | allowlisted       |                                                        |
| `setCloudBrowserConfig`   | implemented | `settings.setCloudBrowserConfig`   | allowlisted       |                                                        |
| `getSelectedModel`        | implemented | `settings.getSelectedModel`        | allowlisted       |                                                        |
| `setSelectedModel`        | implemented | `settings.setSelectedModel`        | allowlisted       |                                                        |
| `onDebugModeChange?`      | implemented | —                                  | —                 | WS notification settings.changed (debugMode key)       |
| `getCloseBehavior`        | implemented | `settings.getCloseBehavior`        | allowlisted       |                                                        |
| `setCloseBehavior`        | implemented | `settings.setCloseBehavior`        | allowlisted       |                                                        |
| `getSandboxConfig`        | implemented | `settings.getSandboxConfig`        | allowlisted       |                                                        |
| `setSandboxConfig`        | implemented | `settings.setSandboxConfig`        | allowlisted       |                                                        |

### provider-settings

Entries 9 — implemented 2 · no-op 0 · optional-absent 0 · unavailable 7 ｜ RPC: allowlisted 7 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 1

| Method                    | Shim status | Backing RPC                | RPC policy status | Note                                                                                         |
| ------------------------- | ----------- | -------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `getProviderSettings`     | implemented | `provider.getSettings`     | allowlisted       |                                                                                              |
| `setActiveProvider`       | unavailable | `provider.setActive`       | allowlisted       |                                                                                              |
| `getConnectedProvider`    | unavailable | `provider.getSettings`     | allowlisted       | derived — connected state rides the masked provider.getSettings payload (no direct read RPC) |
| `setConnectedProvider`    | unavailable | `provider.setConnected`    | allowlisted       |                                                                                              |
| `removeConnectedProvider` | unavailable | `provider.removeConnected` | allowlisted       |                                                                                              |
| `updateProviderModel`     | unavailable | `provider.updateModel`     | allowlisted       |                                                                                              |
| `setProviderDebugMode`    | unavailable | `provider.setDebugMode`    | allowlisted       |                                                                                              |
| `getProviderDebugMode`    | unavailable | `provider.getDebugMode`    | allowlisted       |                                                                                              |
| `onAuthError?`            | implemented | —                          | —                 | WS notification auth.error                                                                   |

### api-keys-secrets

Entries 15 — implemented 3 · no-op 0 · optional-absent 0 · unavailable 12 ｜ RPC: allowlisted 5 · registered-blocked 2 · blocklisted 2 · unregistered 0 · no-backing 2

| Method                      | Shim status | Backing RPC                       | RPC policy status      | Note                                                                                                  |
| --------------------------- | ----------- | --------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `getApiKeys`                | unavailable | `secrets.listApiKeys`             | allowlisted            | M2 T1a masked backing (daemon RPC + allowlist); shim call-site wiring lands in T1b                    |
| `addApiKey`                 | implemented | `secrets.storeApiKey`             | allowlisted            |                                                                                                       |
| `removeApiKey`              | unavailable | `secrets.deleteApiKey`            | allowlisted            |                                                                                                       |
| `hasApiKey`                 | implemented | `secrets.hasAnyApiKey`            | allowlisted            |                                                                                                       |
| `setApiKey`                 | unavailable | `secrets.storeApiKey`             | allowlisted            |                                                                                                       |
| `getApiKey`                 | unavailable | `secrets.getApiKey`               | registered-blocklisted | blocklisted — must STAY blocked (masked variant `secrets.listApiKeys` ships in M2 T1a for UI display) |
| `validateApiKey`            | unavailable | `provider.validateKey`            | allowlisted            | M2 T1a — provider.validateKey                                                                         |
| `validateApiKeyForProvider` | unavailable | `provider.validateKey`            | allowlisted            | M2 T1a — provider.validateKey (desktop api-key:validate-provider parity)                              |
| `clearApiKey`               | unavailable | `secrets.clear`                   | registered-blocked     |                                                                                                       |
| `getAllApiKeys`             | unavailable | `secrets.listApiKeys`             | allowlisted            | M2 T1a masked backing (daemon RPC + allowlist); shim call-site wiring lands in T1b                    |
| `hasAnyApiKey`              | implemented | `secrets.hasAnyApiKey`            | allowlisted            |                                                                                                       |
| `saveBedrockCredentials`    | unavailable | `secrets.storeBedrockCredentials` | registered-blocked     |                                                                                                       |
| `getBedrockCredentials`     | unavailable | `secrets.getBedrockCredentials`   | registered-blocklisted | blocklisted plaintext read — M2 masked variant required                                               |
| `saveVertexCredentials`     | unavailable | —                                 | —                      | no vertex secrets RPC registered                                                                      |
| `getVertexCredentials`      | unavailable | —                                 | —                      | no vertex secrets RPC registered                                                                      |

### provider-configs

Entries 11 — implemented 0 · no-op 0 · optional-absent 0 · unavailable 11 ｜ RPC: allowlisted 10 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 1

| Method                   | Shim status | Backing RPC                      | RPC policy status | Note                                                                                 |
| ------------------------ | ----------- | -------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `getOpenAiBaseUrl`       | unavailable | `settings.getOpenAiBaseUrl`      | allowlisted       |                                                                                      |
| `setOpenAiBaseUrl`       | unavailable | `settings.setOpenAiBaseUrl`      | allowlisted       |                                                                                      |
| `getOllamaConfig`        | unavailable | `settings.getOllamaConfig`       | allowlisted       |                                                                                      |
| `setOllamaConfig`        | unavailable | `settings.setOllamaConfig`       | allowlisted       |                                                                                      |
| `getAzureFoundryConfig`  | unavailable | `settings.getAzureFoundryConfig` | allowlisted       |                                                                                      |
| `setAzureFoundryConfig`  | unavailable | `settings.setAzureFoundryConfig` | allowlisted       |                                                                                      |
| `saveAzureFoundryConfig` | unavailable | —                                | —                 | no direct RPC — M2: key via secrets.storeApiKey + config write (validate-first flow) |
| `getLiteLLMConfig`       | unavailable | `settings.getLiteLLMConfig`      | allowlisted       |                                                                                      |
| `setLiteLLMConfig`       | unavailable | `settings.setLiteLLMConfig`      | allowlisted       |                                                                                      |
| `getLMStudioConfig`      | unavailable | `settings.getLMStudioConfig`     | allowlisted       |                                                                                      |
| `setLMStudioConfig`      | unavailable | `settings.setLMStudioConfig`     | allowlisted       |                                                                                      |

Config writes carry the API key and read paths must return masked data only (plan §5.4) — every M2 allowlist addition needs paired secrets tests.

### model-discovery

Entries 17 — implemented 0 · no-op 0 · optional-absent 0 · unavailable 17 ｜ RPC: allowlisted 2 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 4

| Method                       | Shim status | Backing RPC               | RPC policy status | Note                                                                   |
| ---------------------------- | ----------- | ------------------------- | ----------------- | ---------------------------------------------------------------------- |
| `testOllamaConnection`       | unavailable | `provider.testConnection` | allowlisted       | M2 T1a                                                                 |
| `testAzureFoundryConnection` | unavailable | `provider.testConnection` | allowlisted       | M2 T1a                                                                 |
| `fetchProviderModels`        | unavailable | `provider.fetchModels`    | allowlisted       | M2 T1a                                                                 |
| `fetchOpenRouterModels`      | unavailable | `provider.fetchModels`    | allowlisted       | M2 T1a                                                                 |
| `testLiteLLMConnection`      | unavailable | `provider.testConnection` | allowlisted       | M2 T1a                                                                 |
| `fetchLiteLLMModels`         | unavailable | `provider.fetchModels`    | allowlisted       | M2 T1a                                                                 |
| `testLMStudioConnection`     | unavailable | `provider.testConnection` | allowlisted       | M2 T1a                                                                 |
| `fetchLMStudioModels`        | unavailable | `provider.fetchModels`    | allowlisted       | M2 T1a                                                                 |
| `testNimConnection`          | unavailable | `provider.testConnection` | allowlisted       | M2 T1a                                                                 |
| `fetchNimModels`             | unavailable | `provider.fetchModels`    | allowlisted       | M2 T1a                                                                 |
| `testCustomConnection`       | unavailable | `provider.testConnection` | allowlisted       | M2 T1a                                                                 |
| `validateBedrockCredentials` | unavailable | —                         | —                 | separate desktop flow (bedrock:validate) — no T1a RPC; defer to T1b/M3 |
| `fetchBedrockModels`         | unavailable | `provider.fetchModels`    | allowlisted       | M2 T1a — daemon-side stored credentials                                |
| `validateVertexCredentials`  | unavailable | —                         | —                 | separate desktop flow (vertex:validate) — no T1a RPC; defer to T1b/M3  |
| `fetchVertexModels`          | unavailable | `provider.fetchModels`    | allowlisted       | M2 T1a — daemon-side stored credentials                                |
| `detectVertexProject`        | unavailable | —                         | —                 | host-side gcloud flow — defer to T1b/M6                                |
| `listVertexProjects`         | unavailable | —                         | —                 | host-side gcloud flow — defer to T1b/M6                                |

M2 T1a: connection tests + model fetches (incl. bedrock/vertex via daemon-side stored credentials) are backed by `provider.testConnection`/`provider.fetchModels`, keys never cross the socket; shim call-site wiring lands in T1b. `validateBedrockCredentials`/`validateVertexCredentials` keep their separate desktop flows — no T1a RPC yet.

### huggingface

Entries 10 — implemented 0 · no-op 1 · optional-absent 0 · unavailable 9 ｜ RPC: allowlisted 0 · registered-blocked 2 · blocklisted 0 · unregistered 0 · no-backing 8

| Method                          | Shim status | Backing RPC                          | RPC policy status  | Note                                           |
| ------------------------------- | ----------- | ------------------------------------ | ------------------ | ---------------------------------------------- |
| `getHuggingFaceLocalConfig`     | unavailable | `provider.getHuggingFaceLocalConfig` | registered-blocked |                                                |
| `setHuggingFaceLocalConfig`     | unavailable | `provider.setHuggingFaceLocalConfig` | registered-blocked |                                                |
| `listHuggingFaceModels`         | unavailable | —                                    | —                  | HF local-server control port (plan M2/M6 seam) |
| `downloadHuggingFaceModel`      | unavailable | —                                    | —                  | HF local-server control port                   |
| `startHuggingFaceServer`        | unavailable | —                                    | —                  | HF local-server control port                   |
| `stopHuggingFaceServer`         | unavailable | —                                    | —                  | HF local-server control port                   |
| `getHuggingFaceServerStatus`    | unavailable | —                                    | —                  | HF local-server control port                   |
| `testHuggingFaceConnection`     | unavailable | —                                    | —                  | HF local-server control port                   |
| `deleteHuggingFaceModel`        | unavailable | —                                    | —                  | HF local-server control port                   |
| `onHuggingFaceDownloadProgress` | no-op       | —                                    | —                  | shim no-op subscription until HF ships         |

### skills

Entries 12 — implemented 5 · no-op 0 · optional-absent 0 · unavailable 7 ｜ RPC: allowlisted 6 · registered-blocked 2 · blocklisted 0 · unregistered 0 · no-backing 4

| Method               | Shim status | Backing RPC                | RPC policy status  | Note                                                          |
| -------------------- | ----------- | -------------------------- | ------------------ | ------------------------------------------------------------- |
| `getSkills`          | implemented | `skills.list`              | allowlisted        |                                                               |
| `getEnabledSkills`   | implemented | `skills.listEnabled`       | allowlisted        |                                                               |
| `setSkillEnabled`    | implemented | `skills.setEnabled`        | allowlisted        |                                                               |
| `getSkillContent`    | implemented | `skills.getContent`        | allowlisted        |                                                               |
| `getUserSkillsPath`  | unavailable | `skills.getUserSkillsPath` | allowlisted        | registered + allowlisted but shim method absent — M2 wires it |
| `pickSkillFolder`    | unavailable | —                          | —                  | host /pick-folder (HTTP zenity) reuse — M2                    |
| `addSkillFromFolder` | unavailable | `skills.addFromPath`       | registered-blocked |                                                               |
| `addSkillFromGitHub` | unavailable | —                          | —                  | no daemon RPC — fetch+verify path TBD (post-M2)               |
| `deleteSkill`        | unavailable | `skills.delete`            | registered-blocked |                                                               |
| `resyncSkills`       | implemented | `skills.resync`            | allowlisted        |                                                               |
| `openSkillInEditor`  | unavailable | —                          | —                  | Electron shell-open; browser equivalent TBD                   |
| `showSkillInFolder`  | unavailable | —                          | —                  | Electron shell-open; browser equivalent TBD                   |

### connectors

Entries 23 — implemented 1 · no-op 0 · optional-absent 0 · unavailable 22 ｜ RPC: allowlisted 0 · registered-blocked 4 · blocklisted 0 · unregistered 0 · no-backing 19

| Method                          | Shim status | Backing RPC             | RPC policy status  | Note                                                                     |
| ------------------------------- | ----------- | ----------------------- | ------------------ | ------------------------------------------------------------------------ |
| `getOpenAiOauthStatus`          | unavailable | —                       | —                  | M6 — maps to auth.openai.status                                          |
| `loginOpenAiWithChatGpt`        | unavailable | —                       | —                  | M6 — maps to auth.openai.startLogin + awaitCompletion                    |
| `getSlackMcpOauthStatus`        | unavailable | —                       | —                  | M6                                                                       |
| `loginSlackMcp`                 | unavailable | —                       | —                  | M6 — built-in connector login path                                       |
| `logoutSlackMcp`                | unavailable | —                       | —                  | M6                                                                       |
| `getCopilotOAuthStatus`         | unavailable | —                       | —                  | M6                                                                       |
| `loginGithubCopilot`            | unavailable | —                       | —                  | M6                                                                       |
| `logoutGithubCopilot`           | unavailable | —                       | —                  | M6                                                                       |
| `getConnectors`                 | unavailable | `connectors.list`       | registered-blocked |                                                                          |
| `addConnector`                  | unavailable | `connectors.upsert`     | registered-blocked |                                                                          |
| `deleteConnector`               | unavailable | `connectors.delete`     | registered-blocked |                                                                          |
| `setConnectorEnabled`           | unavailable | `connectors.setEnabled` | registered-blocked |                                                                          |
| `startConnectorOAuth`           | unavailable | —                       | —                  | M6 oauth re-homing to host loopbacks                                     |
| `completeConnectorOAuth`        | unavailable | —                       | —                  | M6 oauth re-homing to host loopbacks                                     |
| `disconnectConnector`           | unavailable | —                       | —                  | M6 — probable backing connectors.deleteTokens; confirm at implementation |
| `onMcpAuthCallback?`            | implemented | —                       | —                  | WS control event mcp-callback (deep link)                                |
| `getBuiltInConnectorAuthStatus` | unavailable | —                       | —                  | M6 built-in connector token state                                        |
| `loginBuiltInConnector`         | unavailable | —                       | —                  | M6 oauth re-homing to host loopbacks                                     |
| `logoutBuiltInConnector`        | unavailable | —                       | —                  | M6                                                                       |
| `lightdashGetServerUrl`         | unavailable | —                       | —                  | M6                                                                       |
| `lightdashSetServerUrl`         | unavailable | —                       | —                  | M6                                                                       |
| `datadogGetServerUrl`           | unavailable | —                       | —                  | M6                                                                       |
| `datadogSetServerUrl`           | unavailable | —                       | —                  | M6                                                                       |

OpenAI (ChatGPT) / Slack-MCP / GitHub-Copilot OAuth methods are grouped here (built-in connector/OAuth login family); M6 re-homes their flows to host loopbacks.

### gws

Entries 8 — implemented 0 · no-op 0 · optional-absent 0 · unavailable 8 ｜ RPC: allowlisted 0 · registered-blocked 5 · blocklisted 0 · unregistered 0 · no-backing 2

| Method                | Shim status | Backing RPC              | RPC policy status  | Note                                                         |
| --------------------- | ----------- | ------------------------ | ------------------ | ------------------------------------------------------------ |
| `gws.listAccounts`    | unavailable | `gwsAccount.list`        | registered-blocked |                                                              |
| `gws.startAuth`       | unavailable | `gwsAccount.add`         | registered-blocked | probable — M6 to confirm (startAuth creates pending account) |
| `gws.completeAuth`    | unavailable | `gwsAccount.updateToken` | registered-blocked | probable — M6 to confirm                                     |
| `gws.removeAccount`   | unavailable | `gwsAccount.remove`      | registered-blocked |                                                              |
| `gws.updateLabel`     | unavailable | `gwsAccount.updateLabel` | registered-blocked |                                                              |
| `gws.cancelAuth`      | unavailable | `gwsAccount.remove`      | registered-blocked | probable — M6 to confirm (cancelAuth cleans pending auth)    |
| `gws.onStatusChanged` | unavailable | —                        | —                  | WS notification status.changed (GWS)                         |
| `gws.onAuthError`     | unavailable | —                        | —                  | WS notification auth error (GWS)                             |

`gws` namespace is optional-absent; sub-methods are unreachable while the parent is absent.

### whatsapp

Entries 6 — implemented 2 · no-op 0 · optional-absent 0 · unavailable 4 ｜ RPC: allowlisted 0 · registered-blocked 4 · blocklisted 0 · unregistered 0 · no-backing 2

| Method               | Shim status | Backing RPC           | RPC policy status  | Note                            |
| -------------------- | ----------- | --------------------- | ------------------ | ------------------------------- |
| `getWhatsAppConfig`  | unavailable | `whatsapp.getConfig`  | registered-blocked |                                 |
| `connectWhatsApp`    | unavailable | `whatsapp.connect`    | registered-blocked |                                 |
| `disconnectWhatsApp` | unavailable | `whatsapp.disconnect` | registered-blocked |                                 |
| `setWhatsAppEnabled` | unavailable | `whatsapp.setEnabled` | registered-blocked |                                 |
| `onWhatsAppQR`       | implemented | —                     | —                  | WS notification whatsapp.qr     |
| `onWhatsAppStatus`   | implemented | —                     | —                  | WS notification whatsapp.status |

### speech

Entries 4 — implemented 0 · no-op 2 · optional-absent 0 · unavailable 2 ｜ RPC: allowlisted 0 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 4

| Method               | Shim status | Backing RPC | RPC policy status | Note                                                          |
| -------------------- | ----------- | ----------- | ----------------- | ------------------------------------------------------------- |
| `speechIsConfigured` | no-op       | —           | —                 | shim no-op — M6 feature-flagged OFF with friendly degradation |
| `speechGetConfig`    | no-op       | —           | —                 | shim no-op — M6 feature-flagged OFF                           |
| `speechValidate`     | unavailable | —           | —                 | M6 — feature-flagged OFF, graceful degradation                |
| `speechTranscribe`   | unavailable | —           | —                 | M6 — feature-flagged OFF, graceful degradation                |

### file-attachments

Entries 4 — implemented 2 · no-op 0 · optional-absent 0 · unavailable 2 ｜ RPC: allowlisted 0 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 4

| Method                | Shim status | Backing RPC | RPC policy status | Note                                                                           |
| --------------------- | ----------- | ----------- | ----------------- | ------------------------------------------------------------------------------ |
| `pickFolder`          | implemented | —           | —                 | host /pick-folder (HTTP zenity)                                                |
| `pickFiles`           | implemented | —           | —                 | host /pick-files (HTTP zenity)                                                 |
| `getFilePath`         | unavailable | —           | —                 | M2 documented interface change: browser File objects cannot reveal local paths |
| `processDroppedFiles` | unavailable | —           | —                 | M2: route drops through the host picker flow                                   |

`pickFolder` also serves the skills picker. M2 documents that browser-dropped `File` objects cannot reveal local paths — the picker flow is the authorized path (plan §6 M2.3).

### browser-preview

Entries 6 — implemented 0 · no-op 0 · optional-absent 6 · unavailable 0 ｜ RPC: allowlisted 0 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 6

| Method                     | Shim status     | Backing RPC | RPC policy status | Note                                                      |
| -------------------------- | --------------- | ----------- | ----------------- | --------------------------------------------------------- |
| `onBrowserFrame?`          | optional-absent | —           | —                 | M2 on-demand screenshot v1 (dev-browser bridge)           |
| `onBrowserNavigate?`       | optional-absent | —           | —                 | M2 — no live screencast per migration plan §8.5           |
| `onBrowserStatus?`         | optional-absent | —           | —                 | M2 on-demand screenshot v1                                |
| `startBrowserPreview?`     | optional-absent | —           | —                 | M2 on-demand screenshot v1 — new daemon methods as needed |
| `stopBrowserPreview?`      | optional-absent | —           | —                 | M2 on-demand screenshot v1                                |
| `getBrowserPreviewStatus?` | optional-absent | —           | —                 | M2 on-demand screenshot v1                                |

### daemon-control

Entries 5 — implemented 1 · no-op 0 · optional-absent 0 · unavailable 4 ｜ RPC: allowlisted 2 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 3

| Method                | Shim status | Backing RPC       | RPC policy status | Note                                                                        |
| --------------------- | ----------- | ----------------- | ----------------- | --------------------------------------------------------------------------- |
| `getDaemonSocketPath` | unavailable | —                 | —                 | M6 — host-owned (socket path stays loopback-internal)                       |
| `daemonPing`          | implemented | `daemon.ping`     | allowlisted       |                                                                             |
| `daemonRestart`       | unavailable | —                 | —                 | M6 — host-owned restart-then-reconnect (backoff exists in daemon-connector) |
| `daemonStop`          | unavailable | `daemon.shutdown` | allowlisted       | probable mapping; M6 to confirm semantics                                   |
| `daemonStart`         | unavailable | —                 | —                 | M6 — host-owned systemd start                                               |

Restart/Stop/Start are host-owned in M6 (restart-then-reconnect); `daemon.ping` is implemented+allowlisted today.

### bug-report

Entries 6 — implemented 1 · no-op 1 · optional-absent 0 · unavailable 4 ｜ RPC: allowlisted 0 · registered-blocked 1 · blocklisted 0 · unregistered 0 · no-backing 4

| Method              | Shim status | Backing RPC                 | RPC policy status  | Note                                     |
| ------------------- | ----------- | --------------------------- | ------------------ | ---------------------------------------- |
| `onDebugLog`        | no-op       | —                           | —                  | shim no-op — no daemon-side source       |
| `logEvent`          | implemented | —                           | —                  | host /client-log (HTTP, sanitized)       |
| `exportLogs`        | unavailable | `logs.getTasksForBugReport` | registered-blocked | M6 — combined with host-side logs        |
| `captureScreenshot` | unavailable | —                           | —                  | M6 in-page capture (no privilege needed) |
| `captureAxtree`     | unavailable | —                           | —                  | M6 in-page capture (no privilege needed) |
| `generateBugReport` | unavailable | `logs.getTasksForBugReport` | registered-blocked | M6 — packaged with host logs             |

`capture*` are in-page captures (M6, no privilege); `logEvent` uses the host HTTP `/client-log`; `exportLogs`/`generateBugReport` use `logs.getTasksForBugReport` + host logs (M6).

### analytics

Entries 37 — implemented 0 · no-op 37 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 0 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 37

| Method                                   | Shim status | Backing RPC | RPC policy status | Note                                              |
| ---------------------------------------- | ----------- | ----------- | ----------------- | ------------------------------------------------- |
| `analytics.track`                        | no-op       | —           | —                 | M6 — local batched JSONL endpoint (plan §6 M6/§9) |
| `analytics.trackPageView`                | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackSubmitTask`              | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackNewTask`                 | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackOpenSettings`            | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackSaveApiKey`              | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackSelectProvider`          | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackSelectModel`             | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackToggleDebugMode`         | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackTaskStart`               | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackTaskComplete`            | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackTaskError`               | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackPermissionRequested`     | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackPermissionResponse`      | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackToolUsed`                | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackUserInteraction`         | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackAppClose`                | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackAppBackgrounded`         | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackAppForegrounded`         | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackModelSelectionStep`      | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackModelSelectionComplete`  | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackModelSelectionAbandoned` | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackHistoryViewed`           | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackTaskFromHistory`         | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackHistoryCleared`          | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackTaskDetailsExpanded`     | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackOutputCopied`            | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackProviderDisconnected`    | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackHelpLinkClicked`         | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackSkillAction`             | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackSaveVoiceApiKey`         | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackExportLogs`              | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackThreadExported`          | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackTaskLauncherAction`      | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackTaskFeedback`            | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackStopAgent`               | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |
| `analytics.trackProviderBoxClicked`      | no-op       | —           | —                 | M6 — local batched JSONL endpoint                 |

All analytics.\* entries resolve through the shim no-op Proxy today; M6 adds a local batched JSONL endpoint.

### scheduler

Entries 5 — implemented 5 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 4 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 1

| Method               | Shim status | Backing RPC               | RPC policy status | Note                          |
| -------------------- | ----------- | ------------------------- | ----------------- | ----------------------------- |
| `listSchedules`      | implemented | `task.listScheduled`      | allowlisted       |                               |
| `createSchedule`     | implemented | `task.schedule`           | allowlisted       |                               |
| `deleteSchedule`     | implemented | `task.cancelScheduled`    | allowlisted       |                               |
| `setScheduleEnabled` | implemented | `task.setScheduleEnabled` | allowlisted       |                               |
| `isAutoStartEnabled` | implemented | —                         | —                 | host /autostart-status (HTTP) |

`isAutoStartEnabled` reads host systemd autostart over HTTP, not scheduler RPC; kept in scheduler as it feeds the same settings page.

### workspace

Entries 8 — implemented 7 · no-op 0 · optional-absent 1 · unavailable 0 ｜ RPC: allowlisted 6 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 2

| Method                 | Shim status     | Backing RPC           | RPC policy status | Note                                   |
| ---------------------- | --------------- | --------------------- | ----------------- | -------------------------------------- |
| `listWorkspaces`       | implemented     | `workspace.list`      | allowlisted       |                                        |
| `getActiveWorkspaceId` | implemented     | `workspace.getActive` | allowlisted       |                                        |
| `switchWorkspace`      | implemented     | `workspace.setActive` | allowlisted       |                                        |
| `createWorkspace`      | implemented     | `workspace.create`    | allowlisted       |                                        |
| `updateWorkspace`      | implemented     | `workspace.update`    | allowlisted       |                                        |
| `deleteWorkspace`      | implemented     | `workspace.delete`    | allowlisted       |                                        |
| `onWorkspaceChanged?`  | implemented     | —                     | —                 | WS notification workspace.changed      |
| `onWorkspaceDeleted?`  | optional-absent | —                     | —                 | optional-absent — no shim subscription |

### knowledge-notes

Entries 4 — implemented 4 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 4 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 0

| Method                | Shim status | Backing RPC            | RPC policy status | Note |
| --------------------- | ----------- | ---------------------- | ----------------- | ---- |
| `listKnowledgeNotes`  | implemented | `knowledgeNote.list`   | allowlisted       |      |
| `createKnowledgeNote` | implemented | `knowledgeNote.create` | allowlisted       |      |
| `updateKnowledgeNote` | implemented | `knowledgeNote.update` | allowlisted       |      |
| `deleteKnowledgeNote` | implemented | `knowledgeNote.delete` | allowlisted       |      |

### favorites

Entries 3 — implemented 3 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 3 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 0

| Method           | Shim status | Backing RPC        | RPC policy status | Note |
| ---------------- | ----------- | ------------------ | ----------------- | ---- |
| `addFavorite`    | implemented | `favorites.add`    | allowlisted       |      |
| `removeFavorite` | implemented | `favorites.remove` | allowlisted       |      |
| `listFavorites`  | implemented | `favorites.list`   | allowlisted       |      |

### accomplish-ai

Entries 6 — implemented 2 · no-op 0 · optional-absent 0 · unavailable 4 ｜ RPC: allowlisted 3 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 2

| Method                      | Shim status | Backing RPC                | RPC policy status | Note                                                    |
| --------------------------- | ----------- | -------------------------- | ----------------- | ------------------------------------------------------- |
| `accomplishAiConnect`       | unavailable | `accomplish-ai.connect`    | allowlisted       |                                                         |
| `accomplishAiEnsureReady`   | unavailable | `accomplish-ai.connect`    | allowlisted       | derived — connect-if-needed                             |
| `accomplishAiDisconnect`    | unavailable | `accomplish-ai.disconnect` | allowlisted       |                                                         |
| `accomplishAiGetUsage`      | implemented | `accomplish-ai.get-usage`  | allowlisted       |                                                         |
| `accomplishAiGetStatus`     | unavailable | —                          | —                 | no status RPC registered (connect result carries state) |
| `onAccomplishAiUsageUpdate` | implemented | —                          | —                 | WS notification accomplish-ai.usage-update              |

### build-capabilities

Entries 1 — implemented 0 · no-op 1 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 0 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 1

| Method                 | Shim status | Backing RPC | RPC policy status | Note                                                   |
| ---------------------- | ----------- | ----------- | ----------------- | ------------------------------------------------------ |
| `getBuildCapabilities` | no-op       | —           | —                 | local constant — OSS build: no free mode, no analytics |

### onboarding

Entries 2 — implemented 2 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 2 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 0

| Method                  | Shim status | Backing RPC                      | RPC policy status | Note                                         |
| ----------------------- | ----------- | -------------------------------- | ----------------- | -------------------------------------------- |
| `getOnboardingComplete` | implemented | `settings.getAll`                | allowlisted       | derived — rides the settings.getAll snapshot |
| `setOnboardingComplete` | implemented | `settings.setOnboardingComplete` | allowlisted       |                                              |

### opencode-cli

Entries 2 — implemented 2 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 0 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 2

| Method               | Shim status | Backing RPC | RPC policy status | Note                    |
| -------------------- | ----------- | ----------- | ----------------- | ----------------------- |
| `checkOpenCodeCli`   | implemented | —           | —                 | host /cli-status (HTTP) |
| `getOpenCodeVersion` | implemented | —           | —                 | host /cli-status (HTTP) |

## Appendix A — shim-implemented but NOT declared on AccomplishAPI (2)

| Shim key                    | Shim status | Backing RPC            | Note                                                                              |
| --------------------------- | ----------- | ---------------------- | --------------------------------------------------------------------------------- |
| `isFavorite`                | implemented | `favorites.isFavorite` | shim-extra: implemented in shim + Electron preload, not declared on AccomplishAPI |
| `onSettingsChangedExternal` | implemented | —                      | shim-extra: WS notification settings.changed relay, not declared on AccomplishAPI |

## Appendix B — WS subscriptions wired by the shim (14 notifications, 4 control events)

Notifications: `settings.changed`, `task.complete`, `task.error`, `task.message`, `task.progress`, `permission.request`, `task.statusChange`, `task.summary`, `todo.update`, `auth.error`, `workspace.changed`, `accomplish-ai.usage-update`, `whatsapp.qr`, `whatsapp.status`

Control events: `mcp-callback`, `daemon:disconnected`, `daemon:reconnected`, `daemon:reconnect-failed`

## Appendix C — allowlisted RPC methods with no shim mapping (5)

`health.check`, `task.status`, `task.getActiveCount`, `settings.setNimConfig`, `workspace.get`

## Appendix D — shim transport.call coverage (self-check)

All 53 distinct `transport.call` targets are allowlisted — verified at generation time.
