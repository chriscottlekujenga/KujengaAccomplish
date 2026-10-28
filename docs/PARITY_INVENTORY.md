# API Parity Inventory — Firefox migration (Phase 3)

> **Generated file — do not hand-edit.** Regenerate with `node apps/host/scripts/parity-audit.mjs` from the repo root (deterministic; same sources → same bytes).
> Generated: 2026-10-27 (run date)

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
| Declared AccomplishAPI entries                          | **250** (205 top-level methods + 8 gws._ + 37 analytics._)     |
| Shim functional (implemented)                           | **142**                                                        |
| Shim no-op                                              | **45**                                                         |
| Shim optional-absent                                    | **3**                                                          |
| Shim unavailable                                        | **60**                                                         |
| Shim-implemented not declared on AccomplishAPI (extras) | 2                                                              |
| Gateway allowlist entries                               | **99**                                                         |
| Gateway blocklist entries                               | 7                                                              |
| Daemon registered methods                               | **138** (136 daemon-routes.ts + 1 daemon/index.ts + 1 builtin) |
| Daemon registered not allowlisted                       | 39                                                             |

### Reconciliation with plan §2.2 (measured vs known facts)

Plan §2.2 (verified 2026-10-21) states: AccomplishAPI = 249 methods · shim implements 129 (7 no-op) · 120 unavailable · allowlist 62 · daemon exposes 125. The checked-in numbers below are THIS run's real measure; each line reconciles the two accountings or flags drift.

- ✓ plan "129 implemented" = 142 functional + 45 no-op, where functional = 84 pre-T1b + 42 T1b-shim-wired entries + 10 T2 skills/connector-CRUD entries + 1 T3 file-attachment-drop entry (processDroppedFiles → host picker) + 4 T4 browser-preview entries (on-demand captureFrame poll ×4) + 1 M6-A T4 entry (getPendingRequest — pending-request restore read) and measured no-op 45 = 8 top-level no-ops + 37 analytics.\*. Plan's parenthetical "(7 no-op)" = the deliberate top-level no-op family (treating onHuggingFaceDownloadProgress — also a no-op — under the same family). Arithmetic matches.
- ✓ plan "120 unavailable" = 60 unavailable + 3 optional-absent (browser-preview onBrowserNavigate/onBrowserStatus 2 + onWorkspaceDeleted), minus the 42 entries T1b promoted to implemented, the 10 entries T2 promoted (skills CRUD + connector CRUD), the 1 entry T3 promoted (processDroppedFiles via the host picker), and the 4 entries T4 promoted (browser-preview poll ×4). Plan's "GWS (8)" = the 8 gws.\* sub-methods (shim-side they throw while the parent namespace is absent). Arithmetic matches.
- ✓ allowlist 99 vs plan 62 + 21 M2 T1a entries + 2 T1b entries (provider.validateCredentials + secrets.storeBedrockCredentials) + 9 T2 entries (skills.addFromPath/addFromGitHub/delete + connectors.list/upsert/setEnabled/setStatus/delete/deleteTokens) + 3 T4 entries (devBrowser.openPreviewPage promotes to allowlisted; captureFrame + shutdown new) + 1 T5 entry (task.stop — daemon-native stop, cancel-parity; no shim mapping) + 1 M6-A T4 entry (task.getPendingRequest — pending-request restore read, §5.4-paired) = 99 — matches the M2+M6-A expansion
- ✓ daemon registered 138 (136 daemon-routes.ts + 1 daemon/index.ts daemon.shutdown + 1 builtin daemon.ping) vs plan 125 = pre-M1 123 routes + shutdown + ping, +4 M1-internal methods (daemon.setClientType, daemon.setUiPresence, devBrowser.getPreviewInfo, devBrowser.openPreviewPage), +4 M2 T1a methods (provider.testConnection, provider.fetchModels, provider.validateKey, secrets.listApiKeys) +1 T1b method (provider.validateCredentials) +1 T2 method (skills.addFromGitHub) +2 T4 methods (devBrowser.captureFrame, devBrowser.shutdown) +1 M6-A T4 method (task.getPendingRequest) = 138. Arithmetic matches.

## Summary per domain

Shim counts are per method entry; RPC counts are per DISTINCT backing RPC named in the domain (null backing rows are counted as `no-backing`, not in RPC buckets).

| Domain              | Entries | implemented | no-op | optional-absent | unavailable | allowlisted | registered-blocked | registered-blocklisted | unregistered | no-backing |
| ------------------- | ------: | ----------: | ----: | --------------: | ----------: | ----------: | -----------------: | ---------------------: | -----------: | ---------: |
| app-shell           |       9 |           6 |     3 |               0 |           0 |           0 |                  0 |                      0 |            0 |          9 |
| tasks               |      15 |          15 |     0 |               0 |           0 |           9 |                  0 |                      0 |            0 |          6 |
| session-permissions |       3 |           3 |     0 |               0 |           0 |           2 |                  0 |                      0 |            0 |          1 |
| settings            |      19 |          19 |     0 |               0 |           0 |          14 |                  0 |                      0 |            0 |          2 |
| provider-settings   |       9 |           9 |     0 |               0 |           0 |           7 |                  0 |                      0 |            0 |          1 |
| api-keys-secrets    |      15 |          12 |     0 |               0 |           3 |           6 |                  0 |                      2 |            0 |          0 |
| provider-configs    |      11 |          11 |     0 |               0 |           0 |          10 |                  0 |                      0 |            0 |          0 |
| model-discovery     |      17 |          15 |     0 |               0 |           2 |           3 |                  0 |                      0 |            0 |          2 |
| huggingface         |      10 |           0 |     1 |               0 |           9 |           0 |                  2 |                      0 |            0 |          8 |
| skills              |      12 |          10 |     0 |               0 |           2 |           9 |                  0 |                      0 |            0 |          3 |
| connectors          |      23 |           6 |     0 |               0 |          17 |           5 |                  0 |                      0 |            0 |         18 |
| gws                 |       8 |           0 |     0 |               0 |           8 |           0 |                  5 |                      0 |            0 |          2 |
| whatsapp            |       6 |           2 |     0 |               0 |           4 |           0 |                  4 |                      0 |            0 |          2 |
| speech              |       4 |           0 |     2 |               0 |           2 |           0 |                  0 |                      0 |            0 |          4 |
| file-attachments    |       4 |           3 |     0 |               0 |           1 |           0 |                  0 |                      0 |            0 |          4 |
| browser-preview     |       6 |           4 |     0 |               2 |           0 |           2 |                  0 |                      0 |            0 |          2 |
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
| **TOTAL**           |     250 |         142 |    45 |               3 |          60 |          91 |                 12 |                      2 |            0 |        116 |

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

Entries 15 — implemented 15 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 9 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 6

| Method                | Shim status | Backing RPC              | RPC policy status | Note                                                                                                                              |
| --------------------- | ----------- | ------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `startTask`           | implemented | `task.start`             | allowlisted       |                                                                                                                                   |
| `cancelTask`          | implemented | `task.cancel`            | allowlisted       |                                                                                                                                   |
| `interruptTask`       | implemented | `task.interrupt`         | allowlisted       |                                                                                                                                   |
| `getTask`             | implemented | `task.get`               | allowlisted       |                                                                                                                                   |
| `listTasks`           | implemented | `task.list`              | allowlisted       |                                                                                                                                   |
| `deleteTask`          | implemented | `task.delete`            | allowlisted       |                                                                                                                                   |
| `clearTaskHistory`    | implemented | `task.clearHistory`      | allowlisted       |                                                                                                                                   |
| `getPendingRequest?`  | implemented | `task.getPendingRequest` | allowlisted       | M6-A T4 pending-request restore read (§5.4-paired); the T3 restore path also rides the pendingRequest field on task.get/task.list |
| `getTodosForTask`     | implemented | `task.getTodos`          | allowlisted       |                                                                                                                                   |
| `onTaskUpdate`        | implemented | —                        | —                 | WS notifications task.complete + task.error                                                                                       |
| `onTaskUpdateBatch?`  | implemented | —                        | —                 | WS notification task.message                                                                                                      |
| `onTaskProgress`      | implemented | —                        | —                 | WS notification task.progress                                                                                                     |
| `onTaskStatusChange?` | implemented | —                        | —                 | WS notification task.statusChange                                                                                                 |
| `onTaskSummary?`      | implemented | —                        | —                 | WS notification task.summary                                                                                                      |
| `onTodoUpdate?`       | implemented | —                        | —                 | WS notification todo.update                                                                                                       |

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

Entries 9 — implemented 9 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 7 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 1

| Method                    | Shim status | Backing RPC                | RPC policy status | Note                                                                                         |
| ------------------------- | ----------- | -------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `getProviderSettings`     | implemented | `provider.getSettings`     | allowlisted       |                                                                                              |
| `setActiveProvider`       | implemented | `provider.setActive`       | allowlisted       |                                                                                              |
| `getConnectedProvider`    | implemented | `provider.getSettings`     | allowlisted       | derived — connected state rides the masked provider.getSettings payload (no direct read RPC) |
| `setConnectedProvider`    | implemented | `provider.setConnected`    | allowlisted       |                                                                                              |
| `removeConnectedProvider` | implemented | `provider.removeConnected` | allowlisted       |                                                                                              |
| `updateProviderModel`     | implemented | `provider.updateModel`     | allowlisted       |                                                                                              |
| `setProviderDebugMode`    | implemented | `provider.setDebugMode`    | allowlisted       |                                                                                              |
| `getProviderDebugMode`    | implemented | `provider.getDebugMode`    | allowlisted       |                                                                                              |
| `onAuthError?`            | implemented | —                          | —                 | WS notification auth.error                                                                   |

### api-keys-secrets

Entries 15 — implemented 12 · no-op 0 · optional-absent 0 · unavailable 3 ｜ RPC: allowlisted 6 · registered-blocked 0 · blocklisted 2 · unregistered 0 · no-backing 0

| Method                      | Shim status | Backing RPC                       | RPC policy status      | Note                                                                                                                                                                                                |
| --------------------------- | ----------- | --------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getApiKeys`                | implemented | `secrets.listApiKeys`             | allowlisted            | masked backing (M2 T1a RPC); shim wiring landed in T1b — existing-only entries with 4-char prefixes                                                                                                 |
| `addApiKey`                 | implemented | `secrets.storeApiKey`             | allowlisted            |                                                                                                                                                                                                     |
| `removeApiKey`              | implemented | `secrets.deleteApiKey`            | allowlisted            | T1b wired — shim-fabricated ids carry the bare provider id                                                                                                                                          |
| `hasApiKey`                 | implemented | `secrets.hasAnyApiKey`            | allowlisted            |                                                                                                                                                                                                     |
| `setApiKey`                 | implemented | `secrets.storeApiKey`             | allowlisted            | T1b wired — desktop api-key:set stores under the DEFAULT provider (anthropic)                                                                                                                       |
| `getApiKey`                 | unavailable | `secrets.getApiKey`               | registered-blocklisted | blocklisted — must STAY blocked (plaintext default-provider read; masked sibling is secrets.listApiKeys)                                                                                            |
| `validateApiKey`            | implemented | `provider.validateKey`            | allowlisted            | T1b wired — desktop api-key:validate targets the DEFAULT provider (anthropic)                                                                                                                       |
| `validateApiKeyForProvider` | implemented | `provider.validateKey`            | allowlisted            | T1b wired (desktop api-key:validate-provider parity)                                                                                                                                                |
| `clearApiKey`               | implemented | `secrets.deleteApiKey`            | allowlisted            | T1b wired — desktop api-key:clear deletes ONLY the default-provider key; secrets.clear stays blocked                                                                                                |
| `getAllApiKeys`             | implemented | `secrets.listApiKeys`             | allowlisted            | masked backing (M2 T1a RPC); shim wiring landed in T1b — record shape returned verbatim                                                                                                             |
| `hasAnyApiKey`              | implemented | `secrets.hasAnyApiKey`            | allowlisted            |                                                                                                                                                                                                     |
| `saveBedrockCredentials`    | implemented | `secrets.storeBedrockCredentials` | allowlisted            | T1b allowlisted — one-way void write; ApiKeyConfig label/prefix derive locally                                                                                                                      |
| `getBedrockCredentials`     | unavailable | `secrets.getBedrockCredentials`   | registered-blocklisted | blocklisted plaintext read — stays unavailable; no web UI call site (connect flows null-derive from the masked snapshot)                                                                            |
| `saveVertexCredentials`     | implemented | `secrets.storeApiKey`             | allowlisted            | T1b wired — vertex credentials ride the standard api-key bucket under 'vertex' (desktop vertex:save parity; the SecureStorageAPI vertex analog of storeBedrockCredentials IS storeApiKey('vertex')) |
| `getVertexCredentials`      | unavailable | `secrets.getApiKey`               | registered-blocklisted | would read the 'vertex' api-key bucket in plaintext — blocklist binding keeps it unavailable                                                                                                        |

### provider-configs

Entries 11 — implemented 11 · no-op 0 · optional-absent 0 · unavailable 0 ｜ RPC: allowlisted 10 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 0

| Method                   | Shim status | Backing RPC                      | RPC policy status | Note                                                                                                                                |
| ------------------------ | ----------- | -------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `getOpenAiBaseUrl`       | implemented | `settings.getOpenAiBaseUrl`      | allowlisted       |                                                                                                                                     |
| `setOpenAiBaseUrl`       | implemented | `settings.setOpenAiBaseUrl`      | allowlisted       |                                                                                                                                     |
| `getOllamaConfig`        | implemented | `settings.getOllamaConfig`       | allowlisted       |                                                                                                                                     |
| `setOllamaConfig`        | implemented | `settings.setOllamaConfig`       | allowlisted       |                                                                                                                                     |
| `getAzureFoundryConfig`  | implemented | `settings.getAzureFoundryConfig` | allowlisted       |                                                                                                                                     |
| `setAzureFoundryConfig`  | implemented | `settings.setAzureFoundryConfig` | allowlisted       |                                                                                                                                     |
| `saveAzureFoundryConfig` | implemented | `settings.setAzureFoundryConfig` | allowlisted       | composite (T1b): validate + optional secrets.storeApiKey("azure-foundry") + config write — desktop azure-foundry:save-config parity |
| `getLiteLLMConfig`       | implemented | `settings.getLiteLLMConfig`      | allowlisted       |                                                                                                                                     |
| `setLiteLLMConfig`       | implemented | `settings.setLiteLLMConfig`      | allowlisted       |                                                                                                                                     |
| `getLMStudioConfig`      | implemented | `settings.getLMStudioConfig`     | allowlisted       |                                                                                                                                     |
| `setLMStudioConfig`      | implemented | `settings.setLMStudioConfig`     | allowlisted       |                                                                                                                                     |

Config reads/writes land in T1b via the T1a settings.\* RPCs; saveAzureFoundryConfig is a composite (validate → optional secrets.storeApiKey → settings.setAzureFoundryConfig). Writes invalidate the shim settings-snapshot cache.

### model-discovery

Entries 17 — implemented 15 · no-op 0 · optional-absent 0 · unavailable 2 ｜ RPC: allowlisted 3 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 2

| Method                       | Shim status | Backing RPC                    | RPC policy status | Note                                                                                                               |
| ---------------------------- | ----------- | ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `testOllamaConnection`       | implemented | `provider.testConnection`      | allowlisted       | T1b wired                                                                                                          |
| `testAzureFoundryConnection` | implemented | `provider.testConnection`      | allowlisted       | T1b wired                                                                                                          |
| `fetchProviderModels`        | implemented | `provider.fetchModels`         | allowlisted       | T1b wired                                                                                                          |
| `fetchOpenRouterModels`      | implemented | `provider.fetchModels`         | allowlisted       | T1b wired                                                                                                          |
| `testLiteLLMConnection`      | implemented | `provider.testConnection`      | allowlisted       | T1b wired                                                                                                          |
| `fetchLiteLLMModels`         | implemented | `provider.fetchModels`         | allowlisted       | T1b wired                                                                                                          |
| `testLMStudioConnection`     | implemented | `provider.testConnection`      | allowlisted       | T1b wired                                                                                                          |
| `fetchLMStudioModels`        | implemented | `provider.fetchModels`         | allowlisted       | T1b wired                                                                                                          |
| `testNimConnection`          | implemented | `provider.testConnection`      | allowlisted       | T1b wired                                                                                                          |
| `fetchNimModels`             | implemented | `provider.fetchModels`         | allowlisted       | T1b wired                                                                                                          |
| `testCustomConnection`       | implemented | `provider.testConnection`      | allowlisted       | T1b wired                                                                                                          |
| `validateBedrockCredentials` | implemented | `provider.validateCredentials` | allowlisted       | T1b §A3 — document JSON travels one-way in the request; verdict + redacted error only                              |
| `fetchBedrockModels`         | implemented | `provider.fetchModels`         | allowlisted       | daemon-side stored credentials (T1b) — the credentials argument is accepted-but-ignored (connect flows save first) |
| `validateVertexCredentials`  | implemented | `provider.validateCredentials` | allowlisted       | T1b §A3 — document JSON travels one-way in the request; verdict + redacted error only                              |
| `fetchVertexModels`          | implemented | `provider.fetchModels`         | allowlisted       | daemon-side stored credentials (T1b) — the credentials argument is accepted-but-ignored (connect flows save first) |
| `detectVertexProject`        | unavailable | —                              | —                 | host-side gcloud flow — defer to M6                                                                                |
| `listVertexProjects`         | unavailable | —                              | —                 | host-side gcloud flow — defer to M6                                                                                |

T1b wires the per-provider test/fetch call sites onto provider.testConnection / provider.fetchModels; model fetches resolve keys daemon-side from stored secrets, so fetchBedrockModels/fetchVertexModels accept-but-ignore their credentials argument (the connect flows always save first). bedrock/vertex credential VALIDATION rides the §A3 provider.validateCredentials RPC (document one-way in, redacted verdict out). detectVertexProject/listVertexProjects keep their host-side gcloud flow (M6).

### huggingface

Entries 10 — implemented 0 · no-op 1 · optional-absent 0 · unavailable 9 ｜ RPC: allowlisted 0 · registered-blocked 2 · blocklisted 0 · unregistered 0 · no-backing 8

| Method                          | Shim status | Backing RPC                          | RPC policy status  | Note                                                                        |
| ------------------------------- | ----------- | ------------------------------------ | ------------------ | --------------------------------------------------------------------------- |
| `getHuggingFaceLocalConfig`     | unavailable | `provider.getHuggingFaceLocalConfig` | registered-blocked | registered-blocked — deferred to M6 (architect decision); stays unavailable |
| `setHuggingFaceLocalConfig`     | unavailable | `provider.setHuggingFaceLocalConfig` | registered-blocked | registered-blocked — deferred to M6 (architect decision); stays unavailable |
| `listHuggingFaceModels`         | unavailable | —                                    | —                  | HF local-server control port (plan M2/M6 seam)                              |
| `downloadHuggingFaceModel`      | unavailable | —                                    | —                  | HF local-server control port                                                |
| `startHuggingFaceServer`        | unavailable | —                                    | —                  | HF local-server control port                                                |
| `stopHuggingFaceServer`         | unavailable | —                                    | —                  | HF local-server control port                                                |
| `getHuggingFaceServerStatus`    | unavailable | —                                    | —                  | HF local-server control port                                                |
| `testHuggingFaceConnection`     | unavailable | —                                    | —                  | HF local-server control port                                                |
| `deleteHuggingFaceModel`        | unavailable | —                                    | —                  | HF local-server control port                                                |
| `onHuggingFaceDownloadProgress` | no-op       | —                                    | —                  | shim no-op subscription until HF ships                                      |

### skills

Entries 12 — implemented 10 · no-op 0 · optional-absent 0 · unavailable 2 ｜ RPC: allowlisted 9 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 3

| Method               | Shim status | Backing RPC                | RPC policy status | Note                                                                                                                                   |
| -------------------- | ----------- | -------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `getSkills`          | implemented | `skills.list`              | allowlisted       |                                                                                                                                        |
| `getEnabledSkills`   | implemented | `skills.listEnabled`       | allowlisted       |                                                                                                                                        |
| `setSkillEnabled`    | implemented | `skills.setEnabled`        | allowlisted       |                                                                                                                                        |
| `getSkillContent`    | implemented | `skills.getContent`        | allowlisted       |                                                                                                                                        |
| `getUserSkillsPath`  | implemented | `skills.getUserSkillsPath` | allowlisted       | T2 wired — registered + allowlisted pre-T2; the shim method now exists                                                                 |
| `pickSkillFolder`    | implemented | —                          | —                 | T2 wired — host /pick-folder reuse (same zenity folder dialog as workspace picking, v1)                                                |
| `addSkillFromFolder` | implemented | `skills.addFromPath`       | allowlisted       | T2 wired                                                                                                                               |
| `addSkillFromGitHub` | implemented | `skills.addFromGitHub`     | allowlisted       | T2 — new daemon RPC (§5.4-paired); URL normalization reuses agent-core addSkill → addFromUrl → resolveGithubRawUrl                     |
| `deleteSkill`        | implemented | `skills.delete`            | allowlisted       | T2 wired                                                                                                                               |
| `resyncSkills`       | implemented | `skills.resync`            | allowlisted       |                                                                                                                                        |
| `openSkillInEditor`  | unavailable | —                          | —                 | M2 documented degradation — Electron shell.openPath has no browser surface (M6 candidate); UI call sites try/catch and degrade         |
| `showSkillInFolder`  | unavailable | —                          | —                 | M2 documented degradation — Electron shell.showItemInFolder has no browser surface (M6 candidate); UI call sites try/catch and degrade |

### connectors

Entries 23 — implemented 6 · no-op 0 · optional-absent 0 · unavailable 17 ｜ RPC: allowlisted 5 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 18

| Method                          | Shim status | Backing RPC               | RPC policy status | Note                                                                                                                           |
| ------------------------------- | ----------- | ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `getOpenAiOauthStatus`          | unavailable | —                         | —                 | M6 — maps to auth.openai.status                                                                                                |
| `loginOpenAiWithChatGpt`        | unavailable | —                         | —                 | M6 — maps to auth.openai.startLogin + awaitCompletion                                                                          |
| `getSlackMcpOauthStatus`        | unavailable | —                         | —                 | M6                                                                                                                             |
| `loginSlackMcp`                 | unavailable | —                         | —                 | M6 — built-in connector login path                                                                                             |
| `logoutSlackMcp`                | unavailable | —                         | —                 | M6                                                                                                                             |
| `getCopilotOAuthStatus`         | unavailable | —                         | —                 | M6                                                                                                                             |
| `loginGithubCopilot`            | unavailable | —                         | —                 | M6                                                                                                                             |
| `logoutGithubCopilot`           | unavailable | —                         | —                 | M6                                                                                                                             |
| `getConnectors`                 | implemented | `connectors.list`         | allowlisted       | T2 wired                                                                                                                       |
| `addConnector`                  | implemented | `connectors.upsert`       | allowlisted       | T2 wired — shim builds the full McpConnector row client-side (desktop connectors:add parity)                                   |
| `deleteConnector`               | implemented | `connectors.delete`       | allowlisted       | T2 wired — pairs connectors.deleteTokens with the row delete (desktop connectors:delete parity)                                |
| `setConnectorEnabled`           | implemented | `connectors.setEnabled`   | allowlisted       | T2 wired                                                                                                                       |
| `startConnectorOAuth`           | unavailable | —                         | —                 | M6 oauth re-homing to host loopbacks                                                                                           |
| `completeConnectorOAuth`        | unavailable | —                         | —                 | M6 oauth re-homing to host loopbacks                                                                                           |
| `disconnectConnector`           | implemented | `connectors.deleteTokens` | allowlisted       | T2 wired — desktop parity: deleteTokens + connectors.setStatus(disconnected) (backing lists the token scrub; both allowlisted) |
| `onMcpAuthCallback?`            | implemented | —                         | —                 | WS control event mcp-callback (deep link)                                                                                      |
| `getBuiltInConnectorAuthStatus` | unavailable | —                         | —                 | M6 built-in connector token state                                                                                              |
| `loginBuiltInConnector`         | unavailable | —                         | —                 | M6 oauth re-homing to host loopbacks                                                                                           |
| `logoutBuiltInConnector`        | unavailable | —                         | —                 | M6                                                                                                                             |
| `lightdashGetServerUrl`         | unavailable | —                         | —                 | M6                                                                                                                             |
| `lightdashSetServerUrl`         | unavailable | —                         | —                 | M6                                                                                                                             |
| `datadogGetServerUrl`           | unavailable | —                         | —                 | M6                                                                                                                             |
| `datadogSetServerUrl`           | unavailable | —                         | —                 | M6                                                                                                                             |

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

Entries 4 — implemented 3 · no-op 0 · optional-absent 0 · unavailable 1 ｜ RPC: allowlisted 0 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 4

| Method                | Shim status | Backing RPC | RPC policy status | Note                                                                                                                                              |
| --------------------- | ----------- | ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pickFolder`          | implemented | —           | —                 | host /pick-folder (HTTP zenity)                                                                                                                   |
| `pickFiles`           | implemented | —           | —                 | host /pick-files (HTTP zenity; rows match FileAttachmentInfo 1:1)                                                                                 |
| `getFilePath`         | unavailable | —           | —                 | stays unavailable (loud Proxy throw) — must never pretend a browser File has a path; the T3 drop flow routes around it                            |
| `processDroppedFiles` | implemented | —           | —                 | T3 wired — re-opens the authorized host /pick-files flow (browser drops cannot reveal local paths, so the paths argument is ignored off-Electron) |

`pickFolder` also serves the skills picker. M2 T3 documents that browser-dropped `File` objects cannot reveal local paths: `processDroppedFiles` re-opens the authorized host `/pick-files` flow (the paths argument is unusable off-Electron) while `getFilePath` stays unavailable — the picker flow is the authorized path (plan §6 M2.3).

### browser-preview

Entries 6 — implemented 4 · no-op 0 · optional-absent 2 · unavailable 0 ｜ RPC: allowlisted 2 · registered-blocked 0 · blocklisted 0 · unregistered 0 · no-backing 2

| Method                     | Shim status     | Backing RPC                  | RPC policy status | Note                                                                                                     |
| -------------------------- | --------------- | ---------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `onBrowserFrame?`          | implemented     | `devBrowser.captureFrame`    | allowlisted       | T4 wired — shim-local emitter fanned out by the captureFrame poll (no WS notification)                   |
| `onBrowserNavigate?`       | optional-absent | —                            | —                 | v1 defer — no live screencast per migration plan §8.5                                                    |
| `onBrowserStatus?`         | optional-absent | —                            | —                 | v1 defer — no live screencast per migration plan §8.5                                                    |
| `startBrowserPreview?`     | implemented     | `devBrowser.openPreviewPage` | allowlisted       | T4 wired — ensures the page (lazy Chrome launch), then starts the shim-local captureFrame poll (~750 ms) |
| `stopBrowserPreview?`      | implemented     | `devBrowser.captureFrame`    | allowlisted       | T4 wired — clears the shim-local poll timer (frames stop; the poll state is captureFrame-driven)         |
| `getBrowserPreviewStatus?` | implemented     | `devBrowser.captureFrame`    | allowlisted       | T4 wired — { active } reflects the shim-local captureFrame poll timers                                   |

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

## Appendix C — allowlisted RPC methods with no shim mapping (7)

`health.check`, `task.stop`, `task.status`, `task.getActiveCount`, `settings.setNimConfig`, `workspace.get`, `devBrowser.shutdown`

## Appendix D — shim transport.call coverage (self-check)

All 89 distinct `transport.call` targets are allowlisted — verified at generation time.
