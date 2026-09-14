import type { CoffmanCondition, DeadlockSnapshotActor, Pid, ResourceId } from '../types';
import {
  actorKey, collectDependencies, compareActors, findActorCycle, scenarioLockResources,
} from './waitForGraph';
import type { WaitForGraphInput } from './waitForGraph';

const CONDITIONS: readonly CoffmanCondition[] = Object.freeze([
  'mutual_exclusion', 'hold_and_wait', 'no_preemption', 'circular_wait',
]);
const NEAR_CONDITIONS: readonly CoffmanCondition[] = Object.freeze([
  'mutual_exclusion', 'hold_and_wait', 'no_preemption',
]);

/** A confirmed cycle has four conditions; preemptibility selects recovery only. */
export function coffmanConditions(cycle: readonly Pid[] | null): readonly CoffmanCondition[] {
  return cycle === null || cycle.length === 0 ? [] : CONDITIONS;
}

export interface NearDeadlock {
  readonly chain: readonly Pid[];
  readonly resources: readonly ResourceId[];
  readonly conditions: readonly CoffmanCondition[];
}

/** Explicit warning query. Observation never invokes this graph analysis. */
export function nearDeadlocks(input: WaitForGraphInput): readonly NearDeadlock[] {
  const lockRoles = new Set(scenarioLockResources(input.scenarios));
  const exclusive = new Set(input.resources.filter(resource => resource.totalInstances > 0 && Number.isFinite(resource.totalInstances)).map(resource => resource.id));
  const held = new Set<string>();
  for (const process of input.processes) {
    if (!process.heldResources.some(resource => exclusive.has(resource))) continue;
    for (const thread of input.threads) if (thread.pid === process.pid && thread.state !== 'terminated') held.add(actorKey(thread));
  }
  for (const primitive of input.primitives) {
    if (primitive.kind === 'mutex' || primitive.kind === 'monitor') {
      exclusive.add(primitive.id);
      if (primitive.owner !== null) held.add(actorKey(primitive.owner));
    } else if (primitive.kind === 'rwlock' && primitive.writer !== null) {
      exclusive.add(primitive.id);
      held.add(actorKey(primitive.writer));
    } else if (primitive.kind === 'semaphore' && lockRoles.has(primitive.id)) {
      exclusive.add(primitive.id);
      for (const debit of primitive.debits) if (debit.actor !== null) held.add(actorKey(debit.actor));
    }
  }
  const dependencies = collectDependencies(input).filter(dependency =>
    (dependency.source.kind === 'resource_request' || dependency.source.kind === 'sync_wait')
    && exclusive.has(dependency.source.resource));
  const actors = new Map<string, DeadlockSnapshotActor>();
  const undirected = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    const from = actorKey(dependency.waiter);
    actors.set(from, dependency.waiter);
    for (const alternative of dependency.alternatives) {
      const to = actorKey(alternative);
      actors.set(to, alternative);
      for (const [left, right] of [[from, to], [to, from]] as const) {
        const neighbours = undirected.get(left) ?? new Set<string>();
        neighbours.add(right);
        undirected.set(left, neighbours);
      }
      const targets = outgoing.get(from) ?? new Set<string>();
      targets.add(to);
      outgoing.set(from, targets);
      const sources = incoming.get(to) ?? new Set<string>();
      sources.add(from);
      incoming.set(to, sources);
    }
  }
  const orderedKeys = [...actors.values()].sort(compareActors).map(actorKey);
  const compareKeys = (left: string, right: string): number => {
    const a = actors.get(left), b = actors.get(right);
    return a === undefined || b === undefined ? 0 : compareActors(a, b);
  };
  const visited = new Set<string>();
  const result: NearDeadlock[] = [];
  for (const start of orderedKeys) {
    if (visited.has(start)) continue;
    const component = new Set<string>();
    const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const key = queue[cursor];
      if (key === undefined || component.has(key)) continue;
      component.add(key);
      visited.add(key);
      queue.push(...(undirected.get(key) ?? []));
    }
    const edges = dependencies.filter(dependency => component.has(actorKey(dependency.waiter)));
    if (findActorCycle(edges) !== null) continue;
    const covered = new Set<string>();
    // A deterministic maximal-path cover visits every branch without enumerating
    // the exponentially many paths that a chain of diamonds could contain.
    for (const from of [...component].sort(compareKeys)) {
      for (const to of [...(outgoing.get(from) ?? [])].sort(compareKeys)) {
        const prefix = [from];
        let current = from;
        while (true) {
          const previous = [...(incoming.get(current) ?? [])].sort(compareKeys)[0];
          if (previous === undefined) break;
          prefix.push(previous);
          current = previous;
        }
        const path = [...prefix.reverse(), to];
        current = to;
        while (true) {
          const next = [...(outgoing.get(current) ?? [])].sort(compareKeys)[0];
          if (next === undefined) break;
          path.push(next);
          current = next;
        }
        const signature = JSON.stringify(path);
        if (covered.has(signature) || !path.slice(0, -1).some(key => held.has(key))) continue;
        covered.add(signature);
        const chain: Pid[] = [];
        for (const key of path) {
          const actor = actors.get(key);
          if (actor !== undefined && chain.at(-1) !== actor.pid) chain.push(actor.pid);
        }
        const resources = new Set<ResourceId>();
        for (let index = 0; index + 1 < path.length; index++) {
          for (const edge of edges) {
            if (actorKey(edge.waiter) !== path[index]
              || !edge.alternatives.some(actor => actorKey(actor) === path[index + 1])) continue;
            if (edge.source.kind === 'resource_request' || edge.source.kind === 'sync_wait') resources.add(edge.source.resource);
          }
        }
        result.push({ chain, resources: [...resources].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), conditions: NEAR_CONDITIONS });
      }
    }
  }
  return result;
}
