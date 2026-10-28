import { detectCredentialRequest, type CredentialTextPart } from '@accomplish_ai/agent-core/common';
import type { PermissionRequest } from '@accomplish_ai/agent-core/common';

/**
 * SEC-1 — browser-safe credential-flag evaluation for the permission card.
 *
 * Trusts the adapter's `credentialRisk` stamp when present (live asks);
 * restored cards rebuilt from pre-SEC-1 persisted records carry no stamp, so
 * detection re-runs over the request's text surfaces. Header-independent by
 * design: a credential request can arrive under any agent-authored header
 * (A7 observed "GitHub login", not the canonical assistance header).
 */
export function isCredentialFlaggedRequest(request: PermissionRequest): boolean {
  if (request.type !== 'question') {
    return false;
  }
  if (request.credentialRisk !== undefined) {
    return request.credentialRisk;
  }
  const parts: CredentialTextPart[] = [
    { value: request.header, kind: 'header' },
    { value: request.question, kind: 'question' },
    ...(request.options ?? []).flatMap((option) => [
      { value: option.label, kind: 'option_label' as const },
      { value: option.description, kind: 'option_description' as const },
    ]),
  ];
  return detectCredentialRequest(parts).flagged;
}
