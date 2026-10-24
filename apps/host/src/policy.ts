/**
 * RPC method authorization policy — explicit allowlist with a
 * secrets blocklist.
 *
 * The gateway proxies JSON-RPC to the daemon's Unix socket, but the browser
 * is a less trusted client than the Electron renderer was (see
 * FIREFOX_MIGRATION_PLAN §7.3): an XSS in the web UI must never be able to
 * exfiltrate plaintext API keys or OAuth tokens. Two rules:
 *
 *   1. ALLOWLIST — only explicitly listed methods are proxied. Adding a new
 *      method requires an intentional one-line change here (explicit
 *      authorization; Phase 3 grows this list toward full parity).
 *   2. BLOCKLIST — methods that return secret material are denied even if
 *      someone accidentally allowlists them. Blocklist always wins.
 */

export const RPC_METHOD_ALLOWLIST: readonly string[] = [
  // Health & lifecycle
  'daemon.ping',
  'daemon.shutdown',
  'health.check',
  // Task lifecycle
  'task.start',
  'task.cancel',
  // task.stop (Phase 3 M2 T5 — plan §6 M2 item 5, the M1-audit essential
  // method): the daemon's NATIVE stop method — daemon-routes.ts registers
  // 'task.stop' directly and 'task.cancel' as the desktop-IPC alias (see the
  // alias comment there); both call the same taskService.stopTask, i.e.
  // cancel/interrupt semantics for the target task. No new shim method: the
  // UI's cancelTask already maps to 'task.cancel' (SHIM_RPC_MAP backs nothing
  // on task.stop); task.stop parity matters for MCP-driven flows. RESPONSE
  // SHAPE (§5.4(a)): void — taskService.stopTask resolves void, so the
  // gateway serializes the HTTP body with NO `result` field at all
  // (JSON.stringify drops an undefined result); the cancel/interrupt signal
  // is the daemon-side task.statusChange:'cancelled' notification. No
  // fields → no secret material, and the universal scrubber still applies
  // as defense in depth.
  'task.stop',
  'task.interrupt',
  'task.list',
  'task.status',
  'task.get',
  // Pending-request read (Phase 3 M6-A T4 — the only new entry M6-A makes).
  // §5.4(a) RESPONSE SHAPE:
  //   { taskId } → { pendingRequest: { kind: 'permission' | 'question',
  //   requestId, question?, header?, options?, multiSelect?, createdAt } | null }
  // Restore source for the assistance card after a page reload, gateway
  // reconnect or daemon restart: the daemon wrote the record redacted +
  // length-capped at park time (§6.4) and never persists tool input, file
  // paths or secret material; the universal scrubber still applies here as
  // defense in depth. (The task.get/task.list payloads also carry the field;
  // this dedicated route is the §6.9 "one-shot read per task open/reconnect,
  // card re-read on task.statusChange only" surface.)
  'task.getPendingRequest',
  'task.delete',
  'task.clearHistory',
  'task.getTodos',
  'task.getActiveCount',
  // Session & permissions
  'session.resume',
  'permission.respond',
  // Scheduler
  'task.schedule',
  'task.listScheduled',
  'task.cancelScheduled',
  'task.setScheduleEnabled',
  // Settings
  'settings.getAll',
  'settings.setTheme',
  'settings.setLanguage',
  'settings.setDebugMode',
  'settings.getNotificationsEnabled',
  'settings.setNotificationsEnabled',
  'settings.getCloseBehavior',
  'settings.setCloseBehavior',
  'settings.getSandboxConfig',
  'settings.setSandboxConfig',
  'settings.getCloudBrowserConfig',
  'settings.setCloudBrowserConfig',
  'settings.setOnboardingComplete',
  'settings.getSelectedModel',
  'settings.setSelectedModel',
  // Provider runtime configs (Phase 3 M2 T1a): ollama / LiteLLM / LMStudio /
  // Azure Foundry / NIM / OpenAI base URL. Writes carry config (and any
  // provider keys) one-way to the daemon; reads return config metadata the
  // settings UI renders — the universal scrubber still applies to reads.
  // NOTE: no `settings.getNimConfig` — AccomplishAPI has no Nim getter, the
  // UI resolves NIM config through `provider.getSettings` instead.
  'settings.getOpenAiBaseUrl',
  'settings.setOpenAiBaseUrl',
  'settings.getOllamaConfig',
  'settings.setOllamaConfig',
  'settings.getLiteLLMConfig',
  'settings.setLiteLLMConfig',
  'settings.getLMStudioConfig',
  'settings.setLMStudioConfig',
  'settings.getAzureFoundryConfig',
  'settings.setAzureFoundryConfig',
  'settings.setNimConfig',
  // Provider settings — masked metadata only (gateway scrubs secret-looking
  // fields from the response before it crosses the trust boundary).
  'provider.getSettings',
  'provider.getDebugMode',
  // Provider management writes (Phase 3 M2 T1a) — empty/echo-scoped
  // responses; the universal scrubber still applies to whatever the daemon
  // returns, so a hypothetical secret-shaped field cannot leak by accident.
  'provider.setActive',
  'provider.setConnected',
  'provider.removeConnected',
  'provider.updateModel',
  'provider.setDebugMode',
  // Provider model management (Phase 3 M2 T1a):
  //   testConnection  → { success, models?: [{id, name, ...}], error? } —
  //                     provider-native shape, errors redacted daemon-side;
  //                     the REQUEST may carry a plaintext key (one-way to
  //                     the daemon).
  //   fetchModels     → { success, models?: [{id, name, ...}], error? } —
  //                     no key material anywhere: keys resolve daemon-side
  //                     (stored secrets / OpenAI OAuth token).
  //   validateKey     → { valid, error? } — the REQUEST carries the
  //                     plaintext key (one-way); errors redacted daemon-side.
  'provider.testConnection',
  'provider.fetchModels',
  'provider.validateKey',
  // Bedrock/Vertex credential validation (Phase 3 M2 T1b §A3): the
  // plaintext credential document travels one-way in the REQUEST; the
  // response is a { valid, error? } verdict with daemon-side redacted
  // error text — the document itself never echoes back.
  'provider.validateCredentials',
  // Workspaces & knowledge notes
  'workspace.list',
  'workspace.get',
  'workspace.getActive',
  'workspace.setActive',
  'workspace.create',
  'workspace.update',
  'workspace.delete',
  'knowledgeNote.list',
  'knowledgeNote.create',
  'knowledgeNote.update',
  'knowledgeNote.delete',
  // Favorites
  'favorites.list',
  'favorites.add',
  'favorites.remove',
  'favorites.isFavorite',
  // Skills (read + toggle; disk-path intake lands with Phase 2 pickers)
  'skills.list',
  'skills.listEnabled',
  'skills.setEnabled',
  'skills.getContent',
  'skills.getUserSkillsPath',
  'skills.resync',
  // Skill intake + delete (Phase 3 M2 T2). Registry writes with plain-file
  // responses:
  //   addFromPath    { sourcePath } → Skill | null — { id, name, command,
  //                     description, source, isEnabled, isVerified,
  //                     isHidden, filePath, updatedAt }; null = import
  //                     failed daemon-side.
  //   addFromGitHub  { rawUrl } → Skill (+ githubUrl for community
  //                     imports); URL is zod-gated to https +
  //                     github.com or raw.githubusercontent.com daemon-side.
  //   delete         { skillId } → void; errors for unknown or official
  //                     skills.
  // No secret-shaped fields in any of these responses; the universal
  // scrubber still applies as defense in depth.
  'skills.addFromPath',
  'skills.addFromGitHub',
  'skills.delete',
  // Custom MCP-connector registry CRUD (Phase 3 M2 T2). Tokens are NOT part
  // of these responses: OAuth tokens live in the daemon secure-storage file
  // under the connector-tokens:<id> prefix and are only reachable through
  // connectors.getTokens / authEntry.read (both blocklisted below).
  //   list            → McpConnector[] (id, name, url, status, isEnabled,
  //     oauthMetadata, clientRegistration, lastConnectedAt,
  //     lastOAuthValidatedAt, createdAt, updatedAt). DCR-issued
  //     clientRegistration.clientSecret is secret material — the gateway
  //     scrubs it (SECRET_FIELD_NAMES gained the clientSecret name in T2).
  //   upsert          { connector } → void (one-way registry write).
  //   setEnabled      { id, enabled } → void.
  //   setStatus       { id, status } → void (disconnect parity with desktop:
  //     deleteTokens, then status disconnected).
  //   delete          { id } → void (shim pairs it with deleteTokens first,
  //     mirroring desktop connectors:delete).
  //   deleteTokens    { connectorId } → void — REMOVES stored OAuth tokens
  //     (secret material destroyed, never returned).
  // connectors.getById / getEnabled / getTokens / authEntry.* / storeTokens
  // stay unauthorized for the browser (token-returning reads / M6 OAuth
  // flows; the web AccomplishAPI has no getEnabled/getById accessor —
  // getEnabled serves the same row shape as list, so the T2 scrubber proof
  // covers it if it is ever allowlisted).
  'connectors.list',
  'connectors.upsert',
  'connectors.setEnabled',
  'connectors.setStatus',
  'connectors.delete',
  'connectors.deleteTokens',
  // Secrets — writes only (one-way by design); every plaintext READ stays
  // on the RPC_METHOD_BLOCKLIST until masked variants exist (Phase 3).
  'secrets.storeApiKey',
  'secrets.hasAnyApiKey',
  // Masked read (Phase 3 M2): `{ provider: { exists, prefix? } }` entries
  // only — never plaintext. Plaintext siblings stay on the blocklist below.
  'secrets.listApiKeys',
  // Delete is a write; response is `true`/`false`.
  'secrets.deleteApiKey',
  // Bedrock credential-store write (Phase 3 M2 T1b §A3): one-way like
  // storeApiKey — the response is void. Its plaintext sibling read stays
  // blocklisted below.
  'secrets.storeBedrockCredentials',
  // Browser-preview v1 (Phase 3 M2 T4 — on-demand screenshot, no live
  // screencast per migration plan §8.5). The shim polls `captureFrame`
  // (~750 ms) and lazily ensures the page via `openPreviewPage`; `shutdown`
  // is the quit-time clean fix (checkpoint §18.3.6) that lets the desktop
  // stop the daemon-owned sidecar gracefully. DOCUMENTED RESPONSE SHAPES:
  //   openPreviewPage  { name, viewport? } → { targetId } | null — page-name
  //                     + target id only.
  //   captureFrame     { taskId, pageName? } → { data, width, height } | null
  //                     — base64 JPEG frame + CSS content size; null when
  //                     the sidecar/browser/page is absent. No token fields
  //                     exist in this shape (the sidecar bearer token stays
  //                     daemon-side) and the universal scrubber applies as
  //                     defense in depth.
  //   shutdown         {} → { stopped } — boolean only.
  // `devBrowser.getPreviewInfo` is deliberately NOT allowlisted: it returns
  // the raw CDP WebSocket endpoint, which is daemon-side plumbing the shim
  // must never need (that is the point of keeping the token daemon-side).
  'devBrowser.openPreviewPage',
  'devBrowser.captureFrame',
  'devBrowser.shutdown',
  // Accomplish AI free tier
  'accomplish-ai.connect',
  'accomplish-ai.get-usage',
  'accomplish-ai.disconnect',
];

/**
 * Methods that must never be proxied to a browser. They return plaintext
 * secret material over the daemon socket. Masked read variants (Phase 3)
 * will be new daemon methods instead of holes here.
 */
export const RPC_METHOD_BLOCKLIST: readonly string[] = [
  'secrets.getApiKey',
  'secrets.getAllApiKeys',
  'secrets.getBedrockCredentials',
  'connectors.getTokens',
  'connectors.authEntry.read',
  'gwsAccount.getToken',
  'gwsAccount.refreshNow',
];

export type MethodPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: 'not-authorized' | 'blocked' };

export interface MethodPolicySets {
  allow?: ReadonlySet<string>;
  block?: ReadonlySet<string>;
}

const DEFAULT_ALLOW = new Set(RPC_METHOD_ALLOWLIST);
const DEFAULT_BLOCK = new Set(RPC_METHOD_BLOCKLIST);

/**
 * Decide whether a method may be proxied. Blocklist wins over allowlist so
 * the secrets invariant cannot regress through a careless allowlist edit.
 */
export function checkMethodPolicy(method: string, sets?: MethodPolicySets): MethodPolicyDecision {
  const allow = sets?.allow ?? DEFAULT_ALLOW;
  const block = sets?.block ?? DEFAULT_BLOCK;
  if (block.has(method)) {
    return { allowed: false, reason: 'blocked' };
  }
  if (allow.has(method)) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'not-authorized' };
}
