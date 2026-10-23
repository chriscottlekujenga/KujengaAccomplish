/**
 * Settings page over the gateway (plan §4 B `settings.spec.ts`).
 *
 * The settings surface is the SettingsDialog opened from the sidebar gear.
 * Non-secret round-trip chosen: the theme selector (General tab) —
 * `settings.setTheme` / `settings.getAll` are both allowlisted and the
 * UI control is a plain dropdown. Verified UI → RPC → UI (reload) → RPC.
 */

import { expect } from '@playwright/test';
import { test } from '../fixtures/gateway';
import { gotoAuthenticated } from '../fixtures/task-helpers';

test.setTimeout(90_000);

async function openSettingsGeneralTab(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('sidebar-settings-button').click();
  const dialog = page.getByTestId('settings-dialog').first();
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'General' }).click();
  const themeTrigger = page
    .getByRole('button')
    .filter({ hasText: /^(System|Light|Dark)$/ })
    .first();
  await expect(themeTrigger).toBeVisible({ timeout: 20_000 });
}

test('theme change round-trips UI → RPC → UI(reload) without error toasts', async ({
  page,
  chain,
}) => {
  await gotoAuthenticated(page, chain.appUrl);
  await expect(page.getByTestId('task-input-textarea')).toBeVisible({ timeout: 20_000 });

  const settingsBefore = (await chain.rpcCall('settings.getAll')) as {
    app?: { theme?: string };
  };
  const originalTheme = settingsBefore.app?.theme ?? 'system';
  const targetTheme = originalTheme === 'dark' ? 'light' : 'dark';

  await openSettingsGeneralTab(page);
  const themeTrigger = page
    .getByRole('button')
    .filter({ hasText: /^(System|Light|Dark)$/ })
    .first();
  await themeTrigger.click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${targetTheme}$`, 'i') }).click();

  // UI reflects the optimistic change immediately.
  await expect
    .poll(async () => themeTrigger.textContent(), { timeout: 10_000 })
    .toMatch(new RegExp(targetTheme, 'i'));

  // No error toasts appeared while the dialog is open.
  await expect(page.getByTestId('auth-error-toast')).toHaveCount(0);
  await expect(page.getByTestId('daemon-connection-toast')).toHaveCount(0);

  // RPC persistence through the allowlisted setter.
  const settingsAfter = (await chain.rpcCall('settings.getAll')) as {
    app?: { theme?: string };
  };
  expect(settingsAfter.app?.theme).toBe(targetTheme);

  // UI reflection after a full reload (fresh page state, sessionStorage
  // retains the token through reloads on the same origin).
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('task-input-textarea')).toBeVisible({ timeout: 20_000 });
  await openSettingsGeneralTab(page);
  const reloadedTrigger = page
    .getByRole('button')
    .filter({ hasText: /^(System|Light|Dark)$/ })
    .first();
  await expect
    .poll(async () => reloadedTrigger.textContent(), { timeout: 10_000 })
    .toMatch(new RegExp(targetTheme, 'i'));

  // Leave the instance in its original state.
  await reloadedTrigger.click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${originalTheme}$`, 'i') }).click();
  const settingsRestored = (await chain.rpcCall('settings.getAll')) as {
    app?: { theme?: string };
  };
  expect(settingsRestored.app?.theme).toBe(originalTheme);

  // Close the dialog cleanly.
  await page.getByTestId('settings-done-button').click();
  await expect(page.getByTestId('settings-dialog').first()).toBeHidden({ timeout: 10_000 });
});
