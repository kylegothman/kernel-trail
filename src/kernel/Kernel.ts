/**
 * KERNEL TRAIL - the simulator.
 *
 * Pure, deterministic, headless. Nothing here imports three, touches the DOM,
 * or calls `Math.random`, `Date.now` or `performance.now`; the guard rail is
 * tests/kernel/boundaries.test.ts.
 *
 * WHAT IS REAL IN THIS FILE:
 *   - the constructor, including the RNG stream registry of sim spec 1.2.5
 *   - the tick counter and the fixed eleven-phase `step()` order of sim spec 2.1
 *   - `run`, `snapshot`, `restore`
 *   - the invariant harness of sim spec 15 (phase 11), behind the DEV flag
 *
 * WHAT IS NOT: the bodies of phases 1 to 10, and the subsystem state they
 * mutate. Each is stubbed with a TODO naming its sim spec section. The state
 * containers those phases will fill are declared and initialised here so that
 * `snapshot`, `restore` and the invariants are real, executing code from the
 * first commit rather than something switched on later.
 */

import { KernelEventBus } from './EventBus';
import { createStreamRegistry, type StreamRegistry } from './rng';
import { createScheduler, isMetricsAware, isRunningAware } from './scheduler/SchedulerRegistry';
import type {
  AddressSpaceId,
  AllocationStrategy,
  DeadlockReport,
  Device,
  DiskHead,
  DiskRequest,
  DiskSchedulingId,
  Frame,
  FrameId,
  Inode,
  JournalEntry,
  Kernel,
  KernelConfig,
  KernelEvent,
  KernelSnapshot,
  MemoryMetrics,
  PageId,
  PageReplacementId,
  PageTableEntry,
  Pid,
  ProcessControlBlock,
  ProcessState,
  ProtectionDomain,
  ResourceId,
  ResourceType,
  SafetyCheckResult,
  SchedulerContext,
  SchedulerId,
  SchedulerParams,
  SchedulerPolicy,
  SchedulingMetrics,
  SubsystemId,
  SyncPrimitive,
  SyscallRequest,
  SyscallResult,
  Tick,
} from './types';
import { asFrameId, asTick } from './types';

/* ------------------------------------------------------------------ */
/* Dev flag and the invariant error                                    */
/* ------------------------------------------------------------------ */

/**
 * Phase 11 runs only when this is true. It is a constructor option rather than
 * a global, because reading `import.meta.env` or `process.env` from inside
 * src/kernel would make the simulator depend on its host, and the whole point
 * of a headless kernel is that it does not.
 */
export interface KernelOptions {
  /** Defaults to true. Production bundles pass false; phase 11 then no-ops. */
  readonly devBuild?: boolean;
  /** Sim spec 9: how often deadlock detection runs. Default 20. */
  readonly deadlockDetectionInterval?: number;
  /** Sim spec 15 I-29: how often the expensive block-exclusivity check runs. */
  readonly invariantSlowInterval?: number;
}

export class InvariantViolation extends Error {
  constructor(
    readonly invariant: number,
    message: string,
    readonly tick: number,
  ) {
    super(`I-${invariant} violated at tick ${tick}: ${message}`);
    this.name = 'InvariantViolation';
  }
}

/* ------------------------------------------------------------------ */
/* Legal state transitions, sim spec 3.3                               */
/* ------------------------------------------------------------------ */

/** The edge table of sim spec 3.3. Invariant I-11 admits nothing else. */
const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  'new>ready', // T2
  'ready>running', // T3
  'running>ready', // T4
  'running>waiting', // T5
  'waiting>ready', // T6
  'running>zombie', // T7
  'ready>zombie', // T8
  'waiting>zombie', // T9
  'zombie>terminated', // T10
  'new>terminated', // T11
]);

/* ------------------------------------------------------------------ */
/* Internal state                                                      */
/* ------------------------------------------------------------------ */

const EMPTY_SCHEDULING_METRICS: SchedulingMetrics = {
  averageWaitingTime: 0,
  averageTurnaroundTime: 0,
  averageResponseTime: 0,
  throughput: 0,
  cpuUtilisation: 0,
  contextSwitches: 0,
  worstWait: 0,
};

const EMPTY_MEMORY_METRICS: MemoryMetrics = {
  totalFrames: 0,
  freeFrames: 0,
  pageFaults: 0,
  majorFaults: 0,
  evictions: 0,
  writeBacks: 0,
  faultRate: 0,
  externalFragmentation: 0,
  internalFragmentation: 0,
  workingSets: new Map<Pid, number>(),
  tlbHitRate: 0,
};

/** One TLB entry. Sim spec 6.5. Declared here so invariant I-9 is executable. */
export interface TlbEntry {
  readonly space: AddressSpaceId;
  readonly page: PageId;
  readonly frame: FrameId;
  valid: boolean;
  lastUsedTick: Tick;
}

/** The highest priority number a process may hold. Sim spec 15 I-15. */
export const MAX_PRIORITY = 39;

export class KernelImpl implements Kernel {
  readonly config: Readonly<KernelConfig>;
  readonly events: KernelEventBus;

  private currentTick: Tick = asTick(0);

  /* ---- determinism ---- */
  private readonly rng: StreamRegistry;

  /* ---- processes ---- */
  private readonly pcbs = new Map<Pid, ProcessControlBlock>();
  /** Strictly ascending. Invariant I-1. */
  private orderedPids: Pid[] = [];
  private running: Pid | null = null;
  private sliceElapsed = 0;
  /** Set at admission, adjusted only by the Amdahl recomputation. I-4. */
  private readonly totalServiceAtAdmission = new Map<Pid, number>();
  /** Per-process program counter into its `Program`. Sim spec 2.3. I-8. */
  private readonly programCounters = new Map<Pid, number>();

  /* ---- per-tick bookkeeping, for cross-tick invariants ---- */
  private readonly stateAtTickStart = new Map<Pid, ProcessState>();
  private readonly pcAtTickStart = new Map<Pid, number>();
  private readonly faultedThisTick = new Set<Pid>();
  private readonly admittedThisTick = new Set<Pid>();

  /* ---- scheduling ---- */
  private scheduler: SchedulerPolicy;
  private schedulerParams: SchedulerParams;
  private contextSwitches = 0;
  private busyTicks = 0;

  /* ---- memory ---- */
  private frames: Frame[] = [];
  /** Strictly ascending. Invariant I-20. */
  private freeList: FrameId[] = [];
  private readonly pageTables = new Map<AddressSpaceId, Map<PageId, PageTableEntry>>();
  private tlb: TlbEntry[] = [];
  private replacementPolicyId: PageReplacementId;
  private allocationStrategy: AllocationStrategy;

  /* ---- sync, deadlock ---- */
  private syncPrimitives: SyncPrimitive[] = [];
  private resources: ResourceType[] = [];

  /* ---- storage, io, fs, security ---- */
  private diskQueue: DiskRequest[] = [];
  private diskHead: DiskHead;
  private diskPolicyId: DiskSchedulingId;
  private devices: Device[] = [];
  private inodes: Inode[] = [];
  private journal: JournalEntry[] = [];
  private domains: ProtectionDomain[] = [];

  /* ---- metrics ---- */
  private schedulingMetrics: SchedulingMetrics = EMPTY_SCHEDULING_METRICS;
  private memoryMetrics: MemoryMetrics = EMPTY_MEMORY_METRICS;

  /* ---- options ---- */
  private readonly devBuild: boolean;
  private readonly deadlockDetectionInterval: number;
  private readonly invariantSlowInterval: number;
  private readonly enabled: ReadonlySet<SubsystemId>;

  /* ---- live policy accessors ----
   * These read the mutable policy fields rather than config, because the player
   * swaps policies mid-run and config records only what the leg started with.
   * The HUD, the world and the debrief all need the live value.
   */
  get activeReplacementPolicy(): PageReplacementId {
    return this.replacementPolicyId;
  }

  get activeAllocationStrategy(): AllocationStrategy {
    return this.allocationStrategy;
  }

  get activeDiskPolicy(): DiskSchedulingId {
    return this.diskPolicyId;
  }

  /** Ticks between full invariant sweeps. Read by the dev overlay. */
  get invariantInterval(): number {
    return this.invariantSlowInterval;
  }

  constructor(config: KernelConfig, options?: KernelOptions) {
    this.config = Object.freeze({ ...config });
    this.devBuild = options?.devBuild ?? true;
    this.deadlockDetectionInterval = options?.deadlockDetectionInterval ?? 20;
    this.invariantSlowInterval = options?.invariantSlowInterval ?? 50;
    this.enabled = new Set(config.enabledSubsystems);

    // Sim spec 1.2.5: one root stream seeded from config.seed, then exactly
    // eleven forks in a fixed order, taken whether or not the subsystem is
    // enabled, so that enabling one for a leg cannot shift another's stream.
    this.rng = createStreamRegistry(config.seed);

    this.events = new KernelEventBus();

    this.schedulerParams = { ...config.schedulerParams };
    this.scheduler = createScheduler(config.scheduler, this.schedulerParams);

    this.replacementPolicyId = config.replacementPolicy;
    this.allocationStrategy = config.allocationStrategy;
    this.diskPolicyId = config.diskPolicy;

    this.diskHead = { cylinder: 0, direction: 'up', totalCylinders: config.totalCylinders };

    this.initialiseFrameTable();
  }

  /* ---------------------------------------------------------------- */
  /* Public surface                                                    */
  /* ---------------------------------------------------------------- */

  get tick(): Tick {
    return this.currentTick;
  }

  get processes(): readonly Readonly<ProcessControlBlock>[] {
    const out: ProcessControlBlock[] = [];
    for (const pid of this.orderedPids) {
      const pcb = this.pcbs.get(pid);
      if (pcb !== undefined) out.push(pcb);
    }
    return out;
  }

  process(pid: Pid): Readonly<ProcessControlBlock> | undefined {
    return this.pcbs.get(pid);
  }

  /**
   * Advance exactly one tick. Sim spec 2.1: eleven phases, in this order, every
   * tick, with no early return. A phase with nothing to do is a no-op; a
   * disabled subsystem's phase is skipped whole.
   *
   * The order is not negotiable. Sim spec 2.2 gives the reason for every
   * adjacency, and several of them (interrupts before unblocking, aging before
   * the scheduler decision, execution before deadlock detection) change
   * published fixture numbers if swapped.
   */
  step(): readonly KernelEvent[] {
    this.events.beginFrame();
    this.currentTick = asTick(this.currentTick + 1);

    this.captureTickStartState();

    this.phase01_expireTimers();
    this.phase02_serviceDeviceCompletions();
    this.phase03_deliverInterrupts();
    this.phase04_resolveBlockedProcesses();
    this.phase05_admitNewProcesses();
    this.phase06_ageAndDetectStarvation();
    this.phase07_scheduleDecision();
    this.phase08_executeOneTick();
    this.phase09_detectDeadlock();
    this.phase10_updateMetrics();
    this.phase11_checkInvariants();

    return this.events.lastFrame;
  }

  /** Advance n ticks, returning the concatenated event log. */
  run(ticks: number): readonly KernelEvent[] {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new RangeError(`run: ticks must be a non-negative integer, received ${ticks}`);
    }
    const log: KernelEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      const frame = this.step();
      for (let j = 0; j < frame.length; j++) {
        const event = frame[j];
        if (event !== undefined) log.push(event);
      }
    }
    return log;
  }

  syscall(request: SyscallRequest): SyscallResult {
    // TODO(astra): implement the syscall table per sim spec 14. Dispatch on
    // request.name through a total record, charge the trap cost, emit
    // syscall.invoked with the result, and return the Errno cases of sim spec
    // 14.3 rather than throwing.
    void request;
    return { ok: false, errno: 'EINVAL', message: 'syscall table not implemented' };
  }

  setScheduler(id: SchedulerId, params?: Partial<SchedulerParams>): void {
    this.schedulerParams = { ...this.schedulerParams, ...params };
    this.scheduler = createScheduler(id, this.schedulerParams);
    // Every ready process must be re-offered to the new policy, or the new
    // policy's queues would be empty and invariant I-13 would fail on the very
    // next tick.
    const ctx = this.schedulerContext();
    for (const pid of this.orderedPids) {
      const pcb = this.pcbs.get(pid);
      if (pcb !== undefined && pcb.state === 'ready') {
        this.scheduler.onAdmit(pcb, ctx);
      }
    }
    this.syncSchedulerView();
  }

  setReplacementPolicy(id: PageReplacementId): void {
    // TODO(astra): construct the policy from REPLACEMENT_POLICIES per sim spec
    // 7.4, call reset(this.frames), and refuse 'optimal' with a kernel.panic in
    // dev builds unless every runnable process has a scripted referenceString
    // (sim spec 2.3).
    this.replacementPolicyId = id;
  }

  setDiskPolicy(id: DiskSchedulingId): void {
    // TODO(astra): construct the policy from DISK_POLICIES per sim spec 10.3
    // and recompute the projected head path for the world layer.
    this.diskPolicyId = id;
  }

  setAllocationStrategy(s: AllocationStrategy): void {
    // TODO(astra): switch the contiguous allocator per sim spec 6.2. Existing
    // allocations are not moved; only future placements change.
    this.allocationStrategy = s;
  }

  evaluateBankers(pid: Pid, resource: ResourceId, instances: number): SafetyCheckResult {
    // TODO(astra): implement the safety algorithm of sim spec 9.4. Return the
    // full trace whether or not the request is granted, because the codex shows
    // the player the actual algorithm step by step.
    void pid;
    void resource;
    void instances;
    return { safe: true, sequence: null, trace: [] };
  }

  detectDeadlock(): DeadlockReport | null {
    // TODO(astra): build the wait-for graph and run the cycle detection of sim
    // spec 9.3. The returned cycle must begin at its lowest pid, per invariant
    // I-26.
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Snapshot and restore                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Serialisable, structurally cloneable, and sufficient to resume a run
   * exactly. Sim spec 1.2.6: the eleven RNG streams plus the root, in the fixed
   * registry order. Everything returned is a deep copy, so a later `step()`
   * cannot mutate a snapshot the caller is still holding.
   */
  snapshot(): KernelSnapshot {
    return {
      version: 1,
      tick: this.currentTick,
      seq: this.events.seq,
      config: { ...this.config },
      rng: this.rng.save(),
      processes: this.orderedPids.map((pid) => clonePcb(this.pcbs.get(pid) as ProcessControlBlock)),
      frames: this.frames.map((f) => ({ ...f })),
      pageTables: [...this.pageTables.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([space, table]) => [
          space,
          [...table.values()].sort((a, b) => a.page - b.page).map((e) => ({ ...e })),
        ] as const),
      syncPrimitives: this.syncPrimitives.map((s) => ({
        ...s,
        holders: [...s.holders],
        waitQueue: [...s.waitQueue],
      })),
      resources: this.resources.map((r) => ({ ...r })),
      diskQueue: this.diskQueue.map((r) => ({ ...r })),
      diskHead: { ...this.diskHead },
      devices: this.devices.map((d) => ({ ...d, queue: [...d.queue] })),
      inodes: this.inodes.map((i) => ({ ...i, blocks: [...i.blocks] })),
      journal: this.journal.map((j) => ({ ...j, blocks: [...j.blocks] })),
      domains: this.domains.map((d) => ({ ...d })),
      metrics: {
        scheduling: { ...this.schedulingMetrics },
        memory: { ...this.memoryMetrics, workingSets: new Map(this.memoryMetrics.workingSets) },
      },
    };
  }

  /**
   * Resume from a snapshot. Sim spec 1.2.6: RNG state is replaced in place, not
   * rebuilt, because subsystems hold references to their `Rng`. `seq` is
   * carried, never reset, because invariant I-38 requires it to strictly
   * increase across a restore.
   */
  restore(snapshot: KernelSnapshot): void {
    if (snapshot.version !== 1) {
      throw new Error(`unsupported snapshot version ${String(snapshot.version)}`);
    }

    this.currentTick = snapshot.tick;
    this.events.beginFrame();
    this.events.setSeq(snapshot.seq);
    this.rng.restore(snapshot.rng);

    this.pcbs.clear();
    this.orderedPids = [];
    this.totalServiceAtAdmission.clear();
    this.programCounters.clear();
    for (const pcb of snapshot.processes) {
      const copy = clonePcb(pcb);
      this.pcbs.set(copy.pid, copy);
      this.orderedPids.push(copy.pid);
    }
    this.orderedPids.sort((a, b) => a - b);

    this.running = null;
    for (const pid of this.orderedPids) {
      if (this.pcbs.get(pid)?.state === 'running') {
        this.running = pid;
        break;
      }
    }

    this.frames = snapshot.frames.map((f) => ({ ...f }));
    this.rebuildFreeList();

    this.pageTables.clear();
    for (const [space, entries] of snapshot.pageTables) {
      const table = new Map<PageId, PageTableEntry>();
      for (const entry of entries) table.set(entry.page, { ...entry });
      this.pageTables.set(space, table);
    }
    this.tlb = [];

    this.syncPrimitives = snapshot.syncPrimitives.map((s) => ({
      ...s,
      holders: [...s.holders],
      waitQueue: [...s.waitQueue],
    }));
    this.resources = snapshot.resources.map((r) => ({ ...r }));
    this.diskQueue = snapshot.diskQueue.map((r) => ({ ...r }));
    this.diskHead = { ...snapshot.diskHead };
    this.devices = snapshot.devices.map((d) => ({ ...d, queue: [...d.queue] }));
    this.inodes = snapshot.inodes.map((i) => ({ ...i, blocks: [...i.blocks] }));
    this.journal = snapshot.journal.map((j) => ({ ...j, blocks: [...j.blocks] }));
    this.domains = snapshot.domains.map((d) => ({ ...d }));

    this.schedulingMetrics = { ...snapshot.metrics.scheduling };
    this.memoryMetrics = {
      ...snapshot.metrics.memory,
      workingSets: new Map(snapshot.metrics.memory.workingSets),
    };
    this.contextSwitches = snapshot.metrics.scheduling.contextSwitches;

    // The policy holds its own ordering structure, which is not in the
    // snapshot, so it is rebuilt from the restored PCBs. Sim spec 1.3 calls
    // out policy objects with hidden internal state as exactly the thing
    // determinism test D2 exists to catch: everything a policy needs must be
    // derivable from the snapshot, which for an insertion-ordered queue means
    // ascending pid over the ready set.
    this.scheduler = createScheduler(this.config.scheduler, this.schedulerParams);
    const ctx = this.schedulerContext();
    for (const pid of this.orderedPids) {
      const pcb = this.pcbs.get(pid);
      if (pcb !== undefined && pcb.state === 'ready') {
        this.scheduler.onAdmit(pcb, ctx);
      }
    }
    this.syncSchedulerView();

    this.stateAtTickStart.clear();
    this.pcAtTickStart.clear();
    this.faultedThisTick.clear();
    this.admittedThisTick.clear();
    this.sliceElapsed = 0;
  }

  /* ---------------------------------------------------------------- */
  /* The eleven phases, sim spec 2.1                                   */
  /* ---------------------------------------------------------------- */

  private phase01_expireTimers(): void {
    // TODO(astra): implement phase 1 per sim spec 2.1. Advance every countdown
    // keyed on absolute tick: sleep blocks whose untilTick <= tick, monitor
    // condition timeouts, starvation clocks, RAID rebuild progress, journal
    // checkpoint interval, TLB shootdown counter. Mark expired sleepers
    // wakeable but do NOT move them; phase 4 owns every ready-queue insertion.
  }

  private phase02_serviceDeviceCompletions(): void {
    if (!this.enabled.has('io') && !this.enabled.has('storage')) return;
    // TODO(astra): implement phase 2 per sim spec 2.1 and 11.1. Decrement each
    // busy Device's remaining service; on zero raise an interrupt line for
    // interrupt/dma modes or set a status flag for polling and charge the
    // poller for wasted ticks. Drain disk requests through
    // DiskSchedulingPolicy.select (sim spec 10.3). Emits disk.served,
    // io.dma_transfer.
  }

  private phase03_deliverInterrupts(): void {
    if (!this.enabled.has('io')) return;
    // TODO(astra): implement phase 3 per sim spec 11.2. Sort pending lines by
    // (priority, deviceId), deliver up to maxInterruptsPerTick, charge
    // interruptServiceTicks against the kernel rather than the interrupted
    // process, and fire the storm condition of sim spec 11.3 when the pending
    // queue exceeds interruptStormThreshold for interruptStormWindow ticks.
    // Emits io.interrupt.
  }

  private phase04_resolveBlockedProcesses(): void {
    // TODO(astra): implement phase 4 per sim spec 2.1 and 3.3 T6. Re-test every
    // waiting process against blockedOn in ascending pid order; on satisfaction
    // move waiting -> ready, clear blockedOn, set readySince = tick, and call
    // SchedulerPolicy.onUnblock. Wakes from a SyncPrimitive with ordered: true
    // come from the head of waitQueue only, preserving bounded waiting.
    // Emits process.state_changed, sync.acquired.
  }

  private phase05_admitNewProcesses(): void {
    // TODO(astra): implement phase 5 per sim spec 2.1 and 3.3 T2. Admit
    // processes in state 'new' with arrivalTick <= tick, subject to
    // TravelPolicy.degreeOfMultiprogramming passed down from the game layer.
    // Allocate the address space, set readySince = tick, call
    // SchedulerPolicy.onAdmit, record totalServiceAtAdmission for invariant
    // I-4, and add the pid to admittedThisTick for invariant I-14.
    // Emits process.created, process.state_changed.
  }

  private phase06_ageAndDetectStarvation(): void {
    if (!this.enabled.has('scheduler')) return;
    // TODO(astra): implement phase 6 per sim spec 5.9. For each ready process
    // in ascending pid order compute waited = tick - readySince. Age when
    // agingInterval > 0 and waited % agingInterval === 0 and waited > 0,
    // decrementing priority with a floor of 0. Warn on strict equality with
    // starvationThreshold so it fires once per residence; terminate at
    // starvationFatalThreshold with reason 'starvation' via T8. SABLE's passive
    // multiplies both thresholds by 3 for its own PCB only.
  }

  private phase07_scheduleDecision(): void {
    if (!this.enabled.has('scheduler')) return;
    // TODO(astra): implement phase 7 per sim spec 2.1 and 5.1. Build the
    // SchedulerContext, call SchedulerPolicy.onTick exactly once, and apply the
    // returned SchedulingDecision verbatim: move the outgoing process
    // running -> ready (unless it left the CPU for another reason), move the
    // incoming ready -> running, set lastScheduledTick, reset sliceElapsed,
    // increment contextSwitches, and emit context.switch with the policy's
    // rationale. A context switch costs contextSwitchTicks, charged as idle
    // ticks before phase 8 when nonzero.
  }

  private phase08_executeOneTick(): void {
    // TODO(astra): implement phase 8 per sim spec 2.1 and 2.3. Deliver exactly
    // one unit of CPU service to the running process, dispatching on the head
    // of its instruction stream (compute, access, syscall, io, acquire,
    // release). Increment totalCpuUsed and busyTicks, decrement
    // cpuBurstRemaining and serviceRemaining. A syscall or page fault may move
    // the process out of 'running' here, which is legal and is the only place
    // other than phase 7 where that happens. A page fault must NOT advance the
    // program counter; invariant I-8 checks that.
  }

  private phase09_detectDeadlock(): void {
    if (this.config.deadlockStrategy !== 'detect') return;
    if (this.currentTick % this.deadlockDetectionInterval !== 0) return;
    // TODO(astra): implement phase 9 per sim spec 9.3 and 9.6. Build the
    // wait-for graph, run cycle detection, emit deadlock.detected on a cycle
    // and deadlock.resolved when recovery is enabled. Under 'avoid' no
    // detection runs because Banker's already ran inside the request syscall;
    // under 'prevent' none runs because the ordering rule makes a cycle
    // impossible, and invariant I-24 checks that claim every tick.
  }

  private phase10_updateMetrics(): void {
    // TODO(astra): implement phase 10 per sim spec 5.10 and 7.8. Recompute
    // SchedulingMetrics and MemoryMetrics from scratch off PCB and frame state,
    // never by accumulation, because an accumulated float drifts across a
    // restore (sim spec 1.3). Smooth faultRate and cpuUtilisation with the
    // integer-friendly EWMA of sim spec 7.8, test the thrashing thresholds, and
    // emit memory.thrashing here, after this tick's faults are counted.
    //
    // The two lines below are real and must survive: the scheduler snapshot has
    // to report the live metrics and the live running pid.
    this.schedulingMetrics = {
      ...this.schedulingMetrics,
      contextSwitches: this.contextSwitches,
      cpuUtilisation: this.currentTick === 0 ? 0 : this.busyTicks / this.currentTick,
    };
    this.memoryMetrics = {
      ...this.memoryMetrics,
      totalFrames: this.frames.length,
      freeFrames: this.freeList.length,
    };
    this.syncSchedulerView();
  }

  /* ---------------------------------------------------------------- */
  /* Phase 11: the invariant harness, sim spec 15                      */
  /* ---------------------------------------------------------------- */

  /**
   * Every invariant is checked here, in numbered order, in development and
   * test builds. A failure throws `InvariantViolation` naming the number and
   * the offending state. In a production build `devBuild` is false and this
   * returns immediately.
   */
  private phase11_checkInvariants(): void {
    if (!this.devBuild) return;

    this.i1_pidUniquenessAndOrdering();
    this.i2_exactlyOneRunning();
    this.i3_cpuUtilisationIsAProbability();
    this.i4_serviceAccountingConserved();
    this.i5_resourceConservation();
    this.i6_noSelfOnlyResourceWait();
    this.i7_everyLiveProcessHasAThread();
    this.i8_pageFaultDoesNotAdvanceThePc();
    this.i9_tlbCoherence();
    this.i10_waitQueueMembership();
    this.i11_onlyLegalTransitions();
    this.i12_readySincePairsWithReady();
    this.i13_readyQueueMatchesReadySet();
    this.i14_admittedThisTickHasNotWaited();
    this.i15_prioritiesInRange();
    this.i17_frameConservation();
    this.i19_metricsAreFinite();
    this.i20_freeListOrdering();
    this.i38_eventSequenceIsMonotonic();

    // TODO(astra): add I-16, I-18, I-21 to I-37 as their subsystems land. I-29
    // and I-30 are expensive and run only every invariantSlowInterval ticks;
    // the gate is already available as this.invariantSlowInterval.
  }

  private assert(condition: boolean, invariant: number, message: () => string): void {
    if (!condition) throw new InvariantViolation(invariant, message(), this.currentTick);
  }

  /** I-1. PID uniqueness and ordering. */
  private i1_pidUniquenessAndOrdering(): void {
    const seen = new Set<Pid>();
    for (let i = 0; i < this.orderedPids.length; i++) {
      const pid = this.orderedPids[i];
      if (pid === undefined) continue;
      this.assert(!seen.has(pid), 1, () => `duplicate pid ${pid}`);
      seen.add(pid);
      const prev = i === 0 ? null : this.orderedPids[i - 1];
      this.assert(
        prev === undefined || prev === null || pid > prev,
        1,
        () => `pids not ascending at index ${i}: ${String(prev)} then ${pid}`,
      );
    }
    this.assert(
      seen.size === this.pcbs.size,
      1,
      () => `orderedPids holds ${seen.size} pids but the table holds ${this.pcbs.size}`,
    );
  }

  /** I-2. Exactly one running process, or none. */
  private i2_exactlyOneRunning(): void {
    const running: Pid[] = [];
    for (const pcb of this.pcbs.values()) {
      if (pcb.state === 'running') running.push(pcb.pid);
    }
    this.assert(
      running.length <= 1,
      2,
      () => `${running.length} processes in state running`,
    );
    if (this.running !== null) {
      const pcb = this.pcbs.get(this.running);
      this.assert(
        pcb !== undefined && pcb.state === 'running',
        2,
        () => `k.running=${String(this.running)} but its state is ${String(pcb?.state)}`,
      );
    }
    this.assert(
      running.length === 0 || running[0] === this.running,
      2,
      () => `running pid ${String(running[0])} disagrees with k.running ${String(this.running)}`,
    );
  }

  /** I-3. `cpuUtilisation` is a probability, and busyTicks <= tick. */
  private i3_cpuUtilisationIsAProbability(): void {
    const u = this.schedulingMetrics.cpuUtilisation;
    this.assert(u >= 0 && u <= 1, 3, () => `cpuUtilisation ${u} is not in [0, 1]`);
    this.assert(
      this.busyTicks <= this.currentTick,
      3,
      () => `busyTicks ${this.busyTicks} exceeds tick ${this.currentTick}`,
    );
  }

  /** I-4. Service accounting is conserved. */
  private i4_serviceAccountingConserved(): void {
    for (const pcb of this.pcbs.values()) {
      const total = this.totalServiceAtAdmission.get(pcb.pid);
      if (total === undefined) continue; // not yet admitted
      this.assert(
        pcb.totalCpuUsed + pcb.serviceRemaining === total,
        4,
        () =>
          `P${pcb.pid}: totalCpuUsed ${pcb.totalCpuUsed} + serviceRemaining ` +
          `${pcb.serviceRemaining} != ${total} at admission`,
      );
      if (pcb.terminationReason === 'normal_exit') {
        this.assert(
          pcb.serviceRemaining === 0,
          4,
          () => `P${pcb.pid} exited normally with ${pcb.serviceRemaining} service left`,
        );
      }
    }
  }

  /** I-5. Resource conservation. */
  private i5_resourceConservation(): void {
    for (const rt of this.resources) {
      let held = 0;
      for (const pcb of this.pcbs.values()) {
        for (const r of pcb.heldResources) if (r === rt.id) held += 1;
      }
      this.assert(
        rt.availableInstances + held === rt.totalInstances,
        5,
        () =>
          `${rt.id}: ${rt.availableInstances} available + ${held} held != ` +
          `${rt.totalInstances} total`,
      );
      this.assert(rt.availableInstances >= 0, 5, () => `${rt.id}: negative availability`);
    }
  }

  /** I-6. No process blocks on a resource whose only holder is itself. */
  private i6_noSelfOnlyResourceWait(): void {
    for (const pcb of this.pcbs.values()) {
      for (const r of pcb.requestedResources) {
        if (!pcb.heldResources.includes(r)) continue;
        let othersHold = false;
        for (const other of this.pcbs.values()) {
          if (other.pid === pcb.pid) continue;
          if (other.heldResources.includes(r)) {
            othersHold = true;
            break;
          }
        }
        const rt = this.resources.find((x) => x.id === r);
        const selfOnly = !othersHold && rt !== undefined && rt.availableInstances === 0;
        this.assert(!selfOnly, 6, () => `P${pcb.pid} blocked on ${r} which only it holds`);
      }
    }
  }

  /** I-7. Every live process has at least one thread. */
  private i7_everyLiveProcessHasAThread(): void {
    for (const pcb of this.pcbs.values()) {
      if (pcb.state !== 'ready' && pcb.state !== 'running' && pcb.state !== 'waiting') continue;
      this.assert(
        pcb.threads.length >= 1,
        7,
        () => `P${pcb.pid} is ${pcb.state} with no threads`,
      );
    }
  }

  /** I-8. A page fault does not advance the program counter. */
  private i8_pageFaultDoesNotAdvanceThePc(): void {
    for (const pid of this.faultedThisTick) {
      const before = this.pcAtTickStart.get(pid);
      const after = this.programCounters.get(pid);
      if (before === undefined || after === undefined) continue;
      this.assert(
        before === after,
        8,
        () => `P${pid} faulted but its pc moved ${before} -> ${after}`,
      );
    }
  }

  /** I-9. TLB coherence. */
  private i9_tlbCoherence(): void {
    for (const entry of this.tlb) {
      if (!entry.valid) continue;
      const frame = this.frames[entry.frame];
      this.assert(
        frame !== undefined,
        9,
        () => `tlb entry names frame ${entry.frame} which is out of range`,
      );
      if (frame === undefined) continue;
      this.assert(
        frame.owner === entry.space && frame.page === entry.page,
        9,
        () =>
          `tlb entry (space ${entry.space}, page ${entry.page}) names frame ${entry.frame} ` +
          `owned by ${String(frame.owner)} holding page ${String(frame.page)}`,
      );
    }
  }

  /** I-10. Wait queue membership is consistent with state. */
  private i10_waitQueueMembership(): void {
    for (const primitive of this.syncPrimitives) {
      for (const pid of primitive.waitQueue) {
        const pcb = this.pcbs.get(pid);
        this.assert(
          pcb !== undefined && pcb.state === 'waiting',
          10,
          () => `P${pid} is in ${primitive.id}'s wait queue with state ${String(pcb?.state)}`,
        );
        const reason = pcb?.blockedOn;
        this.assert(
          reason !== null &&
            reason !== undefined &&
            (reason.kind === 'semaphore' || reason.kind === 'mutex'
              ? reason.resource === primitive.id
              : reason.kind === 'condition'
                ? reason.monitor === primitive.id
                : false),
          10,
          () => `P${pid} waits in ${primitive.id} but blockedOn says ${JSON.stringify(reason)}`,
        );
      }
    }
    for (const device of this.devices) {
      for (const pid of device.queue) {
        const pcb = this.pcbs.get(pid);
        this.assert(
          pcb !== undefined && pcb.state === 'waiting',
          10,
          () => `P${pid} is in device ${device.id}'s queue with state ${String(pcb?.state)}`,
        );
        const reason = pcb?.blockedOn;
        this.assert(
          reason !== null && reason !== undefined && reason.kind === 'io' && reason.device === device.id,
          10,
          () => `P${pid} queues on ${device.id} but blockedOn says ${JSON.stringify(reason)}`,
        );
      }
    }
    for (const pcb of this.pcbs.values()) {
      if (pcb.state !== 'waiting') continue;
      this.assert(pcb.blockedOn !== null, 10, () => `P${pcb.pid} is waiting with blockedOn null`);
    }
  }

  /** I-11. Only legal state transitions occurred. Sim spec 3.3. */
  private i11_onlyLegalTransitions(): void {
    for (const pcb of this.pcbs.values()) {
      const before = this.stateAtTickStart.get(pcb.pid);
      if (before === undefined || before === pcb.state) continue;
      const edge = `${before}>${pcb.state}`;
      this.assert(
        LEGAL_TRANSITIONS.has(edge),
        11,
        () => `P${pcb.pid} took the illegal transition ${edge}`,
      );
    }
  }

  /** I-12. `readySince` pairs with state `ready`. */
  private i12_readySincePairsWithReady(): void {
    for (const pcb of this.pcbs.values()) {
      this.assert(
        (pcb.state === 'ready') === (pcb.readySince !== null),
        12,
        () => `P${pcb.pid} state=${pcb.state} readySince=${String(pcb.readySince)}`,
      );
      if (pcb.readySince !== null) {
        this.assert(
          pcb.readySince <= this.currentTick,
          12,
          () => `P${pcb.pid} readySince ${pcb.readySince} is in the future`,
        );
      }
    }
  }

  /** I-13. The ready queue equals the set of ready processes. */
  private i13_readyQueueMatchesReadySet(): void {
    const queued = new Set<Pid>();
    for (const level of this.scheduler.snapshot().queues) {
      for (const pid of level) {
        this.assert(!queued.has(pid), 13, () => `P${pid} appears in two queue levels`);
        queued.add(pid);
      }
    }
    if (this.running !== null) {
      this.assert(
        !queued.has(this.running),
        13,
        () => `running P${String(this.running)} is also queued`,
      );
      queued.add(this.running);
    }

    const expected = new Set<Pid>();
    for (const pcb of this.pcbs.values()) {
      if (pcb.state === 'ready' || pcb.state === 'running') expected.add(pcb.pid);
    }

    this.assert(
      queued.size === expected.size,
      13,
      () => `queues hold ${queued.size} pids, ${expected.size} are ready or running`,
    );
    for (const pid of expected) {
      this.assert(queued.has(pid), 13, () => `P${pid} is ready or running but not queued`);
    }
  }

  /** I-14. A process admitted this tick has `waited === 0`. */
  private i14_admittedThisTickHasNotWaited(): void {
    for (const pid of this.admittedThisTick) {
      const pcb = this.pcbs.get(pid);
      if (pcb === undefined || pcb.readySince === null) continue;
      this.assert(
        this.currentTick - pcb.readySince === 0,
        14,
        () => `P${pid} was admitted this tick but has already waited ${this.currentTick - (pcb.readySince ?? 0)}`,
      );
    }
  }

  /** I-15. Priorities are in range. */
  private i15_prioritiesInRange(): void {
    for (const pcb of this.pcbs.values()) {
      this.assert(
        pcb.priority >= 0 && pcb.priority <= MAX_PRIORITY,
        15,
        () => `P${pcb.pid} priority ${pcb.priority} out of [0, ${MAX_PRIORITY}]`,
      );
      this.assert(
        pcb.basePriority >= 0 && pcb.basePriority <= MAX_PRIORITY,
        15,
        () => `P${pcb.pid} basePriority ${pcb.basePriority} out of [0, ${MAX_PRIORITY}]`,
      );
    }
  }

  /** I-17. Frame conservation. */
  private i17_frameConservation(): void {
    let used = 0;
    for (const frame of this.frames) if (frame.owner !== null) used += 1;
    const free = this.freeList.length;
    this.assert(
      used + free === this.config.totalFrames,
      17,
      () => `${used} used + ${free} free != ${this.config.totalFrames} total`,
    );
    const seen = new Set<FrameId>();
    for (const id of this.freeList) {
      this.assert(!seen.has(id), 17, () => `duplicate frame ${id} in the free list`);
      seen.add(id);
      const frame = this.frames[id];
      this.assert(
        frame !== undefined && frame.owner === null,
        17,
        () => `free list holds owned frame ${id}`,
      );
    }
  }

  /** I-19. Metrics are finite. */
  private i19_metricsAreFinite(): void {
    const scheduling = this.schedulingMetrics;
    const schedulingNumbers: readonly (readonly [string, number])[] = [
      ['averageWaitingTime', scheduling.averageWaitingTime],
      ['averageTurnaroundTime', scheduling.averageTurnaroundTime],
      ['averageResponseTime', scheduling.averageResponseTime],
      ['throughput', scheduling.throughput],
      ['cpuUtilisation', scheduling.cpuUtilisation],
      ['contextSwitches', scheduling.contextSwitches],
      ['worstWait', scheduling.worstWait],
    ];
    for (const [name, value] of schedulingNumbers) {
      this.assert(Number.isFinite(value), 19, () => `scheduling.${name} is ${value}`);
      this.assert(value >= 0, 19, () => `scheduling.${name} is negative: ${value}`);
    }
    this.assert(
      scheduling.cpuUtilisation <= 1,
      19,
      () => `cpuUtilisation ${scheduling.cpuUtilisation} exceeds 1`,
    );

    const memory = this.memoryMetrics;
    const memoryNumbers: readonly (readonly [string, number])[] = [
      ['totalFrames', memory.totalFrames],
      ['freeFrames', memory.freeFrames],
      ['pageFaults', memory.pageFaults],
      ['majorFaults', memory.majorFaults],
      ['evictions', memory.evictions],
      ['writeBacks', memory.writeBacks],
      ['faultRate', memory.faultRate],
      ['externalFragmentation', memory.externalFragmentation],
      ['internalFragmentation', memory.internalFragmentation],
      ['tlbHitRate', memory.tlbHitRate],
    ];
    for (const [name, value] of memoryNumbers) {
      this.assert(Number.isFinite(value), 19, () => `memory.${name} is ${value}`);
      this.assert(value >= 0, 19, () => `memory.${name} is negative: ${value}`);
    }
    this.assert(
      memory.tlbHitRate <= 1,
      19,
      () => `tlbHitRate ${memory.tlbHitRate} exceeds 1`,
    );
  }

  /** I-20. Free list ordering. Strictly ascending makes allocation reproducible. */
  private i20_freeListOrdering(): void {
    for (let i = 1; i < this.freeList.length; i++) {
      const prev = this.freeList[i - 1];
      const cur = this.freeList[i];
      if (prev === undefined || cur === undefined) continue;
      this.assert(
        cur > prev,
        20,
        () => `free list not ascending at index ${i}: ${prev} then ${cur}`,
      );
    }
  }

  /** I-38. The event sequence is monotonic within the frame. */
  private i38_eventSequenceIsMonotonic(): void {
    const frame = this.events.lastFrame;
    for (let i = 1; i < frame.length; i++) {
      const prev = frame[i - 1];
      const cur = frame[i];
      if (prev === undefined || cur === undefined) continue;
      this.assert(cur.seq > prev.seq, 38, () => `seq went ${prev.seq} then ${cur.seq}`);
      this.assert(cur.tick >= prev.tick, 38, () => `tick went ${prev.tick} then ${cur.tick}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /** Frames start owned by nobody and the free list starts fully ascending. */
  private initialiseFrameTable(): void {
    this.frames = [];
    this.freeList = [];
    for (let i = 0; i < this.config.totalFrames; i++) {
      const id = asFrameId(i);
      this.frames.push({
        id,
        owner: null,
        page: null,
        pinned: false,
        loadedAtTick: null,
        lastAccessTick: null,
        referenceBit: false,
      });
      this.freeList.push(id);
    }
  }

  private rebuildFreeList(): void {
    this.freeList = [];
    for (const frame of this.frames) {
      if (frame.owner === null) this.freeList.push(frame.id);
    }
    this.freeList.sort((a, b) => a - b);
  }

  /** Snapshot per-process state so the cross-tick invariants have a baseline. */
  private captureTickStartState(): void {
    this.stateAtTickStart.clear();
    this.pcAtTickStart.clear();
    this.faultedThisTick.clear();
    this.admittedThisTick.clear();
    for (const pcb of this.pcbs.values()) {
      this.stateAtTickStart.set(pcb.pid, pcb.state);
      this.pcAtTickStart.set(pcb.pid, this.programCounters.get(pcb.pid) ?? 0);
    }
  }

  /** Push kernel-owned values into the policy's reusable snapshot. */
  private syncSchedulerView(): void {
    if (isRunningAware(this.scheduler)) this.scheduler.setRunning(this.running);
    if (isMetricsAware(this.scheduler)) this.scheduler.acceptMetrics(this.schedulingMetrics);
  }

  /** The read-only view handed to the scheduling policy in phase 7. */
  private schedulerContext(): SchedulerContext {
    return {
      tick: this.currentTick,
      rng: this.rng.streams.get('scheduler') ?? this.rng.root,
      params: this.schedulerParams,
      running: this.running,
      sliceElapsed: this.sliceElapsed,
      process: (pid: Pid) => this.pcbs.get(pid),
      readyQueue: this.orderedPids.filter((pid) => this.pcbs.get(pid)?.state === 'ready'),
      emit: (event: KernelEvent) => {
        this.events.publish(event, this.currentTick);
      },
    };
  }
}

function clonePcb(pcb: ProcessControlBlock): ProcessControlBlock {
  return {
    ...pcb,
    threads: [...pcb.threads],
    openFiles: [...pcb.openFiles],
    heldResources: [...pcb.heldResources],
    requestedResources: [...pcb.requestedResources],
    blockedOn: pcb.blockedOn === null ? null : { ...pcb.blockedOn },
  };
}

/** The factory the game layer and the tests use. */
export function createKernel(config: KernelConfig, options?: KernelOptions): KernelImpl {
  return new KernelImpl(config, options);
}
