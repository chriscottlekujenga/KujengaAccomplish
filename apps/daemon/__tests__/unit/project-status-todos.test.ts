import { describe, it, expect } from 'vitest';
import { projectStatusToTodos } from '../../src/project-orchestrator.js';
import type { ProjectStatus } from '../../src/project-orchestrator.js';

describe('projectStatusToTodos', () => {
  it('maps subtasks to todos including assigned model', () => {
    const status: ProjectStatus = {
      taskId: 't1',
      goal: 'goal',
      subtasks: [
        {
          subtaskId: 's1',
          title: 'Research',
          modelId: 'glm-5.3-flash:cloud',
          status: 'completed',
        },
        {
          subtaskId: 's2',
          title: 'Implement',
          modelId: 'kimi-k2.7-code:cloud',
          status: 'running',
        },
        {
          subtaskId: 's3',
          title: 'Plan DB',
          modelId: 'gpt-oss:120b-cloud',
          status: 'pending',
        },
      ],
      stopped: false,
      unfinished: [],
    };

    const todos = projectStatusToTodos(status);
    expect(todos).toHaveLength(3);
    expect(todos[0]).toMatchObject({
      id: 's1',
      content: 'Research',
      status: 'completed',
      model: 'glm-5.3-flash:cloud',
    });
    expect(todos[1]).toMatchObject({
      id: 's2',
      content: 'Implement',
      status: 'in_progress',
      model: 'kimi-k2.7-code:cloud',
    });
    expect(todos[2]).toMatchObject({
      id: 's3' in todos[2] ? 's3' : 's3',
      model: 'gpt-oss:120b-cloud',
      status: 'pending',
    });
  });

  it('maps failed subtasks to cancelled todo status', () => {
    const status: ProjectStatus = {
      taskId: 't2',
      goal: 'goal',
      subtasks: [
        {
          subtaskId: 's1',
          title: 'Broken',
          modelId: 'kimi-k2.7-code:cloud',
          status: 'failed',
        },
      ],
      stopped: false,
      unfinished: [],
    };

    const todos = projectStatusToTodos(status);
    expect(todos[0].status).toBe('cancelled');
    expect(todos[0].model).toBe('kimi-k2.7-code:cloud');
  });
});