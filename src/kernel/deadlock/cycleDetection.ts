import { KernelInvariantError } from '../errors';
import type { Pid } from '../types';

const WHITE = 0;
const GREY = 1;
const BLACK = 2;

export function rotateToLowestPid(cycle: readonly Pid[]): Pid[] {
  if (cycle.length === 0) return [];
  let lowest = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    const value = cycle[index];
    const minimum = cycle[lowest];
    if (value === undefined || minimum === undefined) throw new KernelInvariantError(26, 'Cycle has a missing pid.');
    if (value < minimum) lowest = index;
  }
  return [...cycle.slice(lowest), ...cycle.slice(0, lowest)];
}

/** Ch. 8.7.1. Return the first ascending-start DFS cycle, with canonical rotation. */
export function findCycle(graph: ReadonlyMap<Pid, readonly Pid[]>): Pid[] | null {
  const nodes = [...graph.keys()].sort((a, b) => a - b);
  const colour = new Map<Pid, number>(nodes.map(pid => [pid, WHITE]));
  const parent = new Map<Pid, Pid | null>();
  for (const pid of nodes) {
    if (colour.get(pid) !== WHITE) continue;
    const stack: { node: Pid; index: number }[] = [{ node: pid, index: 0 }];
    colour.set(pid, GREY);
    parent.set(pid, null);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) throw new KernelInvariantError(26, 'DFS stack has a missing frame.');
      const adjacent = graph.get(top.node) ?? [];
      if (top.index >= adjacent.length) {
        stack.pop();
        colour.set(top.node, BLACK);
        continue;
      }
      const target = adjacent[top.index];
      top.index += 1;
      if (target === undefined) throw new KernelInvariantError(26, 'Wait-for adjacency has a missing target.');
      const targetColour = colour.get(target) ?? WHITE;
      if (targetColour === WHITE) {
        colour.set(target, GREY);
        parent.set(target, top.node);
        stack.push({ node: target, index: 0 });
      } else if (targetColour === GREY) {
        const cycle: Pid[] = [target];
        let cursor = top.node;
        while (cursor !== target) {
          cycle.push(cursor);
          const previous = parent.get(cursor);
          if (previous === undefined || previous === null) {
            throw new KernelInvariantError(26, 'DFS back edge has no complete parent path.');
          }
          cursor = previous;
        }
        cycle.reverse();
        return rotateToLowestPid(cycle);
      }
    }
  }
  return null;
}
