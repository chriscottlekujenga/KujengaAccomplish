export interface ModelRecommendation {
  modelId: string;
  label: string;
  reason: string;
}

const recommendations = {
  default: {
    modelId: 'glm-5.3:cloud',
    label: 'GLM 5.3 Cloud',
    reason: 'best general choice for multi-step work',
  },
  fast: {
    modelId: 'glm-5.3-flash:cloud',
    label: 'GLM 5.3 Flash Cloud',
    reason: 'fast choice for straightforward writing and summaries',
  },
  careful: {
    modelId: 'gpt-oss:120b-cloud',
    label: 'GPT-OSS 120B Cloud',
    reason: 'careful reasoning and structured analysis',
  },
  code: {
    modelId: 'kimi-k2.7-code:cloud',
    label: 'Kimi K2.7 Code Cloud',
    reason: 'coding and long-running technical work',
  },
} as const;

export function recommendModelForPrompt(prompt: string): ModelRecommendation {
  const text = prompt.toLowerCase();
  if (/\b(code|coding|bug|debug|test|typescript|javascript|python|repository|repo|build|compile|terminal|command|api|database|sql|git)\b/.test(text)) {
    return recommendations.code;
  }
  if (/\b(compare|analyze|analysis|reason|strategy|plan|decision|math|calculate|proof|trade-?off|risk)\b/.test(text)) {
    return recommendations.careful;
  }
  if (text.length < 500 && /\b(summarize|summary|rewrite|email|message|translate|brainstorm|list|outline|draft)\b/.test(text)) {
    return recommendations.fast;
  }
  return recommendations.default;
}
