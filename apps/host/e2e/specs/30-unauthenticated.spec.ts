/**
 * Unauthenticated access is rejected at every layer (plan §4 A
 * `unauthenticated.spec.ts`):
 *   - browser: a page opened WITHOUT the token fragment shows the
 *     shell-access error state ("opened without a session token"), not the
 *     app (App.tsx checkStatus → errors:app.openViaLauncher)
 *   - HTTP: POST /rpc with no bearer → 401; wrong token → 401
 *   - policy: blocklisted secrets methods → 403 even WITH the right token
 *   - WS /events: first-message auth with a wrong token → close 4401, no
 *     auth-ok
 */

import { expect } from '@playwright/test';
import { test } from '../fixtures/gateway';

test.setTimeout(60_000);

test('page without token fragment shows the shell-access error state', async ({ page, chain }) => {
  await page.goto(`${chain.gatewayUrl}/`, { waitUntil: 'domcontentloaded' });

  // App.checkStatus: no shell API + loopback HTTP origin →
  // t('errors:app.openViaLauncher') below the "Unable to Start" heading.
  await expect(
    page.getByText('This page was opened without a session token', { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Unable to Start', { exact: true })).toBeVisible();
  await expect(page.getByTestId('task-input-textarea')).toHaveCount(0);
});

test('POST /rpc without bearer → 401; with wrong token → 401', async ({ chain }) => {
  const noAuth = await fetch(`${chain.gatewayUrl}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemon.ping' }),
  });
  expect(noAuth.status).toBe(401);

  const wrongToken = await fetch(`${chain.gatewayUrl}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${'0'.repeat(64)}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemon.ping' }),
  });
  expect(wrongToken.status).toBe(401);
});

test('blocklisted secrets methods → 403 even when authenticated', async ({ chain }) => {
  for (const method of ['secrets.getApiKey', 'secrets.getAllApiKeys']) {
    const res = await fetch(`${chain.gatewayUrl}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${chain.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { provider: 'ollama' } }),
    });
    expect(res.status, `${method} must be 403 (blocklist)`).toBe(403);
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message).toContain('blocked');
  }
});

test('WS /events first-message auth with wrong token → closed, no auth-ok', async ({ chain }) => {
  const { openEvents } = chain;
  // openEvents resolves on auth-ok; with a wrong token the gateway closes
  // the socket (4401) within the 5s auth window and the helper rejects.
  await expect(
    (async () => {
      const session = await openEvents('0'.repeat(64));
      session.close();
    })(),
  ).rejects.toThrow(/closed|auth/i);

  // Sanity: the correct token still authenticates.
  const session = await openEvents();
  try {
    await session.nextMessage((m) => m.type === 'auth-ok', 3_000);
  } finally {
    session.close();
  }
});
