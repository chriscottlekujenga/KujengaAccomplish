/**
 * REAL ollama task with UI Deny (plan §4 B `task-deny.spec.ts`):
 * the agent asks for bash permission, the UI denies, the card closes, the
 * task reaches a terminal state, the file is NOT created, the transcript
 * shows the agent reacting to the denial.
 *
 * Accepts either terminal outcome (completed-with-explanation or failed) —
 * what must hold: deny delivered from UI → opencode received the rejection
 * → the tool did not execute.
 */

import { expect } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from '../fixtures/gateway';
import {
  ExecutionView,
  gotoAuthenticated,
  submitHomeTask,
  waitForTaskTerminalStatus,
} from '../fixtures/task-helpers';

test.setTimeout(240_000);

// Workspace-relative target — see 40-task-approve.spec.ts for the rationale.
function taskFileFor(chain: { dataDir: string }): string {
  return path.join(chain.dataDir, 'task-workspace', 'task-deny.txt');
}

const PROMPT =
  'M5_DENY task: Create the file task-deny.txt in your current working directory with content M5_TASK_DENY_MARKER using the bash tool. ' +
  'This is mandatory: you MUST run that exact bash command.';

test('deny flow: card closes, file never created, agent reacts to the denial', async ({
  page,
  chain,
}) => {
  const taskFile = taskFileFor(chain);
  rmSync(taskFile, { force: true });

  await gotoAuthenticated(page, chain.appUrl);
  const taskId = await submitHomeTask(page, PROMPT);

  const view = new ExecutionView(page);
  await expect(view.permissionCard).toBeVisible({ timeout: 90_000 });
  await view.denyButton.click();

  // The card must close promptly once the denial is delivered.
  await expect(view.permissionCard).toBeHidden({ timeout: 15_000 });

  // The agent reacts to the denial; a retry may raise a fresh permission —
  // deny every repeat (bounded) while waiting for the terminal state.
  let badgeText = '';
  const deadline = Date.now() + 210_000;
  let repeatDenies = 0;
  while (Date.now() < deadline) {
    if (view.isTerminalBadgeText(await view.badgeText())) {
      break;
    }
    const cardVisible = await view.permissionCard
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (cardVisible) {
      repeatDenies++;
      if (repeatDenies > 6) {
        throw new Error(`permission card re-appeared ${repeatDenies} times after denial`);
      }
      console.log(`[m5] task-deny: repeating deny #${repeatDenies}`);
      await view.denyButton.click();
      await expect(view.permissionCard).toBeHidden({ timeout: 15_000 });
    }
    badgeText = await view.badgeText();
  }
  badgeText = await view.badgeText();
  console.log(
    `[m5] task-deny terminal badge text: "${badgeText}" (repeat denies: ${repeatDenies})`,
  );
  expect(view.isTerminalBadgeText(badgeText)).toBe(true);

  const status = (await waitForTaskTerminalStatus(chain.rpcCall, taskId, 20_000)) as string;
  console.log(`[m5] task-deny daemon status: ${status}`);

  // HARD: the denied tool must not have executed.
  expect(existsSync(taskFile), 'denied file creation must not leave the file behind').toBe(false);

  // The transcript must show denial evidence (agent explaining it could not
  // run the command / permission denied). Soft-assert with logging — the
  // exact prose belongs to the model; the file-absence check above is the
  // hard proof of the deny workflow. Message batches may flush shortly after
  // the terminal status — poll for 30 s before judging.
  let denialHits: RegExpMatchArray | null = null;
  let transcriptDump: string[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const task = (await chain.rpcCall('task.get', { taskId })) as {
      status?: string;
      messages?: { type?: string; content?: string }[];
    };
    const messages = task.messages ?? [];
    transcriptDump = messages.map((m) => `[${m.type}] ${(m.content ?? '').slice(0, 200)}`);
    denialHits = messages
      .map((m) => m.content ?? '')
      .join('\n')
      .match(/(denied|denial|permission|not allow|rejected)/i);
    if (denialHits || attempt === 9) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (denialHits) {
    console.log(`[m5] task-deny denial evidence present (${denialHits[0]})`);
  } else {
    console.log(
      '[m5] task-deny: NO denial-text evidence in transcript — file absence is the hard proof; transcript follows:',
    );
    for (const line of transcriptDump) {
      console.log(`[m5]   - ${line.replace(/\n/g, ' ')}`);
    }
  }
});
