import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeAdapter } from '../../../../src/internal/classes/OpenCodeAdapter.js';
import { ACCOMPLISH_AGENT_NAME } from '../../../../src/opencode/config-generator.js';

/**
 * REGRESSION: the adapter used to pass `{ title }` to `session.create`
 * and nothing agent-related to `session.prompt`. The generated
 * `opencode.json` defines a custom `accomplish` agent containing the
 * entire Accomplish system prompt (skills, connectors, workspace
 * instructions, knowledge notes, etc.) and sets `default_agent:
 * 'accomplish'` at the config root. That default_agent IS honored by
 * the CLI path, which was invoked as `opencode --agent accomplish` —
 * but the SDK path (OpenCode SDK cutover port) has no implicit agent
 * selection. Without explicit `agent: ACCOMPLISH_AGENT_NAME` on each
 * `session.prompt`, OpenCode runs the session under its built-in
 * default agent and silently ignores the accomplish prompt.
 *
 * User-visible symptom: workspace `instruction`-type knowledge notes
 * are correctly written into the generated opencode.json (verified by
 * inspecting the file) but the model's replies show none of those
 * instructions being followed. The entire ~18KB Accomplish system
 * prompt — including the mandatory `<workspace-instructions>` block
 * prepended to the top — never reaches the model because the session
 * isn't configured to use the accomplish agent.
 *
 * Fix: pass `agent: ACCOMPLISH_AGENT_NAME` on BOTH session.prompt call
 * sites (initial prompt + continuation nudge). Per the current
 * `@opencode-ai/sdk` type defs, `SessionPromptData.body` accepts
 * `agent?: string`; `SessionCreateData.body` does not have an agent
 * field so create stays agent-less.
 *
 * These tests pin the fix at the narrow seam:
 *   - Initial startTask → session.prompt carries `agent: 'accomplish'`.
 *   - Continuation prompt → also carries `agent: 'accomplish'`.
 * If a future SDK upgrade or refactor silently drops the field, these
 * tests fail loudly before the PR lands.
 *
 * The file also pins the model-ref seam (Phase 2 local-model hang): the
 * daemon threads `config.provider` + `config.modelId`, and the adapter
 * must send them as the SDK `model: { providerID, modelID }` field —
 * mapped through PROVIDER_ID_TO_OPENCODE — on BOTH the initial prompt
 * and the continuation nudge. Without it opencode's model cascade is
 * empty and the LLM is never called (task hangs, e.g. ollama).
 */
describe('OpenCodeAdapter agent selection on session.prompt', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface PromptCall {
    sessionID: string;
    agent?: string;
    system?: string;
    text?: string;
    model?: { providerID: string; modelID: string };
  }

  function buildFakeClient(): {
    client: unknown;
    promptCalls: PromptCall[];
  } {
    const promptCalls: PromptCall[] = [];

    const client = {
      session: {
        create: async (_args: { title: string }) => {
          return { id: 'session_abc' };
        },
        prompt: (args: {
          sessionID: string;
          agent?: string;
          system?: string;
          parts: Array<{ text?: string }>;
          model?: { providerID: string; modelID: string };
        }) => {
          promptCalls.push({
            sessionID: args.sessionID,
            agent: args.agent,
            system: args.system,
            text: args.parts[0]?.text,
            model: args.model,
          });
          return Promise.resolve();
        },
      },
      event: {
        subscribe: async () => {
          const stream: AsyncIterable<unknown> = {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise(() => {}), // never resolves
              };
            },
          };
          return { stream, close: () => {} };
        },
      },
    };

    return { client, promptCalls };
  }

  async function runStartTask(
    adapter: OpenCodeAdapter,
    config: { prompt: string; sessionId?: string; provider?: string; modelId?: string },
    fake: ReturnType<typeof buildFakeClient>,
  ): Promise<void> {
    const adapterOpts = (
      adapter as unknown as {
        options: {
          getServerUrl: (taskId: string) => Promise<string>;
        };
      }
    ).options;
    adapterOpts.getServerUrl = async () => 'http://127.0.0.1:4096';

    let clientAssigned = false;
    Object.defineProperty(adapter, 'client', {
      configurable: true,
      get() {
        return clientAssigned ? fake.client : null;
      },
      set(_value: unknown) {
        clientAssigned = true;
      },
    });

    const startPromise = adapter.startTask({ ...config, taskId: 'tsk_agent_test' });
    await Promise.race([
      startPromise.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 200)),
    ]);
  }

  it('initial session.prompt carries agent: ACCOMPLISH_AGENT_NAME', async () => {
    const adapter = new OpenCodeAdapter(
      { platform: 'darwin', isPackaged: false, tempPath: '/tmp' },
      'tsk_agent_fresh',
    );
    const fake = buildFakeClient();
    await runStartTask(adapter, { prompt: 'tell me about yourself' }, fake);

    expect(fake.promptCalls.length).toBe(1);
    const call = fake.promptCalls[0];
    expect(call.agent).toBe(ACCOMPLISH_AGENT_NAME);
    expect(call.agent).toBe('accomplish'); // double-check the constant value
    expect(call.text).toBe('tell me about yourself');
  });

  it('resume (config.sessionId) session.prompt also carries agent: ACCOMPLISH_AGENT_NAME', async () => {
    const adapter = new OpenCodeAdapter(
      { platform: 'darwin', isPackaged: false, tempPath: '/tmp' },
      'tsk_agent_resume',
    );
    const fake = buildFakeClient();
    await runStartTask(
      adapter,
      { prompt: 'follow-up question', sessionId: 'existing_session' },
      fake,
    );

    expect(fake.promptCalls.length).toBe(1);
    expect(fake.promptCalls[0].agent).toBe(ACCOMPLISH_AGENT_NAME);
    expect(fake.promptCalls[0].sessionID).toBe('existing_session');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Runtime per-turn `system` injection for workspace instructions.
  //
  // The agent-level `agent.accomplish.prompt` is not enough: the OpenAI/
  // Codex provider path inside OpenCode injects its own `options.instructions`
  // channel that crowds out the agent-level prompt, so mandatory user rules
  // (e.g. "always add Haiku suffix") never reach the model. Fix: `onBeforeStart`
  // returns `{ env, workspaceInstructions }`, the adapter stores the
  // instructions, and every `session.prompt` call includes them as the
  // SDK's first-class `system` field. These tests pin that pipeline.
  // ──────────────────────────────────────────────────────────────────────
  it('session.prompt carries system= with workspace instructions when onBeforeStart returns them', async () => {
    const adapter = new OpenCodeAdapter(
      {
        platform: 'darwin',
        isPackaged: false,
        tempPath: '/tmp',
        onBeforeStart: async () => ({
          env: {},
          workspaceInstructions: '- Always add "Haiku" suffix string for any reply',
        }),
      },
      'tsk_ws_instr',
    );
    const fake = buildFakeClient();
    await runStartTask(adapter, { prompt: 'tell me about yourself' }, fake);

    expect(fake.promptCalls.length).toBe(1);
    const call = fake.promptCalls[0];
    expect(call.system).toBeDefined();
    // The runtime block wraps the instructions under a mandatory header
    // that's deliberately terse but explicit about overriding the
    // conversational-bypass default-concise behavior.
    expect(call.system).toContain('MANDATORY WORKSPACE INSTRUCTIONS');
    // The exact user-supplied instruction text is preserved verbatim.
    expect(call.system).toContain('Always add "Haiku" suffix string for any reply');
    // It's wrapped in the <workspace-instructions> tag so the model can
    // pattern-match it reliably.
    expect(call.system).toContain('<workspace-instructions>');
    expect(call.system).toContain('</workspace-instructions>');
  });

  it('session.prompt omits system= when no workspace instructions are set', async () => {
    const adapter = new OpenCodeAdapter(
      {
        platform: 'darwin',
        isPackaged: false,
        tempPath: '/tmp',
        // onBeforeStart returns a legacy plain-env shape, no workspaceInstructions.
        onBeforeStart: async () => ({ ACCOMPLISH_SOME_VAR: '1' }) as NodeJS.ProcessEnv,
      },
      'tsk_no_instr',
    );
    const fake = buildFakeClient();
    await runStartTask(adapter, { prompt: 'hi' }, fake);

    expect(fake.promptCalls.length).toBe(1);
    // Legacy callers that return a bare env object shouldn't accidentally
    // trigger a `system` injection. The adapter only populates `system`
    // when `onBeforeStart` returns the rich `{ env, workspaceInstructions }`
    // shape with a non-empty `workspaceInstructions` field.
    expect(fake.promptCalls[0].system).toBeUndefined();
  });

  it('resume path also carries system= (workspace rules apply on every turn, not just session creation)', async () => {
    const adapter = new OpenCodeAdapter(
      {
        platform: 'darwin',
        isPackaged: false,
        tempPath: '/tmp',
        onBeforeStart: async () => ({
          env: {},
          workspaceInstructions: '- Reply in haiku form',
        }),
      },
      'tsk_resume_system',
    );
    const fake = buildFakeClient();
    await runStartTask(
      adapter,
      { prompt: 'follow-up', sessionId: 'session_was_created_before_note_was_added' },
      fake,
    );

    // The critical property: a session that was created BEFORE the user
    // added the workspace note must STILL get the instructions injected
    // on subsequent turns, because the runtime `system` field is per-call,
    // not sticky to session creation.
    expect(fake.promptCalls.length).toBe(1);
    expect(fake.promptCalls[0].sessionID).toBe('session_was_created_before_note_was_added');
    expect(fake.promptCalls[0].system).toContain('Reply in haiku form');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Model ref on session.prompt (Phase 2 local-model hang fix).
  //
  // The daemon threads `config.provider` + `config.modelId`; the adapter
  // must convert them into the SDK `model: { providerID, modelID }` field,
  // mapping internal provider IDs through PROVIDER_ID_TO_OPENCODE so they
  // match the provider names in the generated opencode config. The
  // continuation nudge must reuse the same ref — it fires outside
  // startTask and used to go out model-less.
  // ──────────────────────────────────────────────────────────────────────
  it('initial session.prompt carries model= mapped through PROVIDER_ID_TO_OPENCODE', async () => {
    const adapter = new OpenCodeAdapter(
      { platform: 'darwin', isPackaged: false, tempPath: '/tmp' },
      'tsk_model_zai',
    );
    const fake = buildFakeClient();
    await runStartTask(
      adapter,
      { prompt: 'run with zai plan', provider: 'zai', modelId: 'glm-4.7' },
      fake,
    );

    expect(fake.promptCalls.length).toBe(1);
    expect(fake.promptCalls[0].model).toEqual({
      providerID: 'zai-coding-plan',
      modelID: 'glm-4.7',
    });
  });

  it('initial session.prompt carries the provider verbatim when already an OpenCode registry name (ollama)', async () => {
    const adapter = new OpenCodeAdapter(
      { platform: 'darwin', isPackaged: false, tempPath: '/tmp' },
      'tsk_model_ollama',
    );
    const fake = buildFakeClient();
    await runStartTask(
      adapter,
      { prompt: 'run locally', provider: 'ollama', modelId: 'llama3.2' },
      fake,
    );

    expect(fake.promptCalls.length).toBe(1);
    expect(fake.promptCalls[0].model).toEqual({
      providerID: 'ollama',
      modelID: 'llama3.2',
    });
  });

  it('session.prompt strips the provider prefix from a full model ref (ollama cloud 404 fix)', async () => {
    // REGRESSION (live Phase 2 verification): storage stores the selected
    // model as a full ref (`ollama/glm-5.3:cloud`). Opencode forwards
    // modelID verbatim to the provider's /v1/chat/completions call, and the
    // server rejects the prefixed name ('model "ollama/glm-5.3" not found')
    // → session.error at the first turn. modelID must be the bare
    // server-known name, same splitting normalizeSelectedModelForSdk does.
    const adapter = new OpenCodeAdapter(
      { platform: 'darwin', isPackaged: false, tempPath: '/tmp' },
      'tsk_model_fullref',
    );
    const fake = buildFakeClient();
    await runStartTask(
      adapter,
      { prompt: 'run locally', provider: 'ollama', modelId: 'ollama/glm-5.3:cloud' },
      fake,
    );

    expect(fake.promptCalls.length).toBe(1);
    expect(fake.promptCalls[0].model).toEqual({
      providerID: 'ollama',
      modelID: 'glm-5.3:cloud',
    });
  });

  it('session.prompt omits model= when config carries no provider/modelId', async () => {
    const adapter = new OpenCodeAdapter(
      { platform: 'darwin', isPackaged: false, tempPath: '/tmp' },
      'tsk_model_absent',
    );
    const fake = buildFakeClient();
    await runStartTask(adapter, { prompt: 'no model info' }, fake);

    expect(fake.promptCalls.length).toBe(1);
    expect(fake.promptCalls[0].model).toBeUndefined();
  });

  it('continuation prompt reuses the same model ref as the initial prompt', async () => {
    const adapter = new OpenCodeAdapter(
      { platform: 'darwin', isPackaged: false, tempPath: '/tmp' },
      'tsk_model_continuation',
    );
    const fake = buildFakeClient();
    await runStartTask(
      adapter,
      { prompt: 'multi-step task', provider: 'ollama', modelId: 'llama3.2' },
      fake,
    );
    expect(fake.promptCalls.length).toBe(1);

    // Drive the completion enforcer into the continuation path the same
    // way live event flow does: tools were used, the agent stopped without
    // complete_task (→ CONTINUATION_PENDING), then process exit 0 fires
    // the nudge.
    const enforcer = (
      adapter as unknown as {
        completionEnforcer: {
          markToolsUsed: () => void;
          handleStepFinish: (reason: string) => unknown;
          handleProcessExit: (code: number) => Promise<void>;
        };
      }
    ).completionEnforcer;
    enforcer.markToolsUsed();
    enforcer.handleStepFinish('stop');
    await enforcer.handleProcessExit(0);

    expect(fake.promptCalls.length).toBe(2);
    expect(fake.promptCalls[1].agent).toBe(ACCOMPLISH_AGENT_NAME);
    expect(fake.promptCalls[1].model).toEqual({ providerID: 'ollama', modelID: 'llama3.2' });
  });
});
