/**
 * SEC-1 — deterministic credential-detection hardening (browser-safe).
 *
 * Detects credential-request language on agent-authored question surfaces
 * (header/question/options — deliberately NOT keyed on the M6-A assistance
 * header: live samples show the model reusing other headers, e.g. "GitHub
 * login") and blocks secret-shaped answers BEFORE they cross into model
 * context, persisted transcripts, or logs.
 *
 * Heuristic by design: see docs/SEC1_CREDENTIAL_HARDENING_DESIGN.md §7 for
 * false-positive and evasion limits. This module is one layer of defense in
 * depth — never the only one.
 */
import { redact } from '../utils/redact.js';

export const CREDENTIAL_GENRES = [
  'password',
  'mfa_code',
  'api_key',
  'recovery_code',
  'credential_phrase',
] as const;

export type CredentialGenre = (typeof CREDENTIAL_GENRES)[number];

/** High-confidence secret shapes — blocked regardless of ask context. */
const HIGH_CONFIDENCE_SECRET_PATTERNS: RegExp[] = [
  /\b(?:passwords?|passwd|passphrases?|passcodes?|pass\s?codes?)["']?\s*[:=]\s*\S+/i,
  /\b(?:passwords?|passphrases?|passcodes?|passwd)\s+is\s+["']?\S{6,}/i,
  /\b(?:api[\s_-]?key|apikey|api[\s_-]?secret|client[\s_-]?secret|access[\s_-]?token|auth[\s_-]?token|secret[\s_-]?key|secret[\s_-]?token|recovery[\s_-]?code|backup[\s_-]?code)\b["']?\s*[:=]\s*\S+/i,
  /(?<!zip\s)(?<!area\s)(?<!postal\s)(?:\bcode\b|\botp\b|\bpin\b|\bpasscode\b)\s*[:=]\s*["']?\d{4,8}["']?\s*(?:[.,;!\s]|$)/i,
  /\b(?:verification|authentication|auth|security|one[\s-]?time|otp|mfa|2fa|access|recovery|backup|login)(?:[\s_-]*(?:code|otp|pin|token))?\s+is\s*[:=]?\s*["']?\d{4,8}\b/i,
  /\b(?:sk|ghp|gho|ghu|ghs|xai)[_-][A-Za-z0-9]{16,}\b/,
  /\bAIza[a-zA-Z0-9_-]{30,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /Bearer\s+[A-Za-z0-9._-]{10,}/i,
  /\b[A-Za-z0-9+/=]{40,}\b/,
];

/**
 * Bare 5–8-digit groups (6–8 is the OTP/recovery norm; 4-digit PINs are NOT
 * matched bare — they are caught only when labeled, e.g. "pin: 1234"). Used
 * ONLY when the ask itself was already flagged as credential-requesting, so
 * ordinary numeric answers (dates, counts) in unflagged conversations are
 * never corrupted.
 */
const OTP_LIKE_DIGITS_RE = /\b\d{5,8}\b/;

/** Credential-request language on agent-authored ask surfaces (warn-level). */
const ASK_PATTERNS: ReadonlyArray<{ genre: CredentialGenre; re: RegExp }> = [
  {
    genre: 'password',
    re: /\b(?:passwords?|passwd|passphrases?|passcodes?|passkeys?)\b/i,
  },
  {
    genre: 'mfa_code',
    re: /\b(?:mfa|2fa|otp|one[\s-]?time[\s-]?(?:code|password|pin)|(?:multi|two|three)[\s-]?factor|verification[\s-]?codes?|authentication[\s-]?codes?|security[\s-]?codes?|auth[\s-]?tokens?|\d[\s-]?digit[\s-]?(?:code|pin))\b/i,
  },
  {
    genre: 'api_key',
    re: /\b(?:api[\s_-]?keys?|apikeys?|api[\s_-]?secrets?|client[\s_-]?secrets?|access[\s_-]?tokens?|auth[\s_-]?tokens?|private[\s_-]?keys?|signing[\s_-]?keys?)\b/i,
  },
  {
    genre: 'recovery_code',
    re: /\b(?:recovery[\s_-]?codes?|backup[\s_-]?codes?|recovery[\s_-]?(?:phrase|keys?)|seed[\s_-]?phrases?|secret[\s_-]?phrases?|rescue[\s_-]?codes?)\b/i,
  },
  {
    genre: 'credential_phrase',
    re: /\b(?:credentials?\b|login[\s-]?(?:details|info)|sign[\s-]?in[\s-]?(?:details|info)|(?:share|provide|give|send|tell|type|enter|paste)\b[^.;]{0,60}\b(?:password|passcode|passphrase|credentials?|mfa|otp|secret)\b)/i,
  },
];

/** User-facing explanation attached to a blocked credential reply. */
export const CREDENTIAL_BLOCK_USER_MESSAGE =
  'This reply was blocked: it appears to contain a password, verification code, API key, or ' +
  'recovery code. For your security it was NOT sent to the agent. Authenticate directly on the ' +
  'site — its own login form (in the automation browser or your own browser) — then send a ' +
  'non-secret reply or choose an option.';

export interface CredentialTextPart {
  value?: string;
  kind: 'header' | 'question' | 'option_label' | 'option_description';
}

export interface CredentialDetectionResult {
  flagged: boolean;
  genres: CredentialGenre[];
}

/**
 * Detect credential-request language across the ask text surfaces
 * (header + question + option labels/descriptions). Header-agnostic by
 * design — the canonical assistance header is not consulted.
 */
export function detectCredentialRequest(parts: CredentialTextPart[]): CredentialDetectionResult {
  const genres = new Set<CredentialGenre>();
  for (const part of parts) {
    const text = part.value?.trim();
    if (!text) {
      continue;
    }
    for (const pattern of ASK_PATTERNS) {
      if (pattern.re.test(text)) {
        genres.add(pattern.genre);
      }
    }
  }
  return { flagged: genres.size > 0, genres: [...genres] };
}

/**
 * True when the free-text answer carries a high-confidence secret shape.
 * Used for the answer-side hard block (both live and restart reply paths)
 * and for deciding whether masked scrubbing must precede any persistence.
 */
export function containsLikelySecret(text: string): boolean {
  if (!text) {
    return false;
  }
  return HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** Bare 5–8-digit group in the answer (evaluated only for flagged asks). */
export function hasOtpLikeDigits(text: string): boolean {
  if (!text) {
    return false;
  }
  return OTP_LIKE_DIGITS_RE.test(text);
}

/**
 * Combined answer-side verdict: high-confidence secret shapes always block;
 * bare 5–8-digit groups block only when the ask itself requested codes.
 */
export function isCredentialUnsafeAnswer(text: string, askFlagged: boolean): boolean {
  return containsLikelySecret(text) || (askFlagged && hasOtpLikeDigits(text));
}

/** Throws {@link CREDENTIAL_BLOCK_USER_MESSAGE} when the answer is unsafe. */
export function assertCredentialSafeAnswer(text: string, askFlagged: boolean): void {
  if (isCredentialUnsafeAnswer(text, askFlagged)) {
    throw new Error(CREDENTIAL_BLOCK_USER_MESSAGE);
  }
}

/**
 * Scrub credential material from a text surface (persist/log/transport).
 * Always applies the shared `redact()` patterns; when `askFlagged` is true
 * it additionally masks labeled secret values and bare 5–8-digit groups.
 */
export function scrubCredentialText(text: string, askFlagged = false): string {
  let result = redact(text ?? '');
  if (!askFlagged) {
    return result;
  }
  result = result.replace(
    /\b(?:passwords?|passwd|passphrases?|passcodes?|api[\s-]?key|apikey|api[\s-]?secret|client[\s-]?secret|access[\s-]?token|auth[\s-]?token|secret[\s-]?key|recovery[\s-]?code|backup[\s-]?code|code|otp|pin)\b["']?\s*[:=]\s*\S+/gi,
    (match) => `${match.slice(0, 4)}[REDACTED]`,
  );
  // Prose form ("the password is …", "API key is …") — mirrors the
  // high-confidence detection so masked surfaces match blocked shapes.
  result = result.replace(
    /\b((?:passwords?|passwd|passphrases?|passcodes?|api[\s-]?key|apikey|api[\s-]?secret|client[\s-]?secret|access[\s-]?token|auth[\s-]?token|secret[\s-]?key|recovery[\s-]?code|backup[\s-]?code|code|otp|pin)s?\s+(?:is|are|was)\s*[:=]?\s*)["']?\S+/gi,
    (_match, labelPart: string) => `${labelPart}[REDACTED]`,
  );
  result = result.replace(OTP_LIKE_DIGITS_RE, (match) => `${match.slice(0, 2)}…[REDACTED]`);
  return result;
}
