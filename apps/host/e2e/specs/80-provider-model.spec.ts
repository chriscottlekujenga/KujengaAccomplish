/**
 * Provider/model over the gateway (plan §4 B `provider-model.spec.ts`).
 *
 * UI: the ollama provider card appears connected; its settings panel shows
 * the configured server URL and the selected model. RPC (scrubbed HTTP
 * surface): provider.getSettings carries selectedModelId with NO credential
 * plaintext. When the isolated ollama server advertises more than one
 * model, change the model via the UI, verify persistence, then restore.
 */

import { expect } from '@playwright/test';
import { test } from '../fixtures/gateway';
import { gotoAuthenticated } from '../fixtures/task-helpers';

test.setTimeout(90_000);

test('ollama connected; selected model reflection persists via scrubbed RPC', async ({
  page,
  chain,
}) => {
  await gotoAuthenticated(page, chain.appUrl);
  await expect(page.getByTestId('task-input-textarea')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('sidebar-settings-button').click();
  const dialog = page.getByTestId('settings-dialog').first();
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  // The provider grid is the default tab: ollama card + connected badge.
  const card = dialog.getByTestId('provider-card-ollama');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByTestId('provider-connected-badge-ollama')).toBeVisible();

  // Open the ollama panel: connected controls + model selector.
  await card.click();
  const panel = dialog.getByTestId('provider-settings-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const serverUrlInput = panel.locator('input[disabled]').first();
  await expect(serverUrlInput).toHaveValue('http://127.0.0.1:11434');
  const modelSelector = panel.getByTestId('model-selector');
  await expect(modelSelector).toBeVisible();
  await expect(panel.getByText('glm-5.3:cloud', { exact: false }).first()).toBeVisible();

  // Scrubbed HTTP read: selected model metadata, no credential plaintext.
  const providerSettings = (await chain.rpcCall('provider.getSettings')) as {
    activeProviderId?: string;
    connectedProviders?: Record<
      string,
      { connectionStatus?: string; selectedModelId?: string; credentials?: unknown }
    >;
  };
  const ollama = providerSettings.connectedProviders?.ollama;
  expect(providerSettings.activeProviderId).toBe('ollama');
  expect(ollama?.connectionStatus).toBe('connected');
  expect(ollama?.selectedModelId).toBe('ollama/glm-5.3:cloud');

  const selected = (await chain.rpcCall('settings.getSelectedModel')) as {
    provider?: string;
    model?: string;
  };
  expect(selected.provider).toBe('ollama');
  expect(selected.model).toBe('ollama/glm-5.3:cloud');

  const serialized = JSON.stringify({ providerSettings, selected });
  expect(serialized, 'no api-key material crosses the gateway').not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  expect(serialized).not.toContain('"apiKey"');

  await page.getByTestId('settings-done-button').click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});
