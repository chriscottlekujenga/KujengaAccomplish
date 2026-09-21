import { recommendModelForPrompt, type ModelRecommendation } from './prompt-model-router.js';

export type ProjectModelRole = 'coordinator' | 'fast' | 'careful' | 'code';

export interface ProjectModelAssignment extends ModelRecommendation {
  role: ProjectModelRole;
}

const ROLE_RECOMMENDATIONS: Record<ProjectModelRole, ModelRecommendation> = {
  coordinator: {
    modelId: 'glm-5.3:cloud',
    label: 'GLM 5.3 Cloud',
    reason: 'coordinator and general multi-step work',
  },
  fast: {
    modelId: 'glm-5.3-flash:cloud',
    label: 'GLM 5.3 Flash Cloud',
    reason: 'quick summaries, drafting, simple research, and lightweight subtasks',
  },
  careful: {
    modelId: 'gpt-oss:120b-cloud',
    label: 'GPT-OSS 120B Cloud',
    reason: 'careful analysis, architecture, planning, comparisons, risk assessment, and math',
  },
  code: {
    modelId: 'kimi-k2.7-code:cloud',
    label: 'Kimi K2.7 Code Cloud',
    reason: 'coding, debugging, tests, repository work, APIs, and databases',
  },
};

export function assignModelForProjectSubtask(
  subtaskTitle: string,
  subtaskDescription: string,
): ProjectModelAssignment {
  const text = `${subtaskTitle} ${subtaskDescription}`.toLowerCase();

  if (
    /\b(migrate|migration|refactor|refactoring|rewrite|schema|database|db|deploy|release|breaking)\b/.test(
      text,
    )
  ) {
    return { role: 'careful', ...ROLE_RECOMMENDATIONS.careful };
  }

  const routerRec = recommendModelForPrompt(text);
  const role: ProjectModelRole =
    routerRec.modelId === ROLE_RECOMMENDATIONS.code.modelId
      ? 'code'
      : routerRec.modelId === ROLE_RECOMMENDATIONS.careful.modelId
        ? 'careful'
        : routerRec.modelId === ROLE_RECOMMENDATIONS.fast.modelId
          ? 'fast'
          : 'coordinator';

  return { role, ...routerRec };
}

export function getCoordinatorModel(): ProjectModelAssignment {
  return { role: 'coordinator', ...ROLE_RECOMMENDATIONS.coordinator };
}
