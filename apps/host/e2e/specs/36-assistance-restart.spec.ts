/**
 * REAL ollama assistance-restart E2E (Phase 3 M6-A plan §5 T6, live gate):
 * a task parks `waiting_for_user` on an assistance question → the daemon is
 * RESTARTED mid-wait (SIGTERM to the pid-file daemon; the host respawns it —
 * the real launcher contract) → crash recovery leaves the waiting row
 * byte-identical (sessionId/cwd/pendingRequest preserved) → the UI rebuilds
 * the assistance card from the persisted record (restored hint) → the human
 * answers → the daemon-side auto-resume (single-flight claim → `resuming` →
 * session.resume on the SAME session + cwd) completes the task with NO
 * duplicate execution.
 *
 * Same-session live flavor is 35-assistance-question.spec.ts.
 */

import { expect } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from '../fixtures/gateway';
import { ExecutionView, gotoAuthenticated, submitHomeTask } from '../fixtures/task-helpers';

test.setTimeout(420_000);

const PROMPT =
  'M6_RESTARTASSIST task: a human-verification gate has been reached — the (simulated) login wall at internal.example.test/account requires an MFA code that only a human can provide. Follow your HUMAN VERIFICATION GATES instructions exactly: STOP immediately (no retries, no alternate routes, no complete_task, no bypass attempts) and call the question tool exactly ONCE with header EXACTLY "Human assistance required", describing the login-wall gate and what the human must do, with the standard options. Wait for the human reply before anything else. After the human confirms they completed the verification, write the file m6-assist-restart.txt in your current working directory containing exactly the text M6_ASSIST_RESTART_OK (use the bash tool), then confirm the exact file contents in your final message.';

const CONTINUATION_PREFIX = 'The human replied to your assistance request.';

function taskFileFor(chain: { dataDir: string }): string {
  return path.join(chain.dataDir, 'task-workspace', 'm6-assist-restart.txt');
}

interface TaskRecord {
  status?: string;
  sessionId?: string;
  workingDirectory?: string;
  pendingRequest?: Record<string, unknown> | null;
  messages?: { type?: string; content?: string }[];
}

/** Poll an async predicate until true (restart plumbing settles). */
async function pollUntil(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${label} not satisfied within ${timeoutMs} ms${lastError ? ` (last error: ${String(lastError)})` : ''}`,
  );
}

test('restart mid-wait: waiting row survives byte-identically, card restored, answer auto-resumes to completion', async ({
  page,
  chain,
}) => {
  const taskFile = taskFileFor(chain);
  rmSync(taskFile, { force: true });

  await gotoAuthenticated(page, chain.appUrl);
  const taskId = await submitHomeTask(page, PROMPT);
  expect(taskId).toBeTruthy();

  // Park on the assistance question first (generous: cold-model load makes
  // the first turn slow — M5 watch item).
  await expect(page.getByTestId('execution-waiting-for-user-label')).toBeVisible({
    timeout: 240_000,
  });
  const card = page.getByTestId('execution-permission-card');
  await expect(page.getByTestId('assistance-context')).toBeVisible({ timeout: 30_000 });

  const parked = (await chain.rpcCall('task.status', { taskId })) as { status?: string };
  expect(parked.status).toBe('waiting_for_user');
  const taskPre = (await chain.rpcCall('task.get', { taskId })) as TaskRecord;
  const pendingPre = (await chain.rpcCall('task.getPendingRequest', { taskId })) as {
    pendingRequest: Record<string, unknown> | null;
  };
  expect(pendingPre.pendingRequest?.kind).toBe('question');
  expect(pendingPre.pendingRequest?.header).toBe('Human assistance required');
  const requestIdPre = pendingPre.pendingRequest?.requestId as string;
  const sessionIdPre = taskPre.sessionId;
  const workingDirectoryPre = taskPre.workingDirectory;
  console.log(
    `[m6] pre-restart: status=${parked.status} sessionId=${sessionIdPre} requestId=${requestIdPre}`,
  );
  expect(sessionIdPre, 'session id persisted while parked').toBeTruthy();

  // Restart the daemon mid-wait: SIGTERM the pid-file daemon — the graceful
  // drain kills its opencode/children (real restart semantics), the host's
  // connector respawns it after backoff, and boot-time crash recovery runs.
  const pidFilePath = path.join(chain.dataDir, 'daemon.pid');
  const pidFile = JSON.parse(readFileSync(pidFilePath, 'utf8')) as { pid?: number };
  const daemonPid = pidFile.pid;
  expect(daemonPid, 'daemon pid file').toBeTruthy();
  process.kill(daemonPid as number, 'SIGTERM');
  console.log(`[m6] sent SIGTERM to daemon pid ${daemonPid} mid-wait`);
  await pollUntil(
    'daemon process exited',
    async () => {
      try {
        process.kill(daemonPid as number, 0);
        return false;
      } catch {
        return true;
      }
    },
    45_000,
  );

  // The host respawns the daemon (connector backoff → spawn → boot). The
  // waiting row must survive the restart byte-identically.
  await pollUntil(
    'respawned daemon answers daemon.ping and the waiting row is intact',
    async () => {
      const ping = (await chain.rpcCall('daemon.ping', {})) as { status?: string };
      if (ping.status !== 'ok') {
        return false;
      }
      const post = (await chain.rpcCall('task.get', { taskId })) as TaskRecord;
      return (
        post.status === 'waiting_for_user' &&
        post.sessionId === sessionIdPre &&
        post.workingDirectory === workingDirectoryPre
      );
    },
    120_000,
    3_000,
  );
  const pendingPostRestart = (await chain.rpcCall('task.getPendingRequest', { taskId })) as {
    pendingRequest: Record<string, unknown> | null;
  };
  console.log(
    `[m6] after restart: pendingRequest still persisted (${pendingPostRestart.pendingRequest?.requestId})`,
  );
  expect(pendingPostRestart.pendingRequest?.requestId).toBe(requestIdPre);

  // Open the task fresh — a REAL document reload (page reloads the SPA so
  // the store is rebuilt and the card must re-seed from the persisted
  // record), then a hash navigation to the execution route. The restored
  // hint must be visible (isRestored marker).
  await gotoAuthenticated(page, chain.appUrl);
  await page.goto(`${chain.gatewayUrl}/#/execution/${taskId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('execution-waiting-for-user-label')).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByTestId('assistance-context')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('assistance-restored-hint')).toBeVisible();
  console.log('[m6] assistance card restored from the persisted record after daemon restart');

  // Answer the restored card: the live-task sendResponse path is unavailable
  // (adapter died with the old daemon), so permission.respond routes to the
  // dead-pending guardrails → claim → resuming → session.auto-resume.
  await expect(page.getByTestId('permission-allow-button')).toBeDisabled();
  await card.getByRole('button', { name: /complete it / }).click();
  await expect(page.getByTestId('permission-allow-button')).toBeEnabled();
  await page.getByTestId('permission-allow-button').click();

  // The single-flight claim is synchronous with the respond RPC: the task
  // leaves waiting_for_user (transient `resuming`, then `running`) — poll
  // briefly for the resumption transition...
  const seenStatuses = new Set<string>();
  const resumptionDeadline = Date.now() + 30_000;
  while (Date.now() < resumptionDeadline) {
    try {
      const s = (await chain.rpcCall('task.status', { taskId })) as { status?: string };
      if (s.status) {
        seenStatuses.add(s.status);
      }
      if (s.status === 'resuming' || s.status === 'running') {
        break;
      }
      if (s.status !== 'waiting_for_user') {
        break; // unexpected state — let the terminal wait handle it
      }
    } catch {
      /* transient during daemon plumbing */
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  expect(
    seenStatuses.has('resuming') || seenStatuses.has('running'),
    `post-answer resumption transition observed (saw: ${[...seenStatuses].join(', ')})`,
  ).toBe(true);

  // ...then drive any post-resume approvals (bash for the file write) while
  // watching for the terminal badge AND tracking the full transition set.
  const view = new ExecutionView(page);
  const terminalStatus = await (async (): Promise<string> => {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      let badgeText = await view.badgeText();
      if (view.isTerminalBadgeText(badgeText)) {
        break;
      }
      const cardVisible = await view.permissionCard
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (cardVisible) {
        await view.allowButton.click();
        await expect(view.permissionCard).toBeHidden({ timeout: 30_000 });
      }
      try {
        const s = (await chain.rpcCall('task.status', { taskId })) as { status?: string };
        if (s.status) {
          seenStatuses.add(s.status);
        }
        if (s.status === 'failed' || s.status === 'cancelled') {
          throw new Error(`task reached ${s.status} instead of completing`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('task reached')) {
          throw err;
        }
      }
      badgeText = await view.badgeText();
    }
    try {
      const s = (await chain.rpcCall('task.status', { taskId })) as { status?: string };
      seenStatuses.add(s.status ?? 'unknown');
      return s.status ?? 'never-terminal';
    } catch {
      return 'never-terminal';
    }
  })();
  console.log(`[m6] post-restart status transitions: ${[...seenStatuses].join(' → ')}`);
  expect(terminalStatus).toBe('completed');

  // NO duplicate execution: exactly one task, one resumption, one file.
  const tasks = (await chain.rpcCall('task.list', {})) as { id?: string; prompt?: string }[];
  const mine = tasks.filter((t) => (t.prompt ?? '').includes('M6_RESTARTASSIST task'));
  expect(mine.length, 'exactly one M6_RESTARTASSIST task in history').toBe(1);
  expect(mine[0]?.id).toBe(taskId);

  const taskAfter = (await chain.rpcCall('task.get', { taskId })) as TaskRecord;
  const messages = taskAfter.messages ?? [];
  const continuationUserMessages = messages.filter((m) =>
    (m.content ?? '').includes(CONTINUATION_PREFIX),
  );
  expect(
    continuationUserMessages.length,
    'the auto-resume continuation prompt appears exactly once (no duplicate resume execution)',
  ).toBe(1);
  const transcriptText = messages.map((m) => m.content ?? '').join('\n');
  expect(transcriptText).toContain('M6_ASSIST_RESTART_OK');
  console.log(
    `[m6] post-restart sessionId=${taskAfter.sessionId} (pre=${sessionIdPre}) messages=${messages.length}`,
  );

  // The claim cleared the persisted request; the original session was reused.
  const cleared = (await chain.rpcCall('task.getPendingRequest', { taskId })) as {
    pendingRequest: Record<string, unknown> | null;
  };
  expect(cleared.pendingRequest, 'claimed pending request cleared after auto-resume').toBeNull();
  expect(taskAfter.sessionId).toBe(sessionIdPre);

  expect(existsSync(taskFile), 'auto-resumed continuation created the task file').toBe(true);
  expect(readFileSync(taskFile, 'utf8')).toContain('M6_ASSIST_RESTART_OK');
});

test('restarted assistance task reopens from history with the resumed transcript, no card', async ({
  page,
  chain,
}) => {
  const tasks = (await chain.rpcCall('task.list', {})) as {
    id?: string;
    prompt?: string;
    status?: string;
  }[];
  const restarted = tasks.find((t) => (t.prompt ?? '').includes('M6_RESTARTASSIST task'));
  if (!restarted) {
    console.log(
      `[m6] task.list contents: ${JSON.stringify(tasks.map((t) => ({ id: t.id, prompt: (t.prompt ?? '').slice(0, 60), status: t.status })))}`,
    );
  }
  expect(restarted, 'restart task persisted in SQLite through the gateway').toBeTruthy();
  expect(restarted?.status).toBe('completed');

  await gotoAuthenticated(page, chain.appUrl);
  await page.goto(`${chain.gatewayUrl}/#/execution/${restarted!.id}`, {
    waitUntil: 'domcontentloaded',
  });
  const view = new ExecutionView(page);
  await expect(view.messagesScrollContainer).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('M6_ASSIST_RESTART_OK').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('execution-permission-card')).toBeHidden();
});
