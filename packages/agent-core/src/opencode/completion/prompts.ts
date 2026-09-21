export function getContinuationPrompt(): string {
  return `REMINDER: You must call complete_task when finished.

Before proceeding, ask yourself: "Have I actually finished everything the user asked?"

- If NO, you haven't finished yet → CONTINUE WORKING on the task
- If YES, all parts are done → Call complete_task with status: "success"
- If you hit a blocker → Call complete_task with status: "blocked"
- If some parts done, some not → Call complete_task with status: "partial"

Do NOT call complete_task until you have actually completed the user's request.
Keep working if there's more to do.`;
}

/**
 * Prompt injected when the user sends a new message while the task is still running.
 * The current turn is interrupted and the session is respawned with this prompt, so
 * the agent keeps its prior context (via --session) but re-plans around the new input.
 */
export function getRedirectPrompt(userMessages: string[]): string {
  const messages = userMessages.map((message) => `- "${message}"`).join('\n');
  return `The user interrupted your current work to send a new message while you were still working.

## New Message(s) From User
${messages}

## What To Do Now

1. **Review your progress so far** - Use the session context to see what you had already completed
2. **Create a TODO list** showing what's done and what remains:
   - Keep items that are still valid from your previous plan
   - Add new items required by the user's message above
   - Cancel items the new message makes obsolete

3. **Re-plan and continue working** - Incorporate the user's new message into the task:
   - If the message changes the goal, redirect your work accordingly
   - If the message adds requirements, extend your work to cover them
   - If the message is a question or clarification, address it directly, then continue

## IMPORTANT RULES

- Build on your existing work - do NOT start over from scratch unless the user's message requires it
- Do NOT call complete_task until you have handled the new message AND finished all remaining work
- Call complete_task with status "success" only when the original request (as adjusted by the new message) is fully complete
- If you hit a real technical blocker, call complete_task with status "blocked"

Now re-plan with todowrite and resume working with the user's new message in mind.`;
}

export function getPartialContinuationPrompt(
  remainingWork: string,
  originalRequest: string,
  completedSummary: string,
  incompleteTodos?: string,
): string {
  if (incompleteTodos) {
    return `Your complete_task call was rejected because these todo items are still marked incomplete:

${incompleteTodos}

Call todowrite to mark each item as "completed" or "cancelled", then call complete_task with status="success".

If any items are not done yet, complete them first.`;
  }

  return `You called complete_task with status="partial" but the task is not done yet.

## Original Request
"${originalRequest}"

## What You Completed
${completedSummary}

## What You Said Remains
${remainingWork}

## REQUIRED: Create a Continuation Plan

Before continuing, you MUST:

1. **Review the original request** - Re-read every requirement carefully
2. **Create a TODO list** showing what's done and what remains:

**Continuation Plan:**
✓ [Items you already completed]
□ [Next step] → verify: [how to confirm it's done]
□ [Following step] → verify: [how to confirm it's done]
...

3. **Execute the plan** - Work through each remaining step
4. **Call complete_task(success)** - Only when ALL original requirements are met

## IMPORTANT RULES

- Do NOT call complete_task with "partial" again unless you hit an actual TECHNICAL blocker
- If you hit a real blocker (login wall, CAPTCHA, rate limit, site error), use "blocked" status
- "partial" is NOT an acceptable final status - keep working until the task is complete
- Do NOT ask the user "would you like me to continue?" - just continue working

Now create your continuation plan and resume working on the remaining items.`;
}
