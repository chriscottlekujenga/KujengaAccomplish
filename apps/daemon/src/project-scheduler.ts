import type { ProjectSubtask } from './project-plan-parser.js';

export interface ScheduledBatch {
  /** Subtasks that may run concurrently in this batch. */
  subtasks: ProjectSubtask[];
  /** True if this batch must run sequentially with any previous batch because at least one subtask edits files or is a migration. */
  sequential: boolean;
}

/**
 * Build batches of subtasks that can safely run in parallel.
 *
 * Rules:
 * - A subtask only appears after all of its declared dependencies have appeared.
 * - Subtasks with no unmet dependencies and that do not touch files are grouped
 *   into parallel batches.
 * - Subtasks that edit files or perform migrations run in a sequential batch.
 * - Sequential batches are emitted as single-item batches so callers run them
 *   one at a time.
 */
export function buildDependencyBatches(subtasks: ProjectSubtask[]): ScheduledBatch[] {
  if (subtasks.length === 0) {
    return [];
  }

  const remaining = new Map(subtasks.map((s) => [s.id, s]));
  const completed = new Set<string>();
  const batches: ScheduledBatch[] = [];

  while (remaining.size > 0) {
    // Find all ready subtasks whose dependencies are satisfied.
    const ready = [...remaining.values()].filter((s) =>
      s.dependsOn.every((dep) => completed.has(dep)),
    );

    if (ready.length === 0) {
      const remainingIds = [...remaining.keys()].join(', ');
      throw new Error(`Circular or unsatisfied dependency detected among: ${remainingIds}`);
    }

    // Emit file-editing work as sequential batches first, then parallel-safe ready subtasks together.
    const gates = ready.filter((s) => s.decisionGate);
    if (gates.length > 0) {
      const gate = gates[0];
      batches.push({ subtasks: [gate], sequential: true });
      remaining.delete(gate.id);
      completed.add(gate.id);
      continue;
    }
    const fileEditors = ready.filter((s) => s.fileEdits);
    for (const s of fileEditors) {
      batches.push({ subtasks: [s], sequential: true });
      remaining.delete(s.id);
      completed.add(s.id);
    }

    const parallelSafe = ready.filter((s) => !s.fileEdits);
    if (parallelSafe.length > 0) {
      batches.push({ subtasks: parallelSafe, sequential: false });
      for (const s of parallelSafe) {
        remaining.delete(s.id);
        completed.add(s.id);
      }
    }
  }

  return batches;
}

/**
 * Return a simple topological ordering (for callers that don't need batching).
 */
export function topologicalOrder(subtasks: ProjectSubtask[]): ProjectSubtask[] {
  const batches = buildDependencyBatches(subtasks);
  return batches.flatMap((b) => b.subtasks);
}
