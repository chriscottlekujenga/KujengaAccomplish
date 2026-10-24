/**
 * Shared assistance-question marker (Phase 3 M6-A D1/D2).
 *
 * The config-generator (system-prompt instruction), the OpenCodeAdapter
 * (assistance-kind tagging) and the daemon (`waiting_for_user` routing)
 * MUST import this same constant: the daemon routes a `question`
 * PermissionRequest to `waiting_for_user` iff its `header` string-equals
 * this exact value, so any drift silently degrades assistance routing.
 * Browser-safe by design — UI consumers import it via the `common` barrel.
 */
export const ASSISTANCE_QUESTION_HEADER = 'Human assistance required';
