/** KERNEL TRAIL: deterministic process engine and eleven-phase orchestrator. */
import { KernelEventBus, type EmittableEvent } from './EventBus';
import { createStreams, type StreamRegistry } from './rngStreams';
import { createScheduler, configureSchedulerWorkload, isMetricsAware, isRunningAware, saveSchedulerEnvelope, prepareSchedulerRestore } from './scheduler/SchedulerRegistry';
import { saveSchedulerParams } from './scheduler/SchedulerBase';
import { createSchedulerHooks } from './scheduler/starvation';
import { SchedulingAccounting } from './scheduler/metrics';
import { KernelInvariantError } from './errors';
import { DEFAULT_TUNING, resolveTuning, validateConfig, type KernelTuning } from './config';
import { ProcessTable } from './process/ProcessTable';
import { transition, type TransitionOptions } from './process/transitions';
import { ProcessLifecycle, type CowCapacity } from './process/lifecycle';
import { ThreadManager, type ThreadControlBlock } from './process/threads';
import { generatedProgram, scriptedProgram, instructionProgram, type Program, type ProgramSpec, type Instruction } from './process/Program';
import { IpcManager } from './process/ipc';
import { MemorySubsystem } from './memory/MemorySubsystem';
import { SyncSubsystem } from './sync/SyncSubsystem';
import { DeadlockSubsystem, deadlockSettings, decodeResourceVector, type DeadlockStrategy } from './deadlock/DeadlockSubsystem';
import { StorageSubsystem } from './storage/StorageSubsystem';
import { IoSubsystem } from './io/IoSubsystem';
import { FileSystemSubsystem } from './fs/FileSystemSubsystem';
import { SecuritySubsystem, inodeObject } from './security/SecuritySubsystem';
import type { ResourceDeclaration, ResourceVector } from './deadlock/resources';
import type { SuspendedProcess } from './memory/demandPaging';
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
  SubsystemId, SchedulerSnapshotState, SubsystemSnapshots,
  SyncPrimitive,
  SyscallRequest,
  SyscallResult,
  Tick,
  Tid, BlockReason, DomainId, FileDescriptor, DeviceId, AccessRight, Unsubscribe,
} from './types';
import { asTick, asPid, asPageId } from './types';

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

export const MAX_PRIORITY = 39;
export interface KernelOptions extends Partial<KernelTuning> {
  readonly devBuild?: boolean;
  readonly invariantSlowInterval?: number;
}
export interface SpawnOptions {
  readonly program?: Program;
  readonly parent?: Pid;
  readonly serialFraction?: number;
  readonly threadCount?: number;
}
export class InvariantViolation extends KernelInvariantError {
  constructor(invariant: number, message: string, readonly tick: number) {
    super(invariant, `I-${invariant} violated at tick ${tick}: ${message}`);
    this.name = 'InvariantViolation';
  }
}
export interface TlbEntry {
  readonly space: AddressSpaceId;
  readonly page: PageId;
  readonly frame: FrameId;
  valid: boolean;
  lastUsedTick: Tick;
}

export interface MemoryHooks {
  expireTimers(tick: Tick): void;
  admit(pcb: ProcessControlBlock): void;
  access(pid: Pid, page: PageId, write: boolean): { readonly hit: boolean };
  isSatisfied(pid: Pid, reason: BlockReason): boolean;
  allocateFrame(space: AddressSpaceId, page: PageId): FrameId | null;
  freeFrame(frame: FrameId): void;
  copyFrame(from: FrameId, to: FrameId): void;
  prepareCow(pid: Pid, page: PageId, source: FrameId): CowCapacity;
}
export interface SyncHooks {
  expireTimers(tick: Tick): void;
  isSatisfied(pid: Pid, reason: BlockReason, tid?: Tid): boolean;
  acquire(pid: Pid, resource: ResourceId): void;
  release(pid: Pid, resource: ResourceId): void;
  releaseAll(pcb: ProcessControlBlock): void;
  removeWaiter(pid: Pid): void;
}
export interface IoHooks {
  expireTimers(tick: Tick): void;
  serviceCompletions(tick: Tick): void;
  deliverInterrupts(tick: Tick): void;
  isSatisfied(pid: Pid, reason: BlockReason): boolean;
  request(pid: Pid, device: DeviceId): void;
  removeWaiter(pid: Pid): void;
}
export interface StorageHooks { expireTimers(tick: Tick): void }
export interface FsHooks {
  expireTimers(tick: Tick): void;
  retainDescriptor(fd: FileDescriptor): void;
  closeDescriptor(pcb: ProcessControlBlock, fd: FileDescriptor): void;
  closeOnExec(pcb: ProcessControlBlock, fd: FileDescriptor): boolean;
  ownsWait(pid: Pid, tid: Tid, reason: BlockReason): boolean;
  isSatisfied(pid: Pid, tid: Tid): boolean;
  instructionOutcome(actor: { readonly pid: Pid; readonly tid: Tid }): { readonly advance: boolean; readonly deferService: boolean } | null;
  removeProcess(pid: Pid): void;
}
export interface SecurityHooks { rights(pid: Pid, resource: ResourceId): readonly AccessRight[] }
export interface DeadlockHooks { maybeDetect(tick: Tick): void }
// SchedulerPolicy has no aging member. Keep this hook separate from the contract.
export interface SchedulerHooks { ageAndDetectStarvation(ctx: SchedulerContext): void }
export interface MetricsHooks {
  scheduler(tick: Tick): SchedulingMetrics;
  memory(tick: Tick): MemoryMetrics;
}
export interface InvariantHooks { check(kernel: KernelImpl): void }
export interface SnapshotHooks {
  saveState(): Partial<SubsystemSnapshots>;
  /** Validate first and return the commit, so one invalid contribution changes nothing. */
  restoreState(snapshot: KernelSnapshot): () => void;
}
export interface KernelHooks {
  snapshots?: SnapshotHooks;
  memory: Partial<MemoryHooks>; sync: Partial<SyncHooks>; io: Partial<IoHooks>;
  storage: Partial<StorageHooks>; fs: Partial<FsHooks>; security: Partial<SecurityHooks>;
  deadlock: Partial<DeadlockHooks>; scheduler: Partial<SchedulerHooks>; metrics: Partial<MetricsHooks>; invariants: InvariantHooks;
}
const noop = (): void => {};

export class KernelImpl implements Kernel {
  private currentConfig: Readonly<KernelConfig>;
  get config(): Readonly<KernelConfig> { return this.currentConfig; }
  readonly tuning: KernelTuning;
  readonly events = new KernelEventBus();
  readonly table = new ProcessTable();
  readonly threads: ThreadManager;
  readonly lifecycle: ProcessLifecycle;
  readonly ipc: IpcManager;
  readonly memorySubsystem: MemorySubsystem;
  readonly syncSubsystem: SyncSubsystem;
  readonly deadlockSubsystem: DeadlockSubsystem;
  readonly storageSubsystem: StorageSubsystem;
  readonly ioSubsystem: IoSubsystem;
  readonly fileSystemSubsystem: FileSystemSubsystem;
  readonly securitySubsystem: SecuritySubsystem;
  private readonly snapshotHooks: SnapshotHooks[] = [];
  readonly pageTables = new Map<AddressSpaceId, PageTableEntry[]>();
  private currentTick = asTick(0);
  private readonly rng: StreamRegistry;
  private enabled: ReadonlySet<SubsystemId>;
  private hooksInstalled = false;
  private requestedScheduler: SchedulerId;
  private readonly programs = new Map<Pid, Program>();
  private readonly namedPrograms = new Map<string, Program>();
  private readonly burstSizes = new Map<Pid, number>();
  private readonly syscallResults = new Map<Pid, SyscallResult>();
  private readonly wakeable = new Set<Pid>();
  private readonly probes = new Set<(phase: number, tick: Tick) => void>();
  private readonly admittedThisTick = new Set<Pid>();
  private nextSpace = 2;
  private running: Pid | null = null;
  private readonly readyQueue: Pid[] = [];
  private lastCpuOwner: Pid | null = null;
  private executingThread: Tid | undefined;
  private sliceElapsed = 0;
  private switchDebt = 0;
  private readonly copyDebt = new Map<Pid, number>();
  private scheduler: SchedulerPolicy;
  private schedulerParams: SchedulerParams;
  private contextSwitches = 0;
  private frames: Frame[] = [];
  private freeList: FrameId[] = [];
  private tlb: readonly Readonly<TlbEntry>[] = [];
  private syncPrimitives: SyncPrimitive[] = [];
  private resources: ResourceType[] = [];
  private diskQueue: DiskRequest[] = [];
  private diskHead: DiskHead;
  private devices: Device[] = [];
  private inodes: Inode[] = [];
  private journal: JournalEntry[] = [];
  private domains: ProtectionDomain[] = [];
  private schedulingMetrics: SchedulingMetrics = EMPTY_SCHEDULING_METRICS;
  private memoryMetrics: MemoryMetrics = EMPTY_MEMORY_METRICS;
  private readonly invariantSlowInterval: number;
  private readonly devBuild: boolean;

  private memory: MemoryHooks;
  private sync: SyncHooks = { expireTimers: noop, isSatisfied: () => false,
    acquire: noop, release: noop, releaseAll: noop, removeWaiter: noop };
  private io: IoHooks = { expireTimers: noop, serviceCompletions: noop, deliverInterrupts: noop,
    isSatisfied: () => false, request: noop, removeWaiter: noop };
  private storage: StorageHooks = { expireTimers: noop };
  private fs: FsHooks = { expireTimers: noop, retainDescriptor: noop, closeDescriptor: noop, closeOnExec: () => false,
    ownsWait: () => false, isSatisfied: () => false, instructionOutcome: () => null, removeProcess: noop };
  private security: SecurityHooks = { rights: () => [] };
  private deadlock: DeadlockHooks = { maybeDetect: noop };
  private schedulerHooks: SchedulerHooks = createSchedulerHooks(() => this.scheduler, {
    emit: event => this.syncSubsystem.withEffectivePriorities(() => this.publish(event)),
    terminate: pcb => {
      this.schedulingAccounting.complete(pcb, asTick(this.tick - 1));
      this.lifecycle.exit(pcb, -1, 'starvation');
    },
  });
  private readonly schedulingAccounting = new SchedulingAccounting();
  private metricsHooks: MetricsHooks = {
    scheduler: tick => this.schedulingAccounting.recompute(tick, this.processes, this.contextSwitches, this.scheduler),
    memory: () => this.memorySubsystem.metrics(),
  };
  // TODO(astra): WP-11 extends the existing invariant harness to the full set.
  private invariants: InvariantHooks = { check: kernel => kernel.checkInvariants() };

  constructor(config: KernelConfig, options: KernelOptions = {}) {
    validateConfig(config);
    this.currentConfig = cloneConfig(config);
    this.requestedScheduler = config.scheduler;
    this.tuning = resolveTuning({ ...options, checkInvariants: options.checkInvariants ?? options.devBuild ?? true });
    this.invariantSlowInterval = options.invariantSlowInterval ?? 50;
    this.devBuild = options.devBuild ?? options.checkInvariants ?? true;
    this.enabled = new Set(config.enabledSubsystems);
    this.rng = createStreams(config.seed);
    this.schedulerParams = { ...config.schedulerParams };
    this.scheduler = this.makeScheduler(config.scheduler);
    this.diskHead = { cylinder: 0, direction: 'up', totalCylinders: config.totalCylinders };
    const vmRng = this.rng.streams.get('vm');
    if (vmRng === undefined) throw new Error('vm RNG stream missing');
    this.memorySubsystem = new MemorySubsystem(this.config, {
      rng: vmRng,
      tick: () => this.tick, process: pid => this.process(pid), processes: () => this.processes,
      pageTables: this.pageTables, emit: event => this.publish(event),
      refreshSharedMappings: () => this.ipc.refreshSharedMappings(),
      sharedMapping: (pid, page) => this.ipc.sharedMapping(pid, page),
      onEvicted: frame => this.lifecycle.forgetEvictedFrame(frame),
      refuseOptimal: () => {
        this.setReplacementPolicy('fifo');
        if (this.devBuild) this.publish({ type: 'kernel.panic', message: 'OPT requires a scripted workload; using FIFO' });
      },
      terminate: (pid, reason) => { const pcb = this.table.get(pid); if (pcb !== undefined) this.exitProcess(pcb, 1, reason); },
      suspend: (pid, tick, until) => this.suspendMemoryProcess(pid, tick, until),
      resume: record => this.resumeMemoryProcess(record),
      futureReferences: pid => {
        if (!this.allProgramsScripted()) return null;
        const pcb = this.table.get(pid); const program = this.programs.get(pid);
        if (pcb === undefined || program === undefined || program.referenceString === null) return null;
        const result: PageId[] = [];
        for (let pc = this.threadPc(pcb) + 1; pc < program.length; pc++) {
          const instruction = program.at(pc); if (instruction.kind === 'access') result.push(instruction.page);
        }
        return result;
      },
      accessKey: pid => this.executingThread === undefined ? undefined : `${pid}:${this.executingThread}`,
      releaseAddressSpace: space => {
        const pcb = this.table.filterAscending(process => process.addressSpaceId === space)[0];
        if (pcb !== undefined) this.lifecycle.releaseAddressSpace(pcb);
      },
    }, { tuning: this.tuning });
    const memory = this.memorySubsystem;
    this.events.onAny(event => memory.observeEvent(event));
    this.memory = { expireTimers: tick => memory.expireTimers(tick), admit: pcb => memory.admit(pcb),
      access: (pid, page, write) => memory.access(pid, page, write), isSatisfied: (pid, reason) => memory.isSatisfied(pid, reason),
      allocateFrame: (space, page) => memory.allocateFrame(space, page), freeFrame: frame => memory.freeFrame(frame),
      copyFrame: (from, to) => memory.copyFrame(from, to),
      prepareCow: (pid, page, source) => memory.prepareCow(pid, page, source) };
    this.snapshotHooks.push({ saveState: () => memory.saveState(), restoreState: snapshot => memory.prepareKernelRestore(snapshot) });
    this.threads = new ThreadManager({ model: this.tuning.threadModel,
      coreCount: this.tuning.coreCount, lwpPoolSize: this.tuning.lwpPoolSize,
      maxThreadsPerProcess: this.tuning.maxThreadsPerProcess, threadCreateTicks: this.tuning.threadCreateTicks },
    this.table.raw, event => this.publish(event), pcb => { this.lifecycle.exit(pcb, 0); });
    this.lifecycle = new ProcessLifecycle({
      table: this.table, maxProcesses: this.tuning.maxProcesses, cowCopyTicks: this.tuning.cowCopyTicks,
      tick: () => this.tick, emit: event => this.publish(event),
      onTransition: (pcb, to, opts) => {
        if (to === 'waiting' && opts?.blockReason !== undefined) this.blockProcess(pcb.pid, opts.blockReason);
        else this.move(pcb, to, opts);
      },
      nextAddressSpace: () => this.nextSpace++ as AddressSpaceId,
      createInitialThread: (pcb, parent) => {
        const pc = parent === undefined ? 0 : this.threadPc(parent) + (this.executingThread === undefined ? 0 : 1);
        this.threads.attach(pcb, { programCounter: pc });
      },
      clearThreads: pcb => this.threads.clear(pcb),
      programNamed: name => this.namedPrograms.get(name),
      detachIpc: pcb => { this.deadlockSubsystem.exec(pcb, this.enabled.has('deadlock')); this.syncSubsystem.exec(pcb.pid); this.io.removeWaiter(pcb.pid); this.storageSubsystem.removeWaiter(pcb.pid); this.ipc.removeProcess(pcb.pid); this.memorySubsystem.detachAddressSpace(pcb.addressSpaceId); },
      replaceProgram: (pcb, program) => {
        this.programs.set(pcb.pid, program);
        this.burstSizes.set(pcb.pid, program.length);
        this.threads.clear(pcb);
        pcb.serviceRemaining = program.length;
        this.threads.attach(pcb);
      },
      copyProgram: (parent, child) => {
        const program = this.programs.get(parent.pid);
        if (program !== undefined) this.programs.set(child.pid, program);
        this.burstSizes.set(child.pid, this.burstSizes.get(parent.pid) ?? parent.cpuBurstRemaining);
        if (this.enabled.has('fs')) this.fileSystemSubsystem.fork(parent, child);
        if (this.enabled.has('security')) this.securitySubsystem.fork(parent, child);
      },
      retainDescriptor: fd => this.fs.retainDescriptor(fd),
      closeDescriptor: (pcb, fd) => this.fs.closeDescriptor(pcb, fd),
      closeOnExec: (pcb, fd) => this.fs.closeOnExec(pcb, fd),
      releaseResources: pcb => { this.deadlockSubsystem.releaseResources(pcb, this.enabled.has('deadlock')); this.sync.releaseAll(pcb); },
      removeFromWaitQueues: pcb => { this.deadlockSubsystem.removeWaiter(pcb.pid); this.sync.removeWaiter(pcb.pid); this.io.removeWaiter(pcb.pid); this.storageSubsystem.removeWaiter(pcb.pid); this.ipc.removeProcess(pcb.pid); this.memorySubsystem.detachAddressSpace(pcb.addressSpaceId); },
      wakeParent: pid => { this.wakeable.add(pid); },
      chargeCowCopy: (pcb, ticks) => { this.copyDebt.set(pcb.pid, (this.copyDebt.get(pcb.pid) ?? 0) + ticks); },
      memory: { pageTables: this.pageTables,
        prepareCow: (pid, page, source) => this.memory.prepareCow(pid, page, source),
        allocateFrame: (space, page) => this.memory.allocateFrame(space, page),
        freeFrame: frame => this.memory.freeFrame(frame), copyFrame: (from, to) => this.memory.copyFrame(from, to) },
    });
    this.ipc = new IpcManager({ process: pid => this.table.get(pid),
      pageTable: space => { let table = this.pageTables.get(space); if (table === undefined) { table = []; this.pageTables.set(space, table); } return table; },
      frame: id => this.frames[id], rights: (pid, id) => this.security.rights(pid, id),
      block: (pid, reason) => this.blockProcess(pid, reason),
      onSharedMap: (pid, mapping) => { memory.sharedMapped(pid, mapping); this.securitySubsystem.sharedMapped(pid, mapping); },
      onSharedUnmap: (pid, mapping) => { memory.sharedUnmapped(pid, mapping); this.securitySubsystem.sharedUnmapped(pid, mapping); },
      onAccessDenied: (pid, resource, right) => this.securitySubsystem.mappingDenied(pid, resource, right),
    });
    const syncRng = this.rng.streams.get('sync');
    if (syncRng === undefined) throw new Error('sync RNG stream missing');
    this.syncSubsystem = new SyncSubsystem({
      tick: () => this.tick, process: pid => this.table.get(pid), processes: () => this.table.processes,
      originalWait: actor => this.memorySubsystem.pager.control.suspendedRecords.find(row => row.pid === actor.pid)?.threads.find(row => row.tid === actor.tid)?.blockedOn ?? undefined,
      thread: tid => this.threads.table.get(tid), actor: pid => {
        const pcb = this.table.get(pid); const tid = pcb === undefined ? undefined
          : this.executingThread !== undefined && pcb.threads.includes(this.executingThread) ? this.executingThread : pcb.threads[0];
        return tid === undefined ? undefined : { pid, tid };
      },
      block: (pid, reason, tid) => this.blockProcess(pid, reason, tid), emit: event => this.publish(event),
      terminate: pid => { const pcb = this.table.get(pid); if (pcb !== undefined) {
        this.schedulingAccounting.complete(pcb, asTick(this.tick - 1)); this.lifecycle.exit(pcb, -1, 'starvation');
      } },
      complete: pid => { const pcb = this.table.get(pid); if (pcb !== undefined) this.exitProcess(pcb, 0); },
      settings: () => ({ progressStallLimit: this.tuning.progressStallLimit, boundedWaitLimit: this.tuning.boundedWaitLimit,
        spinWaitTicks: this.tuning.spinWaitTicks, storeBufferDepth: this.tuning.storeBufferDepth,
        priorityInheritance: this.tuning.priorityInheritance, rwlockPolicy: this.tuning.rwlockPolicy,
        starvationThreshold: this.schedulerParams.starvationThreshold, starvationFatalThreshold: this.schedulerParams.starvationFatalThreshold }),
      cell: binding => {
        if (binding.kind === 'region') {
          const region = this.ipc.sharedRegion(binding.region);
          return region === undefined ? undefined : { get: () => region.value, set: value => { region.value = value; } };
        }
        const inode = this.inodes.find(item => item.id === binding.inode);
        if (inode === undefined || typeof Reflect.get(inode, binding.field) !== 'number') return undefined;
        return { get: () => { const value: unknown = Reflect.get(inode, binding.field);
          if (typeof value !== 'number') throw new Error('inode cell is not numeric'); return value; },
        set: value => { Reflect.set(inode, binding.field, value); } };
      },
    }, syncRng);
    const sync = this.syncSubsystem;
    this.sync = { expireTimers: tick => sync.expireTimers(tick), isSatisfied: (pid, reason, tid) => sync.isSatisfied(pid, reason, tid),
      acquire: (pid, resource) => sync.acquire(pid, resource), release: (pid, resource) => sync.release(pid, resource),
      releaseAll: pcb => sync.releaseAll(pcb), removeWaiter: pid => sync.removeWaiter(pid) };
    this.snapshotHooks.push({ saveState: () => sync.saveState(), restoreState: snapshot => sync.prepareKernelRestore(snapshot) });
    this.events.onAny(event => sync.observe(event));
    const schedulerHooks = this.schedulerHooks;
    this.schedulerHooks = { ageAndDetectStarvation: ctx => {
      sync.beforeAging(); try { schedulerHooks.ageAndDetectStarvation(ctx); } finally { sync.afterAging(); }
    } };
    this.deadlockSubsystem = new DeadlockSubsystem({
      tick: () => this.tick, strategy: () => this.config.deadlockStrategy, settings: () => deadlockSettings(this.tuning),
      processes: () => this.table.processes.filter(pcb => pcb.pid > 1), process: pid => this.table.get(pid),
      threads: () => [...this.threads.table.values()], actor: pid => {
        const pcb = this.table.get(pid); const tid = pcb === undefined ? undefined
          : this.executingThread !== undefined && pcb.threads.includes(this.executingThread) ? this.executingThread : pcb.threads[0];
        return tid === undefined ? undefined : { pid, tid };
      },
      program: pid => this.programs.get(pid), sync, ipc: this.ipc,
      block: (actor, resource) => this.blockProcess(actor.pid, { kind: 'semaphore', resource }, actor.tid),
      complete: pid => { this.syscallResults.set(pid, { ok: true, value: null }); },
      terminate: (pid, reason) => { const pcb = this.table.get(pid); if (pcb !== undefined) this.exitProcess(pcb, -1, reason); },
      rollback: checkpoint => {
        const pcb = this.table.get(checkpoint.pid); const thread = this.threads.table.get(checkpoint.tid);
        if (pcb === undefined || thread?.pid !== checkpoint.pid) throw new KernelInvariantError(26, 'rollback actor is missing');
        thread.programCounter = checkpoint.programCounter; this.threads.wake(pcb, thread.tid);
        if (pcb.state === 'waiting') this.move(pcb, 'ready');
      },
      emit: event => this.publish(event),
    });
    const deadlock = this.deadlockSubsystem;
    this.deadlock = { maybeDetect: tick => deadlock.maybeDetect(tick) };
    sync.installDeadlockHooks({ onDeclare: resource => deadlock.onSyncDeclare(resource),
      beforeAcquire: (actor, resource, operation) => deadlock.beforeAcquire(actor, resource, operation) });
    this.snapshotHooks.push({ saveState: () => deadlock.saveState(), restoreState: snapshot => deadlock.prepareKernelRestore(snapshot) });
    this.onPhase((phase, tick) => { if (this.enabled.has('deadlock')) deadlock.onPhase(phase, tick); });
    const storageRng = this.rng.streams.get('storage'); const ioRng = this.rng.streams.get('io');
    if (storageRng === undefined || ioRng === undefined) throw new Error('storage or I/O RNG stream missing');
    this.storageSubsystem = new StorageSubsystem({ tick: () => this.tick, enabled: () => this.enabled.has('storage'),
      emit: event => this.publish(event), rng: storageRng,
      isPagingBackingLive: (space, page) => this.pageTables.get(space)?.some(entry => entry.page === page) === true
        || this.frames.some(frame => frame.owner === space && frame.page === page)
        || this.table.processes.some(pcb => (this.pageTables.get(pcb.addressSpaceId) ?? []).some(entry => {
          const mapping = this.ipc.sharedMapping(pcb.pid, entry.page);
          return mapping?.backingSpace === space && mapping.backingPage === page;
        })),
    }, {
      totalCylinders: config.totalCylinders, policy: config.diskPolicy, nvmWriteBufferPages: this.tuning.nvmWriteBufferPages,
      settings: { diskStarvationThreshold: this.tuning.diskStarvationThreshold,
        rebuildBlocksPerTick: this.tuning.rebuildBlocksPerTick, rebuildProgressInterval: this.tuning.rebuildProgressInterval },
    });
    const storage = this.storageSubsystem;
    const ioActor = (pid: Pid) => {
      const pcb = this.table.get(pid); const tid = pcb === undefined ? undefined
        : this.executingThread !== undefined && pcb.threads.includes(this.executingThread) ? this.executingThread : pcb.threads[0];
      return tid === undefined ? undefined : { pid, tid };
    };
    this.ioSubsystem = new IoSubsystem({ tick: () => this.tick, enabled: () => this.enabled.has('io'),
      process: pid => this.table.get(pid), thread: tid => this.threads.table.get(tid), actor: ioActor,
      block: (actor, device) => this.blockProcess(actor.pid, { kind: 'io', device }, actor.tid),
      emit: event => this.publish(event), chargeKernelDebt: ticks => this.chargeKernelDebt(ticks),
      abortStorage: () => {
        for (const device of new Set([...storage.drives.keys(), ...storage.nvm.keys(), ...storage.raid.keys()])) storage.control(device as DeviceId, 'crash', []);
      },
      onRequestSubmitted: request => this.securitySubsystem?.onRequestSubmitted(request),
      onRequestRemoved: request => this.securitySubsystem?.onRequestRemoved(request),
      onRequestCompleted: (request, result) => this.securitySubsystem?.onRequestCompleted(request, result),
      terminate: (pid, reason) => { const pcb = this.table.get(pid); if (pcb !== undefined) this.exitProcess(pcb, -1, reason); },
      settings: () => ({ interruptServiceTicks: this.tuning.interruptServiceTicks, maxInterruptsPerTick: this.tuning.maxInterruptsPerTick,
        interruptStormThreshold: this.tuning.interruptStormThreshold, interruptStormWindow: this.tuning.interruptStormWindow,
        maxPendingInterrupts: this.tuning.maxPendingInterrupts, dmaCycleStealRatio: this.tuning.dmaCycleStealRatio,
        blockCacheEntries: this.tuning.blockCacheEntries }),
    }, ioRng, storage);
    const io = this.ioSubsystem;
    this.storage = { expireTimers: tick => storage.expireTimers(tick) };
    this.io = { expireTimers: tick => io.expireTimers(tick), serviceCompletions: tick => {
      if (this.enabled.has('storage')) storage.serviceCompletions(tick);
      if (this.enabled.has('io')) io.serviceCompletions(tick);
      if (this.enabled.has('memory') || this.enabled.has('vm')) this.memorySubsystem.pager.serviceStorageCompletions(tick);
    }, deliverInterrupts: tick => io.deliverInterrupts(tick), request: (pid, device) => io.request(pid, device),
    removeWaiter: pid => io.removeWaiter(pid), isSatisfied: (pid, reason) => {
      const pcb = this.table.get(pid);
      const matches = pcb?.threads.map(tid => this.threads.table.get(tid)).filter(thread => thread?.state === 'waiting' && thread.blockedOn === reason) ?? [];
      return matches.length === 1 && io.isSatisfied(pid, matches[0]!.tid, reason);
    } };
    let ownerBeforeScheduling = this.lastCpuOwner;
    this.onPhase((phase, tick) => {
      if (!this.enabled.has('io')) return;
      if (phase === 1) this.io.expireTimers(tick);
      if (phase === 7) ownerBeforeScheduling = this.lastCpuOwner;
      if (phase === 8 && io.debt > 0) {
        if (this.lastCpuOwner !== ownerBeforeScheduling) this.chargeKernelDebt(io.debt);
        // The unchanged phase 8 consumes debt only when a user process is selected.
        if (!this.enabled.has('process') || this.running === null) this.switchDebt -= 1;
        io.consumeDebtTick();
      }
    });
    this.installHooks({ snapshots: { saveState: () => ({ storage: storage.saveState(), ...io.saveState() }), restoreState: snapshot => {
      const commitStorage = storage.prepareKernelRestore(snapshot);
      const commitIo = io.prepareKernelRestore(snapshot);
      const ioDebt = snapshot.subsystems?.io?.payload.kernelDebt ?? 0;
      const combinedDebt = snapshot.subsystems?.scheduler?.payload.runtime.switchDebt ?? 0;
      if (ioDebt < 0 || ioDebt > combinedDebt) throw new Error('I/O debt exceeds combined kernel debt');
      return () => { commitStorage(); commitIo(); this.bindPagingStorage(true); };
    } } });
    const securityRng = this.rng.streams.get('security');
    if (securityRng === undefined) throw new Error('security RNG stream missing');
    this.securitySubsystem = new SecuritySubsystem({ tick: () => this.tick, enabled: () => this.enabled.has('security'),
      process: pid => this.table.get(pid), processes: () => this.table.processes, pages: space => this.pageTables.get(space) ?? [],
      pageSize: () => this.config.pageSize, actor: ioActor, emit: event => this.publish(event),
      terminate: (pid, reason) => { const pcb = this.table.get(pid); if (pcb !== undefined) this.exitProcess(pcb, -1, reason); },
      publishResult: (pid, result) => { this.syscallResults.set(pid, result); },
      registerProgram: (name, program) => this.registerProgram(name, program), io, ipc: this.ipc, fs: () => this.fileSystemSubsystem,
    }, securityRng, this.tuning.accessModel);
    const security = this.securitySubsystem;
    this.security = { rights: (pid, resource) => security.rights(pid, resource) };
    this.fileSystemSubsystem = new FileSystemSubsystem({ tick: () => this.tick, enabled: () => this.enabled.has('fs'),
      process: pid => this.table.get(pid), actor: ioActor, domain: pid => this.enabled.has('security') ? security.callerDomain(pid) : this.table.get(pid)?.domain ?? 'kernel' as DomainId,
      block: (actor, device) => { if (this.table.get(actor.pid)?.state === 'running') this.blockProcess(actor.pid, { kind: 'io', device }, actor.tid); },
      publishResult: (pid, result, request) => {
        this.syscallResults.set(pid, result);
        if (request !== undefined) this.publish({ type: 'syscall.invoked', request, result });
        if (!result.ok && result.message.startsWith('storage_corruption:')) {
          const pcb = this.table.get(pid); if (pcb !== undefined) this.exitProcess(pcb, -1, 'storage_corruption');
        }
        if (result.ok && this.enabled.has('security')) {
          const actor = ioActor(pid), operation = actor === undefined ? undefined : this.fileSystemSubsystem.pending(actor);
          if (operation?.inode !== null && operation?.inode !== undefined) {
            const rights: AccessRight[] = operation.call.name === 'open' ? operation.call.mode === 'rw' ? ['read', 'write']
              : [operation.call.mode === 'r' ? 'read' : 'write'] : operation.call.name === 'read' || operation.call.name === 'write' ? [operation.call.name] : [];
            for (const right of rights) security.use(pid, inodeObject(operation.inode), right);
          }
        }
      }, emit: event => this.publish(event), check: (domain, inode, right) => security.checkFile(domain, inode, right),
      inodeCreated: inode => security.inodeCreated(inode), storage, io,
    }, { defaultAllocation: this.config.fileAllocation, maxSymlinkDepth: this.tuning.maxSymlinkDepth,
      dentryCacheEntries: this.tuning.dentryCacheEntries, fragmentationWarnExtents: this.tuning.fragmentationWarnExtents,
      freeSpaceMethod: this.tuning.freeSpaceMethod, linkedVariant: this.tuning.linkedVariant, journalMode: this.config.journalingEnabled ? this.tuning.journalMode : 'off' });
    const fs = this.fileSystemSubsystem;
    this.fs = { expireTimers: tick => fs.expireTimers(tick), retainDescriptor: fd => fs.retainDescriptor(fd),
      closeDescriptor: (pcb, fd) => fs.closeDescriptor(pcb, fd), closeOnExec: (pcb, fd) => fs.closeOnExec(pcb, fd),
      ownsWait: (pid, tid, reason) => fs.ownsWait(pid, tid, reason), isSatisfied: (pid, tid) => fs.isSatisfied(pid, tid),
      instructionOutcome: actor => fs.instructionOutcome(actor), removeProcess: pid => fs.removeProcess(pid) };
    io.registerControl((device, command, args, actor) => security.control(device, command, args, actor));
    this.events.onAny(event => { security.observe(event); if (event.type === 'process.exited' && this.enabled.has('fs')) fs.removeProcess(event.pid); });
    this.onPhase(phase => security.onPhase(phase));
    this.snapshotHooks.push({ saveState: () => ({ ...(this.enabled.has('fs') ? { fs: fs.saveState() } : {}),
      ...(this.enabled.has('security') ? { security: security.saveState() } : {}) }), restoreState: snapshot => {
      const restoreFs = snapshot.config.enabledSubsystems.includes('fs') ? fs.prepareKernelRestore(snapshot) : noop;
      const restoreSecurity = snapshot.config.enabledSubsystems.includes('security') ? security.prepareKernelRestore(snapshot) : noop;
      return () => { restoreFs(); restoreSecurity(); };
    } });
    const invariants = this.invariants;
    this.invariants = { check: kernel => { invariants.check(kernel); deadlock.assertInvariants();
      if (this.enabled.has('storage')) storage.assertInvariants();
      if (this.enabled.has('fs')) fs.checkInvariants(this.tick % this.invariantSlowInterval === 0);
      if (this.enabled.has('security')) security.assertInvariants();
      if (this.enabled.has('io')) { io.assertInvariants(); this.assert(io.debt >= 0 && io.debt <= this.switchDebt, 33, 'I/O debt exceeds combined kernel debt'); }
    } };
    this.initialiseFrameTable();
    this.initialiseSystemProcesses();
  }

  get tick(): Tick { return this.currentTick; }
  get processes(): readonly Readonly<ProcessControlBlock>[] { return this.table.processes; }
  process(pid: Pid): Readonly<ProcessControlBlock> | undefined { return this.table.get(pid); }
  get activeReplacementPolicy(): PageReplacementId { return this.config.replacementPolicy; }
  get activeAllocationStrategy(): AllocationStrategy { return this.config.allocationStrategy; }
  get activeDiskPolicy(): DiskSchedulingId { return this.storageSubsystem.activePolicy; }
  get invariantInterval(): number { return this.invariantSlowInterval; }
  frame(id: FrameId): Frame | undefined { return this.frames[id]; }
  program(pid: Pid): Program | undefined { return this.programs.get(pid); }
  allProgramsScripted(): boolean {
    return this.table.filterAscending(pcb => pcb.pid > 1 && (pcb.state === 'ready' || pcb.state === 'running'))
      .every(pcb => { const refs = this.programs.get(pcb.pid)?.referenceString; return refs !== null && refs !== undefined; });
  }
  lastSyscallResult(pid: Pid): SyscallResult | undefined { return this.syscallResults.get(pid); }
  registerProgram(name: string, program: Program): void { this.namedPrograms.set(name, program); }
  onPhase(probe: (phase: number, tick: Tick) => void): Unsubscribe {
    this.probes.add(probe); return () => { this.probes.delete(probe); };
  }
  installHooks(hooks: Partial<KernelHooks>): void {
    this.hooksInstalled ||= Object.keys(hooks).some(key => key !== 'snapshots');
    if (hooks.snapshots !== undefined) this.snapshotHooks.push(hooks.snapshots);
    this.memory = { ...this.memory, ...hooks.memory }; this.sync = { ...this.sync, ...hooks.sync };
    this.io = { ...this.io, ...hooks.io }; this.storage = { ...this.storage, ...hooks.storage };
    this.fs = { ...this.fs, ...hooks.fs }; this.security = { ...this.security, ...hooks.security };
    this.deadlock = { ...this.deadlock, ...hooks.deadlock };
    this.schedulerHooks = { ...this.schedulerHooks, ...hooks.scheduler };
    this.metricsHooks = { ...this.metricsHooks, ...hooks.metrics };
    if (hooks.invariants !== undefined) this.invariants = hooks.invariants;
  }

  spawn(spec: ProgramSpec, options: SpawnOptions = {}): Pid {
    if (this.table.activeCount >= this.tuning.maxProcesses) throw new RangeError('process table is full');
    for (const [name, value] of Object.entries({ burst: spec.burst, service: spec.service, arrival: spec.arrival, pages: spec.pages, priority: spec.priority })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid process ${name}`);
    }
    if (spec.burst < 1 || spec.service < 1 || spec.priority > 39) throw new RangeError('invalid process work or priority');
    const count = options.threadCount ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > this.tuning.maxThreadsPerProcess) throw new RangeError('invalid thread count');
    const serial = options.serialFraction ?? this.tuning.defaultSerialFraction;
    if (!(serial >= 0 && serial <= 1)) throw new RangeError('invalid serial fraction');
    const parent = options.parent ?? asPid(1);
    if (this.table.get(parent) === undefined) throw new RangeError('unknown parent');
    const pid = this.table.allocatePid();
    const pcb = this.table.insert({ ...this.basePcb(pid, parent, spec.name), state: 'new', readySince: null,
      priority: spec.priority, basePriority: spec.priority, arrivalTick: asTick(spec.arrival),
      cpuBurstRemaining: spec.burst, serviceRemaining: spec.service, addressSpaceId: this.nextSpace++ as AddressSpaceId },
    { rawBurst: spec.burst, rawService: spec.service, serialFraction: serial });
    for (let i = 0; i < count; i++) pcb.threads.push(this.threads.newTid());
    this.threads.attach(pcb);
    const stream = this.rng.streams.get('vm');
    if (stream === undefined) throw new Error('vm RNG stream missing');
    const program = options.program ?? (spec.referenceString === undefined
      ? generatedProgram(stream, spec, this.tuning) : scriptedProgram(spec.referenceString, spec.service));
    this.programs.set(pid, program); this.namedPrograms.set(spec.name, program); this.burstSizes.set(pid, spec.burst);
    this.pageTables.set(pcb.addressSpaceId, Array.from({ length: spec.pages }, (_, i) => ({ page: asPageId(i),
      frame: null, valid: false, dirty: false, referenced: false, readable: true, writable: true,
      executable: false, swapped: false, lastAccessTick: null, accessCount: 0 })));
    return pid;
  }

  step(): readonly KernelEvent[] {
    this.events.beginFrame();
    this.currentTick = asTick(this.currentTick + 1);
    this.admittedThisTick.clear();
    this.phase01_expireTimers();
    this.phase02_serviceDeviceCompletions();
    this.phase03_deliverInterrupts();
    this.phase04_resolveBlockedProcesses();
    if (this.memorySubsystem.admissionAllowed()) this.phase05_admitNewProcesses(); else this.probe(5);
    this.phase06_ageAndDetectStarvation();
    this.phase07_scheduleDecision();
    this.phase08_executeOneTick();
    this.phase09_detectDeadlock();
    this.phase10_updateMetrics();
    this.phase11_checkInvariants();
    return this.events.lastFrame;
  }
  run(ticks: number): readonly KernelEvent[] {
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new RangeError('run: ticks must be a non-negative integer');
    const log: KernelEvent[] = [];
    for (let i = 0; i < ticks; i++) log.push(...this.step());
    return log;
  }
  syscall(request: SyscallRequest): SyscallResult {
    const pcb = this.table.get(request.pid);
    const live = pcb !== undefined && pcb.state !== 'zombie' && pcb.state !== 'terminated';
    const trap = live && this.enabled.has('security') ? this.securitySubsystem.enterTrap(pcb.pid) : null;
    try {
      const result = !live ? failure('ESRCH', 'process not found') : this.dispatchSyscall(pcb, request);
      this.syscallResults.set(request.pid, result);
      const actor = live ? this.ioActor(pcb) : undefined;
      if (actor === undefined || !this.enabled.has('fs') || this.fileSystemSubsystem.pending(actor) === undefined) this.publish({ type: 'syscall.invoked', request, result });
      return result;
    } finally { if (live && this.enabled.has('security')) this.securitySubsystem.returnTrap(pcb.pid, trap); }
  }
  private dispatchSyscall(pcb: ProcessControlBlock, request: SyscallRequest): SyscallResult {
    const arg = request.args[0];
    switch (request.name) {
      case 'getpid': return { ok: true, value: pcb.pid };
      case 'fork': return this.lifecycle.fork(pcb);
      case 'exec': {
        if (pcb.state === 'waiting') return failure('EBUSY', 'cannot exec a blocked process');
        const target = typeof arg === 'string' && this.enabled.has('fs') && this.fileSystemSubsystem.mounted && !this.namedPrograms.has(arg)
          ? this.fileSystemSubsystem.execTarget(pcb.pid, arg) : undefined;
        if (target !== undefined && !target.result.ok) return target.result;
        const result = typeof arg === 'string' ? this.lifecycle.exec(pcb, target?.programName ?? arg) : failure('EINVAL', 'exec requires a program name');
        if (result.ok) { this.threads.recompute(pcb); this.securitySubsystem.commitExec(pcb.pid, target?.inode); }
        return result;
      }
      case 'exit': return typeof arg === 'number' && Number.isSafeInteger(arg)
        ? this.exitProcess(pcb, arg) : failure('EINVAL', 'exit requires an integer code');
      case 'wait': {
        if (arg !== undefined && (typeof arg !== 'number' || !Number.isSafeInteger(arg) || arg < 0)) return failure('EINVAL', 'invalid child pid');
        const child = typeof arg === 'number' ? asPid(arg) : null;
        if (child !== null && (this.table.parentOf(child) !== pcb.pid || this.table.get(child)?.state === 'terminated')) return failure('ESRCH', 'not a child');
        if (pcb.state !== 'running' && !this.lifecycle.hasExitedChild(pcb.pid, child)) {
          const hasChildren = this.table.filterAscending(p => this.table.parentOf(p.pid) === pcb.pid && p.state !== 'terminated').length > 0;
          if (hasChildren) return failure('EBUSY', 'blocking wait requires a running caller');
        }
        return this.lifecycle.wait(pcb, child);
      }
      case 'kill': {
        if (typeof arg !== 'number' || !Number.isSafeInteger(arg)) return failure('EINVAL', 'invalid target pid');
        const target = this.table.get(asPid(arg));
        if (target === undefined || target.pid === asPid(0)) return failure('ESRCH', 'process not found');
        return this.exitProcess(target, 137, target.parent === pcb.pid ? 'killed_by_parent' : 'killed_by_user');
      }
      case 'ioctl':
        // TODO(astra): WP-11 validates ioctl arguments.
        if (arg !== 'tlb_flush') {
          if (!this.enabled.has('io') || typeof arg !== 'string' || typeof request.args[1] !== 'string') return failure('EINVAL', 'unknown kernel ioctl subcommand');
          const result = this.ioSubsystem.control(arg as DeviceId, request.args[1], request.args.slice(2), this.ioActor(pcb));
          if (result.ok && request.args[1] === 'set_policy') this.currentConfig = cloneConfig({ ...this.config, diskPolicy: this.storageSubsystem.activePolicy });
          return result;
        }
        this.memorySubsystem.flush(); return { ok: true, value: null };
      case 'sync':
        // TODO(astra): WP-11 validates sync arguments.
        if (this.enabled.has('fs') && this.fileSystemSubsystem.mounted) return this.fileSystemSubsystem.syscall(request);
        return this.enabled.has('io') ? this.ioSubsystem.sync(this.ioActor(pcb)) : failure('EINVAL', 'I/O is disabled');
      case 'read': case 'write': {
        // TODO(astra): WP-11 validates read and write arguments; the byte-count bound below is the SEC-ARG-1 check it takes over.
        const invalid = this.securitySubsystem.validateByteCount(pcb.pid, request.args[1]);
        if (invalid !== null) return invalid;
        return this.fileSystemSubsystem.syscall(request);
      }
      case 'open': case 'close': case 'seek': case 'stat': case 'unlink': case 'mkdir': case 'chmod':
        // TODO(astra): WP-11 validates open, close, seek, stat, unlink, mkdir and chmod arguments.
        return this.fileSystemSubsystem.syscall(request);
      case 'sem_wait':
        // TODO(astra): WP-11 validates sem_wait arguments.
        return typeof arg === 'string' && request.args.length === 1 ? this.syncSubsystem.syscall(pcb.pid, 'sem_wait', arg as ResourceId) : failure('EINVAL', 'expected a synchronization resource');
      case 'sem_post':
        // TODO(astra): WP-11 validates sem_post arguments.
        return typeof arg === 'string' && request.args.length === 1 ? this.syncSubsystem.syscall(pcb.pid, 'sem_post', arg as ResourceId) : failure('EINVAL', 'expected a synchronization resource');
      case 'mutex_lock':
        // TODO(astra): WP-11 validates mutex_lock arguments.
        return typeof arg === 'string' && request.args.length === 1 ? this.syncSubsystem.syscall(pcb.pid, 'mutex_lock', arg as ResourceId) : failure('EINVAL', 'expected a synchronization resource');
      case 'mutex_unlock':
        // TODO(astra): WP-11 validates mutex_unlock arguments.
        return typeof arg === 'string' && request.args.length === 1 ? this.syncSubsystem.syscall(pcb.pid, 'mutex_unlock', arg as ResourceId) : failure('EINVAL', 'expected a synchronization resource');
      case 'request': {
        // TODO(astra): WP-11 validates request arguments.
        const vector = decodeResourceVector(request.args);
        return vector === undefined ? failure('EINVAL', 'expected resource/count pairs') : this.deadlockSubsystem.requestVector(pcb.pid, vector);
      }
      case 'release': {
        // TODO(astra): WP-11 validates release arguments.
        const vector = decodeResourceVector(request.args);
        return vector === undefined ? failure('EINVAL', 'expected resource/count pairs') : this.deadlockSubsystem.releaseVector(pcb.pid, vector);
      }
      case 'nice':
        if (typeof arg !== 'number' || !Number.isSafeInteger(arg) || arg < 0 || arg > 39) return failure('EINVAL', 'priority must be in [0, 39]');
        pcb.priority = arg; return { ok: true, value: arg };
      default:
        // TODO(astra): WP-11 completes the syscall table.
        return failure('EINVAL', 'not implemented in WP-02');
    }
  }
  private exitProcess(pcb: ProcessControlBlock, code: number, reason: import('./types').TerminationReason = 'normal_exit'): SyscallResult {
    if (pcb.pid === asPid(0)) return failure('EPERM', 'idle cannot exit');
    if (pcb.state === 'new') {
      pcb.exitCode = code; pcb.terminationReason = reason; this.move(pcb, 'terminated');
      return { ok: true, value: null };
    }
    return this.lifecycle.exit(pcb, code, reason);
  }
  blockProcess(pid: Pid, reason: BlockReason, tid?: Tid): void {
    const pcb = this.table.get(pid);
    if (pcb === undefined || pcb.state !== 'running') throw new KernelInvariantError(11, 'only a running process can block');
    const selected = tid ?? this.executingThread ?? pcb.threads[0];
    if (selected === undefined) throw new KernelInvariantError(7, 'blocking process has no thread');
    const wholeProcess = this.threads.block(pcb, selected, { ...reason });
    if (wholeProcess) this.move(pcb, 'waiting', { blockReason: reason });
    else { this.threads.recompute(pcb); this.move(pcb, 'ready'); }
  }
  private blockMemoryAccess(pcb: ProcessControlBlock, page: PageId, tid: Tid): void {
    const service = pcb.threads.map(id => this.threads.table.get(id)).filter((item): item is ThreadControlBlock => item !== undefined)
      .map(item => ({ thread: item, remaining: item.serviceRemaining }));
    this.blockProcess(pcb.pid, { kind: 'page_fault', page }, tid);
    // Deferred delivery restores the caller's charge; blocking must not redistribute its siblings' service.
    for (const item of service) item.thread.serviceRemaining = item.remaining;
  }
  private suspendMemoryProcess(pid: Pid, tick: Tick, untilTick: Tick): SuspendedProcess {
    const pcb = this.table.get(pid);
    if (pcb === undefined || (pcb.state !== 'ready' && pcb.state !== 'running' && pcb.state !== 'waiting')) throw new RangeError('only an admitted process can be suspended');
    const threads = pcb.threads.map(tid => this.threads.table.get(tid)).filter((thread): thread is ThreadControlBlock => thread !== undefined).sort((a, b) => a.tid - b.tid);
    const saved: SuspendedProcess = { pid, suspendedAt: tick, untilTick, previousState: pcb.state,
      previousBlockedOn: pcb.blockedOn === null ? null : { ...pcb.blockedOn },
      threads: threads.map(thread => ({ tid: thread.tid, state: thread.state, blockedOn: thread.blockedOn === null ? null : { ...thread.blockedOn } })) };
    const reason: BlockReason = { kind: 'sleep', untilTick };
    for (const thread of threads) if (thread.state !== 'terminated') { thread.state = 'waiting'; thread.blockedOn = reason; }
    if (pcb.state === 'waiting') pcb.blockedOn = reason;
    else this.move(pcb, 'waiting', { reason: 'memory_suspension', blockReason: reason });
    return saved;
  }
  private resumeMemoryProcess(saved: SuspendedProcess): void {
    const pcb = this.table.get(saved.pid);
    if (pcb === undefined || pcb.state !== 'waiting') return;
    for (const prior of saved.threads) {
      const thread = this.threads.table.get(prior.tid);
      if (thread === undefined || thread.pid !== saved.pid) throw new Error('suspended thread is missing');
      thread.state = prior.state === 'running' ? 'ready' : prior.state;
      thread.blockedOn = prior.blockedOn === null ? null : { ...prior.blockedOn };
    }
    pcb.blockedOn = saved.previousBlockedOn === null ? null : { ...saved.previousBlockedOn };
    if (this.threads.runnable(pcb).length > 0) { this.threads.recompute(pcb); this.move(pcb, 'ready'); }
  }
  setScheduler(id: SchedulerId, params?: Partial<SchedulerParams>): void {
    const nextParams = { ...this.schedulerParams, ...params };
    const next = this.makeScheduler(id, nextParams);
    this.schedulerParams = nextParams; this.scheduler = next; this.requestedScheduler = id;
    for (const pcb of this.table.filterAscending(p => p.pid > 1 && p.state === 'ready')) this.scheduler.onAdmit(pcb, this.schedulerContext());
    this.syncSchedulerView();
  }
  setReplacementPolicy(id: PageReplacementId): void {
    if (id === 'optimal' && !this.allProgramsScripted()) {
      if (this.devBuild) this.publish({ type: 'kernel.panic', message: 'OPT requires a scripted workload' });
      return;
    }
    this.memorySubsystem.setReplacementPolicy(id);
    this.currentConfig = cloneConfig({ ...this.config, replacementPolicy: id });
  }
  halveRemainingBurst(pid: Pid): void {
    const pcb = this.table.get(pid); const raw = this.table.raw.get(pid);
    if (pcb === undefined || raw === undefined || ['zombie', 'terminated'].includes(pcb.state)) throw new RangeError('process has no remaining work');
    this.threads.halveUsefulWork(pcb);
  }
  prefetchNextFaults(pid: Pid, count: number): void { this.memorySubsystem.prefetchNextFaults(pid, count); }
  remapOptimalLocality(pid: Pid): void { this.memorySubsystem.remapOptimalLocality(pid); }
  setDegreeOfMultiprogramming(target: number): void { this.memorySubsystem.setDegreeOfMultiprogramming(target); }

  setAllocationStrategy(strategy: AllocationStrategy): void {
    this.memorySubsystem.setAllocationStrategy(strategy);
    this.currentConfig = cloneConfig({ ...this.config, allocationStrategy: strategy });
  }
  setDiskPolicy(id: DiskSchedulingId): void {
    this.storageSubsystem.setPolicy(id);
    this.currentConfig = cloneConfig({ ...this.config, diskPolicy: id });
  }
  /** Kernel-side CPU ticks charged to no process; consumed by the phase 8 debt check. */
  chargeKernelDebt(ticks: number): void { this.switchDebt += ticks; }
  /** Opt in before issuing faults; existing demand-paging deadlines remain the floor. */
  attachPagingStorage(options?: Parameters<StorageSubsystem['attachPagingStorage']>[0]): void {
    if (!this.enabled.has('storage')) throw new Error('paging storage requires storage to be enabled');
    if (this.memorySubsystem.pager.saveState().demand.requests.length > 0) throw new Error('attach paging storage before pending faults');
    this.storageSubsystem.attachPagingStorage({ pageBytes: this.config.pageSize, ...options }); this.bindPagingStorage();
  }
  private bindPagingStorage(restoring = false): void {
    const storage = this.storageSubsystem;
    this.memorySubsystem.pager.setStorage(storage.pagingAttached ? {
      enqueue: request => {
        if (request.space === undefined) throw new Error('paging storage needs backing address-space identity');
        storage.enqueuePaging({ ...request, space: request.space });
      },
      result: (id, kind) => storage.pagingResult(id, kind), has: (id, kind) => storage.hasPagingTransfer(id, kind),
      acknowledge: (id, kind) => storage.acknowledgePaging(id, kind), cancel: id => storage.cancelPaging(id),
      reassign: (id, pid) => storage.reassignPaging(id, pid),
    } : undefined, restoring);
  }
  private ioActor(pcb: ProcessControlBlock): { pid: Pid; tid: Tid } | undefined {
    const tid = this.executingThread !== undefined && pcb.threads.includes(this.executingThread) ? this.executingThread : pcb.threads[0];
    return tid === undefined ? undefined : { pid: pcb.pid, tid };
  }
  declareResource(resource: ResourceDeclaration): void { this.deadlockSubsystem.declare(resource); }
  declareClaims(pid: Pid, claims: ResourceVector): void { this.deadlockSubsystem.declareClaims(pid, claims); }
  setDeadlockStrategy(strategy: DeadlockStrategy): void {
    this.deadlockSubsystem.assertStrategy(strategy);
    this.currentConfig = cloneConfig({ ...this.config, deadlockStrategy: strategy });
  }
  setPreemptible(resource: ResourceId, value: boolean, untilTick: Tick): void { this.deadlockSubsystem.setPreemptible(resource, value, untilTick); }
  evaluateBankers(pid: Pid, resource: ResourceId, instances: number): SafetyCheckResult {
    return this.deadlockSubsystem.evaluateBankers(pid, resource, instances);
  }
  detectDeadlock(): DeadlockReport | null { return this.deadlockSubsystem.detectDeadlock(); }

  /** WP-11 restores the process tables before applying this independent contribution. */
  saveSchedulerState(): SchedulerSnapshotState {
    this.syncSchedulerView();
    return saveSchedulerEnvelope(this.scheduler, this.schedulingAccounting, {
      tick: this.tick, readyQueue: [...this.readyQueue], running: this.running,
      lastCpuOwner: this.lastCpuOwner, sliceElapsed: this.sliceElapsed, switchDebt: this.switchDebt,
      contextSwitches: this.contextSwitches, params: saveSchedulerParams(this.schedulerParams),
    });
  }
  restoreSchedulerState(envelope: unknown): void {
    const saved = prepareSchedulerRestore(envelope, {
      ...this.schedulerContext(),
      readyQueue: this.processes.filter(pcb => pcb.pid > 1 && pcb.state === 'ready').map(pcb => pcb.pid),
      running: this.processes.find(pcb => pcb.pid > 1 && pcb.state === 'running')?.pid ?? null,
    }, this.schedulingAccounting, pid => this.burstSizes.get(pid), {
      maxProcesses: this.tuning.maxProcesses, mlfqAccounting: this.tuning.mlfqAccounting, emit: event => this.publish(event),
    });
    saved.commitAccounting();
    this.scheduler = saved.policy; this.schedulerParams = saved.params; this.requestedScheduler = saved.policy.id;
    this.readyQueue.length = 0; this.readyQueue.push(...saved.readyQueue);
    this.running = saved.running; this.lastCpuOwner = saved.lastCpuOwner;
    this.sliceElapsed = saved.sliceElapsed; this.switchDebt = saved.switchDebt; this.contextSwitches = saved.contextSwitches;
    this.schedulingMetrics = this.metricsHooks.scheduler(this.tick);
    this.syncSchedulerView();
  }

  /** The scaffold's init-only replay remains supported. Workload saves need WP-11's contract channel. */
  snapshot(): KernelSnapshot {
    this.requireSnapshotChannel('snapshot');
    return this.withSnapshotContributions({
      version: 1, tick: this.tick, seq: this.events.seq, config: cloneConfig({ ...this.config, scheduler: this.requestedScheduler, schedulerParams: this.schedulerParams }), rng: this.rng.save(),
      processes: this.processes.map(clonePcb), frames: this.frames.map(frame => ({ ...frame })),
      pageTables: [...this.pageTables].sort(([a], [b]) => a - b).map(([space, entries]) => [space, entries.map(entry => ({ ...entry }))] as const),
      syncPrimitives: this.syncPrimitives.map(s => ({ id: s.id, kind: s.kind, displayName: s.displayName, value: s.value,
        capacity: s.capacity, holders: [...s.holders], waitQueue: [...s.waitQueue], ordered: s.ordered })),
      resources: this.resources.map(r => ({ ...r })), diskQueue: this.diskQueue.map(r => ({ ...r })),
      diskHead: { ...this.diskHead }, devices: this.devices.map(d => ({ ...d, queue: [...d.queue] })),
      inodes: this.inodes.map(i => ({ ...i, blocks: [...i.blocks] })), journal: this.journal.map(j => ({ ...j, blocks: [...j.blocks] })),
      domains: this.domains.map(d => ({ ...d, rights: new Map([...d.rights].map(([key, rights]) => [key, [...rights]])) })),
      subsystems: { scheduler: this.saveSchedulerState() },
      metrics: { scheduling: { ...this.schedulingMetrics }, memory: { ...this.memoryMetrics, workingSets: new Map(this.memoryMetrics.workingSets) } },
    });
  }
  private withSnapshotContributions(snapshot: KernelSnapshot): KernelSnapshot {
    const subsystems: SubsystemSnapshots = { ...snapshot.subsystems };
    for (const hooks of this.snapshotHooks) {
      const contribution = hooks.saveState();
      if (Object.keys(contribution).some(key => key in subsystems)) throw new Error('duplicate snapshot subsystem registration');
      Object.assign(subsystems, contribution);
    }
    return { ...snapshot, subsystems };
  }
  restore(snapshot: KernelSnapshot): void {
    if (snapshot.version !== 1) throw new Error(`unsupported snapshot version ${String(snapshot.version)}`);
    this.requireSnapshotChannel('restore');
    if (snapshot.processes.some(pcb => pcb.pid !== asPid(1) || pcb.state !== 'ready') || snapshot.processes.length !== 1) this.snapshotBlocked('restore');
    if (snapshot.subsystems?.scheduler !== undefined) prepareSchedulerRestore(snapshot.subsystems.scheduler, {
      ...this.schedulerContext(), tick: snapshot.tick, running: null, readyQueue: [],
      process: pid => snapshot.processes.find(pcb => pcb.pid === pid),
    }, this.schedulingAccounting, pid => this.burstSizes.get(pid), {
      maxProcesses: this.tuning.maxProcesses, mlfqAccounting: this.tuning.mlfqAccounting, emit: event => this.publish(event),
    }, snapshot.config);
    const restoreContributions = this.snapshotHooks.map(hooks => hooks.restoreState(snapshot));
    this.currentConfig = cloneConfig(snapshot.config); this.enabled = new Set(this.config.enabledSubsystems);
    this.schedulerParams = { ...snapshot.config.schedulerParams }; this.requestedScheduler = this.config.scheduler;
    this.currentTick = snapshot.tick; this.events.beginFrame(); this.events.setSeq(snapshot.seq); this.rng.restore(snapshot.rng);
    this.table.forEachAscending(pcb => this.threads.clear(pcb)); this.table.clear(); this.threads.reset(); this.initialiseSystemProcesses(snapshot.processes[0]);
    const init = snapshot.processes[0];
    const live = this.table.get(asPid(1));
    if (init !== undefined && live !== undefined) {
      // Init has no instruction stream; its finite service fields stay unchanged.
      live.state = init.state; live.readySince = init.readySince;
    }
    this.frames = snapshot.frames.map(frame => ({ ...frame })); this.rebuildFreeList();
    this.pageTables.clear();
    for (const [space, entries] of snapshot.pageTables) this.pageTables.set(space, entries.map(entry => ({ ...entry })));
    this.tlb = [];
    this.syncPrimitives = snapshot.syncPrimitives.map(s => ({ ...s, holders: [...s.holders], waitQueue: [...s.waitQueue] }));
    this.resources = snapshot.resources.map(r => ({ ...r })); this.diskQueue = snapshot.diskQueue.map(r => ({ ...r }));
    this.diskHead = { ...snapshot.diskHead }; this.devices = snapshot.devices.map(d => ({ ...d, queue: [...d.queue] }));
    this.inodes = snapshot.inodes.map(i => ({ ...i, blocks: [...i.blocks] })); this.journal = snapshot.journal.map(j => ({ ...j, blocks: [...j.blocks] }));
    this.domains = snapshot.domains.map(d => ({ ...d, rights: new Map([...d.rights].map(([key, rights]) => [key, [...rights]])) }));
    this.schedulingMetrics = { ...snapshot.metrics.scheduling };
    this.memoryMetrics = { ...snapshot.metrics.memory, workingSets: new Map(snapshot.metrics.memory.workingSets) };
    this.contextSwitches = snapshot.metrics.scheduling.contextSwitches;
    this.running = null; this.lastCpuOwner = null; this.sliceElapsed = 0; this.switchDebt = 0;
    this.wakeable.clear(); this.admittedThisTick.clear(); this.scheduler = this.makeScheduler(this.config.scheduler);
    if (snapshot.subsystems?.scheduler !== undefined) this.restoreSchedulerState(snapshot.subsystems.scheduler);
    else this.schedulingAccounting.reset();
    for (const commit of restoreContributions) commit();
    this.initialiseFrameTable();
    this.syncSchedulerView();
  }
  private requireSnapshotChannel(name: string): void {
    const tuningNeedsState = Object.keys(DEFAULT_TUNING).some(key => key !== 'checkInvariants'
      && Reflect.get(this.tuning, key) !== Reflect.get(DEFAULT_TUNING, key));
    if (this.table.nextPid > 2 || this.namedPrograms.size > 0 || this.hooksInstalled || this.ipc.hasState
      || tuningNeedsState || this.table.get(asPid(1))?.state !== 'ready') this.snapshotBlocked(name);
  }
  private snapshotBlocked(name: string): never {
    // TODO(astra): blocked on contract change, see report
    throw new Error(`not implemented: ${name} for process workloads or custom subsystem state; WP-11 needs a KernelSnapshot channel for programs, threads and side tables`);
  }

  private phase01_expireTimers(): void {
    this.probe(1); this.wakeable.clear();
    if (this.enabled.has('process')) this.table.forEachAscending(pcb => {
      if (pcb.blockedOn?.kind === 'sleep' && pcb.blockedOn.untilTick <= this.tick) this.wakeable.add(pcb.pid);
    });
    if (this.enabled.has('sync')) this.sync.expireTimers(this.tick);
    if (this.enabled.has('memory') || this.enabled.has('vm')) this.memory.expireTimers(this.tick);
    if (this.enabled.has('storage')) this.storage.expireTimers(this.tick);
    if (this.enabled.has('fs')) this.fs.expireTimers(this.tick);
  }
  private phase02_serviceDeviceCompletions(): void {
    this.probe(2);
    if (this.enabled.has('io') || this.enabled.has('storage')) this.io.serviceCompletions(this.tick);
  }
  private phase03_deliverInterrupts(): void {
    this.probe(3); if (this.enabled.has('io')) this.io.deliverInterrupts(this.tick);
  }
  private phase04_resolveBlockedProcesses(): void {
    this.probe(4); if (!this.enabled.has('process')) return;
    this.table.forEachAscending(pcb => {
      if (pcb.pid <= 1 || pcb.state === 'new' || pcb.state === 'terminated' || pcb.state === 'zombie') return;
      let woke = false;
      for (const tid of pcb.threads) {
        const thread = this.threads.table.get(tid);
        if (thread?.state !== 'waiting' || thread.blockedOn === null) continue;
        const reason = thread.blockedOn;
        if (!this.isSatisfied(pcb, reason)) continue;
        if (reason.kind === 'child_wait') this.syscallResults.set(pcb.pid, this.lifecycle.wait(pcb, reason.child));
        if (this.ipc.matchesWait(pcb.pid, reason)) {
          const result = this.ipc.takeCompletion(pcb.pid);
          if (result !== undefined) this.syscallResults.set(pcb.pid, result);
        }
        this.threads.wake(pcb, tid); woke = true;
      }
      // Any newly runnable LWP can wake the PCB, even if a different LWP blocked last.
      if (pcb.state === 'waiting' && woke && (this.threads.runnable(pcb).length > 0 || pcb.serviceRemaining === 0)) {
        this.threads.recompute(pcb); this.move(pcb, 'ready');
      }
    });
    // Init has no user program and reaps its zombie children in deterministic pid order.
    const init = this.table.get(asPid(1));
    if (init !== undefined && init.state === 'ready') {
      for (const child of this.table.filterAscending(pcb => pcb.state === 'zombie' && this.table.parentOf(pcb.pid) === init.pid)) this.lifecycle.wait(init, child.pid);
    }
  }
  private isSatisfied(pcb: ProcessControlBlock, reason: BlockReason): boolean {
    if (this.memorySubsystem.isSuspended(pcb.pid)) return false;
    switch (reason.kind) {
      case 'sleep': return reason.untilTick <= this.tick;
      case 'child_wait': return this.lifecycle.hasExitedChild(pcb.pid, reason.child);
      case 'io': {
        const thread = pcb.threads.map(tid => this.threads.table.get(tid)).find(row => row?.state === 'waiting' && row.blockedOn === reason);
        if (thread !== undefined && this.enabled.has('fs') && this.fs.ownsWait(pcb.pid, thread.tid, reason)) return this.fs.isSatisfied(pcb.pid, thread.tid);
        return this.enabled.has('io') && this.io.isSatisfied(pcb.pid, reason);
      }
      case 'page_fault': return (this.enabled.has('memory') || this.enabled.has('vm')) && this.memory.isSatisfied(pcb.pid, reason);
      case 'semaphore': case 'mutex': case 'condition':
        if (this.ipc.matchesWait(pcb.pid, reason)) return this.ipc.hasCompletion(pcb.pid);
        {
          const matches = pcb.threads.map(tid => this.threads.table.get(tid)).filter(thread => thread?.state === 'waiting' && thread.blockedOn === reason);
          if (reason.kind === 'semaphore' && this.deadlockSubsystem.owns(reason.resource)) {
            return matches.length === 1 && this.enabled.has('deadlock') && this.deadlockSubsystem.isSatisfied(pcb.pid, reason, matches[0]?.tid);
          }
          return matches.length === 1 && this.enabled.has('sync') && this.sync.isSatisfied(pcb.pid, reason, matches[0]?.tid);
        }
    }
  }
  private phase05_admitNewProcesses(): void {
    this.probe(5); if (!this.enabled.has('process')) return;
    let resident = this.table.filterAscending(pcb => pcb.pid > 1 && ['ready', 'running', 'waiting'].includes(pcb.state)).length;
    this.table.forEachAscending(pcb => {
      if (pcb.state !== 'new' || pcb.arrivalTick > this.tick || resident >= this.tuning.degreeOfMultiprogramming) return;
      if (this.enabled.has('memory')) this.memory.admit(pcb);
      this.threads.recompute(pcb); this.move(pcb, 'ready'); resident += 1; this.admittedThisTick.add(pcb.pid);
    });
  }
  private phase06_ageAndDetectStarvation(): void {
    this.probe(6); if (this.enabled.has('scheduler')) this.schedulerHooks.ageAndDetectStarvation(this.schedulerContext());
  }
  private phase07_scheduleDecision(): void {
    this.probe(7); if (!this.enabled.has('scheduler') || !this.enabled.has('process')) return;
    const decision = this.scheduler.onTick(this.schedulerContext());
    if (decision.next !== this.running) {
      const outgoing = this.running === null ? undefined : this.table.get(this.running);
      if (outgoing?.state === 'running') this.move(outgoing, 'ready');
      if (decision.next !== null) {
        const incoming = this.table.get(decision.next);
        if (incoming?.state !== 'ready' || incoming.pid <= 1) throw new KernelInvariantError(13, 'scheduler selected a non-ready user process');
        this.move(incoming, 'running');
        const forkReturn = this.lifecycle.takeForkReturn(incoming.pid);
        if (forkReturn !== undefined) this.syscallResults.set(incoming.pid, { ok: true, value: forkReturn });
      }
      this.running = decision.next; this.sliceElapsed = 0;
    }
    if (this.lastCpuOwner !== this.running) {
      this.contextSwitches += 1; this.switchDebt = this.tuning.contextSwitchTicks;
      this.publish({ type: 'context.switch', from: this.lastCpuOwner, to: this.running, rationale: decision.rationale });
      this.lastCpuOwner = this.running;
    }
    this.syncSchedulerView();
  }
  private phase08_executeOneTick(): void {
    this.probe(8); if (!this.enabled.has('process') || this.running === null) return;
    if (this.switchDebt > 0) { this.switchDebt -= 1; return; }
    const pcb = this.table.get(this.running);
    if (pcb?.state !== 'running') return;
    if (pcb.serviceRemaining === 0) { this.lifecycle.exit(pcb, 0); return; }
    const debt = this.copyDebt.get(pcb.pid) ?? 0;
    if (debt > 0) { this.copyDebt.set(pcb.pid, debt - 1); return; }
    const delivered = this.threads.deliver(pcb, thread => this.execute(pcb, thread));
    this.executingThread = undefined;
    if (delivered === null) return;
    this.schedulingAccounting.accountBusyTick();
    this.sliceElapsed += 1;
    if (pcb.state === 'running' && pcb.serviceRemaining === 0) this.lifecycle.exit(pcb, 0);
    else if (pcb.cpuBurstRemaining === 0 && pcb.serviceRemaining > 0 && !['zombie', 'terminated'].includes(pcb.state)) {
      const raw = this.table.raw.get(pcb.pid);
      if (raw !== undefined) raw.rawBurst = Math.min(this.burstSizes.get(pcb.pid) ?? 1, raw.rawService);
      this.threads.recompute(pcb);
    }
    if (pcb.state === 'running' && pcb.serviceRemaining > 0 && this.threads.runnable(pcb).length === 0) {
      const waiting = pcb.threads.map(tid => this.threads.table.get(tid)).find(thread => thread?.state === 'waiting');
      if (waiting?.blockedOn !== null && waiting?.blockedOn !== undefined) this.move(pcb, 'waiting', { blockReason: waiting.blockedOn });
    }
  }
  private execute(pcb: ProcessControlBlock, thread: ThreadControlBlock): boolean {
    if (this.enabled.has('io') && this.ioSubsystem.gate({ pid: pcb.pid, tid: thread.tid })) { this.threads.deferServiceCharge(); return false; }
    this.executingThread = thread.tid;
    const program = this.programs.get(pcb.pid);
    if (program === undefined) throw new KernelInvariantError(8, 'running process has no program');
    const instruction = program.at(thread.programCounter);
    if (!this.enabled.has('sync')) return this.executeInstruction(pcb, thread, instruction);
    const actor = { pid: pcb.pid, tid: thread.tid };
    this.syncSubsystem.beginAttempt(actor);
    try { return this.executeInstruction(pcb, thread, instruction); }
    finally { this.syncSubsystem.endAttempt(actor); }
  }
  private executeInstruction(pcb: ProcessControlBlock, thread: ThreadControlBlock, instruction: Instruction): boolean {
    switch (instruction.kind) {
      case 'sync': {
        if (!this.enabled.has('sync')) return true;
        const result = this.syncSubsystem.execute({ pid: pcb.pid, tid: thread.tid }, instruction.operation);
        if (result.deferService) this.threads.deferServiceCharge();
        if (result.target !== null) thread.programCounter = result.target;
        return result.advance;
      }
      case 'compute': return true;
      case 'access': {
        if (!this.securitySubsystem.pageAllowed(pcb.pid, instruction.page, instruction.write)) { this.threads.deferServiceCharge(); return false; }
        if (!this.enabled.has('memory') && !this.enabled.has('vm')) return true;
        const page = this.memorySubsystem.resolvePage(pcb.pid, instruction.page);
        const cow = instruction.write ? this.lifecycle.resolveCow(pcb, page) : null;
        if (cow !== null) {
          this.threads.deferServiceCharge();
          if ('pending' in cow) this.blockMemoryAccess(pcb, page, thread.tid);
          else if (!cow.ok) this.exitProcess(pcb, 1, 'out_of_memory');
          return false;
        }
        const result = this.memory.access(pcb.pid, page, instruction.write);
        if (['zombie', 'terminated'].includes(pcb.state)) { this.threads.deferServiceCharge(); return false; }
        if (!result.hit) {
          this.threads.deferServiceCharge();
          this.publish({ type: 'memory.page_fault', pid: pcb.pid, page, major: true });
          this.blockMemoryAccess(pcb, page, thread.tid);
        }
        if (result.hit && !this.memorySubsystem.accessComplete(pcb.pid)) {
          this.threads.deferServiceCharge(); return false;
        }
        return result.hit;
      }
      case 'syscall': {
        const actor = { pid: pcb.pid, tid: thread.tid }, pending = this.enabled.has('fs') ? this.fs.instructionOutcome(actor) : null;
        if (pending !== null) { if (pending.deferService) this.threads.deferServiceCharge(); return pending.advance; }
        const result = this.syscall({ ...instruction.call, pid: pcb.pid });
        const completion = this.enabled.has('fs') ? this.fs.instructionOutcome(actor) : null;
        if (completion !== null) { if (completion.deferService) this.threads.deferServiceCharge(); return completion.advance; }
        return !(instruction.call.name === 'exec' && result.ok);
      }
      case 'io': {
        if (!this.enabled.has('io')) return true;
        this.io.request(pcb.pid, instruction.device);
        const result = this.ioSubsystem.instructionOutcome({ pid: pcb.pid, tid: thread.tid });
        if (result.deferService) this.threads.deferServiceCharge();
        return result.advance;
      }
      case 'acquire': if (this.enabled.has('sync')) this.sync.acquire(pcb.pid, instruction.resource); return true;
      case 'release': if (this.enabled.has('sync')) this.sync.release(pcb.pid, instruction.resource); return true;
      case 'thread_create': this.threads.create(pcb, thread.tid); return true;
      case 'thread_join': this.threads.join(pcb, instruction.tid, thread.tid); return true;
    }
  }
  private phase09_detectDeadlock(): void {
    this.probe(9);
    if (this.enabled.has('deadlock') && this.config.deadlockStrategy === 'detect' && this.tick % this.tuning.deadlockDetectionInterval === 0) this.deadlock.maybeDetect(this.tick);
  }
  private phase10_updateMetrics(): void {
    this.probe(10);
    if (this.enabled.has('scheduler')) this.schedulingMetrics = this.metricsHooks.scheduler(this.tick);
    this.rebuildFreeList();
    if (this.enabled.has('memory') || this.enabled.has('vm')) this.memoryMetrics = this.metricsHooks.memory(this.tick);
    this.syncSchedulerView();
  }
  private phase11_checkInvariants(): void {
    this.probe(11); if (this.tuning.checkInvariants) this.invariants.check(this);
  }
  private move(pcb: ProcessControlBlock, to: ProcessState, options: TransitionOptions = {}): void {
    transition(pcb, to, { ...options, tick: this.tick, emit: event => this.publish(event),
      parentOf: pid => this.table.parentOf(pid), markCreated: pid => this.table.markCreated(pid),
      onAdmit: p => {
        this.readyQueue.push(p.pid);
        this.scheduler.onAdmit(p, this.schedulerContext());
      },
      onDispatch: p => {
        this.running = p.pid;
        this.removeReady(p.pid);
        this.schedulingAccounting.dispatch(p, asTick(this.tick - 1));
      },
      onReady: p => {
        if (this.running === p.pid) this.running = null;
        this.readyQueue.push(p.pid);
        this.scheduler.onUnblock(p, this.schedulerContext());
      },
      onBlock: p => {
        this.removeReady(p.pid);
        if (this.running === p.pid) this.running = null;
        if (p.blockedOn !== null && !p.threads.some(tid => this.threads.table.get(tid)?.state === 'waiting')) {
          const tid = this.executingThread ?? p.threads[0];
          if (tid !== undefined) this.threads.block(p, tid, p.blockedOn);
        }
        this.scheduler.onBlock(p, this.schedulerContext());
      },
      onUnblock: p => {
        this.readyQueue.push(p.pid);
        this.scheduler.onUnblock(p, this.schedulerContext());
      },
      onExit: p => {
        this.removeReady(p.pid);
        this.schedulingAccounting.complete(p, this.tick);
        if (this.running === p.pid) this.running = null;
        this.scheduler.onExit(p, this.schedulerContext()); this.lifecycle.cleanupExit(p);
      },
      onDiscard: p => this.lifecycle.cleanupExit(p),
    });
  }
  private publish(event: EmittableEvent): void { this.events.setTick(this.tick); this.events.emit(event); }
  private probe(phase: number): void { for (const callback of this.probes) callback(phase, this.tick); }
  private threadPc(pcb: ProcessControlBlock): number {
    const tid = this.executingThread ?? pcb.threads[0];
    return tid === undefined ? 0 : this.threads.table.get(tid)?.programCounter ?? 0;
  }
  private makeScheduler(id: SchedulerId, params: SchedulerParams = this.schedulerParams): SchedulerPolicy {
    const policy = createScheduler(id, params, {
      maxProcesses: this.tuning.maxProcesses, mlfqAccounting: this.tuning.mlfqAccounting, emit: event => this.publish(event),
    });
    configureSchedulerWorkload(policy, pid => this.burstSizes.get(pid));
    return policy;
  }
  private syncSchedulerView(): void {
    if (isRunningAware(this.scheduler)) this.scheduler.setRunning(this.running);
    if (isMetricsAware(this.scheduler)) this.scheduler.acceptMetrics(this.schedulingMetrics);
  }
  private removeReady(pid: Pid): void {
    const index = this.readyQueue.indexOf(pid);
    if (index >= 0) this.readyQueue.splice(index, 1);
  }
  private schedulerContext(): SchedulerContext {
    const rng = this.rng.streams.get('scheduler');
    if (rng === undefined) throw new Error('scheduler RNG stream missing');
    return { tick: this.tick, rng,
      params: this.schedulerParams, running: this.running, sliceElapsed: this.sliceElapsed,
      process: pid => this.table.get(pid), readyQueue: this.readyQueue,
      emit: event => this.publish(event) };
  }
  private basePcb(pid: Pid, parent: Pid | null, name: string): ProcessControlBlock {
    return { pid, parent, name, state: 'ready', priority: 39, basePriority: 39,
      arrivalTick: asTick(0), cpuBurstRemaining: 1, serviceRemaining: 1, totalCpuUsed: 0,
      readySince: asTick(0), lastScheduledTick: null, queueLevel: 0, addressSpaceId: pid as number as AddressSpaceId,
      threads: [], openFiles: [], heldResources: [], requestedResources: [], blockedOn: null,
      domain: 'kernel' as DomainId, exitCode: null, terminationReason: null, convoyMemberId: null };
  }
  private initialiseSystemProcesses(savedInit?: ProcessControlBlock): void {
    const idle = this.table.insert({ ...this.basePcb(asPid(0), null, 'idle'), priority: Number.MAX_SAFE_INTEGER, basePriority: Number.MAX_SAFE_INTEGER, cpuBurstRemaining: Infinity, serviceRemaining: Infinity });
    idle.threads.push(0 as Tid);
    const init = this.table.insert(savedInit === undefined ? this.basePcb(asPid(1), null, 'init') : clonePcb(savedInit), { rawBurst: 1, rawService: 1, serialFraction: 1 });
    this.threads.attach(init);
    this.programs.set(init.pid, instructionProgram([{ kind: 'compute' }]));
  }
  private initialiseFrameTable(): void {
    this.syncPrimitives = this.syncSubsystem.primitives;
    this.resources = this.deadlockSubsystem.resources.resources;
    this.diskQueue = this.storageSubsystem.diskQueue;
    this.diskHead = this.storageSubsystem.diskHead;
    this.devices = this.ioSubsystem.devices;
    this.inodes = this.fileSystemSubsystem.inodes;
    this.journal = this.fileSystemSubsystem.journalEntries;
    this.domains = this.securitySubsystem.domains;
    this.frames = this.memorySubsystem.frameTable.frames;
    this.tlb = this.memorySubsystem.tlb.entries;
    this.rebuildFreeList();
  }
  private rebuildFreeList(): void {
    this.freeList = this.frames.filter(frame => frame.owner === null).map(frame => frame.id).sort((a, b) => a - b);
  }
  private checkInvariants(): void {
    const processes = this.table.filterAscending(p => p.pid !== asPid(0));
    this.assert(processes.filter(p => p.state === 'running').length <= 1, 2, 'more than one running process');
    for (let index = 0; index < processes.length; index++) {
      const pcb = processes[index]; if (pcb === undefined) continue;
      this.assert(index === 0 || pcb.pid > (processes[index - 1]?.pid ?? -1), 1, 'process table not ascending');
      this.assert((pcb.state === 'ready') === (pcb.readySince !== null), 12, 'readySince disagrees with state');
      if (pcb.readySince !== null) this.assert(pcb.readySince <= this.tick, 12, 'readySince lies in the future');
      if (['ready', 'running', 'waiting'].includes(pcb.state)) this.assert(pcb.threads.length > 0, 7, 'active process has no threads');
      for (const value of [pcb.cpuBurstRemaining, pcb.serviceRemaining, pcb.totalCpuUsed]) this.assert(Number.isSafeInteger(value) && value >= 0, 4, 'invalid process service');
      this.assert(pcb.priority >= 0 && pcb.priority <= 39 && pcb.basePriority >= 0 && pcb.basePriority <= 39, 15, 'priority out of range');
      if (pcb.state === 'waiting') this.assert(pcb.blockedOn !== null, 10, 'waiting process has no block reason');
      if (this.admittedThisTick.has(pcb.pid) && pcb.readySince !== null) this.assert(pcb.readySince === this.tick, 14, 'new admission has waited');
      if (pcb.pid > 1 && ['ready', 'running', 'waiting'].includes(pcb.state)) {
        const sum = pcb.threads.reduce((total, tid) => total + (this.threads.table.get(tid)?.serviceRemaining ?? 0), 0);
        this.assert(sum === pcb.serviceRemaining, 7, 'thread service is not conserved');
      }
    }
    // I-11 is enforced per edge by transition(), not by comparing endpoints of a multi-edge tick.
    const queued = this.scheduler.snapshot().queues.flat();
    this.assert(new Set(queued).size === queued.length, 13, 'duplicate ready queue entry');
    const expected = processes.filter(p => p.pid > 1 && p.state === 'ready').map(p => p.pid);
    this.assert(queued.length === expected.length && expected.every(pid => queued.includes(pid)), 13, 'ready queue differs from ready processes');
    this.assert(this.frames.filter(frame => frame.owner !== null).length + this.freeList.length === this.config.totalFrames, 17, 'frame conservation');
    for (let index = 1; index < this.freeList.length; index++) this.assert((this.freeList[index] ?? -1) > (this.freeList[index - 1] ?? -1), 20, 'free list not ascending');
    for (const entry of this.tlb) {
      const frame = this.frames[entry.frame];
      if (entry.valid) this.assert(frame?.owner === entry.space && frame.page === entry.page, 9, 'TLB does not match frame owner');
    }
    for (const value of Object.values(this.schedulingMetrics)) this.assert(Number.isFinite(value) && value >= 0, 19, 'invalid scheduling metric');
    this.assert(this.schedulingMetrics.cpuUtilisation <= 1, 19, 'CPU utilisation exceeds one');
    let previous = -1;
    for (const event of this.events.lastFrame) { this.assert(event.seq > previous, 38, 'event sequence decreased'); previous = event.seq; }
  }
  private assert(condition: boolean, invariant: number, message: string): void {
    if (!condition) {
      this.publish({ type: 'kernel.panic', message: `I-${invariant}: ${message}` });
      throw new InvariantViolation(invariant, message, this.tick);
    }
  }
}
function clonePcb(pcb: Readonly<ProcessControlBlock>): ProcessControlBlock {
  return { ...pcb, threads: [...pcb.threads], openFiles: [...pcb.openFiles], heldResources: [...pcb.heldResources],
    requestedResources: [...pcb.requestedResources], blockedOn: pcb.blockedOn === null ? null : { ...pcb.blockedOn } };
}
function cloneConfig(config: KernelConfig): KernelConfig {
  return Object.freeze({ ...config, enabledSubsystems: Object.freeze([...config.enabledSubsystems]),
    schedulerParams: Object.freeze({ ...config.schedulerParams,
      ...(config.schedulerParams.levelQuanta === undefined ? {} : { levelQuanta: Object.freeze([...config.schedulerParams.levelQuanta]) }) }) });
}
function failure(errno: import('./types').Errno, message: string): SyscallResult { return { ok: false, errno, message }; }
export function createKernel(config: KernelConfig, options?: KernelOptions): KernelImpl { return new KernelImpl(config, options); }
