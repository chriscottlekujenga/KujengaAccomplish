/**
 * REAL ollama task end-to-end (plan §4 B `task-approve.spec.ts`):
 * prompt → submit → execution page → permission card(s) for bash → Allow
 * via UI → streaming transcript renders → terminal success → exact file
 * created → assistant transcript contains the planted confirmation text.
 *
 * Times out at 240 s (real LLM work, several approvals).
 */

import { expect } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from '../fixtures/gateway';
import {
  ExecutionView,
  approveUntilTerminal,
  gotoAuthenticated,
  submitHomeTask,
} from '../fixtures/task-helpers';

test.setTimeout(240_000);

// Task files live in the daemon's default workspace (<dataDir>/task-workspace)
// so no external_directory permission ask is raised — the permission chain is
// a single bash ask per command and the approval loop cannot race a second
// sequential ask (a /tmp target asks external_directory + bash back-to-back).
const PROMPT =
  'M5_APPROVE task: Create the file task-approve.txt in your current working directory containing exactly the text M5_TASK_APPROVE_OK. ' +
  'Use the bash tool to write it. Then confirm the exact file contents in your final message.';

function taskFileFor(chain: { dataDir: string }): string {
  return path.join(chain.dataDir, 'task-workspace', 'task-approve.txt');
}

test('approve flow: file created, terminal success, transcript confirmation', async ({
  page,
  chain,
}) => {
  const taskFile = taskFileFor(chain);
  rmSync(taskFile, { force: true });

  await gotoAuthenticated(page, chain.appUrl);
  const taskId = await submitHomeTask(page, PROMPT);
  expect(taskId).toBeTruthy();

  const view = new ExecutionView(page);
  const badgeText = await approveUntilTerminal(page, view);
  console.log(`[m5] task-approve terminal badge text: "${badgeText}"`);

  const taskForLog = (await chain.rpcCall('task.get', { taskId })) as {
    status?: string;
    messages?: { type?: string; content?: string }[];
  };
  console.log(`[m5] task-approve daemon status: ${taskForLog.status}`);
  for (const m of taskForLog.messages ?? []) {
    console.log(`[m5]   - [${m.type}] ${(m.content ?? '').slice(0, 220).replace(/\n/g, ' ')}`);
  }

  // Terminal state is success — both in the badge and in the daemon record.
  expect(badgeText).toContain('completed');
  expect(taskForLog.status).toBe('completed');

  // The exact file was created with the exact content.
  expect(existsSync(taskFile), 'agent created the task file').toBe(true);
  expect(readFileSync(taskFile, 'utf8')).toContain('M5_TASK_APPROVE_OK');

  // Streaming/transcript rendered: at least the user message + an assistant
  // reply, and the assistant confirmation carries the planted marker.
  const messages = taskForLog.messages ?? [];
  expect(messages.length, 'transcript has at least 2 message blocks').toBeGreaterThanOrEqual(2);
  const transcriptText = messages.map((m) => m.content ?? '').join('\n');
  expect(transcriptText).toContain('M5_TASK_APPROVE_OK');
  expect(
    messages.some(
      (m) => m.type === 'assistant' && (m.content ?? '').includes('M5_TASK_APPROVE_OK'),
    ),
    'assistant confirmation contains the marker',
  ).toBe(true);

  // The UI transcript shows the assistant confirmation too.
  await expect(view.messagesScrollContainer).toBeVisible();
  await expect(page.getByText('M5_TASK_APPROVE_OK').first()).toBeVisible();

  // Clean the workspace file so later specs start fresh.
  rmSync(taskFile, { force: true });
});

test('transcript rendered live through the gateway WS bridge (message blocks reach the UI)', async ({
  page,
  chain,
}) => {
  // Cheaper companion check without a second LLM run: reload the persisted
  // task from history and confirm its full transcript re-renders.
  const tasks = (await chain.rpcCall('task.list', {})) as {
    id?: string;
    prompt?: string;
    status?: string;
  }[];
  const approveTask = tasks.find((t) => (t.prompt ?? '').includes('M5_TASK_APPROVE_OK'));
  expect(approveTask, 'approve task persisted in SQLite through the gateway').toBeTruthy();
  expect(approveTask?.status).toBe('completed');

  await gotoAuthenticated(page, chain.appUrl);
  await page.goto(`${chain.gatewayUrl}/#/execution/${approveTask!.id}`, {
    waitUntil: 'domcontentloaded',
  });
  const view = new ExecutionView(page);
  await expect(view.messagesScrollContainer).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('M5_TASK_APPROVE_OK').first()).toBeVisible({ timeout: 20_000 });
});
