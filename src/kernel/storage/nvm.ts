import { asTick } from '../types';
import type { DeviceId, StorageNvmPartRefSnapshot, StorageNvmSnapshot, StorageRequestSnapshot, StorageResultSnapshot, SyscallResult, Tick } from '../types';

export type NvmGeometry = StorageNvmSnapshot['geometry'];
export interface NvmHost {
  tick(): Tick;
  request(id: number): StorageRequestSnapshot | undefined;
  completeRequest(id: number, result: StorageResultSnapshot, completedAtTick: Tick): void;
  costMultiplier?(): number;
}
export type NvmOptions = Partial<NvmGeometry> & { readonly deviceId?: DeviceId; readonly writeBufferPages?: number; readonly msPerTick?: number };
const PAGE_BYTES = 4096;
/** Capacity is a model default, not a new KernelTuning key. */
export const DEFAULT_NVM_GEOMETRY: NvmGeometry = Object.freeze({ pages: 4096, logicalPages: 3456,
  pagesPerBlock: 256, readUs: 25, writeUs: 250, eraseUs: 2000, overProvisionRatio: 0.07 });
type PartRef = StorageNvmPartRefSnapshot;

/** Serial, page-granular flash; HDD scheduling policy never enters this model. */
export class NvmDevice {
  private state: StorageNvmSnapshot;
  readonly msPerTick: number;
  constructor(private readonly host: NvmHost, options: NvmOptions = {}) {
    const d = DEFAULT_NVM_GEOMETRY;
    const geometry: NvmGeometry = { pages: options.pages ?? d.pages, logicalPages: options.logicalPages ?? d.logicalPages,
      pagesPerBlock: options.pagesPerBlock ?? d.pagesPerBlock, readUs: options.readUs ?? d.readUs,
      writeUs: options.writeUs ?? d.writeUs, eraseUs: options.eraseUs ?? d.eraseUs, overProvisionRatio: options.overProvisionRatio ?? d.overProvisionRatio };
    this.msPerTick = options.msPerTick ?? 0.5;
    positive(this.msPerTick, 'NVM tick duration'); validateGeometry(geometry);
    const writeBufferPages = integer(options.writeBufferPages ?? 8, 'NVM write buffer', 1);
    this.state = { deviceId: options.deviceId ?? 'nvm0' as DeviceId, geometry, writeBufferPages,
      programmedPages: [], eraseCounts: Array.from({ length: geometry.pages / geometry.pagesPerBlock }, () => 0),
      nextGeneration: 0, buffers: [], programs: [], requests: [], pendingParts: [], active: null, gc: null,
      counters: { logicalBytesWritten: 0, logicalBytesRead: 0, foregroundPrograms: 0, relocationPrograms: 0, pageReads: 0, blockErases: 0 } };
  }
  get deviceId(): DeviceId { return this.state.deviceId; }
  get geometry(): NvmGeometry { return this.state.geometry; }
  get busy(): boolean { return this.state.active !== null || this.state.gc !== null || this.state.requests.length > 0 || this.state.programs.length > 0 || this.state.buffers.length > 0; }
  get freePages(): number { return this.freePhysicalPages().length; }
  get writeAmplification(): number {
    const c = this.state.counters;
    return c.logicalBytesWritten === 0 ? 0 : PAGE_BYTES * (c.foregroundPrograms + c.relocationPrograms) / c.logicalBytesWritten;
  }
  metrics() { return { ...this.state.counters, physicalWrites: this.state.counters.foregroundPrograms + this.state.counters.relocationPrograms,
    logicalWrites: this.state.counters.logicalBytesWritten / PAGE_BYTES, writeAmplification: this.writeAmplification,
    freePages: this.freePages, wear: [...this.state.eraseCounts] }; }
  serviceTimeUs(write: boolean): number { return write ? this.geometry.writeUs : this.geometry.readUs; }
  physicalPage(logicalPage: number): number | null { return this.state.programmedPages.find(page => page.logicalPage === logicalPage)?.physicalPage ?? null; }
  readPage(logicalPage: number): readonly number[] { return [...this.pageImage(logicalPage)]; }
  submit(requestId: number): void {
    const request = this.host.request(requestId);
    if (request === undefined || this.state.requests.some(row => row.requestId === requestId)) throw new Error('unknown or duplicate NVM request');
    const transfer = request.transfer; const byteCount = transfer.kind === 'read' ? transfer.bytes : transfer.data.length;
    integer(transfer.lba, 'NVM sector'); integer(byteCount, 'NVM request bytes', 1);
    if (transfer.kind === 'write') bytes(transfer.data, byteCount);
    const firstByte = transfer.lba * 512;
    if (!Number.isSafeInteger(firstByte + byteCount) || firstByte + byteCount > this.geometry.logicalPages * PAGE_BYTES) throw new RangeError('NVM address outside device');
    const parts: StorageNvmSnapshot['requests'][number]['parts'][number][] = [];
    for (let offset = 0; offset < byteCount;) {
      const address = firstByte + offset; const pageOffset = address % PAGE_BYTES; const size = Math.min(PAGE_BYTES - pageOffset, byteCount - offset);
      parts.push({ logicalPage: Math.floor(address / PAGE_BYTES), pageOffset, byteCount: size, result: null }); offset += size;
    }
    const counters = { ...this.state.counters };
    if (transfer.kind === 'write') counters.logicalBytesWritten += byteCount; else counters.logicalBytesRead += byteCount;
    this.state = { ...this.state, counters, requests: [...this.state.requests, { requestId, parts }],
      pendingParts: [...this.state.pendingParts, ...parts.map((_, partIndex) => ({ requestId, partIndex }))] };
    this.pump();
  }
  flush(): number {
    this.acceptWrites(); const count = this.state.buffers.length;
    for (const buffer of [...this.state.buffers]) this.detach(buffer.generation);
    this.pump(); return count;
  }
  /** Mutating controls never enqueue hidden work behind a GC reservation. */
  trim(startPage: number, count: number): SyscallResult {
    integer(startPage, 'trim page'); integer(count, 'trim count');
    if (startPage + count > this.geometry.logicalPages) return { ok: false, errno: 'EINVAL', message: 'trim outside NVM' };
    if (this.state.gc !== null || this.state.active !== null || this.state.requests.length !== 0) return { ok: false, errno: 'EBUSY', message: 'NVM media is active' };
    this.state = { ...this.state, programmedPages: this.state.programmedPages.map(page =>
      page.logicalPage !== null && page.logicalPage >= startPage && page.logicalPage < startPage + count ? { ...page, logicalPage: null } : page) };
    return { ok: true, value: count };
  }
  resetCounters(): void {
    if (this.busy) throw new Error('cannot reset NVM counters during service');
    this.state = { ...this.state, counters: { logicalBytesWritten: 0, logicalBytesRead: 0, foregroundPrograms: 0, relocationPrograms: 0, pageReads: 0, blockErases: 0 } };
  }
  cancel(requestId: number): void {
    const request = this.state.requests.find(row => row.requestId === requestId); if (request === undefined) return;
    this.state = { ...this.state, pendingParts: this.state.pendingParts.filter(ref => ref.requestId !== requestId),
      buffers: this.state.buffers.map(image => ({ ...image, parts: image.parts.filter(ref => ref.requestId !== requestId) })).filter(image => image.parts.length > 0),
      programs: this.state.programs.map(image => ({ ...image, parts: image.parts.filter(ref => ref.requestId !== requestId) })) };
    for (let index = 0; index < request.parts.length; index++) this.finishPart({ requestId, partIndex: index }, { kind: 'failed', reason: 'cancelled' });
    if (this.state.active?.operation.kind === 'read' && this.state.active.operation.part.requestId === requestId) this.state = { ...this.state, active: null };
  }
  expireTimers(tick: Tick): void {
    // A partial page combines calls in its submission tick, then drains. The
    // request table owns the clock, so no unpersisted flush timer is needed.
    for (const image of [...this.state.buffers]) if (image.parts.some(ref => (this.host.request(ref.requestId)?.queuedAtTick ?? tick) < tick)) this.detach(image.generation);
    if (this.state.active?.operation.kind === 'gc' && this.state.active.completeAtTick <= tick) this.completeGc();
    this.pump();
  }
  serviceCompletions(tick: Tick): void {
    const active = this.state.active;
    if (active !== null && active.operation.kind !== 'gc' && active.completeAtTick <= tick) {
      this.state = { ...this.state, active: null }; const operation = active.operation;
      if (operation.kind === 'read') { this.increment('pageReads'); this.finishPart(operation.part, { kind: 'ok', data: operation.data }); }
      else {
        const program = this.state.programs.find(image => image.generation === operation.generation);
        if (program === undefined) throw new Error('NVM program image missing');
        this.programPage(program.logicalPage, operation.physicalPage, program.data); this.increment('foregroundPrograms');
        this.state = { ...this.state, programs: this.state.programs.filter(image => image.generation !== program.generation) };
        for (const part of program.parts) this.finishPart(part, { kind: 'ok', data: [] });
      }
    }
    this.pump();
  }
  saveState(): StorageNvmSnapshot { return structuredClone(this.state); }
  prepareRestore(snapshot: StorageNvmSnapshot): () => void {
    const next = structuredClone(snapshot); validateState(next, this.host.tick(), id => this.host.request(id));
    if (next.deviceId !== this.deviceId || !sameGeometry(next.geometry, this.geometry) || next.writeBufferPages !== this.state.writeBufferPages) throw new Error('NVM snapshot configuration mismatch');
    return () => { this.state = next; };
  }
  private increment(key: keyof StorageNvmSnapshot['counters']): void { this.state = { ...this.state, counters: { ...this.state.counters, [key]: this.state.counters[key] + 1 } }; }
  private acceptWrites(): void {
    while (this.state.pendingParts.length > 0) {
      const ref = this.state.pendingParts[0]!; const request = this.host.request(ref.requestId);
      if (request?.transfer.kind !== 'write') break;
      const part = this.part(ref); if (part === undefined) throw new Error('NVM part missing');
      let buffer = this.state.buffers.find(image => image.logicalPage === part.logicalPage);
      if (buffer === undefined) {
        if (this.state.buffers.length >= this.state.writeBufferPages) this.detach(this.state.buffers[0]!.generation);
        buffer = { logicalPage: part.logicalPage, generation: this.state.nextGeneration, data: [...this.pageImage(part.logicalPage)], parts: [] };
        this.state = { ...this.state, nextGeneration: this.state.nextGeneration + 1, buffers: [...this.state.buffers, buffer] };
      }
      const data = [...buffer.data]; const offset = part.logicalPage * PAGE_BYTES + part.pageOffset - request.transfer.lba * 512;
      data.splice(part.pageOffset, part.byteCount, ...request.transfer.data.slice(offset, offset + part.byteCount));
      const updated = { ...buffer, data, parts: [...buffer.parts, ref] };
      this.state = { ...this.state, pendingParts: this.state.pendingParts.slice(1), buffers: this.state.buffers.map(image => image.generation === updated.generation ? updated : image) };
      const covered = new Uint8Array(PAGE_BYTES);
      for (const value of updated.parts) { const portion = this.part(value); if (portion !== undefined) covered.fill(1, portion.pageOffset, portion.pageOffset + portion.byteCount); }
      if (covered.every(value => value === 1)) this.detach(updated.generation);
    }
  }
  private detach(generation: number): void {
    const image = this.state.buffers.find(buffer => buffer.generation === generation); if (image === undefined) return;
    this.state = { ...this.state, buffers: this.state.buffers.filter(buffer => buffer !== image), programs: [...this.state.programs, image] };
  }
  private pump(): void {
    this.acceptWrites(); if (this.state.active !== null) return;
    // With neither active operation nor GC, there are no reserved pages. Idle
    // ticks need no page scan, while the final write still triggers required GC.
    if (this.state.gc === null && this.geometry.pages - this.state.programmedPages.length < this.geometry.overProvisionRatio * this.geometry.pages) this.beginGc();
    if (this.state.gc !== null) {
      const us = this.state.gc.phase === 'read' ? this.geometry.readUs : this.state.gc.phase === 'program' ? this.geometry.writeUs : this.geometry.eraseUs;
      this.start({ kind: 'gc' }, us); return;
    }
    const program = this.state.programs[0];
    if (program !== undefined) {
      const physicalPage = this.freePhysicalPages()[0]; if (physicalPage === undefined) throw new Error('NVM exhausted its relocation reserve');
      this.start({ kind: 'program', generation: program.generation, physicalPage }, this.geometry.writeUs); return;
    }
    const ref = this.state.pendingParts[0];
    if (ref !== undefined) {
      const part = this.part(ref); if (part === undefined || this.host.request(ref.requestId)?.transfer.kind !== 'read') throw new Error('invalid NVM read');
      this.state = { ...this.state, pendingParts: this.state.pendingParts.slice(1) };
      this.start({ kind: 'read', part: ref, data: this.pageImage(part.logicalPage).slice(part.pageOffset, part.pageOffset + part.byteCount) }, this.geometry.readUs);
    }
  }
  private start(operation: NonNullable<StorageNvmSnapshot['active']>['operation'], us: number): void {
    const tick = this.host.tick(); const factor = this.host.costMultiplier?.() ?? 1; positive(factor, 'NVM multiplier');
    const ticks = Math.max(1, Math.round(us * factor / 1000 / this.msPerTick));
    this.state = { ...this.state, active: { startedAtTick: tick, completeAtTick: asTick(tick + ticks), operation } };
  }
  private part(ref: PartRef) { return this.state.requests.find(row => row.requestId === ref.requestId)?.parts[ref.partIndex]; }
  private finishPart(ref: PartRef, result: StorageResultSnapshot): void {
    const row = this.state.requests.find(request => request.requestId === ref.requestId); if (row === undefined || row.parts[ref.partIndex]?.result !== null) return;
    const parts = row.parts.map((part, index) => index === ref.partIndex ? { ...part, result } : part);
    this.state = { ...this.state, requests: this.state.requests.map(request => request === row ? { ...row, parts } : request) };
    if (parts.some(part => part.result === null)) return;
    const failure = parts.map(part => part.result).find(value => value?.kind === 'failed');
    const outcome: StorageResultSnapshot = failure?.kind === 'failed' ? failure : { kind: 'ok', data: parts.flatMap(part => part.result?.kind === 'ok' ? [...part.result.data] : []) };
    this.state = { ...this.state, requests: this.state.requests.filter(request => request.requestId !== ref.requestId) };
    this.host.completeRequest(ref.requestId, outcome, this.host.tick());
  }
  private pageImage(logicalPage: number): readonly number[] {
    const buffer = this.state.buffers.find(image => image.logicalPage === logicalPage); if (buffer !== undefined) return buffer.data;
    const program = [...this.state.programs].reverse().find(image => image.logicalPage === logicalPage);
    return program?.data ?? this.state.programmedPages.find(page => page.logicalPage === logicalPage)?.data ?? Array<number>(PAGE_BYTES).fill(0);
  }
  private freePhysicalPages(excludedBlock?: number): number[] {
    const used = new Set(this.state.programmedPages.map(page => page.physicalPage));
    const active = this.state.active?.operation; if (active?.kind === 'program') used.add(active.physicalPage);
    if (this.state.gc !== null) for (const relocation of this.state.gc.relocations.slice(this.state.gc.nextRelocation)) used.add(relocation.destinationPage);
    return Array.from({ length: this.geometry.pages }, (_, index) => index).filter(index => !used.has(index) && (excludedBlock === undefined || Math.floor(index / this.geometry.pagesPerBlock) !== excludedBlock));
  }
  private programPage(logicalPage: number, physicalPage: number, data: readonly number[]): void {
    if (this.state.programmedPages.some(page => page.physicalPage === physicalPage)) throw new Error('NVM attempted in-place overwrite');
    this.state = { ...this.state, programmedPages: [...this.state.programmedPages.map(page => page.logicalPage === logicalPage ? { ...page, logicalPage: null } : page),
      { physicalPage, logicalPage, data: [...data] }].sort((a, b) => a.physicalPage - b.physicalPage) };
  }
  private beginGc(): void {
    const counts = new Map<number, number>();
    for (const page of this.state.programmedPages) if (page.logicalPage === null) {
      const block = Math.floor(page.physicalPage / this.geometry.pagesPerBlock); counts.set(block, (counts.get(block) ?? 0) + 1);
    }
    const victimBlock = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]; if (victimBlock === undefined) return;
    const sources = this.state.programmedPages.filter(page => page.logicalPage !== null && Math.floor(page.physicalPage / this.geometry.pagesPerBlock) === victimBlock);
    const free = this.freePhysicalPages(victimBlock); if (free.length < sources.length) throw new Error('NVM cannot reserve all GC destinations');
    this.state = { ...this.state, gc: { victimBlock, relocations: sources.map((source, index) => ({ sourcePage: source.physicalPage, destinationPage: free[index]! })),
      nextRelocation: 0, phase: sources.length === 0 ? 'erase' : 'read' } };
  }
  private completeGc(): void {
    const gc = this.state.gc; if (gc === null) throw new Error('NVM GC state missing'); this.state = { ...this.state, active: null };
    if (gc.phase === 'read') { this.increment('pageReads'); this.state = { ...this.state, gc: { ...gc, phase: 'program' } }; }
    else if (gc.phase === 'program') {
      const relocation = gc.relocations[gc.nextRelocation]!; const source = this.state.programmedPages.find(page => page.physicalPage === relocation.sourcePage);
      if (source === undefined || source.logicalPage === null) throw new Error('NVM GC source is no longer valid');
      this.programPage(source.logicalPage, relocation.destinationPage, source.data); this.increment('relocationPrograms');
      const next = gc.nextRelocation + 1; this.state = { ...this.state, gc: { ...gc, nextRelocation: next, phase: next === gc.relocations.length ? 'erase' : 'read' } };
    } else {
      this.state = { ...this.state, programmedPages: this.state.programmedPages.filter(page => Math.floor(page.physicalPage / this.geometry.pagesPerBlock) !== gc.victimBlock),
        eraseCounts: this.state.eraseCounts.map((count, index) => count + (index === gc.victimBlock ? 1 : 0)), gc: null }; this.increment('blockErases');
    }
  }
}

function integer(value: number, name: string, min = 0): number { if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`invalid ${name}`); return value; }
function positive(value: number, name: string): void { if (!Number.isFinite(value) || value <= 0) throw new RangeError(`invalid ${name}`); }
function bytes(data: readonly number[], length: number): void { if (!Array.isArray(data) || data.length !== length || data.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('invalid NVM byte image'); }
function validateGeometry(g: NvmGeometry): void {
  integer(g.pages, 'NVM pages', 1); integer(g.logicalPages, 'NVM logical pages', 1); integer(g.pagesPerBlock, 'NVM block pages', 1);
  positive(g.readUs, 'NVM read time'); positive(g.writeUs, 'NVM write time'); positive(g.eraseUs, 'NVM erase time');
  if (!Number.isFinite(g.overProvisionRatio) || g.overProvisionRatio <= 0 || g.overProvisionRatio >= 1 || g.pages % g.pagesPerBlock !== 0 || g.logicalPages >= g.pages
    || Math.ceil(g.pages * g.overProvisionRatio) < g.pagesPerBlock
    || g.logicalPages > g.pages - Math.ceil(g.pages * g.overProvisionRatio)) throw new RangeError('invalid NVM geometry or GC reserve');
}
function sameGeometry(a: NvmGeometry, b: NvmGeometry): boolean { return Object.keys(a).every(key => Reflect.get(a, key) === Reflect.get(b, key)); }
function validateState(s: StorageNvmSnapshot, tick: Tick, lookup: (id: number) => StorageRequestSnapshot | undefined): void {
  validateGeometry(s.geometry); integer(s.writeBufferPages, 'NVM buffer capacity', 1); integer(s.nextGeneration, 'NVM generation');
  if (typeof s.deviceId !== 'string' || s.deviceId.length === 0) throw new Error('invalid NVM device identity');
  const physical = new Set<number>(); const logical = new Set<number>();
  for (const [index, page] of s.programmedPages.entries()) {
    integer(page.physicalPage, 'physical page'); if (page.physicalPage >= s.geometry.pages || physical.has(page.physicalPage)) throw new Error('invalid physical mapping'); physical.add(page.physicalPage);
    if (index > 0 && s.programmedPages[index - 1]!.physicalPage >= page.physicalPage) throw new Error('physical pages are not canonical');
    if (page.logicalPage !== null) { integer(page.logicalPage, 'logical page'); if (page.logicalPage >= s.geometry.logicalPages || logical.has(page.logicalPage)) throw new Error('duplicate logical mapping'); logical.add(page.logicalPage); } bytes(page.data, PAGE_BYTES);
  }
  if (s.eraseCounts.length !== s.geometry.pages / s.geometry.pagesPerBlock) throw new Error('invalid wear table');
  for (const count of s.eraseCounts) integer(count, 'erase count'); for (const count of Object.values(s.counters)) integer(count, 'NVM counter');
  const ids = new Set<number>();
  for (const row of s.requests) {
    integer(row.requestId, 'NVM request'); if (ids.has(row.requestId) || row.parts.length === 0) throw new Error('invalid NVM request'); ids.add(row.requestId);
    const request = lookup(row.requestId); if (request === undefined) throw new Error('NVM request owner missing');
    let offset = 0;
    for (const part of row.parts) { integer(part.logicalPage, 'part page'); integer(part.pageOffset, 'part offset'); integer(part.byteCount, 'part bytes', 1);
      if (part.logicalPage >= s.geometry.logicalPages || part.pageOffset + part.byteCount > PAGE_BYTES) throw new Error('invalid NVM part');
      if (part.logicalPage * PAGE_BYTES + part.pageOffset !== request.transfer.lba * 512 + offset) throw new Error('NVM part does not match request extent'); offset += part.byteCount;
      if (part.result !== null) validateResult(part.result, request.transfer.kind === 'read' ? part.byteCount : 0);
    }
    if (offset !== (request.transfer.kind === 'read' ? request.transfer.bytes : request.transfer.data.length)) throw new Error('NVM part coverage mismatch');
  }
  const ownership = new Map<string, number>();
  const ref = (value: PartRef) => { integer(value.partIndex, 'part index'); if (s.requests.find(row => row.requestId === value.requestId)?.parts[value.partIndex]?.result !== null) throw new Error('invalid pending part reference');
    const key = `${value.requestId}:${value.partIndex}`; ownership.set(key, (ownership.get(key) ?? 0) + 1); };
  for (const value of s.pendingParts) ref(value);
  const generations = new Set<number>();
  for (const image of [...s.buffers, ...s.programs]) { integer(image.generation, 'image generation'); integer(image.logicalPage, 'image page');
    if (image.generation >= s.nextGeneration || generations.has(image.generation) || image.logicalPage >= s.geometry.logicalPages) throw new Error('invalid NVM image'); generations.add(image.generation); bytes(image.data, PAGE_BYTES); for (const value of image.parts) ref(value);
  }
  if (s.buffers.length > s.writeBufferPages || new Set(s.buffers.map(image => image.logicalPage)).size !== s.buffers.length) throw new Error('invalid NVM buffer table');
  if (s.active !== null) {
    integer(s.active.startedAtTick, 'NVM start'); integer(s.active.completeAtTick, 'NVM deadline');
    if (s.active.startedAtTick > tick || s.active.completeAtTick <= tick) throw new Error('invalid NVM service deadline');
    const op = s.active.operation;
    if (op.kind === 'read') { ref(op.part); bytes(op.data, s.requests.find(row => row.requestId === op.part.requestId)!.parts[op.part.partIndex]!.byteCount); }
    else if (op.kind === 'program') { integer(op.physicalPage, 'program reservation'); if (s.programs[0]?.generation !== op.generation || physical.has(op.physicalPage) || op.physicalPage >= s.geometry.pages) throw new Error('invalid NVM program reservation'); }
    else if (op.kind !== 'gc' || s.gc === null) throw new Error('GC operation has no plan');
  }
  for (const row of s.requests) for (const [index, part] of row.parts.entries()) if ((ownership.get(`${row.requestId}:${index}`) ?? 0) !== (part.result === null ? 1 : 0)) throw new Error('NVM part has multiple or missing owners');
  if (s.gc !== null) {
    integer(s.gc.victimBlock, 'GC victim'); integer(s.gc.nextRelocation, 'GC cursor');
    if (s.gc.victimBlock >= s.eraseCounts.length || s.gc.nextRelocation > s.gc.relocations.length || !['read', 'program', 'erase'].includes(s.gc.phase)
      || (s.gc.phase === 'erase') !== (s.gc.nextRelocation === s.gc.relocations.length)) throw new Error('invalid GC plan');
    if (s.active !== null && s.active.operation.kind !== 'gc') throw new Error('foreground media overlaps GC');
    const reserved = new Set<number>();
    for (const [index, move] of s.gc.relocations.entries()) { integer(move.sourcePage, 'GC source'); integer(move.destinationPage, 'GC destination');
      if (Math.floor(move.sourcePage / s.geometry.pagesPerBlock) !== s.gc.victimBlock || move.destinationPage >= s.geometry.pages
        || Math.floor(move.destinationPage / s.geometry.pagesPerBlock) === s.gc.victimBlock || reserved.has(move.destinationPage)) throw new Error('invalid GC relocation'); reserved.add(move.destinationPage);
      const source = s.programmedPages.find(page => page.physicalPage === move.sourcePage);
      if (index >= s.gc.nextRelocation && (physical.has(move.destinationPage) || source?.logicalPage === null || source === undefined)) throw new Error('invalid GC reservation');
      if (index > 0 && s.gc.relocations[index - 1]!.sourcePage >= move.sourcePage) throw new Error('GC sources are not ascending');
      if (index < s.gc.nextRelocation) {
        const destination = s.programmedPages.find(page => page.physicalPage === move.destinationPage);
        if (source?.logicalPage !== null || destination?.logicalPage === null || destination === undefined || !source.data.every((byte, at) => byte === destination.data[at])) throw new Error('invalid completed GC relocation');
      }
    }
    const victimBlock = s.gc.victimBlock;
    const remainingSources = new Set(s.gc.relocations.slice(s.gc.nextRelocation).map(move => move.sourcePage));
    const liveVictimPages = s.programmedPages.filter(page => page.logicalPage !== null
      && Math.floor(page.physicalPage / s.geometry.pagesPerBlock) === victimBlock);
    if (liveVictimPages.length !== remainingSources.size || liveVictimPages.some(page => !remainingSources.has(page.physicalPage))) throw new Error('GC plan omits a live victim page');
  }
}
function validateResult(result: StorageResultSnapshot, count: number): void {
  if (result.kind === 'ok') bytes(result.data, count);
  else if (result.kind !== 'failed' || !['io_timeout', 'storage_corruption', 'cancelled', 'device_failed'].includes(result.reason)) throw new Error('invalid NVM result');
}
