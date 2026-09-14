import { describe, expect, it } from 'vitest';
import type { ThreadControlBlock } from '../../../src/kernel/process/threads';
import { asPid, asResourceId, asTick } from '../../../src/kernel/types';
import type { BlockReason, DeadlockSnapshotActor, DeadlockSnapshotDependency, ResourceType, SyncSnapshotPrimitive, SyncSnapshotScenario, SyncSnapshotWait, Tid } from '../../../src/kernel/types';
import { findCycle, rotateToLowestPid } from '../../../src/kernel/deadlock/cycleDetection';
import { coffmanConditions, nearDeadlocks } from '../../../src/kernel/deadlock/coffman';
import { buildWaitForGraph, collectDependencies, dependencyKey, projectDependencies, qualifyResourceDependencies, scenarioLockResources } from '../../../src/kernel/deadlock/waitForGraph';
import type { WaitForGraphInput } from '../../../src/kernel/deadlock/waitForGraph';

const actor = (pid: number, tid = pid): DeadlockSnapshotActor => ({ pid: asPid(pid), tid: tid as Tid });
const rid = asResourceId;
const thread = (pid: number, blockedOn: BlockReason | null, tid = pid): ThreadControlBlock => ({
  ...actor(pid, tid), state: blockedOn === null ? 'ready' : 'waiting', blockedOn,
  programCounter: 0, serviceRemaining: 100, lwp: tid,
});
const semReason = (resource: string): BlockReason => ({ kind: 'semaphore', resource: rid(resource) });
const mutexReason = (resource: string): BlockReason => ({ kind: 'mutex', resource: rid(resource) });
const resource = (id: string, totalInstances = 1, availableInstances = 0, preemptible = false): ResourceType => ({
  id: rid(id), displayName: id, totalInstances, availableInstances, preemptible,
});
const process = (pid: number, held: readonly string[] = [], state: 'waiting' | 'ready' = 'waiting') => ({
  pid: asPid(pid), state, heldResources: held.map(rid),
});
const request = (pid: number, resource: string, generation = pid, tid = pid) => ({
  generation, actor: actor(pid, tid), requestedAt: asTick(0), resources: [[rid(resource), 1]] as const, grantedAt: null,
});
const mutex = (id: string, owner: DeadlockSnapshotActor | null): SyncSnapshotPrimitive => ({
  id: rid(id), displayName: id, capacity: 1, ordered: true, kind: 'mutex', owner, entryQueue: [],
});
const semaphore = (id: string, owners: readonly (DeadlockSnapshotActor | null)[], capacity = 1): SyncSnapshotPrimitive => ({
  id: rid(id), displayName: id, capacity, ordered: true, kind: 'semaphore', initialValue: capacity,
  debits: owners.map((owner, index) => ({ id: index, actor: owner })), waitQueue: [],
});
const wait = (pid: number, resource: string, kind: 'mutex' | 'semaphore' | 'monitor_entry' | 'rw_read' | 'rw_write' = 'mutex', tid = pid): SyncSnapshotWait => ({
  generation: tid, actor: actor(pid, tid), resource: rid(resource), operation: { kind }, requestedAt: asTick(0),
  entriesObserved: 0, boundedWarningEmitted: false, starvationWarningEmitted: false, starvationFatalEmitted: false,
});
const input = (overrides: Partial<WaitForGraphInput>): WaitForGraphInput => ({
  processes: [], threads: [], resources: [], requests: [], primitives: [], waits: [], scenarios: [], mailboxEndpoints: [],
  reserved: () => false, mailbox: () => undefined, matchesIpcWait: () => false, hasIpcCompletion: () => false,
  ...overrides,
});
const graph = (fixture: WaitForGraphInput) => buildWaitForGraph(collectDependencies(fixture), fixture.processes.map(process => process.pid));
const boundedBuffer = (consumers: readonly number[] = [2]): SyncSnapshotScenario => ({
  kind: 'bounded_buffer', id: 'buffer', variant: 'wrong_order', capacity: 1,
  mutex: rid('lock'), empty: rid('empty'), full: rid('full'), cell: 'buffer-cell', items: [0],
  produced: 1, consumed: 0, inFlight: 0, reservations: [],
  actors: [{ actor: actor(1), role: 'producer', targetItems: 2, workTicks: 1, completedItems: 1 },
    ...consumers.map(pid => ({ actor: actor(pid), role: 'consumer' as const, targetItems: 2, workTicks: 1, completedItems: 0 }))],
});
const mutexCycle = (): WaitForGraphInput => input({
  processes: [process(1), process(2)], threads: [thread(1, mutexReason('B')), thread(2, mutexReason('A'))],
  primitives: [mutex('A', actor(1)), mutex('B', actor(2))], waits: [wait(1, 'B'), wait(2, 'A')],
});

describe('deterministic iterative cycle detection', () => {
  it('DL-CYCLE-1 keeps forward edge orientation and rotates to the lowest PID', () => {
    const g = new Map([[asPid(3), [asPid(1)]], [asPid(2), [asPid(3)]], [asPid(1), [asPid(2)]]]);
    expect(findCycle(g)).toEqual([1, 2, 3]);
    expect(rotateToLowestPid([asPid(3), asPid(1), asPid(2)])).toEqual([1, 2, 3]);
  });
  it('DL-CYCLE-2 returns null for an acyclic graph', () => {
    expect(findCycle(new Map([[asPid(1), [asPid(2)]], [asPid(2), []]]))).toBeNull();
  });
  it('finds the first ascending-start DFS cycle, not a globally selected cycle', () => {
    expect(findCycle(new Map([
      [asPid(8), [asPid(9)]], [asPid(9), [asPid(8)]],
      [asPid(2), [asPid(3)]], [asPid(3), [asPid(2)]],
    ]))).toEqual([2, 3]);
    expect(findCycle(new Map([
      [asPid(1), [asPid(8)]], [asPid(8), [asPid(9)]], [asPid(9), [asPid(8)]],
      [asPid(2), [asPid(3)]], [asPid(3), [asPid(2)]],
    ]))).toEqual([8, 9]);
  });
  it('walks a 100,000-node chain without recursion', () => {
    const g = new Map(Array.from({ length: 100_000 }, (_, index) => [asPid(index), index === 99_999 ? [] : [asPid(index + 1)]] as const));
    expect(findCycle(g)).toBeNull();
  });
});

describe('resource and actor dependencies', () => {
  it('collects every holder with sorted adjacency and keeps an empty ready node', () => {
    const fixture = input({
      processes: [process(3, ['A']), process(4, [], 'ready'), process(2, ['A']), process(1, ['B'])],
      threads: [thread(3, semReason('B')), thread(4, null), thread(2, semReason('B')), thread(1, semReason('A'))],
      resources: [resource('A', 2), resource('B')], requests: [request(3, 'B'), request(2, 'B'), request(1, 'A')],
    });
    const result = graph(fixture);
    expect([...result.graph.keys()]).toEqual([1, 2, 3, 4]);
    expect(result.graph.get(asPid(1))).toEqual([2, 3]);
    expect(result.graph.get(asPid(4))).toEqual([]);
    for (const edges of result.graph.values()) expect(edges).toEqual([...new Set(edges)].sort((a, b) => a - b));
  });
  it('a runnable sibling can release process-owned resources, breaking closure', () => {
    const fixture = input({
      processes: [process(1, ['A']), process(2, ['B'], 'ready')],
      threads: [thread(1, semReason('B')), thread(2, semReason('A')), thread(2, null, 3)],
      resources: [resource('A'), resource('B')], requests: [request(1, 'B'), request(2, 'A')],
    });
    expect(collectDependencies(fixture)[0]?.alternatives).toEqual([actor(2), actor(2, 3)]);
    expect(graph(fixture).actorCycle).toBeNull();
    expect(graph(fixture).closedDependencies).toEqual([]);
  });
  it('reserved resource requests and currently available vectors add no edges', () => {
    const base = input({
      processes: [process(1), process(2, ['A'])], threads: [thread(1, semReason('A')), thread(2, null)],
      resources: [resource('A')], requests: [{ ...request(1, 'A'), grantedAt: asTick(2) }],
    });
    expect(collectDependencies(base)).toEqual([]);
    expect(collectDependencies({ ...base, resources: [resource('A', 2, 1)], requests: [request(1, 'A')] })).toEqual([]);
  });
  it('keeps full vector generations in observation identity', () => {
    const dependency: DeadlockSnapshotDependency = {
      waiter: actor(1), source: { kind: 'resource_request', resource: rid('A'), requestGeneration: 1 }, alternatives: [actor(2)],
    };
    expect(dependencyKey(dependency)).not.toEqual(dependencyKey({ ...dependency, alternatives: [actor(2), actor(2, 3)] }));
    expect(dependencyKey(dependency)).not.toEqual(dependencyKey({ ...dependency, source: { kind: 'resource_request', resource: rid('A'), requestGeneration: 2 } }));
  });
  it('observation identity ignores JSON object property insertion order', () => {
    const dependency: DeadlockSnapshotDependency = {
      waiter: actor(1), source: { kind: 'sync_wait', resource: rid('A'), waitGeneration: 1 }, alternatives: [actor(2)],
    };
    const reordered: DeadlockSnapshotDependency = {
      alternatives: [{ tid: actor(2).tid, pid: actor(2).pid }],
      source: { waitGeneration: 1, resource: rid('A'), kind: 'sync_wait' },
      waiter: { tid: actor(1).tid, pid: actor(1).pid },
    };
    expect(dependencyKey(reordered)).toBe(dependencyKey(dependency));
  });
  it('does not invent a cycle by projecting different unblocked sibling owners to one PID', () => {
    const fixture = input({
      processes: [process(1, [], 'ready'), process(2, [], 'ready')],
      threads: [thread(1, mutexReason('B'), 1), thread(1, null, 2), thread(2, null, 3), thread(2, mutexReason('A'), 4)],
      primitives: [mutex('A', actor(1, 2)), mutex('B', actor(2, 3))], waits: [wait(1, 'B', 'mutex', 1), wait(2, 'A', 'mutex', 4)],
    });
    expect(findCycle(projectDependencies(collectDependencies(fixture), [asPid(1), asPid(2)]))).toEqual([1, 2]);
    expect(graph(fixture).actorCycle).toBeNull();
    expect(findCycle(graph(fixture).graph)).toBeNull();
  });
  it('a genuine same-process thread cycle projects to a justified self-edge', () => {
    const fixture = input({
      processes: [process(1)], threads: [thread(1, mutexReason('B'), 1), thread(1, mutexReason('A'), 2)],
      primitives: [mutex('A', actor(1, 1)), mutex('B', actor(1, 2))], waits: [wait(1, 'B', 'mutex', 1), wait(1, 'A', 'mutex', 2)],
    });
    expect(graph(fixture).actorCycle).toEqual([actor(1, 1), actor(1, 2)]);
    expect(findCycle(graph(fixture).graph)).toEqual([1]);
  });
  it.each([1, 2])('mixed R(2) request of %i respects the instance a runnable third holder can return', count => {
    const fixture = input({
      processes: [process(1, ['R']), process(2, ['M']), process(3, ['R'], 'ready')],
      threads: [thread(1, mutexReason('M')), thread(2, semReason('R')), thread(3, null)],
      resources: [resource('R', 2)], primitives: [mutex('M', actor(2))], waits: [wait(1, 'M')],
      requests: [{ ...request(2, 'R'), resources: [[rid('R'), count]] }],
    });
    const qualified = qualifyResourceDependencies(fixture, collectDependencies(fixture));
    const result = buildWaitForGraph(qualified, fixture.processes.map(process => process.pid));
    if (count === 1) {
      expect(qualified).toEqual([]);
      expect(result.actorCycle).toBeNull();
    } else {
      expect(result.actorCycle).toEqual([actor(1), actor(2)]);
      expect(qualified.find(dependency => dependency.source.kind === 'resource_request')?.alternatives).toEqual([actor(1)]);
      expect(result.graph.get(asPid(3))).toEqual([]);
    }
  });
  it('mixed progress qualification credits a ready sibling and cascades through both edge kinds', () => {
    const fixture = input({
      processes: [process(1, ['R'], 'ready'), process(2, ['M'])],
      threads: [thread(1, mutexReason('M'), 1), thread(1, null, 3), thread(2, semReason('R'))],
      resources: [resource('R')], primitives: [mutex('M', actor(2))], waits: [wait(1, 'M')], requests: [request(2, 'R')],
    });
    const qualified = qualifyResourceDependencies(fixture, collectDependencies(fixture));
    expect(qualified).toEqual([]);
    expect(buildWaitForGraph(qualified, [asPid(1), asPid(2)]).actorCycle).toBeNull();
  });
  it('filters only resource edges with multi-instance candidates', () => {
    const fixture = mutexCycle();
    const result = buildWaitForGraph(collectDependencies(fixture), [asPid(1), asPid(2)], new Set());
    expect(findCycle(result.graph)).toEqual([1, 2]);
  });
});

describe('sync ownership and signalling roles', () => {
  it('mutex ownership is exact even when its owner has a ready sibling', () => {
    const fixture = mutexCycle();
    const result = graph({ ...fixture, threads: [...fixture.threads, thread(2, null, 3)] });
    expect(result.graph.get(asPid(1))).toEqual([2]);
    expect(result.actorCycle).toEqual([actor(1), actor(2)]);
  });
  it('drops reserved waits without consuming the reservation', () => {
    let reads = 0;
    const result = graph({ ...mutexCycle(), reserved: generation => { reads++; return generation === 1; } });
    expect(result.actorCycle).toBeNull();
    expect(reads).toBe(2);
  });
  it('uses monitor lock ownership but gives condition waits no invented owner', () => {
    const fixture = mutexCycle();
    const monitor: SyncSnapshotPrimitive = { id: rid('B'), displayName: 'B', capacity: 1, ordered: true,
      kind: 'monitor', owner: actor(2), signalDiscipline: 'signal_and_continue', entryQueue: [], conditions: [] };
    expect(graph({ ...fixture, primitives: [mutex('A', actor(1)), monitor], waits: [wait(1, 'B', 'monitor_entry'), wait(2, 'A')] }).actorCycle).toEqual([actor(1), actor(2)]);
    const condition: SyncSnapshotWait = { ...wait(1, 'B'), operation: { kind: 'condition', condition: 'ready' } };
    expect(graph({ ...fixture, primitives: [mutex('A', actor(1)), monitor], waits: [condition, wait(2, 'A')] }).actorCycle).toBeNull();
  });
  it('uses only rwlock writer ownership and excludes reader-only and upgrade waits', () => {
    const fixture = mutexCycle();
    const rwlock: SyncSnapshotPrimitive = { id: rid('B'), displayName: 'B', capacity: 1, ordered: true,
      kind: 'rwlock', writer: actor(2), readers: [], waitQueue: [], policy: 'fair' };
    expect(graph({ ...fixture, primitives: [mutex('A', actor(1)), rwlock], waits: [wait(1, 'B', 'rw_read'), wait(2, 'A')] }).actorCycle).toEqual([actor(1), actor(2)]);
    const readers: SyncSnapshotPrimitive = { ...rwlock, writer: null, readers: [actor(2)] };
    expect(graph({ ...fixture, primitives: [mutex('A', actor(1)), readers], waits: [wait(1, 'B', 'rw_write'), wait(2, 'A')] }).actorCycle).toBeNull();
  });
  it('generic semaphore debit attribution never implies exclusive ownership', () => {
    const fixture = mutexCycle();
    expect(collectDependencies({ ...fixture, primitives: [mutex('A', actor(1)), semaphore('B', [actor(2)])], waits: [wait(1, 'B', 'semaphore'), wait(2, 'A')] })).toHaveLength(1);
  });
  it('extracts only the bounded-buffer mutex and philosopher chopsticks as lock roles', () => {
    const philosophers: SyncSnapshotScenario = { kind: 'philosophers', id: 'dining', solution: 'room', rendezvous: rid('barrier'),
      bindings: { kind: 'chopsticks', chopsticks: [rid('c4'), rid('c3'), rid('c2'), rid('c1'), rid('c0')], room: rid('room') }, actors: [] };
    expect(scenarioLockResources([boundedBuffer(), philosophers])).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'lock']);
  });
  it('BB wrong order uses the lock owner and all eligible consumer signalers', () => {
    const fixture = input({ processes: [process(1), process(2), process(3)],
      threads: [thread(1, semReason('empty')), thread(2, semReason('lock')), thread(3, semReason('lock'))],
      primitives: [semaphore('lock', [actor(1)]), semaphore('empty', [actor(1)]), semaphore('full', [])],
      waits: [wait(1, 'empty', 'semaphore'), wait(2, 'lock', 'semaphore'), wait(3, 'lock', 'semaphore')], scenarios: [boundedBuffer([2, 3])] });
    const result = graph(fixture);
    expect(result.closedDependencies.find(dependency => dependency.waiter.pid === 1)?.alternatives).toEqual([actor(2), actor(3)]);
    expect(result.actorCycle).toEqual([actor(1), actor(2)]);
    expect(graph({ ...fixture, threads: [fixture.threads[0]!, fixture.threads[1]!, thread(3, null)] }).actorCycle).toBeNull();
  });
  it('excludes completed scenario participants from eligible signalers', () => {
    const scenario = boundedBuffer([2, 3]);
    if (scenario.kind !== 'bounded_buffer') throw new Error('wrong fixture');
    const fixture = input({ processes: [process(1), process(2), process(3)],
      threads: [thread(1, semReason('empty')), thread(2, semReason('lock')), thread(3, null)],
      primitives: [semaphore('lock', [actor(1)]), semaphore('empty', [null])], waits: [wait(1, 'empty', 'semaphore'), wait(2, 'lock', 'semaphore')],
      scenarios: [{ ...scenario, actors: scenario.actors.map(participant => participant.actor.pid === 3 ? { ...participant, completedItems: participant.targetItems } : participant) }] });
    expect(graph(fixture).actorCycle).toEqual([actor(1), actor(2)]);
  });
});

describe('lifecycle and declared mailbox dependencies', () => {
  it('a named child contributes its actors while wait-any contributes no guessed edge', () => {
    const fixture = input({ processes: [process(1, ['A']), process(7)],
      threads: [thread(1, { kind: 'child_wait', child: asPid(7) }), thread(7, semReason('A'))], resources: [resource('A')], requests: [request(7, 'A')] });
    expect(graph(fixture).graph.get(asPid(1))).toEqual([7]);
    expect(graph(fixture).actorCycle).toEqual([actor(1), actor(7)]);
    expect(graph({ ...fixture, threads: [thread(1, { kind: 'child_wait', child: null }), fixture.threads[1]!] }).actorCycle).toBeNull();
  });
  it('timer and I/O progress do not close a child dependency', () => {
    const fixture = input({ processes: [process(1, ['A']), process(7)],
      threads: [thread(1, { kind: 'child_wait', child: asPid(7) }), thread(7, { kind: 'sleep', untilTick: asTick(20) })] });
    expect(graph(fixture).actorCycle).toBeNull();
    expect(graph(fixture).closedDependencies).toEqual([]);
  });
  it('requires declared peers and actual pending sends for the two-mailbox rendezvous cycle', () => {
    const fixture = input({ processes: [process(1), process(2)],
      threads: [thread(1, semReason('mbox:a:send')), thread(2, semReason('mbox:b:send'))],
      mailboxEndpoints: [{ mailbox: rid('a'), senders: [actor(1)], receivers: [actor(2)] }, { mailbox: rid('b'), senders: [actor(2)], receivers: [actor(1)] }],
      mailbox: id => ({ id, sendWaiters: id === 'a' ? [asPid(1)] : [asPid(2)], recvWaiters: [] }), matchesIpcWait: () => true });
    expect(graph(fixture).actorCycle).toEqual([actor(1), actor(2)]);
    expect(collectDependencies({ ...fixture, mailboxEndpoints: [] })).toEqual([]);
    expect(graph({ ...fixture, hasIpcCompletion: pid => pid === 1 }).actorCycle).toBeNull();
    expect(collectDependencies({ ...fixture, matchesIpcWait: () => false })).toEqual([]);
    expect(collectDependencies({ ...fixture, mailboxEndpoints: fixture.mailboxEndpoints.map(row => ({ ...row, senders: [] })) })).toEqual([]);
  });
});

describe('Coffman confirmation and near chains', () => {
  it('a cycle always has four conditions, including a recoverably preemptible resource', () => {
    expect(coffmanConditions([asPid(1), asPid(2)])).toEqual(['mutual_exclusion', 'hold_and_wait', 'no_preemption', 'circular_wait']);
    expect(coffmanConditions(null)).toEqual([]);
  });
  it('returns the three-condition unclosed exclusive chain without reporting a cycle', () => {
    const fixture = input({ processes: [process(1, ['A']), process(2, ['B'], 'ready')],
      threads: [thread(1, semReason('B')), thread(2, null)], resources: [resource('A', 1, 0, true), resource('B', 1, 0, true)], requests: [request(1, 'B')] });
    expect(nearDeadlocks(fixture)).toEqual([{ chain: [1, 2], resources: ['B'], conditions: ['mutual_exclusion', 'hold_and_wait', 'no_preemption'] }]);
    expect(graph(fixture).actorCycle).toBeNull();
    expect(nearDeadlocks(mutexCycle())).toEqual([]);
  });
  it('reports both branches of an unclosed exclusive chain', () => {
    const fixture = input({ processes: [process(1, ['A']), process(2, ['B'], 'ready'), process(3, ['C'], 'ready')],
      threads: [thread(1, semReason('B')), thread(2, null), thread(3, null)],
      resources: [resource('A'), resource('B'), resource('C')],
      requests: [{ ...request(1, 'B'), resources: [[rid('B'), 1], [rid('C'), 1]] }] });
    expect(nearDeadlocks(fixture).map(warning => warning.chain)).toEqual([[1, 2], [1, 3]]);
  });
  it('a wait without a holding and an undeclared counting-permit wait are not near deadlocks', () => {
    const fixture = input({ processes: [process(1), process(2, ['B'], 'ready')],
      threads: [thread(1, semReason('B')), thread(2, null)], resources: [resource('B')], requests: [request(1, 'B')] });
    expect(nearDeadlocks(fixture)).toEqual([]);
  });
});
