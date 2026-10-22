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
    // T2: connectors.getById stays unauthorized — no web AccomplishAPI
    // method maps to it (only the deferred-M6 desktop OAuth flows use it).
    expect(checkMethodPolicy('connectors.getById')).toEqual({
      allowed: false,
      reason: 'not-authorized',
    });
    expect(checkMethodPolicy('connectors.getEnabled')).toEqual({
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
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.getTokens');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.authEntry.read');
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

  it('authors the M2 T1b bedrock/vertex credential flows with paired limits', () => {
    // provider.validateCredentials: the plaintext credential JSON travels
    // one-way in the REQUEST; the response carries only { valid, error? }
    // with daemon-side redaction. secrets.storeBedrockCredentials: one-way
    // void write like storeApiKey. Neither plaintext read sibling is (or
    // ever becomes) allowlisted.
    expect(RPC_METHOD_ALLOWLIST).toContain('provider.validateCredentials');
    expect(RPC_METHOD_ALLOWLIST).toContain('secrets.storeBedrockCredentials');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.getBedrockCredentials');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.getVertexCredentials');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.storeVertexCredentials');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('secrets.clear');
  });

  it('authorizes the M2 T2 skills CRUD methods (registry writes, plain responses)', () => {
    // Skill intake/delete return plain Skill records (id/name/command/
    // description/source/isEnabled/filePath/updatedAt) or void — no secret
    // material; the T2 audit found none of these response shapes colliding
    // with SECRET_FIELD_NAMES. skills.addFromGitHub is the new T2 daemon
    // RPC (URL zod-gated to https + GitHub hosts daemon-side).
    expect(RPC_METHOD_ALLOWLIST).toContain('skills.addFromPath');
    expect(RPC_METHOD_ALLOWLIST).toContain('skills.addFromGitHub');
    expect(RPC_METHOD_ALLOWLIST).toContain('skills.delete');
  });

  it('authorizes the M2 T2 custom-connector CRUD but keeps token reads blocked', () => {
    // connectors.list/getEnabled responses are plain McpConnector registry
    // metadata; OAuth tokens live in secure storage under
    // `connector-tokens:<id>` and are ONLY reachable through
    // connectors.getTokens / connectors.authEntry.read — both stay on the
    // blocklist. connectors.deleteTokens is a one-way secret-destroying
    // write (void response, never echoes tokens). connectors.getById is
    // deliberately NOT allowlisted: no web call site today (only desktop
    // OAuth flows, deferred to M6).
    for (const method of [
      'connectors.list',
      'connectors.upsert',
      'connectors.setEnabled',
      'connectors.setStatus',
      'connectors.delete',
      'connectors.deleteTokens',
    ]) {
      expect(RPC_METHOD_ALLOWLIST).toContain(method);
    }
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.getById');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.getTokens');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.authEntry.read');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('connectors.storeTokens');
    expect(RPC_METHOD_BLOCKLIST).toContain('connectors.getTokens');
    expect(RPC_METHOD_BLOCKLIST).toContain('connectors.authEntry.read');
  });

  it('authorizes the M2 T4 browser-preview methods and keeps getPreviewInfo internal', () => {
    // Phase 3 M2 T4 (on-demand screenshot v1): the browser shim polls
    // devBrowser.captureFrame and lazily ensures pages via
    // devBrowser.openPreviewPage; devBrowser.shutdown serves the desktop
    // quit-time clean fix through the same surface. Documented response
    // shapes (§5.4a): captureFrame → { data, width, height } | null —
    // base64 JPEG + CSS size, NEVER token material (the sidecar token stays
    // daemon-side); openPreviewPage → { targetId } | null; shutdown →
    // { stopped }. devBrowser.getPreviewInfo returns the raw CDP endpoint
    // and therefore stays OFF the allowlist (internal daemon↔desktop only).
    expect(RPC_METHOD_ALLOWLIST).toContain('devBrowser.openPreviewPage');
    expect(RPC_METHOD_ALLOWLIST).toContain('devBrowser.captureFrame');
    expect(RPC_METHOD_ALLOWLIST).toContain('devBrowser.shutdown');
    expect(RPC_METHOD_ALLOWLIST).not.toContain('devBrowser.getPreviewInfo');
  });

  it('authorizes the M2 T5 task.cancel-parity stop method (plan §6 M2 item 5)', () => {
    // task.stop is the daemon-native stop RPC daemon-routes registers first
    // ('task.cancel' is the desktop-IPC alias; both call the same
    // taskService.stopTask). The shim's cancelTask maps to 'task.cancel', so
    // task.stop backs nothing in the shim (SHIM_RPC_MAP) — the parity target
    // is MCP-driven flows. The response is void (result null), so no secret
    // material can ride it; the universal scrubber stays as defense in depth.
    expect(RPC_METHOD_ALLOWLIST).toContain('task.stop');
    expect(RPC_METHOD_ALLOWLIST).toContain('task.cancel');
    expect(RPC_METHOD_ALLOWLIST).toContain('task.interrupt');
  });

  it('pins the allowlist count (M2 tripwire — every addition needs §5.4 tests)', () => {
    // 62 M1 baseline + 21 M2 provider/model-management + masked-listing
    // entries (Phase 3 M2 T1a) + 2 T1b bedrock/vertex credential entries
    // (provider.validateCredentials + secrets.storeBedrockCredentials)
    // + 9 T2 skills/connector-CRUD entries (skills.addFromPath,
    // skills.addFromGitHub, skills.delete, connectors.list/upsert/
    // setEnabled/setStatus/delete/deleteTokens)
    // + 3 T4 browser-preview entries (devBrowser.openPreviewPage promotes
    // from M1's internal set to allowlisted; captureFrame + shutdown new).
    // + 1 T5 entry (task.stop — cancel-parity for MCP-driven flows; response
    // is void, no shim mapping).
    // This pin is deliberate: growing it further requires the §5.4
    // expansion policy — documented response shape, scrubber/no-secret-field
    // proof, paired authorization + redaction tests.
    expect(RPC_METHOD_ALLOWLIST).toHaveLength(98);
    expect(RPC_METHOD_BLOCKLIST).toHaveLength(7);
  });

  it('allows a custom allow set with the default blocklist intact', () => {
    const decision = checkMethodPolicy('custom.method', {
      allow: new Set(['custom.method']),
    });
    expect(decision).toEqual({ allowed: true });
  });
});
