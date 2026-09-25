export interface ProjectSubtask {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  fileEdits: boolean;
  assignedModel?: string;
  decisionGate?: boolean;
}

export interface ProjectPlan {
  summary: string;
  subtasks: ProjectSubtask[];
}

export class ProjectPlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectPlanParseError';
  }
}

export function parseProjectPlan(raw: string, goal: string): ProjectPlan {
  const trimmed = raw.trim();

  // Extract JSON from a fenced code block if present.
  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = jsonBlockMatch ? jsonBlockMatch[1].trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new ProjectPlanParseError('Coordinator response was not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ProjectPlanParseError('Coordinator response was not a JSON object.');
  }

  const plan = parsed as { summary?: unknown; subtasks?: unknown };
  const summary = typeof plan.summary === 'string' ? plan.summary : '';

  if (!Array.isArray(plan.subtasks)) {
    throw new ProjectPlanParseError('Coordinator plan missing "subtasks" array.');
  }

  const subtasks = plan.subtasks.map((item: unknown, index: number): ProjectSubtask => {
    if (!item || typeof item !== 'object') {
      throw new ProjectPlanParseError(`Subtask ${index} is not an object.`);
    }
    const s = item as Record<string, unknown>;

    const rawId = typeof s.id === 'string' ? s.id : `auto-subtask-${index + 1}`;
    const title = typeof s.title === 'string' ? s.title : String(s.title ?? '');
    const description =
      typeof s.description === 'string' ? s.description : String(s.description ?? '');

    const dependsOn = Array.isArray(s.dependsOn)
      ? s.dependsOn.filter((d): d is string => typeof d === 'string')
      : [];

    const fileEdits = s.fileEdits === true || String(s.fileEdits).toLowerCase() === 'true';
    const assignedModel = typeof s.assignedModel === 'string' ? s.assignedModel : undefined;

    const decisionGate = s.decisionGate === true;
    return { id: rawId, title, description, dependsOn, fileEdits, assignedModel, decisionGate };
  });

  if (subtasks.length === 0) {
    throw new ProjectPlanParseError('Plan contains no subtasks.');
  }

  validateDependencies(subtasks);

  return { summary: summary || goal, subtasks };
}

function validateDependencies(subtasks: ProjectSubtask[]): void {
  const ids = new Set(subtasks.map((s) => s.id));
  for (const s of subtasks) {
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) {
        throw new ProjectPlanParseError(`Subtask "${s.id}" depends on unknown subtask "${dep}".`);
      }
      if (dep === s.id) {
        throw new ProjectPlanParseError(`Subtask "${s.id}" depends on itself.`);
      }
    }
  }
}
