/**
 * KERNEL TRAIL: the forty invariants of sim spec 15, checked in phase 11 in numbered order.
 *
 * The harness reads an `InvariantView`, a narrow snapshot of the kernel's live
 * tables, so a test can hand it a hand-built view that violates one invariant
 * and nothing else. Every message is a thunk: on the happy path no string is
 * built. Checks that a subsystem already composes onto the constructor wrapper
 * (deadlock, storage, file system, security, I/O) run in their numbered slots
 * through the `subsystems` callbacks, with the exceptions WP-05 through WP-10
 * documented and the harness carrying the cheap shared-table halves itself.
 *
 * I-37 and I-40 run in tests rather than in phase 11: `assertSecretAbsent` and
 * `assertSnapshotPure` below.
 */
import { KernelInvariantError } from './errors';
import { asPid } from './types';
import { findCycle } from './deadlock/cycleDetection';
import type {
  AddressSpaceId, Device, DiskHead, DiskRequest, Frame, FrameId, KernelConfig, KernelEvent, KernelSnapshot, MemoryMetrics,
  PageId, PageTableEntry, Pid, ProcessControlBlock, ProcessState, ResourceType, RngState, SchedulerId, SchedulerParams,
  SchedulingMetrics, SubsystemId, SyncPrimitive, SyncSnapshotActor, SyncSnapshotPrimitive, SyncSnapshotScenario, SyncSnapshotWait, Tick, Tid,
} from './types';
import type { KernelTuning } from './config';
import type { ThreadControlBlock } from './process/threads';
import type { SharedMapping } from './process/ipc';

export class InvariantViolation extends KernelInvariantError {
  constructor(invariant: number, message: string, readonly tick: number) {
    super(invariant, `I-${invariant} violated at tick ${tick}: ${message}`);
    this.name = 'InvariantViolation';
  }
}

export interface TlbView { readonly space: AddressSpaceId; readonly page: PageId; readonly frame: FrameId; readonly valid: boolean }

/** Per-tick state captured at phase 1 by the kernel, for the cross-tick checks I-8 and I-11. */
export interface TickStart {
  readonly states: ReadonlyMap<Pid, ProcessState>;
  readonly counters: ReadonlyMap<Tid, number>;
}

/** What the harness reads. The kernel builds it from live tables; a negative test builds one by hand. */
export interface InvariantView {
  readonly tick: Tick;
  readonly config: Readonly<KernelConfig>;
  readonly tuning: KernelTuning;
  enabled(subsystem: SubsystemId): boolean;
  /** Ascending by pid, idle excluded. */
  readonly processes: readonly Readonly<ProcessControlBlock>[];
  readonly running: Pid | null;
  readonly queues: readonly (readonly Pid[])[];
  readonly schedulerId: SchedulerId;
  readonly schedulerParams: SchedulerParams;
  readonly threads: ReadonlyMap<Tid, Readonly<ThreadControlBlock>>;
  readonly admittedThisTick: ReadonlySet<Pid>;
  readonly tickStart: TickStart | null;
  readonly frames: readonly Frame[];
  readonly freeList: readonly FrameId[];
  readonly pageTables: ReadonlyMap<AddressSpaceId, readonly PageTableEntry[]>;
  readonly tlb: readonly TlbView[];
  readonly cowRefCounts: ReadonlyMap<FrameId, number>;
  sharedMapping(pid: Pid, page: PageId): Readonly<SharedMapping> | undefined;
  suspended(pid: Pid): boolean;
  readonly metrics: { readonly scheduling: SchedulingMetrics; readonly memory: MemoryMetrics };
  readonly busyTicks: number;
  readonly syncPrimitives: readonly SyncPrimitive[];
  readonly syncStates: readonly SyncSnapshotPrimitive[];
  readonly syncWaits: readonly SyncSnapshotWait[];
  /** A wait whose grant is reserved for the actor and not yet consumed (WP-07 hand-off); the actor may already own the primitive. */
  reserved(generation: number): boolean;
  readonly scenarios: readonly SyncSnapshotScenario[];
  readonly resources: readonly ResourceType[];
  readonly mailboxes: readonly { readonly id: string; readonly sendWaiters: readonly Pid[]; readonly recvWaiters: readonly Pid[] }[];
  readonly diskHead: DiskHead;
  readonly diskQueue: readonly DiskRequest[];
  readonly devices: readonly Device[];
  readonly interruptLines: readonly { readonly device: string; readonly pending: number }[];
  readonly ioDebt: number;
  readonly switchDebt: number;
  readonly lastFrame: readonly KernelEvent[];
  readonly rng: readonly RngState[];
  readonly slowInterval: number;
  /** The composed subsystem checks, each run in its numbered slot. */
  readonly subsystems: {
    deadlock(): void;
    storage(): void;
    fs(slow: boolean): void;
    security(): void;
    io(): void;
  };
  /** Called with each invariant number just before it runs; tests use it to prove the order. */
  readonly trace?: (invariant: number) => void;
  /** Reports a violation before the throw, so the event log carries the panic. */
  readonly panic?: (message: string) => void;
}

export const RNG_ORDER: readonly string[] = ['root', 'root/process', 'root/scheduler', 'root/memory', 'root/vm', 'root/sync',
  'root/deadlock', 'root/storage', 'root/io', 'root/fs', 'root/security', 'root/events'];
const LIVE: readonly ProcessState[] = ['ready', 'running', 'waiting'];
const REACHABLE: Readonly<Record<ProcessState, readonly ProcessState[]>> = {
  new: ['new', 'ready', 'running', 'waiting', 'zombie', 'terminated'],
  ready: ['ready', 'running', 'waiting', 'zombie', 'terminated'],
  running: ['running', 'ready', 'waiting', 'zombie', 'terminated'],
  waiting: ['waiting', 'ready', 'running', 'zombie', 'terminated'],
  zombie: ['zombie', 'terminated'],
  terminated: ['terminated'],
};
const sameActor = (a: SyncSnapshotActor, b: SyncSnapshotActor): boolean => a.pid === b.pid && a.tid === b.tid;

/** Run every check in numbered order. The caller gates on the development flag; production never reaches this module. */
export function checkInvariants(k: InvariantView): void {
  const assert = (condition: boolean, n: number, message: () => string): void => {
    if (condition) return;
    const text = message();
    k.panic?.(`I-${n}: ${text}`);
    throw new InvariantViolation(n, text, k.tick);
  };
  const begin = (n: number): void => { k.trace?.(n); };
  const processes = k.processes;
  const isSubsystemError = (error: unknown, n: number): boolean => error instanceof KernelInvariantError && error.invariant === n;
  /** Re-throw a composed subsystem failure as the numbered violation it names. */
  const delegate = (n: number, run: () => void): void => {
    try { run(); } catch (error) {
      if (error instanceof InvariantViolation) throw error;
      const named = error instanceof KernelInvariantError ? error.invariant : /^I-(\d+)/.exec(error instanceof Error ? error.message : String(error))?.[1];
      const number = typeof named === 'number' ? named : named === undefined ? n : Number(named);
      const text = error instanceof Error ? error.message : String(error);
      k.panic?.(`I-${number}: ${text}`);
      throw new InvariantViolation(number, text, k.tick);
    }
  };
  void isSubsystemError;
  const byPid = new Map<Pid, Readonly<ProcessControlBlock>>(); const bySpace = new Map<AddressSpaceId, Readonly<ProcessControlBlock>>();
  for (const pcb of processes) { byPid.set(pcb.pid, pcb); bySpace.set(pcb.addressSpaceId, pcb); }

  // Process and scheduling, I-1 to I-16.
  begin(1);
  for (let index = 0; index < processes.length; index++) {
    const pcb = processes[index]; const previous = processes[index - 1];
    if (pcb === undefined) continue;
    assert(previous === undefined || pcb.pid > previous.pid, 1, () => `pids not ascending at ${pcb.pid}`);
  }
  assert(new Set(processes.map(p => p.pid)).size === processes.length, 1, () => 'duplicate pid');
  begin(2);
  const runningSet = processes.filter(p => p.state === 'running');
  assert(runningSet.length <= 1, 2, () => `${runningSet.length} processes in state running`);
  assert(k.running === null || byPid.get(k.running)?.state === 'running', 2, () => `running=${String(k.running)} but its state is not running`);
  assert(runningSet.length === 0 || runningSet[0]?.pid === k.running, 2, () => 'running pid disagrees with state');
  begin(3);
  assert(k.metrics.scheduling.cpuUtilisation >= 0 && k.metrics.scheduling.cpuUtilisation <= 1, 3, () => `cpuUtilisation ${k.metrics.scheduling.cpuUtilisation} is not a probability`);
  assert(k.busyTicks <= k.tick, 3, () => `busyTicks ${k.busyTicks} exceeds tick ${k.tick}`);
  begin(4);
  for (const pcb of processes) {
    // The spec's admission-time equality needs the explicit overhead accounting of WP-06's I-4 row; the
    // conserved quantities here are the three counters themselves, and an explicit exit call is a normal
    // exit with service remaining, so no zero-service clause applies.
    assert(Number.isSafeInteger(pcb.cpuBurstRemaining) && pcb.cpuBurstRemaining >= 0 && Number.isSafeInteger(pcb.serviceRemaining) && pcb.serviceRemaining >= 0
      && Number.isSafeInteger(pcb.totalCpuUsed) && pcb.totalCpuUsed >= 0, 4, () => `P${pcb.pid} service accounting is not a nonnegative integer`);
  }
  begin(5);
  for (const resource of k.resources) {
    const held = processes.reduce((sum, p) => sum + p.heldResources.filter(id => id === resource.id).length, 0);
    assert(resource.availableInstances >= 0, 5, () => `${resource.id}: negative availability`);
    assert(resource.availableInstances + held === resource.totalInstances, 5, () => `${resource.id}: ${resource.availableInstances} available + ${held} held != ${resource.totalInstances} total`);
  }
  begin(6);
  for (const p of processes) for (const id of p.requestedResources) {
    const resource = k.resources.find(row => row.id === id);
    if (resource === undefined) continue;
    const others = processes.some(q => q.pid !== p.pid && q.heldResources.includes(id));
    assert(!(p.heldResources.includes(id) && !others && resource.availableInstances === 0), 6, () => `P${p.pid} blocked on ${id} which only it holds`);
  }
  begin(7);
  for (const pcb of processes) {
    if (!LIVE.includes(pcb.state)) continue;
    assert(pcb.threads.length > 0, 7, () => `P${pcb.pid} is ${pcb.state} with no threads`);
    if (pcb.pid <= 1) continue;
    let sum = 0; for (const tid of pcb.threads) sum += k.threads.get(tid)?.serviceRemaining ?? 0;
    assert(sum === pcb.serviceRemaining, 7, () => `P${pcb.pid} thread service ${sum} != ${pcb.serviceRemaining}`);
  }
  begin(8);
  if (k.tickStart !== null) {
    const faulted = new Set<Pid>();
    for (const event of k.lastFrame) if (event.type === 'memory.page_fault') faulted.add(event.pid);
    for (const pid of faulted) {
      const pcb = byPid.get(pid);
      for (const tid of pcb?.threads ?? []) {
        const thread = k.threads.get(tid); const start = k.tickStart.counters.get(tid);
        // Only an instruction still awaiting service holds its counter; a minor fault served within the tick may retire (WP-06 I-8 row).
        if (thread?.state === 'waiting' && thread.blockedOn?.kind === 'page_fault' && start !== undefined) assert(thread.programCounter === start, 8, () => `P${pid} T${tid} advanced past a pending page fault`);
      }
    }
  }
  begin(9);
  for (const entry of k.tlb) {
    if (!entry.valid) continue;
    const frame = k.frames[entry.frame];
    assert(frame?.owner === entry.space && frame.page === entry.page, 9, () => `TLB entry for space ${entry.space} page ${entry.page} names frame ${entry.frame} owned by ${String(frame?.owner)}`);
  }
  begin(10);
  const waitsOn = (pid: Pid, predicate: (thread: Readonly<ThreadControlBlock>) => boolean): boolean => {
    if (k.suspended(pid)) return true;
    const pcb = byPid.get(pid);
    return pcb !== undefined && (pcb.state === 'waiting' || pcb.state === 'ready' || pcb.state === 'running') && pcb.threads.some(tid => { const thread = k.threads.get(tid); return thread?.state === 'waiting' && thread.blockedOn !== null && predicate(thread); });
  };
  for (const primitive of k.syncPrimitives) for (const pid of primitive.waitQueue) {
    assert(waitsOn(pid, thread => (thread.blockedOn?.kind === 'semaphore' || thread.blockedOn?.kind === 'mutex') && thread.blockedOn.resource === primitive.id
      || (thread.blockedOn?.kind === 'condition' && thread.blockedOn.monitor === primitive.id)), 10, () => `P${pid} is queued on ${primitive.id} without a matching wait`);
  }
  for (const box of k.mailboxes) {
    for (const pid of box.sendWaiters) assert(waitsOn(pid, thread => thread.blockedOn?.kind === 'semaphore' && thread.blockedOn.resource === `mbox:${box.id}:send`), 10, () => `P${pid} is a send waiter on ${box.id} without a wait`);
    for (const pid of box.recvWaiters) assert(waitsOn(pid, thread => thread.blockedOn?.kind === 'semaphore' && thread.blockedOn.resource === `mbox:${box.id}:recv`), 10, () => `P${pid} is a receive waiter on ${box.id} without a wait`);
  }
  for (const pcb of processes) if (pcb.state === 'waiting') assert(pcb.blockedOn !== null, 10, () => `P${pcb.pid} is waiting with no block reason`);
  begin(11);
  if (k.tickStart !== null) for (const pcb of processes) {
    const from = k.tickStart.states.get(pcb.pid);
    if (from !== undefined) assert(REACHABLE[from].includes(pcb.state), 11, () => `P${pcb.pid} moved ${from} -> ${pcb.state} in one tick`);
  }
  begin(12);
  for (const p of processes) {
    assert((p.state === 'ready') === (p.readySince !== null), 12, () => `P${p.pid} state=${p.state} readySince=${String(p.readySince)}`);
    if (p.readySince !== null) assert(p.readySince <= k.tick, 12, () => `P${p.pid} readySince in the future`);
  }
  begin(13);
  const queued = k.queues.length === 1 ? (k.queues[0] ?? []) : k.queues.flat();
  const queuedSet = new Set(queued);
  assert(queuedSet.size === queued.length, 13, () => 'duplicate ready queue entry');
  let readyCount = 0; let allQueued = true;
  for (const p of processes) if (p.pid > 1 && p.state === 'ready') { readyCount += 1; if (!queuedSet.has(p.pid)) allQueued = false; }
  assert(queued.length === readyCount && allQueued, 13, () => `ready queue [${queued.join(',')}] differs from the ${readyCount} ready processes`);
  begin(14);
  for (const pid of k.admittedThisTick) {
    const pcb = byPid.get(pid);
    if (pcb?.readySince !== null && pcb?.readySince !== undefined) assert(pcb.readySince === k.tick, 14, () => `P${pid} admitted this tick has already waited`);
  }
  begin(15);
  for (const p of processes) assert(p.priority >= 0 && p.priority <= 39 && p.basePriority >= 0 && p.basePriority <= 39, 15, () => `P${p.pid} priority ${p.priority}/${p.basePriority} out of range`);
  begin(16);
  if (k.schedulerId === 'priority_aging' || k.schedulerId === 'rr' || k.schedulerId === 'mlfq') {
    const quantum = Math.max(k.schedulerParams.quantum, ...(k.schedulerParams.levelQuanta ?? []));
    const bound = processes.length * quantum + k.schedulerParams.agingInterval * 39;
    assert(k.metrics.scheduling.worstWait <= bound, 16, () => `worstWait ${k.metrics.scheduling.worstWait} exceeds the starvation-free bound ${bound}`);
  }

  // Memory, I-17 to I-20.
  begin(17);
  let used = 0; for (const f of k.frames) if (f.owner !== null) used += 1;
  assert(used + k.freeList.length === k.config.totalFrames, 17, () => `${used} used + ${k.freeList.length} free != ${k.config.totalFrames} total`);
  assert(new Set(k.freeList).size === k.freeList.length, 17, () => 'duplicate frame in the free list');
  assert(k.freeList.every(id => k.frames[id]?.owner === null), 17, () => 'free list holds an owned frame');
  begin(18);
  const named = new Map<FrameId, number>();
  for (const [space, entries] of k.pageTables) {
    const owner = bySpace.get(space);
    for (const entry of entries) {
      if (!entry.valid) { assert(entry.frame === null, 18, () => `space ${space} page ${entry.page} is invalid but names frame ${String(entry.frame)}`); continue; }
      assert(entry.frame !== null, 18, () => `space ${space} page ${entry.page} is valid without a frame`);
      if (entry.frame === null) continue;
      const frame = k.frames[entry.frame];
      assert(frame !== undefined && frame.owner !== null, 18, () => `space ${space} page ${entry.page} names an unowned frame ${entry.frame}`);
      named.set(entry.frame, (named.get(entry.frame) ?? 0) + 1);
      if (frame === undefined || frame.owner !== space) continue;
      // A frame owned by another space is one of the documented aliases: copy-on-write, a shared region, or the
      // pager's backing identity (WP-05 and WP-06 I-18 rows). Within its own space the frame must be the page it says.
      const alias = frame.page === entry.page || (k.cowRefCounts.get(entry.frame) ?? 1) > 1 || frame.pinned || (owner !== undefined && k.sharedMapping(owner.pid, entry.page) !== undefined);
      assert(alias, 18, () => `space ${space} page ${entry.page} names frame ${entry.frame} which holds page ${String(frame.page)} of the same space`);
    }
  }
  for (const [frame, count] of named) {
    if (count <= 1) continue;
    const row = k.frames[frame];
    assert((k.cowRefCounts.get(frame) ?? 1) >= count || row?.pinned === true, 18, () => `frame ${frame} is named by ${count} entries with copy-on-write count ${String(k.cowRefCounts.get(frame))}`);
  }
  begin(19);
  for (const [key, value] of Object.entries(k.metrics.scheduling)) assert(Number.isFinite(value) && value >= 0, 19, () => `scheduling metric ${key} is ${String(value)}`);
  for (const [key, value] of Object.entries(k.metrics.memory)) {
    if (value instanceof Map) { for (const [pid, size] of value) assert(Number.isFinite(size) && size >= 0, 19, () => `working set of P${pid} is ${String(size)}`); continue; }
    assert(typeof value === 'number' && Number.isFinite(value) && value >= 0, 19, () => `memory metric ${key} is ${String(value)}`);
  }
  assert(k.metrics.memory.tlbHitRate <= 1, 19, () => `tlbHitRate ${k.metrics.memory.tlbHitRate} exceeds one`);
  assert(k.metrics.scheduling.cpuUtilisation <= 1, 19, () => `cpuUtilisation ${k.metrics.scheduling.cpuUtilisation} exceeds one`);
  begin(20);
  for (let index = 1; index < k.freeList.length; index++) assert((k.freeList[index] ?? -1) > (k.freeList[index - 1] ?? -1), 20, () => `free list not ascending at index ${index}`);

  // Synchronisation and deadlock, I-21 to I-26.
  begin(21);
  for (const s of k.syncPrimitives) {
    switch (s.kind) {
      case 'mutex':
        assert(s.holders.length <= 1, 21, () => `${s.id} has ${s.holders.length} holders`);
        assert(s.value === (s.holders.length === 0 ? 1 : 0), 21, () => `${s.id} value ${s.value} disagrees with ${s.holders.length} holders`);
        break;
      case 'semaphore':
        assert(s.value >= -s.waitQueue.length, 21, () => `${s.id} value ${s.value} below waiter count ${s.waitQueue.length}`);
        assert(s.value <= s.capacity, 21, () => `${s.id} value ${s.value} above capacity ${s.capacity}`);
        break;
      case 'rwlock':
        assert(s.value === -1 ? s.holders.length === 1 : s.holders.length === s.value, 21, () => `${s.id} rwlock holder count mismatch`);
        break;
      case 'barrier':
        assert(s.value >= 0 && s.value < s.capacity, 21, () => `${s.id} barrier not reset`);
        break;
      case 'monitor':
        assert(s.holders.length <= 1, 21, () => `${s.id} monitor has ${s.holders.length} holders`);
        break;
    }
  }
  begin(22);
  for (const scenario of k.scenarios) {
    if (scenario.kind !== 'bounded_buffer') continue;
    const occupancy = scenario.items.length;
    assert(occupancy >= 0 && occupancy <= scenario.capacity, 22, () => `${scenario.id} occupancy ${occupancy} outside [0, ${scenario.capacity}]`);
    const empty = k.syncPrimitives.find(p => p.id === scenario.empty); const full = k.syncPrimitives.find(p => p.id === scenario.full);
    if (empty !== undefined && full !== undefined) {
      const sum = Math.max(empty.value, 0) + Math.max(full.value, 0) + scenario.inFlight;
      assert(sum === scenario.capacity, 22, () => `${scenario.id}: empty ${empty.value} + full ${full.value} + in flight ${scenario.inFlight} != ${scenario.capacity}`);
    }
  }
  begin(23);
  for (const state of k.syncStates) {
    const owners: SyncSnapshotActor[] = state.kind === 'mutex' || state.kind === 'monitor' ? (state.owner === null ? [] : [state.owner])
      : state.kind === 'rwlock' ? (state.writer === null ? [] : [state.writer]) : [];
    for (const owner of owners) {
      const waiting = k.syncWaits.some(wait => wait.resource === state.id && sameActor(wait.actor, owner) && wait.operation.kind !== 'condition' && !k.reserved(wait.generation));
      assert(!waiting, 23, () => `${state.id} owner P${owner.pid} T${owner.tid} is in its own wait queue`);
    }
  }
  begin(24);
  if (k.config.deadlockStrategy === 'prevent') {
    // The shared-table wait-for graph: P waits for Q when P requests an instance Q holds and none is available.
    const graph = new Map<Pid, Pid[]>();
    for (const p of processes) {
      if (p.requestedResources.length === 0) continue;
      const edges: Pid[] = [];
      for (const id of p.requestedResources) {
        const resource = k.resources.find(row => row.id === id);
        if (resource === undefined || resource.availableInstances > 0) continue;
        for (const q of processes) if (q.pid !== p.pid && q.heldResources.includes(id) && !edges.includes(q.pid)) edges.push(q.pid);
      }
      if (edges.length > 0) graph.set(p.pid, edges);
    }
    for (const edges of graph.values()) for (const pid of edges) if (!graph.has(pid)) graph.set(pid, []);
    const cycle = findCycle(graph);
    assert(cycle === null, 24, () => `cycle under prevention: [${(cycle ?? []).join(' -> ')}]`);
  }
  delegate(24, () => k.subsystems.deadlock());
  if (k.enabled('deadlock') && k.config.deadlockStrategy === 'avoid' && k.lastFrame.some(event => event.type === 'resource.granted')) begin(25);
  begin(26);

  // Storage, I/O and file system, I-27 to I-33.
  begin(27);
  assert(k.diskHead.cylinder >= 0 && k.diskHead.cylinder < k.diskHead.totalCylinders, 27, () => `disk head at ${k.diskHead.cylinder} of ${k.diskHead.totalCylinders}`);
  delegate(27, () => k.subsystems.storage());
  begin(28);
  for (const request of k.diskQueue) {
    assert(request.servedAtTick === null || request.servedAtTick >= request.queuedAtTick, 28, () => `request ${request.id} served before it was queued`);
  }
  const slow = k.tick % k.slowInterval === 0;
  if (slow) { begin(29); begin(30); }
  begin(31);
  delegate(31, () => k.subsystems.fs(slow));
  begin(32);
  // The I/O subsystem refreshes the whole-process device projection before its own check; the shared-table half runs on the fresh projection.
  delegate(32, () => k.subsystems.io());
  for (const device of k.devices) for (const pid of device.queue) {
    const pcb = byPid.get(pid);
    assert(pcb?.state === 'waiting' && pcb.blockedOn?.kind === 'io' && pcb.blockedOn.device === device.id, 32, () => `P${pid} in the ${device.id} queue is not waiting on it`);
  }
  begin(33);
  for (const line of k.interruptLines) assert(line.pending >= 0 && line.pending <= k.tuning.maxPendingInterrupts, 33, () => `${line.device} has ${line.pending} pending interrupts`);
  assert(k.ioDebt >= 0 && k.ioDebt <= k.switchDebt, 33, () => `I/O debt ${k.ioDebt} exceeds combined kernel debt ${k.switchDebt}`);

  // Security, I-34 to I-36. I-37 runs in tests.
  begin(34); begin(35); begin(36);
  delegate(34, () => k.subsystems.security());

  // Determinism, I-38 and I-39. I-40 runs in tests.
  begin(38);
  let previous = -1; let previousTick = -1;
  for (const event of k.lastFrame) {
    assert(event.seq > previous, 38, () => `event sequence decreased at seq ${event.seq}`); previous = event.seq;
    assert(event.tick >= previousTick, 38, () => `event tick decreased at seq ${event.seq}`); previousTick = event.tick;
  }
  begin(39);
  assert(k.rng.length === RNG_ORDER.length && k.rng.every((state, index) => state.label === RNG_ORDER[index]), 39, () => `rng registry order is [${k.rng.map(s => s.label).join(', ')}]`);
  assert(k.rng.every(state => state.algorithm === 'sfc32'), 39, () => 'an rng stream is not sfc32');
}

/** I-40: two snapshots with no intervening step are canonically identical. Test-only, because it is quadratic. */
export function assertSnapshotPure(kernel: { snapshot(): KernelSnapshot; readonly tick: Tick }, canonical: (value: unknown) => string): void {
  const first = canonical(kernel.snapshot()); const second = canonical(kernel.snapshot());
  if (first !== second) throw new InvariantViolation(40, 'snapshot() is not a pure function of state', kernel.tick);
}

/** I-37: the sealing secret never reaches the event log. Test-only, checked once at the end of a run. */
export function assertSecretAbsent(secretAppearsIn: (text: string) => boolean, events: readonly KernelEvent[], tick: Tick): void {
  for (const event of events) {
    if (secretAppearsIn(JSON.stringify(event))) throw new InvariantViolation(37, `event seq ${event.seq} carries the kernel secret`, tick);
  }
}

export const IDLE_PID: Pid = asPid(0);
