import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StorageAPI } from '@accomplish_ai/agent-core';
import { SecretsService } from '../../src/secrets-service.js';

/**
 * Milestone 2 — SecretsService is a thin pass-through; the tests exist to
 * guarantee that every RPC-facing method reaches the same StorageAPI method
 * it documents, and no extra side-effects slip in later.
 */
function makeStorageStub(): StorageAPI {
  return {
    storeApiKey: vi.fn(),
    getApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    getAllApiKeys: vi.fn(async () => ({}) as Record<string, string | null>),
    hasAnyApiKey: vi.fn(async () => false),
    storeBedrockCredentials: vi.fn(),
    getBedrockCredentials: vi.fn(),
    clearSecureStorage: vi.fn(),
  } as unknown as StorageAPI;
}

describe('SecretsService', () => {
  let storage: StorageAPI;
  let service: SecretsService;

  beforeEach(() => {
    storage = makeStorageStub();
    service = new SecretsService(storage);
  });

  it('forwards storeApiKey to storage with provider + key', () => {
    service.storeApiKey('anthropic', 'sk-ant-test');
    expect(storage.storeApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-test');
  });

  it('forwards getApiKey and returns the storage result', () => {
    vi.mocked(storage.getApiKey).mockReturnValue('sk-existing');
    expect(service.getApiKey('anthropic')).toBe('sk-existing');
    expect(storage.getApiKey).toHaveBeenCalledWith('anthropic');
  });

  it('forwards getApiKey and returns null when storage returns null', () => {
    vi.mocked(storage.getApiKey).mockReturnValue(null);
    expect(service.getApiKey('anthropic')).toBeNull();
  });

  it('forwards deleteApiKey and returns the storage boolean', () => {
    vi.mocked(storage.deleteApiKey).mockReturnValue(true);
    expect(service.deleteApiKey('openai')).toBe(true);
    expect(storage.deleteApiKey).toHaveBeenCalledWith('openai');
  });

  it('forwards getAllApiKeys (async) through to storage', async () => {
    vi.mocked(storage.getAllApiKeys).mockResolvedValue({ anthropic: 'sk-xyz', openai: null });
    await expect(service.getAllApiKeys()).resolves.toEqual({
      anthropic: 'sk-xyz',
      openai: null,
    });
  });

  it('forwards hasAnyApiKey (async) through to storage', async () => {
    vi.mocked(storage.hasAnyApiKey).mockResolvedValue(true);
    await expect(service.hasAnyApiKey()).resolves.toBe(true);
  });

  it('forwards storeBedrockCredentials with the raw payload', () => {
    service.storeBedrockCredentials('{"accessKeyId":"...","secretAccessKey":"..."}');
    expect(storage.storeBedrockCredentials).toHaveBeenCalledWith(
      '{"accessKeyId":"...","secretAccessKey":"..."}',
    );
  });

  it('forwards getBedrockCredentials and returns the storage map', () => {
    vi.mocked(storage.getBedrockCredentials).mockReturnValue({
      accessKeyId: 'AKIA',
      secretAccessKey: 'sekr3t',
    });
    expect(service.getBedrockCredentials()).toEqual({
      accessKeyId: 'AKIA',
      secretAccessKey: 'sekr3t',
    });
  });

  it('clear() forwards to storage.clearSecureStorage()', () => {
    service.clear();
    expect(storage.clearSecureStorage).toHaveBeenCalledTimes(1);
  });
});

describe('SecretsService.listApiKeysMasked (Phase 3 M2 masked read)', () => {
  let storage: StorageAPI;
  let service: SecretsService;

  beforeEach(() => {
    storage = makeStorageStub();
    service = new SecretsService(storage);
  });

  it('maps stored keys to { exists: true, prefix } with a 4-char prefix', async () => {
    vi.mocked(storage.getAllApiKeys).mockResolvedValue({
      anthropic: 'sk-ant-abcdefghijklmnop',
      openai: null,
    });
    await expect(service.listApiKeysMasked()).resolves.toEqual({
      anthropic: { exists: true, prefix: 'sk-a' },
      openai: { exists: false },
    });
  });

  it('NEVER includes plaintext values — every entry exposes only exists/prefix', async () => {
    const SECRET = 'sk-super-secret-plaintext-value-9999';
    vi.mocked(storage.getAllApiKeys).mockResolvedValue({
      anthropic: SECRET,
      openai: null,
      litellm: 'another-plaintext-key',
    });
    const masked = await service.listApiKeysMasked();
    const json = JSON.stringify(masked);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('another-plaintext-key');
    for (const entry of Object.values(masked)) {
      expect(Object.keys(entry).sort()).toEqual(
        ['exists', 'prefix'].slice(0, Object.keys(entry).length),
      );
      if ('prefix' in entry) {
        expect(entry.prefix?.length).toBe(4);
      }
    }
  });

  it('a 4-char prefix matches the shim-side local derivation convention', async () => {
    // accomplish-http.ts `addApiKey` derives `key.slice(0, 4)` locally — this
    // masked read must hand back the same prefix shape for the same key.
    const key = 'abcdEFGH-remainder';
    vi.mocked(storage.getAllApiKeys).mockResolvedValue({ anthropic: key, openai: null });
    const masked = await service.listApiKeysMasked();
    expect(masked.anthropic).toEqual({ exists: true, prefix: key.slice(0, 4) });
  });

  it('absent keys carry no prefix at all', async () => {
    vi.mocked(storage.getAllApiKeys).mockResolvedValue({ anthropic: null, openai: null });
    const masked = await service.listApiKeysMasked();
    expect(masked.anthropic).toEqual({ exists: false });
    expect('prefix' in masked.anthropic).toBe(false);
  });
});
