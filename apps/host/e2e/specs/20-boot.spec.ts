/**
 * Boot & auth over the gateway (plan §4 A `boot.spec.ts`). Playwright runs
 * spec files alphabetically, so the numeric prefix pins the boot check to
 * the front of the serial suite while keeping the plan's file name.
 *
 * Asserts:
 *   - the launcher-contract URL loads the real UI (Home renders)
 *   - the token was captured from the fragment and STRIPPED from the URL
 *     (sessionStorage hand-off, gateway-bootstrap.ts)
 *   - daemon.ping alive through POST /rpc
 *   - onboarding auto-completed by the UI's App.checkStatus
 *     (settings.setOnboardingComplete is fired before status 'ready')
 */

import { expect } from '@playwright/test';
import { test } from '../fixtures/gateway';
import { gotoAuthenticated } from '../fixtures/task-helpers';

test.setTimeout(60_000);

test('gateway URL renders the app, strips the token fragment, daemon alive, onboarding complete', async ({
  page,
  chain,
}) => {
  await gotoAuthenticated(page, chain.appUrl);

  // The UI installs the HTTP shim only after capturing a valid token; the
  // Home page renders the task input once checkStatus resolves 'ready'.
  const taskInput = page.getByTestId('task-input-textarea');
  await expect(taskInput).toBeVisible({ timeout: 20_000 });

  // Token stripped from the fragment: history.replaceState removed it before
  // the router saw it; the URL must not leak the bearer token anywhere.
  expect(page.url()).not.toContain(chain.token);
  expect(page.url().split('#')[1] ?? '').not.toContain('token=');
  const stored = await page.evaluate(() =>
    window.sessionStorage.getItem('accomplish.gateway-token'),
  );
  expect(stored).toBe(chain.token);

  // Gateway + daemon reachable over the same surface the browser uses.
  const ping = (await chain.rpcCall('daemon.ping')) as { status?: string };
  expect(ping.status).toBe('ok');

  // App.checkStatus called settings.setOnboardingComplete(true) before
  // rendering 'ready'; the app settings snapshot must reflect it.
  const settings = (await chain.rpcCall('settings.getAll')) as {
    app?: { onboardingComplete?: boolean };
  };
  expect(settings.app?.onboardingComplete).toBe(true);
});
