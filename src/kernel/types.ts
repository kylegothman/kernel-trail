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
  readonly scheduler?: SubsystemEnvelope;
  readonly memory?: SubsystemEnvelope;
  /** Amendment 3. Demand paging state distinct from the frame table: the working
   *  set window, the replacement policy's own ordering, and the fault counters. */
  readonly vm?: SubsystemEnvelope;
  readonly sync?: SubsystemEnvelope;
  /** Amendment 3. Detection interval position and the wait-for graph edges that
   *  are not recoverable from the resource table alone. */
  readonly deadlock?: SubsystemEnvelope;
  readonly storage?: SubsystemEnvelope;
  /** Amendment 3. In-flight requests, interrupt queue, and DMA transfers. */
  readonly io?: SubsystemEnvelope;
  readonly fs?: SubsystemEnvelope;
  readonly security?: SubsystemEnvelope;
}

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
