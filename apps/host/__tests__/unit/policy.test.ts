import { describe, expect, it } from 'vitest';
import { RPC_METHOD_ALLOWLIST, RPC_METHOD_BLOCKLIST, checkMethodPolicy } from '../../src/policy.js';

describe('checkMethodPolicy', () => {
  it('allows explicitly authorized methods', () => {
    expect(checkMethodPolicy('task.start')).toEqual({ allowed: true });
    expect(checkMethodPolicy('daemon.ping')).toEqual({ allowed: true });
    expect(checkMethodPolicy('settings.getAll')).toEqual({ allowed: true });
    expect(checkMethodPolicy('permission.respond')).toEqual({ allowed: true });
  });

  it('denies methods that are not on the allowlist (default deny)', () => {
    expect(checkMethodPolicy('secrets.clear')).toEqual({
      allowed: false,
      reason: 'not-authorized',
    });
    expect(checkMethodPolicy('connectors.list')).toEqual({
      allowed: false,
      reason: 'not-authorized',
    });
    expect(checkMethodPolicy('some.unknown.method')).toEqual({
      allowed: false,
      reason: 'not-authorized',
    });
    expect(checkMethodPolicy('')).toEqual({ allowed: false, reason: 'not-authorized' });
  });

  it('blocks secret-returning methods even if allowlisted (blocklist wins)', () => {
    for (const method of RPC_METHOD_BLOCKLIST) {
      const hostileSets = {
        allow: new Set([method]),
        block: new Set(RPC_METHOD_BLOCKLIST),
      };
      expect(checkMethodPolicy(method, hostileSets)).toEqual({ allowed: false, reason: 'blocked' });
    }
  });

  it('blocks secret-returning methods under the default allowlist too', () => {
    // None of these should appear in the allowlist, but belt-and-braces:
    // even if someone adds one, the blocklist must still refuse it.
    expect(checkMethodPolicy('secrets.getApiKey')).toEqual({ allowed: false, reason: 'blocked' });
    expect(checkMethodPolicy('secrets.getAllApiKeys')).toEqual({
      allowed: false,
      reason: 'blocked',
    });
    expect(checkMethodPolicy('connectors.getTokens')).toEqual({
      allowed: false,
      reason: 'blocked',
    });
    expect(checkMethodPolicy('connectors.authEntry.read')).toEqual({
      allowed: false,
      reason: 'blocked',
    });
    expect(checkMethodPolicy('gwsAccount.getToken')).toEqual({ allowed: false, reason: 'blocked' });
  });

  it('authorizes one-way secret writes but never plaintext secret reads', () => {
    // Phase 2: the browser may STORE keys (one-way by design) and probe
    // existence (boolean), but every read that returns key material stays
    // unauthorized — masked reads are a Phase 3 method, not a hole here.
    expect(RPC_METHOD_ALLOWLIST).toContain('secrets.storeApiKey');
    expect(RPC_METHOD_ALLOWLIST).toContain('secrets.hasAnyApiKey');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.getApiKey');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.getAllApiKeys');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.getBedrockCredentials');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.upsert');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.storeTokens');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('auth.openai.getAccessToken');
  });

  it('authorizes the M2 provider/model-management methods (Phase 3 M2 T1a)', () => {
    // Test-connection + key validation accept a plaintext key in the REQUEST
    // (one-way to the daemon) and return redacted, key-free results. Model
    // fetch resolves keys daemon-side — no key material in either direction.
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.testConnection');
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.fetchModels');
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.validateKey');
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.setActive');
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.setConnected');
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.removeConnected');
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.updateModel');
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.setDebugMode');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.getOpenAiBaseUrl');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.setOpenAiBaseUrl');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.getOllamaConfig');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.setOllamaConfig');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.getLiteLLMConfig');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.setLiteLLMConfig');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.getLMStudioConfig');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.setLMStudioConfig');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.getAzureFoundryConfig');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.setAzureFoundryConfig');
    expect(RPC_METHOD_ALLOWLIST).toContain('settings.setNimConfig');
  });

  it('authorizes the M2 masked key listing but keeps its plaintext sibling blocked', () => {
    // secrets.listApiKeys returns { provider: { exists, prefix? } } only.
    expect(RPC_METHOD_ALLOWLIST).toContain('secrets.listApiKeys');
    expect(RPC_METHOD_ALLOWLIST).toContain('secrets.deleteApiKey');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.getApiKey');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.getAllApiKeys');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.getBedrockCredentials');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.clear');
    // No Nim getter exists on AccomplishAPI — the read stays unauthorized.
    expect(RPC_METHOD_ALLOWLIST).not.toContain('settings.getNimConfig');
  });

  it('pins the allowlist count (M2 tripwire — every addition needs §5.4 tests)', () => {
    // 62 M1 baseline + 21 M2 provider/model-management + masked-listing
    // entries (Phase 3 M2 T1a). This pin is deliberate: growing it further
    // requires the §5.4 expansion policy — documented response shape,
    // scrubber/no-secret-field proof, paired authorization + redaction tests.
    expect(RPC_METHOD_ALLOWLIST).toHaveLength(83);
    expect(RPC_METHOD_BLOCKLIST).toHaveLength(7);
  });

  it('allows a custom allow set with the default blocklist intact', () => {
    const decision = checkMethodPolicy('custom.method', {
      allow: new Set(['custom.method']),
    });
    expect(decision).toEqual({ allowed: true });
  });
});
