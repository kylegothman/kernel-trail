import { KernelInvariantError } from '../errors';
import { asFrameId, asPageId, asTick } from '../types';
import type { AddressSpaceId, Frame, FrameId, PageId, Tick } from '../types';

export type FrameTableOptions = {
  readonly freePoolRetain?: number;
  readonly tick?: () => Tick;
  readonly frames?: Frame[];
};
export type SavedFrame = { readonly [K in keyof Frame]: Frame[K] };
export type FrameTableState = {
  readonly totalFrames: number;
  readonly freePoolRetain: number;
  readonly frames: readonly SavedFrame[];
  readonly freeList: readonly FrameId[];
  readonly freePool: readonly FrameId[];
};

function isMemoryObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function memoryObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isMemoryObject(value)) throw new Error(`invalid memory ${label}`);
  return value;
}
export function memoryArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`invalid memory ${label}`);
  return value;
}
export function memoryInteger(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`invalid memory ${label}`);
  return value;
}
export function memoryBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid memory ${label}`);
  return value;
}
export function memorySpace(value: unknown, label: string): AddressSpaceId {
  return memoryInteger(value, label) as AddressSpaceId;
}
function nullableTick(value: unknown): Tick | null {
  return value === null ? null : asTick(memoryInteger(value, 'frame tick'));
}

/** A dense frame table with deterministic allocation and bounded retained pages. */
export class FrameTable {
  readonly frames: Frame[];
  readonly freePoolRetain: number;
  private readonly freeIds: FrameId[] = [];
  private readonly retained: FrameId[] = [];
  private readonly retainedMappings = new Map<FrameId, { space: AddressSpaceId; page: PageId }>();
  private readonly tick: () => Tick;

  constructor(totalFrames: number, options: FrameTableOptions = {}) {
    memoryInteger(totalFrames, 'frame count');
    this.freePoolRetain = memoryInteger(options.freePoolRetain ?? 4, 'free pool capacity');
    this.tick = options.tick ?? (() => asTick(0));
    this.frames = options.frames ?? Array.from({ length: totalFrames }, (_, id): Frame => ({
      id: asFrameId(id), owner: null, page: null, pinned: false,
      loadedAtTick: null, lastAccessTick: null, referenceBit: false,
    }));
    if (this.frames.length !== totalFrames || this.frames.some((frame, id) => frame.id !== id)) {
      throw new KernelInvariantError(17, 'frame table must be dense and indexed by frame id');
    }
    this.reconcile();
  }

  get freeList(): readonly FrameId[] { this.reconcile(); return this.freeIds; }
  get freePool(): readonly FrameId[] { this.reconcile(); return this.retained; }
  get available(): number { this.reconcile(); return this.freeIds.length + this.retained.length; }

  allocate(space: AddressSpaceId, page: PageId, pinned = false): FrameId | null {
    memorySpace(space, 'allocation address space');
    memoryInteger(page, 'allocation page');
    this.reconcile();
    const id = this.freeIds.shift() ?? this.retained.shift();
    if (id === undefined) return null;
    this.retainedMappings.delete(id);
    const frame = this.frame(id);
    frame.owner = space;
    frame.page = page;
    frame.pinned = pinned;
    frame.loadedAtTick = this.tick();
    frame.lastAccessTick = null;
    frame.referenceBit = false;
    // Choose from the free list first, then invalidate older contents of this page.
    this.discardRetainedCopies(space, page);
    this.reconcile();
    return id;
  }

  free(id: FrameId, retain = true): void {
    this.reconcile();
    const frame = this.frame(id);
    if (!retain || this.freePoolRetain === 0) { this.discard(id); return; }
    if (frame.owner === null || this.retainedMappings.has(id)) return;
    if (frame.page === null) throw new KernelInvariantError(18, 'owned frame has no page');
    this.discardRetainedCopies(frame.owner, frame.page);
    frame.pinned = false;
    this.retained.push(id);
    this.retainedMappings.set(id, { space: frame.owner, page: frame.page });
    if (this.retained.length > this.freePoolRetain) {
      const oldest = this.retained.shift();
      if (oldest === undefined) throw new KernelInvariantError(17, 'retained frame list is inconsistent');
      this.retainedMappings.delete(oldest);
      this.clear(this.frame(oldest));
    }
    this.reconcile();
  }

  discard(id: FrameId): void {
    const index = this.retained.indexOf(id);
    if (index >= 0) this.retained.splice(index, 1);
    this.retainedMappings.delete(id);
    this.clear(this.frame(id));
    this.reconcile();
  }

  /** Return a retained mapping to use without copying or loading its contents. */
  reclaim(space: AddressSpaceId, page: PageId): FrameId | null {
    this.reconcile();
    const index = this.retained.findIndex(id => {
      const frame = this.frame(id);
      return frame.owner === space && frame.page === page;
    });
    const id = this.retained[index];
    if (id === undefined) return null;
    this.retained.splice(index, 1);
    this.retainedMappings.delete(id);
    return id;
  }

  unpinnedFrames(): readonly FrameId[] {
    this.reconcile();
    return this.frames.filter(frame => frame.owner !== null && !frame.pinned && !this.retainedMappings.has(frame.id)).map(frame => frame.id);
  }

  framesOf(space: AddressSpaceId): readonly FrameId[] {
    this.reconcile();
    return this.frames.filter(frame => frame.owner === space).map(frame => frame.id);
  }

  saveState(): FrameTableState {
    this.reconcile();
    return { totalFrames: this.frames.length, freePoolRetain: this.freePoolRetain,
      frames: this.frames.map(frame => ({ ...frame })), freeList: [...this.freeIds], freePool: [...this.retained] };
  }

  prepareRestore(value: unknown): () => void {
    const source = memoryObject(value, 'frame state');
    if (memoryInteger(source['totalFrames'], 'frame count') !== this.frames.length
      || memoryInteger(source['freePoolRetain'], 'pool capacity') !== this.freePoolRetain) {
      throw new Error('memory frame snapshot configuration mismatch');
    }
    const frames: Frame[] = memoryArray(source['frames'], 'frames').map((value, index) => {
      const row = memoryObject(value, 'frame');
      const id = asFrameId(memoryInteger(row['id'], 'frame id'));
      if (id !== index) throw new Error('memory snapshot frames are not dense');
      const owner = row['owner'] === null ? null : memorySpace(row['owner'], 'frame owner');
      const page = row['page'] === null ? null : asPageId(memoryInteger(row['page'], 'frame page'));
      const pinned = memoryBoolean(row['pinned'], 'frame pinned');
      const loadedAtTick = nullableTick(row['loadedAtTick']);
      const lastAccessTick = nullableTick(row['lastAccessTick']);
      const referenceBit = memoryBoolean(row['referenceBit'], 'frame reference bit');
      if ((owner === null) !== (page === null) || (owner === null && (pinned || loadedAtTick !== null || lastAccessTick !== null || referenceBit))) {
        throw new Error('memory snapshot frame metadata is inconsistent');
      }
      return { id, owner, page, pinned, loadedAtTick, lastAccessTick, referenceBit };
    });
    if (frames.length !== this.frames.length) throw new Error('memory snapshot frame count mismatch');
    const parseIds = (value: unknown, label: string): FrameId[] => {
      const seen = new Set<FrameId>();
      return memoryArray(value, label).map(value => {
        const id = asFrameId(memoryInteger(value, label));
        if (id >= frames.length || seen.has(id)) throw new Error(`invalid memory ${label} membership`);
        seen.add(id); return id;
      });
    };
    const freeList = parseIds(source['freeList'], 'free list');
    const freePool = parseIds(source['freePool'], 'free pool');
    const expected = frames.filter(frame => frame.owner === null).map(frame => frame.id);
    if (freeList.length !== expected.length || freeList.some((id, index) => id !== expected[index])) throw new Error('invalid memory free list ordering or ownership');
    if (freePool.length > this.freePoolRetain || freePool.some(id => {
      const frame = frames[id]; return frame === undefined || frame.owner === null || frame.pinned;
    })) throw new Error('invalid memory retained frame membership');
    const retainedPages = new Set<string>();
    for (const id of freePool) {
      const frame = frames[id];
      if (frame === undefined) throw new Error('invalid memory retained frame membership');
      const key = `${frame.owner}:${frame.page}`;
      if (retainedPages.has(key)) throw new Error('duplicate retained memory page');
      retainedPages.add(key);
    }
    return () => {
      for (const frame of frames) Object.assign(this.frame(frame.id), frame);
      this.retained.length = 0;
      this.retainedMappings.clear();
      for (const id of freePool) {
        const frame = this.frame(id);
        if (frame.owner === null || frame.page === null) throw new KernelInvariantError(18, 'validated retained frame lost its mapping');
        this.retained.push(id);
        this.retainedMappings.set(id, { space: frame.owner, page: frame.page });
      }
      this.reconcile();
    };
  }

  restoreState(value: unknown): void { this.prepareRestore(value)(); }

  private frame(id: FrameId): Frame {
    const frame = this.frames[id];
    if (frame === undefined) throw new KernelInvariantError(17, 'frame id is outside physical memory', { id });
    return frame;
  }
  private clear(frame: Frame): void {
    frame.owner = null; frame.page = null; frame.pinned = false;
    frame.loadedAtTick = null; frame.lastAccessTick = null; frame.referenceBit = false;
  }
  private discardRetainedCopies(space: AddressSpaceId, page: PageId): void {
    for (let index = this.retained.length - 1; index >= 0; index -= 1) {
      const id = this.retained[index];
      if (id === undefined) continue;
      const frame = this.frame(id);
      if (frame.owner !== space || frame.page !== page) continue;
      this.retained.splice(index, 1);
      this.retainedMappings.delete(id);
      this.clear(frame);
    }
  }
  private reconcile(): void {
    for (let index = this.retained.length - 1; index >= 0; index -= 1) {
      const id = this.retained[index];
      if (id === undefined) continue;
      const frame = this.frame(id);
      const mapping = this.retainedMappings.get(id);
      if (mapping === undefined || frame.owner !== mapping.space || frame.page !== mapping.page || frame.pinned) {
        this.retained.splice(index, 1); this.retainedMappings.delete(id);
      }
    }
    this.freeIds.length = 0;
    for (const frame of this.frames) if (frame.owner === null) { this.clear(frame); this.freeIds.push(frame.id); }
  }
}
