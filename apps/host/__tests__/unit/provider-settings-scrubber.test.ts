import { describe, expect, it } from 'vitest';
import { scrubSecretFields } from '../../src/provider-settings-scrubber.js';

describe('scrubSecretFields', () => {
  it('removes secret-looking fields at any depth', () => {
    const settings = {
      activeProviderId: 'custom',
      debugMode: false,
      connectedProviders: {
        custom: {
          providerId: 'custom',
          connectionStatus: 'connected',
          selectedModelId: 'custom/glm-5.3:cloud',
          credentials: {
            type: 'custom',
            baseUrl: 'https://ollama.com/v1',
            modelName: 'glm-5.3:cloud',
            hasApiKey: true,
            apiKey: 'SUPER-SECRET-KEY',
          },
          availableModels: [{ id: 'm1', name: 'M1' }],
        },
      },
    };
    const scrubbed = scrubSecretFields(settings) as typeof settings;
    const creds = scrubbed.connectedProviders.custom.credentials as Record<string, unknown>;
    expect(creds.apiKey).toBeUndefined();
    expect(creds.hasApiKey).toBe(true);
    expect(creds.type).toBe('custom');
    expect(scrubbed.connectedProviders.custom.providerId).toBe('custom');
  });

  it('keeps display-safe masked fields (keyPrefix, apiKeyPrefix)', () => {
    const scrubbed = scrubSecretFields({
      credentials: { type: 'api_key', keyPrefix: 'abcd' },
      nested: { apiKeyPrefix: 'ef01' },
    }) as { credentials: Record<string, unknown>; nested: Record<string, unknown> };
    expect(scrubbed.credentials.keyPrefix).toBe('abcd');
    expect(scrubbed.nested.apiKeyPrefix).toBe('ef01');
  });

  it('scrubs arrays and deeply nested objects', () => {
    const scrubbed = scrubSecretFields({
      list: [
        { ok: 1, refreshToken: 'r1' },
        { ok: 2, deep: { serviceAccountJson: '{...}' } },
      ],
    }) as { list: Array<Record<string, unknown>> };
    expect(JSON.stringify(scrubbed)).not.toContain('refreshToken');
    expect(JSON.stringify(scrubbed)).not.toContain('serviceAccountJson');
    expect(scrubbed.list).toHaveLength(2);
  });

  it('passes primitives and null through unchanged', () => {
    expect(scrubSecretFields('plain')).toBe('plain');
    expect(scrubSecretFields(42)).toBe(42);
    expect(scrubSecretFields(null)).toBeNull();
  });
});
