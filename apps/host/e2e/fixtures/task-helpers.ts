/**
 * Shared page helpers for the real-task UI specs (Phase 3 M5 plan §4 B).
 *
 * The web UI is the same React app the Electron shell loads (HashRouter):
 * Home at `#/`, execution detail at `#/execution/<id>`. Terminal badge text
 * comes from `execution:status.*` locale strings (en: "Completed", "Failed",
 * "Cancelled", "Stopped", "Pending", "Waiting for permission").
 */

import { expect, type Locator, type Page } from '@playwright/test';

export const TERMINAL_BADGE_PATTERNS = ['completed', 'failed', 'stopped', 'cancelled'] as const;

export class ExecutionView {
  constructor(private readonly page: Page) {}

  get statusBadge(): Locator {
    return this.page.getByTestId('execution-status-badge');
  }

  get permissionCard(): Locator {
    return this.page.getByTestId('execution-permission-card');
  }

  get allowButton(): Locator {
    return this.page.getByTestId('permission-allow-button');
  }

  get denyButton(): Locator {
    return this.page.getByTestId('permission-deny-button');
  }

  get messagesScrollContainer(): Locator {
    return this.page.getByTestId('messages-scroll-container');
  }

  get cancelLink(): Locator {
    return this.page.getByTestId('start-new-task');
  }

  badgeText(): Promise<string> {
    return this.statusBadge.textContent().then((t) => (t ?? '').toLowerCase());
  }

  isTerminalBadgeText(text: string): boolean {
    return TERMINAL_BADGE_PATTERNS.some((pattern) => text.includes(pattern));
  }

  async waitForTerminalBadge(timeoutMs: number): Promise<string> {
    await this.statusBadge.waitFor({ state: 'visible', timeout: 20_000 });
    await this.page.waitForFunction(
      () => {
        const badge = document.querySelector('[data-testid="execution-status-badge"]');
        if (!badge) {
          return false;
        }
        const text = (badge.textContent ?? '').toLowerCase();
        return (
          text.includes('completed') ||
          text.includes('failed') ||
          text.includes('stopped') ||
          text.includes('cancelled')
        );
      },
      undefined,
      { timeout: timeoutMs },
    );
    const text = await this.badgeText();
    expect(this.isTerminalBadgeText(text)).toBe(true);
    return text;
  }

  async followUp(text: string): Promise<void> {
    const input = this.page.getByTestId('execution-follow-up-input');
    await input.fill(text);
    await input.press('Enter');
  }
}

export async function gotoAuthenticated(page: Page, appUrl: string): Promise<void> {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
}

export async function openExecutionTask(page: Page, taskId: string): Promise<void> {
  await page.goto(`${page.url().split('#')[0]}#/execution/${taskId}`, {
    waitUntil: 'domcontentloaded',
  });
}

/**
 * Submit a task from Home and wait for navigation to the execution page.
 * Returns the task id parsed from the `#/execution/<id>` URL.
 */
export async function submitHomeTask(page: Page, prompt: string): Promise<string> {
  const input = page.getByTestId('task-input-textarea');
  await expect(input).toBeVisible();
  await input.fill(prompt);
  const submit = page.getByTestId('task-input-submit');
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.waitForURL(/#\/execution\//, { timeout: 30_000 });
  const match = page.url().match(/#\/execution\/([^#?]+)/);
  if (!match) {
    throw new Error(`execution URL did not contain a task id: ${page.url()}`);
  }
  return decodeURIComponent(match[1]);
}

export type PermissionDecision = 'allow' | 'deny';

/**
 * Drive the permission card once it appears; returns the decision that was
 * submitted. Resolves false when no card appears within `waitForCardMs` and
 * the task runs without needing a UI permission.
 */
export async function respondToPermission(
  view: ExecutionView,
  decision: PermissionDecision,
  waitForCardMs = 90_000,
): Promise<boolean> {
  const appeared = await view.permissionCard
    .waitFor({ state: 'visible', timeout: waitForCardMs })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    return false;
  }
  if (decision === 'allow') {
    await view.allowButton.click();
  } else {
    await view.denyButton.click();
  }
  return true;
}

/**
 * Approval loop for the real LLM task: approve every permission card the
 * agent raises until the badge reaches a terminal state. glm frequently
 * needs several per-command approvals.
 *
 * Anti-double-respond: a re-click only happens when the card TEXT changed
 * (a fresh request arrived). A stuck identical card after a click means the
 * respond RPC rejected client-side — log the console + page errors and stop.
 */
export async function approveUntilTerminal(
  page: Page,
  view: ExecutionView,
  overallTimeoutMs = 230_000,
): Promise<string> {
  const deadline = Date.now() + overallTimeoutMs;
  const pageErrors: string[] = [];
  const consoleListener = (message: import('@playwright/test').ConsoleMessage): void => {
    if (message.type() === 'error' || message.type() === 'warning') {
      pageErrors.push(`${message.type()}: ${message.text()}`);
    }
  };
  page.on('console', consoleListener);

  const cardText = async (): Promise<string> => {
    return (await view.permissionCard.textContent().catch(() => null)) ?? '';
  };

  try {
    let iterations = 0;
    let lastClickedCardText = '';
    while (Date.now() < deadline) {
      let badgeText = await view.badgeText();
      if (view.isTerminalBadgeText(badgeText)) {
        return badgeText;
      }
      const appeared = await view.permissionCard
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (appeared) {
        const currentText = await cardText();
        if (currentText !== lastClickedCardText) {
          iterations++;
          if (iterations > 20) {
            throw new Error(`permission card still cycling after ${iterations} approvals`);
          }
          console.log(
            `[m5] approve iteration ${iterations}: ${(currentText || '').slice(0, 180).replace(/\s+/g, ' ')}`,
          );
          await view.allowButton.click();
          lastClickedCardText = currentText;
          // Wait for one of: card cleared (respond resolved + no follow-up
          // request), a NEW request replacing the card content (opencode
          // asks per-tool: external_directory → bash → …), or termination.
          await expect
            .poll(
              async () => {
                if (view.isTerminalBadgeText(await view.badgeText())) {
                  return true;
                }
                const stillVisible = await view.permissionCard.isVisible().catch(() => false);
                if (!stillVisible) {
                  return true;
                }
                return (await cardText()) !== lastClickedCardText;
              },
              { timeout: 120_000, intervals: [1_000] },
            )
            .toBe(true);
          continue;
        }
        // Same card still up after our click — the respond RPC must have
        // failed; surface the collected console errors for diagnosis.
        if (pageErrors.length > 0) {
          console.log(
            `[m5] page console errors while card stuck:\n${pageErrors.slice(-10).join('\n')}`,
          );
        }
      }
      badgeText = await view.badgeText();
      if (view.isTerminalBadgeText(badgeText)) {
        return badgeText;
      }
    }
    throw new Error(`task did not reach a terminal state within ${overallTimeoutMs} ms`);
  } finally {
    page.off('console', consoleListener);
  }
}

/** Poll the task list RPC until a task id matches a predicate. */
export async function pollTaskList(
  rpcCall: (method: string, params?: unknown) => Promise<unknown>,
  predicate: (task: Record<string, unknown>) => boolean,
  timeoutMs: number,
  intervalMs = 3_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = (await rpcCall('task.list', {})) as unknown[];
      const match = result.find((entry) => predicate(entry as Record<string, unknown>));
      if (match) {
        return match as Record<string, unknown>;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `task.list never produced a matching task within ${timeoutMs} ms${lastError ? ` (last error: ${String(lastError)})` : ''}`,
  );
}

export async function waitForTaskTerminalStatus(
  rpcCall: (method: string, params?: unknown) => Promise<unknown>,
  taskId: string,
  timeoutMs: number,
  intervalMs = 4_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const seen: string[] = [];
  while (Date.now() < deadline) {
    try {
      const result = (await rpcCall('task.status', { taskId })) as { status?: string };
      const status = result?.status ?? 'unknown';
      if (seen[seen.length - 1] !== status) {
        seen.push(status);
      }
      if (
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'interrupted'
      ) {
        if (seen.length > 1) {
          console.log(`[m5] task ${taskId} status transitions: ${seen.join(' → ')}`);
        }
        return status;
      }
    } catch {
      /* transient RPC failure — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `task ${taskId} never reached a terminal status within ${timeoutMs} ms (saw: ${seen.join(', ')})`,
  );
}
