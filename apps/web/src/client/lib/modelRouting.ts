export interface ModelSuggestion {
  label: string;
  reason: string;
}

export function suggestModelForPrompt(prompt: string): ModelSuggestion | null {
  const text = prompt.trim().toLowerCase();
  if (!text) return null;
  if (/\b(code|coding|bug|debug|test|typescript|javascript|python|repository|repo|build|compile|terminal|command|api|database|sql|git)\b/.test(text)) {
    return { label: 'Kimi K2.7 Code Cloud', reason: 'coding and technical work' };
  }
  if (/\b(compare|analyze|analysis|reason|strategy|plan|decision|math|calculate|proof|trade-?off|risk)\b/.test(text)) {
    return { label: 'GPT-OSS 120B Cloud', reason: 'careful reasoning' };
  }
  if (text.length < 500 && /\b(summarize|summary|rewrite|email|message|translate|brainstorm|list|outline|draft)\b/.test(text)) {
    return { label: 'GLM 5.3 Flash Cloud', reason: 'quick everyday work' };
  }
  return { label: 'GLM 5.3 Cloud', reason: 'general multi-step work' };
}
