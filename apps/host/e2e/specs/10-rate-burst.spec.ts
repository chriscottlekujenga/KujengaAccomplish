/**
 * Rate burst at the real gateway layer (plan §4 A): 1000 rapid authed
 * requests, none throttled under the 1500/60 s per-token budget.
 *
 * Note: the burst rides POST /rpc (daemon.ping) rather than GET /health —
 * /health is handled before auth + rate limiting by design (gateway.ts
 * serves it unauthenticated), so it can never exercise the limiter. /rpc
 * calls are counted by the per-token fixed-window limiter, which is the
 * behavior this spec pins. It runs FIRST in the serial suite so the 1000
 * request burst never overlaps other specs' traffic within its window.
 */

import { expect } from '@playwright/test';
import { test } from '../fixtures/gateway';

test.setTimeout(120_000);

const TOTAL_REQUESTS = 1000;
const BATCH_SIZE = 50;

interface BurstAttempt {
  status: number;
  ok: boolean;
}

test('1000 rapid authed /rpc requests: none throttled, all 200', async ({ chain }) => {
  const results: BurstAttempt[] = new Array(TOTAL_REQUESTS);

  for (let start = 0; start < TOTAL_REQUESTS; start += BATCH_SIZE) {
    const batch = Array.from(
      { length: Math.min(BATCH_SIZE, TOTAL_REQUESTS - start) },
      (_, offset) => offset + start,
    );
    await Promise.all(
      batch.map(async (index) => {
        const res = await fetch(`${chain.gatewayUrl}/rpc`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${chain.token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: index, method: 'daemon.ping' }),
        });
        results[index] = { status: res.status, ok: res.ok };
      }),
    );
  }

  const throttled = results.filter((r) => r.status === 429);
  const unauthorized = results.filter((r) => r.status === 401);
  const failed = results.filter((r) => !r.ok);
  expect(throttled, 'no 429 within the 1500/60s budget').toEqual([]);
  expect(unauthorized, 'no 401 for the bearer-authed requests').toEqual([]);
  expect(failed, 'every burst request succeeded').toEqual([]);

  // The gateway stays healthy right after the burst.
  const ping = (await chain.rpcCall('daemon.ping')) as { status?: string };
  expect(ping.status).toBe('ok');
});
