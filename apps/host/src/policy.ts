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
  'task.interrupt',
  'task.list',
  'task.status',
  'task.get',
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
  // Secrets — writes only (one-way by design); every plaintext READ stays
  // on the RPC_METHOD_BLOCKLIST until masked variants exist (Phase 3).
  'secrets.storeApiKey',
  'secrets.hasAnyApiKey',
  // Masked read (Phase 3 M2): `{ provider: { exists, prefix? } }` entries
  // only — never plaintext. Plaintext siblings stay on the blocklist below.
  'secrets.listApiKeys',
  // Delete is a write; response is `true`/`false`.
  'secrets.deleteApiKey',
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
