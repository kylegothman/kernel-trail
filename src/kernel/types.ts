/**
 * KERNEL TRAIL - core simulation contracts.
 *
 * This file is the single source of truth for the simulation layer. Every other
 * module in the project depends on these types and none of them may redefine a
 * concept declared here.
 *
 * INVARIANTS (enforced by tests/kernel/determinism.test.ts):
 *  1. Nothing under src/kernel imports from three, the DOM, or any render module.
 *  2. Nothing under src/kernel calls Math.random, Date.now, or performance.now.
 *     All nondeterminism flows through the injected Rng.
 *  3. A Kernel constructed from the same KernelConfig and stepped the same number
 *     of ticks produces a byte-identical event log and snapshot every time.
 */

/* ------------------------------------------------------------------ */
/* Branded primitives                                                  */
/* ------------------------------------------------------------------ */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Discrete simulation time. Monotonic, integer, starts at 0. Never wall-clock. */
export type Tick = Brand<number, 'Tick'>;
export type Pid = Brand<number, 'Pid'>;
export type Tid = Brand<number, 'Tid'>;
/** Index of a physical frame in the frame table. */
export type FrameId = Brand<number, 'FrameId'>;
/** Virtual page number within an address space. */
export type PageId = Brand<number, 'PageId'>;
export type AddressSpaceId = Brand<number, 'AddressSpaceId'>;
export type ResourceId = Brand<string, 'ResourceId'>;
export type FileDescriptor = Brand<number, 'FileDescriptor'>;
export type InodeId = Brand<number, 'InodeId'>;
export type BlockId = Brand<number, 'BlockId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
export type DomainId = Brand<string, 'DomainId'>;

export const asTick = (n: number): Tick => n as Tick;
export const asPid = (n: number): Pid => n as Pid;
export const asFrameId = (n: number): FrameId => n as FrameId;
export const asPageId = (n: number): PageId => n as PageId;
export const asResourceId = (s: string): ResourceId => s as ResourceId;

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

/**
 * Seeded PRNG. The ONLY source of randomness permitted inside src/kernel.
 * Implementations must be pure functions of their internal state so that a run
 * can be replayed exactly from its seed.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** Uniformly select one element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher-Yates. Returns the same array for chaining. */
  shuffle<T>(items: T[]): T[];
  /** Fork an independent stream, so adding a subsystem cannot shift others. */
  fork(label: string): Rng;
  /** Opaque serialisable state, for save files and replay. */
  save(): RngState;
  restore(state: RngState): void;
}

export interface RngState {
  readonly algorithm: 'sfc32';
  readonly words: readonly [number, number, number, number];
  readonly label: string;
}

/* ------------------------------------------------------------------ */
/* Processes                                                           */
/* ------------------------------------------------------------------ */

export type ProcessState =
  | 'new'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'terminated'
  /** Exited but not yet reaped by its parent. Ch. 3.3.2. */
  | 'zombie';

export type TerminationReason =
  | 'normal_exit'
  | 'killed_by_user'
  | 'killed_by_parent'
  | 'starvation'
  | 'deadlock_victim'
  | 'out_of_memory'
  | 'thrashing_collapse'
  | 'protection_fault'
  | 'io_timeout'
  | 'storage_corruption';

export interface ProcessControlBlock {
  readonly pid: Pid;
  readonly parent: Pid | null;
  /** Display name. Convoy members use their Program name. */
  readonly name: string;
  state: ProcessState;
  /** Lower number is higher priority, matching Silberschatz Ch. 5.3.3 and 5.3.4. */
  priority: number;
  readonly basePriority: number;
  readonly arrivalTick: Tick;
  /** Ticks of CPU still required by the current burst. */
  cpuBurstRemaining: number;
  /** Full remaining service time across all bursts, for SJF/SRTF and metrics. */
  serviceRemaining: number;
  totalCpuUsed: number;
  /** Tick this process last entered the ready queue. Drives starvation detection. */
  readySince: Tick | null;
  lastScheduledTick: Tick | null;
  /** MLFQ level, or 0 for single-queue policies. */
  queueLevel: number;
  readonly addressSpaceId: AddressSpaceId;
  readonly threads: Tid[];
  openFiles: FileDescriptor[];
  heldResources: ResourceId[];
  /** Outstanding requests. Feeds the wait-for graph in Ch. 8. */
  requestedResources: ResourceId[];
  blockedOn: BlockReason | null;
  domain: DomainId;
  exitCode: number | null;
  terminationReason: TerminationReason | null;
  /** Set when this process IS a named convoy Program, so its death is narrative. */
  convoyMemberId: ConvoyMemberId | null;
}

export type BlockReason =
  | { kind: 'semaphore'; resource: ResourceId }
  | { kind: 'mutex'; resource: ResourceId }
  | { kind: 'condition'; monitor: ResourceId; condition: string }
  | { kind: 'io'; device: DeviceId }
  | { kind: 'page_fault'; page: PageId }
  | { kind: 'child_wait'; child: Pid | null }
  | { kind: 'sleep'; untilTick: Tick };

/* ------------------------------------------------------------------ */
/* Scheduling - Ch. 5                                                  */
/* ------------------------------------------------------------------ */

export type SchedulerId =
  | 'fcfs'
  | 'sjf'
  | 'srtf'
  | 'priority'
  | 'priority_aging'
  | 'rr'
  | 'mlfq';

export interface SchedulerParams {
  /** Round-robin / MLFQ time quantum, in ticks. */
  quantum: number;
  /** MLFQ only. Quantum per level, index 0 = highest priority. */
  levelQuanta?: readonly number[];
  /** Ticks after which a starved process gains a priority level. 0 disables aging. */
  agingInterval: number;
  /** Ticks in the ready queue before a starvation warning fires. */
  starvationThreshold: number;
  /** Ticks in the ready queue before the process is derezzed. */
  starvationFatalThreshold: number;
  preemptive: boolean;
}

export interface SchedulingDecision {
  /** Process to run this tick, or null to idle the CPU. */
  readonly next: Pid | null;
  /** True when this differs from the previously running process. */
  readonly isContextSwitch: boolean;
  /** Why, in words the codex can show the player. */
  readonly rationale: string;
}

/**
 * Pluggable CPU scheduling policy. One implementation per algorithm in
 * src/kernel/scheduler. Each must be independently unit-testable against a
 * fixture of arrival times and burst lengths with a known-correct Gantt chart.
 */
export interface SchedulerPolicy {
  readonly id: SchedulerId;
  readonly displayName: string;
  readonly isPreemptive: boolean;
  configure(params: SchedulerParams): void;
  onAdmit(pcb: ProcessControlBlock, ctx: SchedulerContext): void;
  onTick(ctx: SchedulerContext): SchedulingDecision;
  onBlock(pcb: ProcessControlBlock, ctx: SchedulerContext): void;
  onUnblock(pcb: ProcessControlBlock, ctx: SchedulerContext): void;
  onExit(pcb: ProcessControlBlock, ctx: SchedulerContext): void;
  /** Read-only view for the 3D world and the HUD. Must not allocate per tick. */
  snapshot(): SchedulerSnapshot;
}

export interface SchedulerContext {
  readonly tick: Tick;
  readonly rng: Rng;
  readonly params: Readonly<SchedulerParams>;
  readonly running: Pid | null;
  /** Ticks the running process has held the CPU in its current slice. */
  readonly sliceElapsed: number;
  process(pid: Pid): ProcessControlBlock | undefined;
  readonly readyQueue: readonly Pid[];
  emit(event: KernelEvent): void;
}

export interface SchedulerSnapshot {
  readonly policy: SchedulerId;
  readonly running: Pid | null;
  /** Outer index is the queue level. Single-level policies use one entry. */
  readonly queues: readonly (readonly Pid[])[];
  readonly quantumRemaining: number;
  readonly metrics: SchedulingMetrics;
}

export interface SchedulingMetrics {
  readonly averageWaitingTime: number;
  readonly averageTurnaroundTime: number;
  readonly averageResponseTime: number;
  readonly throughput: number;
  readonly cpuUtilisation: number;
  readonly contextSwitches: number;
  /** Ready time of the longest-waiting process. Feeds the starvation warning. */
  readonly worstWait: number;
}

/* ------------------------------------------------------------------ */
/* Memory - Ch. 9 and 10                                               */
/* ------------------------------------------------------------------ */

export type AllocationStrategy = 'first_fit' | 'best_fit' | 'worst_fit' | 'buddy';

export type PageReplacementId = 'fifo' | 'lru' | 'clock' | 'optimal' | 'lfu' | 'random';

export interface PageTableEntry {
  readonly page: PageId;
  frame: FrameId | null;
  valid: boolean;
  dirty: boolean;
  referenced: boolean;
  /** Protection bits. Ch. 9.3.3. */
  readable: boolean;
  writable: boolean;
  executable: boolean;
  /** True when the page lives in the backing store rather than memory. */
  swapped: boolean;
  lastAccessTick: Tick | null;
  accessCount: number;
}

export interface Frame {
  readonly id: FrameId;
  owner: AddressSpaceId | null;
  page: PageId | null;
  pinned: boolean;
  loadedAtTick: Tick | null;
  lastAccessTick: Tick | null;
  /** Second-chance bit for the clock algorithm. */
  referenceBit: boolean;
}

/**
 * Pluggable page replacement policy. Ch. 10.4. `optimal` requires a reference
 * string lookahead, which the sim provides only in scripted teaching scenarios;
 * it exists so the player can compare their policy against the theoretical floor
 * and so Belady's anomaly can be demonstrated on demand.
 */
export interface PageReplacementPolicy {
  readonly id: PageReplacementId;
  readonly displayName: string;
  reset(frames: readonly Frame[]): void;
  onAccess(space: AddressSpaceId, page: PageId, frame: FrameId, ctx: MemoryContext): void;
  onLoad(space: AddressSpaceId, page: PageId, frame: FrameId, ctx: MemoryContext): void;
  selectVictim(ctx: MemoryContext): FrameId;
  snapshot(): PageReplacementSnapshot;
}

export interface MemoryContext {
  readonly tick: Tick;
  readonly rng: Rng;
  readonly frames: readonly Frame[];
  /** Only populated in scenarios that permit the optimal policy. */
  readonly futureReferences: readonly PageId[] | null;
  pageTable(space: AddressSpaceId): ReadonlyMap<PageId, PageTableEntry>;
  emit(event: KernelEvent): void;
}

export interface PageReplacementSnapshot {
  readonly policy: PageReplacementId;
  /** Policy-specific ordering, for the world to draw the victim queue. */
  readonly order: readonly FrameId[];
  /** Clock hand position, for the clock policy only. */
  readonly handIndex: number | null;
}

export interface MemoryMetrics {
  readonly totalFrames: number;
  readonly freeFrames: number;
  readonly pageFaults: number;
  readonly majorFaults: number;
  readonly evictions: number;
  readonly writeBacks: number;
  /** Faults per thousand ticks, smoothed. Above thrashingThreshold you thrash. */
  readonly faultRate: number;
  readonly externalFragmentation: number;
  readonly internalFragmentation: number;
  /** Working set size per process. Ch. 10.6.2. */
  readonly workingSets: ReadonlyMap<Pid, number>;
  readonly tlbHitRate: number;
}

/* ------------------------------------------------------------------ */
/* Synchronisation - Ch. 6 and 7                                       */
/* ------------------------------------------------------------------ */

export type SyncPrimitiveKind = 'mutex' | 'semaphore' | 'monitor' | 'rwlock' | 'barrier';

export interface SyncPrimitive {
  readonly id: ResourceId;
  readonly kind: SyncPrimitiveKind;
  readonly displayName: string;
  /** Semaphore count, mutex 0/1, rwlock reader count. */
  value: number;
  readonly capacity: number;
  holders: Pid[];
  waitQueue: Pid[];
  /** FIFO wait queues are bounded-wait; unordered ones are not. Ch. 6.2. */
  readonly ordered: boolean;
}

/** A detected data race, used to teach why unsynchronised access is unsafe. */
export interface RaceCondition {
  readonly tick: Tick;
  readonly participants: readonly Pid[];
  readonly location: string;
  readonly interleaving: readonly string[];
  readonly corruptedValue: number;
  readonly expectedValue: number;
}

/* ------------------------------------------------------------------ */
/* Deadlock - Ch. 8                                                    */
/* ------------------------------------------------------------------ */

export interface ResourceType {
  readonly id: ResourceId;
  readonly displayName: string;
  readonly totalInstances: number;
  availableInstances: number;
  /** True when the resource can be taken back without corrupting the holder. */
  readonly preemptible: boolean;
}

/** Ch. 8.6.3. Rows are processes, columns are resource types. */
export interface BankersState {
  readonly processes: readonly Pid[];
  readonly resources: readonly ResourceId[];
  readonly available: readonly number[];
  readonly max: readonly (readonly number[])[];
  readonly allocation: readonly (readonly number[])[];
  readonly need: readonly (readonly number[])[];
}

export interface SafetyCheckResult {
  readonly safe: boolean;
  /** The safe sequence when one exists. Ch. 8.6.1. */
  readonly sequence: readonly Pid[] | null;
  /** Step-by-step trace so the codex can show the player the actual algorithm. */
  readonly trace: readonly SafetyTraceStep[];
}

export interface SafetyTraceStep {
  readonly work: readonly number[];
  readonly candidate: Pid | null;
  readonly admitted: boolean;
  readonly explanation: string;
}

export interface DeadlockReport {
  readonly tick: Tick;
  /** The cycle in the wait-for graph. Ch. 8.7.1. */
  readonly cycle: readonly Pid[];
  readonly resources: readonly ResourceId[];
  /** Which of the four Coffman conditions each edge demonstrates. */
  readonly conditions: readonly CoffmanCondition[];
  readonly suggestedVictims: readonly Pid[];
}

export type CoffmanCondition =
  | 'mutual_exclusion'
  | 'hold_and_wait'
  | 'no_preemption'
  | 'circular_wait';

/* ------------------------------------------------------------------ */
/* Storage - Ch. 11                                                    */
/* ------------------------------------------------------------------ */

export type DiskSchedulingId = 'fcfs' | 'sstf' | 'scan' | 'cscan' | 'look' | 'clook';

export interface DiskRequest {
  readonly id: number;
  readonly pid: Pid;
  readonly cylinder: number;
  readonly write: boolean;
  readonly queuedAtTick: Tick;
  servedAtTick: Tick | null;
}

export interface DiskSchedulingPolicy {
  readonly id: DiskSchedulingId;
  readonly displayName: string;
  /** Returns the index into `queue` to serve next. */
  select(queue: readonly DiskRequest[], head: DiskHead): number;
  snapshot(): { readonly policy: DiskSchedulingId; readonly projectedPath: readonly number[] };
}

export interface DiskHead {
  cylinder: number;
  /** SCAN family only. */
  direction: 'up' | 'down';
  readonly totalCylinders: number;
}

export type RaidLevel = 0 | 1 | 4 | 5 | 6 | 10;

/* ------------------------------------------------------------------ */
/* I/O - Ch. 12                                                        */
/* ------------------------------------------------------------------ */

export type IoMode = 'polling' | 'interrupt' | 'dma';

export interface Device {
  readonly id: DeviceId;
  readonly displayName: string;
  readonly kind: 'block' | 'character' | 'network';
  readonly mode: IoMode;
  /** Ticks to service one request once started. */
  readonly latency: number;
  busy: boolean;
  queue: Pid[];
}

/* ------------------------------------------------------------------ */
/* File system - Ch. 13 to 15                                          */
/* ------------------------------------------------------------------ */

export type FileAllocationMethod = 'contiguous' | 'linked' | 'indexed' | 'extent';

export interface Inode {
  readonly id: InodeId;
  name: string;
  kind: 'file' | 'directory' | 'link';
  sizeBytes: number;
  readonly method: FileAllocationMethod;
  blocks: BlockId[];
  /** Indexed allocation only. */
  indexBlock: BlockId | null;
  owner: DomainId;
  permissions: PermissionBits;
  createdTick: Tick;
  modifiedTick: Tick;
  linkCount: number;
}

export interface PermissionBits {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
}

export interface JournalEntry {
  readonly tick: Tick;
  readonly txId: number;
  readonly phase: 'begin' | 'write' | 'commit' | 'checkpoint';
  readonly blocks: readonly BlockId[];
}

/* ------------------------------------------------------------------ */
/* Protection and security - Ch. 16 and 17                             */
/* ------------------------------------------------------------------ */

/** Ch. 17.3. Ring 0 is the kernel. */
export type ProtectionRing = 0 | 1 | 2 | 3;

export interface ProtectionDomain {
  readonly id: DomainId;
  readonly displayName: string;
  readonly ring: ProtectionRing;
  /** Ch. 17.5. Keyed by object id. */
  readonly rights: ReadonlyMap<string, readonly AccessRight[]>;
}

export type AccessRight = 'read' | 'write' | 'execute' | 'owner' | 'copy' | 'control';

/* ------------------------------------------------------------------ */
/* System calls - Ch. 2.3                                              */
/* ------------------------------------------------------------------ */

export type SyscallName =
  | 'fork' | 'exec' | 'exit' | 'wait' | 'kill' | 'getpid' | 'nice'
  | 'mmap' | 'munmap' | 'brk'
  | 'open' | 'close' | 'read' | 'write' | 'seek' | 'stat' | 'unlink' | 'mkdir'
  | 'sem_wait' | 'sem_post' | 'mutex_lock' | 'mutex_unlock'
  | 'request' | 'release'
  | 'ioctl' | 'sync' | 'chmod';

export interface SyscallRequest {
  readonly name: SyscallName;
  readonly pid: Pid;
  readonly args: readonly (string | number | boolean)[];
}

export type SyscallResult =
  | { readonly ok: true; readonly value: string | number | boolean | null }
  | { readonly ok: false; readonly errno: Errno; readonly message: string };

export type Errno =
  | 'EPERM' | 'ENOENT' | 'EAGAIN' | 'ENOMEM' | 'EACCES' | 'EBUSY'
  | 'EEXIST' | 'EINVAL' | 'ENOSPC' | 'EDEADLK' | 'ESRCH';

/* ------------------------------------------------------------------ */
/* Event bus - the contract between sim and everything visual          */
/* ------------------------------------------------------------------ */

interface EventBase {
  readonly tick: Tick;
  /** Monotonic across the whole run. Used to order and to dedupe on replay. */
  readonly seq: number;
}

/**
 * Every observable thing the kernel does. The 3D world, the HUD, the audio
 * engine and the codex all subscribe to this stream and NOTHING else. Adding a
 * visual feature must never require reaching into kernel internals.
 *
 * This union is exhaustively switched in src/world/WorldEventRouter.ts, so a new
 * variant produces a compile error until it is given a visual treatment. That is
 * deliberate.
 */
export type KernelEvent =
  | (EventBase & { type: 'process.created'; pid: Pid; parent: Pid | null; name: string })
  | (EventBase & { type: 'process.state_changed'; pid: Pid; from: ProcessState; to: ProcessState })
  | (EventBase & { type: 'process.exited'; pid: Pid; exitCode: number; reason: TerminationReason })
  | (EventBase & { type: 'process.reaped'; pid: Pid; by: Pid })
  | (EventBase & { type: 'process.starving'; pid: Pid; waitedTicks: number; fatal: boolean })
  | (EventBase & { type: 'context.switch'; from: Pid | null; to: Pid | null; rationale: string })
  | (EventBase & { type: 'quantum.expired'; pid: Pid; level: number })
  | (EventBase & { type: 'thread.created'; pid: Pid; tid: Tid })
  | (EventBase & { type: 'thread.joined'; pid: Pid; tid: Tid })
  | (EventBase & { type: 'memory.access'; pid: Pid; page: PageId; write: boolean; hit: boolean })
  | (EventBase & { type: 'memory.page_fault'; pid: Pid; page: PageId; major: boolean })
  | (EventBase & { type: 'memory.page_loaded'; pid: Pid; page: PageId; frame: FrameId })
  | (EventBase & { type: 'memory.page_evicted'; frame: FrameId; page: PageId; dirty: boolean; policy: PageReplacementId })
  | (EventBase & { type: 'memory.allocated'; pid: Pid; frames: readonly FrameId[]; strategy: AllocationStrategy })
  | (EventBase & { type: 'memory.allocation_failed'; pid: Pid; requested: number; reason: 'no_space' | 'fragmentation' })
  | (EventBase & { type: 'memory.thrashing'; faultRate: number; severity: 'warning' | 'critical' })
  | (EventBase & { type: 'tlb.miss'; pid: Pid; page: PageId })
  | (EventBase & { type: 'sync.acquired'; pid: Pid; resource: ResourceId; kind: SyncPrimitiveKind })
  | (EventBase & { type: 'sync.blocked'; pid: Pid; resource: ResourceId; queueLength: number })
  | (EventBase & { type: 'sync.released'; pid: Pid; resource: ResourceId; woke: Pid | null })
  | (EventBase & { type: 'sync.race_detected'; race: RaceCondition })
  | (EventBase & { type: 'sync.busy_wait'; pid: Pid; resource: ResourceId; spunTicks: number })
  | (EventBase & { type: 'resource.requested'; pid: Pid; resource: ResourceId; instances: number })
  | (EventBase & { type: 'resource.granted'; pid: Pid; resource: ResourceId; instances: number })
  | (EventBase & { type: 'resource.denied'; pid: Pid; resource: ResourceId; reason: 'unsafe' | 'unavailable' })
  | (EventBase & { type: 'bankers.evaluated'; result: SafetyCheckResult; forRequest: { pid: Pid; resource: ResourceId } })
  | (EventBase & { type: 'deadlock.detected'; report: DeadlockReport })
  | (EventBase & { type: 'deadlock.resolved'; victims: readonly Pid[]; method: 'preempt' | 'terminate' | 'rollback' })
  | (EventBase & { type: 'disk.queued'; request: DiskRequest })
  | (EventBase & { type: 'disk.seek'; from: number; to: number; distance: number })
  | (EventBase & { type: 'disk.served'; request: DiskRequest; waitTicks: number })
  | (EventBase & { type: 'raid.rebuild'; level: RaidLevel; failedDisk: number; progress: number })
  | (EventBase & { type: 'io.request'; pid: Pid; device: DeviceId; mode: IoMode })
  | (EventBase & { type: 'io.interrupt'; device: DeviceId; pid: Pid | null })
  | (EventBase & { type: 'io.dma_transfer'; device: DeviceId; bytes: number })
  | (EventBase & { type: 'io.poll_wasted'; device: DeviceId; wastedTicks: number })
  | (EventBase & { type: 'fs.block_allocated'; inode: InodeId; block: BlockId; method: FileAllocationMethod })
  | (EventBase & { type: 'fs.fragmented'; inode: InodeId; extents: number })
  | (EventBase & { type: 'fs.journal'; entry: JournalEntry })
  | (EventBase & { type: 'fs.corruption'; inode: InodeId; recoverable: boolean })
  | (EventBase & { type: 'fs.recovered'; inode: InodeId; fromJournal: boolean })
  | (EventBase & { type: 'security.access_denied'; domain: DomainId; object: string; right: AccessRight })
  | (EventBase & { type: 'security.escalation_attempt'; pid: Pid; fromRing: ProtectionRing; toRing: ProtectionRing; blocked: boolean })
  | (EventBase & { type: 'syscall.invoked'; request: SyscallRequest; result: SyscallResult })
  | (EventBase & { type: 'kernel.panic'; message: string });

export type KernelEventType = KernelEvent['type'];

export type KernelEventOf<T extends KernelEventType> = Extract<KernelEvent, { type: T }>;

export interface KernelEventStream {
  on<T extends KernelEventType>(type: T, handler: (e: KernelEventOf<T>) => void): Unsubscribe;
  onAny(handler: (e: KernelEvent) => void): Unsubscribe;
  /** Events emitted during the most recent step, in order. */
  readonly lastFrame: readonly KernelEvent[];
}

export type Unsubscribe = () => void;

/* ------------------------------------------------------------------ */
/* Kernel                                                              */
/* ------------------------------------------------------------------ */

export interface KernelConfig {
  readonly seed: number;
  readonly scheduler: SchedulerId;
  readonly schedulerParams: SchedulerParams;
  readonly totalFrames: number;
  readonly pageSize: number;
  readonly replacementPolicy: PageReplacementId;
  readonly allocationStrategy: AllocationStrategy;
  readonly tlbEntries: number;
  readonly diskPolicy: DiskSchedulingId;
  readonly totalCylinders: number;
  readonly raidLevel: RaidLevel | null;
  readonly fileAllocation: FileAllocationMethod;
  readonly journalingEnabled: boolean;
  readonly deadlockStrategy: 'ignore' | 'detect' | 'avoid' | 'prevent';
  /** Faults per thousand ticks above which thrashing begins. */
  readonly thrashingThreshold: number;
  /** Subsystems this leg actually simulates. Everything else is inert, which
   *  keeps early legs cheap and keeps their teaching surface small. */
  readonly enabledSubsystems: readonly SubsystemId[];
}

export type SubsystemId =
  | 'process' | 'scheduler' | 'memory' | 'vm' | 'sync'
  | 'deadlock' | 'storage' | 'io' | 'fs' | 'security';

/**
 * The simulator. Pure, deterministic, headless, and fully testable without a
 * browser. `step` advances exactly one tick and returns everything that happened.
 */
export interface Kernel {
  readonly config: Readonly<KernelConfig>;
  readonly tick: Tick;
  readonly events: KernelEventStream;

  step(): readonly KernelEvent[];
  /** Advance n ticks, returning the concatenated event log. */
  run(ticks: number): readonly KernelEvent[];

  syscall(request: SyscallRequest): SyscallResult;

  process(pid: Pid): Readonly<ProcessControlBlock> | undefined;
  readonly processes: readonly Readonly<ProcessControlBlock>[];

  /** Swap policies mid-run. This is a core player verb, not a debug hook. */
  setScheduler(id: SchedulerId, params?: Partial<SchedulerParams>): void;
  setReplacementPolicy(id: PageReplacementId): void;
  setDiskPolicy(id: DiskSchedulingId): void;
  setAllocationStrategy(s: AllocationStrategy): void;

  /** Ch. 8.6. Returns the trace whether or not the request is granted. */
  evaluateBankers(pid: Pid, resource: ResourceId, instances: number): SafetyCheckResult;
  detectDeadlock(): DeadlockReport | null;

  snapshot(): KernelSnapshot;
  restore(snapshot: KernelSnapshot): void;
}

/** Serialisable, structurally cloneable, and sufficient to resume a run exactly. */
export interface KernelSnapshot {
  readonly version: 1;
  readonly tick: Tick;
  readonly seq: number;
  readonly config: KernelConfig;
  readonly rng: readonly RngState[];
  readonly processes: readonly ProcessControlBlock[];
  readonly frames: readonly Frame[];
  readonly pageTables: readonly (readonly [AddressSpaceId, readonly PageTableEntry[]])[];
  readonly syncPrimitives: readonly SyncPrimitive[];
  readonly resources: readonly ResourceType[];
  readonly diskQueue: readonly DiskRequest[];
  readonly diskHead: DiskHead;
  readonly devices: readonly Device[];
  readonly inodes: readonly Inode[];
  readonly journal: readonly JournalEntry[];
  readonly domains: readonly ProtectionDomain[];
  readonly metrics: { readonly scheduling: SchedulingMetrics; readonly memory: MemoryMetrics };

  /* ---- amendment 1: the subsystem state channel ---- */

  /**
   * Whether this snapshot can reconstruct a running workload.
   *
   * 'init_only' means the tables above are the whole truth: no user process has
   * existed, no program is registered, and restore is exact. 'full' means
   * `subsystems` carries the side-table state the shared tables cannot express.
   *
   * Optional, and absent means 'init_only'. That is deliberate rather than lazy:
   * an init-only snapshot genuinely has no workload state to record, and making
   * the field required would break every snapshot construction site the moment
   * this amendment landed. `restore` is the enforcement point. It must reject a
   * snapshot whose completeness is weaker than the state it is being restored
   * into, rather than silently dropping it.
   */
  readonly completeness?: SnapshotCompleteness;

  /**
   * Per-subsystem state that the shared tables above cannot express, because it
   * lives in side tables private to a subsystem.
   *
   * This field exists because the original contract had nowhere to put it, which
   * blocked workload snapshot and restore in WP-02 and would have blocked every
   * subsystem after it. See docs/07-CONTRACT-AMENDMENTS.md, amendment 1.
   */
  readonly subsystems?: SubsystemSnapshots;
}

export type SnapshotCompleteness = 'init_only' | 'full';

/**
 * One slot per subsystem. The process slot is fully typed, because WP-02 is
 * built and its state is known. The other five are versioned envelopes, because
 * those subsystems do not exist yet and inventing their internals now would mean
 * amending this contract again the moment they did.
 *
 * As each subsystem lands, its package replaces its envelope with a typed
 * interface in the same additive way this amendment was made, and records it in
 * docs/07-CONTRACT-AMENDMENTS.md. The envelope is the transition mechanism, not
 * the destination.
 */
export interface SubsystemSnapshots {
  readonly process?: ProcessSnapshotState;
  /** Amendment 3. Queues, quantum remaining, aging and starvation timers, and the
   *  metrics accumulators, none of which SchedulerSnapshot carries: that type is a
   *  read-only view for the HUD and the world, not a restore format. */
  readonly scheduler?: SchedulerSnapshotState;
  readonly memory?: MemorySnapshotState;
  /** Amendment 3. Demand paging state distinct from the frame table: the working
   *  set window, the replacement policy's own ordering, and the fault counters. */
  readonly vm?: VmSnapshotState;
  /** Amendment 7. Synchronisation continuation: primitives, waits, memory order, race detector and scenario state. */
  readonly sync?: SyncSnapshotState;
  /** Amendment 8. Deadlock continuation: requests, recovery, dependencies and detection history. */
  readonly deadlock?: DeadlockSnapshotState;
  /** Amendment 9. Disk queues, media, RAID rebuild and opt-in paging continuation. */
  readonly storage?: StorageSnapshotState;
  /** Amendment 9. Device requests, interrupts, CPU charges, buffers, cache and spools. */
  readonly io?: IoSnapshotState;
  readonly fs?: SubsystemEnvelope;
  readonly security?: SubsystemEnvelope;
}

/** Read data is bytes; successful writes acknowledge with an empty array. */
export type StorageResultSnapshot =
  | { readonly kind: 'ok'; readonly data: readonly number[] }
  | {
      readonly kind: 'failed';
      readonly reason: 'io_timeout' | 'storage_corruption' | 'cancelled' | 'device_failed';
    };

/** LBA means 512-byte sector index; data bytes are integers in [0, 255]. */
export type StorageTransferSnapshot =
  | { readonly kind: 'read'; readonly lba: BlockId; readonly bytes: number }
  | { readonly kind: 'write'; readonly lba: BlockId; readonly data: readonly number[] };

/**
 * A live consumer owns pid/tid, cache generation or pager waiter. After explicit
 * cancellation this is correlation history; consumer teardown may remove it.
 */
export type StorageConsumerSnapshot =
  | { readonly kind: 'io'; readonly requestId: number }
  | { readonly kind: 'cache'; readonly flushId: number }
  | { readonly kind: 'paging'; readonly vmRequestId: number; readonly operation: 'read' | 'write' }
  | { readonly kind: 'direct' };

/**
 * Accepted logical work, retained until the consumer accepts its result or all
 * cancelled physical work drains. ID is storage-owned, independent of Io IDs.
 * A result has exactly one owner: this record until consumed, then Io/cache/
 * paging. Consumed records are removed; readyRequestIds is the delivery order.
 */
export type StorageRequestSnapshot = {
  readonly id: number;
  readonly consumer: StorageConsumerSnapshot;
  readonly pid: Pid | null;
  readonly transfer: StorageTransferSnapshot;
  readonly queuedAtTick: Tick;
  /** Live media work only; cleared after its result is accepted into completion. */
  readonly target:
    | { readonly kind: 'disk'; readonly driveId: string; readonly physicalOperationId: number }
    | { readonly kind: 'nvm'; readonly deviceId: DeviceId }
    | { readonly kind: 'raid'; readonly arrayId: string; readonly transactionId: number }
    | null;
  /** Cancellation suppresses waiter delivery; an already committed write may drain. */
  readonly cancelledAtTick: Tick | null;
  readonly completion: {
    readonly completedAtTick: Tick;
    readonly result: StorageResultSnapshot;
  } | null;
};

export type StorageDiskGeometrySnapshot = {
  readonly cylinders: number;
  readonly headsPerCylinder: number;
  readonly sectorsPerTrack: number;
  readonly bytesPerSector: number;
  readonly rpm: number;
  readonly seekOverheadMs: number;
  readonly seekPerCylinderMs: number;
  readonly transferMbPerSec: number;
};

/**
 * One real issued physical operation. RAID's unissued dependency plans live in
 * its own alias; they acquire this global ID only when dispatched to a drive.
 * Foreground DiskRequest projection uses id/pid/cylinder/write/queuedAtTick/
 * servedAtTick from here (write is derived from transfer.kind). Virtual route
 * endpoints never create operations. Null pid denotes ownerless kernel work;
 * it cannot produce process.starving or a user waiter. A shared pure helper over
 * {id,cylinder,queuedAtTick} serves both frozen-policy wrappers for real actor
 * DiskRequests and these physical queues. No null-pid/fake DiskRequest is made.
 */
export type StorageDiskOperationSnapshot = {
  readonly id: number;
  readonly driveId: string;
  readonly owner:
    | { readonly kind: 'request'; readonly requestId: number }
    | {
        readonly kind: 'raid'; readonly arrayId: string;
        readonly transactionId: number; readonly operationId: number;
      };
  readonly pid: Pid | null;
  readonly cylinder: number;
  readonly transfer: StorageTransferSnapshot;
  readonly queuedAtTick: Tick;
  readonly servedAtTick: Tick | null;
  readonly starvationNotified: boolean;
  readonly result: StorageResultSnapshot | null;
};

/**
 * Committed service is never recalculated after a policy/multiplier change.
 * A leg is head travel only: one disk.seek event when that leg is committed.
 * Absolute leg deadlines preserve the event/head cursor without requiring a
 * mutable cost model at restore. Several legs may share a tick. The request's
 * completeAtTick is based on ONE overhead + all leg travel + ONE rotation and
 * transfer, rounded ONCE; it is not the sum of rounded leg service times.
 */
export type StorageCommittedRouteSnapshot = {
  readonly physicalOperationId: number;
  readonly policy: DiskSchedulingId;
  readonly startedAtTick: Tick;
  readonly completeAtTick: Tick;
  readonly directionAfter: 'up' | 'down';
  readonly legs: readonly {
    readonly from: number;
    readonly to: number;
    readonly completeAtTick: Tick;
  }[];
  /** Prefix already moved/emitted; 0 <= nextLegIndex <= legs.length. */
  readonly nextLegIndex: number;
};

/**
 * Exactly one queue and durable byte store per physical disk, including RAID
 * members/spares. Private driveId is not a fifth kernel-visible Device.
 * Head.totalCylinders is projected from geometry.cylinders. Shared top-level
 * diskQueue/diskHead project disk0's real actor requests/head; they are not a
 * second persistence authority. A projected DiskRequest's pid remains Pid.
 */
export type StorageDiskDriveSnapshot = {
  readonly driveId: string;
  readonly geometry: StorageDiskGeometrySnapshot;
  readonly head: { readonly cylinder: number; readonly direction: 'up' | 'down' };
  /** Arrival order of issued, service-eligible operations; excludes active. */
  readonly queue: readonly number[];
  readonly active: StorageCommittedRouteSnapshot | null;
  /** Canonical ascending LBA; exactly bytesPerSector bytes; absent sectors=zero. */
  readonly sectors: readonly { readonly lba: BlockId; readonly data: readonly number[] }[];
  readonly statistics: {
    readonly totalHeadMovement: number;
    /** Successful real disk services, including ones whose consumer exited. */
    readonly completedRequests: number;
    /** Welford moments over servedAtTick - queuedAtTick, no unbounded history. */
    readonly meanWaitTicks: number;
    readonly waitM2TicksSquared: number;
  };
};

/**
 * Attached only by attachPagingStorage(); never inferred from storage.enabled.
 * A nonnull saved adapter restores prior explicit attachment. The original VM
 * slot still owns its requests, phase, frame reservations and final dueTick.
 */
export type StoragePagingAdapterSnapshot = {
  readonly target:
    | { readonly kind: 'disk'; readonly driveId: string }
    | { readonly kind: 'nvm'; readonly deviceId: DeviceId }
    | { readonly kind: 'raid'; readonly arrayId: string };
  /** Address allocation is local to this configured backing extent. */
  readonly firstSector: BlockId;
  readonly sectorCount: number;
  readonly pageBytes: number;
  /**
   * Canonical (space,page) order. Slots are lowest available aligned page spans
   * inside the extent. Each span occupies ceil(pageBytes/512) sectors. A mapping
   * cannot be reused while a cancelled in-flight operation can still touch it.
   */
  readonly mappings: readonly {
    readonly space: AddressSpaceId;
    readonly page: PageId;
    readonly firstSector: BlockId;
  }[];
  /** Submission order; global storage ID distinguishes write-back then read. */
  readonly transfers: readonly StoragePagingTransferSnapshot[];
};

export type StoragePagingTransferSnapshot = {
  /** Live reference while pending/cancelling; historical correlation after ACK. */
  readonly storageRequestId: number;
  readonly vmRequestId: number;
  readonly operation: 'read' | 'write';
  readonly pid: Pid;
  /** Actual backing ASID/page; dirty writes name the victim, never the faulting page. */
  readonly backing: { readonly space: AddressSpaceId; readonly page: PageId };
  readonly frame: FrameId;
  /**
   * Original WP-06 floor for THIS stage: write uses serviceBase+majorFaultTicks;
   * read uses the existing dueTick. A media ACK can delay, never shorten it.
   */
  readonly notBeforeTick: Tick;
  readonly state:
    | { readonly kind: 'pending' }
    | {
        readonly kind: 'acknowledged';
        readonly completedAtTick: Tick;
        readonly result: StorageResultSnapshot;
      }
    | { readonly kind: 'cancelled'; readonly cancelledAtTick: Tick };
};

/** Exact proposed storage envelope; payload and every compound child are literals. */
export interface StorageSnapshotState {
  readonly owner: 'storage';
  readonly version: 1;
  readonly payload: {
    readonly tick: Tick;
    readonly settings: {
      readonly msPerTick: number;
      readonly diskStarvationThreshold: number;
      readonly rebuildBlocksPerTick: number;
      readonly rebuildProgressInterval: number;
    };
    readonly policy: DiskSchedulingId;
    readonly costMultiplier: number;
    readonly nextRequestId: number;
    readonly nextPhysicalOperationId: number;
    /** Canonical ID order; counters never reuse acknowledged IDs. */
    readonly requests: readonly StorageRequestSnapshot[];
    readonly physicalOperations: readonly StorageDiskOperationSnapshot[];
    /** Exact production order awaiting consumer acceptance, not recomputed by ID. */
    readonly readyRequestIds: readonly number[];
    readonly readyPhysicalOperationIds: readonly number[];
    /** Canonical private driveId order; includes replacement members. */
    readonly drives: readonly StorageDiskDriveSnapshot[];
    readonly nvm: readonly StorageNvmSnapshot[];
    readonly raid: readonly StorageRaidSnapshot[];
    readonly paging: StoragePagingAdapterSnapshot | null;
  };
}

/** References one page-sized portion of an owned global storage request. */
export type StorageNvmPartRefSnapshot = {
  readonly requestId: number;
  readonly partIndex: number;
};

export type StorageNvmSnapshot = {
  readonly deviceId: DeviceId;
  readonly geometry: {
    readonly pages: number;
    readonly logicalPages: number;
    readonly pagesPerBlock: number;
    readonly readUs: number;
    readonly writeUs: number;
    readonly eraseUs: number;
    readonly overProvisionRatio: number;
  };
  /** Installed capacity, checked against the owning storage configuration. */
  readonly writeBufferPages: number;
  /**
   * Ascending physical page index. Each byte image is exactly 4096 bytes.
   * Non-null logicalPage is the authoritative logical-to-physical mapping;
   * null means programmed but invalid. No second map/free/invalid list is saved.
   * An absent physical page is erased/free unless reserved by active foreground
   * programming or the unfinished destinations in gc.relocations.
   */
  readonly programmedPages: readonly {
    readonly physicalPage: number;
    readonly logicalPage: number | null;
    readonly data: readonly number[];
  }[];
  /** Dense erase-block-index order; lifetime wear survives measurement resets. */
  readonly eraseCounts: readonly number[];
  /** Monotonic generation identity shared by buffers and detached flush images. */
  readonly nextGeneration: number;
  /**
   * Buffer order is the live eviction order. Each image contains the complete
   * current 4096-byte page, including untouched bytes. Parts are acknowledged
   * only after this generation has been physically programmed.
   */
  readonly buffers: readonly {
    readonly logicalPage: number;
    readonly generation: number;
    readonly data: readonly number[];
    readonly parts: readonly StorageNvmPartRefSnapshot[];
  }[];
  /**
   * FIFO detached flush images, including any generation being programmed.
   * A newer buffer for the same page may coexist; its bytes cannot replace an
   * older in-flight image. An image leaves this list at durable completion.
   */
  readonly programs: readonly {
    readonly logicalPage: number;
    readonly generation: number;
    readonly data: readonly number[];
    readonly parts: readonly StorageNvmPartRefSnapshot[];
  }[];
  /**
   * Original request address, operation and write bytes remain in the global
   * storage request table. These records preserve page splitting, partial read
   * results and durability fan-in. Completed writes have ok/data:[]; reads have
   * exactly byteCount result bytes. Completed logical requests leave this list.
   */
  readonly requests: readonly {
    readonly requestId: number;
    readonly parts: readonly {
      readonly logicalPage: number;
      readonly pageOffset: number;
      readonly byteCount: number;
      readonly result: StorageResultSnapshot | null;
    }[];
  }[];
  /** Ordered not-yet-accepted portions; active reads leave this list on start. */
  readonly pendingParts: readonly StorageNvmPartRefSnapshot[];
  /**
   * The controller has one serial media engine, independent of HDD policy.
   * Timing is absolute, so a restore neither repeats nor loses elapsed work.
   * The foreground program destination is reserved until its atomic commit.
   */
  readonly active: {
    readonly startedAtTick: Tick;
    readonly completeAtTick: Tick;
    readonly operation:
      | {
          readonly kind: 'read'; readonly part: StorageNvmPartRefSnapshot;
          /** Stable read image selected at start, before later buffered writes. */
          readonly data: readonly number[];
        }
      | { readonly kind: 'program'; readonly generation: number; readonly physicalPage: number }
      | { readonly kind: 'gc' };
  } | null;
  /**
   * The complete destination reservation is made before copying starts. Sources
   * are in ascending page order. GC excludes foreground media mutation while
   * this plan is live; an unfinished source therefore retains the bytes needed
   * for its program phase, without a redundant copy buffer. Each completed
   * relocation atomically remaps its page and advances nextRelocation. Erasure
   * follows all copies. Phase plus active deadline retains read/program work.
   * Mutating controls such as trim return EBUSY while this plan is active;
   * rejected controls enqueue no deferred work or hidden continuation.
   */
  readonly gc: {
    readonly victimBlock: number;
    readonly relocations: readonly {
      readonly sourcePage: number;
      readonly destinationPage: number;
    }[];
    readonly nextRelocation: number;
    readonly phase: 'read' | 'program' | 'erase';
  } | null;
  /**
   * Measurement counters may reset after preconditioning; page state and wear
   * do not. WA = 4096 * (foregroundPrograms + relocationPrograms) /
   * logicalBytesWritten, with a defined zero-denominator presentation policy.
   * Count bytes accepted by host writes, not the number of small-write calls.
   */
  readonly counters: {
    readonly logicalBytesWritten: number;
    readonly logicalBytesRead: number;
    readonly foregroundPrograms: number;
    readonly relocationPrograms: number;
    readonly pageReads: number;
    readonly blockErases: number;
  };
};

/**
 * RAID plans contain all physical operations, including dependency-blocked ones.
 * These plans are included when deriving the pre-service member queue lengths.
 * On issue, the disk subsystem owns the physical request, deadline, route and
 * write bytes. After acknowledgement its result is retained here only while a
 * dependent operation or the logical completion still needs it.
 */
export type StorageRaidOperationSnapshot = {
  readonly id: number;
  readonly memberIndex: number;
  /** A rebuild can target a spare rather than the member's current drive. */
  readonly driveId: string;
  readonly sectorLba: BlockId;
  readonly dependsOn: readonly number[];
  readonly operation:
    | { readonly kind: 'read' }
    | {
        readonly kind: 'write';
        /**
         * Every physical write is one 512-byte sector. Computed sources are
         * derived from the transaction's retained read results and original
         * global request input when dependencies are satisfied. There are no
         * separately saved parity caches or duplicate durable member bytes.
         */
        readonly source:
          | { readonly kind: 'request'; readonly byteOffset: number }
          | { readonly kind: 'p'; readonly stripe: number }
          | { readonly kind: 'q'; readonly stripe: number }
          | { readonly kind: 'reconstructed'; readonly stripe: number; readonly memberIndex: number }
          | { readonly kind: 'mirror'; readonly readOperationId: number };
      };
  readonly state:
    | { readonly kind: 'planned' }
    | { readonly kind: 'submitted'; readonly physicalOperationId: number }
    | { readonly kind: 'settled'; readonly result: StorageResultSnapshot };
};

export type StorageRaidTransactionSnapshot = {
  readonly id: number;
  readonly purpose:
    | { readonly kind: 'request'; readonly requestId: number }
    | {
        readonly kind: 'rebuild';
        readonly memberIndex: number;
        readonly sectorLba: BlockId;
      };
  /**
   * ID order is the deterministic issuance tie-break. Dependencies retain
   * read-before-write ordering. Full-stripe writes are represented by plans
   * containing only their data/P/Q writes; alignment and stripe width derive
   * from the original request and array level, with no independent flag.
   */
  readonly operations: readonly StorageRaidOperationSnapshot[];
};

export type StorageRaidSnapshot = {
  readonly arrayId: string;
  readonly level: RaidLevel;
  readonly blocksPerMember: number;
  /** Fatal loss is latched; draining rebuild work cannot resurrect this array. */
  readonly dataLost: boolean;
  /**
   * Array order is physical member index. Mirror pairs are adjacent. Version 1
   * fixes RAID-5/6 P=(n-1-(stripe%n)); RAID-6 Q=(P-1+n)%n, with remaining data
   * members in ascending index order. P is bytewise XOR; Q is bytewise GF(256)
   * with primitive polynomial 0x11d and coefficients 2^dataOrdinal. RAID 6
   * requires 2 <= n-2 <= 255, so these coefficients are distinct and nonzero.
   * Durable data and P/Q bytes live only in the referenced
   * StorageDiskDriveSnapshot sector maps, including spares.
   * dataLost dominates availability; otherwise member failures determine it.
   */
  readonly members: readonly {
    readonly driveId: string;
    readonly failed: boolean;
  }[];
  /**
   * Authoritative available-spare pool in deterministic selection order. Each
   * available drive belongs to one array's pool and appears in no member table
   * or active rebuild row. Selection removes the first ID and transfers
   * ownership to that member's rebuild row;
   * no constructor-only spare inventory or ordering is needed after restore.
   */
  readonly spareDriveIds: readonly string[];
  readonly nextTransactionId: number;
  readonly nextOperationId: number;
  /** Ordered transactions own foreground and rebuild plans through completion. */
  readonly transactions: readonly StorageRaidTransactionSnapshot[];
  /** Pause stops new rebuild issuance; already-issued physical work continues. */
  readonly rebuildPaused: boolean;
  /**
   * One row per failed member being repaired; RAID 6 may have two. Source reads
   * and spare writes are ordinary transactions through the shared disk queues.
   * Spare identities come from spareDriveIds, not constructor-only configuration.
   * Issuance cap and progress interval are persisted in storage.settings as
   * rebuildBlocksPerTick and rebuildProgressInterval; there is no per-array copy.
   */
  readonly rebuilds: readonly {
    readonly memberIndex: number;
    readonly spareDriveId: string;
    /** Count/cursor, including the one-past-end value blocksPerMember. */
    readonly nextSectorToIssue: number;
    /** All sectors below this index have completed; no dense bitmap is needed. */
    readonly completedPrefix: number;
    /** Sorted completed sectors beyond the prefix support out-of-order I/O. */
    readonly completedBeyondPrefix: readonly BlockId[];
    readonly nextProgressAtTick: Tick;
  }[];
  /**
   * Lifetime counters remain after completed plans are retired. Throughput is
   * measured from completed logical work, never inferred from the issuance cap.
   * The shared issuance budget resets in phase 1; only completed ticks are saved.
   */
  readonly counters: {
    readonly completedReadBlocks: number;
    readonly completedWriteBlocks: number;
    readonly completedRebuildBlocks: number;
    readonly issuedPhysicalReads: number;
    readonly issuedPhysicalWrites: number;
    readonly completedPhysicalReads: number;
    readonly completedPhysicalWrites: number;
  };
};

/** WP-09 I/O continuation at a completed-tick boundary. Plain versioned data. */
export interface IoSnapshotState {
  readonly owner: 'io';
  readonly version: 1;
  readonly payload: {
    readonly tick: Tick;
    readonly settings: {
      readonly interruptServiceTicks: number;
      readonly maxInterruptsPerTick: number;
      readonly interruptStormThreshold: number;
      readonly interruptStormWindow: number;
      readonly maxPendingInterrupts: number;
      readonly dmaCycleStealRatio: number;
      readonly blockCacheEntries: number;
    };
    readonly nextRequestId: number;
    readonly nextInterruptTokenId: number;
    readonly nextFlushId: number;
    readonly nextSyncId: number;
    readonly nextSpoolJobId: number;
    readonly lastTimerTick: Tick | null;
    readonly lastCompletionTick: Tick | null;
    /** Included in scheduler.runtime.switchDebt, not added again on restore. */
    readonly kernelDebt: number;
    /** Work recorded outside phase 3; excluded from kernelDebt until posted there. */
    readonly pendingKernelCharges: readonly {
      readonly kind: 'interrupt' | 'copy';
      readonly device: DeviceId;
      /** Provenance may name a completed/cancelled request below nextRequestId. */
      readonly requestId: number | null;
      readonly ticks: number;
    }[];
    readonly cpuCharges: {
      readonly issueTicks: number;
      readonly interruptTicks: number;
      readonly copyTicks: number;
      readonly dmaStealTicks: number;
    };
    /** Includes historical pids so cleanup does not erase charged polling time. */
    readonly pollTicks: readonly { readonly pid: Pid; readonly ticks: number }[];
    readonly devices: readonly IoSnapshotDevice[];
    readonly requests: readonly IoSnapshotRequest[];
    readonly interrupts: {
      readonly lines: readonly {
        readonly device: DeviceId;
        readonly priority: number;
        readonly maskable: boolean;
        /** FIFO tokens are authoritative; pending is this array's length. */
        readonly pending: readonly IoSnapshotInterruptToken[];
        readonly panicEmitted: boolean;
      }[];
      readonly masks: readonly DeviceId[];
      /** Bottom to top; must be empty at a completed-tick snapshot boundary. */
      readonly serviceStack: readonly { readonly device: DeviceId; readonly token: IoSnapshotInterruptToken }[];
      readonly budgetTick: Tick | null;
      readonly deliveredThisTick: number;
      readonly lastStormSampleTick: Tick | null;
      readonly storm: null | {
        readonly device: DeviceId;
        readonly sourcePid: Pid | null;
        readonly beganAtTick: Tick;
        readonly ticksHeld: number;
        readonly stage: 'observed' | 'afflicted' | 'masked' | 'terminated';
      };
    };
    readonly buffers: readonly IoSnapshotBuffer[];
    readonly cache: {
      readonly policy: 'write_through' | 'write_back';
      /** Global, never reused after eviction; capacity is global across devices. */
      readonly nextGeneration: number;
      readonly hits: number;
      readonly misses: number;
      /** Identity (device, block); eviction order is (recency, block, device). */
      readonly entries: readonly {
        readonly device: DeviceId;
        readonly block: BlockId;
        readonly contents: readonly number[];
        readonly loadedAtTick: Tick;
        readonly lastAccessTick: Tick | null;
        readonly generation: number;
        readonly durableGeneration: number;
      }[];
      /** A newer generation stays dirty when an older captured flush completes. */
      readonly flushes: readonly {
        readonly id: number;
        readonly device: DeviceId;
        readonly block: BlockId;
        readonly generation: number;
        readonly contents: readonly number[];
        readonly reason: 'write_through' | 'eviction' | 'sync';
        readonly progress:
          | { readonly kind: 'queued' }
          /** Exactly one delivery owner: this I/O request OR direct storage below. */
          | { readonly kind: 'io'; readonly requestId: number }
          | { readonly kind: 'storage'; readonly storageRequestId: number }
          | { readonly kind: 'completed'; readonly result: IoSnapshotMediaResult };
      }[];
      /** The incoming request cannot replace a dirty victim before its flush. */
      readonly admissions: readonly {
        readonly requestId: number;
        readonly device: DeviceId;
        readonly block: BlockId;
        readonly evictionFlushId: number | null;
      }[];
      readonly syncs: readonly {
        readonly id: number;
        readonly actor: IoSnapshotActor;
        readonly requestedAtTick: Tick;
        readonly flushIds: readonly number[];
        readonly completed: boolean;
      }[];
    };
    readonly spools: readonly {
      readonly device: DeviceId;
      readonly enabled: boolean;
      /** Whole jobs in FCFS order; unspooled jobs retain individual offsets. */
      readonly jobs: readonly {
        readonly id: number;
        readonly owner: { readonly kind: 'actor'; readonly actor: IoSnapshotActor } | { readonly kind: 'fixture' };
        readonly outputInode: InodeId;
        readonly submittedAtTick: Tick;
        readonly contents: readonly number[];
        readonly offset: number;
        readonly requestId: number | null;
        readonly corruptionEmitted: boolean;
      }[];
      readonly activeJobId: number | null;
      readonly lastWriterJobId: number | null;
    }[];
  };
}

export type IoSnapshotActor = { readonly pid: Pid; readonly tid: Tid };

export type IoSnapshotMediaResult =
  | { readonly kind: 'ok'; readonly data: readonly number[] }
  | { readonly kind: 'failed'; readonly reason: 'io_timeout' | 'storage_corruption' | 'cancelled' | 'device_failed' };

export type IoSnapshotResult = IoSnapshotMediaResult | { readonly kind: 'lost' };

export type IoSnapshotRequest = {
  readonly id: number;
  readonly owner:
    | { readonly kind: 'actor'; readonly actor: IoSnapshotActor }
    | { readonly kind: 'cache'; readonly flushId: number }
    | { readonly kind: 'spool'; readonly jobId: number }
    | { readonly kind: 'kernel'; readonly purpose: 'console_flush' | 'fixture' };
  readonly device: DeviceId;
  readonly submittedAtTick: Tick;
  readonly startedAtTick: Tick | null;
  readonly wordSize: number;
  /** BlockId/LBAs are 512-byte sector addresses; filesystem conversion is WP-10's. */
  readonly command:
    | { readonly kind: 'read'; readonly lba: BlockId; readonly bytes: number }
    | { readonly kind: 'write'; readonly lba: BlockId; readonly contents: readonly number[] }
    | { readonly kind: 'character'; readonly contents: readonly number[] }
    | { readonly kind: 'packet'; readonly contents: readonly number[] };
  /** Storage owns media progress until acknowledgment transfers its result here. */
  readonly service:
    | { readonly kind: 'queued' }
    | { readonly kind: 'timer'; readonly remainingTicks: number }
    | { readonly kind: 'storage'; readonly storageRequestId: number }
    | { readonly kind: 'completed'; readonly atTick: Tick; readonly result: IoSnapshotResult };
  readonly continuation:
    | {
        readonly mode: 'polling';
        readonly setupTicksRemaining: number;
        readonly copiedWords: number;
        readonly wastedPolls: number;
        readonly wastedEventEmitted: boolean;
      }
    | {
        readonly mode: 'interrupt';
        readonly setupTicksRemaining: number;
        readonly copyDebt: 'not_due' | 'pending' | 'charged';
      }
    | {
        readonly mode: 'dma';
        readonly setupTicksRemaining: number;
        readonly transferTicks: number;
        readonly elapsedTransferTicks: number;
        readonly stealBudget: number;
        readonly stealsCharged: number;
        readonly stealAccumulator: number;
        readonly dmaEventEmitted: boolean;
      };
  /** Distinguishes a pending instruction from its already-retired blocking issue. */
  readonly instructionRetired: boolean;
  readonly wakeable: boolean;
};

export type IoSnapshotInterruptToken = {
  readonly id: number;
  readonly raisedAtTick: Tick;
} & (
  | { readonly kind: 'completion'; readonly requestId: number }
  | { readonly kind: 'signal'; readonly sourcePid: Pid | null }
  | { readonly kind: 'timer' }
  | { readonly kind: 'panic'; readonly message: string }
);

export type IoSnapshotDevice = {
  readonly id: DeviceId;
  readonly displayName: string;
  readonly defaultMode: IoMode;
  readonly mode: IoMode;
  readonly latency: number;
  readonly wordSize: number;
  /** Requests awaiting device service; excludes activeRequestId. */
  readonly requestOrder: readonly number[];
  readonly activeRequestId: number | null;
  /** Pending completion tokens moved out of a masked interrupt line, in order. */
  readonly pollingTokens: readonly IoSnapshotInterruptToken[];
  readonly mitigation: null | {
    readonly priorMode: IoMode;
    readonly wasMasked: boolean;
    readonly healthyTicks: number;
    readonly nextPollAtTick: Tick;
  };
  readonly driver:
    | {
        readonly kind: 'disk0';
        /** Null is unavailable storage, never an implicit timer fallback. */
        readonly backing:
          | { readonly kind: 'disk'; readonly driveId: string }
          | { readonly kind: 'raid'; readonly arrayId: string }
          | null;
      }
    | { readonly kind: 'nvm0'; readonly backing: { readonly deviceId: DeviceId } | null }
    | { readonly kind: 'character_output'; readonly output: readonly number[] }
    | { readonly kind: 'net0'; readonly lossProbability: number }
    /** Explicit test adapters; neither is an additional shipped driver module. */
    | { readonly kind: 'timer_fixture' }
    | { readonly kind: 'printer_fixture'; readonly output: readonly number[] };
};

export type IoSnapshotBuffer = {
  readonly device: DeviceId;
  readonly scheme:
    | { readonly kind: 'single' }
    | { readonly kind: 'double' }
    | { readonly kind: 'circular'; readonly capacity: number };
  readonly producerTicks: number;
  readonly consumerTicks: number;
  /** FIFO order; fill/drain records below also occupy buffers. */
  readonly ready: readonly { readonly requestId: number; readonly contents: readonly number[] }[];
  readonly filling: null | { readonly requestId: number; readonly contents: readonly number[]; readonly remainingTicks: number };
  readonly draining: null | { readonly requestId: number; readonly contents: readonly number[]; readonly remainingTicks: number };
  readonly producerWaiters: readonly number[];
  readonly consumerWaiters: readonly number[];
  readonly occupancySamples: readonly { readonly tick: Tick; readonly occupancy: number }[];
  readonly stalls: number;
};

/** WP-08 deadlock continuation. Plain versioned data, not a live graph view. */
export interface DeadlockSnapshotState {
  readonly owner: 'deadlock';
  readonly version: 1;
  readonly payload: {
    readonly tick: Tick;
    readonly settings: {
      readonly deadlockDetectionInterval: number;
      readonly rollbackCheckpointInterval: number;
      readonly maxPreemptionsPerProcess: number;
      readonly preventionMode: 'ordering' | 'all_or_nothing';
      readonly deadlockRecovery: 'none' | 'abort_one' | 'abort_all' | 'preempt';
    };
    /** Resource ID order. Availability is derived from staged PCB holdings. */
    readonly declarations: readonly {
      readonly id: ResourceId;
      readonly displayName: string;
      readonly totalInstances: number;
      /** The declared value to restore when a temporary override expires. */
      readonly preemptible: boolean;
    }[];
    /** Declaration order across the two governed namespaces determines rank. */
    readonly ranks: readonly {
      readonly resource: ResourceId;
      readonly source: 'resource' | 'sync';
    }[];
    /** PID order; each vector contains positive counts in resource ID order. */
    readonly claims: readonly {
      readonly pid: Pid;
      readonly resources: readonly (readonly [ResourceId, number])[];
    }[];
    readonly nextRequestGeneration: number;
    /** Generation order; one complete vector per requesting actor. */
    readonly requests: readonly {
      readonly generation: number;
      readonly actor: DeadlockSnapshotActor;
      readonly requestedAt: Tick;
      readonly resources: readonly (readonly [ResourceId, number])[];
      /** Null means queued; otherwise every instance is already allocated. */
      readonly grantedAt: Tick | null;
    }[];
    /** Intended protocol participants; IPC remains the owner of actual waits. */
    readonly mailboxEndpoints: readonly {
      readonly mailbox: ResourceId;
      readonly senders: readonly DeadlockSnapshotActor[];
      readonly receivers: readonly DeadlockSnapshotActor[];
    }[];
    /** Resource-free PC checkpoints; no service, CPU or external state rewind. */
    readonly checkpoints: readonly {
      readonly pid: Pid;
      readonly tid: Tid;
      readonly tick: Tick;
      readonly programCounter: number;
    }[];
    /** PID order. Counts survive exec for the lifetime of the PID. */
    readonly preemptionCounts: readonly (readonly [Pid, number])[];
    readonly preemptibilityOverrides: readonly {
      readonly resource: ResourceId;
      readonly preemptible: boolean;
      readonly untilTick: Tick;
    }[];
    readonly lastObservationTick: Tick | null;
    readonly lastStatisticsTick: Tick | null;
    readonly nextDependencyGeneration: number;
    /** Generation order. A changed alternative group begins a new observation. */
    readonly observations: readonly {
      readonly generation: number;
      readonly dependency: DeadlockSnapshotDependency;
      readonly sinceTick: Tick;
    }[];
    /** Canonical observation-generation sets for continuously present witnesses. */
    readonly confirmedEpisodes: readonly (readonly number[])[];
    /** Historical I-26 evidence, captured before recovery changes live owners. */
    readonly lastDetection: {
      readonly report: {
        readonly tick: Tick;
        readonly cycle: readonly Pid[];
        readonly resources: readonly ResourceId[];
        readonly conditions: readonly CoffmanCondition[];
        readonly suggestedVictims: readonly Pid[];
      };
      readonly actorCycle: readonly DeadlockSnapshotActor[];
      /** Includes the closed alternative groups supporting the actor witness. */
      readonly dependencies: readonly DeadlockSnapshotDependency[];
    } | null;
    /** Ratios are derived from integer accumulators, never saved as averages. */
    readonly statistics: {
      readonly deadlocks: number;
      readonly processesLost: number;
      readonly occupiedInstanceTicks: number;
      readonly capacityInstanceTicks: number;
      readonly totalTicks: number;
      readonly detectionLatencyTicks: number;
      readonly detectionSamples: number;
    };
  };
}

export type DeadlockSnapshotActor = {
  readonly pid: Pid;
  readonly tid: Tid;
};

/** An effective dependency before PID projection, with source-specific groups. */
export type DeadlockSnapshotDependency = {
  readonly waiter: DeadlockSnapshotActor;
  readonly source:
    | {
        readonly kind: 'resource_request';
        readonly resource: ResourceId;
        readonly requestGeneration: number;
      }
    | {
        readonly kind: 'sync_wait';
        readonly resource: ResourceId;
        readonly waitGeneration: number;
      }
    | {
        readonly kind: 'mailbox';
        readonly mailbox: ResourceId;
        readonly operation: 'send' | 'recv';
      }
    | {
        readonly kind: 'child_wait';
        readonly child: Pid;
      };
  /**
   * PID/TID order. Resource requests group one holder's eligible actors; sync
   * and mailbox waits group alternative releasers/signallers; child waits use
   * one required child actor per dependency. Instance thresholds are proved by
   * the multi-instance detector, not by treating holders as interchangeable.
   */
  readonly alternatives: readonly DeadlockSnapshotActor[];
};

/** WP-07 synchronization continuation. Plain versioned data, not a live view. */
export interface SyncSnapshotState {
  readonly owner: 'sync';
  readonly version: 1;
  readonly payload: {
    readonly tick: Tick;
    readonly settings: {
      readonly progressStallLimit: number;
      readonly boundedWaitLimit: number;
      readonly spinWaitTicks: number;
      readonly storeBufferDepth: number;
      readonly priorityInheritance: boolean;
      readonly rwlockPolicy: 'reader_pref' | 'writer_pref' | 'fair';
      readonly starvationThreshold: number;
      readonly starvationFatalThreshold: number;
    };
    readonly nextWaitGeneration: number;
    readonly nextPermitId: number;
    readonly lastTimerTick: Tick | null;
    readonly lastInversionTick: Tick | null;
    /** Resource ID order; detailed records produce the shared PID projections. */
    readonly primitives: readonly SyncSnapshotPrimitive[];
    readonly waits: readonly SyncSnapshotWait[];
    readonly reservations: readonly {
      readonly waitGeneration: number;
      readonly grantedAt: Tick;
    }[];
    readonly requirements: readonly {
      readonly resource: ResourceId;
      readonly capacity: number;
      readonly mode: 'enforce' | 'observe';
      readonly criticalActors: readonly SyncSnapshotActor[];
      readonly mutualExclusionViolations: number;
      readonly progressFreeSince: Tick | null;
      readonly progressReported: boolean;
    }[];
    readonly priorities: readonly {
      readonly pid: Pid;
      readonly ordinaryPriority: number;
      readonly donations: readonly {
        readonly resource: ResourceId;
        readonly ownerTid: Tid;
        readonly waitGeneration: number;
        readonly priority: number;
      }[];
    }[];
    readonly inversions: readonly {
      readonly blocked: Pid;
      readonly holder: Pid;
      readonly interposed: Pid;
    }[];
    readonly memoryOrder: SyncSnapshotMemoryOrder;
    readonly raceDetector: {
      readonly nextAccessId: number;
      readonly cells: readonly SyncSnapshotRaceCell[];
    };
    readonly atomicLocks: readonly SyncSnapshotAtomicLock[];
    /** Cumulative PID totals survive an individual thread's join. */
    readonly spinTicks: readonly (readonly [Pid, number])[];
    readonly actors: readonly SyncSnapshotExecution[];
    readonly scenarios: readonly SyncSnapshotScenario[];
  };
}

export type SyncSnapshotActor = {
  readonly pid: Pid;
  readonly tid: Tid;
};

export type SyncSnapshotWait = {
  /** Unique episode ID; fair RW admission uses this ticket order. */
  readonly generation: number;
  readonly actor: SyncSnapshotActor;
  readonly resource: ResourceId;
  readonly operation:
    | { readonly kind: 'mutex' | 'semaphore' | 'monitor_entry' | 'rw_read' | 'rw_write' | 'spin' }
    | { readonly kind: 'condition'; readonly condition: string }
    | { readonly kind: 'barrier'; readonly barrierGeneration: number };
  readonly requestedAt: Tick;
  readonly entriesObserved: number;
  readonly boundedWarningEmitted: boolean;
  readonly starvationWarningEmitted: boolean;
  readonly starvationFatalEmitted: boolean;
};

export type SyncSnapshotPrimitive = {
  readonly id: ResourceId;
  readonly displayName: string;
  readonly capacity: number;
  readonly ordered: boolean;
} & (
  | {
      readonly kind: 'mutex';
      readonly owner: SyncSnapshotActor | null;
      /** Queue arrays contain wait generations, in head-to-tail order. */
      readonly entryQueue: readonly number[];
    }
  | {
      readonly kind: 'semaphore';
      readonly initialValue: number;
      /** Oldest first; null attribution never removes the debit. */
      readonly debits: readonly {
        readonly id: number;
        readonly actor: SyncSnapshotActor | null;
      }[];
      readonly waitQueue: readonly number[];
    }
  | {
      readonly kind: 'monitor';
      readonly owner: SyncSnapshotActor | null;
      readonly signalDiscipline: 'signal_and_continue' | 'signal_and_wait';
      readonly entryQueue: readonly number[];
      readonly conditions: readonly {
        readonly name: string;
        readonly waitQueue: readonly number[];
      }[];
    }
  | {
      readonly kind: 'rwlock';
      readonly policy: 'reader_pref' | 'writer_pref' | 'fair';
      readonly writer: SyncSnapshotActor | null;
      readonly readers: readonly SyncSnapshotActor[];
      readonly waitQueue: readonly number[];
    }
  | {
      readonly kind: 'barrier';
      readonly generation: number;
      readonly arrivals: readonly number[];
    }
);

/** Only local control cells store a value here; external owners restore theirs. */
export type SyncSnapshotCell =
  | { readonly id: string; readonly kind: 'control'; readonly value: number }
  | { readonly id: string; readonly kind: 'region'; readonly region: ResourceId }
  | { readonly id: string; readonly kind: 'inode'; readonly inode: InodeId; readonly field: string };

export type SyncSnapshotMemoryOrder = {
  readonly cells: readonly SyncSnapshotCell[];
  readonly nextWriteId: number;
  readonly buffers: readonly {
    readonly pid: Pid;
    readonly reordering: boolean;
    readonly depth: number;
    readonly attemptResidue: number;
    /** Issue order is authoritative; draining shuffles eligible heads only. */
    readonly writes: readonly {
      readonly id: number;
      readonly actor: SyncSnapshotActor;
      readonly cell: string;
      readonly value: number;
      readonly issuedAt: Tick;
      readonly held: readonly ResourceId[];
      /** Explicit RMW load-access ID, or null for plain/control stores. */
      readonly rmw: number | null;
    }[];
  }[];
};

export type SyncSnapshotAccess = {
  /** Global access order also distinguishes multiple accesses in one tick. */
  readonly id: number;
  readonly tick: Tick;
  readonly actor: SyncSnapshotActor;
  readonly op: 'load' | 'store';
  readonly value: number;
  readonly atomic: boolean;
  readonly held: readonly ResourceId[];
  readonly rmw: number | null;
};

export type SyncSnapshotRaceCell = {
  readonly cell: string;
  readonly serialValue: number;
  readonly lockSet: readonly ResourceId[] | null;
  /** Oldest first, at most 32 records. */
  readonly history: readonly SyncSnapshotAccess[];
  /** Each category retains at most two distinct actor representatives. */
  readonly observed: {
    readonly plainReads: readonly SyncSnapshotAccess[];
    readonly plainWrites: readonly SyncSnapshotAccess[];
    readonly atomicReads: readonly SyncSnapshotAccess[];
    readonly atomicWrites: readonly SyncSnapshotAccess[];
  };
  readonly episodeOrigin: SyncSnapshotAccess | null;
  readonly pending: readonly {
    /** The load's access ID identifies this RMW until its store commits. */
    readonly load: SyncSnapshotAccess;
    readonly writeId: number | null;
    /** At most one competing completed operation per pending RMW. */
    readonly witness: {
      readonly load: SyncSnapshotAccess | null;
      readonly store: SyncSnapshotAccess;
    } | null;
  }[];
};

export type SyncSnapshotAtomicLock = {
  readonly resource: ResourceId;
  readonly lockCell: string;
  readonly algorithm: 'tas' | 'cas_bounded';
  readonly owner: SyncSnapshotActor | null;
  /** Cyclic algorithm order, not PID sorting. */
  readonly contenders: readonly {
    readonly actor: SyncSnapshotActor;
    readonly waiting: boolean;
  }[];
  readonly handoff: SyncSnapshotActor | null;
};

/** TCB state owns the program counter; these are instruction-local operands. */
export type SyncSnapshotExecution = {
  readonly actor: SyncSnapshotActor;
  readonly scenario: string | null;
  readonly registers: readonly (readonly [string, number])[];
  /** Positive while useful item/read/think/eat work is in progress. */
  readonly remainingWork: number | null;
  readonly spin: {
    readonly resource: ResourceId;
    readonly elapsedTicks: number;
  } | null;
};

export type SyncSnapshotScenario =
  | {
      readonly kind: 'bounded_buffer';
      readonly id: string;
      readonly variant: 'correct' | 'wrong_order' | 'unbalanced';
      readonly capacity: number;
      readonly mutex: ResourceId;
      readonly empty: ResourceId;
      readonly full: ResourceId;
      readonly cell: string;
      readonly items: readonly number[];
      readonly produced: number;
      readonly consumed: number;
      readonly inFlight: number;
      /** Each reservation names its source counting-semaphore debit. */
      readonly reservations: readonly {
        readonly permitId: number;
        readonly actor: SyncSnapshotActor | null;
        readonly role: 'producer' | 'consumer';
        readonly itemApplied: boolean;
      }[];
      readonly actors: readonly {
        readonly actor: SyncSnapshotActor;
        readonly role: 'producer' | 'consumer';
        readonly targetItems: number;
        readonly workTicks: number;
        readonly completedItems: number;
      }[];
    }
  | {
      readonly kind: 'readers_writers';
      readonly id: string;
      readonly policy: 'reader_pref' | 'writer_pref' | 'fair';
      readonly cell: string;
      readonly bindings:
        | { readonly kind: 'semaphores'; readonly mutex: ResourceId; readonly rwMutex: ResourceId; readonly readCountCell: string }
        | { readonly kind: 'rwlock'; readonly rwlock: ResourceId };
      readonly actors: readonly {
        readonly actor: SyncSnapshotActor;
        readonly role: 'reader' | 'writer';
        readonly workTicks: number;
        readonly iterationLimit: number | null;
        readonly completedOperations: number;
        readonly waitStartedAt: Tick | null;
        readonly worstWait: number;
        readonly outcome: 'active' | 'completed' | 'starved' | 'cancelled';
      }[];
    }
  | {
      readonly kind: 'philosophers';
      readonly id: string;
      readonly solution: 'naive' | 'asymmetric' | 'room' | 'monitor';
      readonly rendezvous: ResourceId;
      readonly bindings:
        | { readonly kind: 'chopsticks'; readonly chopsticks: readonly [ResourceId, ResourceId, ResourceId, ResourceId, ResourceId]; readonly room: ResourceId | null }
        | { readonly kind: 'monitor'; readonly monitor: ResourceId; readonly conditions: readonly [string, string, string, string, string] };
      /** Exactly five records, in philosopher index order. */
      readonly actors: readonly {
        readonly actor: SyncSnapshotActor;
        readonly state: 'thinking' | 'hungry' | 'eating';
        readonly hungrySince: Tick | null;
        readonly meals: number;
        readonly worstWait: number;
      }[];
    }
  | {
      readonly kind: 'peterson';
      readonly id: string;
      readonly actors: readonly [SyncSnapshotActor, SyncSnapshotActor];
      readonly flagCells: readonly [string, string];
      readonly turnCell: string;
      readonly counterCell: string;
      readonly requirement: ResourceId;
      readonly fenced: boolean;
      readonly entries: readonly [number, number];
    }
  | {
      readonly kind: 'counter';
      readonly id: string;
      readonly cell: string;
      readonly protection:
        | { readonly kind: 'unprotected' | 'cas' }
        | { readonly kind: 'mutex'; readonly mutex: ResourceId };
      readonly actors: readonly {
        readonly actor: SyncSnapshotActor;
        readonly increments: number;
        readonly incrementBy: number;
        readonly completedIncrements: number;
      }[];
    }
  | {
      readonly kind: 'spinlock';
      readonly id: string;
      /** References the atomic lock record, including its ordered roster. */
      readonly resource: ResourceId;
      readonly criticalTicks: number;
      readonly remainderTicks: number;
      readonly iterationLimit: number | null;
      readonly actors: readonly {
        readonly actor: SyncSnapshotActor;
        readonly completedEntries: number;
      }[];
    }
  | {
      readonly kind: 'monitor_predicate';
      readonly id: string;
      readonly check: 'while' | 'if';
      readonly monitor: ResourceId;
      readonly condition: string;
      readonly predicateCell: string;
      readonly actors: readonly {
        readonly actor: SyncSnapshotActor;
        readonly role: 'waiter' | 'signaller' | 'barger';
      }[];
      readonly successfulEntries: number;
      readonly falsePredicateEntries: number;
    };

/** Persistent scheduler state. Distinct from the per-tick SchedulerSnapshot view. */
export interface SchedulerSnapshotState {
  readonly owner: 'scheduler';
  readonly version: 2;
  readonly payload: {
    readonly policy: SchedulerPolicySnapshotState;
    readonly accounting: {
      readonly busyTicks: number;
      readonly firstRuns: readonly (readonly [Pid, Tick])[];
      readonly completed: readonly {
        readonly pid: Pid;
        readonly arrivalTick: Tick;
        readonly firstRunTick: Tick;
        readonly turnaround: number;
        readonly totalService: number;
      }[];
    };
    readonly runtime: {
      readonly tick: Tick;
      readonly readyQueue: readonly Pid[];
      readonly running: Pid | null;
      readonly lastCpuOwner: Pid | null;
      readonly sliceElapsed: number;
      readonly switchDebt: number;
      readonly contextSwitches: number;
      readonly params: SchedulerSnapshotParameters;
    };
  };
}

/** Explicit versioned values, rather than a mapped copy of a future contract. */
export type SchedulerSnapshotParameters = {
  readonly quantum: number;
  readonly levelQuanta?: readonly number[];
  readonly agingInterval: number;
  readonly starvationThreshold: number;
  readonly starvationFatalThreshold: number;
  readonly preemptive: boolean;
};

export type SchedulerPolicySnapshotBase = {
  readonly params: SchedulerSnapshotParameters;
  /** Head-to-tail order. Outer index is the MLFQ level. */
  readonly queues: readonly (readonly Pid[])[];
  readonly running: Pid | null;
  readonly quantumRemaining: number;
};

/** CPU count when the current logical slice began. Null means no active slice. */
export type SchedulerCpuSliceSnapshot = {
  readonly pid: Pid;
  readonly startCpu: number;
};

export type SchedulerPolicySnapshotState = SchedulerPolicySnapshotBase & (
  | {
      readonly policy: 'fcfs';
      readonly detail: readonly {
        readonly tick: Tick;
        readonly source: 'admit' | 'unblock';
      }[];
    }
  | {
      readonly policy: 'sjf' | 'srtf';
      readonly detail: {
        readonly useEstimatedBurst: boolean;
        readonly estimates: readonly {
          readonly pid: Pid;
          readonly estimate: number;
          readonly startCpu: number;
          readonly lastCpu: number;
          readonly lastRemaining: number;
        }[];
      };
    }
  | {
      readonly policy: 'priority';
      readonly detail: null;
    }
  | {
      readonly policy: 'priority_aging';
      readonly detail: {
        readonly lastAgingTick: Tick | null;
      };
    }
  | {
      readonly policy: 'rr';
      readonly detail: {
        readonly slice: SchedulerCpuSliceSnapshot | null;
      };
    }
  | {
      readonly policy: 'mlfq';
      readonly detail: {
        readonly accountingMode: 'per_slice' | 'cumulative';
        readonly lastAgingTick: Tick | null;
        readonly slice: SchedulerCpuSliceSnapshot | null;
        readonly processes: readonly {
          readonly pid: Pid;
          readonly level: number;
          readonly levelStartCpu: number;
          readonly demotions: number;
        }[];
      };
    }
);

/** WP-05 placement, frame, page-table and content metadata. Plain JSON only. */
export interface MemorySnapshotState {
  readonly owner: 'memory';
  readonly version: 1;
  readonly payload: MemorySnapshotPayload;
}
export type MemorySnapshotPayload = {
  readonly pageSize: number;
  readonly frames: {
    readonly totalFrames: number;
    readonly freePoolRetain: number;
    readonly frames: readonly { readonly [K in keyof Frame]: Frame[K] }[];
    readonly freeList: readonly FrameId[];
    readonly freePool: readonly FrameId[];
  };
  readonly pageTables: {
    readonly spaces: readonly {
      readonly space: AddressSpaceId;
      readonly entries: readonly { readonly [K in keyof PageTableEntry]: PageTableEntry[K] }[];
    }[];
  };
  readonly holes: {
    readonly totalBytes: number;
    readonly minBlock: number;
    readonly strategy: AllocationStrategy;
    readonly holes: readonly { readonly start: number; readonly size: number }[];
    readonly partitions: readonly { readonly pid: Pid; readonly base: number; readonly limit: number; readonly requested: number }[];
    readonly reserved: readonly { readonly start: number; readonly size: number }[];
  };
  readonly contents: readonly (readonly [FrameId, number])[];
  readonly nextContent: number;
  readonly requestedBytes: readonly (readonly [AddressSpaceId, number])[];
  readonly rations: 'generous' | 'standard' | 'lean' | 'starved';
  readonly allocationScheme: 'equal' | 'proportional';
  readonly replacementScope: 'local' | 'global';
};

/** WP-06 demand paging, replacement and control state. Plain JSON only. */
export interface VmSnapshotState {
  readonly owner: 'vm';
  readonly version: 2;
  readonly payload: {
    readonly tick: Tick;
    readonly tlbHitTicks: number;
    readonly tlbMissTicks: number;
    readonly tlb: {
      readonly version: 1;
      readonly entries: readonly {
        readonly space: AddressSpaceId;
        readonly page: PageId;
        readonly frame: FrameId;
        readonly valid: boolean;
        readonly lastUsedTick: Tick;
      }[];
    };
    readonly tlbHits: number;
    readonly tlbMisses: number;
    /** VM-disabled memory-only kernels retain the WP-05 admission behavior. */
    readonly enabled: boolean;
    readonly settings: VmSettingsSnapshot;
    readonly replacement: VmReplacementState;
    readonly demand: VmDemandState;
    readonly counters: {
      readonly pageFaults: number;
      readonly majorFaults: number;
      readonly evictions: number;
      readonly writeBacks: number;
      readonly faultsThisTick: number;
      readonly faultAccumulator: number;
      readonly lastMetricsTick: Tick | null;
    };
    readonly workingSets: {
      readonly preciseEstimates: boolean;
      readonly noiseDraws: number;
      /** Canonical PID order; each ring is stored oldest reference first. */
      readonly processes: readonly {
        readonly pid: Pid;
        readonly references: readonly PageId[];
        readonly noise: number;
        readonly nextNoiseTick: Tick;
      }[];
    };
    readonly thrashing: VmThrashingState;
    readonly controls: {
      readonly prefetchCredits: readonly (readonly [Pid, number])[];
      /** Persistent logical-reference remaps applied before translation/lookahead. */
      readonly localityRemaps: readonly {
        readonly pid: Pid;
        readonly pages: readonly (readonly [PageId, PageId])[];
      }[];
    };
    readonly pending: readonly {
      readonly key: string;
      readonly pid: Pid;
      readonly page: PageId;
      readonly write: boolean;
      readonly remaining: number;
      readonly lastAttemptTick: Tick;
    }[];
  };
}

/** Parameters that affect VM continuation; validated against the installed tuning. */
export type VmSettingsSnapshot = {
  readonly minorFaultTicks: number;
  readonly majorFaultTicks: number;
  readonly workingSetWindow: number;
  readonly faultRateWindow: number;
  readonly lfuAging: number;
  readonly thrashingThreshold: number;
  readonly thrashingCriticalFaultMultiplier: number;
  readonly thrashingCriticalDemandRatio: number;
  readonly thrashingSuspendInterval: number;
  readonly thrashingSuspendDuration: number;
  readonly thrashingRecoveryTicks: number;
  readonly thrashingControl: 'working_set' | 'pff';
  readonly pffUpperBound: number;
  readonly pffLowerBound: number;
};

/** Frame/PTE timestamps, LFU counts and reference bits remain in the memory slot. */
export type VmReplacementState = {
  readonly policy: PageReplacementId;
  readonly order: readonly FrameId[];
  readonly nextIndex: number;
  readonly handIndex: number | null;
  readonly lastAgingTick: Tick | null;
};

export type VmDemandState = {
  readonly nextRequestId: number;
  /** Queue order resolves simultaneous completions without consulting a Map. */
  readonly requests: readonly {
    readonly id: number;
    readonly kind: 'major' | 'cow';
    readonly pid: Pid;
    readonly space: AddressSpaceId;
    readonly page: PageId;
    readonly write: boolean;
    readonly faultTick: Tick;
    readonly phase: 'queued' | 'write_back' | 'read' | 'copy';
    readonly dueTick: Tick | null;
    readonly frame: FrameId | null;
    readonly sourceFrame: FrameId | null;
    readonly victim: {
      readonly space: AddressSpaceId;
      readonly page: PageId;
      readonly dirty: boolean;
      readonly policy: PageReplacementId;
    } | null;
  }[];
  /** One logical reference across faults and instruction retries, keyed by thread. */
  readonly references: readonly {
    readonly key: string;
    readonly pid: Pid;
    readonly space: AddressSpaceId;
    readonly page: PageId;
    readonly write: boolean;
    readonly requestId: number | null;
    readonly fault: 'none' | 'minor' | 'major';
    readonly loaded: boolean;
  }[];
  /** Accounting markers only; backing mappings remain owned by the IPC slot. */
  readonly sharedTouches: readonly {
    readonly pid: Pid;
    readonly space: AddressSpaceId;
    readonly page: PageId;
  }[];
};

export type VmThrashingState = {
  readonly severity: 'healthy' | 'warning' | 'critical';
  readonly healthyTicks: number;
  readonly nextSuspendTick: Tick;
  readonly nextResumeTick: Tick;
  readonly degreeOfMultiprogramming: number;
  /** Canonical PID order; per-thread prior waits survive whole-process suspension. */
  readonly suspended: readonly {
    readonly pid: Pid;
    readonly suspendedAt: Tick;
    readonly untilTick: Tick;
    readonly previousState: 'ready' | 'running' | 'waiting';
    readonly previousBlockedOn: BlockReason | null;
    readonly threads: readonly {
      readonly tid: Tid;
      readonly state: 'ready' | 'running' | 'waiting' | 'terminated';
      readonly blockedOn: BlockReason | null;
    }[];
  }[];
  readonly pff: readonly {
    readonly pid: Pid;
    readonly frameBudget: number;
    readonly faultTicks: readonly (readonly [Tick, number])[];
    readonly nextAdjustmentTick: Tick;
  }[];
};

/**
 * Compile-time proof that every SubsystemId has a slot above. Amendment 1 shipped
 * six slots for ten subsystems, and nothing caught it until WP-03 needed the
 * seventh. This makes the next omission a type error instead of an escalation.
 */
type _EverySubsystemHasASlot = SubsystemId extends keyof SubsystemSnapshots ? true : never;
const _subsystemSlotCheck: _EverySubsystemHasASlot = true;
void _subsystemSlotCheck;

/**
 * A subsystem's own serialisable state, opaque to everything except that
 * subsystem. The owner validates its payload on restore and throws rather than
 * accepting a version it does not understand, because a silently misread save is
 * worse than a refused one.
 */
export interface SubsystemEnvelope {
  readonly owner: SubsystemId;
  /** Bumped by the owning subsystem whenever its payload shape changes. */
  readonly version: number;
  readonly payload: JsonValue;
}

/** Structurally cloneable JSON. Envelopes may not carry functions or class instances. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * The process subsystem's snapshot contribution (Ch. 3 and 4).
 *
 * Every field here is state that a PCB array cannot carry, which is why a
 * shallow process snapshot was insufficient. Named rather than enveloped because
 * WP-11 has to reconstruct it exactly and a typed shape is what makes that
 * checkable at compile time.
 */
export interface ProcessSnapshotState {
  readonly version: 1;
  /** Executable descriptions, so a restored process can keep running. */
  readonly programs: readonly ProgramSnapshot[];
  /** Thread control blocks, including each thread's program counter. */
  readonly threads: readonly ThreadSnapshot[];
  /** Pre-acceleration service, which the accelerated figure cannot recover. */
  readonly rawWork: readonly (readonly [Pid, number])[];
  /** Many-to-many light-weight process bindings, by tid. */
  readonly lwpBindings: readonly (readonly [Tid, number])[];
  /** Allocators, so a restored kernel never reissues a live id. */
  readonly counters: IdCounters;
  /** Exit codes a parent has not yet collected through wait. */
  readonly pendingChildReturns: readonly (readonly [Pid, number])[];
  /** Copy-on-write reference counts per frame. Ch. 10.3. */
  readonly cowRefCounts: readonly (readonly [FrameId, number])[];
  /** Shared memory and message passing state. Ch. 3.5 and 3.6. */
  readonly ipc: IpcSnapshot;
  /** The immutable tuning object in force, since it changes computed service. */
  readonly tuning: JsonValue;
  /** CPU spent on context switches and copies, charged to no process. */
  readonly executionDebt: number;
}

export interface ProgramSnapshot {
  readonly pid: Pid;
  readonly name: string;
  /** Instruction stream, as the program's own serialisable description. */
  readonly instructions: JsonValue;
  readonly programCounter: number;
  readonly repeating: boolean;
  /** Ch. 10.4 scenarios that drive memory from a fixed reference string. */
  readonly referenceString: readonly PageId[] | null;
  readonly serialFraction: number;
}

export interface ThreadSnapshot {
  readonly tid: Tid;
  readonly pid: Pid;
  readonly programCounter: number;
  readonly state: ProcessState;
  readonly blockedOn: BlockReason | null;
}

export interface IdCounters {
  readonly nextPid: number;
  readonly nextTid: number;
  readonly nextAddressSpace: number;
}

export interface IpcSnapshot {
  /** Shared regions and the address spaces attached to each. */
  readonly sharedRegions: readonly {
    readonly id: string;
    readonly frames: readonly FrameId[];
    readonly attached: readonly AddressSpaceId[];
    readonly value: number;
  }[];
  /** Message queues, in order, so delivery stays deterministic. */
  readonly mailboxes: readonly {
    readonly id: string;
    readonly capacity: number;
    readonly messages: readonly JsonValue[];
    readonly waiters: readonly Pid[];
  }[];
}

/* ------------------------------------------------------------------ */
/* Forward reference into the game layer                               */
/* ------------------------------------------------------------------ */

/** Declared here so a PCB can point at a named Program. Defined in @game/types. */
export type ConvoyMemberId =
  | 'lumen'
  | 'sable'
  | 'orrery'
  | 'kestrel'
  | 'vesper';
