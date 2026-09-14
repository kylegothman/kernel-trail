import type { Mailbox } from '../process/ipc';
import type { ThreadControlBlock } from '../process/threads';
import { asPid } from '../types';
import type {
  BlockReason, DeadlockSnapshotActor, DeadlockSnapshotDependency, DeadlockSnapshotState,
  Pid, ProcessControlBlock, ResourceId, ResourceType, SyncSnapshotPrimitive,
  SyncSnapshotScenario, SyncSnapshotWait,
} from '../types';
import { findCycle } from './cycleDetection';

type Actor = DeadlockSnapshotActor;
type Dependency = DeadlockSnapshotDependency;

/** Read-only owner views: the collector never consumes a reservation or an IPC result. */
export interface WaitForGraphInput {
  readonly processes: readonly Pick<ProcessControlBlock, 'pid' | 'state' | 'heldResources'>[];
  readonly threads: readonly ThreadControlBlock[];
  readonly resources: readonly ResourceType[];
  readonly requests: DeadlockSnapshotState['payload']['requests'];
  readonly primitives: readonly SyncSnapshotPrimitive[];
  readonly waits: readonly SyncSnapshotWait[];
  readonly scenarios: readonly SyncSnapshotScenario[];
  readonly mailboxEndpoints: DeadlockSnapshotState['payload']['mailboxEndpoints'];
  readonly reserved: (generation: number) => boolean;
  readonly mailbox: (id: ResourceId) => Pick<Mailbox, 'id' | 'sendWaiters' | 'recvWaiters'> | undefined;
  readonly matchesIpcWait: (pid: Pid, reason: BlockReason) => boolean;
  readonly hasIpcCompletion: (pid: Pid) => boolean;
}

export function actorKey(actor: Actor): string { return `${actor.pid}:${actor.tid}`; }
export function compareActors(left: Actor, right: Actor): number { return left.pid - right.pid || left.tid - right.tid; }
const compareStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const liveProcess = (state: ProcessControlBlock['state']): boolean => state !== 'terminated' && state !== 'zombie';

export function scenarioLockResources(scenarios: readonly SyncSnapshotScenario[]): readonly ResourceId[] {
  const result = new Set<ResourceId>();
  for (const scenario of scenarios) {
    if (scenario.kind === 'bounded_buffer') result.add(scenario.mutex);
    if (scenario.kind === 'philosophers' && scenario.bindings.kind === 'chopsticks') {
      for (const resource of scenario.bindings.chopsticks) result.add(resource);
    }
  }
  return [...result].sort(compareStrings);
}

/** Canonical identity includes the entire OR group, so a changed group starts a new observation. */
export function dependencyKey(dependency: Dependency): string {
  const source = dependency.source;
  const origin = source.kind === 'resource_request' ? [source.kind, source.resource, source.requestGeneration]
    : source.kind === 'sync_wait' ? [source.kind, source.resource, source.waitGeneration]
      : source.kind === 'mailbox' ? [source.kind, source.mailbox, source.operation]
        : [source.kind, source.child];
  return JSON.stringify([dependency.waiter.pid, dependency.waiter.tid, origin,
    dependency.alternatives.map(actor => [actor.pid, actor.tid])]);
}

/** Phase-nine observation is a collection pass only; cycle algorithms are intentionally absent. */
export function collectDependencies(input: WaitForGraphInput): readonly Dependency[] {
  const livePids = new Set(input.processes.filter(process => liveProcess(process.state)).map(process => process.pid));
  const actors = new Map<string, ThreadControlBlock>();
  const byPid = new Map<Pid, Actor[]>();
  for (const thread of [...input.threads].sort(compareActors)) {
    if (thread.state === 'terminated' || !livePids.has(thread.pid)) continue;
    actors.set(actorKey(thread), thread);
    const siblings = byPid.get(thread.pid) ?? [];
    siblings.push({ pid: thread.pid, tid: thread.tid });
    byPid.set(thread.pid, siblings);
  }
  const result: Dependency[] = [];
  const add = (waiter: Actor, source: Dependency['source'], alternatives: readonly Actor[]): void => {
    const unique = new Map<string, Actor>();
    for (const actor of alternatives) if (actors.has(actorKey(actor))) unique.set(actorKey(actor), { pid: actor.pid, tid: actor.tid });
    if (unique.size === 0) return;
    result.push({ waiter: { pid: waiter.pid, tid: waiter.tid }, source, alternatives: [...unique.values()].sort(compareActors) });
  };
  const waiting = (actor: Actor): ThreadControlBlock | undefined => {
    const thread = actors.get(actorKey(actor));
    return thread?.state === 'waiting' && thread.blockedOn !== null ? thread : undefined;
  };
  const resources = new Map(input.resources.map(resource => [resource.id, resource]));
  for (const request of input.requests) {
    const thread = waiting(request.actor);
    if (request.grantedAt !== null || thread === undefined || thread.blockedOn?.kind !== 'semaphore') continue;
    const reasonResource = thread.blockedOn.resource;
    if (!request.resources.some(([resource]) => resource === reasonResource)) continue;
    for (const [resource, count] of request.resources) {
      const declaration = resources.get(resource);
      if (declaration === undefined || count <= declaration.availableInstances) continue;
      for (const process of input.processes) {
        if (!livePids.has(process.pid) || !process.heldResources.includes(resource)) continue;
        add(request.actor, { kind: 'resource_request', resource, requestGeneration: request.generation }, byPid.get(process.pid) ?? []);
      }
    }
  }
  const primitives = new Map(input.primitives.map(primitive => [primitive.id, primitive]));
  const lockRoles = new Set(scenarioLockResources(input.scenarios));
  for (const wait of input.waits) {
    const thread = waiting(wait.actor);
    if (thread === undefined || input.reserved(wait.generation)) continue;
    const reason = thread.blockedOn;
    if (reason === null || (reason.kind !== 'mutex' && reason.kind !== 'semaphore' && reason.kind !== 'condition')) continue;
    const reasonResource = reason.kind === 'condition' ? reason.monitor : reason.resource;
    if (reasonResource !== wait.resource || input.matchesIpcWait(wait.actor.pid, reason)) continue;
    const primitive = primitives.get(wait.resource);
    if (primitive === undefined) continue;
    const source: Dependency['source'] = { kind: 'sync_wait', resource: wait.resource, waitGeneration: wait.generation };
    if ((primitive.kind === 'mutex' && wait.operation.kind === 'mutex')
      || (primitive.kind === 'monitor' && wait.operation.kind === 'monitor_entry')) {
      if (primitive.owner !== null) add(wait.actor, source, [primitive.owner]);
    } else if (primitive.kind === 'rwlock' && (wait.operation.kind === 'rw_read' || wait.operation.kind === 'rw_write')) {
      // Reader-only and mixed reader/upgrade ownership have no exclusive-owner proof.
      if (primitive.writer !== null) add(wait.actor, source, [primitive.writer]);
    } else if (primitive.kind === 'semaphore' && wait.operation.kind === 'semaphore') {
      if (lockRoles.has(primitive.id)) {
        for (const debit of primitive.debits) if (debit.actor !== null) add(wait.actor, source, [debit.actor]);
      } else {
        for (const scenario of input.scenarios) {
          if (scenario.kind !== 'bounded_buffer') continue;
          const role = scenario.empty === primitive.id ? 'consumer' : scenario.full === primitive.id ? 'producer' : null;
          if (role === null) continue;
          add(wait.actor, source, scenario.actors.filter(actor => actor.role === role && actor.completedItems < actor.targetItems).map(actor => actor.actor));
        }
      }
    }
  }
  for (const thread of actors.values()) {
    if (thread.state !== 'waiting' || thread.blockedOn === null) continue;
    const reason = thread.blockedOn;
    if (reason.kind === 'child_wait' && reason.child !== null) {
      for (const childActor of byPid.get(reason.child) ?? []) {
        add(thread, { kind: 'child_wait', child: reason.child }, [childActor]);
      }
    }
    if (!input.matchesIpcWait(thread.pid, reason) || input.hasIpcCompletion(thread.pid)) continue;
    for (const endpoints of input.mailboxEndpoints) {
      const mailbox = input.mailbox(endpoints.mailbox);
      if (mailbox === undefined) continue;
      if (reason.kind === 'semaphore' && reason.resource === `mbox:${mailbox.id}:send`
        && mailbox.sendWaiters.includes(thread.pid) && endpoints.senders.some(actor => actorKey(actor) === actorKey(thread))) {
        add(thread, { kind: 'mailbox', mailbox: mailbox.id, operation: 'send' }, endpoints.receivers);
      } else if (reason.kind === 'semaphore' && reason.resource === `mbox:${mailbox.id}:recv`
        && mailbox.recvWaiters.includes(thread.pid) && endpoints.receivers.some(actor => actorKey(actor) === actorKey(thread))) {
        add(thread, { kind: 'mailbox', mailbox: mailbox.id, operation: 'recv' }, endpoints.senders);
      }
    }
  }
  const unique = new Map(result.map(dependency => [dependencyKey(dependency), dependency]));
  return [...unique.values()].sort((left, right) => compareActors(left.waiter, right.waiter) || compareStrings(dependencyKey(left), dependencyKey(right)));
}

/** Raw projection is useful for a warning view; it is not itself a deadlock proof. */
export function projectDependencies(dependencies: readonly Dependency[], pids: readonly Pid[]): ReadonlyMap<Pid, readonly Pid[]> {
  const graph = new Map<Pid, Set<Pid>>([...pids].sort((left, right) => left - right).map(pid => [pid, new Set<Pid>()]));
  for (const dependency of dependencies) {
    const targets = graph.get(dependency.waiter.pid);
    if (targets === undefined) continue;
    for (const alternative of dependency.alternatives) if (graph.has(alternative.pid)) targets.add(alternative.pid);
  }
  return new Map([...graph].map(([pid, targets]) => [pid, [...targets].sort((left, right) => left - right)]));
}

/** Remove a waiter once every blocking group has at least one actor that can progress. */
export function closeDependencies(dependencies: readonly Dependency[]): readonly Dependency[] {
  const actors = new Set(dependencies.map(dependency => actorKey(dependency.waiter)));
  const valid = dependencies.map(dependency => dependency.alternatives.length > 0 && dependency.alternatives.every(actor => actors.has(actorKey(actor))));
  const counts = new Map<string, number>();
  const dependents = new Map<string, number[]>();
  for (const [index, dependency] of dependencies.entries()) {
    const waiter = actorKey(dependency.waiter);
    if (valid[index] === true) counts.set(waiter, (counts.get(waiter) ?? 0) + 1);
    for (const alternative of dependency.alternatives) {
      const key = actorKey(alternative);
      const groups = dependents.get(key) ?? [];
      groups.push(index);
      dependents.set(key, groups);
    }
  }
  const removed = new Set<string>();
  const queue = [...actors].filter(actor => (counts.get(actor) ?? 0) === 0);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const actor = queue[cursor];
    if (actor === undefined || removed.has(actor)) continue;
    removed.add(actor);
    for (const index of dependents.get(actor) ?? []) {
      if (valid[index] !== true) continue;
      valid[index] = false;
      const dependency = dependencies[index];
      if (dependency === undefined) continue;
      const waiter = actorKey(dependency.waiter);
      const remaining = (counts.get(waiter) ?? 0) - 1;
      counts.set(waiter, remaining);
      if (remaining === 0) queue.push(waiter);
    }
  }
  return dependencies.filter((dependency, index) => valid[index] === true && !removed.has(actorKey(dependency.waiter)));
}

/**
 * Mixed waits need a joint progress proof: the classic resource reduction cannot
 * assume that a zero-Request mutex or mailbox holder is able to finish.
 * This is detector work, never part of the phase-nine observation collector.
 */
export function qualifyResourceDependencies(
  input: WaitForGraphInput,
  dependencies: readonly Dependency[],
): readonly Dependency[] {
  const livePids = new Set(input.processes.filter(process => liveProcess(process.state)).map(process => process.pid));
  const siblings = new Map<Pid, Actor[]>();
  for (const thread of input.threads) {
    if (thread.state === 'terminated' || !livePids.has(thread.pid)) continue;
    const actors = siblings.get(thread.pid) ?? [];
    actors.push(thread);
    siblings.set(thread.pid, actors);
  }
  const trapped = new Set(dependencies.map(dependency => actorKey(dependency.waiter)));
  const byWaiter = new Map<string, Dependency[]>();
  for (const dependency of dependencies) {
    const key = actorKey(dependency.waiter);
    const groups = byWaiter.get(key) ?? [];
    groups.push(dependency);
    byWaiter.set(key, groups);
  }
  const requests = new Map(input.requests.filter(request => request.grantedAt === null).map(request => [actorKey(request.actor), request]));
  const availableAfterProgress = (): Map<ResourceId, number> => {
    const work = new Map(input.resources.map(resource => [resource.id, resource.availableInstances]));
    for (const process of input.processes) {
      if (!(siblings.get(process.pid) ?? []).some(actor => !trapped.has(actorKey(actor)))) continue;
      for (const resource of process.heldResources) {
        const available = work.get(resource);
        if (available !== undefined) work.set(resource, available + 1);
      }
    }
    return work;
  };
  for (;;) {
    const work = availableAfterProgress();
    const progressing: string[] = [];
    for (const key of trapped) {
      const groups = byWaiter.get(key) ?? [];
      const nonresourceBlocked = groups.some(group => group.source.kind !== 'resource_request'
        && group.alternatives.length > 0 && group.alternatives.every(actor => trapped.has(actorKey(actor))));
      const request = requests.get(key);
      const resourceBlocked = request !== undefined && request.resources.some(([resource, count]) => {
        const available = work.get(resource);
        return available !== undefined && count > available;
      });
      if (!nonresourceBlocked && !resourceBlocked) progressing.push(key);
    }
    if (progressing.length === 0) break;
    for (const key of progressing) trapped.delete(key);
  }
  const work = availableAfterProgress();
  return dependencies.filter(dependency => {
    const key = actorKey(dependency.waiter);
    if (!trapped.has(key) || !dependency.alternatives.every(actor => trapped.has(actorKey(actor)))) return false;
    if (dependency.source.kind !== 'resource_request') return true;
    const source = dependency.source;
    const request = requests.get(key);
    const amount = request?.resources.find(([resource]) => resource === source.resource)?.[1];
    const available = work.get(source.resource);
    return request?.generation === source.requestGeneration && amount !== undefined && available !== undefined && amount > available;
  });
}

export interface ClosedWaitForGraph {
  readonly graph: ReadonlyMap<Pid, readonly Pid[]>;
  readonly closedDependencies: readonly Dependency[];
  readonly actorCycle: readonly Actor[] | null;
}

/** Only the gated detector calls this function. Resource thresholds are proved separately. */
export function buildWaitForGraph(
  dependencies: readonly Dependency[],
  pids: readonly Pid[],
  resourceCandidatePids?: ReadonlySet<Pid>,
): ClosedWaitForGraph {
  const filtered = resourceCandidatePids === undefined ? dependencies : dependencies.filter(dependency =>
    dependency.source.kind !== 'resource_request' || (resourceCandidatePids.has(dependency.waiter.pid)
      && dependency.alternatives.every(actor => resourceCandidatePids.has(actor.pid))));
  const closedDependencies = closeDependencies(filtered);
  const actorCycle = findActorCycle(closedDependencies);
  return { graph: projectDependencies(closedDependencies, pids), closedDependencies, actorCycle };
}

/** Dense numeric labels preserve PID/TID order while sharing the iterative DFS implementation. */
export function findActorCycle(dependencies: readonly Dependency[]): readonly Actor[] | null {
  const actors = new Map<string, Actor>();
  for (const dependency of dependencies) {
    actors.set(actorKey(dependency.waiter), dependency.waiter);
    for (const actor of dependency.alternatives) actors.set(actorKey(actor), actor);
  }
  const ordered = [...actors.values()].sort(compareActors);
  const ids = new Map(ordered.map((actor, index) => [actorKey(actor), asPid(index)]));
  const graph = new Map<Pid, Set<Pid>>(ordered.map((_, index) => [asPid(index), new Set<Pid>()]));
  for (const dependency of dependencies) {
    const from = ids.get(actorKey(dependency.waiter));
    if (from === undefined) continue;
    for (const actor of dependency.alternatives) {
      const to = ids.get(actorKey(actor));
      if (to !== undefined) graph.get(from)?.add(to);
    }
  }
  const cycle = findCycle(new Map([...graph].map(([pid, edges]) => [pid, [...edges].sort((left, right) => left - right)])));
  return cycle === null ? null : cycle.map(pid => {
    const actor = ordered[pid];
    if (actor === undefined) throw new Error('actor cycle index disappeared');
    return actor;
  });
}
