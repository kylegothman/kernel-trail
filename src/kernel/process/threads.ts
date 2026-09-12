import type { EmittableEvent } from '../EventBus';
import { KernelInvariantError } from '../errors';
import type { BlockReason, Pid, ProcessControlBlock, SyscallResult, Tid } from '../types';
import { amdahlSpeedup, usableCores } from './amdahl';
import type { RawProcessWork } from './ProcessTable';

export type ThreadState = 'ready' | 'running' | 'waiting' | 'terminated';

export interface ThreadControlBlock {
  readonly tid: Tid;
  readonly pid: Pid;
  state: ThreadState;
  /** Index into the owning process's Program. Threads share the address space. */
  programCounter: number;
  /** Ticks of work this thread still owes. Sums to the process serviceRemaining. */
  serviceRemaining: number;
  /** Kernel-level scheduling entity this thread maps onto. Null under many-to-one. */
  lwp: number | null;
  blockedOn: BlockReason | null;
}

export type ThreadModel = 'many_to_one' | 'one_to_one' | 'many_to_many';

export interface ThreadConfig {
  readonly model: ThreadModel;
  readonly coreCount: number;
  readonly lwpPoolSize: number;
  readonly maxThreadsPerProcess: number;
  readonly threadCreateTicks: number;
}

export interface ThreadOptions {
  readonly programCounter?: number;
  readonly lwp?: number;
}

/** Explicit bindings are separate from computed ones, so reassignment is reproducible. */
export function assignLwps(
  tids: readonly Tid[],
  cfg: ThreadConfig,
  bindings: ReadonlyMap<Tid, number> = new Map<Tid, number>(),
): ReadonlyMap<Tid, number | null> {
  const ordered = [...tids].sort((left, right) => left - right);
  const count = Math.min(ordered.length, cfg.lwpPoolSize);
  const result = new Map<Tid, number | null>();
  for (let index = 0; index < ordered.length; index++) {
    const tid = ordered[index];
    if (tid === undefined) continue;
    switch (cfg.model) {
      case 'many_to_one': result.set(tid, null); break;
      case 'one_to_one': result.set(tid, tid); break;
      case 'many_to_many': result.set(tid, bindings.get(tid) ?? index % count); break;
    }
  }
  return result;
}

export class ThreadManager {
  readonly table = new Map<Tid, ThreadControlBlock>();
  private nextId = 1;
  private readonly bindings = new Map<Tid, number>();
  private readonly lastDelivered = new Map<Pid, Tid>();

  constructor(
    readonly config: ThreadConfig,
    private readonly raw: Map<Pid, RawProcessWork>,
    private readonly emit: (event: EmittableEvent) => void,
    private readonly onEmpty: (pcb: ProcessControlBlock) => void,
  ) {}

  reset(): void {
    this.table.clear(); this.bindings.clear(); this.lastDelivered.clear(); this.nextId = 1;
  }

  newTid(): Tid {
    const tid = this.nextId as Tid;
    this.nextId += 1;
    return tid;
  }

  /** Initial and fork threads are covered by process creation, without creation overhead. */
  attach(pcb: ProcessControlBlock, options: ThreadOptions = {}): void {
    if (pcb.threads.length === 0) pcb.threads.push(this.newTid());
    const count = pcb.threads.length;
    for (let index = 0; index < count; index++) {
      const tid = pcb.threads[index];
      if (tid === undefined) continue;
      this.nextId = Math.max(this.nextId, tid + 1);
      if (this.table.has(tid)) {
        throw new KernelInvariantError(7, 'thread already attached', { tid });
      }
      const share = Math.floor(pcb.serviceRemaining / count)
        + (index < pcb.serviceRemaining % count ? 1 : 0);
      this.add(pcb, tid, share, options);
    }
    this.assign(pcb);
  }

  create(
    pcb: ProcessControlBlock,
    creatorTid?: Tid,
    options: ThreadOptions = {},
  ): SyscallResult {
    if (pcb.threads.length >= this.config.maxThreadsPerProcess) {
      return { ok: false, errno: 'EAGAIN', message: 'thread limit reached' };
    }
    if (options.lwp !== undefined && (!Number.isSafeInteger(options.lwp) || options.lwp < 0)) throw new RangeError('invalid LWP');
    const creator = this.find(pcb, creatorTid ?? pcb.threads[0]);
    if (creator === undefined) return { ok: false, errno: 'ESRCH', message: 'no creating thread' };
    const tid = this.newTid();
    const share = Math.floor(creator.serviceRemaining / 2);
    creator.serviceRemaining -= share;
    this.add(pcb, tid, share, {
      ...options,
      programCounter: options.programCounter ?? creator.programCounter + 1,
    });
    pcb.threads.push(tid);
    this.assign(pcb);
    // WP-02's numeric acceptance requires charging raw work before the division.
    this.work(pcb).rawService += this.config.threadCreateTicks;
    this.emit({ type: 'thread.created', pid: pcb.pid, tid });
    this.recompute(pcb);
    return { ok: true, value: tid };
  }

  join(pcb: ProcessControlBlock, tid: Tid, joinerTid?: Tid): SyscallResult {
    const joined = this.find(pcb, tid);
    if (joined === undefined) return { ok: false, errno: 'ESRCH', message: 'thread not found' };
    const survivors = pcb.threads.filter(candidate => candidate !== tid);
    const joiner = this.find(pcb, joinerTid ?? survivors[0]);
    if (survivors.length > 0 && (joiner === undefined || joiner.tid === tid)) {
      return { ok: false, errno: 'EINVAL', message: 'invalid joining thread' };
    }
    if (joiner !== undefined && joiner.tid !== tid) {
      joiner.serviceRemaining += joined.serviceRemaining;
      if (joiner.state === 'terminated' && joiner.serviceRemaining > 0) joiner.state = 'ready';
    }
    pcb.threads.splice(pcb.threads.indexOf(tid), 1);
    this.table.delete(tid);
    this.bindings.delete(tid);
    if (this.lastDelivered.get(pcb.pid) === tid) this.lastDelivered.delete(pcb.pid);
    this.assign(pcb);
    this.emit({ type: 'thread.joined', pid: pcb.pid, tid });
    if (pcb.threads.length === 0) this.onEmpty(pcb);
    else this.recompute(pcb);
    return { ok: true, value: 0 };
  }

  clear(pcb: ProcessControlBlock): void {
    for (const tid of pcb.threads) {
      this.table.delete(tid);
      this.bindings.delete(tid);
    }
    pcb.threads.length = 0;
    this.lastDelivered.delete(pcb.pid);
  }

  /** The caller performs the corresponding legal PCB transition. */
  block(pcb: ProcessControlBlock, tid: Tid, reason: BlockReason): boolean {
    const thread = this.require(pcb, tid);
    thread.state = 'waiting';
    thread.blockedOn = reason;
    return this.runnable(pcb).length === 0;
  }

  wake(pcb: ProcessControlBlock, tid: Tid): boolean {
    const thread = this.require(pcb, tid);
    if (thread.state === 'waiting') {
      thread.state = 'ready';
      thread.blockedOn = null;
      this.recompute(pcb);
    }
    return this.runnable(pcb).length > 0;
  }

  runnable(pcb: ProcessControlBlock, includeEmpty = false): readonly ThreadControlBlock[] {
    const threads = pcb.threads.map(tid => this.require(pcb, tid));
    const blocked = new Set<number>();
    for (const thread of threads) {
      if (thread.state !== 'waiting') continue;
      if (this.config.model === 'many_to_one') return [];
      if (thread.lwp !== null) blocked.add(thread.lwp);
    }
    return threads.filter(thread => (thread.state === 'ready' || thread.state === 'running')
      && (includeEmpty || thread.serviceRemaining > 0)
      && (this.config.model !== 'many_to_many' || thread.lwp === null || !blocked.has(thread.lwp)));
  }

  effectiveCores(pcb: ProcessControlBlock, includeEmpty = false): number {
    const runnable = this.runnable(pcb, includeEmpty);
    const cores = usableCores(runnable.length, this.config);
    if (this.config.model !== 'many_to_many') return cores;
    // A blocked LWP stalls all of its users, even when other LWPs have many users.
    return Math.min(cores, new Set(runnable.map(thread => thread.lwp)).size);
  }

  recompute(pcb: ProcessControlBlock): void {
    const work = this.work(pcb);
    if (work.rawService === 0) return;
    const cores = this.effectiveCores(pcb, true);
    if (this.runnable(pcb, true).length === 0 || cores === 0) return;
    const speedup = amdahlSpeedup(work.serialFraction, cores);
    pcb.cpuBurstRemaining = Math.max(1, Math.round(work.rawBurst / speedup));
    pcb.serviceRemaining = Math.max(1, Math.round(work.rawService / speedup));
    this.distribute(pcb);
  }

  /** A process tick is already accelerated, so precisely one thread consumes it. */
  deliver(pcb: ProcessControlBlock, execute: (thread: ThreadControlBlock) => boolean): Tid | null {
    const runnable = this.runnable(pcb);
    const previous = this.lastDelivered.get(pcb.pid);
    const same = runnable.find(thread => thread.tid === previous);
    const next = this.config.model === 'many_to_one'
      ? same ?? runnable[0]
      : runnable.find(thread => previous === undefined || thread.tid > previous) ?? runnable[0];
    if (next === undefined) return null;
    this.lastDelivered.set(pcb.pid, next.tid);
    next.state = 'running';
    this.consume(pcb, next);
    const advance = execute(next);
    // Exec and exit may have removed the selected TCB during the callback.
    if (this.table.get(next.tid) === next) {
      if (advance) next.programCounter += 1;
      if (next.state === 'running') next.state = next.serviceRemaining === 0 ? 'terminated' : 'ready';
    }
    return next.tid;
  }

  private consume(pcb: ProcessControlBlock, thread: ThreadControlBlock): void {
    const work = this.work(pcb);
    const oldBurst = pcb.cpuBurstRemaining;
    const oldService = pcb.serviceRemaining;
    pcb.cpuBurstRemaining = Math.max(0, oldBurst - 1);
    pcb.serviceRemaining = Math.max(0, oldService - 1);
    pcb.totalCpuUsed += 1;
    thread.serviceRemaining = Math.max(0, thread.serviceRemaining - 1);
    // Keep raw progress integral; recomputation must never restore work already run.
    work.rawBurst = oldBurst === 0 ? 0
      : Math.round(work.rawBurst * pcb.cpuBurstRemaining / oldBurst);
    work.rawService = oldService === 0 ? 0
      : Math.round(work.rawService * pcb.serviceRemaining / oldService);
  }

  private distribute(pcb: ProcessControlBlock): void {
    const threads = pcb.threads.map(tid => this.require(pcb, tid));
    const sum = threads.reduce((total, thread) => total + thread.serviceRemaining, 0);
    let assigned = 0;
    const fractions = threads.map(thread => {
      const weighted = sum === 0 ? pcb.serviceRemaining / threads.length
        : pcb.serviceRemaining * thread.serviceRemaining / sum;
      const units = Math.floor(weighted);
      thread.serviceRemaining = units;
      assigned += units;
      return { thread, remainder: weighted - units };
    });
    fractions.sort((left, right) => right.remainder - left.remainder || left.thread.tid - right.thread.tid);
    for (let index = 0; index < pcb.serviceRemaining - assigned; index++) {
      const entry = fractions[index];
      if (entry !== undefined) entry.thread.serviceRemaining += 1;
    }
    for (const thread of threads) {
      if (thread.state === 'terminated' && thread.serviceRemaining > 0) thread.state = 'ready';
    }
  }

  private add(pcb: ProcessControlBlock, tid: Tid, service: number, options: ThreadOptions): void {
    if (options.lwp !== undefined) {
      if (!Number.isInteger(options.lwp) || options.lwp < 0) throw new RangeError('invalid LWP');
      this.bindings.set(tid, options.lwp);
    }
    this.table.set(tid, {
      tid, pid: pcb.pid, state: 'ready', programCounter: options.programCounter ?? 0,
      serviceRemaining: service, lwp: options.lwp ?? null, blockedOn: null,
    });
  }

  private assign(pcb: ProcessControlBlock): void {
    const assignments = assignLwps(pcb.threads, this.config, this.bindings);
    for (const tid of pcb.threads) this.require(pcb, tid).lwp = assignments.get(tid) ?? null;
  }

  private find(pcb: ProcessControlBlock, tid: Tid | undefined): ThreadControlBlock | undefined {
    if (tid === undefined || !pcb.threads.includes(tid)) return undefined;
    const thread = this.table.get(tid);
    return thread?.pid === pcb.pid ? thread : undefined;
  }

  private require(pcb: ProcessControlBlock, tid: Tid): ThreadControlBlock {
    const thread = this.find(pcb, tid);
    if (thread === undefined) throw new KernelInvariantError(7, 'missing process thread', { pid: pcb.pid, tid });
    return thread;
  }

  private work(pcb: ProcessControlBlock): RawProcessWork {
    const work = this.raw.get(pcb.pid);
    if (work === undefined) throw new KernelInvariantError(7, 'missing raw process work', { pid: pcb.pid });
    return work;
  }
}
