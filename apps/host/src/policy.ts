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
  // Provider settings — masked metadata only (gateway scrubs secret-looking
  // fields from the response before it crosses the trust boundary).
  'provider.getSettings',
  'provider.getDebugMode',
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
