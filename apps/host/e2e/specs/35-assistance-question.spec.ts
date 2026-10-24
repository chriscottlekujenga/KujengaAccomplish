/**
 * REAL ollama assistance-question E2E (Phase 3 M6-A plan §5 T6, live gate):
 * a task at a human-verification gate calls the question tool with the shared
 * ASSISTANCE_QUESTION_HEADER → daemon parks it `waiting_for_user` ("Needs
 * your reply" badge) → the assistance card renders the verification-gate
 * context → the human answers through the UI → the SAME live session
 * continues (question.reply, no restart) → the agent finishes the task →
 * terminal success + the file exactly once (no duplicate execution).
 *
 * Live-path only; the daemon-restart flavor is 36-assistance-restart.spec.ts.
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

test.setTimeout(300_000);

// The scripted gate leans on the system prompt's HUMAN VERIFICATION GATES
// instruction (M6-A T1): name the gate explicitly and forbid terminate/bypass
// so instruction-following models emit the single assistance question.
const PROMPT =
  'M6_ASSISTANCE task: a human-verification gate has been reached — the (simulated) login wall at internal.example.test/account requires an MFA code that only a human can provide. Follow your HUMAN VERIFICATION GATES instructions exactly: STOP immediately (no retries, no alternate routes, no complete_task, no bypass attempts) and call the question tool exactly ONCE with header EXACTLY "Human assistance required", describing the login-wall gate and what the human must do, with the standard options. Wait for the human reply before anything else. After the human confirms they completed the verification, write the file m6-assist.txt in your current working directory containing exactly the text M6_ASSIST_CONTINUED_OK (use the bash tool), then confirm the exact file contents in your final message.';

function taskFileFor(chain: { dataDir: string }): string {
  return path.join(chain.dataDir, 'task-workspace', 'm6-assist.txt');
}

interface TaskRecord {
  status?: string;
  sessionId?: string;
  pendingRequest?: Record<string, unknown> | null;
  messages?: { type?: string; content?: string }[];
}

test('assistance gate: waiting_for_user badge, card context, answer resumes SAME session to completion', async ({
  page,
  chain,
}) => {
  const taskFile = taskFileFor(chain);
  rmSync(taskFile, { force: true });

  await gotoAuthenticated(page, chain.appUrl);
  const taskId = await submitHomeTask(page, PROMPT);
  expect(taskId).toBeTruthy();

  const view = new ExecutionView(page);

  // The parked state: waiting_for_user badge ("Needs your reply") and the
  // assistance card with the verification gate explainer + wait label.
  await expect(page.getByTestId('execution-waiting-for-user-label')).toBeVisible({
    timeout: 120_000,
  });
  const card = page.getByTestId('execution-permission-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('assistance-context')).toBeVisible();
  await expect(page.getByTestId('assistance-explainer')).toBeVisible();
  await expect(page.getByTestId('assistance-waiting-label')).toBeVisible();

  // Daemon records the parked waiting status and the persisted pending
  // request (allowlisted task.getPendingRequest read).
  const parked = (await chain.rpcCall('task.status', { taskId })) as { status?: string };
  expect(parked.status).toBe('waiting_for_user');
  const pending = (await chain.rpcCall('task.getPendingRequest', { taskId })) as {
    pendingRequest: Record<string, unknown> | null;
  };
  console.log(`[m6] parked pendingRequest: ${JSON.stringify(pending.pendingRequest)}`);
  expect(pending.pendingRequest).toBeTruthy();
  expect(pending.pendingRequest?.kind).toBe('question');
  expect(pending.pendingRequest?.header).toBe('Human assistance required');
  expect(typeof pending.pendingRequest?.requestId).toBe('string');
  const persistedRequestId = pending.pendingRequest?.requestId as string;

  // Answer through the assistance card: select the continue option, submit.
  await expect(view.allowButton).toBeDisabled(); // submit reply disabled until answered
  await card.getByRole('button', { name: /complete it / }).click();
  await expect(view.allowButton).toBeEnabled();
  await view.allowButton.click();

  // The reply is delivered to the SAME live session: the card clears and the
  // status leaves waiting_for_user (running → agent continues the turn).
  await expect(card).toBeHidden({ timeout: 30_000 });

  // The continuation may need further approvals (bash for the file write) —
  // the approval loop only reacts to cards appearing AFTER the answer.
  const badgeText = await approveUntilTerminal(page, view, 240_000);
  console.log(`[m6] task-approve assistance terminal badge text: "${badgeText}"`);

  const status = (await chain.rpcCall('task.status', { taskId })) as { status?: string };
  console.log(`[m6] assistance daemon status: ${status.status}`);
  expect(status.status).toBe('completed');

  // The task is DONE exactly once: the file exists with the exact content
  // (the continuation ran in the original session — no duplicate run created
  // a second task).
  expect(existsSync(taskFile), 'continuation created the task file').toBe(true);
  expect(readFileSync(taskFile, 'utf8')).toContain('M6_ASSIST_CONTINUED_OK');

  const taskAfter = (await chain.rpcCall('task.get', { taskId })) as TaskRecord;
  const messages = taskAfter.messages ?? [];
  expect(
    messages.length,
    'transcript has at least the user prompt + assistant reply',
  ).toBeGreaterThanOrEqual(2);
  const transcriptText = messages.map((m) => m.content ?? '').join('\n');
  expect(transcriptText).toContain('M6_ASSIST_CONTINUED_OK');

  // Exactly one execution of this task; no duplicate/queued sibling.
  const tasks = (await chain.rpcCall('task.list', {})) as { id?: string; prompt?: string }[];
  const mine = tasks.filter((t) => (t.prompt ?? '').includes('M6_ASSISTANCE task'));
  expect(mine.length, 'exactly one M6_ASSISTANCE task in history').toBe(1);
  expect(mine[0]?.id).toBe(taskId);

  // The persisted pending request was cleared on the live reply.
  const cleared = (await chain.rpcCall('task.getPendingRequest', { taskId })) as {
    pendingRequest: Record<string, unknown> | null;
  };
  expect(cleared.pendingRequest).toBeNull();
  console.log(`[m6] persisted request id ${persistedRequestId} consumed; live path clean`);
});

test('completed assistance task reopens from history with the transcript, no card', async ({
  page,
  chain,
}) => {
  // Companion check without a second LLM run: the persisted task reloads its
  // transcript; no assistance card (nothing pending) and no restored hint.
  const tasks = (await chain.rpcCall('task.list', {})) as {
    id?: string;
    prompt?: string;
    status?: string;
  }[];
  const assistanceTask = tasks.find((t) => (t.prompt ?? '').includes('M6_ASSISTANCE task'));
  expect(assistanceTask, 'assistance task persisted in SQLite through the gateway').toBeTruthy();
  expect(assistanceTask?.status).toBe('completed');

  await gotoAuthenticated(page, chain.appUrl);
  await page.goto(`${chain.gatewayUrl}/#/execution/${assistanceTask!.id}`, {
    waitUntil: 'domcontentloaded',
  });
  const view = new ExecutionView(page);
  await expect(view.messagesScrollContainer).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('M6_ASSIST_CONTINUED_OK').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('execution-permission-card')).toBeHidden();
});
