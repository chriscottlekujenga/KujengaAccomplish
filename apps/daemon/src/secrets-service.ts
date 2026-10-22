/**
 * SecretsService — thin wrapper around the daemon's `SecureStorageAPI` surface.
 *
 * Milestone 2 of the daemon-only-SQLite migration
 * (plan: /Users/yanai/.claude/plans/squishy-exploring-hamster.md).
 *
 * Exposes the read/write API for the encrypted `secure-storage.json` so the
 * desktop can route secret ops through the daemon. Main is the only writer
 * post-M3; this service is the endpoint. No events — secrets aren't
 * subscribed to by the renderer, and the few places that need to react to a
 * secret change already go through explicit IPC calls.
 *
 * NOTE: only exposes API-key / Bedrock / clear operations. The low-level
 * generic `set`/`get` on `SecureStorageAPI` is intentionally NOT proxied —
 * callers should use the typed methods so we keep a clean contract and can
 * reason about which keys live in the encrypted file.
 */
import type { StorageAPI } from '@accomplish_ai/agent-core';

/** Masked per-provider key info — the ONLY key-shaped shape that may cross
 *  the RPC boundary as a read. `prefix` is a 4-char display fragment
 *  (matching the shim-side local prefix derivation); the plaintext value is
 *  never included. */
export interface MaskedApiKeyInfo {
  exists: boolean;
  prefix?: string;
}

export class SecretsService {
  constructor(private readonly storage: StorageAPI) {}

  storeApiKey(provider: string, apiKey: string): void {
    this.storage.storeApiKey(provider, apiKey);
  }

  getApiKey(provider: string): string | null {
    return this.storage.getApiKey(provider);
  }

  deleteApiKey(provider: string): boolean {
    return this.storage.deleteApiKey(provider);
  }

  async getAllApiKeys(): Promise<Record<string, string | null>> {
    return this.storage.getAllApiKeys();
  }

  /**
   * Masked sibling of `getAllApiKeys` (Phase 3 M2): safe to serve over the
   * gateway as `secrets.listApiKeys`. Maps the plaintext provider → key
   * record down to `{ exists, prefix? }` entries; the plaintext value never
   * leaves this method.
   */
  async listApiKeysMasked(): Promise<Record<string, MaskedApiKeyInfo>> {
    const keys = await this.getAllApiKeys();
    const masked: Record<string, MaskedApiKeyInfo> = {};
    for (const [provider, key] of Object.entries(keys)) {
      masked[provider] = key ? { exists: true, prefix: key.slice(0, 4) } : { exists: false };
    }
    return masked;
  }

  async hasAnyApiKey(): Promise<boolean> {
    return this.storage.hasAnyApiKey();
  }

  storeBedrockCredentials(credentials: string): void {
    this.storage.storeBedrockCredentials(credentials);
  }

  getBedrockCredentials(): Record<string, string> | null {
    return this.storage.getBedrockCredentials();
  }

  clear(): void {
    this.storage.clearSecureStorage();
  }
}
