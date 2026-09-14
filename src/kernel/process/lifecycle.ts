import type { EmittableEvent } from '../EventBus';
import { asPid } from '../types';
import type {
  AddressSpaceId, FileDescriptor, FrameId, PageId, PageTableEntry, Pid,
  ProcessControlBlock, ProcessState, SyscallResult, TerminationReason, Tick,
} from '../types';
import type { Program } from './Program';
import type { ProcessTable } from './ProcessTable';
import type { TransitionOptions } from './transitions';

export type CowCapacity =
  | { readonly state: 'ready'; readonly frame: FrameId; readonly reported: boolean }
  | { readonly state: 'pending'; readonly reported: boolean }
  | { readonly state: 'failed' };

export type CowResolution = SyscallResult | { readonly pending: true };

export interface ProcessMemoryHooks {
  readonly pageTables: Map<AddressSpaceId, PageTableEntry[]>;
  allocateFrame(space: AddressSpaceId, page: PageId): FrameId | null;
  freeFrame(frame: FrameId): void;
  copyFrame(from: FrameId, to: FrameId): void;
  prepareCow?(pid: Pid, page: PageId, source: FrameId): CowCapacity;
}

export interface LifecycleContext {
  readonly table: ProcessTable;
  readonly maxProcesses: number;
  readonly cowCopyTicks: number;
  readonly memory: ProcessMemoryHooks;
  tick(): Tick;
  emit(event: EmittableEvent): void;
  onTransition(pcb: ProcessControlBlock, to: ProcessState, options?: TransitionOptions): void;
  nextAddressSpace(): AddressSpaceId;
  createInitialThread(pcb: ProcessControlBlock, parent?: ProcessControlBlock): void;
  clearThreads(pcb: ProcessControlBlock): void;
  programNamed(name: string): Program | undefined;
  detachIpc(pcb: ProcessControlBlock): void;
  replaceProgram(pcb: ProcessControlBlock, program: Program): void;
  copyProgram(parent: ProcessControlBlock, child: ProcessControlBlock): void;
  retainDescriptor(fd: FileDescriptor): void;
  closeDescriptor(pcb: ProcessControlBlock, fd: FileDescriptor): void;
  closeOnExec(pcb: ProcessControlBlock, fd: FileDescriptor): boolean;
  releaseResources(pcb: ProcessControlBlock): void;
  removeFromWaitQueues(pcb: ProcessControlBlock): void;
  wakeParent(pid: Pid): void;
  chargeCowCopy(pcb: ProcessControlBlock, ticks: number): void;
}

/** Lifecycle metadata remains separate from the frozen process contract. */
export class ProcessLifecycle {
  readonly cowRefCount = new Map<FrameId, number>();
  readonly childForkReturns = new Map<Pid, number>();

  constructor(private readonly ctx: LifecycleContext) {}

  fork(parent: ProcessControlBlock): SyscallResult {
    if (parent.state === 'zombie' || parent.state === 'terminated') {
      return { ok: false, errno: 'ESRCH', message: 'process has exited' };
    }
    if (this.ctx.table.activeCount >= this.ctx.maxProcesses) {
      return { ok: false, errno: 'EAGAIN', message: 'process table is full' };
    }
    const pid = this.ctx.table.allocatePid();
    const addressSpaceId = this.ctx.nextAddressSpace();
    const raw = this.ctx.table.raw.get(parent.pid);
    const child = this.ctx.table.insert({
      pid, parent: parent.pid, name: `${parent.name}'`, state: 'new',
      priority: parent.priority, basePriority: parent.basePriority,
      arrivalTick: this.ctx.tick(), cpuBurstRemaining: parent.cpuBurstRemaining,
      serviceRemaining: parent.serviceRemaining, totalCpuUsed: 0,
      readySince: null, lastScheduledTick: null, queueLevel: 0, addressSpaceId,
      threads: [], openFiles: [...parent.openFiles], heldResources: [],
      requestedResources: [], blockedOn: null, domain: parent.domain,
      exitCode: null, terminationReason: null, convoyMemberId: null,
    }, raw);
    this.ctx.createInitialThread(child, parent);
    this.ctx.copyProgram(parent, child);
    for (const fd of child.openFiles) this.ctx.retainDescriptor(fd);
    const childPages: PageTableEntry[] = [];
    for (const entry of this.ctx.memory.pageTables.get(parent.addressSpaceId) ?? []) {
      const copied = { ...entry };
      if (entry.valid && entry.frame !== null) {
        entry.writable = false;
        copied.writable = false;
        this.cowRefCount.set(entry.frame, (this.cowRefCount.get(entry.frame) ?? 1) + 1);
      }
      childPages.push(copied);
    }
    this.ctx.memory.pageTables.set(child.addressSpaceId, childPages);
    this.childForkReturns.set(pid, 0);
    if (this.ctx.table.markCreated(pid)) {
      this.ctx.emit({ type: 'process.created', pid, parent: parent.pid, name: child.name });
    }
    return { ok: true, value: pid };
  }

  /** Dispatch consumes the child's fork result exactly once. */
  takeForkReturn(pid: Pid): number | undefined {
    const value = this.childForkReturns.get(pid);
    this.childForkReturns.delete(pid);
    return value;
  }

  exec(pcb: ProcessControlBlock, name: string): SyscallResult {
    const program = this.ctx.programNamed(name);
    if (program === undefined) return { ok: false, errno: 'ENOENT', message: `unknown program ${name}` };
    this.ctx.detachIpc(pcb);
    this.releaseAddressSpace(pcb);
    const preserved: FileDescriptor[] = [];
    for (const fd of [...pcb.openFiles]) {
      if (this.ctx.closeOnExec(pcb, fd)) this.ctx.closeDescriptor(pcb, fd);
      else preserved.push(fd);
    }
    pcb.openFiles = preserved;
    this.ctx.replaceProgram(pcb, program);
    pcb.cpuBurstRemaining = program.length;
    pcb.serviceRemaining = program.length;
    pcb.queueLevel = 0;
    const raw = this.ctx.table.raw.get(pcb.pid);
    if (raw !== undefined) {
      raw.rawBurst = program.length;
      raw.rawService = program.length;
    }
    return { ok: true, value: null };
  }

  exit(pcb: ProcessControlBlock, code: number, reason: TerminationReason = 'normal_exit'): SyscallResult {
    if (pcb.state === 'zombie' || pcb.state === 'terminated') {
      return { ok: false, errno: 'ESRCH', message: 'process has exited' };
    }
    pcb.exitCode = code;
    pcb.terminationReason = reason;
    this.ctx.onTransition(pcb, 'zombie');
    this.ctx.emit({ type: 'process.exited', pid: pcb.pid, exitCode: code, reason });
    return { ok: true, value: null };
  }

  /** Called by transition's onExit hook before committing the zombie state. */
  cleanupExit(pcb: ProcessControlBlock): void {
    pcb.exitCode ??= 0;
    pcb.terminationReason ??= 'normal_exit';
    this.ctx.releaseResources(pcb);
    pcb.heldResources = [];
    pcb.requestedResources = [];
    this.ctx.removeFromWaitQueues(pcb);
    for (const fd of [...pcb.openFiles]) this.ctx.closeDescriptor(pcb, fd);
    pcb.openFiles = [];
    this.releaseAddressSpace(pcb);
    this.ctx.clearThreads(pcb);
    pcb.blockedOn = null;
    this.adoptChildren(pcb.pid);
    this.childForkReturns.delete(pcb.pid);
    const parentPid = this.ctx.table.parentOf(pcb.pid);
    if (parentPid !== null) {
      const parent = this.ctx.table.get(parentPid);
      const block = parent?.blockedOn;
      if (parent?.state === 'waiting' && block?.kind === 'child_wait'
          && (block.child === null || block.child === pcb.pid)) {
        this.ctx.wakeParent(parentPid);
      }
    }
    if (pcb.pid === asPid(1)) this.ctx.emit({ type: 'kernel.panic', message: 'init exited' });
  }

  wait(pcb: ProcessControlBlock, pid: Pid | null = null): SyscallResult {
    const children = this.ctx.table.filterAscending(child =>
      this.ctx.table.parentOf(child.pid) === pcb.pid && child.state !== 'terminated');
    // Sim spec section 14 substitutes ESRCH because ECHILD is not in frozen Errno.
    if (children.length === 0) return { ok: false, errno: 'ESRCH', message: 'no children' };
    const candidates = pid === null ? children : children.filter(child => child.pid === pid);
    if (candidates.length === 0) return { ok: false, errno: 'ESRCH', message: 'not a child' };
    const zombie = candidates.find(child => child.state === 'zombie');
    if (zombie !== undefined) {
      this.ctx.onTransition(zombie, 'terminated', { reapedBy: pcb.pid });
      return { ok: true, value: zombie.exitCode };
    }
    this.ctx.onTransition(pcb, 'waiting', { blockReason: { kind: 'child_wait', child: pid } });
    return { ok: true, value: null };
  }

  hasExitedChild(pid: Pid, child: Pid | null): boolean {
    return this.ctx.table.filterAscending(pcb => this.ctx.table.parentOf(pcb.pid) === pid
      && (child === null || pcb.pid === child) && pcb.state === 'zombie').length > 0;
  }

  private adoptChildren(exitingPid: Pid): void {
    this.ctx.table.forEachAscending(child => {
      if (this.ctx.table.parentOf(child.pid) !== exitingPid || child.state === 'terminated') return;
      this.ctx.table.reparent(child.pid, asPid(1));
      if (child.state === 'zombie') {
        this.ctx.onTransition(child, 'terminated', { reapedBy: asPid(1) });
      } else {
        this.ctx.onTransition(child, child.state, { reason: 'reparent' });
      }
    });
  }

  /** Lifecycle owns COW events and copying; memory owns any asynchronous capacity request. */
  resolveCow(pcb: ProcessControlBlock, page: PageId): CowResolution | null {
    const pte = this.ctx.memory.pageTables.get(pcb.addressSpaceId)?.find(entry => entry.page === page);
    if (pte === undefined || !pte.valid || pte.writable || pte.frame === null) return null;
    const from = pte.frame;
    const count = this.cowRefCount.get(from) ?? 0;
    if (count <= 1) return null;
    const capacity = this.ctx.memory.prepareCow?.(pcb.pid, page, from);
    if (capacity?.state === 'failed') return { ok: false, errno: 'ENOMEM', message: 'no frame for copy-on-write' };
    if (capacity?.state === 'pending') {
      if (!capacity.reported) this.ctx.emit({ type: 'memory.page_fault', pid: pcb.pid, page, major: false });
      return { pending: true };
    }
    const frame = capacity?.frame ?? this.ctx.memory.allocateFrame(pcb.addressSpaceId, page);
    if (frame === null) return { ok: false, errno: 'ENOMEM', message: 'no frame for copy-on-write' };
    this.ctx.memory.copyFrame(from, frame);
    pte.frame = frame;
    pte.writable = true;
    pte.dirty = true;
    this.cowRefCount.set(frame, 1);
    this.cowRefCount.set(from, count - 1);
    if (count - 1 === 1) this.restoreSingleWriter(from);
    this.ctx.chargeCowCopy(pcb, this.ctx.cowCopyTicks);
    if (capacity?.reported !== true) this.ctx.emit({ type: 'memory.page_fault', pid: pcb.pid, page, major: false });
    this.ctx.emit({ type: 'memory.page_loaded', pid: pcb.pid, page, frame });
    return { ok: true, value: frame };
  }

  /** Evicted COW aliases become independent backing mappings before physical reuse. */
  forgetEvictedFrame(frame: FrameId): void {
    if (this.cowRefCount.has(frame)) this.restoreSingleWriter(frame);
    this.cowRefCount.delete(frame);
  }

  releaseAddressSpace(pcb: ProcessControlBlock): void {
    const entries = this.ctx.memory.pageTables.get(pcb.addressSpaceId) ?? [];
    this.ctx.memory.pageTables.set(pcb.addressSpaceId, []);
    for (const pte of entries) {
      if (!pte.valid || pte.frame === null) continue;
      const remaining = (this.cowRefCount.get(pte.frame) ?? 1) - 1;
      if (remaining === 0) {
        this.cowRefCount.delete(pte.frame);
        this.ctx.memory.freeFrame(pte.frame);
      } else {
        this.cowRefCount.set(pte.frame, remaining);
        if (remaining === 1) this.restoreSingleWriter(pte.frame);
      }
    }
  }

  private restoreSingleWriter(frame: FrameId): void {
    this.ctx.table.forEachAscending(pcb => {
      for (const pte of this.ctx.memory.pageTables.get(pcb.addressSpaceId) ?? []) {
        if (pte.valid && pte.frame === frame) pte.writable = true;
      }
    });
  }
}
