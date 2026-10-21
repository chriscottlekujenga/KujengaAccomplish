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
    expect(checkMethodPolicy('secrets.storeApiKey')).toEqual({
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

  it('keeps the allowlist minimal — no secrets or token stores authorized', () => {
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.storeApiKey');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.deleteApiKey');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.upsert');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('auth.openai.getAccessToken');
  });

  it('allows a custom allow set with the default blocklist intact', () => {
    const decision = checkMethodPolicy('custom.method', {
      allow: new Set(['custom.method']),
    });
    expect(decision).toEqual({ allowed: true });
  });
});
