import { describe, expect, it } from 'vitest';
import {
  detectCredentialRequest,
  containsLikelySecret,
  hasOtpLikeDigits,
  isCredentialUnsafeAnswer,
  assertCredentialSafeAnswer,
  scrubCredentialText,
  CREDENTIAL_BLOCK_USER_MESSAGE,
} from '../../../src/common/credential-detection.js';

function ask(header, question, optionLabels = []) {
  return [
    { value: header, kind: 'header' },
    { value: question, kind: 'question' },
    ...optionLabels.map((label) =>
      typeof label === 'string' ? { value: label, kind: 'option_label' } : label,
    ),
  ];
}

describe('detectCredentialRequest — SEC-1 header-agnostic ask detection', () => {
  it('flags a password request (A7 observed shape) under a NON-assistance header', () => {
    const result = detectCredentialRequest(
      ask('GitHub login', 'I cannot log in without credentials', [
        "Share your GitHub username and password via the custom answer box; I'll fill the form for you",
        'You enter them yourself in the automation browser',
      ]),
    );
    expect(result.flagged).toBe(true);
    expect(result.genres).toContain('password');
  });

  it('flags an MFA/verification-code request', () => {
    const cases = [
      ask('Login help', 'Please send me the 6-digit code from your authenticator app'),
      ask('Verify', 'What is the MFA code?'),
      ask('Verify', 'Tell me the one-time code shown on your phone'),
      ask('Verify', 'I need the 2FA SMS code to continue'),
      ask('Verify', 'Enter the verification code I can paste for you'),
    ];
    for (const parts of cases) {
      const result = detectCredentialRequest(parts);
      expect(result.flagged).toBe(true);
      expect(result.genres).toContain('mfa_code');
    }
  });

  it('flags API key / token / secret requests', () => {
    const cases = [
      ask('Setup', 'I need your OpenAI API key to run the import'),
      ask('Setup', 'Please share your access token for the integration'),
      ask('Setup', 'Provide the client secret from the provider console'),
    ];
    for (const parts of cases) {
      const result = detectCredentialRequest(parts);
      expect(result.flagged).toBe(true);
      expect(result.genres).toContain('api_key');
    }
  });

  it('flags recovery/backup-code requests', () => {
    const result = detectCredentialRequest(
      ask(
        'Account check',
        'I got locked out — share two of your recovery codes so I can restore access',
      ),
    );
    expect(result.flagged).toBe(true);
    expect(result.genres).toContain('recovery_code');
  });

  it('flags credential-style phrasing (share/enter + credentials)', () => {
    const result = detectCredentialRequest(
      ask('Payment portal', 'Enter your credentials in the box below so I can complete the login'),
    );
    expect(result.flagged).toBe(true);
    expect(result.genres).toContain('credential_phrase');
  });

  it('does NOT flag legitimate non-sensitive questions (M6-A T7 asks included)', () => {
    const cases = [
      ask('Human assistance required', 'A CAPTCHA is blocking https://example.com/form', [
        "I'll complete it — please wait",
        'Skip this verification',
      ]),
      ask(
        'Human assistance required',
        'I reached the GitHub login page. Log in yourself in the preview browser and choose an option when done',
        ["I'll complete it — please wait", 'Skip this verification'],
      ),
      ask('A quick question', 'Which format do you want?', [
        { value: 'Markdown', kind: 'option_label' },
        { value: 'Plain text', kind: 'option_label' },
      ]),
      ask('Order check', 'Which of the 8 results on the page should I list?'),
      ask('Workspace', 'Should the file go to Desktop or Downloads?'),
      ask('Site check', 'Do you want me to report order status 2025 data or last year?'),
    ];
    for (const parts of cases) {
      const result = detectCredentialRequest(parts);
      expect(result.flagged).toBe(false);
    }
  });

  it('does not flag a bare username/account mention without secret terms', () => {
    const result = detectCredentialRequest(
      ask('Account', 'Which username should I use for the profile setup?'),
    );
    expect(result.flagged).toBe(false);
  });
});

describe('containsLikelySecret — SEC-1 answer-side shapes', () => {
  it('blocks labeled passwords, keys, tokens, and recovery codes', () => {
    const cases = [
      'password: hunter2secret',
      'Password = super-secure-123',
      '"password": "hunter2secret"',
      'api key: sk-proj-aaaaaaaaaaaaaaaaaaaaaa',
      'API_KEY=abcdefghijklmnopqrstuvwxyz',
      'access token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.done',
      'recovery code: 1234567890abcdef',
      'the password is hunter2secret',
    ];
    for (const text of cases) {
      expect(containsLikelySecret(text)).toBe(true);
    }
  });

  it('blocks known key formats, labeled codes, and bearer tokens', () => {
    const cases = [
      'sk-abcdefghijklmnopqrstuvwxyz0123',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'AIzaSyabcdefghijklmnopqrstuvwxyz1234',
      'AKIAIOSFODNN7EXAMPLE',
      'code: 482913',
      'the otp is 482913',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.token',
    ];
    for (const text of cases) {
      expect(containsLikelySecret(text)).toBe(true);
    }
  });

  it('passes legitimate non-secret replies (manual-browser-auth confirmations)', () => {
    const cases = [
      "I'll complete it — please wait",
      'Done — I logged in myself in the preview browser; continue from the dashboard',
      'verified, please continue',
      'I chose the passkey option on the site',
      'my username is chris (no password shared)',
      'The report has 1,432 rows',
      'approved on 2025-10-26',
    ];
    for (const text of cases) {
      expect(containsLikelySecret(text)).toBe(false);
    }
  });
});

describe('hasOtpLikeDigits / isCredentialUnsafeAnswer', () => {
  it('bare 5-8 digit groups count ONLY when the ask was flagged', () => {
    expect(hasOtpLikeDigits('the code is 482913')).toBe(true);
    expect(hasOtpLikeDigits('Done 2025 report reviewed')).toBe(false);
    expect(isCredentialUnsafeAnswer('the code is 482913', false)).toBe(false);
    expect(isCredentialUnsafeAnswer('the code is 482913', true)).toBe(true);
    expect(isCredentialUnsafeAnswer('482913', true)).toBe(true);
    expect(isCredentialUnsafeAnswer("I'll complete it — please wait", true)).toBe(false);
  });

  it('high-confidence shapes block regardless of the ask flag', () => {
    expect(isCredentialUnsafeAnswer('password: hunter2secret', false)).toBe(true);
    expect(isCredentialUnsafeAnswer('password: hunter2secret', true)).toBe(true);
  });

  it('assertCredentialSafeAnswer throws the user-facing block message', () => {
    expect(() => assertCredentialSafeAnswer('mfa code 482913', true)).toThrowError(
      CREDENTIAL_BLOCK_USER_MESSAGE,
    );
    expect(() => assertCredentialSafeAnswer('password: hunter2secret', false)).toThrowError(
      CREDENTIAL_BLOCK_USER_MESSAGE,
    );
    expect(() => assertCredentialSafeAnswer('I completed the login myself', true)).not.toThrow();
  });
});

describe('scrubCredentialText', () => {
  it('always applies the shared redactor (unflagged surface)', () => {
    const out = scrubCredentialText('the api key is sk-abcdefghijklmnopqrstuvwxyz', false);
    expect(out).toContain('[REDACTED]');
  });

  it('masks labeled secrets and bare 5-8 digit groups on a flagged surface', () => {
    const out = scrubCredentialText('password: hunter2secret code 482913', true);
    expect(out).not.toContain('hunter2secret');
    expect(out).not.toContain('482913');
    expect(out).toContain('[REDACTED]');
  });

  it('leaves ordinary numbers intact on a flagged surface', () => {
    const out = scrubCredentialText('approved on 2025-10-26, 14 items', true);
    expect(out).toContain('2025-10-26');
    expect(out).toContain('14 items');
  });
});
