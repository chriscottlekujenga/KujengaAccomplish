/**
 * Shared test fixtures for gateway unit tests. This file is NOT a test file
 * (the vitest include pattern only matches *.test.ts) — exporting helpers
 * from a test module would double-register its describe blocks in any file
 * that imports it.
 */

export interface RecordedCall {
  method: string;
  params?: unknown;
}

export function createFakeRpc(results: Record<string, unknown> = {}) {
  const calls: RecordedCall[] = [];
  const rpc = {
    calls,
    async call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params });
      if (method in results) {
        const result = results[method];
        if (result instanceof Error) {
          throw result;
        }
        return result;
      }
      return { echoed: method };
    },
  };
  return rpc;
}
