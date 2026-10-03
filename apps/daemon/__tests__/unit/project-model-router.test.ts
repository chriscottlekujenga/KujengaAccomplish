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

  it('escalates migration tasks to GLM 5.3 Cloud', () => {
    const rec = assignModelForProjectSubtask(
      'Database migration',
      'Update the schema and migrate customer data.',
    );
    expect(rec.modelId).toBe('glm-5.3:cloud');
    expect(rec.role).toBe('escalated');
  });

  it('escalates security-sensitive work to GLM 5.3 Cloud', () => {
    const rec = assignModelForProjectSubtask(
      'Risk review',
      'Assess the security implications of the new design.',
    );
    expect(rec.modelId).toBe('glm-5.3:cloud');
    expect(rec.role).toBe('escalated');
  });

  it('assigns the low-cost language model for lightweight summaries', () => {
    const rec = assignModelForProjectSubtask('Summarize findings', 'Draft a brief summary.');
    expect(rec.modelId).toBe('gemma4:cloud');
    expect(rec.role).toBe('language');
  });

  it('uses a connected local model for bounded, read-only language work', () => {
    const rec = assignModelForProjectSubtask(
      'Summarize findings',
      'Extract the key points and draft a brief summary.',
      { provider: 'ollama', modelId: 'qwen3:4b', label: 'Ollama local: qwen3:4b' },
    );
    expect(rec).toMatchObject({
      role: 'local',
      provider: 'ollama',
      modelId: 'qwen3:4b',
    });
  });

  it('keeps code work in the cloud even when a local model is connected', () => {
    const rec = assignModelForProjectSubtask(
      'Implement API',
      'Write the user controller.',
      { provider: 'ollama', modelId: 'qwen3:4b', label: 'Ollama local: qwen3:4b' },
    );
    expect(rec.role).toBe('code');
  });
});

describe('getCoordinatorModel', () => {
  it('returns GLM 5.3 Flash Cloud by default', () => {
    const rec = getCoordinatorModel();
    expect(rec.modelId).toBe('glm-5.3-flash:cloud');
    expect(rec.role).toBe('coordinator');
  });

  it('escalates high-stakes coordination to GLM 5.3 Cloud', () => {
    const rec = getCoordinatorModel('Plan a production security migration');
    expect(rec.modelId).toBe('glm-5.3:cloud');
    expect(rec.role).toBe('escalated');
  });
});
