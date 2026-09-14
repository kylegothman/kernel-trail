import type { EmittableEvent } from '../EventBus';
import type { CowCapacity } from '../process/lifecycle';
import type { SharedMapping } from '../process/ipc';
import type {
  AddressSpaceId, Frame, FrameId, MemoryContext, PageId, PageReplacementId, Pid, ProcessControlBlock,
  Rng, TerminationReason, Tick, VmDemandState, VmSettingsSnapshot, VmSnapshotState, VmThrashingState, StorageResultSnapshot,
} from '../types';
import { asPageId, asTick } from '../types';
import { memoryArray, memoryBoolean, memoryInteger, memoryObject } from './FrameTable';
import type { MemorySubsystem } from './MemorySubsystem';
import { createReplacementPolicy, type PersistentReplacementPolicy } from './replacement/registry';
import { WorkingSetModel } from './workingSet';
import { nextFaultAccumulator, ThrashingController } from './thrashing';
import { framesPerProcess } from './rations';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Request = Mutable<VmDemandState['requests'][number]>;
type Reference = Mutable<VmDemandState['references'][number]>;
type VmPayload = VmSnapshotState['payload'];
type SavedVm = Pick<VmPayload, 'enabled' | 'settings' | 'replacement' | 'demand' | 'counters' | 'workingSets' | 'thrashing' | 'controls'>;
export type SuspendedProcess = VmThrashingState['suspended'][number];
export interface VmHost {
  tick(): Tick;
  process(pid: Pid): Readonly<ProcessControlBlock> | undefined;
  processes(): readonly Readonly<ProcessControlBlock>[];
  emit(event: EmittableEvent): void;
  terminate?(pid: Pid, reason: TerminationReason): void;
  suspend?(pid: Pid, tick: Tick, untilTick: Tick): SuspendedProcess;
  resume?(record: SuspendedProcess): void;
  futureReferences?(pid: Pid): readonly PageId[] | null;
  sharedMapping?(pid: Pid, page: PageId): SharedMapping | undefined;
  accessKey?(pid: Pid): string | undefined;
  onEvicted?(frame: FrameId): void;
  refuseOptimal?(): void;
}
export interface PagingStorageRequest {
  readonly requestId: number;
  readonly kind: 'read' | 'write';
  readonly pid: Pid;
  readonly page: PageId;
  readonly frame: FrameId;
  readonly completeAt: Tick;
  /** Completion-aware adapters receive the actual backing ASID and page. */
  readonly space?: AddressSpaceId;
}
export interface PagingStorage {
  enqueue(request: PagingStorageRequest): void;
  result?(requestId: number, kind: 'read' | 'write'): StorageResultSnapshot | null;
  has?(requestId: number, kind: 'read' | 'write'): boolean;
  acknowledge?(requestId: number, kind: 'read' | 'write'): void;
  cancel?(requestId: number): void;
  reassign?(requestId: number, pid: Pid): void;
}

/** EAT = (1 - p) * ma + p * faultServiceNs. */
export function demandPagingEat(p: number, ma = 200, faultServiceNs = 8e6): number {
  if (!Number.isFinite(p) || p < 0 || p > 1 || !Number.isFinite(ma) || ma < 0
    || !Number.isFinite(faultServiceNs) || faultServiceNs < 0) throw new RangeError('invalid demand paging access time');
  return (1 - p) * ma + p * faultServiceNs;
}

/** Fault service has its own queue; Kernel emits a major fault before this queue runs. */
export class DemandPager {
  readonly workingSets: WorkingSetModel;
  readonly control: ThrashingController;
  policy: PersistentReplacementPolicy;
  private requests: Request[] = [];
  private readonly references = new Map<string, Reference>();
  private readonly sharedTouches = new Map<string, VmDemandState['sharedTouches'][number]>();
  private readonly credits = new Map<Pid, number>();
  private readonly remaps = new Map<Pid, Map<PageId, PageId>>();
  private nextRequestId = 0;
  private pageFaults = 0;
  private majorFaults = 0;
  private evictions = 0;
  private writeBacks = 0;
  private faultsThisTick = 0;
  private faultAccumulator = 0;
  private lastMetricsTick: Tick | null = null;
  private ownEmission = false;
  private storage: PagingStorage = {
    // Timed paging remains the default; physical backing requires explicit attachment.
    enqueue: () => {},
  };

  constructor(readonly memory: MemorySubsystem, readonly host: VmHost, readonly rng: Rng,
    readonly settings: VmSettingsSnapshot, readonly enabled: boolean, degree: number) {
    this.policy = createReplacementPolicy(memory.config.replacementPolicy, { lfuAging: settings.lfuAging });
    this.policy.reset(memory.frameTable.frames);
    this.workingSets = new WorkingSetModel(settings.workingSetWindow, rng);
    this.control = new ThrashingController(settings, memory.config.totalFrames, degree, {
      suspend: (pid, tick, until) => {
        if (host.suspend === undefined) throw new Error('memory suspension requires a process host');
        const saved = host.suspend(pid, tick, until);
        this.swapOut(pid); return saved;
      },
      resume: record => { if (host.resume === undefined) throw new Error('memory recovery requires a process host'); host.resume(record); },
      terminate: pid => this.fail(pid, 'thrashing_collapse'),
      emit: (severity, faultRate) => this.emit({ type: 'memory.thrashing', severity, faultRate }),
      panic: pid => this.emit({ type: 'kernel.panic', message: `thrashing collapse: ${pid}` }),
      resizeBudget: (pid, target) => this.resizeBudget(pid, target),
    });
  }

  setStorage(storage: PagingStorage | undefined, restoring = false): void {
    if (!restoring && storage?.result !== undefined && this.requests.length > 0) throw new Error('attach paging storage before pending faults');
    this.storage = storage ?? { enqueue: () => {} };
  }
  setPolicy(id: PageReplacementId): void {
    const next = createReplacementPolicy(id, { lfuAging: this.settings.lfuAging });
    next.reset(this.memory.frameTable.frames); next.bindContext(this.context()); this.policy = next;
  }
  context(pid?: Pid, forceLocal = false): MemoryContext {
    const pcb = pid === undefined ? undefined : this.host.process(pid);
    const future = pid === undefined ? null : this.host.futureReferences?.(pid) ?? null;
    const refs = future === null || pid === undefined ? future : future.map(page => this.resolvePage(pid, page));
    return this.memory.context(this.rng, refs, pcb?.addressSpaceId, forceLocal);
  }
  isReserved(frame: FrameId): boolean {
    return this.requests.some(request => request.frame === frame || request.sourceFrame === frame)
      || [...this.references.values()].some(reference => reference.loaded && reference.fault !== 'none'
        && this.memory.pageTables.get(reference.space, reference.page)?.frame === frame);
  }
  admit(pcb: Readonly<ProcessControlBlock>): void {
    if (!this.enabled || pcb.pid <= 1) return;
    this.workingSets.admit(pcb.pid, this.host.tick());
    const active = this.host.processes().filter(p => p.pid > 1 && !['zombie', 'terminated'].includes(p.state)
      && (p.pid === pcb.pid || this.control.frameBudget(p.pid) !== undefined) && !this.control.isSuspended(p.pid));
    this.control.admit(pcb.pid, this.host.tick(), this.quota(pcb, active));
    this.rebudget();
  }
  private quota(pcb: Readonly<ProcessControlBlock>, active: readonly Readonly<ProcessControlBlock>[]): number {
    const policy = this.memory.framePolicy;
    const count = this.memory.pageTables.pageTable(pcb.addressSpaceId).size;
    const total = active.reduce((sum, p) => sum + this.memory.pageTables.pageTable(p.addressSpaceId).size, 0);
    return framesPerProcess(policy.rations, this.memory.config.totalFrames, Math.max(1, active.length), {
      allocationScheme: policy.allocationScheme, pageCount: count, totalPageCount: Math.max(1, total),
    });
  }
  /** Membership changes recompute fixed quotas; explicit policy changes also reset PFF targets. */
  rebudget(force = false): void {
    if (!this.enabled || (this.settings.thrashingControl === 'pff' && !force)) return;
    const active = this.host.processes().filter(p => p.pid > 1 && !['zombie', 'terminated'].includes(p.state)
      && this.control.frameBudget(p.pid) !== undefined && !this.control.isSuspended(p.pid));
    for (const pcb of active) {
      const budget = this.quota(pcb, active);
      if (budget !== this.control.frameBudget(pcb.pid)) {
        this.resizeBudget(pcb.pid, budget); this.control.setFrameBudget(pcb.pid, budget);
      }
    }
  }
  resolvePage(pid: Pid, page: PageId): PageId { return this.remaps.get(pid)?.get(page) ?? page; }
  begin(pid: Pid, page: PageId, write: boolean): Reference {
    const pcb = this.host.process(pid);
    if (pcb === undefined) throw new Error('unknown memory process');
    if (this.control.frameBudget(pid) === undefined) this.admit(pcb);
    const key = this.host.accessKey?.(pid) ?? `direct:${pid}`;
    const existing = this.references.get(key);
    if (existing?.pid === pid && existing.page === page && existing.write === write) return existing;
    const reference: Reference = { key, pid, space: pcb.addressSpaceId, page, write, requestId: null, fault: 'none', loaded: false };
    this.references.set(key, reference); this.workingSets.push(pid, page);
    return reference;
  }
  finish(pid: Pid): void { this.references.delete(this.host.accessKey?.(pid) ?? `direct:${pid}`); }
  reference(pid: Pid): Reference | undefined { return this.references.get(this.host.accessKey?.(pid) ?? `direct:${pid}`); }
  observe(event: EmittableEvent): void {
    if (!this.enabled || this.ownEmission) return;
    this.count(event);
    if (event.type === 'memory.page_loaded') {
      const pcb = this.host.process(event.pid);
      if (pcb !== undefined) {
        this.noteLoad(event.pid, event.page, event.frame);
        this.requests = this.requests.filter(request => !(request.kind === 'cow' && request.pid === event.pid && request.page === event.page));
      }
    }
  }
  private count(event: EmittableEvent): void {
    if (event.type === 'memory.page_fault') {
      this.pageFaults += 1; this.majorFaults += Number(event.major); this.faultsThisTick += 1;
      const pcb = this.host.process(event.pid);
      if (pcb !== undefined && this.control.frameBudget(event.pid) === undefined) this.admit(pcb);
      this.control.recordFault(event.pid, this.host.tick());
    } else if (event.type === 'memory.page_evicted') this.evictions += 1;
  }
  private emit(event: EmittableEvent): void {
    this.count(event); this.ownEmission = true;
    try { this.host.emit(event); } finally { this.ownEmission = false; }
  }
  private fail(pid: Pid, reason: TerminationReason): void {
    if (this.host.terminate === undefined) throw new Error(`memory termination requires a process host: ${reason}`);
    this.host.terminate(pid, reason);
  }
  private noSpace(pid: Pid): void {
    this.emit({ type: 'memory.allocation_failed', pid, requested: 1, reason: 'no_space' }); this.fail(pid, 'out_of_memory');
  }
  checkProtection(pid: Pid, page: PageId, write: boolean): boolean {
    const pcb = this.host.process(pid); if (pcb === undefined) return false;
    const pte = this.memory.pageTables.get(pcb.addressSpaceId, page);
    if (pte !== undefined && ((!write && pte.readable) || (write && pte.writable))) return true;
    this.emit({ type: 'security.access_denied', domain: pcb.domain, object: `page:${page}`, right: write ? 'write' : 'read' });
    this.fail(pid, 'protection_fault'); return false;
  }
  sharedMapped(pid: Pid, mapping: SharedMapping): void { this.sharedTouches.delete(`${pid}:${mapping.space}:${mapping.page}`); }
  sharedUnmapped(pid: Pid, mapping: SharedMapping): void {
    this.sharedMapped(pid, mapping);
    for (const [key, reference] of this.references) if (reference.pid === pid && reference.page === mapping.page) this.references.delete(key);
    for (const request of [...this.requests]) if (request.pid === pid && request.page === mapping.page) this.transferOrCancel(request);
  }
  private backing(pid: Pid, space: AddressSpaceId, page: PageId) {
    const mapping = this.host.sharedMapping?.(pid, page);
    return { space: mapping?.backingSpace ?? space, page: mapping?.backingPage ?? page, shared: mapping !== undefined };
  }
  private waiters(request: Request): Reference[] {
    return [...this.references.values()].filter(reference => reference.requestId === request.id)
      .sort((a, b) => a.pid - b.pid || a.page - b.page || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  private transferOrCancel(request: Request): void {
    const next = request.kind === 'major' ? this.waiters(request).find(reference => {
      const pcb = this.host.process(reference.pid);
      return pcb !== undefined && !['zombie', 'terminated'].includes(pcb.state);
    }) : undefined;
    if (next === undefined) { this.cancel(request); return; }
    request.pid = next.pid; request.space = next.space; request.page = next.page; request.write = next.write;
    this.storage.reassign?.(request.id, next.pid);
  }
  sharedFirstTouch(pid: Pid, page: PageId): boolean {
    const mapping = this.host.sharedMapping?.(pid, page); if (mapping === undefined) return false;
    const key = `${pid}:${mapping.space}:${page}`; if (this.sharedTouches.has(key)) return false;
    const pte = this.memory.pageTables.get(mapping.space, page);
    if (pte?.valid !== true || pte.frame === null) return false;
    this.sharedTouches.set(key, { pid, space: mapping.space, page });
    const reference = this.reference(pid); if (reference !== undefined) reference.fault = 'minor';
    this.emit({ type: 'memory.page_fault', pid, page, major: false });
    this.noteLoad(pid, page, pte.frame, true);
    this.emit({ type: 'memory.page_loaded', pid, page, frame: pte.frame }); return true;
  }
  fault(pid: Pid, page: PageId, write: boolean): { readonly hit: boolean } {
    const reference = this.reference(pid) ?? this.begin(pid, page, write);
    const mapping = this.host.sharedMapping?.(pid, page);
    const space = mapping?.backingSpace ?? reference.space; const backingPage = mapping?.backingPage ?? page;
    const retained = this.memory.frameTable.reclaim(space, backingPage);
    if (retained !== null) {
      reference.fault = 'minor'; this.emit({ type: 'memory.page_fault', pid, page, major: false });
      this.memory.installFrame(space, backingPage, retained, mapping !== undefined);
      this.noteLoad(pid, page, retained);
      if (mapping !== undefined) this.sharedTouches.set(`${pid}:${reference.space}:${page}`, { pid, space: reference.space, page });
      this.emit({ type: 'memory.page_loaded', pid, page, frame: retained });
      return { hit: true };
    }
    const old = this.requests.find(request => {
      if (request.kind !== 'major') return false;
      const target = this.backing(request.pid, request.space, request.page);
      return target.space === space && target.page === backingPage;
    });
    if (old !== undefined) { reference.fault = 'major'; reference.requestId = old.id; return { hit: false }; }
    const request: Request = { id: this.nextRequestId++, kind: 'major', pid, space: reference.space, page, write,
      faultTick: this.host.tick(), phase: 'queued', dueTick: null, frame: null, sourceFrame: null, victim: null };
    reference.fault = 'major'; reference.requestId = request.id; this.requests.push(request);
    return { hit: false };
  }
  prepareCow(pid: Pid, page: PageId, source: FrameId): CowCapacity {
    const pcb = this.host.process(pid); if (pcb === undefined) return { state: 'failed' };
    const reference = this.begin(pid, page, true); reference.fault = 'minor';
    const old = this.requests.find(request => request.kind === 'cow' && request.pid === pid && request.page === page);
    if (old !== undefined) {
      return old.phase === 'copy' && old.frame !== null
        ? { state: 'ready', frame: old.frame, reported: true } : { state: 'pending', reported: true };
    }
    if (this.memory.frameTable.available > 0) {
      const frame = this.memory.allocateFrame(pcb.addressSpaceId, page);
      return frame === null ? { state: 'failed' } : { state: 'ready', frame, reported: false };
    }
    const request: Request = { id: this.nextRequestId++, kind: 'cow', pid, space: pcb.addressSpaceId, page, write: true,
      faultTick: this.host.tick(), phase: 'queued', dueTick: null, frame: null, sourceFrame: source, victim: null };
    reference.requestId = request.id; this.requests.push(request); return { state: 'pending', reported: false };
  }
  cowReady(pid: Pid, page: PageId): boolean | undefined {
    const request = this.requests.find(item => item.kind === 'cow' && item.pid === pid && item.page === page);
    return request === undefined ? undefined : request.phase === 'copy';
  }
  private noteLoad(pid: Pid, page: PageId, frame: FrameId, alias = false): void {
    const pcb = this.host.process(pid); if (pcb === undefined) return;
    const pte = this.memory.pageTables.get(pcb.addressSpaceId, page);
    const live = this.memory.frameTable.frames[frame]; if (pte === undefined || live === undefined) throw new Error('loaded page disappeared');
    const context = this.context(pid);
    if (!alias && live.owner !== null && live.page !== null) {
      this.policy.onLoad(live.owner, live.page, frame, context); this.policy.onAccess(live.owner, live.page, frame, context);
    }
    if (alias || live.owner !== pcb.addressSpaceId || live.page !== page) {
      pte.accessCount = 0; this.policy.onAccess(pcb.addressSpaceId, page, frame, context);
    }
    pte.referenced = true; pte.lastAccessTick = this.host.tick(); live.referenceBit = true;
    for (const reference of this.references.values()) if (reference.pid === pid && reference.page === page) {
      reference.loaded = true; reference.requestId = null;
    }
  }
  accessed(pid: Pid, page: PageId, frame: FrameId): void {
    const reference = this.reference(pid); const pcb = this.host.process(pid);
    if (pcb !== undefined && !reference?.loaded) {
      this.policy.onAccess(pcb.addressSpaceId, page, frame, this.context(pid));
      if (reference !== undefined) reference.loaded = true;
    }
  }
  private evict(frame: FrameId): Request['victim'] {
    const live = this.memory.frameTable.frames[frame];
    if (live === undefined || live.owner === null || live.page === null || live.pinned || this.isReserved(frame)) throw new Error('ineligible replacement victim');
    const victim = { space: live.owner, page: live.page, dirty: false, policy: this.policy.id };
    this.host.onEvicted?.(frame);
    for (const space of this.memory.pageTables.spaces()) for (const pte of this.memory.pageTables.pageTable(space).values()) {
      if (pte.valid && pte.frame === frame) {
        this.memory.invalidatePendingAccess(space, pte.page);
        for (const reference of this.references.values()) if (reference.space === space && reference.page === pte.page) reference.loaded = false;
        victim.dirty ||= pte.dirty; pte.frame = null; pte.valid = false; pte.swapped = true;
        pte.dirty = false; pte.referenced = false; pte.accessCount = 0;
      }
    }
    this.memory.tlb.shootdown(frame); this.memory.frameTable.free(frame, true);
    this.emit({ type: 'memory.page_evicted', frame, page: victim.page, dirty: victim.dirty, policy: victim.policy });
    return victim;
  }
  expireTimers(tick: Tick): void {
    this.policy.advanceTick(this.context());
    for (const request of [...this.requests]) {
      if (!this.requests.includes(request)) continue;
      const pcb = this.host.process(request.pid);
      if (pcb === undefined || ['terminated', 'zombie'].includes(pcb.state)) {
        for (const [key, reference] of this.references) if (reference.pid === request.pid) this.references.delete(key);
        this.transferOrCancel(request); if (!this.requests.includes(request)) continue;
      }
      if (request.kind === 'cow' && this.memory.pageTables.get(request.space, request.page)?.writable === true) { this.cancel(request); continue; }
      if (request.phase === 'queued' && tick > request.faultTick) this.start(request);
      if (!this.requests.includes(request) || request.dueTick === null) continue;
      if (this.storage.result !== undefined) continue; // Physical completions belong to phase 2.
      if (request.phase === 'write_back') {
        const writtenAt = this.serviceBase(request) + this.settings.majorFaultTicks;
        if (tick < writtenAt) continue;
        if (request.kind === 'cow') { request.phase = 'copy'; continue; }
        request.phase = 'read';
        // dueTick is the final completion deadline, preserving a prefetch credit
        // through write-back and restore without adding transient callback state.
        if (request.dueTick > writtenAt) this.enqueue(request, 'read');
      }
      if (request.phase === 'read' && tick >= request.dueTick) this.complete(request);
    }
  }
  /** Called after physical media service in phase 2; the original VM deadline is a floor. */
  serviceStorageCompletions(tick: Tick): void {
    if (this.storage.result === undefined) return;
    const ready = (request: Request, kind: 'read' | 'write'): boolean => {
      if (this.storage.has?.(request.id, kind) === false) return true; // Prefetch supplied this stage.
      const result = this.storage.result?.(request.id, kind);
      if (result === null || result === undefined) return false;
      this.storage.acknowledge?.(request.id, kind);
      if (result.kind === 'failed') {
        const peers = new Set([request.pid, ...this.waiters(request).map(reference => reference.pid)]);
        this.cancel(request);
        for (const pid of peers) this.fail(pid, result.reason === 'io_timeout' ? 'io_timeout' : 'storage_corruption');
        return false;
      }
      return true;
    };
    for (const request of [...this.requests]) {
      if (!this.requests.includes(request)) continue;
      if (request.dueTick === null) continue;
      if (request.phase === 'write_back') {
        const writtenAt = this.serviceBase(request) + this.settings.majorFaultTicks;
        if (tick < writtenAt || !ready(request, 'write')) continue;
        if (request.kind === 'cow') { request.phase = 'copy'; continue; }
        request.phase = 'read';
        if (request.dueTick > writtenAt) this.enqueue(request, 'read');
      }
      if (this.requests.includes(request) && request.phase === 'read' && tick >= request.dueTick && ready(request, 'read')) this.complete(request);
    }
  }
  private serviceBase(request: Request): number {
    const reservedAt = request.frame === null ? undefined : this.memory.frameTable.frames[request.frame]?.loadedAtTick;
    return Math.max(request.faultTick, (reservedAt ?? request.faultTick + 1) - 1);
  }
  private temporaryCapacity(request: Request): boolean {
    const scope = this.memory.framePolicy.replacementScope;
    return this.memory.frameTable.frames.some(frame => frame.owner !== null && !frame.pinned
      && (scope === 'global' || frame.owner === request.space)
      && (this.requests.some(other => other !== request && (other.frame === frame.id || other.sourceFrame === frame.id))
        || [...this.references.values()].some(reference => reference.loaded && reference.fault !== 'none'
          && this.memory.pageTables.get(reference.space, reference.page)?.frame === frame.id)));
  }
  private ensurePolicy(context: MemoryContext): void {
    if (this.policy.id !== 'optimal' || context.futureReferences !== null) return;
    if (this.host.refuseOptimal === undefined) throw new Error('optimal replacement requires future references');
    this.host.refuseOptimal();
    if (this.policy.id === 'optimal') throw new Error('optimal replacement requires future references');
  }
  private start(request: Request): void {
    const budget = this.control.frameBudget(request.pid) ?? this.memory.config.totalFrames;
    const atLocalBudget = request.kind === 'major' && this.memory.framePolicy.replacementScope === 'local'
      && this.ownedFrames(request.pid).length >= budget;
    if (this.memory.frameTable.available === 0 || atLocalBudget) {
      const context = this.context(request.pid);
      if (context.frames.length === 0 && this.temporaryCapacity(request)) return;
      this.ensurePolicy(context);
      let victim: FrameId;
      try { victim = this.policy.selectVictim(context); }
      catch { const peers = this.waiters(request).map(reference => reference.pid); this.cancel(request);
        for (const pid of new Set(peers.length === 0 ? [request.pid] : peers)) this.noSpace(pid);
        return;
      }
      request.victim = this.evict(victim);
    }
    const target = this.backing(request.pid, request.space, request.page);
    request.frame = this.memory.allocateFrame(target.space, target.page);
    if (request.frame === null) { this.cancel(request); this.noSpace(request.pid); return; }
    const credit = request.kind === 'major' ? this.credits.get(request.pid) ?? 0 : 0;
    if (credit > 0) this.credits.set(request.pid, credit - 1);
    const base = this.serviceBase(request);
    if (request.victim?.dirty) {
      request.phase = 'write_back';
      request.dueTick = asTick(base + this.settings.majorFaultTicks * (request.kind === 'cow' || credit > 0 ? 1 : 2));
      this.writeBacks += 1; this.enqueue(request, 'write');
    } else if (request.kind === 'cow') { request.phase = 'copy'; request.dueTick = this.host.tick(); }
    else {
      request.phase = 'read'; request.dueTick = credit > 0 ? this.host.tick() : asTick(base + this.settings.majorFaultTicks);
      if (credit === 0) this.enqueue(request, 'read');
    }
  }
  private enqueue(request: Request, kind: 'read' | 'write'): void {
    if (request.frame === null || request.dueTick === null) throw new Error('paging request has no reservation');
    const submission: PagingStorageRequest = { requestId: request.id, kind, pid: request.pid,
      page: kind === 'write' ? request.victim?.page ?? request.page : request.page, frame: request.frame,
      completeAt: kind === 'write' ? asTick(this.serviceBase(request) + this.settings.majorFaultTicks) : request.dueTick };
    const backing = kind === 'write' && request.victim !== null ? request.victim : this.backing(request.pid, request.space, request.page);
    try { this.storage.enqueue(this.storage.result === undefined ? submission : { ...submission, space: backing.space, page: backing.page }); }
    catch (error) {
      if (this.storage.result === undefined || !(error instanceof RangeError)) throw error;
      const peers = new Set([request.pid, ...this.waiters(request).map(reference => reference.pid)]);
      this.cancel(request);
      for (const pid of peers) this.noSpace(pid);
    }
  }
  private complete(request: Request): void {
    if (request.frame === null) throw new Error('completed page has no frame');
    const target = this.backing(request.pid, request.space, request.page);
    const waiters = this.waiters(request);
    this.memory.installFrame(target.space, target.page, request.frame, target.shared);
    const groups = new Map<string, Reference[]>();
    for (const reference of waiters) {
      const key = `${reference.pid}:${reference.page}`; const group = groups.get(key) ?? [];
      group.push(reference); groups.set(key, group);
    }
    let installed = false;
    for (const references of groups.values()) {
      const first = references[0]; if (first === undefined) continue;
      this.noteLoad(first.pid, first.page, request.frame, installed); installed = true;
      for (let index = 1; index < references.length; index++) this.policy.onAccess(first.space, first.page, request.frame, this.context(first.pid));
      if (this.host.sharedMapping?.(first.pid, first.page) !== undefined) {
        this.sharedTouches.set(`${first.pid}:${first.space}:${first.page}`, { pid: first.pid, space: first.space, page: first.page });
      }
      this.emit({ type: 'memory.page_loaded', pid: first.pid, page: first.page, frame: request.frame });
    }
    this.requests = this.requests.filter(item => item !== request);
  }
  private cancel(request: Request): void {
    this.storage.cancel?.(request.id);
    if (request.frame !== null) this.memory.freeFrame(request.frame);
    this.requests = this.requests.filter(item => item !== request);
    for (const reference of this.references.values()) if (reference.requestId === request.id) reference.requestId = null;
  }
  remove(pid: Pid): void {
    for (const [key, reference] of this.references) if (reference.pid === pid) this.references.delete(key);
    for (const request of [...this.requests]) if (request.pid === pid) this.transferOrCancel(request);
    for (const [key, reference] of this.sharedTouches) if (reference.pid === pid) this.sharedTouches.delete(key);
    this.workingSets.remove(pid); this.control.remove(pid); this.credits.delete(pid); this.remaps.delete(pid); this.rebudget();
  }
  private swapOut(pid: Pid): void {
    const pcb = this.host.process(pid); if (pcb === undefined) return;
    for (const frame of [...this.memory.frameTable.unpinnedFrames()]) {
      if (this.memory.frameTable.frames[frame]?.owner === pcb.addressSpaceId && !this.isReserved(frame)) this.evict(frame);
    }
  }
  private ownedFrames(pid: Pid): Frame[] {
    const pcb = this.host.process(pid); if (pcb === undefined) return [];
    const retained = this.memory.frameTable.freePool;
    return this.memory.frameTable.frames.filter(frame => frame.owner === pcb.addressSpaceId && !retained.includes(frame.id));
  }
  private resizeBudget(pid: Pid, target: number): boolean {
    const pcb = this.host.process(pid); if (pcb === undefined) return false;
    if (target > this.ownedFrames(pid).length) return this.memory.frameTable.available > 0;
    while (this.ownedFrames(pid).length > target) {
      const own = this.context(pid, true);
      if (own.frames.length === 0) return false;
      this.ensurePolicy(own); this.evict(this.policy.selectVictim(own));
    }
    return true;
  }
  input() {
    const active = this.host.processes().filter(p => p.pid > 1 && !['new', 'zombie', 'terminated'].includes(p.state));
    const eligible = active.filter(p => !this.control.isSuspended(p.pid)).map(p => p.pid);
    return { faultRate: this.faultAccumulator * 1000 / 8, workingSets: this.workingSets.trueSizes(eligible),
      activePids: active.map(p => p.pid), freeFrames: this.memory.frameTable.available };
  }
  metrics() {
    const tick = this.host.tick();
    if (this.enabled && this.lastMetricsTick !== tick) {
      this.faultAccumulator = nextFaultAccumulator(this.faultAccumulator, this.faultsThisTick); this.faultsThisTick = 0;
      this.lastMetricsTick = tick;
      const input = this.input(); this.workingSets.updateNoise(tick, [...input.workingSets.keys()]);
      this.control.update(tick, input); this.rebudget();
    }
    const eligible = this.host.processes().filter(p => p.pid > 1 && !['new', 'zombie', 'terminated'].includes(p.state) && !this.control.isSuspended(p.pid)).map(p => p.pid);
    return { pageFaults: this.pageFaults, majorFaults: this.majorFaults, evictions: this.evictions,
      writeBacks: this.writeBacks, faultRate: this.faultAccumulator * 1000 / 8, workingSets: this.workingSets.reportedSizes(eligible) };
  }
  prefetch(pid: Pid, count: number): void { memoryInteger(count, 'prefetch count'); this.credits.set(pid, (this.credits.get(pid) ?? 0) + count); }
  remap(pid: Pid, localitySize: number): void {
    const pcb = this.host.process(pid); if (pcb === undefined) throw new Error('unknown process');
    const pages = [...this.memory.pageTables.pageTable(pcb.addressSpaceId).keys()].sort((a, b) => a - b);
    if (pages.length === 0) return;
    const targets = pages.slice(0, Math.min(localitySize, pages.length));
    this.remaps.set(pid, new Map(pages.map((page, index) => [page, targets[index % targets.length] ?? asPageId(0)])));
    this.workingSets.reset(pid); this.finish(pid);
  }
  setDegree(target: number): void { this.control.setDegree(target, this.host.tick(), this.input()); }
  saveState(): SavedVm {
    return { enabled: this.enabled, settings: { ...this.settings }, replacement: this.policy.saveState(),
      demand: { nextRequestId: this.nextRequestId, requests: this.requests.map(request => ({ ...request, victim: request.victim === null ? null : { ...request.victim } })),
        references: [...this.references.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(reference => ({ ...reference })),
        sharedTouches: [...this.sharedTouches.values()].sort((a, b) => a.pid - b.pid || a.space - b.space || a.page - b.page).map(value => ({ ...value })) },
      counters: { pageFaults: this.pageFaults, majorFaults: this.majorFaults, evictions: this.evictions, writeBacks: this.writeBacks,
        faultsThisTick: this.faultsThisTick, faultAccumulator: this.faultAccumulator, lastMetricsTick: this.lastMetricsTick },
      workingSets: this.workingSets.saveState(), thrashing: this.control.saveState(),
      controls: { prefetchCredits: [...this.credits].sort(([a], [b]) => a - b), localityRemaps: [...this.remaps].sort(([a], [b]) => a - b)
        .map(([pid, pages]) => ({ pid, pages: [...pages].sort(([a], [b]) => a - b) })) } };
  }
  prepareRestore(value: unknown, tick: Tick, frames: readonly Frame[], context: MemoryContext): () => void {
    const state = memoryObject(value, 'vm payload');
    if (memoryBoolean(state['enabled'], 'vm enabled') !== this.enabled) throw new Error('VM enabled configuration mismatch');
    const settings = memoryObject(state['settings'], 'VM settings');
    for (const key of Object.keys(this.settings) as (keyof VmSettingsSnapshot)[]) {
      if (settings[key] !== this.settings[key]) throw new Error(`VM setting mismatch: ${key}`);
    }
    const counters = memoryObject(state['counters'], 'VM counters');
    const counts = ['pageFaults', 'majorFaults', 'evictions', 'writeBacks', 'faultsThisTick', 'faultAccumulator'] as const;
    const count = Object.fromEntries(counts.map(key => [key, memoryInteger(counters[key], key)])) as Record<typeof counts[number], number>;
    if (count.majorFaults > count.pageFaults || count.faultsThisTick > count.pageFaults || count.writeBacks > count.evictions
      || count.faultAccumulator > 0x7fffffff) throw new Error('inconsistent VM counters');
    const last = counters['lastMetricsTick'] === null ? null : asTick(memoryInteger(counters['lastMetricsTick'], 'last metrics tick'));
    if (last !== null && last > tick) throw new Error('future VM metrics tick');
    const demand = memoryObject(state['demand'], 'demand state');
    const nextId = memoryInteger(demand['nextRequestId'], 'next paging request');
    const requests: Request[] = [];
    const ids = new Set<number>(); const reserved = new Set<FrameId>();
    const mappedFrames = new Set<FrameId>();
    const spaces = new Set(this.host.processes().map(pcb => pcb.addressSpaceId));
    for (const frame of frames) if (frame.owner !== null) spaces.add(frame.owner);
    for (const space of spaces) for (const pte of context.pageTable(space).values()) {
      if (pte.valid && pte.frame !== null) mappedFrames.add(pte.frame);
    }
    const parseFrame = (value: unknown): FrameId | null => {
      if (value === null) return null;
      const id = memoryInteger(value, 'request frame') as FrameId;
      if (frames[id]?.owner === null || frames[id] === undefined) throw new Error('request frame is not owned');
      return id;
    };
    for (const value of memoryArray(demand['requests'], 'paging requests')) {
      const row = memoryObject(value, 'paging request');
      const id = memoryInteger(row['id'], 'paging request id');
      if (id >= nextId || ids.has(id) || (requests.at(-1)?.id ?? -1) >= id) throw new Error('invalid paging request order'); ids.add(id);
      const kind = row['kind']; const phase = row['phase'];
      if ((kind !== 'major' && kind !== 'cow') || !['queued', 'write_back', 'read', 'copy'].includes(String(phase))) throw new Error('invalid paging request stage');
      const pid = memoryInteger(row['pid'], 'request pid', 2) as Pid;
      const space = memoryInteger(row['space'], 'request space') as AddressSpaceId;
      const page = memoryInteger(row['page'], 'request page') as PageId;
      const faultTick = asTick(memoryInteger(row['faultTick'], 'fault tick'));
      const dueTick = row['dueTick'] === null ? null : asTick(memoryInteger(row['dueTick'], 'request deadline'));
      const frame = parseFrame(row['frame']); const sourceFrame = parseFrame(row['sourceFrame']);
      const pcb = this.host.process(pid); const pte = context.pageTable(space).get(page);
      if (faultTick > tick || pcb?.addressSpaceId !== space || ['new', 'zombie', 'terminated'].includes(pcb.state)
        || pte === undefined || (dueTick !== null && dueTick < faultTick)
        || (phase === 'queued' ? frame !== null || dueTick !== null : frame === null || dueTick === null)
        || (kind === 'cow') !== (sourceFrame !== null)
        || (kind === 'major' && phase === 'copy') || (kind === 'cow' && phase === 'read')
        || (frame !== null && (reserved.has(frame) || mappedFrames.has(frame)))
        || (sourceFrame !== null && (sourceFrame === frame || pte.frame !== sourceFrame || !pte.valid || pte.writable))) {
        throw new Error('inconsistent paging request');
      }
      const target = this.backing(pid, space, page);
      if (frame !== null && (frames[frame]?.owner !== target.space || frames[frame]?.page !== target.page)) throw new Error('request reservation disagrees with backing page');
      if (requests.some(other => {
        if (other.kind !== kind) return false;
        const old = this.backing(other.pid, other.space, other.page);
        return kind === 'cow' ? other.pid === pid && other.page === page : old.space === target.space && old.page === target.page;
      })) throw new Error('duplicate pending backing request');
      if (frame !== null) reserved.add(frame);
      let victim: Request['victim'] = null;
      if (row['victim'] !== null) {
        const saved = memoryObject(row['victim'], 'paging victim');
        const policy = saved['policy'];
        if (!['fifo', 'lru', 'clock', 'optimal', 'lfu', 'random'].includes(String(policy))) throw new Error('invalid victim policy');
        victim = { space: memoryInteger(saved['space'], 'victim space') as AddressSpaceId,
          page: memoryInteger(saved['page'], 'victim page') as PageId, dirty: memoryBoolean(saved['dirty'], 'victim dirty'), policy: policy as PageReplacementId };
      }
      if (phase === 'write_back' && victim?.dirty !== true) throw new Error('write-back has no dirty victim');
      if (phase === 'queued' && victim !== null) throw new Error('queued request has an evicted victim');
      requests.push({ id, kind, pid, space, page, write: memoryBoolean(row['write'], 'request write'), faultTick,
        phase: phase as Request['phase'], dueTick, frame, sourceFrame, victim });
    }
    const references = new Map<string, Reference>();
    for (const value of memoryArray(demand['references'], 'logical references')) {
      const row = memoryObject(value, 'logical reference'); const key = row['key']; const fault = row['fault'];
      const pid = memoryInteger(row['pid'], 'reference pid', 2) as Pid;
      const space = memoryInteger(row['space'], 'reference space') as AddressSpaceId;
      const requestId = row['requestId'] === null ? null : memoryInteger(row['requestId'], 'reference request');
      if (typeof key !== 'string' || key.length === 0 || references.has(key) || this.host.process(pid)?.addressSpaceId !== space
        || !['none', 'minor', 'major'].includes(String(fault)) || (requestId !== null && !ids.has(requestId))) throw new Error('invalid logical reference');
      references.set(key, { key, pid, space, page: memoryInteger(row['page'], 'reference page') as PageId,
        write: memoryBoolean(row['write'], 'reference write'), requestId, fault: fault as Reference['fault'], loaded: memoryBoolean(row['loaded'], 'reference loaded') });
    }
    for (const reference of references.values()) {
      const pcb = this.host.process(reference.pid); const pte = context.pageTable(reference.space).get(reference.page);
      if (pcb === undefined || ['new', 'zombie', 'terminated'].includes(pcb.state) || pte === undefined) throw new Error('logical reference has no live page');
      if (reference.requestId === null) continue;
      const request = requests.find(item => item.id === reference.requestId)!;
      const target = this.backing(request.pid, request.space, request.page);
      const peer = this.backing(reference.pid, reference.space, reference.page);
      if (reference.loaded || reference.fault !== (request.kind === 'cow' ? 'minor' : 'major')
        || target.space !== peer.space || target.page !== peer.page
        || (request.kind === 'cow' && (reference.pid !== request.pid || reference.page !== request.page || !reference.write))) {
        throw new Error('logical reference disagrees with its paging request');
      }
    }
    for (const request of requests) {
      if (![...references.values()].some(reference => reference.requestId === request.id && reference.pid === request.pid && reference.page === request.page)) {
        throw new Error('paging request has no owning logical reference');
      }
    }
    if (this.enabled) for (const value of memoryArray(state['pending'], 'pending access costs')) {
      const pending = memoryObject(value, 'pending access cost'); const reference = references.get(String(pending['key']));
      if (reference === undefined || reference.pid !== pending['pid'] || reference.page !== pending['page']
        || reference.write !== pending['write'] || !reference.loaded || reference.requestId !== null) throw new Error('pending access cost has no loaded logical reference');
    }
    const touches = new Map<string, VmDemandState['sharedTouches'][number]>();
    for (const value of memoryArray(demand['sharedTouches'], 'shared touches')) {
      const row = memoryObject(value, 'shared touch'); const pid = memoryInteger(row['pid'], 'shared pid', 2) as Pid;
      const space = memoryInteger(row['space'], 'shared space') as AddressSpaceId; const page = memoryInteger(row['page'], 'shared page') as PageId;
      const key = `${pid}:${space}:${page}`;
      if (touches.has(key) || this.host.process(pid)?.addressSpaceId !== space) throw new Error('invalid shared first-touch state');
      touches.set(key, { pid, space, page });
    }
    const controls = memoryObject(state['controls'], 'VM controls');
    const credits = new Map<Pid, number>();
    for (const value of memoryArray(controls['prefetchCredits'], 'prefetch credits')) {
      const row = memoryArray(value, 'prefetch entry'); const pid = memoryInteger(row[0], 'prefetch pid', 2) as Pid;
      if (row.length !== 2 || credits.has(pid) || this.host.process(pid) === undefined) throw new Error('invalid prefetch credits');
      credits.set(pid, memoryInteger(row[1], 'prefetch count'));
    }
    const remaps = new Map<Pid, Map<PageId, PageId>>();
    for (const value of memoryArray(controls['localityRemaps'], 'locality remaps')) {
      const row = memoryObject(value, 'locality remap'); const pid = memoryInteger(row['pid'], 'remap pid', 2) as Pid;
      const pcb = this.host.process(pid); if (pcb === undefined || remaps.has(pid)) throw new Error('invalid remap process');
      const pages = new Map<PageId, PageId>();
      for (const value of memoryArray(row['pages'], 'remap pages')) {
        const pair = memoryArray(value, 'remap pair'); const from = memoryInteger(pair[0], 'source page') as PageId;
        const to = memoryInteger(pair[1], 'target page') as PageId;
        if (pair.length !== 2 || pages.has(from) || !context.pageTable(pcb.addressSpaceId).has(from)
          || !context.pageTable(pcb.addressSpaceId).has(to)) throw new Error('invalid remapped page');
        pages.set(from, to);
      }
      remaps.set(pid, pages);
    }
    const replacementInput = memoryObject(state['replacement'], 'replacement state');
    // The commit must not reread mutable caller-owned JSON after other slots commit.
    const replacement: Record<string, unknown> = { ...replacementInput, order: [...memoryArray(replacementInput['order'], 'replacement order')] };
    const policyId = replacement['policy'];
    if (!['fifo', 'lru', 'clock', 'optimal', 'lfu', 'random'].includes(String(policyId))) throw new Error('invalid replacement policy');
    const nextPolicy = createReplacementPolicy(policyId as PageReplacementId, { lfuAging: this.settings.lfuAging });
    // Validate detached state first; the commit below binds the already-validated
    // shape to the live dense table after MemorySubsystem commits its frame data.
    nextPolicy.prepareRestore(replacement, frames, context);
    const commitSets = this.workingSets.prepareRestore(state['workingSets']);
    const commitControl = this.control.prepareRestore(state['thrashing']);
    const ws = memoryObject(state['workingSets'], 'working sets');
    const wsPids = new Set<Pid>();
    for (const value of memoryArray(ws['processes'], 'working-set processes')) {
      const row = memoryObject(value, 'working-set process');
      const pid = row['pid'] as Pid; const pcb = this.host.process(pid);
      if (pcb === undefined || ['new', 'zombie', 'terminated'].includes(pcb.state)) throw new Error('unknown working-set process');
      wsPids.add(pid);
      if ((row['nextNoiseTick'] as number) > Math.max(10, (Math.floor(tick / 10) + 1) * 10)) throw new Error('future working-set noise cadence');
      for (const page of memoryArray(row['references'], 'working-set pages')) {
        if (!context.pageTable(pcb.addressSpaceId).has(page as PageId)) throw new Error('working set refers to an unknown page');
      }
    }
    const control = memoryObject(state['thrashing'], 'thrashing state');
    if ((control['healthyTicks'] as number) > tick + 1) throw new Error('future recovery clock');
    const pffPids = new Set<Pid>();
    for (const value of memoryArray(control['pff'], 'PFF processes')) {
      const row = memoryObject(value, 'PFF process'); const pid = row['pid'] as Pid;
      if (!wsPids.has(pid)) throw new Error('PFF process has no working-set state');
      pffPids.add(pid);
      if ((row['nextAdjustmentTick'] as number) > tick + this.settings.thrashingSuspendInterval) throw new Error('future PFF control clock');
      for (const sample of memoryArray(row['faultTicks'], 'PFF samples')) {
        if ((memoryArray(sample, 'PFF sample')[0] as number) > tick) throw new Error('future PFF fault sample');
      }
    }
    if (pffPids.size !== wsPids.size) throw new Error('working-set and PFF membership differ');
    for (const reference of references.values()) if (!wsPids.has(reference.pid)) throw new Error('logical reference has no admitted working set');
    for (const value of memoryArray(control['suspended'], 'suspended processes')) {
      const row = memoryObject(value, 'suspended process'); const pid = row['pid'] as Pid;
      const pcb = this.host.process(pid);
      if (pcb?.state !== 'waiting' || pcb.blockedOn?.kind !== 'sleep' || pcb.blockedOn.untilTick !== row['untilTick']
        || (row['suspendedAt'] as number) > tick) throw new Error('suspension disagrees with the process wait');
      const tids = memoryArray(row['threads'], 'suspended threads').map(value => memoryObject(value, 'suspended thread')['tid'] as number);
      const expected = [...pcb.threads].sort((a, b) => a - b);
      if (tids.length !== expected.length || tids.some((tid, index) => tid !== expected[index])) throw new Error('suspension thread membership disagrees with the process');
    }
    return () => {
      const liveContext: MemoryContext = { ...context, frames: this.memory.frameTable.frames,
        pageTable: space => this.memory.pageTables.pageTable(space) };
      nextPolicy.prepareRestore(replacement, this.memory.frameTable.frames, liveContext)();
      this.policy = nextPolicy; commitSets(); commitControl();
      this.nextRequestId = nextId; this.requests = requests;
      this.references.clear(); for (const [key, reference] of references) this.references.set(key, reference);
      this.sharedTouches.clear(); for (const [key, touch] of touches) this.sharedTouches.set(key, touch);
      this.credits.clear(); for (const [pid, amount] of credits) this.credits.set(pid, amount);
      this.remaps.clear(); for (const [pid, pages] of remaps) this.remaps.set(pid, pages);
      this.pageFaults = count.pageFaults; this.majorFaults = count.majorFaults; this.evictions = count.evictions;
      this.writeBacks = count.writeBacks; this.faultsThisTick = count.faultsThisTick; this.faultAccumulator = count.faultAccumulator; this.lastMetricsTick = last;
      this.policy.bindContext(this.context());
    };
  }
}
