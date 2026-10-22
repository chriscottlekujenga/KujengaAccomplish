/**
 * Unit tests for the Phase 3 M2 T2 skills RPC routes:
 * `skills.addFromGitHub` (new daemon method) and the param shapes of
 * `skills.addFromPath` / `skills.delete`.
 *
 * Proves (§5.4 expansion policy):
 *   - the GitHub URL gate rejects non-https / non-GitHub / malformed URLs
 *     BEFORE the importer is reached (clear validation error, no service
 *     call, no fetch attempt);
 *   - the raw url reaches the service verbatim — normalization to the raw
 *     SKILL.md URL is agent-core's `resolveGithubRawUrl`, reusing
 *     `addSkill`'s http(s) dispatch (desktop `addFromGitHub` parity);
 *   - pass-through semantics of addFromPath/delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRpcMethods, type RouteServices } from '../../src/daemon-routes.js';
import type { SkillsService } from '../../src/skills-service.js';

type RpcHandler = (params: unknown, clientId?: string) => Promise<unknown> | unknown;

const SAMPLE_SKILL = {
  id: 'skill-gh-1',
  name: 'GitHub Skill',
  command: '/github-skill',
  description: 'imported from github',
  source: 'community',
  isEnabled: true,
  isVerified: false,
  isHidden: false,
  filePath: '/tmp/accomplish/skills/github-skill/SKILL.md',
  githubUrl: 'https://github.com/owner/repo/tree/main',
  updatedAt: '2026-10-21T00:00:00.000Z',
};

function buildServices() {
  const registered = new Map<string, RpcHandler>();
  const skillsService = {
    list: vi.fn(() => []),
    listEnabled: vi.fn(() => []),
    setEnabled: vi.fn(),
    getContent: vi.fn(() => null),
    getUserSkillsPath: vi.fn(() => '/tmp/accomplish/skills'),
    addFromPath: vi.fn(async () => SAMPLE_SKILL),
    addFromGitHub: vi.fn(async () => SAMPLE_SKILL),
    delete: vi.fn(),
    resync: vi.fn(async () => [SAMPLE_SKILL]),
    on: vi.fn(),
  } as unknown as SkillsService & Record<string, ReturnType<typeof vi.fn>>;

  const services = {
    rpc: {
      registerMethod: vi.fn((method: string, handler: RpcHandler) => {
        registered.set(method, handler);
      }),
      notify: vi.fn(),
      setClientType: vi.fn(),
      setUiPresence: vi.fn(),
    },
    taskService: {},
    healthService: {},
    storageService: { getStorage: vi.fn(() => ({})) },
    schedulerService: {},
    accomplishRuntime: { onUsageUpdate: vi.fn() },
    whatsappService: {},
    openAiOauthManager: { getAccessToken: vi.fn(() => null) },
    secretsService: { getApiKey: vi.fn(() => null), getBedrockCredentials: vi.fn(() => null) },
    settingsService: { on: vi.fn() },
    workspaceService: { on: vi.fn() },
    connectorService: {},
    legacyImportService: {},
    googleAccountService: { on: vi.fn() },
    skillsService,
    devBrowserService: { getPreviewInfo: vi.fn(), openPreviewPage: vi.fn() },
  } as unknown as RouteServices;
  return { services, registered, skillsService };
}

describe('skills.addFromGitHub RPC route (M2 T2)', () => {
  let registered: Map<string, RpcHandler>;
  let skillsService: SkillsService & Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    const built = buildServices();
    registered = built.registered;
    skillsService = built.skillsService;
    registerRpcMethods(built.services);
  });

  it('registers the T2 skills intake/delete routes', () => {
    expect(registered.has('skills.addFromPath')).toBe(true);
    expect(registered.has('skills.addFromGitHub')).toBe(true);
    expect(registered.has('skills.delete')).toBe(true);
    expect(registered.has('skills.getUserSkillsPath')).toBe(true);
  });

  it('happy path: passes the rawUrl through and returns the imported skill', async () => {
    const handler = registered.get('skills.addFromGitHub');
    const url = 'https://github.com/owner/repo/tree/main';
    await expect(handler?.({ rawUrl: url })).resolves.toEqual(SAMPLE_SKILL);
    expect(skillsService.addFromGitHub).toHaveBeenCalledWith(url);
  });

  it('accepts raw.githubusercontent.com URLs', async () => {
    const handler = registered.get('skills.addFromGitHub');
    const url = 'https://raw.githubusercontent.com/owner/repo/main/SKILL.md';
    await expect(handler?.({ rawUrl: url })).resolves.toEqual(SAMPLE_SKILL);
    expect(skillsService.addFromGitHub).toHaveBeenCalledWith(url);
  });

  it('rejects http:// URLs before reaching the service', async () => {
    const handler = registered.get('skills.addFromGitHub');
    await expect(handler?.({ rawUrl: 'http://github.com/owner/repo/tree/main' })).rejects.toThrow(
      /URL must use HTTPS and a github\.com or raw\.githubusercontent\.com host/,
    );
    expect(skillsService.addFromGitHub).not.toHaveBeenCalled();
  });

  it('rejects non-GitHub hosts before reaching the service', async () => {
    const handler = registered.get('skills.addFromGitHub');
    for (const url of [
      'https://evil.example.com/owner/repo/tree/main',
      'https://gitlab.com/owner/repo/tree/main',
      'https://raw.githubusercontent.com.evil.com/owner/repo/main/SKILL.md',
    ]) {
      await expect(handler?.({ rawUrl: url })).rejects.toThrow(/Invalid payload/);
    }
    expect(skillsService.addFromGitHub).not.toHaveBeenCalled();
  });

  it('rejects malformed URL strings and ftp before reaching the service', async () => {
    const handler = registered.get('skills.addFromGitHub');
    for (const url of ['not-a-url', 'ftp://github.com/owner/repo', '', 'github.com/owner/repo']) {
      await expect(handler?.({ rawUrl: url })).rejects.toThrow(/Invalid payload/);
    }
    expect(skillsService.addFromGitHub).not.toHaveBeenCalled();
  });

  it('the raw url is what agent-core normalizes (no daemon-side rewriting)', async () => {
    // The blob/tree → raw SKILL.md transformation stays inside agent-core
    // (`addSkill` → `addFromUrl` → `resolveGithubRawUrl`); the route and the
    // service must forward the user-supplied url verbatim.
    const handler = registered.get('skills.addFromGitHub');
    const url = 'https://github.com/owner/repo';
    await handler?.({ rawUrl: url });
    expect(skillsService.addFromGitHub).toHaveBeenCalledTimes(1);
    expect(skillsService.addFromGitHub.mock.calls[0]).toEqual([url]);
  });
});

describe('skills.addFromPath / skills.delete param shapes (M2 T2)', () => {
  let registered: Map<string, RpcHandler>;
  let skillsService: SkillsService & Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    const built = buildServices();
    registered = built.registered;
    skillsService = built.skillsService;
    registerRpcMethods(built.services);
  });

  it('addFromPath validates { sourcePath } and returns the service result', async () => {
    const handler = registered.get('skills.addFromPath');
    await expect(handler?.({ sourcePath: '/tmp/skills/new-skill' })).resolves.toEqual(SAMPLE_SKILL);
    expect(skillsService.addFromPath).toHaveBeenCalledWith('/tmp/skills/new-skill');
  });

  it('addFromPath rejects a missing sourcePath', async () => {
    const handler = registered.get('skills.addFromPath');
    await expect(handler?.({})).rejects.toThrow(/Invalid payload/);
    expect(skillsService.addFromPath).not.toHaveBeenCalled();
  });

  it('delete validates { skillId } and surfaces service errors', async () => {
    const handler = registered.get('skills.delete');
    handler?.({ skillId: 'skill-1' });
    expect(skillsService.delete).toHaveBeenCalledWith('skill-1');

    (skillsService.delete as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Skill not found or cannot be deleted');
    });
    await expect(handler?.({ skillId: 'official-x' })).rejects.toThrow(
      'Skill not found or cannot be deleted',
    );
  });
});
