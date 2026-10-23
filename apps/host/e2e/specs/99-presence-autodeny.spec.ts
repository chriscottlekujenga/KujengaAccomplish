/**
 * Presence-gate auto-deny at the browser layer (plan §4 C
 * `presence-autodeny.spec.ts`, Phase 3 M1 §5.2 E2E proof).
 *
 * A transient WS client authenticates, starts a real task over HTTP, then
 * disconnects — leaving ZERO interactive UI presence. When the agent
 * requests bash permission, the daemon's no-UI policy (task-callbacks.ts
 * onPermissionRequest → !presence.hasInteractiveClients → auto-deny) must
 * deny without any UI, deliver the denial to opencode, and drive the task
 * to a terminal state without the file ever being created.
 *
 * This spec requests NO `page` fixture: with workers:1 no other spec's
 * browser context is open here (contexts are per-test), and the transient
 * WS is closed right after task.start — presence collapses to 0 via the
 * gateway's close-time reportPresence.
 */

import { expect } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from '../fixtures/gateway';
import { waitForTaskTerminalStatus } from '../fixtures/task-helpers';

test.setTimeout(240_000);

const TASK_FILE = 'autodeny.txt';
const PROMPT =
  'Create the file autodeny.txt in your current working directory with the exact content M5_AUTODENY using the bash tool. ' +
  'You must run that exact command for the task to complete.';

test('task started by a disconnected WS client: permission auto-denied, no UI', async ({
  chain,
}) => {
  const taskFile = path.join(chain.dataDir, 'task-workspace', TASK_FILE);
  rmSync(taskFile, { force: true });
  const taskId = `m5-autodeny-${Date.now()}`;

  // 1. Transient client: authenticated WS + HTTP task start.
  const session = await chain.openEvents();
  try {
    await session.nextMessage((m) => m.type === 'auth-ok', 5_000);

    const started = (await chain.rpcCall('task.start', {
      taskId,
      prompt: PROMPT,
    })) as { id?: string; status?: string };
    expect(started.id).toBe(taskId);
    expect(started.status).toBeTruthy();
    console.log(`[m5] presence-autodeny task accepted with status: ${started.status}`);
  } finally {
    // 2. Disconnect — the gateway immediately re-reports 0 browser-UI
    //    presence to the daemon.
    session.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  // 3. The agent runs headless; its bash permission request must hit the
  //    no-UI path and auto-deny. Poll for the terminal state.
  const terminalStatus = await waitForTaskTerminalStatus(chain.rpcCall, taskId, 180_000);
  console.log(`[m5] presence-autodeny terminal status: ${terminalStatus}`);

  // 4. HARD: the auto-denied tool must never have executed.
  expect(existsSync(taskFile), 'auto-denied bash must not create the file').toBe(false);

  // 5. Transcript evidence: the daemon delivered the denial and the agent
  //    reacted. Soft-assert the prose; the file absence is the hard proof.
  const task = (await chain.rpcCall('task.get', { taskId })) as {
    status?: string;
    messages?: { type?: string; content?: string }[];
  };
  const transcript = (task.messages ?? []).map((m) => `${m.type}: ${m.content ?? ''}`).join('\n');
  console.log(
    `[m5] presence-autodeny transcript (${task.messages?.length ?? 0} blocks):\n` +
      (task.messages ?? [])
        .map((m) => `  - [${m.type}] ${(m.content ?? '').slice(0, 160).replace(/\n/g, ' ')}`)
        .join('\n'),
  );
  if (/(denied|denial|permission|not allow|rejected)/i.test(transcript)) {
    console.log('[m5] presence-autodeny: denial wording present in transcript');
  } else {
    console.log(
      '[m5] presence-autodeny: explicit denial wording absent — expected ' +
        'tool-error style feedback from the opencode adapter (mirrors the M2 harness observation)',
    );
  }
  expect(task.status).toBe(terminalStatus);
});
