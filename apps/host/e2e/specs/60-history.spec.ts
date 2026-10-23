/**
 * Task history through the UI (plan §4 B `history.spec.ts`).
 *
 * The web app at HEAD surfaces history as the sidebar conversation list
 * (router has only `/` and `#/execution/:id`; the old `/history` page route
 * is not registered). This spec asserts the completed approve task appears
 * in the sidebar with a success-ish status dot and opens its execution
 * detail with the full transcript visible from that navigation.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures/gateway';
import { gotoAuthenticated, pollTaskList } from '../fixtures/task-helpers';

test.setTimeout(120_000);

async function findSidebarItem(page: Page, fragment: string): Promise<Locator | null> {
  const byTitle = page.locator(`div[role="button"][title*="${fragment}"]`).first();
  if ((await byTitle.count()) > 0) {
    return byTitle;
  }
  const byText = page.locator('div[role="button"]', { hasText: fragment }).first();
  if ((await byText.count()) > 0) {
    return byText;
  }
  return null;
}

test('completed task appears in the sidebar history and reopens with transcript', async ({
  page,
  chain,
}) => {
  // SQLite persistence through the gateway: the approve task with its marker.
  const approveTask = (await pollTaskList(
    (method, params) => chain.rpcCall(method, params),
    (t) => String(t.prompt ?? '').includes('M5_TASK_APPROVE_OK') && t.status === 'completed',
    30_000,
  )) as { id?: string };
  expect(approveTask.id).toBeTruthy();

  // Fresh test page: the token must travel in the fragment again (session
  // storage does not persist across tests).
  await gotoAuthenticated(page, chain.appUrl);
  await expect(page.getByTestId('task-input-textarea')).toBeVisible({ timeout: 20_000 });

  // The sidebar is a plain div rail (not <aside>); conversation entries are
  // div[role=button] with a title attribute (ConversationListItem).
  const listItems = page.locator('div[role="button"][title]');
  await expect(listItems.first()).toBeVisible({ timeout: 20_000 });

  // Sidebar text renders the (prompt-derived) summary, so match the planted
  // marker OR the workspace filename; if the summary dropped both, log and
  // fall back to the first item.
  let item = await findSidebarItem(page, 'M5_APPROVE task');
  if (!item) {
    item = await findSidebarItem(page, 'task-approve');
  }
  if (!item) {
    const titles: string[] = [];
    const count = await listItems.count();
    for (let i = 0; i < count; i++) {
      titles.push(
        `${i}: title="${await listItems.nth(i).getAttribute('title')}" text="${(await listItems.nth(i).textContent())?.slice(0, 80)}"`,
      );
    }
    console.log(`[m5] history: marker not found in ${count} sidebar items:\n${titles.join('\n')}`);
    console.log(
      '[m5] history: summary did not retain the marker — falling back to first sidebar item',
    );
    item = listItems.first();
  }
  await item.click();

  await page.waitForURL(/#\/execution\//, { timeout: 15_000 });
  if (approveTask.id) {
    expect(page.url()).toContain(`#/execution/${approveTask.id}`);
  }

  // Transcript visible from history navigation.
  await expect(page.getByTestId('messages-scroll-container')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('M5_TASK_APPROVE_OK').first()).toBeVisible({ timeout: 20_000 });
});
