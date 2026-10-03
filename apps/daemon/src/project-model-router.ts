import { recommendModelForPrompt, type ModelRecommendation } from './prompt-model-router.js';
import type { ProviderId } from '@accomplish_ai/agent-core';

export type ProjectModelRole = 'coordinator' | 'fast' | 'language' | 'careful' | 'code' | 'local' | 'escalated';

export interface ProjectModelAssignment extends ModelRecommendation {
  role: ProjectModelRole;
  /** Set for local models so the CLI routes to the correct provider. */
  provider?: ProviderId;
}

/** A local model that has been explicitly connected in Accomplish settings. */
export interface LocalProjectModel {
  provider: Extract<ProviderId, 'ollama' | 'lmstudio'>;
  modelId: string;
  label: string;
}

const ROLE_RECOMMENDATIONS: Record<Exclude<ProjectModelRole, 'local'>, ModelRecommendation> = {
  coordinator: {
    modelId: 'glm-5.3-flash:cloud',
    label: 'GLM 5.3 Flash Cloud',
    reason: 'cost-efficient coordination and general multi-step work',
  },
  escalated: {
    modelId: 'glm-5.3:cloud',
    label: 'GLM 5.3 Cloud',
    reason: 'high-stakes coordination, ambiguous decisions, or recovery after a failed subtask',
  },
  fast: {
    modelId: 'glm-5.3-flash:cloud',
    label: 'GLM 5.3 Flash Cloud',
    reason: 'quick summaries, drafting, simple research, and lightweight subtasks',
  },
  language: {
    modelId: 'gemma4:cloud',
    label: 'Gemma 4 Cloud',
    reason: 'low-cost natural-language writing, rewriting, translation, and extraction',
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
  localModel?: LocalProjectModel | null,
): ProjectModelAssignment {
  const text = `${subtaskTitle} ${subtaskDescription}`.toLowerCase();

  if (
    /\b(migrate|migration|deploy|release|breaking|production|security|credential|privacy|compliance|legal|financial|payment|destructive|delete|data.loss)\b/.test(
      text,
    )
  ) {
    return { role: 'escalated', ...ROLE_RECOMMENDATIONS.escalated };
  }

  // Local inference is free of cloud token charges, but is deliberately limited
  // to short, read-only language work. Planning, code, tools, web work, and
  // consequential decisions remain on cloud models for reliability.
  const isBoundedLanguageWork =
    text.length <= 2_000 &&
    /\b(summarize|summary|rewrite|translate|extract|classify|proofread|format|outline|draft|copy)\b/.test(text) &&
    !/\b(code|bug|debug|test|build|terminal|browser|website|login|captcha|api|database|sql|deploy|security|risk|plan|decision|file|edit|delete|rename|send|publish)\b/.test(text);
  if (localModel && isBoundedLanguageWork) {
    return {
      role: 'local',
      modelId: localModel.modelId,
      provider: localModel.provider,
      label: localModel.label,
      reason: 'bounded, read-only language subtask; uses connected local model to conserve cloud tokens',
    };
  }

  const routerRec = recommendModelForPrompt(text);
  const role: ProjectModelRole =
    routerRec.modelId === ROLE_RECOMMENDATIONS.code.modelId
      ? 'code'
      : routerRec.modelId === ROLE_RECOMMENDATIONS.careful.modelId
        ? 'careful'
        : routerRec.modelId === ROLE_RECOMMENDATIONS.fast.modelId
          ? 'fast'
        : routerRec.modelId === ROLE_RECOMMENDATIONS.language.modelId
          ? 'language'
          : 'coordinator';

  return { role, ...routerRec };
}

export function getCoordinatorModel(
  goal = '',
  forceEscalation = false,
): ProjectModelAssignment {
  const highStakesGoal =
    /\b(migrate|migration|deploy|release|production|security|credential|privacy|compliance|legal|financial|payment|destructive|delete|data.loss|ambiguous|uncertain|trade.?off)\b/i.test(
      goal,
    );
  const role: Exclude<ProjectModelRole, 'local'> =
    forceEscalation || highStakesGoal ? 'escalated' : 'coordinator';
  return { role, ...ROLE_RECOMMENDATIONS[role] };
}
