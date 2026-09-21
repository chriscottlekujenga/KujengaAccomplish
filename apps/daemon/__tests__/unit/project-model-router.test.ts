import { describe, it, expect } from 'vitest';
import {
  assignModelForProjectSubtask,
  getCoordinatorModel,
} from '../../src/project-model-router.js';

describe('assignModelForProjectSubtask', () => {
  it('assigns code model for coding tasks', () => {
    const rec = assignModelForProjectSubtask('Implement API', 'Write the user controller.');
    expect(rec.modelId).toBe('kimi-k2.7-code:cloud');
    expect(rec.role).toBe('code');
  });

  it('assigns careful model for migration tasks', () => {
    const rec = assignModelForProjectSubtask(
      'Database migration',
      'Update the schema and migrate customer data.',
    );
    expect(rec.modelId).toBe('gpt-oss:120b-cloud');
    expect(rec.role).toBe('careful');
  });

  it('assigns careful model for risk assessment', () => {
    const rec = assignModelForProjectSubtask(
      'Risk review',
      'Assess the security implications of the new design.',
    );
    expect(rec.modelId).toBe('gpt-oss:120b-cloud');
    expect(rec.role).toBe('careful');
  });

  it('assigns fast model for lightweight summaries', () => {
    const rec = assignModelForProjectSubtask('Summarize findings', 'Draft a brief summary.');
    expect(rec.modelId).toBe('glm-5.3-flash:cloud');
    expect(rec.role).toBe('fast');
  });
});

describe('getCoordinatorModel', () => {
  it('returns GLM 5.3 Cloud', () => {
    const rec = getCoordinatorModel();
    expect(rec.modelId).toBe('glm-5.3:cloud');
    expect(rec.role).toBe('coordinator');
  });
});
