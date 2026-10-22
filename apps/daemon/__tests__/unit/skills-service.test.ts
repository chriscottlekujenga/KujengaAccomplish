/**
 * Unit tests for SkillsService (M4 wrapper + Phase 3 M2 T2 GitHub intake).
 *
 * Proves the wrapper contract the renderer relies on:
 *   - delegation to the agent-core SkillsManager (mocked inner) — including
 *     that `addFromGitHub` forwards the RAW url (agent-core's
 *     `addSkill` → `addFromUrl` → `resolveGithubRawUrl` owns normalization);
 *   - `skills.changed` emissions for every write kind (added/removed/
 *     updated/resynced) with no event on failures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillsService, SKILLS_CHANGED } from '../../src/skills-service.js';
import type { Skill } from '@accomplish_ai/agent-core';

const skillsManagerMocks = vi.hoisted(() => ({
  createSkillsManager: vi.fn(),
}));

vi.mock('@accomplish_ai/agent-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...skillsManagerMocks };
});

const SAMPLE_SKILL: Skill = {
  id: 'skill-1',
  name: 'Test Skill',
  command: '/test-skill',
  description: 'A test skill',
  source: 'custom',
  isEnabled: true,
  isVerified: false,
  isHidden: false,
  filePath: '/tmp/skills/test-skill/SKILL.md',
  updatedAt: '2026-10-21T00:00:00.000Z',
};

function makeInner() {
  return {
    initialize: vi.fn(async () => undefined),
    resync: vi.fn(async () => [SAMPLE_SKILL]),
    getAllSkills: vi.fn(() => [SAMPLE_SKILL]),
    getEnabledSkills: vi.fn(() => [SAMPLE_SKILL]),
    getSkillById: vi.fn(() => SAMPLE_SKILL),
    setSkillEnabled: vi.fn(),
    getSkillContent: vi.fn(() => 'SKILL.md body'),
    addSkill: vi.fn(async () => SAMPLE_SKILL),
    deleteSkill: vi.fn(() => true),
  };
}

function makeService(inner = makeInner()): {
  service: SkillsService;
  inner: ReturnType<typeof makeInner>;
} {
  skillsManagerMocks.createSkillsManager.mockReturnValue(inner);
  const service = new SkillsService({
    dataDir: '/tmp/accomplish-data',
    bundledSkillsPath: '/tmp/bundled',
  });
  return { service, inner };
}

describe('SkillsService', () => {
  beforeEach(() => {
    skillsManagerMocks.createSkillsManager.mockReset();
  });

  it('derives the user skills path from the data dir', () => {
    const { service } = makeService();
    expect(service.getUserSkillsPath()).toBe('/tmp/accomplish-data/skills');
    expect(skillsManagerMocks.createSkillsManager).toHaveBeenCalledWith({
      bundledSkillsPath: '/tmp/bundled',
      userSkillsPath: '/tmp/accomplish-data/skills',
    });
  });

  it('initializes the inner manager once (idempotent)', async () => {
    const { service, inner } = makeService();
    await service.initialize();
    await service.initialize();
    expect(inner.initialize).toHaveBeenCalledTimes(1);
  });

  it('addFromPath delegates to inner.addSkill and emits added on success', async () => {
    const { service, inner } = makeService();
    const emitted: unknown[] = [];
    service.on(SKILLS_CHANGED, (payload) => {
      emitted.push(payload);
    });
    await expect(service.addFromPath('/tmp/skills/new-skill')).resolves.toEqual(SAMPLE_SKILL);
    expect(inner.addSkill).toHaveBeenCalledWith('/tmp/skills/new-skill');
    expect(emitted).toEqual([{ kind: 'added' }]);
  });

  it('addFromPath emits nothing when the inner manager returns null', async () => {
    const inner = makeInner();
    inner.addSkill.mockResolvedValue(null);
    const { service } = makeService(inner);
    const emitted: unknown[] = [];
    service.on(SKILLS_CHANGED, (payload) => {
      emitted.push(payload);
    });
    await expect(service.addFromPath('/tmp/not-a-skill')).resolves.toBeNull();
    expect(emitted).toEqual([]);
  });

  it('addFromGitHub forwards the raw url to the agent-core importer and emits added', async () => {
    const { service, inner } = makeService();
    const emitted: unknown[] = [];
    service.on(SKILLS_CHANGED, (payload) => {
      emitted.push(payload);
    });
    const url = 'https://github.com/owner/repo/tree/main';
    await expect(service.addFromGitHub(url)).resolves.toEqual(SAMPLE_SKILL);
    expect(inner.addSkill).toHaveBeenCalledWith(url);
    expect(emitted).toEqual([{ kind: 'added' }]);
  });

  it('addFromGitHub throws (no change event) when the importer fails', async () => {
    const inner = makeInner();
    inner.addSkill.mockResolvedValue(null);
    const { service } = makeService(inner);
    const emitted: unknown[] = [];
    service.on(SKILLS_CHANGED, (payload) => {
      emitted.push(payload);
    });
    await expect(service.addFromGitHub('https://github.com/owner/repo')).rejects.toThrow(
      'Failed to import skill from GitHub',
    );
    expect(emitted).toEqual([]);
  });

  it('setEnabled toggles and emits updated', () => {
    const { service, inner } = makeService();
    const emitted: unknown[] = [];
    service.on(SKILLS_CHANGED, (payload) => {
      emitted.push(payload);
    });
    service.setEnabled('skill-1', false);
    expect(inner.setSkillEnabled).toHaveBeenCalledWith('skill-1', false);
    expect(emitted).toEqual([{ kind: 'updated' }]);
  });

  it('delete throws for unknown skills and emits removed on success', () => {
    const inner = makeInner();
    inner.deleteSkill.mockReturnValue(false);
    const { service } = makeService(inner);
    const emitted: unknown[] = [];
    service.on(SKILLS_CHANGED, (payload) => {
      emitted.push(payload);
    });
    expect(() => service.delete('missing')).toThrow('Skill not found or cannot be deleted');
    expect(emitted).toEqual([]);

    inner.deleteSkill.mockReturnValue(true);
    service.delete('skill-1');
    expect(inner.deleteSkill).toHaveBeenCalledWith('skill-1');
    expect(emitted).toEqual([{ kind: 'removed' }]);
  });

  it('resync returns the reloaded list and emits resynced', async () => {
    const { service, inner } = makeService();
    const emitted: unknown[] = [];
    service.on(SKILLS_CHANGED, (payload) => {
      emitted.push(payload);
    });
    await expect(service.resync()).resolves.toEqual([SAMPLE_SKILL]);
    expect(inner.resync).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([{ kind: 'resynced' }]);
  });

  it('reads forward to the inner manager', () => {
    const { service, inner } = makeService();
    expect(service.list()).toEqual([SAMPLE_SKILL]);
    expect(service.listEnabled()).toEqual([SAMPLE_SKILL]);
    expect(service.getContent('skill-1')).toBe('SKILL.md body');
    expect(inner.getAllSkills).toHaveBeenCalledTimes(1);
    expect(inner.getEnabledSkills).toHaveBeenCalledTimes(1);
    expect(inner.getSkillContent).toHaveBeenCalledWith('skill-1');
  });
});
