#!/usr/bin/env node
/**
 * parity-audit.mjs — static API-parity measurement for the Firefox migration.
 *
 * Phase 3 M2, task T0 (docs/PHASE_3_IMPLEMENTATION_PLAN.md §6): enumerate the
 * three API surfaces — AccomplishAPI (web), the HTTP-gateway shim
 * (accomplish-http.ts), and the daemon RPC registry cross-referenced with the
 * gateway authorization policy (policy.ts) — and produce docs/PARITY_INVENTORY.md.
 *
 * This is a MEASUREMENT tool: it must never gate, patch, or allowlist anything.
 *
 * ── Parsing contract (documented semantics) ────────────────────────────────
 *
 * 1. Declared surface = every entry on `AccomplishAPI`
 *    (apps/web/src/client/lib/accomplish.ts), counted as:
 *       204 top-level methods
 *     +   8 flattened `gws.*` sub-methods (from the GwsAPI interface)
 *     +  37 flattened `analytics.*` sub-methods (from the inline object)
 *     = 249 entries.
 *    Nesting is FLATTENED consistently: nested methods are entries named
 *    `ns.<method>`; the namespace properties themselves (`gws?: GwsAPI`,
 *    `analytics: {…}`) are type-level fields, not methods, and are NOT counted
 *    as entries. The shim's absence of the optional `gws` namespace is tracked
 *    by OPTIONAL_NOT_SUPPORTED (self-checked). This accounting reproduces the
 *    plan §2.2 figures 249/129/120 exactly — see "Reconciliation" below.
 *
 * 2. Shim status per entry (exactly one of):
 *      - implemented      : key of the shim `core` object whose value
 *                           references transport / call / events (or a local
 *                           function rooted in them) → real functionality.
 *      - no-op            : key of `core` whose value reference NONE of those
 *                           (resolves locally; loud set is listed in output).
 *                           `analytics.*` counts as no-op via the Proxy parent.
 *      - optional-absent  : declared optional `?` and listed in the shim's
 *                           OPTIONAL_NOT_SUPPORTED set (absence is the design;
 *                           UI guards skip these).
 *      - unavailable      : everything else — the Proxy throws
 *                           HttpShimNotSupportedError.
 *
 * 3. Daemon registry = every `registerMethod('name')` across
 *       apps/daemon/src/daemon-routes.ts        (132)
 *     + apps/daemon/src/index.ts                (1: daemon.shutdown)
 *     + builtin daemon.ping in agent-core's rpc-server.ts
 *     = 134 registered methods.
 *
 * 4. RPC policy status for a backing RPC (apps/host/src/policy.ts):
 *      - allowlisted            : in RPC_METHOD_ALLOWLIST.
 *      - registered-blocked     : registered, not allowlisted, not blocklisted.
 *      - registered-blocklisted : registered but in RPC_METHOD_BLOCKLIST
 *                                 (blocklist always wins; plaintext reads).
 *      - unregistered           : named RPC that no daemon registers (M2/M6
 *                                 must add it) — for null mappings see column
 *                                 "—" (`no-backing`).
 *
 * 5. SHIM_RPC_MAP maps shim method → backing daemon RPC, maintained BY HAND in
 *    later milestones. Pre-filled (T0) from accomplish-http.ts call sites plus
 *    the daemon-routes.ts surface; `null` = no backing known today (and, for
 *    event subscriptions / host HTTP endpoints, none is expected — the note
 *    says which). Derived/indirect mappings carry an explicit note.
 *    analytics.* entries are all kept explicitly (null — M6 batched endpoint).
 *
 * ── Reconciliation with plan §2.2 (verified by self-checks) ────────────────
 *   plan "129 implemented (7 no-op)" = 84 functional + 45 no-op, where the
 *     45 = 7 deliberate top-level no-ops + onHuggingFaceDownloadProgress (1)
 *         + 37 analytics.* flattened. T1b wires 42 more shim call sites
 *         (functional 84 → 126).
 *   plan "120 unavailable"        = 113 unavailable + 7 optional-absent
 *     (browser-preview 6 + onWorkspaceDeleted) at T1a time; T1b promotes 42
 *     entries to implemented (113 → 71). Plan's "GWS (8)" = the
 *     8 gws.* sub-methods (their shim path throws while the parent namespace
 *     is absent).
 *   plan "125 daemon methods"     = pre-M1 123 (daemon-routes.ts) + builtin
 *     daemon.shutdown (index.ts) + daemon.ping (rpc-server.ts); M1 adds 4
 *     internal methods (daemon.setClientType, daemon.setUiPresence,
 *     devBrowser.getPreviewInfo, devBrowser.openPreviewPage — deliberately NOT
 *     allowlisted); M2 T1a adds 4 (provider.testConnection, provider.fetchModels,
 *     provider.validateKey, secrets.listApiKeys); T1b adds 1
 *     (provider.validateCredentials); T2 adds 1 (skills.addFromGitHub).
 *     Allowlist: plan 62 → M2 T1a
 *     +21 (provider trio, 5 provider writes, 2 secrets, 11 provider configs)
 *     → T1b +2 (provider.validateCredentials, secrets.storeBedrockCredentials)
 *     → T2 +9 (skills.addFromPath/addFromGitHub/delete,
 *     connectors.list/upsert/setEnabled/setStatus/delete/deleteTokens).
 *     The T2 scrubber also grew SECRET_FIELD_NAMES by 'clientSecret'
 *     (DCR-issued OAuth client secret riding clientRegistration in
 *     connectors.list rows).
 *   M2 T3 wires file-attachment drops through the AUTHORIZED host picker:
 *     processDroppedFiles promotes to implemented via transport.pickFiles
 *     (host /pick-files — no new RPC, no allowlist delta), while
 *     getFilePath stays unavailable by design (browser File objects cannot
 *     reveal local paths; picker flow is the authorized path, plan §6 M2.3).
 *
 * ── Self-checks (exit 1 on failure) ────────────────────────────────────────
 *   - parse-unknown: any declared entry without a domain → loud failure.
 *   - stale map entries (renamed/removed methods) → failure.
 *   - totals reconcile (per-domain sums == grand totals; grand == declared).
 *   - sanity assertions (see SANITY_CHECKS).
 *   - shim transport.call targets ⊆ allowlist; allowlist ⊆ registered.
 *
 * Usage:  node apps/host/scripts/parity-audit.mjs           (writes + prints)
 * Env:    PARITY_AUDIT_DATE=YYYY-MM-DD                      (date stamp; else today)
 * Output: docs/PARITY_INVENTORY.md + summary on stdout.
 * Deterministic: pure text parsing, declaration order throughout, fixed domain order.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

const FILES = {
  api: 'apps/web/src/client/lib/accomplish.ts',
  shim: 'apps/web/src/client/lib/accomplish-http.ts',
  policy: 'apps/host/src/policy.ts',
  daemonRoutes: 'apps/daemon/src/daemon-routes.ts',
  daemonIndex: 'apps/daemon/src/index.ts',
  agentCoreRpc: 'packages/agent-core/src/daemon/rpc-server.ts',
};
const OUTPUT = 'docs/PARITY_INVENTORY.md';

// ── fail loudly ──────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`parity-audit: FAIL: ${message}`);
  process.exit(1);
}

function read(rel) {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (err) {
    fail(`cannot read ${rel}: ${err.message}`);
  }
}

// ── regex helpers ────────────────────────────────────────────────────────────

/** Extract the body of `export interface <name> { ... }` (up to "\n}" col 0). */
function interfaceBody(src, name) {
  const marker = `export interface ${name} {`;
  const start = src.indexOf(marker);
  if (start < 0) {
    fail(`parse-unknown: marker "${marker}" not found`);
  }
  const bodyStart = src.indexOf('{', start) + 1;
  const rest = src.slice(bodyStart);
  const close = rest.indexOf('\n}');
  if (close < 0) {
    fail(`parse-unknown: closing brace of interface ${name} not found`);
  }
  return rest.slice(0, close);
}

const METHOD_LINE = (indent) => new RegExp(`^ {${indent}}([A-Za-z_$][\\w$]*)(\\?)?\\(`, 'gm');

function parseMethods(body, indent) {
  return [...body.matchAll(METHOD_LINE(indent))].map((m) => ({
    name: m[1],
    optional: m[2] === '?',
  }));
}

// ── reference/no-op detection ────────────────────────────────────────────────

/** Local bindings whose use means the entry delegates to real transport or events. */
const LOCAL_REF_RE =
  /\btransport\b|\bcall\s*\(|\bevents\b|\bloadSettings\b|\binvalidateSettings\b|\bonSettingsChanged\b/;

// ── domain tables (hand-maintained; stale entries are self-checked) ─────────

const DOMAIN_ORDER = [
  'app-shell',
  'tasks',
  'session-permissions',
  'settings',
  'provider-settings',
  'api-keys-secrets',
  'provider-configs',
  'model-discovery',
  'huggingface',
  'skills',
  'connectors',
  'gws',
  'whatsapp',
  'speech',
  'file-attachments',
  'browser-preview',
  'daemon-control',
  'bug-report',
  'analytics',
  'scheduler',
  'workspace',
  'knowledge-notes',
  'favorites',
  'accomplish-ai',
  'build-capabilities',
  'onboarding',
  'opencode-cli',
];

/**
 * Top-level AccomplishAPI methods → domain. Every declared top-level method
 * MUST appear exactly once (self-checked; missing = parse-unknown failure).
 * Notes on edge assignments (fixed, documented here):
 *  - isE2EMode / close-dialog methods / daemon connection events → app-shell
 *    (shell-level UX; no dedicated E2E/close domain).
 *  - getSelectedModel/setSelectedModel → settings (backed by settings.*SelectedModel).
 *  - onAuthError → provider-settings (provider auth failures).
 *  - getOpenAiBaseUrl/setOpenAiBaseUrl → provider-configs (openai-baseurl family).
 *  - OpenAI / Slack-MCP / Copilot OAuth methods → connectors (OAuth login family).
 *  - validateApiKey/validateApiKeyForProvider → api-keys-secrets (key checks),
 *    while the validate- or fetch- or test- or detect- or list-style methods of Bedrock/Vertex/NIM/etc. →
 *    model-discovery (plan §6 "test/fetch/validate" family).
 *  - saveBedrockCredentials / getBedrockCredentials / saveVertexCredentials /
 *    getVertexCredentials → api-keys-secrets (secret writes/reads).
 *  - logEvent/onDebugLog/exportLogs → bug-report (diagnostics channel).
 */
const DOMAIN_METHODS = {
  'app-shell': [
    'getVersion',
    'getPlatform',
    'openExternal',
    'isE2EMode',
    'onCloseRequested',
    'respondToClose',
    'onDaemonDisconnected',
    'onDaemonReconnected',
    'onDaemonReconnectFailed',
  ],
  tasks: [
    'startTask',
    'cancelTask',
    'interruptTask',
    'getTask',
    'listTasks',
    'deleteTask',
    'clearTaskHistory',
    'getTodosForTask',
    'onTaskUpdate',
    'onTaskUpdateBatch',
    'onTaskProgress',
    'onTaskStatusChange',
    'onTaskSummary',
    'onTodoUpdate',
  ],
  'session-permissions': ['respondToPermission', 'resumeSession', 'onPermissionRequest'],
  settings: [
    'getNotificationsEnabled',
    'setNotificationsEnabled',
    'getDebugMode',
    'setDebugMode',
    'getTheme',
    'setTheme',
    'onThemeChange',
    'getLanguage',
    'setLanguage',
    'getAppSettings',
    'getCloudBrowserConfig',
    'setCloudBrowserConfig',
    'getCloseBehavior',
    'setCloseBehavior',
    'getSelectedModel',
    'setSelectedModel',
    'onDebugModeChange',
    'getSandboxConfig',
    'setSandboxConfig',
  ],
  'provider-settings': [
    'getProviderSettings',
    'setActiveProvider',
    'getConnectedProvider',
    'setConnectedProvider',
    'removeConnectedProvider',
    'updateProviderModel',
    'setProviderDebugMode',
    'getProviderDebugMode',
    'onAuthError',
  ],
  'api-keys-secrets': [
    'getApiKeys',
    'addApiKey',
    'removeApiKey',
    'hasApiKey',
    'setApiKey',
    'getApiKey',
    'validateApiKey',
    'validateApiKeyForProvider',
    'clearApiKey',
    'getAllApiKeys',
    'hasAnyApiKey',
    'saveBedrockCredentials',
    'getBedrockCredentials',
    'saveVertexCredentials',
    'getVertexCredentials',
  ],
  'provider-configs': [
    'getOpenAiBaseUrl',
    'setOpenAiBaseUrl',
    'getOllamaConfig',
    'setOllamaConfig',
    'getAzureFoundryConfig',
    'setAzureFoundryConfig',
    'saveAzureFoundryConfig',
    'getLiteLLMConfig',
    'setLiteLLMConfig',
    'getLMStudioConfig',
    'setLMStudioConfig',
  ],
  'model-discovery': [
    'testOllamaConnection',
    'testAzureFoundryConnection',
    'fetchProviderModels',
    'fetchOpenRouterModels',
    'testLiteLLMConnection',
    'fetchLiteLLMModels',
    'testLMStudioConnection',
    'fetchLMStudioModels',
    'testNimConnection',
    'fetchNimModels',
    'testCustomConnection',
    'validateBedrockCredentials',
    'fetchBedrockModels',
    'validateVertexCredentials',
    'fetchVertexModels',
    'detectVertexProject',
    'listVertexProjects',
  ],
  huggingface: [
    'getHuggingFaceLocalConfig',
    'setHuggingFaceLocalConfig',
    'listHuggingFaceModels',
    'downloadHuggingFaceModel',
    'startHuggingFaceServer',
    'stopHuggingFaceServer',
    'getHuggingFaceServerStatus',
    'testHuggingFaceConnection',
    'deleteHuggingFaceModel',
    'onHuggingFaceDownloadProgress',
  ],
  skills: [
    'getSkills',
    'getEnabledSkills',
    'setSkillEnabled',
    'getSkillContent',
    'getUserSkillsPath',
    'pickSkillFolder',
    'addSkillFromFolder',
    'addSkillFromGitHub',
    'deleteSkill',
    'resyncSkills',
    'openSkillInEditor',
    'showSkillInFolder',
  ],
  connectors: [
    'getConnectors',
    'addConnector',
    'deleteConnector',
    'setConnectorEnabled',
    'startConnectorOAuth',
    'completeConnectorOAuth',
    'disconnectConnector',
    'onMcpAuthCallback',
    'getBuiltInConnectorAuthStatus',
    'loginBuiltInConnector',
    'logoutBuiltInConnector',
    'lightdashGetServerUrl',
    'lightdashSetServerUrl',
    'datadogGetServerUrl',
    'datadogSetServerUrl',
    'getOpenAiOauthStatus',
    'loginOpenAiWithChatGpt',
    'getSlackMcpOauthStatus',
    'loginSlackMcp',
    'logoutSlackMcp',
    'getCopilotOAuthStatus',
    'loginGithubCopilot',
    'logoutGithubCopilot',
  ],
  whatsapp: [
    'getWhatsAppConfig',
    'connectWhatsApp',
    'disconnectWhatsApp',
    'setWhatsAppEnabled',
    'onWhatsAppQR',
    'onWhatsAppStatus',
  ],
  speech: ['speechIsConfigured', 'speechGetConfig', 'speechValidate', 'speechTranscribe'],
  'file-attachments': ['pickFolder', 'pickFiles', 'getFilePath', 'processDroppedFiles'],
  'browser-preview': [
    'onBrowserFrame',
    'onBrowserNavigate',
    'onBrowserStatus',
    'startBrowserPreview',
    'stopBrowserPreview',
    'getBrowserPreviewStatus',
  ],
  'daemon-control': [
    'getDaemonSocketPath',
    'daemonPing',
    'daemonRestart',
    'daemonStop',
    'daemonStart',
  ],
  'bug-report': [
    'logEvent',
    'exportLogs',
    'onDebugLog',
    'captureScreenshot',
    'captureAxtree',
    'generateBugReport',
  ],
  scheduler: [
    'listSchedules',
    'createSchedule',
    'deleteSchedule',
    'setScheduleEnabled',
    'isAutoStartEnabled',
  ],
  workspace: [
    'listWorkspaces',
    'getActiveWorkspaceId',
    'switchWorkspace',
    'createWorkspace',
    'updateWorkspace',
    'deleteWorkspace',
    'onWorkspaceChanged',
    'onWorkspaceDeleted',
  ],
  'knowledge-notes': [
    'listKnowledgeNotes',
    'createKnowledgeNote',
    'updateKnowledgeNote',
    'deleteKnowledgeNote',
  ],
  favorites: ['addFavorite', 'removeFavorite', 'listFavorites'],
  'accomplish-ai': [
    'accomplishAiConnect',
    'accomplishAiEnsureReady',
    'accomplishAiDisconnect',
    'accomplishAiGetUsage',
    'accomplishAiGetStatus',
    'onAccomplishAiUsageUpdate',
  ],
  'build-capabilities': ['getBuildCapabilities'],
  onboarding: ['getOnboardingComplete', 'setOnboardingComplete'],
  'opencode-cli': ['checkOpenCodeCli', 'getOpenCodeVersion'],
};

/** Per-domain footnotes (optional; rendered under each table). */
const DOMAIN_NOTES = {
  'file-attachments':
    '`pickFolder` also serves the skills picker. M2 T3 documents that browser-dropped `File` objects cannot reveal local paths: `processDroppedFiles` re-opens the authorized host `/pick-files` flow (the paths argument is unusable off-Electron) while `getFilePath` stays unavailable — the picker flow is the authorized path (plan §6 M2.3).',
  scheduler:
    '`isAutoStartEnabled` reads host systemd autostart over HTTP, not scheduler RPC; kept in scheduler as it feeds the same settings page.',
  connectors:
    'OpenAI (ChatGPT) / Slack-MCP / GitHub-Copilot OAuth methods are grouped here (built-in connector/OAuth login family); M6 re-homes their flows to host loopbacks.',
  'bug-report':
    '`capture*` are in-page captures (M6, no privilege); `logEvent` uses the host HTTP `/client-log`; `exportLogs`/`generateBugReport` use `logs.getTasksForBugReport` + host logs (M6).',
  'daemon-control':
    'Restart/Stop/Start are host-owned in M6 (restart-then-reconnect); `daemon.ping` is implemented+allowlisted today.',
  'provider-configs':
    'Config reads/writes land in T1b via the T1a settings.* RPCs; saveAzureFoundryConfig is a composite (validate → optional secrets.storeApiKey → settings.setAzureFoundryConfig). Writes invalidate the shim settings-snapshot cache.',
  'model-discovery':
    'T1b wires the per-provider test/fetch call sites onto provider.testConnection / provider.fetchModels; model fetches resolve keys daemon-side from stored secrets, so fetchBedrockModels/fetchVertexModels accept-but-ignore their credentials argument (the connect flows always save first). bedrock/vertex credential VALIDATION rides the §A3 provider.validateCredentials RPC (document one-way in, redacted verdict out). detectVertexProject/listVertexProjects keep their host-side gcloud flow (M6).',
  gws: '`gws` namespace is optional-absent; sub-methods are unreachable while the parent is absent.',
  analytics:
    'All analytics.* entries resolve through the shim no-op Proxy today; M6 adds a local batched JSONL endpoint.',
};

/**
 * SHIM_RPC_MAP — shim method → backing daemon RPC (hand-maintained; self-checked
 * against the declared surface). `null` = no backing (HTTP host endpoint, WS
 * notification, local constant, or a capability that must still be built — the
 * note distinguishes them).
 */
const SHIM_RPC_MAP = {
  // ── app-shell ──────────────────────────────────────────────────────────
  getVersion: { rpc: null, note: 'host /health (HTTP, not RPC)' },
  getPlatform: { rpc: null, note: 'host /health (HTTP, not RPC)' },
  openExternal: { rpc: null, note: 'host /open-external (HTTP)' },
  isE2EMode: { rpc: null, note: 'local constant (false over gateway)' },
  onCloseRequested: {
    rpc: null,
    note: 'no-op — browser close is always keep-daemon (daemon is systemd-managed)',
  },
  respondToClose: { rpc: null, note: 'no-op — pairs with onCloseRequested' },
  onDaemonDisconnected: { rpc: null, note: 'WS control event daemon:disconnected' },
  onDaemonReconnected: { rpc: null, note: 'WS control event daemon:reconnected' },
  onDaemonReconnectFailed: { rpc: null, note: 'WS control event daemon:reconnect-failed' },

  // ── tasks ──────────────────────────────────────────────────────────────
  startTask: { rpc: 'task.start' },
  cancelTask: { rpc: 'task.cancel' },
  interruptTask: { rpc: 'task.interrupt' },
  getTask: { rpc: 'task.get' },
  listTasks: { rpc: 'task.list' },
  deleteTask: { rpc: 'task.delete' },
  clearTaskHistory: { rpc: 'task.clearHistory' },
  getTodosForTask: { rpc: 'task.getTodos' },
  onTaskUpdate: { rpc: null, note: 'WS notifications task.complete + task.error' },
  onTaskUpdateBatch: { rpc: null, note: 'WS notification task.message' },
  onTaskProgress: { rpc: null, note: 'WS notification task.progress' },
  onTaskStatusChange: { rpc: null, note: 'WS notification task.statusChange' },
  onTaskSummary: { rpc: null, note: 'WS notification task.summary' },
  onTodoUpdate: { rpc: null, note: 'WS notification todo.update' },

  // ── session-permissions ────────────────────────────────────────────────
  respondToPermission: { rpc: 'permission.respond' },
  resumeSession: { rpc: 'session.resume' },
  onPermissionRequest: { rpc: null, note: 'WS notification permission.request' },

  // ── settings ───────────────────────────────────────────────────────────
  getNotificationsEnabled: { rpc: 'settings.getNotificationsEnabled' },
  setNotificationsEnabled: { rpc: 'settings.setNotificationsEnabled' },
  getDebugMode: {
    rpc: 'settings.getAll',
    note: 'derived — debugMode rides the settings.getAll snapshot',
  },
  setDebugMode: { rpc: 'settings.setDebugMode' },
  getTheme: { rpc: 'settings.getAll', note: 'derived — theme rides the settings.getAll snapshot' },
  setTheme: { rpc: 'settings.setTheme' },
  onThemeChange: { rpc: null, note: 'WS notification settings.changed (theme key)' },
  getLanguage: { rpc: 'settings.getAll', note: 'derived' },
  setLanguage: { rpc: 'settings.setLanguage' },
  getAppSettings: { rpc: 'settings.getAll', note: 'derived snapshot' },
  getCloudBrowserConfig: { rpc: 'settings.getCloudBrowserConfig' },
  setCloudBrowserConfig: { rpc: 'settings.setCloudBrowserConfig' },
  getCloseBehavior: { rpc: 'settings.getCloseBehavior' },
  setCloseBehavior: { rpc: 'settings.setCloseBehavior' },
  getSelectedModel: { rpc: 'settings.getSelectedModel' },
  setSelectedModel: { rpc: 'settings.setSelectedModel' },
  onDebugModeChange: { rpc: null, note: 'WS notification settings.changed (debugMode key)' },
  getSandboxConfig: { rpc: 'settings.getSandboxConfig' },
  setSandboxConfig: { rpc: 'settings.setSandboxConfig' },

  // ── provider-settings ──────────────────────────────────────────────────
  getProviderSettings: { rpc: 'provider.getSettings' },
  setActiveProvider: { rpc: 'provider.setActive' },
  getConnectedProvider: {
    rpc: 'provider.getSettings',
    note: 'derived — connected state rides the masked provider.getSettings payload (no direct read RPC)',
  },
  setConnectedProvider: { rpc: 'provider.setConnected' },
  removeConnectedProvider: { rpc: 'provider.removeConnected' },
  updateProviderModel: { rpc: 'provider.updateModel' },
  setProviderDebugMode: { rpc: 'provider.setDebugMode' },
  getProviderDebugMode: { rpc: 'provider.getDebugMode' },
  onAuthError: { rpc: null, note: 'WS notification auth.error' },

  // ── api-keys-secrets ───────────────────────────────────────────────────
  getApiKeys: {
    rpc: 'secrets.listApiKeys',
    note: 'masked backing (M2 T1a RPC); shim wiring landed in T1b — existing-only entries with 4-char prefixes',
  },
  addApiKey: { rpc: 'secrets.storeApiKey' },
  removeApiKey: {
    rpc: 'secrets.deleteApiKey',
    note: 'T1b wired — shim-fabricated ids carry the bare provider id',
  },
  hasApiKey: { rpc: 'secrets.hasAnyApiKey' },
  setApiKey: {
    rpc: 'secrets.storeApiKey',
    note: 'T1b wired — desktop api-key:set stores under the DEFAULT provider (anthropic)',
  },
  getApiKey: {
    rpc: 'secrets.getApiKey',
    note: 'blocklisted — must STAY blocked (plaintext default-provider read; masked sibling is secrets.listApiKeys)',
  },
  validateApiKey: {
    rpc: 'provider.validateKey',
    note: 'T1b wired — desktop api-key:validate targets the DEFAULT provider (anthropic)',
  },
  validateApiKeyForProvider: {
    rpc: 'provider.validateKey',
    note: 'T1b wired (desktop api-key:validate-provider parity)',
  },
  clearApiKey: {
    rpc: 'secrets.deleteApiKey',
    note: 'T1b wired — desktop api-key:clear deletes ONLY the default-provider key; secrets.clear stays blocked',
  },
  getAllApiKeys: {
    rpc: 'secrets.listApiKeys',
    note: 'masked backing (M2 T1a RPC); shim wiring landed in T1b — record shape returned verbatim',
  },
  hasAnyApiKey: { rpc: 'secrets.hasAnyApiKey' },
  saveBedrockCredentials: {
    rpc: 'secrets.storeBedrockCredentials',
    note: 'T1b allowlisted — one-way void write; ApiKeyConfig label/prefix derive locally',
  },
  getBedrockCredentials: {
    rpc: 'secrets.getBedrockCredentials',
    note: 'blocklisted plaintext read — stays unavailable; no web UI call site (connect flows null-derive from the masked snapshot)',
  },
  saveVertexCredentials: {
    rpc: 'secrets.storeApiKey',
    note: "T1b wired — vertex credentials ride the standard api-key bucket under 'vertex' (desktop vertex:save parity; the SecureStorageAPI vertex analog of storeBedrockCredentials IS storeApiKey('vertex'))",
  },
  getVertexCredentials: {
    rpc: 'secrets.getApiKey',
    note: "would read the 'vertex' api-key bucket in plaintext — blocklist binding keeps it unavailable",
  },

  // ── provider-configs ───────────────────────────────────────────────────
  getOpenAiBaseUrl: { rpc: 'settings.getOpenAiBaseUrl' },
  setOpenAiBaseUrl: { rpc: 'settings.setOpenAiBaseUrl' },
  getOllamaConfig: { rpc: 'settings.getOllamaConfig' },
  setOllamaConfig: { rpc: 'settings.setOllamaConfig' },
  getAzureFoundryConfig: { rpc: 'settings.getAzureFoundryConfig' },
  setAzureFoundryConfig: { rpc: 'settings.setAzureFoundryConfig' },
  saveAzureFoundryConfig: {
    rpc: 'settings.setAzureFoundryConfig',
    note: 'composite (T1b): validate + optional secrets.storeApiKey("azure-foundry") + config write — desktop azure-foundry:save-config parity',
  },
  getLiteLLMConfig: { rpc: 'settings.getLiteLLMConfig' },
  setLiteLLMConfig: { rpc: 'settings.setLiteLLMConfig' },
  getLMStudioConfig: { rpc: 'settings.getLMStudioConfig' },
  setLMStudioConfig: { rpc: 'settings.setLMStudioConfig' },

  // ── model-discovery (M2 T1b: shim call sites wired onto the T1a routes) ──
  testOllamaConnection: { rpc: 'provider.testConnection', note: 'T1b wired' },
  testAzureFoundryConnection: { rpc: 'provider.testConnection', note: 'T1b wired' },
  fetchProviderModels: { rpc: 'provider.fetchModels', note: 'T1b wired' },
  fetchOpenRouterModels: { rpc: 'provider.fetchModels', note: 'T1b wired' },
  testLiteLLMConnection: { rpc: 'provider.testConnection', note: 'T1b wired' },
  fetchLiteLLMModels: { rpc: 'provider.fetchModels', note: 'T1b wired' },
  testLMStudioConnection: { rpc: 'provider.testConnection', note: 'T1b wired' },
  fetchLMStudioModels: { rpc: 'provider.fetchModels', note: 'T1b wired' },
  testNimConnection: { rpc: 'provider.testConnection', note: 'T1b wired' },
  fetchNimModels: { rpc: 'provider.fetchModels', note: 'T1b wired' },
  testCustomConnection: { rpc: 'provider.testConnection', note: 'T1b wired' },
  validateBedrockCredentials: {
    rpc: 'provider.validateCredentials',
    note: 'T1b §A3 — document JSON travels one-way in the request; verdict + redacted error only',
  },
  fetchBedrockModels: {
    rpc: 'provider.fetchModels',
    note: 'daemon-side stored credentials (T1b) — the credentials argument is accepted-but-ignored (connect flows save first)',
  },
  validateVertexCredentials: {
    rpc: 'provider.validateCredentials',
    note: 'T1b §A3 — document JSON travels one-way in the request; verdict + redacted error only',
  },
  fetchVertexModels: {
    rpc: 'provider.fetchModels',
    note: 'daemon-side stored credentials (T1b) — the credentials argument is accepted-but-ignored (connect flows save first)',
  },
  detectVertexProject: { rpc: null, note: 'host-side gcloud flow — defer to M6' },
  listVertexProjects: { rpc: null, note: 'host-side gcloud flow — defer to M6' },

  // ── huggingface ────────────────────────────────────────────────────────
  getHuggingFaceLocalConfig: {
    rpc: 'provider.getHuggingFaceLocalConfig',
    note: 'registered-blocked — deferred to M6 (architect decision); stays unavailable',
  },
  setHuggingFaceLocalConfig: {
    rpc: 'provider.setHuggingFaceLocalConfig',
    note: 'registered-blocked — deferred to M6 (architect decision); stays unavailable',
  },
  listHuggingFaceModels: { rpc: null, note: 'HF local-server control port (plan M2/M6 seam)' },
  downloadHuggingFaceModel: { rpc: null, note: 'HF local-server control port' },
  startHuggingFaceServer: { rpc: null, note: 'HF local-server control port' },
  stopHuggingFaceServer: { rpc: null, note: 'HF local-server control port' },
  getHuggingFaceServerStatus: { rpc: null, note: 'HF local-server control port' },
  testHuggingFaceConnection: { rpc: null, note: 'HF local-server control port' },
  deleteHuggingFaceModel: { rpc: null, note: 'HF local-server control port' },
  onHuggingFaceDownloadProgress: { rpc: null, note: 'shim no-op subscription until HF ships' },

  // ── skills (M2 T2: shim CRUD call sites wired) ──────────────────────────
  getSkills: { rpc: 'skills.list' },
  getEnabledSkills: { rpc: 'skills.listEnabled' },
  setSkillEnabled: { rpc: 'skills.setEnabled' },
  getSkillContent: { rpc: 'skills.getContent' },
  getUserSkillsPath: {
    rpc: 'skills.getUserSkillsPath',
    note: 'T2 wired — registered + allowlisted pre-T2; the shim method now exists',
  },
  pickSkillFolder: {
    rpc: null,
    note: 'T2 wired — host /pick-folder reuse (same zenity folder dialog as workspace picking, v1)',
  },
  addSkillFromFolder: { rpc: 'skills.addFromPath', note: 'T2 wired' },
  addSkillFromGitHub: {
    rpc: 'skills.addFromGitHub',
    note: 'T2 — new daemon RPC (§5.4-paired); URL normalization reuses agent-core addSkill → addFromUrl → resolveGithubRawUrl',
  },
  deleteSkill: { rpc: 'skills.delete', note: 'T2 wired' },
  resyncSkills: { rpc: 'skills.resync' },
  openSkillInEditor: {
    rpc: null,
    note: 'M2 documented degradation — Electron shell.openPath has no browser surface (M6 candidate); UI call sites try/catch and degrade',
  },
  showSkillInFolder: {
    rpc: null,
    note: 'M2 documented degradation — Electron shell.showItemInFolder has no browser surface (M6 candidate); UI call sites try/catch and degrade',
  },

  // ── connectors (M2 T2: custom-connector CRUD wired; OAuth family M6) ──
  getConnectors: { rpc: 'connectors.list', note: 'T2 wired' },
  addConnector: {
    rpc: 'connectors.upsert',
    note: 'T2 wired — shim builds the full McpConnector row client-side (desktop connectors:add parity)',
  },
  deleteConnector: {
    rpc: 'connectors.delete',
    note: 'T2 wired — pairs connectors.deleteTokens with the row delete (desktop connectors:delete parity)',
  },
  setConnectorEnabled: { rpc: 'connectors.setEnabled', note: 'T2 wired' },
  startConnectorOAuth: { rpc: null, note: 'M6 oauth re-homing to host loopbacks' },
  completeConnectorOAuth: { rpc: null, note: 'M6 oauth re-homing to host loopbacks' },
  disconnectConnector: {
    rpc: 'connectors.deleteTokens',
    note: 'T2 wired — desktop parity: deleteTokens + connectors.setStatus(disconnected) (backing lists the token scrub; both allowlisted)',
  },
  onMcpAuthCallback: { rpc: null, note: 'WS control event mcp-callback (deep link)' },
  getBuiltInConnectorAuthStatus: { rpc: null, note: 'M6 built-in connector token state' },
  loginBuiltInConnector: { rpc: null, note: 'M6 oauth re-homing to host loopbacks' },
  logoutBuiltInConnector: { rpc: null, note: 'M6' },
  lightdashGetServerUrl: { rpc: null, note: 'M6' },
  lightdashSetServerUrl: { rpc: null, note: 'M6' },
  datadogGetServerUrl: { rpc: null, note: 'M6' },
  datadogSetServerUrl: { rpc: null, note: 'M6' },
  getOpenAiOauthStatus: { rpc: null, note: 'M6 — maps to auth.openai.status' },
  loginOpenAiWithChatGpt: {
    rpc: null,
    note: 'M6 — maps to auth.openai.startLogin + awaitCompletion',
  },
  getSlackMcpOauthStatus: { rpc: null, note: 'M6' },
  loginSlackMcp: { rpc: null, note: 'M6 — built-in connector login path' },
  logoutSlackMcp: { rpc: null, note: 'M6' },
  getCopilotOAuthStatus: { rpc: null, note: 'M6' },
  loginGithubCopilot: { rpc: null, note: 'M6' },
  logoutGithubCopilot: { rpc: null, note: 'M6' },

  // ── gws ────────────────────────────────────────────────────────────────
  // (`gws` itself is the optional namespace property — absent in the shim via
  // OPTIONAL_NOT_SUPPORTED; not counted as a declared method entry.)
  'gws.listAccounts': { rpc: 'gwsAccount.list' },
  'gws.startAuth': {
    rpc: 'gwsAccount.add',
    note: 'probable — M6 to confirm (startAuth creates pending account)',
  },
  'gws.completeAuth': { rpc: 'gwsAccount.updateToken', note: 'probable — M6 to confirm' },
  'gws.removeAccount': { rpc: 'gwsAccount.remove' },
  'gws.updateLabel': { rpc: 'gwsAccount.updateLabel' },
  'gws.onStatusChanged': { rpc: null, note: 'WS notification status.changed (GWS)' },
  'gws.onAuthError': { rpc: null, note: 'WS notification auth error (GWS)' },
  'gws.cancelAuth': {
    rpc: 'gwsAccount.remove',
    note: 'probable — M6 to confirm (cancelAuth cleans pending auth)',
  },

  // ── whatsapp ───────────────────────────────────────────────────────────
  getWhatsAppConfig: { rpc: 'whatsapp.getConfig' },
  connectWhatsApp: { rpc: 'whatsapp.connect' },
  disconnectWhatsApp: { rpc: 'whatsapp.disconnect' },
  setWhatsAppEnabled: { rpc: 'whatsapp.setEnabled' },
  onWhatsAppQR: { rpc: null, note: 'WS notification whatsapp.qr' },
  onWhatsAppStatus: { rpc: null, note: 'WS notification whatsapp.status' },

  // ── speech ─────────────────────────────────────────────────────────────
  speechIsConfigured: {
    rpc: null,
    note: 'shim no-op — M6 feature-flagged OFF with friendly degradation',
  },
  speechGetConfig: { rpc: null, note: 'shim no-op — M6 feature-flagged OFF' },
  speechValidate: { rpc: null, note: 'M6 — feature-flagged OFF, graceful degradation' },
  speechTranscribe: { rpc: null, note: 'M6 — feature-flagged OFF, graceful degradation' },

  // ── file-attachments (M2 T3: drop flow routed through the picker) ──────
  pickFolder: { rpc: null, note: 'host /pick-folder (HTTP zenity)' },
  pickFiles: {
    rpc: null,
    note: 'host /pick-files (HTTP zenity; rows match FileAttachmentInfo 1:1)',
  },
  getFilePath: {
    rpc: null,
    note: 'stays unavailable (loud Proxy throw) — must never pretend a browser File has a path; the T3 drop flow routes around it',
  },
  processDroppedFiles: {
    rpc: null,
    note: 'T3 wired — re-opens the authorized host /pick-files flow (browser drops cannot reveal local paths, so the paths argument is ignored off-Electron)',
  },

  // ── browser-preview ────────────────────────────────────────────────────
  onBrowserFrame: { rpc: null, note: 'M2 on-demand screenshot v1 (dev-browser bridge)' },
  onBrowserNavigate: { rpc: null, note: 'M2 — no live screencast per migration plan §8.5' },
  onBrowserStatus: { rpc: null, note: 'M2 on-demand screenshot v1' },
  startBrowserPreview: {
    rpc: null,
    note: 'M2 on-demand screenshot v1 — new daemon methods as needed',
  },
  stopBrowserPreview: { rpc: null, note: 'M2 on-demand screenshot v1' },
  getBrowserPreviewStatus: { rpc: null, note: 'M2 on-demand screenshot v1' },

  // ── daemon-control ─────────────────────────────────────────────────────
  getDaemonSocketPath: { rpc: null, note: 'M6 — host-owned (socket path stays loopback-internal)' },
  daemonPing: { rpc: 'daemon.ping' },
  daemonRestart: {
    rpc: null,
    note: 'M6 — host-owned restart-then-reconnect (backoff exists in daemon-connector)',
  },
  daemonStop: { rpc: 'daemon.shutdown', note: 'probable mapping; M6 to confirm semantics' },
  daemonStart: { rpc: null, note: 'M6 — host-owned systemd start' },

  // ── bug-report ─────────────────────────────────────────────────────────
  logEvent: { rpc: null, note: 'host /client-log (HTTP, sanitized)' },
  exportLogs: { rpc: 'logs.getTasksForBugReport', note: 'M6 — combined with host-side logs' },
  onDebugLog: { rpc: null, note: 'shim no-op — no daemon-side source' },
  captureScreenshot: { rpc: null, note: 'M6 in-page capture (no privilege needed)' },
  captureAxtree: { rpc: null, note: 'M6 in-page capture (no privilege needed)' },
  generateBugReport: { rpc: 'logs.getTasksForBugReport', note: 'M6 — packaged with host logs' },

  // ── scheduler ──────────────────────────────────────────────────────────
  listSchedules: { rpc: 'task.listScheduled' },
  createSchedule: { rpc: 'task.schedule' },
  deleteSchedule: { rpc: 'task.cancelScheduled' },
  setScheduleEnabled: { rpc: 'task.setScheduleEnabled' },
  isAutoStartEnabled: { rpc: null, note: 'host /autostart-status (HTTP)' },

  // ── workspace ──────────────────────────────────────────────────────────
  listWorkspaces: { rpc: 'workspace.list' },
  getActiveWorkspaceId: { rpc: 'workspace.getActive' },
  switchWorkspace: { rpc: 'workspace.setActive' },
  createWorkspace: { rpc: 'workspace.create' },
  updateWorkspace: { rpc: 'workspace.update' },
  deleteWorkspace: { rpc: 'workspace.delete' },
  onWorkspaceChanged: { rpc: null, note: 'WS notification workspace.changed' },
  onWorkspaceDeleted: { rpc: null, note: 'optional-absent — no shim subscription' },

  // ── knowledge-notes ────────────────────────────────────────────────────
  listKnowledgeNotes: { rpc: 'knowledgeNote.list' },
  createKnowledgeNote: { rpc: 'knowledgeNote.create' },
  updateKnowledgeNote: { rpc: 'knowledgeNote.update' },
  deleteKnowledgeNote: { rpc: 'knowledgeNote.delete' },

  // ── favorites ──────────────────────────────────────────────────────────
  addFavorite: { rpc: 'favorites.add' },
  removeFavorite: { rpc: 'favorites.remove' },
  listFavorites: { rpc: 'favorites.list' },

  // ── accomplish-ai ──────────────────────────────────────────────────────
  accomplishAiConnect: { rpc: 'accomplish-ai.connect' },
  accomplishAiEnsureReady: { rpc: 'accomplish-ai.connect', note: 'derived — connect-if-needed' },
  accomplishAiDisconnect: { rpc: 'accomplish-ai.disconnect' },
  accomplishAiGetUsage: { rpc: 'accomplish-ai.get-usage' },
  accomplishAiGetStatus: {
    rpc: null,
    note: 'no status RPC registered (connect result carries state)',
  },
  onAccomplishAiUsageUpdate: { rpc: null, note: 'WS notification accomplish-ai.usage-update' },

  // ── build-capabilities ─────────────────────────────────────────────────
  getBuildCapabilities: {
    rpc: null,
    note: 'local constant — OSS build: no free mode, no analytics',
  },

  // ── onboarding ─────────────────────────────────────────────────────────
  getOnboardingComplete: {
    rpc: 'settings.getAll',
    note: 'derived — rides the settings.getAll snapshot',
  },
  setOnboardingComplete: { rpc: 'settings.setOnboardingComplete' },

  // ── opencode-cli ───────────────────────────────────────────────────────
  checkOpenCodeCli: { rpc: null, note: 'host /cli-status (HTTP)' },
  getOpenCodeVersion: { rpc: null, note: 'host /cli-status (HTTP)' },

  // ── analytics.* ────────────────────────────────────────────────────────
  'analytics.track': { rpc: null, note: 'M6 — local batched JSONL endpoint (plan §6 M6/§9)' },
  'analytics.trackPageView': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackSubmitTask': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackNewTask': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackOpenSettings': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackSaveApiKey': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackSelectProvider': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackSelectModel': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackToggleDebugMode': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackTaskStart': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackTaskComplete': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackTaskError': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackPermissionRequested': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackPermissionResponse': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackToolUsed': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackUserInteraction': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackAppClose': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackAppBackgrounded': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackAppForegrounded': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackModelSelectionStep': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackModelSelectionComplete': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackModelSelectionAbandoned': {
    rpc: null,
    note: 'M6 — local batched JSONL endpoint',
  },
  'analytics.trackHistoryViewed': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackTaskFromHistory': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackHistoryCleared': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackTaskDetailsExpanded': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackOutputCopied': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackProviderDisconnected': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackHelpLinkClicked': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackSaveVoiceApiKey': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackSkillAction': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackExportLogs': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackThreadExported': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackTaskLauncherAction': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackTaskFeedback': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackStopAgent': { rpc: null, note: 'M6 — local batched JSONL endpoint' },
  'analytics.trackProviderBoxClicked': { rpc: null, note: 'M6 — local batched JSONL endpoint' },

  // ── shim-extras (implemented but NOT declared on AccomplishAPI) ────────
  isFavorite: {
    rpc: 'favorites.isFavorite',
    note: 'shim-extra: implemented in shim + Electron preload, not declared on AccomplishAPI',
  },
  onSettingsChangedExternal: {
    rpc: null,
    note: 'shim-extra: WS notification settings.changed relay, not declared on AccomplishAPI',
  },
};

// ── source parsing ───────────────────────────────────────────────────────────

function collect() {
  const apiSrc = read(FILES.api);
  const shimSrc = read(FILES.shim);
  const policySrc = read(FILES.policy);
  const routesSrc = read(FILES.daemonRoutes);
  const indexSrc = read(FILES.daemonIndex);
  const agentCoreSrc = read(FILES.agentCoreRpc);

  // AccomplishAPI interface body
  const iface = interfaceBody(apiSrc, 'AccomplishAPI');

  // — analytics inline object —
  const analyticsOpen = /^  analytics: \{$/m.exec(iface);
  if (!analyticsOpen) {
    fail('parse-unknown: inline `analytics: {` not found on AccomplishAPI');
  }
  const analyticsTail = iface.slice(analyticsOpen.index + analyticsOpen[0].length);
  const analyticsClose = /^  \};$/m.exec(analyticsTail);
  if (!analyticsClose) {
    fail('parse-unknown: closing `  };` of the analytics object not found');
  }
  const analyticsBody = analyticsTail.slice(0, analyticsClose.index);

  // — top-level methods (analytics block excluded — it lives inside the body,
  //    but its sub-members are 4-space-indented so they never match anyway;
  //    we still slice the body apart to keep the ns property detection clean) —
  const topLevel = parseMethods(iface, 2).filter((m) => {
    // exclude the analytics member itself: it is `analytics: {`, not a method
    return !(m.name === 'analytics');
  });

  // — namespace entries —
  const gwsOpen = /^  gws(\?)?:\s*GwsAPI;$/m.exec(iface);
  if (!gwsOpen) {
    fail('parse-unknown: `gws?: GwsAPI` namespace entry not found');
  }
  const gwsSubs = parseMethods(interfaceBody(apiSrc, 'GwsAPI'), 2);

  // Shim core object
  const coreMarker = 'const core: Record<string, unknown> = {';
  const coreStart = shimSrc.indexOf(coreMarker);
  if (coreStart < 0) {
    fail('parse-unknown: shim core object marker not found');
  }
  const coreTailStart = shimSrc.indexOf('{', coreStart) + 1;
  const coreTail = shimSrc.slice(coreTailStart);
  const coreClose = coreTail.indexOf('\n  };');
  if (coreClose < 0) {
    fail('parse-unknown: closing `  };` of shim core object not found');
  }
  const coreBody = coreTail.slice(0, coreClose + 1);

  const keyMatches = [...coreBody.matchAll(/^    ([A-Za-z_$][\w$]*):/gm)];
  if (keyMatches.length === 0) {
    fail('parse-unknown: no core object keys parsed');
  }
  const noopKeys = [];
  const refKeys = [];
  for (let i = 0; i < keyMatches.length; i++) {
    const valueStart = keyMatches[i].index + keyMatches[i][0].length;
    const valueEnd = i + 1 < keyMatches.length ? keyMatches[i + 1].index : coreBody.length;
    const valueText = coreBody.slice(valueStart, valueEnd).replace(/^[ \t]*\/\/.*$/gm, '');
    (LOCAL_REF_RE.test(valueText) ? refKeys : noopKeys).push(keyMatches[i][1]);
  }
  const coreKeys = keyMatches.map((m) => m[1]);
  const coreSet = new Set(coreKeys);
  const noopSet = new Set(noopKeys);

  // OPTIONAL_NOT_SUPPORTED
  const onsMatch = shimSrc.match(/const OPTIONAL_NOT_SUPPORTED = new Set\(\[([\s\S]*?)\]\)/);
  if (!onsMatch) {
    fail('parse-unknown: OPTIONAL_NOT_SUPPORTED set not found');
  }
  const optionalNotSupported = [...onsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  // Policy sets
  const allowMatch = policySrc.match(/RPC_METHOD_ALLOWLIST: readonly string\[\] = \[([\s\S]*?)\];/);
  const blockMatch = policySrc.match(/RPC_METHOD_BLOCKLIST: readonly string\[\] = \[([\s\S]*?)\];/);
  if (!allowMatch || !blockMatch) {
    fail('parse-unknown: allowlist/blocklist arrays not found in policy.ts');
  }
  const allowlist = [...allowMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const blocklist = [...blockMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  // Daemon registry (routes + index + agent-core builtin)
  const registered = new Map(); // name → [source labels]
  const addRegistered = (name, source) => {
    const list = registered.get(name) ?? [];
    list.push(source);
    registered.set(name, list);
  };
  const REGISTER_RE = /registerMethod\(\s*'([A-Za-z0-9._-]+)'/g;
  for (const m of routesSrc.matchAll(REGISTER_RE)) {
    addRegistered(m[1], 'daemon-routes.ts');
  }
  for (const m of indexSrc.matchAll(REGISTER_RE)) {
    addRegistered(m[1], 'daemon/index.ts');
  }
  for (const m of agentCoreSrc.matchAll(/this\.registerMethod\(\s*'([A-Za-z0-9._-]+)'/g)) {
    addRegistered(m[1], 'agent-core rpc-server (builtin)');
  }

  // Shim-side transport.call targets + WS notification/control subscriptions
  const shimCallTargets = [...shimSrc.matchAll(/\bcall\(\s*'([A-Za-z0-9._-]+)'/g)].map((m) => m[1]);
  const shimNotifications = [
    ...new Set([...shimSrc.matchAll(/onNotification\('([^']+)'/g)].map((m) => m[1])),
  ];
  const shimControlEvents = [
    ...new Set([...shimSrc.matchAll(/onControlEvent\('([^']+)'/g)].map((m) => m[1])),
  ];

  return {
    topLevel,
    gwsNs: { optional: gwsOpen[1] === '?', subs: gwsSubs },
    analyticsBody,
    coreKeys,
    coreSet,
    noopSet,
    optionalNotSupported,
    allowlist,
    blocklist,
    registered,
    shimCallTargets,
    shimNotifications,
    shimControlEvents,
  };
}

// ── classification ───────────────────────────────────────────────────────────

function classify(parsed) {
  const {
    topLevel,
    gwsNs,
    coreKeys,
    coreSet,
    noopSet,
    optionalNotSupported,
    allowlist,
    blocklist,
    registered,
  } = parsed;

  // Build declared entry list (document order, deterministic).
  // Namespace properties themselves (gws/analytics) are NOT method entries —
  // only their flattened sub-methods are.
  const entries = [];
  for (const m of topLevel) {
    entries.push({ name: m.name, optional: m.optional, namespace: null });
  }
  for (const s of gwsNs.subs) {
    entries.push({ name: `gws.${s.name}`, optional: s.optional, namespace: 'gws' });
  }
  const analyticsSubs = [...parsed.analyticsBody.matchAll(METHOD_LINE(4))].map((m) => ({
    name: m[1],
    optional: m[2] === '?',
  }));
  for (const s of analyticsSubs) {
    entries.push({ name: `analytics.${s.name}`, optional: s.optional, namespace: 'analytics' });
  }

  const topSet = new Set(topLevel.map((m) => m.name));
  const declaredNames = new Set(entries.map((e) => e.name));

  // parse-unknown: every top-level method must have a domain
  const domainOf = new Map();
  for (const [domain, names] of Object.entries(DOMAIN_METHODS)) {
    for (const name of names) {
      if (domainOf.has(name)) {
        fail(`parse-unknown: duplicate domain mapping for "${name}"`);
      }
      domainOf.set(name, domain);
    }
  }
  const unknown = topLevel.map((m) => m.name).filter((name) => !domainOf.has(name));
  if (unknown.length > 0) {
    fail(
      `parse-unknown: ${unknown.length} AccomplishAPI methods missing from DOMAIN_METHODS: ${unknown.join(', ')}`,
    );
  }

  // stale map entries: every mapped top-level name must still be declared
  const staleDomains = [...domainOf.keys()].filter((name) => !topSet.has(name));
  if (staleDomains.length > 0) {
    fail(
      `parse-unknown: DOMAIN_METHODS contains stale (now-undeclared) names: ${staleDomains.join(', ')}`,
    );
  }

  // Optional-absent set must reference declared or namespace names
  const parentNames = new Set(['gws', 'analytics']);
  for (const name of optionalNotSupported) {
    if (!declaredNames.has(name) && !parentNames.has(name)) {
      fail(`parse-unknown: OPTIONAL_NOT_SUPPORTED has undeclared entry "${name}"`);
    }
  }

  // SHIM_RPC_MAP coverage: every declared entry + analytics parent + extras
  const mapKeys = new Set(Object.keys(SHIM_RPC_MAP));
  const missingMap = entries.map((e) => e.name).filter((n) => !mapKeys.has(n));
  if (missingMap.length > 0) {
    fail(`parse-unknown: SHIM_RPC_MAP missing backing for: ${missingMap.join(', ')}`);
  }

  const allow = new Set(allowlist);
  const block = new Set(blocklist);

  // shim transport.call targets must be allowlisted (runtime parity)
  const notAllowlisted = [...new Set(parsed.shimCallTargets)].filter((n) => !allow.has(n));
  if (notAllowlisted.length > 0) {
    fail(
      `self-check: shim calls methods NOT allowlisted (runtime breakage): ${notAllowlisted.join(', ')}`,
    );
  }

  // allowlist ⊆ registered (gateway misconfig otherwise)
  const allowNotReg = allowlist.filter((n) => !registered.has(n));
  if (allowNotReg.length > 0) {
    fail(`self-check: allowlisted methods not registered on the daemon: ${allowNotReg.join(', ')}`);
  }

  // No core key may also be optional-absent (contradiction)
  const both = [...coreSet].filter((k) => optionalNotSupported.includes(k));
  if (both.length > 0) {
    fail(`self-check: keys present in BOTH core and OPTIONAL_NOT_SUPPORTED: ${both.join(', ')}`);
  }

  function rpcStatus(name) {
    if (name === null) {
      return 'no-backing';
    }
    if (block.has(name)) {
      return 'registered-blocklisted';
    }
    if (allow.has(name)) {
      return 'allowlisted';
    }
    if (registered.has(name)) {
      return 'registered-blocked';
    }
    return 'unregistered';
  }

  const analyticParentNoop = coreSet.has('analytics') && noopSet.has('analytics');
  const gwsParentPresent = coreSet.has('gws');
  // (gws parent present would require sub-value parsing — extend this script first)
  if (gwsParentPresent) {
    fail(
      'parse-unknown: shim now implements the gws namespace — extend gws.* classification first',
    );
  }

  const rows = entries.map((e) => {
    const isAnalyticsSub = e.namespace === 'analytics';
    const isGwsSub = e.namespace === 'gws' && e.name !== 'gws';
    let shimStatus;
    if (optionalNotSupported.includes(e.name)) {
      shimStatus = 'optional-absent';
    } else if (isAnalyticsSub) {
      if (!analyticParentNoop) {
        fail(
          'parse-unknown: analytics parent is not a no-op Proxy in core — extend classification',
        );
      }
      shimStatus = 'no-op';
    } else if (isGwsSub) {
      shimStatus = 'unavailable'; // parent namespace absent → unreachable
    } else if (coreSet.has(e.name)) {
      shimStatus = noopSet.has(e.name) ? 'no-op' : 'implemented';
    } else {
      shimStatus = 'unavailable';
    }

    const mapEntry = SHIM_RPC_MAP[e.name];
    const backing = mapEntry.rpc ?? null;
    return {
      name: e.name,
      optional: e.optional,
      domain: e.namespace === null ? domainOf.get(e.name) : e.namespace,
      shimStatus,
      backing,
      backingStatus: rpcStatus(backing),
      note: mapEntry.note ?? '',
    };
  });

  // Shim-only (undeclared) implemented keys
  const extras = coreKeys
    .filter((k) => !declaredNames.has(k) && !parentNames.has(k))
    .map((k) => {
      const mapEntry = SHIM_RPC_MAP[k];
      if (!mapEntry) {
        fail(`parse-unknown: shim-extra key "${k}" missing from SHIM_RPC_MAP`);
      }
      return {
        name: k,
        shimStatus: noopSet.has(k) ? 'no-op' : 'implemented',
        backing: mapEntry.rpc ?? null,
        backingStatus: rpcStatus(mapEntry.rpc ?? null),
        note: mapEntry.note ?? '',
      };
    });

  // Stale SHIM_RPC_MAP keys (declared+extras+parents all checked above)
  const staleMap = [...mapKeys].filter(
    (k) => !declaredNames.has(k) && !parentNames.has(k) && !extras.some((e) => e.name === k),
  );
  if (staleMap.length > 0) {
    fail(`parse-unknown: SHIM_RPC_MAP has stale keys: ${staleMap.join(', ')}`);
  }

  return { entries: rows, extras, allow, block, registered };
}

// ── aggregation ──────────────────────────────────────────────────────────────

function aggregate(rows) {
  const perDomain = new Map();
  for (const domain of DOMAIN_ORDER) {
    perDomain.set(domain, {
      rows: [],
      counts: { implemented: 0, 'no-op': 0, 'optional-absent': 0, unavailable: 0 },
    });
  }
  for (const row of rows) {
    const bucket = perDomain.get(row.domain);
    if (!bucket) {
      fail(`parse-unknown: entry "${row.name}" resolved to unknown domain "${row.domain}"`);
    }
    bucket.rows.push(row);
    bucket.counts[row.shimStatus]++;
  }
  // grand totals
  const totals = { implemented: 0, 'no-op': 0, 'optional-absent': 0, unavailable: 0 };
  for (const { counts } of perDomain.values()) {
    totals.implemented += counts.implemented;
    totals['no-op'] += counts['no-op'];
    totals['optional-absent'] += counts['optional-absent'];
    totals.unavailable += counts.unavailable;
  }
  const declaredTotal = rows.length;
  const sum = totals.implemented + totals['no-op'] + totals['optional-absent'] + totals.unavailable;
  if (sum !== declaredTotal) {
    fail(`internal-consistency: status sums ${sum} != declared ${declaredTotal}`);
  }
  for (const [domain, bucket] of perDomain) {
    const { counts } = bucket;
    const dsum =
      counts.implemented + counts['no-op'] + counts['optional-absent'] + counts.unavailable;
    if (dsum !== bucket.rows.length) {
      fail(
        `internal-consistency: domain "${domain}" status sums ${dsum} != rows ${bucket.rows.length}`,
      );
    }
  }
  return { perDomain, totals, declaredTotal };
}

const EXPECTED = {
  planDeclared: 249,
  planImplemented: 129, // plan §2.2
  planNoopTopLevel: 7,
  planUnavailable: 120, // plan §2.2
  planAllowlist: 62,
  planDaemonRegistered: 125, // plan §2.2 (pre-M1 bookkeeping: routes + shutdown + ping)
  // Milestone deltas measured against the plan figures:
  m1InternalRegistered: 4, // daemon.setClientType/setUiPresence + devBrowser.* (never allowlisted)
  m2T1aRegistered: 4, // provider.testConnection/fetchModels/validateKey + secrets.listApiKeys
  m2T1aAllowlistDelta: 21, // provider trio + 5 provider writes + 2 secrets + 11 settings configs
  // Phase 3 M2 T1b: shim call-site wiring (42 declared entries) + §A3 daemon
  // surface (provider.validateCredentials) + the storeBedrockCredentials
  // allowlist pairing. saveVertexCredentials reuses the allowlisted
  // secrets.storeApiKey bucket — no third daemon method.
  m2T1bImplemented: 42,
  m2T1bRegistered: 1,
  m2T1bAllowlistDelta: 2,
  // Phase 3 M2 T2: skills CRUD (5 shim call sites) + custom-connector CRUD
  // (5 shim call sites) + one new daemon RPC (skills.addFromGitHub) + the 9
  // allowlist additions (skills trio + connectors.list/upsert/setEnabled/
  // setStatus/delete/deleteTokens). openSkillInEditor/showSkillInFolder stay
  // unavailable (documented degradation); the OAuth family stays M6.
  m2T2Implemented: 10,
  m2T2Registered: 1,
  m2T2AllowlistDelta: 9,
  // Phase 3 M2 T3: file-attachment drop flow. processDroppedFiles promotes
  // to implemented via the existing host /pick-files surface (getFilePath
  // stays unavailable by design) — no new daemon RPC, no allowlist delta.
  m2T3Implemented: 1,
};

const SANITY_CHECKS = [
  {
    label: 'startTask implemented + task.start allowlisted',
    when: (rows, ctx) => {
      const r = rows.find((x) => x.name === 'startTask');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label: 'getApiKey unavailable, backing secrets.getApiKey registered-blocklisted',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'getApiKey');
      return r.shimStatus === 'unavailable' && r.backingStatus === 'registered-blocklisted';
    },
  },
  {
    label:
      'getBedrockCredentials + getVertexCredentials unavailable; backing reads not allowlisted',
    when: (rows) => {
      const bedrock = rows.find((x) => x.name === 'getBedrockCredentials');
      const vertex = rows.find((x) => x.name === 'getVertexCredentials');
      return (
        bedrock.shimStatus === 'unavailable' &&
        vertex.shimStatus === 'unavailable' &&
        bedrock.backingStatus !== 'allowlisted' &&
        vertex.backingStatus !== 'allowlisted'
      );
    },
  },
  {
    label:
      'clearApiKey implemented ONTO secrets.deleteApiKey (blanket secrets.clear stays blocked)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'clearApiKey');
      return r.shimStatus === 'implemented' && r.backing === 'secrets.deleteApiKey';
    },
  },
  {
    label: 'startBrowserPreview optional-absent',
    when: (rows) => {
      return rows.find((x) => x.name === 'startBrowserPreview').shimStatus === 'optional-absent';
    },
  },
  {
    label:
      'setOllamaConfig implemented, backing settings.setOllamaConfig allowlisted (M2 T1b wiring)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'setOllamaConfig');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label: 'testOllamaConnection implemented, backing provider.testConnection allowlisted (M2 T1b)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'testOllamaConnection');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label: 'fetchOpenRouterModels implemented, backing provider.fetchModels allowlisted (M2 T1b)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'fetchOpenRouterModels');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label:
      'validateApiKeyForProvider implemented, backing provider.validateKey allowlisted (M2 T1b)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'validateApiKeyForProvider');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label:
      'validateBedrockCredentials implemented, backing provider.validateCredentials allowlisted (T1b §A3)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'validateBedrockCredentials');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label:
      'saveBedrockCredentials implemented, backing secrets.storeBedrockCredentials allowlisted (T1b §A3)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'saveBedrockCredentials');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label: 'saveVertexCredentials rides the allowlisted storeApiKey bucket (no vertex-secret RPC)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'saveVertexCredentials');
      return r.shimStatus === 'implemented' && r.backing === 'secrets.storeApiKey';
    },
  },
  {
    label: 'addSkillFromGitHub implemented, backing skills.addFromGitHub allowlisted (M2 T2)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'addSkillFromGitHub');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label: 'deleteSkill implemented, backing skills.delete allowlisted (M2 T2)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'deleteSkill');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label: 'getConnectors implemented, backing connectors.list allowlisted (M2 T2)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'getConnectors');
      return r.shimStatus === 'implemented' && r.backingStatus === 'allowlisted';
    },
  },
  {
    label:
      'disconnectConnector implemented onto connectors.deleteTokens (desktop setStatus co-call noted, M2 T2)',
    when: (rows) => {
      const r = rows.find((x) => x.name === 'disconnectConnector');
      return r.shimStatus === 'implemented' && r.backing === 'connectors.deleteTokens';
    },
  },
  {
    label:
      'openSkillInEditor/showSkillInFolder stay unavailable (M2 documented degradation, M6 candidate)',
    when: (rows) => {
      const open = rows.find((x) => x.name === 'openSkillInEditor');
      const show = rows.find((x) => x.name === 'showSkillInFolder');
      return open.shimStatus === 'unavailable' && show.shimStatus === 'unavailable';
    },
  },
  {
    label:
      'processDroppedFiles implemented via host /pick-files reuse while getFilePath stays unavailable (M2 T3)',
    when: (rows) => {
      const dropped = rows.find((x) => x.name === 'processDroppedFiles');
      const gfp = rows.find((x) => x.name === 'getFilePath');
      return (
        dropped.shimStatus === 'implemented' &&
        gfp.shimStatus === 'unavailable' &&
        dropped.backing === null
      );
    },
  },
];

// ── rendering ────────────────────────────────────────────────────────────────

function asOfDate() {
  const env = process.env.PARITY_AUDIT_DATE;
  if (env && /^\d{4}-\d{2}-\d{2}$/.test(env)) {
    return env;
  }
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function domainRpcBuckets(bucket) {
  const distinct = new Set(bucket.rows.map((r) => r.backing).filter((b) => b !== null));
  const buckets = {
    allowlisted: 0,
    'registered-blocked': 0,
    'registered-blocklisted': 0,
    unregistered: 0,
  };
  for (const rpc of distinct) {
    const st = bucket.rows.find((r) => r.backing === rpc).backingStatus;
    buckets[st]++;
  }
  const noBacking = bucket.rows.filter((r) => r.backing === null).length;
  return { ...buckets, 'no-backing': noBacking };
}

function renderMarkdown(agg, extras, parsed, classified, asOf) {
  const { perDomain, totals, declaredTotal } = agg;
  const L = [];
  const push = (s = '') => L.push(s);

  push('# API Parity Inventory — Firefox migration (Phase 3)');
  push();
  push(
    '> **Generated file — do not hand-edit.** Regenerate with ' +
      '`node apps/host/scripts/parity-audit.mjs` from the repo root (deterministic; same sources → same bytes).',
  );
  push(
    '> Generated: ' +
      asOf +
      (process.env.PARITY_AUDIT_DATE ? ' (PARITY_AUDIT_DATE override)' : ' (run date)'),
  );
  push();
  push('Sources parsed at generation time:');
  push('');
  push(
    `- \`${FILES.api}\` — \`AccomplishAPI\` interface (+ nested \`GwsAPI\`, inline \`analytics\` object)`,
  );
  push(`- \`${FILES.shim}\` — gateway shim (\`core\` object, \`OPTIONAL_NOT_SUPPORTED\`)`);
  push(`- \`${FILES.policy}\` — \`RPC_METHOD_ALLOWLIST\` / \`RPC_METHOD_BLOCKLIST\``);
  push(
    `- \`${FILES.daemonRoutes}\` + \`${FILES.daemonIndex}\` + builtin \`daemon.ping\` in \`${FILES.agentCoreRpc}\``,
  );
  push();
  push('## Status semantics');
  push();
  push('| Status | Meaning |');
  push('| --- | --- |');
  push('| implemented | shim `core` key backed by transport/call/events (real functionality) |');
  push(
    '| no-op | shim `core` key that resolves locally (no transport/events use), incl. all `analytics.*` via the no-op Proxy |',
  );
  push(
    '| optional-absent | declared optional `?`, listed in shim `OPTIONAL_NOT_SUPPORTED`; UI guards skip it |',
  );
  push('| unavailable | shim Proxy throws `HttpShimNotSupportedError` |');
  push('| allowlisted | backing RPC in gateway allowlist (proxied) |');
  push(
    '| registered-blocked | registered on daemon, not allowlisted, not blocklisted (gateway default-deny) |',
  );
  push(
    '| registered-blocklisted | registered but blocklisted (plaintext secret read; blocklist wins) |',
  );
  push(
    '| unregistered | backing RPC named but not registered on any daemon surface (must be added) |',
  );
  push(
    '| no-backing | `SHIM_RPC_MAP` = null (host HTTP endpoint, WS notification, local constant, or to-be-built) |',
  );
  push();
  push(
    'Nestings are flattened: `gws.*` and `analytics.*` per sub-method; the namespace properties ' +
      'themselves are not methods (the `gws` absence is tracked via OPTIONAL_NOT_SUPPORTED).',
  );
  push();

  push('## Measured totals');
  push();
  push('| Measure | Value |');
  push('| --- | --- |');
  push(
    `| Declared AccomplishAPI entries | **${declaredTotal}** (204 top-level methods + 8 gws.* + 37 analytics.*) |`,
  );
  push(`| Shim functional (implemented) | **${totals.implemented}** |`);
  push(`| Shim no-op | **${totals['no-op']}** |`);
  push(`| Shim optional-absent | **${totals['optional-absent']}** |`);
  push(`| Shim unavailable | **${totals.unavailable}** |`);
  push(`| Shim-implemented not declared on AccomplishAPI (extras) | ${extras.length} |`);
  push(`| Gateway allowlist entries | **${allowOf(parsed.allowlist)}** |`);
  push(`| Gateway blocklist entries | ${parsed.blocklist.length} |`);
  push(
    `| Daemon registered methods | **${parsed.registered.size}** (${routeCount(parsed)} daemon-routes.ts + ${indexCount(parsed)} daemon/index.ts + ${builtinCount(parsed)} builtin) |`,
  );
  push(
    `| Daemon registered not allowlisted | ${parsed.registered.size - allowOf(parsed.allowlist)} |`,
  );
  push();

  push('### Reconciliation with plan §2.2 (measured vs known facts)');
  push();
  push(
    'Plan §2.2 (verified 2026-10-21) states: AccomplishAPI = 249 methods · shim implements 129 (7 no-op) · ' +
      "120 unavailable · allowlist 62 · daemon exposes 125. The checked-in numbers below are THIS run's real measure; " +
      'each line reconciles the two accountings or flags drift.',
  );
  push();
  const rec = [];
  const check = (ok, text) => rec.push(`${ok ? '✓' : '✗'} ${text}`);
  const implInvariant =
    totals.implemented + totals['no-op'] ===
    EXPECTED.planImplemented +
      EXPECTED.m2T1bImplemented +
      EXPECTED.m2T2Implemented +
      EXPECTED.m2T3Implemented;
  check(
    implInvariant,
    `plan "129 implemented" = ${totals.implemented} functional + ${totals['no-op']} no-op, where ` +
      `functional = 84 pre-T1b + ${EXPECTED.m2T1bImplemented} T1b-shim-wired entries + ` +
      `${EXPECTED.m2T2Implemented} T2 skills/connector-CRUD entries + ` +
      `${EXPECTED.m2T3Implemented} T3 file-attachment-drop entry (processDroppedFiles → host picker) ` +
      `and measured no-op ${totals['no-op']} = ` +
      `8 top-level no-ops + 37 analytics.*. Plan's parenthetical "(7 no-op)" = the deliberate top-level no-op ` +
      'family (treating onHuggingFaceDownloadProgress — also a no-op — under the same family). ' +
      (implInvariant ? 'Arithmetic matches.' : 'MISMATCH — drift since plan.'),
  );
  const unavailInvariant =
    totals.unavailable + totals['optional-absent'] ===
    EXPECTED.planUnavailable -
      EXPECTED.m2T1bImplemented -
      EXPECTED.m2T2Implemented -
      EXPECTED.m2T3Implemented;
  check(
    unavailInvariant,
    `plan "120 unavailable" = ${totals.unavailable} unavailable + ${totals['optional-absent']} optional-absent ` +
      `(browser-preview 6 + onWorkspaceDeleted), minus the ${EXPECTED.m2T1bImplemented} entries T1b promoted to ` +
      `implemented, the ${EXPECTED.m2T2Implemented} entries T2 promoted (skills CRUD + connector CRUD), and the ` +
      `${EXPECTED.m2T3Implemented} entry T3 promoted (processDroppedFiles via the host picker). ` +
      'Plan\'s "GWS (8)" = the 8 gws.* sub-methods (shim-side they throw while the parent namespace ' +
      'is absent). ' +
      (unavailInvariant ? 'Arithmetic matches.' : 'MISMATCH — drift since plan.'),
  );
  const m2ExpectedAllowlist =
    EXPECTED.planAllowlist +
    EXPECTED.m2T1aAllowlistDelta +
    EXPECTED.m2T1bAllowlistDelta +
    EXPECTED.m2T2AllowlistDelta;
  const allowOk = parsed.allowlist.length === m2ExpectedAllowlist;
  check(
    allowOk,
    `allowlist ${parsed.allowlist.length} vs plan 62 + ${EXPECTED.m2T1aAllowlistDelta} M2 T1a entries + ` +
      `${EXPECTED.m2T1bAllowlistDelta} T1b entries (provider.validateCredentials + secrets.storeBedrockCredentials) + ` +
      `${EXPECTED.m2T2AllowlistDelta} T2 entries (skills.addFromPath/addFromGitHub/delete + connectors.list/upsert/setEnabled/setStatus/delete/deleteTokens) = ` +
      `${m2ExpectedAllowlist} — ` +
      `${allowOk ? 'matches the M2 expansion' : 'MISMATCH — allowlist changed since the M2 tripwire'}`,
  );
  const m2ExpectedRegistered =
    EXPECTED.planDaemonRegistered +
    EXPECTED.m1InternalRegistered +
    EXPECTED.m2T1aRegistered +
    EXPECTED.m2T1bRegistered +
    EXPECTED.m2T2Registered;
  const planDelta = parsed.registered.size;
  check(
    planDelta === m2ExpectedRegistered,
    `daemon registered ${parsed.registered.size} (${routeCount(parsed)} daemon-routes.ts + ${indexCount(parsed)} daemon/index.ts daemon.shutdown + ${builtinCount(parsed)} builtin daemon.ping) ` +
      `vs plan 125 = pre-M1 123 routes + shutdown + ping, +4 M1-internal methods ` +
      '(daemon.setClientType, daemon.setUiPresence, devBrowser.getPreviewInfo, devBrowser.openPreviewPage — deliberately not allowlisted), ' +
      `+${EXPECTED.m2T1aRegistered} M2 T1a methods (provider.testConnection, provider.fetchModels, provider.validateKey, secrets.listApiKeys) ` +
      `+${EXPECTED.m2T1bRegistered} T1b method (provider.validateCredentials) ` +
      `+${EXPECTED.m2T2Registered} T2 method (skills.addFromGitHub) = ${m2ExpectedRegistered}. ` +
      (planDelta === m2ExpectedRegistered ? 'Arithmetic matches.' : 'MISMATCH — drift since plan.'),
  );
  push();
  for (const line of rec) {
    push(`- ${line}`);
  }
  push();

  push('## Summary per domain');
  push();
  push(
    'Shim counts are per method entry; RPC counts are per DISTINCT backing RPC named in the domain ' +
      '(null backing rows are counted as `no-backing`, not in RPC buckets).',
  );
  push();
  push(
    '| Domain | Entries | implemented | no-op | optional-absent | unavailable | allowlisted | registered-blocked | registered-blocklisted | unregistered | no-backing |',
  );
  push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const domain of DOMAIN_ORDER) {
    const bucket = perDomain.get(domain);
    const rb = domainRpcBuckets(bucket);
    const c = bucket.counts;
    push(
      `| ${domain} | ${bucket.rows.length} | ${c.implemented} | ${c['no-op']} | ${c['optional-absent']} | ${c.unavailable} | ${rb.allowlisted} | ${rb['registered-blocked']} | ${rb['registered-blocklisted']} | ${rb.unregistered} | ${rb['no-backing']} |`,
    );
  }
  const gTotals = {
    allowlisted: 0,
    'registered-blocked': 0,
    'registered-blocklisted': 0,
    unregistered: 0,
    'no-backing': 0,
  };
  for (const domain of DOMAIN_ORDER) {
    const rb = domainRpcBuckets(perDomain.get(domain));
    for (const k of Object.keys(gTotals)) {
      gTotals[k] += rb[k];
    }
  }
  push(
    `| **TOTAL** | ${declaredTotal} | ${totals.implemented} | ${totals['no-op']} | ${totals['optional-absent']} | ${totals.unavailable} | ${gTotals.allowlisted} | ${gTotals['registered-blocked']} | ${gTotals['registered-blocklisted']} | ${gTotals.unregistered} | ${gTotals['no-backing']} |`,
  );
  push();

  push('## Per-domain detail');
  push();
  for (const domain of DOMAIN_ORDER) {
    const bucket = perDomain.get(domain);
    push(`### ${domain}`);
    push();
    const c = bucket.counts;
    const rb = domainRpcBuckets(bucket);
    push(
      `Entries ${bucket.rows.length} — implemented ${c.implemented} · no-op ${c['no-op']} · optional-absent ${c['optional-absent']} · unavailable ${c.unavailable} ｜ RPC: allowlisted ${rb.allowlisted} · registered-blocked ${rb['registered-blocked']} · blocklisted ${rb['registered-blocklisted']} · unregistered ${rb.unregistered} · no-backing ${rb['no-backing']}`,
    );
    push();
    if (bucket.rows.length > 0) {
      push('| Method | Shim status | Backing RPC | RPC policy status | Note |');
      push('| --- | --- | --- | --- | --- |');
      for (const row of bucket.rows) {
        const backing = row.backing === null ? '—' : `\`${row.backing}\``;
        push(
          `| \`${row.name}${row.optional ? '?' : ''}\` | ${row.shimStatus} | ${backing} | ${row.backingStatus === 'no-backing' ? '—' : row.backingStatus} | ${row.note} |`,
        );
      }
    }
    if (DOMAIN_NOTES[domain]) {
      push();
      push(DOMAIN_NOTES[domain]);
    }
    push();
  }

  push(`## Appendix A — shim-implemented but NOT declared on AccomplishAPI (${extras.length})`);
  push();
  push('| Shim key | Shim status | Backing RPC | Note |');
  push('| --- | --- | --- | --- |');
  for (const e of extras) {
    push(
      `| \`${e.name}\` | ${e.shimStatus} | ${e.backing === null ? '—' : `\`${e.backing}\``} | ${e.note} |`,
    );
  }
  push();

  push(
    `## Appendix B — WS subscriptions wired by the shim (${parsed.shimNotifications.length} notifications, ${parsed.shimControlEvents.length} control events)`,
  );
  push();
  push(`Notifications: ${parsed.shimNotifications.map((n) => `\`${n}\``).join(', ')}`);
  push();
  push(`Control events: ${parsed.shimControlEvents.map((n) => `\`${n}\``).join(', ')}`);
  push();

  const allowlistedUnused = parsed.allowlist.filter(
    (m) =>
      ![...Object.values(SHIM_RPC_MAP)].some((v) => v.rpc === m) &&
      !parsed.shimCallTargets.includes(m),
  );
  push(
    `## Appendix C — allowlisted RPC methods with no shim mapping (${allowlistedUnused.length})`,
  );
  push();
  if (allowlistedUnused.length > 0) {
    push(allowlistedUnused.map((n) => `\`${n}\``).join(', '));
    push();
  } else {
    push('None — every allowlisted method is mapped from a shim method.');
    push();
  }

  push('## Appendix D — shim transport.call coverage (self-check)');
  push();
  push(
    `All ${new Set(parsed.shimCallTargets).size} distinct \`transport.call\` targets are allowlisted — verified at generation time.`,
  );
  push();

  return joinLines(L);
}

/** Join preserving intentional single blank lines; collapse doubles deterministically. */
function joinLines(L) {
  let out = '';
  for (const line of L) {
    if (line === '' && (out === '' || out.endsWith('\n\n'))) {
      continue;
    }
    out += line + '\n';
  }
  return out;
}

// helpers used above (kept plain for determinism)
function allowOf(list) {
  return new Set(list).size;
}
function routeCount(parsed) {
  let n = 0;
  for (const [name, sources] of parsed.registered) {
    if (sources.includes('daemon-routes.ts')) {
      n++;
    }
  }
  return n;
}
function indexCount(parsed) {
  let n = 0;
  for (const [, sources] of parsed.registered) {
    if (sources.includes('daemon/index.ts')) {
      n++;
    }
  }
  return n;
}
function builtinCount(parsed) {
  let n = 0;
  for (const [, sources] of parsed.registered) {
    if (sources.includes('agent-core rpc-server (builtin)')) {
      n++;
    }
  }
  return n;
}
function noopTopLevelList(rows) {
  return rows.entries
    .filter((r) => r.shimStatus === 'no-op' && !r.name.startsWith('analytics.'))
    .map((r) => `\`${r.name}\``)
    .join(', ');
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * Normalize the generated markdown through the repo's existing prettier
 * (devDependency — no new dependency) so `pnpm format:check` stays green on
 * both the script and the regenerated inventory. Parsing + numbers are NOT
 * affected: formatting happens after all measurement self-checks. Falls back
 * to raw output with a loud warning if prettier cannot be resolved.
 */
async function maybePrettierFormat(md) {
  try {
    const prettierModule = await import('prettier');
    const prettier = prettierModule?.default ?? prettierModule;
    if (typeof prettier?.format !== 'function') {
      throw new Error('prettier.format unavailable');
    }
    let config = {};
    try {
      config = (await prettier.resolveConfig(path.join(ROOT, OUTPUT))) ?? {};
    } catch {
      /* repo config is the default anyway */
    }
    return prettier.format(md, { ...config, parser: 'markdown' });
  } catch (err) {
    console.error(
      `parity-audit: WARNING: prettier not resolvable (${err.message}) — writing unformatted markdown`,
    );
    return md;
  }
}

async function main() {
  const parsed = collect();
  if (parsed.topLevel.length === 0) {
    fail('parse-unknown: zero top-level AccomplishAPI methods parsed');
  }
  const classified = classify(parsed);
  const { perDomain, totals, declaredTotal } = aggregate(classified.entries);

  // sanity assertions (task-specified)
  for (const s of SANITY_CHECKS) {
    if (!s.when(classified.entries)) {
      fail(`sanity: ${s.label}`);
    }
  }

  // totals must reconcile with the plan-derived facts (self-checked, loud when drifting)
  if (declaredTotal !== EXPECTED.planDeclared) {
    console.error(
      `parity-audit: NOTE: declared surface changed: ${declaredTotal} (plan documented ${EXPECTED.planDeclared})`,
    );
  }

  const asOf = asOfDate();
  const raw = renderMarkdown(
    { perDomain, totals, declaredTotal },
    classified.extras,
    parsed,
    classified,
    asOf,
  );
  const md = await maybePrettierFormat(raw);
  writeFileSync(path.join(ROOT, OUTPUT), md);

  // stdout summary (same data as the doc)
  console.log(`parity-audit: wrote ${OUTPUT} (as-of ${asOf})`);
  console.log(
    `Declared ${declaredTotal} | implemented ${totals.implemented} | no-op ${totals['no-op']} | optional-absent ${totals['optional-absent']} | unavailable ${totals.unavailable} | extras ${classified.extras.length}`,
  );
  console.log(
    `Allowlist ${parsed.allowlist.length} | blocklist ${parsed.blocklist.length} | daemon registered ${parsed.registered.size}`,
  );
  console.log('');
  console.log(
    'Per domain (entries: impl/no-op/opt-absent/unavail · RPC: allow/reg-blocked/blocklisted/unreg/no-backing):',
  );
  for (const domain of DOMAIN_ORDER) {
    const bucket = perDomain.get(domain);
    const c = bucket.counts;
    const rb = domainRpcBuckets(bucket);
    console.log(
      `  ${domain.padEnd(20)} ${String(bucket.rows.length).padStart(3)}: ${c.implemented}/${c['no-op']}/${c['optional-absent']}/${c.unavailable} · ${rb.allowlisted}/${rb['registered-blocked']}/${rb['registered-blocklisted']}/${rb.unregistered}/${rb['no-backing']}`,
    );
  }
  console.log('');
  console.log(
    'Self-checks: PASS (parse coverage, stale maps, totals, sanity assertions, shim-call ⊆ allowlist, allowlist ⊆ registered)',
  );
}

main();
