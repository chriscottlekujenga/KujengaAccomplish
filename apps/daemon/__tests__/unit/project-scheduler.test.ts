import { describe, it, expect } from 'vitest';
import { buildDependencyBatches } from '../../src/project-scheduler.js';
import type { ProjectSubtask } from '../../src/project-plan-parser.js';

function st(
  id: string,
  deps: string[] = [],
  fileEdits = false,
): ProjectSubtask {
  return {
    id,
    title: id,
    description: id,
    dependsOn: deps,
    fileEdits,
  };
}

describe('buildDependencyBatches', () => {
  it('puts independent non-file subtasks in one parallel batch', () => {
    const batches = buildDependencyBatches([st('a'), st('b'), st('c')]);
    expect(batches).toHaveLength(1);
    expect(batches[0].sequential).toBe(false);
    expect(batches[0].subtasks.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('runs file-editing subtasks sequentially in their own batches', () => {
    const batches = buildDependencyBatches([
      st('a', [], true),
      st('b', [], true),
      st('c', [], false),
    ]);
    expect(batches).toHaveLength(3);
    expect(batches[0].sequential).toBe(true);
    expect(batches[0].subtasks.map((s) => s.id)).toEqual(['a']);
    expect(batches[1].sequential).toBe(true);
    expect(batches[1].subtasks.map((s) => s.id)).toEqual(['b']);
    expect(batches[2].sequential).toBe(false);
    expect(batches[2].subtasks.map((s) => s.id)).toEqual(['c']);
  });

  it('orders dependent subtasks after prerequisites', () => {
    const batches = buildDependencyBatches([st('b', ['a']), st('a'), st('c', ['b'])]);
    const order = batches.flatMap((b) => b.subtasks.map((s) => s.id));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keeps parallel-safe subtasks together when some have dependencies', () => {
    const batches = buildDependencyBatches([
      st('a'),
      st('b'),
      st('c', ['a', 'b']),
      st('d', ['c']),
    ]);
    expect(batches[0].subtasks.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(batches[1].subtasks.map((s) => s.id)).toEqual(['c']);
    expect(batches[2].subtasks.map((s) => s.id)).toEqual(['d']);
  });

  it('throws on circular dependencies', () => {
    expect(() => buildDependencyBatches([st('a', ['b']), st('b', ['a'])])).toThrow(
      /Circular or unsatisfied dependency/,
    );
  });
});
