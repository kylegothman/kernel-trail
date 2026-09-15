import { DemandPager, type VmHost } from './demandPaging';
import { createRng } from '../rng';
import type { CowCapacity } from '../process/lifecycle';
import type { SharedMapping } from '../process/ipc';
import { DEFAULT_TUNING, type KernelTuning } from '../config';
import type { MemoryHooks } from '../Kernel';
import type { EmittableEvent } from '../EventBus';
import type {
  AddressSpaceId, AllocationStrategy, BlockReason, FrameId, JsonValue, KernelConfig, KernelSnapshot,
  MemoryContext, MemoryMetrics, PageId, PageTableEntry, Pid, ProcessControlBlock, Rng,
  SubsystemEnvelope, Tick, MemorySnapshotState, VmSnapshotState, VmSettingsSnapshot, Frame,
} from '../types';
import { asFrameId, asPageId, asPid, asTick } from '../types';
import { FrameTable, memoryArray, memoryBoolean, memoryInteger, memoryObject, memorySpace } from './FrameTable';
import { PageTable } from './PageTable';
import { Tlb } from './Tlb';
import { HoleList } from './contiguous/HoleList';
import type { AllocationScheme, ReplacementScope, Rations } from './rations';
import { framesPerProcess } from './rations';
import { pagingFragmentation, contiguousFragmentation } from './fragmentation';

export interface MemoryHost extends VmHost {
  readonly rng?: Rng;
  tick(): Tick;
  process(pid: Pid): Readonly<ProcessControlBlock> | undefined;
  processes(): readonly Readonly<ProcessControlBlock>[];
  readonly pageTables: Map<AddressSpaceId, PageTableEntry[]>;
  emit(event: EmittableEvent): void;
  refreshSharedMappings?(): void;
  /** Undefined outside instruction execution; each thread has its own access. */
  accessKey?(pid: Pid): string | undefined;
  releaseAddressSpace?(space: AddressSpaceId): void;
}
export interface MemoryOptions {
  readonly contiguousBytes?: number;
  readonly minBlock?: number;
  readonly freePoolRetain?: number;
  readonly tuning?: Partial<KernelTuning>;
  readonly rations?: Rations;
  readonly allocationScheme?: AllocationScheme;
  readonly replacementScope?: ReplacementScope;
}
export interface DemandPagingHooks {
  /** Pending major faults return false; synchronous minor faults return true. */
  fault(pid: Pid, page: PageId, write: boolean): { readonly hit: boolean };
  expireTimers?(tick: Tick): void;
}
type PendingAccess = { pid: Pid; page: PageId; write: boolean; remaining: number; lastAttemptTick: Tick };

export type { MemorySnapshotState, VmSnapshotState } from '../types';

/** Memory owns translation and placement; lifecycle owns COW reference counts. */
export class MemorySubsystem implements MemoryHooks {
  readonly frameTable: FrameTable;
  readonly pageTables: PageTable;
  readonly tlb: Tlb;
  readonly holes: HoleList;
  readonly pager: DemandPager;
  readonly vmEnabled: boolean;
  private readonly candidates: Frame[] = [];
  private readonly localitySize: number;
  private readonly tuning: KernelTuning;
  private tlbHits = 0;
  private tlbMisses = 0;
  private nextContent = 0;
  private readonly timing: Pick<KernelTuning, 'tlbHitTicks' | 'tlbMissTicks'>;
  private readonly contents = new Map<FrameId, number>();
  private readonly requestedBytes = new Map<AddressSpaceId, number>();
  private readonly pending = new Map<string, PendingAccess>();
  private rations: Rations;
  private allocationScheme: AllocationScheme;
  private replacementScope: ReplacementScope;
  private demandPaging: DemandPagingHooks;

  constructor(readonly config: Readonly<KernelConfig>, private readonly host: MemoryHost, options: MemoryOptions = {}) {
    this.config = Object.freeze({ ...config });
    const tuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.tuning = tuning;
    this.localitySize = tuning.localitySize;
    this.vmEnabled = config.enabledSubsystems.includes('vm');
    this.timing = Object.freeze({ tlbHitTicks: tuning.tlbHitTicks, tlbMissTicks: tuning.tlbMissTicks });
    memoryInteger(this.timing.tlbHitTicks, 'TLB hit ticks', 1);
    memoryInteger(this.timing.tlbMissTicks, 'TLB miss ticks', 1);
    this.frameTable = new FrameTable(config.totalFrames, { freePoolRetain: options.freePoolRetain ?? 4, tick: () => host.tick() });
    this.pageTables = new PageTable(host.pageTables);
    this.tlb = new Tlb(config.tlbEntries, id => this.frameTable.frames[id]);
    const bytes = options.contiguousBytes ?? 2 ** Math.ceil(Math.log2(config.totalFrames * config.pageSize));
    this.holes = new HoleList(bytes, config.allocationStrategy, options.minBlock ?? Math.min(4096, bytes));
    this.rations = options.rations ?? 'standard';
    this.allocationScheme = options.allocationScheme ?? 'equal';
    this.replacementScope = options.replacementScope ?? 'local';
    const settings: VmSettingsSnapshot = {
      minorFaultTicks: tuning.minorFaultTicks, majorFaultTicks: tuning.majorFaultTicks,
      workingSetWindow: tuning.workingSetWindow, faultRateWindow: tuning.faultRateWindow, lfuAging: tuning.lfuAging,
      thrashingThreshold: config.thrashingThreshold, thrashingCriticalFaultMultiplier: tuning.thrashingCriticalFaultMultiplier,
      thrashingCriticalDemandRatio: tuning.thrashingCriticalDemandRatio, thrashingSuspendInterval: tuning.thrashingSuspendInterval,
      thrashingSuspendDuration: tuning.thrashingSuspendDuration, thrashingRecoveryTicks: tuning.thrashingRecoveryTicks,
      thrashingControl: tuning.thrashingControl, pffUpperBound: tuning.pffUpperBound, pffLowerBound: tuning.pffLowerBound,
    };
    this.pager = new DemandPager(this, host, host.rng ?? createRng(config.seed).fork('vm'), settings, this.vmEnabled, tuning.degreeOfMultiprogramming);
    this.demandPaging = this.vmEnabled ? this.pager : { fault: () => { throw new Error('virtual memory is disabled'); } };

  }

  setDemandPaging(hooks: DemandPagingHooks): void { this.demandPaging = hooks; }
  setAllocationStrategy(strategy: AllocationStrategy): void { this.holes.setStrategy(strategy); }
  get activeAllocationStrategy(): AllocationStrategy { return this.holes.strategy; }
  setFramePolicy(rations: Rations, scheme: AllocationScheme = 'equal', scope: ReplacementScope = 'local'): void {
    validatePolicy(rations, scheme, scope);
    this.rations = rations; this.allocationScheme = scheme; this.replacementScope = scope;
    if (this.vmEnabled) this.pager.rebudget(true);
  }
  get framePolicy() { return { rations: this.rations, allocationScheme: this.allocationScheme, replacementScope: this.replacementScope }; }

  expireTimers(tick: Tick): void {
    this.demandPaging.expireTimers?.(tick);
    this.pruneTlb();
  }
  admit(pcb: ProcessControlBlock): void {
    if (pcb.pid <= 1) return;
    const entries = this.pageTables.pageTable(pcb.addressSpaceId);
    if (this.vmEnabled) { this.requestedBytes.set(pcb.addressSpaceId, entries.size * this.config.pageSize); this.pager.admit(pcb); return; }
    const count = entries.size;
    if (count === 0) return;
    this.requestedBytes.set(pcb.addressSpaceId, count * this.config.pageSize);
    const active = this.host.processes().filter(process => process.pid > 1 && !['zombie', 'terminated'].includes(process.state));
    const totalPages = active.reduce((sum, process) => sum + this.pageTables.pageTable(process.addressSpaceId).size, 0);
    const budget = framesPerProcess(this.rations, this.config.totalFrames, Math.max(1, active.length), {
      allocationScheme: this.allocationScheme, pageCount: count, totalPageCount: totalPages,
    });
    const allocated: FrameId[] = [];
    let resident = [...entries.values()].filter(entry => entry.valid).length;
    for (const page of [...entries.keys()].sort((a, b) => a - b)) {
      if (resident >= budget) break;
      const entry = entries.get(page);
      if (entry?.valid) continue;
      const frame = this.loadPage(pcb.addressSpaceId, page);
      if (frame === null) break;
      resident += 1; allocated.push(frame);
    }
    if (allocated.length > 0) this.host.emit({ type: 'memory.allocated', pid: pcb.pid, frames: allocated, strategy: this.holes.strategy });
    if (resident === 0) this.host.emit({ type: 'memory.allocation_failed', pid: pcb.pid, requested: Math.min(count, budget), reason: 'no_space' });
  }

  access(pid: Pid, page: PageId, write: boolean): { readonly hit: boolean } {
    const pcb = this.host.process(pid);
    if (pcb === undefined || pcb.pid <= 1) throw new Error('memory access requires a user process');
    page = this.resolvePage(pid, page);
    const tick = this.host.tick();
    const key = this.host.accessKey?.(pid);
    let pending = key === undefined ? undefined : this.pending.get(key);
    if (pending !== undefined && this.vmEnabled && !this.pageTables.get(pcb.addressSpaceId, page)?.valid) {
      if (key !== undefined) this.pending.delete(key); pending = undefined;
    }
    if (pending !== undefined && pending.pid === pid && pending.page === page && pending.write === write) {
      if (tick > pending.lastAttemptTick) { pending.remaining -= 1; pending.lastAttemptTick = tick; }
      if (pending.remaining === 0 && key !== undefined) { this.pending.delete(key); if (this.vmEnabled) this.pager.finish(pid); }
      return { hit: true };
    }
    if (this.vmEnabled) {
      if (!this.pager.checkProtection(pid, page, write)) return { hit: false };
      this.pager.begin(pid, page, write);
    }
    const pte = this.pageTables.ensure(pcb.addressSpaceId, page);
    this.pruneTlb();
    const cached = this.tlb.lookup(pcb.addressSpaceId, page, tick);
    const tlbHit = cached !== null;
    if (tlbHit) this.tlbHits += 1;
    else {
      this.tlbMisses += 1;
      this.host.emit({ type: 'tlb.miss', pid, page });
    }
    const sharedMinor = this.vmEnabled && this.pager.sharedFirstTouch(pid, page);
    if (!pte.valid || pte.frame === null) {
      const result = this.demandPaging.fault(pid, page, write);
      if (!result.hit) return result;
    }
    const entry = this.pageTables.get(pcb.addressSpaceId, page);
    if (entry === undefined || !entry.valid || entry.frame === null) throw new Error('fault service returned success without a resident page');
    const frame = this.frameTable.frames[entry.frame];
    if (frame === undefined || frame.owner === null) throw new Error('resident page has no frame');
    entry.referenced = true; entry.dirty ||= write; entry.lastAccessTick = tick;
    if (this.vmEnabled) this.pager.accessed(pid, page, entry.frame); else entry.accessCount += 1;
    frame.referenceBit = true; frame.lastAccessTick = tick;
    if (!tlbHit) this.tlb.install(pcb.addressSpaceId, page, entry.frame, tick);
    this.host.emit({ type: 'memory.access', pid, page, write, hit: tlbHit });
    const fault = this.vmEnabled ? this.pager.reference(pid)?.fault : undefined;
    const cost = sharedMinor || fault === 'minor' ? this.pager.settings.minorFaultTicks : tlbHit ? this.timing.tlbHitTicks : this.timing.tlbMissTicks;
    if (cost > 1 && key !== undefined) this.pending.set(key, { pid, page, write, remaining: cost - 1, lastAttemptTick: tick });
    else if (this.vmEnabled) this.pager.finish(pid);
    return { hit: true };
  }

  /** The kernel gates instruction retirement separately from page availability. */
  invalidatePendingAccess(space: AddressSpaceId, page: PageId): void {
    for (const [key, pending] of this.pending) {
      if (pending.page === page && this.host.process(pending.pid)?.addressSpaceId === space) this.pending.delete(key);
    }
  }
  accessComplete(pid: Pid): boolean {
    const key = this.host.accessKey?.(pid);
    return key === undefined || !this.pending.has(key);
  }
  isSatisfied(pid: Pid, reason: BlockReason): boolean {
    const pcb = this.host.process(pid);
    if (reason.kind === 'page_fault' && this.vmEnabled) { const ready = this.pager.cowReady(pid, reason.page); if (ready !== undefined) return ready; }
    return reason.kind === 'page_fault' && pcb !== undefined
      && this.pageTables.get(pcb.addressSpaceId, reason.page)?.valid === true;
  }
  allocateFrame(space: AddressSpaceId, page: PageId): FrameId | null {
    const old = this.pageTables.get(space, page)?.frame;
    if (old !== undefined && old !== null) this.tlb.shootdown(old);
    const frame = this.frameTable.allocate(space, page, false);
    if (frame !== null) { this.tlb.shootdown(frame); this.contents.set(frame, this.nextContent++); }
    return frame;
  }
  loadPage(space: AddressSpaceId, page: PageId, pinned = false): FrameId | null {
    const entry = this.pageTables.ensure(space, page);
    if (entry.valid && entry.frame !== null) return entry.frame;
    const frame = this.allocateFrame(space, page);
    if (frame === null) return null;
    entry.frame = frame; entry.valid = true; entry.swapped = false;
    const live = this.frameTable.frames[frame];
    if (live !== undefined) live.pinned = pinned;
    this.host.refreshSharedMappings?.();
    return frame;
  }
  installFrame(space: AddressSpaceId, page: PageId, frame: FrameId, pinned = false): void {
    const entry = this.pageTables.ensure(space, page); const live = this.frameTable.frames[frame];
    if (live === undefined || live.owner === null) throw new Error('page-in requires a reserved frame');
    entry.frame = frame; entry.valid = true; entry.dirty = false; entry.swapped = false;
    entry.referenced = true; entry.lastAccessTick = this.host.tick(); entry.accessCount = 0;
    live.owner = space; live.page = page; live.pinned ||= pinned; live.loadedAtTick = this.host.tick();
    live.lastAccessTick = this.host.tick(); live.referenceBit = true;
    this.host.refreshSharedMappings?.();
  }
  prepareCow(pid: Pid, page: PageId, source: FrameId): CowCapacity {
    if (this.vmEnabled) return this.pager.prepareCow(pid, page, source);
    const pcb = this.host.process(pid); const frame = pcb === undefined ? null : this.allocateFrame(pcb.addressSpaceId, page);
    return frame === null ? { state: 'failed' } : { state: 'ready', frame, reported: false };
  }
  observeEvent(event: EmittableEvent): void { this.pager.observe(event); }
  resolvePage(pid: Pid, page: PageId): PageId { return this.vmEnabled ? this.pager.resolvePage(pid, page) : page; }
  sharedMapped(pid: Pid, mapping: SharedMapping): void { this.pager.sharedMapped(pid, mapping); }
  sharedUnmapped(pid: Pid, mapping: SharedMapping): void { this.pager.sharedUnmapped(pid, mapping); }
  setReplacementPolicy(id: import('../types').PageReplacementId): void { this.pager.setPolicy(id); }
  admissionAllowed(): boolean {
    return !this.vmEnabled || this.pager.control.admissionAllowed(this.host.processes().filter(p => p.pid > 1
      && !['new', 'zombie', 'terminated'].includes(p.state) && !this.pager.control.isSuspended(p.pid)).length);
  }
  isSuspended(pid: Pid): boolean { return this.vmEnabled && this.pager.control.isSuspended(pid); }
  prefetchNextFaults(pid: Pid, count: number): void { this.pager.prefetch(pid, count); }
  remapOptimalLocality(pid: Pid): void { this.pager.remap(pid, this.localitySize); }
  setDegreeOfMultiprogramming(target: number): void { this.pager.setDegree(target); }
  setWorkingSetPrecision(precise: boolean): void { this.pager.workingSets.setPrecision(precise); }
  freeFrame(frame: FrameId): void {
    this.tlb.shootdown(frame);
    this.contents.delete(frame);
    this.frameTable.discard(frame);
  }
  copyFrame(from: FrameId, to: FrameId): void {
    if (this.frameTable.frames[from]?.owner === null || this.frameTable.frames[to]?.owner === null
      || this.frameTable.frames[from] === undefined || this.frameTable.frames[to] === undefined) throw new Error('copy requires two allocated frames');
    let tag = this.contents.get(from);
    if (tag === undefined) { tag = this.nextContent++; this.contents.set(from, tag); }
    this.contents.set(to, tag);
    this.tlb.shootdown(to);
  }
  contentTag(frame: FrameId): number | undefined { return this.contents.get(frame); }
  flush(space?: AddressSpaceId): void { this.tlb.flush(space); }
  detachAddressSpace(space: AddressSpaceId): void {
    this.flush(space); this.requestedBytes.delete(space);
    for (const pcb of this.host.processes()) if (pcb.addressSpaceId === space) this.pager.remove(pcb.pid);
    for (const pcb of this.host.processes()) if (pcb.addressSpaceId === space) this.holes.free(pcb.pid);
    this.discardUnusedFrames(space);
    for (const [key, value] of this.pending) {
      if (this.host.process(value.pid)?.addressSpaceId === space) this.pending.delete(key);
    }
  }
  /**
   * Anonymous growth or shrink of one address space (WP-11 decision D5). Growth
   * appends invalid entries after the highest page, to be faulted in on demand,
   * and returns the first new page. Shrink removes the highest `current - pages`
   * entries, drops their translations and pending accesses, and returns the
   * removed entries so the caller can apply the copy-on-write release rule,
   * which lifecycle owns.
   */
  resizeAddressSpace(space: AddressSpaceId, pages: number): { readonly firstNewPage: PageId | null; readonly removed: readonly PageTableEntry[] } {
    memorySpace(space, 'address space'); memoryInteger(pages, 'page count');
    const entries = [...this.pageTables.pageTable(space).values()].sort((a, b) => a.page - b.page);
    if (pages > entries.length) {
      const first = asPageId(entries.length === 0 ? 0 : (entries[entries.length - 1]?.page ?? -1) + 1);
      for (let offset = 0; offset < pages - entries.length; offset++) this.pageTables.ensure(space, asPageId(first + offset));
      return { firstNewPage: first, removed: [] };
    }
    const removed = entries.slice(pages);
    for (const entry of removed) { this.invalidatePendingAccess(space, entry.page); this.pageTables.deletePage(space, entry.page); }
    if (removed.length > 0) this.flush(space);
    return { firstNewPage: null, removed };
  }
  freeAddressSpace(space: AddressSpaceId): void {
    this.detachAddressSpace(space);
    if (this.host.releaseAddressSpace !== undefined) { this.host.releaseAddressSpace(space); this.discardUnusedFrames(space); return; }
    const frames = [...this.pageTables.pageTable(space).values()].flatMap(entry => entry.frame === null ? [] : [entry.frame]);
    this.pageTables.deleteSpace(space);
    this.discardUnusedFrames(space);
    for (const frame of new Set(frames)) {
      const shared = this.pageTables.spaces().some(other => [...this.pageTables.pageTable(other).values()].some(entry => entry.valid && entry.frame === frame));
      if (!shared) this.freeFrame(frame);
    }
  }
  allocateContiguous(pid: Pid, bytes: number) {
    const result = this.holes.allocate(pid, bytes);
    if (result.ok) this.host.emit({ type: 'memory.allocated', pid, frames: [], strategy: this.holes.strategy });
    else this.host.emit({ type: 'memory.allocation_failed', pid, requested: bytes, reason: result.reason });
    return result;
  }
  contiguousMetrics() { return contiguousFragmentation(this.holes.holes, this.holes.partitions); }
  /** Byte-granular scenarios supply this alongside their page reservation. */
  setRequestedBytes(space: AddressSpaceId, bytes: number): void {
    memorySpace(space, 'requested address space'); memoryInteger(bytes, 'requested bytes');
    this.requestedBytes.set(space, bytes);
  }
  metrics(): MemoryMetrics {
    const virtual = this.pager.metrics();
    const allocations = this.pageTables.spaces().map(space => {
      const resident = [...this.pageTables.pageTable(space).values()].filter(entry => entry.valid);
      const requested = this.requestedBytes.get(space);
      const bytesRequested = resident.reduce((sum, entry) => sum + (requested === undefined ? this.config.pageSize
        : Math.min(this.config.pageSize, Math.max(0, requested - entry.page * this.config.pageSize))), 0);
      return { framesHeld: resident.length, bytesRequested };
    });
    const fragmentation = pagingFragmentation(allocations, this.config.pageSize);
    return {
      totalFrames: this.config.totalFrames, freeFrames: this.frameTable.available,
      externalFragmentation: fragmentation.externalFragmentation, internalFragmentation: fragmentation.internalFragmentation,
      tlbHitRate: this.tlbHits + this.tlbMisses === 0 ? 0 : this.tlbHits / (this.tlbHits + this.tlbMisses),
      ...virtual,
    };
  }
  context(rng: Rng, futureReferences: readonly PageId[] | null = null, space?: AddressSpaceId, forceLocal = false): MemoryContext {
    this.candidates.length = 0;
    for (const frame of this.frameTable.frames) {
      if (frame.owner !== null && !frame.pinned && !this.frameTable.freePool.includes(frame.id) && !this.pager?.isReserved(frame.id)
        && ((!forceLocal && this.replacementScope === 'global') || space === undefined || frame.owner === space)) this.candidates.push(frame);
    }
    const frames = this.candidates;
    return { tick: this.host.tick(), rng, futureReferences, frames,
      pageTable: address => this.pageTables.pageTable(address), emit: event => this.host.emit(event) };
  }

  saveState(): { memory: MemorySnapshotState; vm: VmSnapshotState } {
    this.pruneTlb();
    for (const frame of this.contents.keys()) if (this.frameTable.frames[frame]?.owner === null) this.contents.delete(frame);
    return {
      memory: { owner: 'memory', version: 1, payload: {
        pageSize: this.config.pageSize, frames: this.frameTable.saveState(), pageTables: this.pageTables.saveState(), holes: this.holes.saveState(),
        contents: [...this.contents].sort(([a], [b]) => a - b), nextContent: this.nextContent,
        requestedBytes: [...this.requestedBytes].sort(([a], [b]) => a - b), ...this.framePolicy,
      } },
      vm: { owner: 'vm', version: 2, payload: {
        ...this.pager.saveState(),
        tick: this.host.tick(), ...this.timing, tlb: this.tlb.saveState(), tlbHits: this.tlbHits, tlbMisses: this.tlbMisses,
        pending: [...this.pending].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, ...value })),
      } },
    };
  }

  /** All parsers complete before any current table, counter or live view changes. */
  prepareRestore(memory: SubsystemEnvelope, vm: SubsystemEnvelope, tick: Tick = this.host.tick()): () => void {
    if (memory.owner !== 'memory' || memory.version !== 1 || vm.owner !== 'vm' || vm.version !== 2) throw new Error('unsupported memory or vm snapshot');
    const saved = memoryObject(memory.payload, 'contribution');
    const virtual = memoryObject(vm.payload, 'vm contribution');
    if (saved['pageSize'] !== this.config.pageSize || virtual['tick'] !== tick
      || virtual['tlbHitTicks'] !== this.timing.tlbHitTicks || virtual['tlbMissTicks'] !== this.timing.tlbMissTicks) throw new Error('memory snapshot configuration or tick mismatch');
    const nextFrames = new FrameTable(this.config.totalFrames, { freePoolRetain: this.frameTable.freePoolRetain });
    nextFrames.restoreState(saved['frames']);
    for (const frame of nextFrames.frames) {
      if ((frame.loadedAtTick !== null && frame.loadedAtTick > tick) || (frame.lastAccessTick !== null && frame.lastAccessTick > tick)) throw new Error('saved frame timestamp exceeds snapshot tick');
    }
    const nextPages = new PageTable(); nextPages.restoreState(saved['pageTables']);
    for (const space of nextPages.spaces()) {
      for (const entry of nextPages.pageTable(space).values()) {
        if (entry.lastAccessTick !== null && entry.lastAccessTick > tick) throw new Error('saved page timestamp exceeds snapshot tick');
        if (entry.valid && (entry.frame === null || nextFrames.frames[entry.frame]?.owner === null || nextFrames.frames[entry.frame] === undefined || nextFrames.freePool.includes(entry.frame))) {
          throw new Error('resident saved page has no frame');
        }
      }
    }
    const commitFrames = this.frameTable.prepareRestore(saved['frames']);
    const commitPages = this.pageTables.prepareRestore(saved['pageTables']);
    const nextHoles = new HoleList(this.holes.totalBytes, this.holes.strategy, this.holes.minBlock);
    nextHoles.restoreState(saved['holes']);
    const holes = nextHoles.saveState();
    const nextTlb = new Tlb(this.config.tlbEntries, id => nextFrames.frames[id]);
    nextTlb.restoreState(virtual['tlb'], tick);
    for (const entry of nextTlb.entries) {
      const pte = nextPages.get(entry.space, entry.page);
      if (entry.valid && (pte?.valid !== true || pte.frame !== entry.frame)) throw new Error('saved TLB and page table disagree');
    }
    const commitTlb = this.tlb.prepareRestore(virtual['tlb'], tick, id => nextFrames.frames[id]);
    const rations = saved['rations']; const scheme = saved['allocationScheme']; const scope = saved['replacementScope'];
    if (!isRations(rations) || !isScheme(scheme) || !isScope(scope)) throw new Error('invalid saved frame policy');
    const contents = new Map<FrameId, number>();
    const nextContent = memoryInteger(saved['nextContent'], 'next content tag');
    for (const value of memoryArray(saved['contents'], 'content tags')) {
      const row = memoryArray(value, 'content tag');
      const frame = asFrameId(memoryInteger(row[0], 'tag frame')); const tag = memoryInteger(row[1], 'content tag');
      if (row.length !== 2 || contents.has(frame) || tag >= nextContent || nextFrames.frames[frame]?.owner === null || nextFrames.frames[frame] === undefined) throw new Error('invalid saved frame tag');
      contents.set(frame, tag);
    }
    const requested = new Map<AddressSpaceId, number>();
    for (const value of memoryArray(saved['requestedBytes'], 'requested byte counts')) {
      const row = memoryArray(value, 'requested bytes'); const space = memorySpace(row[0], 'request space');
      const bytes = memoryInteger(row[1], 'requested byte count');
      if (row.length !== 2 || requested.has(space) || !nextPages.spaces().includes(space)) throw new Error('invalid saved byte request');
      requested.set(space, bytes);
    }
    const pending = new Map<string, PendingAccess>();
    for (const value of memoryArray(virtual['pending'], 'pending accesses')) {
      const row = memoryObject(value, 'pending access'); const key = row['key'];
      const pid = asPid(memoryInteger(row['pid'], 'pending pid', 2));
      const page = asPageId(memoryInteger(row['page'], 'pending page'));
      const remaining = memoryInteger(row['remaining'], 'remaining access ticks', 1);
      const lastAttemptTick = asTick(memoryInteger(row['lastAttemptTick'], 'last access attempt'));
      const pcb = this.host.process(pid);
      if (typeof key !== 'string' || pending.has(key) || pcb === undefined || lastAttemptTick > tick || remaining >= Math.max(this.timing.tlbHitTicks, this.timing.tlbMissTicks, this.pager.settings.minorFaultTicks)
        || nextPages.get(pcb.addressSpaceId, page)?.valid !== true) throw new Error('invalid saved pending access');
      pending.set(key, { pid, page, write: memoryBoolean(row['write'], 'access write flag'), remaining, lastAttemptTick });
    }
    const hits = memoryInteger(virtual['tlbHits'], 'TLB hits'); const misses = memoryInteger(virtual['tlbMisses'], 'TLB misses');
    const demand = memoryObject(virtual['demand'], 'demand state');
    for (const value of memoryArray(demand['requests'], 'demand requests')) {
      const request = memoryObject(value, 'demand request');
      if (request['frame'] !== null && nextFrames.freePool.includes(asFrameId(memoryInteger(request['frame'], 'reserved frame')))) {
        throw new Error('reserved page-in frame is retained in the free pool');
      }
    }
    const nextContext: MemoryContext = { tick, rng: this.pager.rng, futureReferences: null, frames: nextFrames.frames,
      pageTable: space => nextPages.pageTable(space), emit: event => this.host.emit(event) };
    const commitVm = this.pager.prepareRestore(virtual, tick, nextFrames.frames, nextContext);

    return () => {
      commitFrames(); commitPages(); this.holes.restoreState(holes); commitTlb();
      this.contents.clear(); for (const [frame, tag] of contents) this.contents.set(frame, tag);
      this.requestedBytes.clear(); for (const [space, bytes] of requested) this.requestedBytes.set(space, bytes);
      this.pending.clear(); for (const [key, value] of pending) this.pending.set(key, value);
      this.nextContent = nextContent; this.tlbHits = hits; this.tlbMisses = misses;
      this.rations = rations; this.allocationScheme = scheme; this.replacementScope = scope; commitVm();
    };
  }
  restoreState(memory: SubsystemEnvelope, vm: SubsystemEnvelope): void { this.prepareRestore(memory, vm)(); }
  prepareKernelRestore(snapshot: KernelSnapshot): () => void {
    const memory = snapshot.subsystems?.memory; const vm = snapshot.subsystems?.vm;
    if (memory !== undefined && vm !== undefined) {
      const commit = this.prepareRestore(memory, vm, snapshot.tick);
      if (snapshot.config.totalFrames !== memory.payload.frames.totalFrames || snapshot.config.pageSize !== memory.payload.pageSize
        || snapshot.config.tlbEntries !== vm.payload.tlb.entries.length || snapshot.config.replacementPolicy !== vm.payload.replacement.policy || snapshot.config.allocationStrategy !== memory.payload.holes.strategy) {
        throw new Error('memory contribution disagrees with snapshot configuration');
      }
      const pages = new PageTable(new Map(snapshot.pageTables.map(([space, entries]) => [space, entries.map(entry => ({ ...entry }))])));
      if (!sameJson(memory.payload.frames.frames, snapshot.frames.map(frame => ({ ...frame }))) || !sameJson(memory.payload.pageTables, pages.saveState())) {
        throw new Error('memory contribution disagrees with shared snapshot tables');
      }
      return commit;
    }
    if (memory !== undefined || vm !== undefined) throw new Error('memory and vm contributions must be restored together');
    let replayTick = asTick(0);
    const empty = new MemorySubsystem(snapshot.config, { ...this.host, tick: () => replayTick, pageTables: new Map(),
      processes: () => snapshot.processes, process: pid => snapshot.processes.find(pcb => pcb.pid === pid), emit: () => {},
    }, { tuning: this.tuning });
    // The supported legacy channel has no workload; reconstruct its deterministic metric clocks.
    for (let value = 1; value <= snapshot.tick; value++) { replayTick = asTick(value); empty.expireTimers(replayTick); empty.metrics(); }
    empty.frameTable.restoreState({ totalFrames: snapshot.frames.length, freePoolRetain: 4,
      frames: snapshot.frames, freePool: [], freeList: snapshot.frames.filter(frame => frame.owner === null).map(frame => frame.id) });
    for (const [space, entries] of snapshot.pageTables) for (const entry of entries) empty.pageTables.set(space, { ...entry });
    const state = empty.saveState();
    return this.prepareRestore(state.memory, state.vm, snapshot.tick);
  }


  private discardUnusedFrames(space: AddressSpaceId): void {
    for (const frame of this.frameTable.framesOf(space)) {
      const mapped = this.pageTables.spaces().some(other => [...this.pageTables.pageTable(other).values()].some(entry => entry.valid && entry.frame === frame));
      if (!mapped) this.freeFrame(frame);
    }
  }
  private pruneTlb(): void {
    for (const entry of this.tlb.entries) {
      if (!entry.valid) continue;
      const pte = this.pageTables.get(entry.space, entry.page);
      const frame = this.frameTable.frames[entry.frame];
      if (pte?.valid !== true || pte.frame !== entry.frame || frame?.owner !== entry.space || frame.page !== entry.page) this.tlb.shootdown(entry.frame);
    }
  }
}

function validatePolicy(rations: string, scheme: string, scope: string): void {
  if (!['generous', 'standard', 'lean', 'starved'].includes(rations) || !['equal', 'proportional'].includes(scheme)
    || !['local', 'global'].includes(scope)) throw new Error('invalid frame allocation policy');
}

function isRations(value: unknown): value is Rations { return value === 'generous' || value === 'standard' || value === 'lean' || value === 'starved'; }
function isScheme(value: unknown): value is AllocationScheme { return value === 'equal' || value === 'proportional'; }
function isScope(value: unknown): value is ReplacementScope { return value === 'local' || value === 'global'; }

function jsonRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value: JsonValue, index: number) => sameJson(value, b[index]));
  if (!jsonRecord(a) || !jsonRecord(b)) return false;
  const keys = Object.keys(a).sort((x, y) => x < y ? -1 : x > y ? 1 : 0); const other = Object.keys(b).sort((x, y) => x < y ? -1 : x > y ? 1 : 0);
  return keys.length === other.length && keys.every((key, index) => key === other[index] && sameJson(a[key], b[key]));
}
