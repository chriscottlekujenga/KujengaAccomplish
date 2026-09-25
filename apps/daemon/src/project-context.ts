import type { ProjectPlan, ProjectSubtask } from './project-plan-parser.js';

export interface ProjectSubtaskResult {
  subtaskId: string;
  title: string;
  status: 'completed' | 'failed' | 'cancelled';
  modelId: string;
  output: string;
  changedFiles?: string[];
  error?: string;
}

export interface ProjectStateSnapshot {
  goal: string;
  planSummary: string;
  completedSubtasks: ProjectSubtaskResult[];
  changedFiles: string[];
}

export class ProjectContext {
  goal: string;
  plan: ProjectPlan;
  results: Map<string, ProjectSubtaskResult> = new Map();
  changedFiles: Set<string> = new Set();
  stopped = false;

  constructor(goal: string, plan: ProjectPlan) {
    this.goal = goal;
    this.plan = plan;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
  }

  addResult(result: ProjectSubtaskResult): void {
    this.results.set(result.subtaskId, result);
    for (const file of result.changedFiles ?? []) {
      this.changedFiles.add(file);
    }
  }

  getResult(subtaskId: string): ProjectSubtaskResult | undefined {
    return this.results.get(subtaskId);
  }

  getCompletedResults(): ProjectSubtaskResult[] {
    return [...this.results.values()].filter((r) => r.status === 'completed');
  }

  /** Build a compact prompt prefix for the next subtask. */
  buildSubtaskPrompt(subtask: ProjectSubtask): string {
    const completed = this.getCompletedResults();
    const fileContext =
      this.changedFiles.size > 0
        ? `\nFiles changed so far:\n${[...this.changedFiles].map((f) => `- ${f}`).join('\n')}`
        : '';

    const priorOutputs =
      completed.length > 0
        ? `\nPrior subtask outputs:\n${completed
            .map((r) => `## ${r.title}\nModel: ${r.modelId}\n${r.output}`)
            .join('\n\n')}`
        : '';

    return [
      `Project goal: ${this.goal}`,
      `Plan summary: ${this.plan.summary}`,
      `\nYour subtask: ${subtask.title}`,
      subtask.description,
      fileContext,
      priorOutputs,
      '\nComplete this subtask independently. Do not start other subtasks. Return a concise result.',
    ].join('\n');
  }

  /** Build a synthesis prompt for the coordinator. */
  buildSynthesisPrompt(): string {
    const completed = this.getCompletedResults();
    const failed = [...this.results.values()].filter((r) => r.status === 'failed');

    return [
      `Project goal: ${this.goal}`,
      `Plan summary: ${this.plan.summary}`,
      `\nCompleted subtasks:\n${completed
        .map(
          (r) =>
            `- ${r.title} (${r.modelId})\n${r.output.slice(0, 800)}${r.output.length > 800 ? '...' : ''}`,
        )
        .join('\n\n')}`,
      failed.length > 0
        ? `\nFailed subtasks:\n${failed.map((r) => `- ${r.title}: ${r.error ?? 'unknown error'}`).join('\n')}`
        : '',
      this.changedFiles.size > 0
        ? `\nFiles changed so far:\n${[...this.changedFiles].map((f) => `- ${f}`).join('\n')}`
        : '',
      '\nSynthesize these results into a final answer for the project goal. Then list any unfinished work and whether more subtasks are needed.',
      'Return JSON: { "synthesis": string, "unfinished": string[], "needsMoreSubtasks": boolean, "followUpSubtasks": [{ "title": string, "description": string, "assignedModel": "fast" | "careful" | "code" | "coordinator", "fileEdits": boolean, "dependsOn": string[], "decisionGate": boolean }] }',
    ].join('\n');
  }

  toSnapshot(): ProjectStateSnapshot {
    return {
      goal: this.goal,
      planSummary: this.plan.summary,
      completedSubtasks: this.getCompletedResults(),
      changedFiles: [...this.changedFiles],
    };
  }
}
