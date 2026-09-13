import type { TlbEntry } from '../Kernel';
import { asFrameId, asPageId, asTick } from '../types';
import type { AddressSpaceId, Frame, FrameId, PageId, Tick } from '../types';

type TlbSlot = { -readonly [Key in keyof TlbEntry]: TlbEntry[Key] };
type TlbSlotView = { readonly [Key in keyof TlbEntry]: TlbEntry[Key] };

export type TlbState = {
  readonly version: 1;
  /** Slot order is part of the LRU tie-break and must survive restore. */
  readonly entries: readonly TlbSlotView[];
};

export type TlbFrameLookup = (id: FrameId) => Readonly<Frame> | undefined;

/** The cache owns replacement only; MemorySubsystem owns events and counters. */
export class Tlb {
  private readonly slots: TlbSlot[];
  readonly entries: readonly TlbSlotView[];

  constructor(readonly capacity: number, private readonly frame: TlbFrameLookup) {
    integer(capacity, 'TLB capacity');
    this.slots = Array.from({ length: capacity }, (): TlbSlot => ({
      space: spaceId(0), page: asPageId(0), frame: asFrameId(0), valid: false, lastUsedTick: asTick(0),
    }));
    this.entries = this.slots;
  }

  lookup(space: AddressSpaceId, page: PageId, tick: Tick): FrameId | null {
    integer(space, 'address space'); integer(page, 'page'); integer(tick, 'TLB lookup tick');
    for (const entry of this.slots) {
      if (!entry.valid || entry.space !== space || entry.page !== page) continue;
      if (!coherent(entry, this.frame)) { entry.valid = false; continue; }
      entry.lastUsedTick = tick;
      return entry.frame;
    }
    return null;
  }

  /** Shared aliases are valid PTEs but cannot be cached under invariant I-9. */
  install(space: AddressSpaceId, page: PageId, frame: FrameId, tick: Tick): boolean {
    integer(space, 'address space'); integer(page, 'page'); integer(frame, 'frame'); integer(tick, 'TLB install tick');
    const physical = this.frame(frame);
    const cacheable = physical !== undefined && physical.owner === space && physical.page === page;
    let chosen: TlbSlot | undefined;
    for (const entry of this.slots) {
      if (entry.valid && !coherent(entry, this.frame)) entry.valid = false;
      if (entry.valid && entry.space === space && entry.page === page) {
        if (!cacheable) { entry.valid = false; return false; }
        chosen = entry;
        break;
      }
    }
    if (!cacheable) return false;
    if (chosen === undefined) chosen = this.slots.find(entry => !entry.valid);
    if (chosen === undefined) {
      for (const entry of this.slots) {
        if (chosen === undefined || entry.lastUsedTick < chosen.lastUsedTick) chosen = entry;
      }
    }
    if (chosen === undefined) return false;
    chosen.space = space; chosen.page = page; chosen.frame = frame;
    chosen.valid = true; chosen.lastUsedTick = tick;
    return true;
  }

  flush(space?: AddressSpaceId): void {
    if (space !== undefined) integer(space, 'address space');
    for (const entry of this.slots) {
      if (space === undefined || entry.space === space) entry.valid = false;
    }
  }

  shootdown(frame: FrameId): void {
    integer(frame, 'frame');
    for (const entry of this.slots) if (entry.frame === frame) entry.valid = false;
  }

  saveState(): TlbState {
    return { version: 1, entries: this.slots.map(entry => ({ ...entry })) };
  }

  /** A prospective frame lookup supports atomic restoration of the whole memory subsystem. */
  prepareRestore(state: unknown, tick?: Tick, frame: TlbFrameLookup = this.frame): () => void {
    if (tick !== undefined) integer(tick, 'restore tick');
    if (!record(state) || state['version'] !== 1 || !Array.isArray(state['entries'])) {
      throw new Error('invalid TLB snapshot');
    }
    if (state['entries'].length !== this.capacity) throw new Error('TLB snapshot capacity mismatch');
    const saved: TlbSlot[] = [];
    const mappings = new Set<string>();
    for (const value of state['entries']) {
      if (!record(value) || typeof value['valid'] !== 'boolean') throw new Error('invalid TLB snapshot entry');
      const entry: TlbSlot = {
        space: spaceId(value['space']), page: asPageId(integer(value['page'], 'saved page')),
        frame: asFrameId(integer(value['frame'], 'saved frame')), valid: value['valid'],
        lastUsedTick: asTick(integer(value['lastUsedTick'], 'saved last-used tick')),
      };
      if (tick !== undefined && entry.lastUsedTick > tick) throw new Error('TLB snapshot contains a future access');
      if (entry.valid) {
        if (!coherent(entry, frame)) throw new Error('TLB snapshot violates frame ownership or page identity');
        const key = `${entry.space}:${entry.page}`;
        if (mappings.has(key)) throw new Error('TLB snapshot contains a duplicate mapping');
        mappings.add(key);
      }
      saved.push(entry);
    }
    return () => {
      for (let slot = 0; slot < saved.length; slot++) {
        const source = saved[slot]; const target = this.slots[slot];
        if (source === undefined || target === undefined) throw new Error('TLB slot count changed during restore');
        Object.assign(target, source);
      }
    };
  }

  restoreState(state: unknown, tick?: Tick): void { this.prepareRestore(state, tick)(); }
}

function coherent(entry: Readonly<TlbEntry>, frame: TlbFrameLookup): boolean {
  const physical = frame(entry.frame);
  return physical !== undefined && physical.owner === entry.space && physical.page === entry.page;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function spaceId(value: unknown): AddressSpaceId { return integer(value, 'address space') as AddressSpaceId; }

/** EAT = E + M + (1 - h) * M, using nanoseconds throughout. */
export function effectiveAccessTimeNs(hitRatio: number, memoryNs: number, tlbNs: number): number {
  if (!Number.isFinite(hitRatio) || hitRatio < 0 || hitRatio > 1
    || !Number.isFinite(memoryNs) || memoryNs < 0 || !Number.isFinite(tlbNs) || tlbNs < 0) {
    throw new RangeError('access times must be finite and non-negative, with hit ratio in [0, 1]');
  }
  const result = tlbNs + memoryNs + (1 - hitRatio) * memoryNs;
  if (!Number.isFinite(result)) throw new RangeError('effective access time exceeds the finite numeric range');
  return result;
}
