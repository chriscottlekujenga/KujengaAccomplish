import { describe, it, expect } from 'vitest';
import { parseProjectPlan, ProjectPlanParseError } from '../../src/project-plan-parser.js';

const goal = 'Build a multi-model project mode';

function makePlan(overrides?: object) {
  return {
    summary: 'Break work into subtasks',
    subtasks: [
      {
        id: 'plan',
        title: 'Create plan',
        description: 'Create a plan with subtasks.',
        assignedModel: 'careful',
        fileEdits: false,
        dependsOn: [],
      },
      {
        id: 'code',
        title: 'Write code',
        description: 'Implement the orchestrator.',
        assignedModel: 'code',
        fileEdits: true,
        dependsOn: ['plan'],
      },
    ],
    ...overrides,
  };
}

describe('parseProjectPlan', () => {
  it('parses a fenced JSON plan', () => {
    const raw = '```json\n' + JSON.stringify(makePlan()) + '\n```';
    const plan = parseProjectPlan(raw, goal);
    expect(plan.summary).toBe('Break work into subtasks');
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[1].dependsOn).toEqual(['plan']);
    expect(plan.subtasks[1].fileEdits).toBe(true);
  });

  it('parses bare JSON', () => {
    const plan = parseProjectPlan(JSON.stringify(makePlan()), goal);
    expect(plan.subtasks[0].id).toBe('plan');
  });

  it('falls back to goal summary when missing', () => {
    const plan = parseProjectPlan(JSON.stringify(makePlan({ summary: undefined })), goal);
    expect(plan.summary).toBe(goal);
  });

  it('throws when JSON is invalid', () => {
    expect(() => parseProjectPlan('not json', goal)).toThrow(ProjectPlanParseError);
  });

  it('throws when subtasks is missing', () => {
    expect(() => parseProjectPlan(JSON.stringify({ summary: 'x' }), goal)).toThrow(
      ProjectPlanParseError,
    );
  });

  it('throws when a dependency is unknown', () => {
    const plan = makePlan();
    plan.subtasks[1].dependsOn = ['missing'];
    expect(() => parseProjectPlan(JSON.stringify(plan), goal)).toThrow(ProjectPlanParseError);
  });

  it('throws on self-dependency', () => {
    const plan = makePlan();
    plan.subtasks[0].dependsOn = ['plan'];
    expect(() => parseProjectPlan(JSON.stringify(plan), goal)).toThrow(ProjectPlanParseError);
  });

  it('generates ids for missing subtask ids', () => {
    const plan = makePlan();
    (plan.subtasks[0] as { id?: string }).id = undefined;
    plan.subtasks[1].dependsOn = [];
    const parsed = parseProjectPlan(JSON.stringify(plan), goal);
    expect(parsed.subtasks[0].id).toBe('auto-subtask-1');
  });
});
