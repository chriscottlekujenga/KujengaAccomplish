/**
 * Secrets never cross the browser trust boundary (plan §4 C
 * `secrets-redaction.spec.ts`) — browser-layer redaction proof.
 *
 * Seeds a fake custom provider whose plaintext key sk-test-M5REDACTED12345
 * is stored one-way in the isolated daemon's secret storage, then records
 * every POST /rpc response body through Playwright network interception
 * while the UI loads home + settings providers. The literal key must never
 * appear in any response body or in the page DOM.
 */

import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from '../fixtures/gateway';
import type { GatewayChain } from '../fixtures/gateway';
import { gotoAuthenticated } from '../fixtures/task-helpers';

test.setTimeout(150_000);

const FAKE_KEY = 'sk-test-M5REDACTED12345';

// Late in the serial suite the gateway's per-token fixed-window rate budget
// (1500 req/60 s, rate-limit.ts) can already be drained by 10-rate-burst +
// task-spec traffic, so restore RPCs may hit a 429 that only a window reset
// clears — the backoff schedule must span one full window, not milliseconds.
const RPC_RETRY_BACKOFFS_MS = [500, 2_000, 10_000, 20_000, 30_000];

async function rpcCallWithRetry(
  chain: GatewayChain,
  method: string,
  params?: unknown,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chain.rpcCall(method, params);
    } catch (err) {
      const backoff = RPC_RETRY_BACKOFFS_MS[attempt];
      if (backoff === undefined) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

test('no raw secret values in /rpc responses or DOM during settings browsing', async ({
  page,
  chain,
}) => {
  const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'setup-dev-provider.mjs');
  execFileSync(
    process.execPath,
    [
      scriptPath,
      '--provider',
      'custom',
      '--api-key',
      FAKE_KEY,
      '--base-url',
      'https://ollama.com/v1',
      '--model',
      'glm-5.3:cloud',
      '--data-dir',
      chain.dataDir,
    ],
    { timeout: 60_000, stdio: 'pipe' },
  );

  const recordedBodies: string[] = [];
  let recordedCount = 0;
  await page.route('**/rpc', async (route) => {
    let body: string;
    let response: import('@playwright/test').APIResponse;
    try {
      response = await route.fetch();
      body = await response.text();
      recordedBodies.push(body);
      recordedCount++;
      await route.fulfill({
        status: response.status(),
        headers: { 'content-type': response.headers()['content-type'] ?? 'application/json' },
        body,
      });
      return;
    } catch {
      // The page/context can dissolve while a fetch/fulfill is in flight
      // (teardown race). Drain the route with a best-effort abort — a bare
      // throw here left the route undrained and stalled context teardown
      // past the test timeout (suite serial-chain hang, ~2 min wall).
      await route.abort().catch(() => undefined);
    }
  });

  // The seeding RPCs resolve when the daemon handles the mutations; durable
  // persisted state lands asynchronously. In a busy serial chain a single-shot
  // read could race that window, so the UI loads only once the daemon itself
  // reports the seeded state.
  await expect
    .poll(
      async () => {
        try {
          const settings = (await chain.rpcCall('provider.getSettings')) as {
            activeProviderId?: string;
            connectedProviders?: Record<string, { connectionStatus?: string }>;
          };
          const selected = (await chain.rpcCall('settings.getSelectedModel')) as {
            provider?: string;
            model?: string;
          };
          if (
            settings.activeProviderId === 'custom' &&
            settings.connectedProviders?.custom?.connectionStatus === 'connected' &&
            selected.provider === 'custom' &&
            selected.model === 'custom/glm-5.3:cloud'
          ) {
            return true;
          }
          return null;
        } catch {
          return null;
        }
      },
      { timeout: 75_000, intervals: [500, 1_000] },
    )
    .toBe(true);

  await gotoAuthenticated(page, chain.appUrl);
  await expect(page.getByTestId('task-input-textarea')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('sidebar-settings-button').click();
  const dialog = page.getByTestId('settings-dialog').first();
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  // Browse the providers tab (custom provider now exists) and a second tab
  // to generate genuine scrubbed responses.
  await expect(dialog.getByTestId('provider-card-custom')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByTestId('provider-connected-badge-custom')).toBeVisible();
  await dialog.getByRole('button', { name: 'General' }).click();
  await expect(dialog.getByRole('button', { name: 'General' })).toHaveClass(/text-foreground/, {
    timeout: 20_000,
  });

  const dom = await page.content();
  expect(dom, 'DOM must not contain the plaintext key').not.toContain(FAKE_KEY);

  expect(recordedCount, 'the session recorded /rpc responses').toBeGreaterThan(0);
  const leaked = recordedBodies.filter((body) => body.includes(FAKE_KEY));
  expect(
    leaked,
    `plaintext key leaked in ${leaked.length} of ${recordedBodies.length} response bodies`,
  ).toEqual([]);

  // Sanity: masked metadata did cross (the custom provider row was fetched),
  // proving the interception actually captured provider traffic.
  expect(
    recordedBodies.some((body) => body.includes('custom')),
    'provider traffic recorded through the interceptor',
  ).toBe(true);

  // Restore: put ollama back in charge so the presence spec runs real ollama
  // tasks. Each mutation returns before its persistence/notify settle, so the
  // read-back is polled to a settled state instead of asserted immediately
  // (the old single read raced that window under serial-chain load).
  await rpcCallWithRetry(chain, 'provider.setActive', { providerId: 'ollama' });
  await rpcCallWithRetry(chain, 'provider.removeConnected', { providerId: 'custom' });
  await rpcCallWithRetry(chain, 'secrets.deleteApiKey', { provider: 'custom' });
  await rpcCallWithRetry(chain, 'settings.setSelectedModel', {
    model: { provider: 'ollama', model: 'ollama/glm-5.3:cloud' },
  });

  await expect
    .poll(
      async () => {
        try {
          const settled = (await chain.rpcCall('provider.getSettings')) as {
            activeProviderId?: string;
            connectedProviders?: Record<string, unknown>;
          };
          const selected = (await chain.rpcCall('settings.getSelectedModel')) as {
            provider?: string;
            model?: string;
          };
          if (
            settled.activeProviderId === 'ollama' &&
            settled.connectedProviders?.custom === undefined &&
            selected.provider === 'ollama' &&
            selected.model === 'ollama/glm-5.3:cloud'
          ) {
            return true;
          }
          return null;
        } catch {
          return null;
        }
      },
      { timeout: 75_000, intervals: [500, 1_000] },
    )
    .toBe(true);
});
