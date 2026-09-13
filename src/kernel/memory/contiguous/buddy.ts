import type { Hole } from './HoleList';

export interface BuddyBlock { readonly base: number; readonly order: number; readonly size: number; readonly requested: number }
export type BuddyState = {
  readonly totalBytes: number;
  readonly minBlock: number;
  readonly freeLists: readonly (readonly number[])[];
  readonly allocations: readonly { readonly base: number; readonly order: number; readonly requested: number }[];
  readonly reserved: readonly { readonly start: number; readonly size: number }[];
};

export function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && 2 ** Math.round(Math.log2(value)) === value;
}

/** Arithmetic XOR avoids truncating byte addresses to signed 32-bit integers. */
export function buddyAddress(base: number, order: number): number {
  if (!Number.isInteger(order) || order < 0 || order > 52 || !Number.isSafeInteger(base)
    || base < 0 || base % 2 ** order !== 0) throw new RangeError('invalid buddy address or order');
  const size = 2 ** order;
  const other = Math.floor(base / size) % 2 === 0 ? base + size : base - size;
  if (!Number.isSafeInteger(other)) throw new RangeError('buddy address exceeds integer range');
  return other;
}

function requestOrder(request: number, minBlock: number): number {
  if (!Number.isSafeInteger(request) || request <= 0) throw new RangeError('allocation request must be positive integer bytes');
  let order = Math.ceil(Math.log2(Math.max(request, minBlock)));
  if (2 ** order < request) order += 1;
  return order;
}

/** Selector counterpart for the registry, using the default minimum block. */
export function select(holes: readonly Hole[], request: number, minBlock = 4096): number {
  if (!isPowerOfTwo(minBlock)) throw new RangeError('minimum buddy block must be a power of two');
  const needed = requestOrder(request, minBlock);
  let selected = -1; let selectedOrder = Infinity; let selectedBase = Infinity;
  for (let index = 0; index < holes.length; index++) {
    const hole = holes[index]; if (hole === undefined) continue;
    let base = Math.ceil(hole.start / minBlock) * minBlock;
    const until = Math.floor((hole.start + hole.size) / minBlock) * minBlock;
    while (base < until) {
      let order = Math.floor(Math.log2(until - base));
      while (base % 2 ** order !== 0 || base + 2 ** order > until) order -= 1;
      if (order >= needed && (order < selectedOrder || (order === selectedOrder && base < selectedBase))) {
        selected = index; selectedOrder = order; selectedBase = base;
      }
      base += 2 ** order;
    }
  }
  return selected;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

/** Sorted byte-order free lists with constant-time removal at each list head. */
export class BuddyAllocator {
  private readonly lists: number[][];
  private readonly heads: number[];
  private readonly allocated = new Map<number, BuddyBlock>();
  private reserved: Hole[] = [];
  readonly minOrder: number;
  readonly maxOrder: number;

  constructor(readonly totalBytes: number, readonly minBlock = 4096, holes?: readonly Hole[]) {
    if (!isPowerOfTwo(totalBytes) || !isPowerOfTwo(minBlock) || minBlock > totalBytes) {
      throw new RangeError('buddy region and minimum block must be compatible powers of two');
    }
    this.minOrder = Math.log2(minBlock); this.maxOrder = Math.log2(totalBytes);
    this.lists = Array.from({ length: this.maxOrder + 1 }, () => []);
    this.heads = Array.from({ length: this.maxOrder + 1 }, () => 0);
    this.resetFromHoles(holes ?? [{ start: 0, size: totalBytes }]);
  }

  get freeLists(): readonly (readonly number[])[] {
    return this.lists.map((list, order) => list.slice(this.heads[order] ?? 0));
  }
  get freeHoles(): readonly Hole[] {
    return this.freeLists.flatMap((list, order) => list.map(start => ({ start, size: 2 ** order })))
      .sort((a, b) => a.start - b.start);
  }

  /** Rebuild from available physical ranges when switching allocation strategies. */
  resetFromHoles(holes: readonly Hole[]): void {
    const ordered = [...holes].map(hole => ({ ...hole })).sort((a, b) => a.start - b.start);
    const free: Hole[] = [];
    let end = 0;
    for (const hole of ordered) {
      if (!integer(hole.start, 0) || !integer(hole.size, 1) || hole.start < end
        || !Number.isSafeInteger(hole.start + hole.size) || hole.start + hole.size > this.totalBytes) throw new RangeError('invalid buddy free range');
      const previous = free[free.length - 1];
      if (previous !== undefined && previous.start + previous.size === hole.start) previous.size += hole.size;
      else free.push(hole);
      end = hole.start + hole.size;
    }
    const nextLists = Array.from({ length: this.maxOrder + 1 }, (): number[] => []);
    const usable: Hole[] = [];
    for (const hole of free) {
      let start = Math.ceil(hole.start / this.minBlock) * this.minBlock;
      const until = Math.floor((hole.start + hole.size) / this.minBlock) * this.minBlock;
      if (start < until) usable.push({ start, size: until - start });
      while (start < until) {
        let order = this.maxOrder;
        while (order > this.minOrder && (start % 2 ** order !== 0 || start + 2 ** order > until)) order -= 1;
        nextLists[order]?.push(start); start += 2 ** order;
      }
    }
    const reserved: Hole[] = []; let cursor = 0;
    for (const range of usable) {
      if (range.start > cursor) reserved.push({ start: cursor, size: range.start - cursor });
      cursor = range.start + range.size;
    }
    if (cursor < this.totalBytes) reserved.push({ start: cursor, size: this.totalBytes - cursor });
    for (let order = 0; order <= this.maxOrder; order++) {
      this.lists[order] = nextLists[order] ?? []; this.heads[order] = 0;
    }
    this.allocated.clear(); this.reserved = reserved;
  }

  allocate(request: number): BuddyBlock | null {
    const order = requestOrder(request, this.minBlock);
    let available = order;
    while (available <= this.maxOrder && (this.lists[available]?.length ?? 0) <= (this.heads[available] ?? 0)) available += 1;
    if (available > this.maxOrder) return null;
    const base = this.pop(available);
    if (base === undefined) throw new Error('buddy free-list head missing');
    while (available > order) { available -= 1; this.insert(available, base + 2 ** available); }
    const block: BuddyBlock = { base, order, size: 2 ** order, requested: request };
    this.allocated.set(base, block); return { ...block };
  }

  free(base: number): boolean {
    const block = this.allocated.get(base); if (block === undefined) return false;
    this.allocated.delete(base); let order = block.order; let start = base;
    while (order < this.maxOrder) {
      const buddy = buddyAddress(start, order);
      const list = this.lists[order];
      const index = list?.indexOf(buddy, this.heads[order] ?? 0) ?? -1;
      if (index < 0 || list === undefined) break;
      list.splice(index, 1); start = Math.min(start, buddy); order += 1;
    }
    this.insert(order, start); return true;
  }

  saveState(): BuddyState {
    return { totalBytes: this.totalBytes, minBlock: this.minBlock, freeLists: this.freeLists,
      allocations: [...this.allocated.values()].sort((a, b) => a.base - b.base)
        .map(({ base, order, requested }) => ({ base, order, requested })),
      reserved: this.reserved.map(hole => ({ ...hole })) };
  }

  restoreState(state: unknown): void {
    if (!object(state) || state['totalBytes'] !== this.totalBytes || state['minBlock'] !== this.minBlock
      || !Array.isArray(state['freeLists']) || !Array.isArray(state['allocations']) || !Array.isArray(state['reserved'])) throw new RangeError('invalid buddy state');
    const rawLists: unknown[] = state['freeLists'];
    if (rawLists.length !== this.maxOrder + 1) throw new RangeError('invalid buddy free-list orders');
    const lists: number[][] = []; const ranges: Hole[] = []; const free: Hole[] = [];
    for (let order = 0; order < rawLists.length; order++) {
      const raw: unknown = rawLists[order]; if (!Array.isArray(raw)) throw new RangeError('invalid buddy free list');
      const list: number[] = [];
      const values: readonly unknown[] = raw;
      for (const value of values) {
        if (!integer(value, 0) || order < this.minOrder || value % 2 ** order !== 0
          || value + 2 ** order > this.totalBytes || (list.length > 0 && value <= (list[list.length - 1] ?? 0))) throw new RangeError('invalid buddy free block');
        list.push(value); free.push({ start: value, size: 2 ** order });
      }
      lists.push(list);
    }
    ranges.push(...free);
    const allocated = new Map<number, BuddyBlock>();
    const rawAllocations: unknown[] = state['allocations'];
    for (const raw of rawAllocations) {
      if (!object(raw) || !integer(raw['base'], 0) || !integer(raw['order'], this.minOrder)
        || raw['order'] > this.maxOrder || !integer(raw['requested'], 1)) throw new RangeError('invalid buddy allocation');
      const base = raw['base']; const order = raw['order']; const requested = raw['requested']; const size = 2 ** order;
      if (base % size !== 0 || base + size > this.totalBytes || requestOrder(requested, this.minBlock) !== order || allocated.has(base)) throw new RangeError('invalid buddy allocation extent');
      allocated.set(base, { base, order, size, requested }); ranges.push({ start: base, size });
    }
    const reserved: Hole[] = [];
    const rawReserved: unknown[] = state['reserved'];
    for (const raw of rawReserved) {
      if (!object(raw) || !integer(raw['start'], 0) || !integer(raw['size'], 1)) throw new RangeError('invalid buddy reserved range');
      const previous = reserved[reserved.length - 1];
      if (previous !== undefined && previous.start + previous.size >= raw['start']) throw new RangeError('buddy reserved ranges must be sorted and coalesced');
      reserved.push({ start: raw['start'], size: raw['size'] });
    }
    ranges.push(...reserved); ranges.sort((a, b) => a.start - b.start); let cursor = 0;
    for (const range of ranges) {
      if (range.start !== cursor || !Number.isSafeInteger(range.start + range.size)) throw new RangeError('buddy state overlaps or loses bytes');
      cursor += range.size;
    }
    if (cursor !== this.totalBytes) throw new RangeError('buddy state does not cover region');
    const canonical = new BuddyAllocator(this.totalBytes, this.minBlock, free);
    const canonicalLists = canonical.freeLists;
    if (lists.some((list, order) => list.length !== canonicalLists[order]?.length
      || list.some((base, index) => base !== canonicalLists[order]?.[index]))) throw new RangeError('buddy free lists must be coalesced');
    for (let order = 0; order <= this.maxOrder; order++) { this.lists[order] = lists[order] ?? []; this.heads[order] = 0; }
    this.allocated.clear(); for (const [base, block] of allocated) this.allocated.set(base, block);
    this.reserved = reserved;
  }

  private pop(order: number): number | undefined {
    const list = this.lists[order]; const head = this.heads[order] ?? 0;
    const value = list?.[head]; if (value === undefined || list === undefined) return undefined;
    this.heads[order] = head + 1;
    if (head + 1 > list.length / 2) { list.splice(0, head + 1); this.heads[order] = 0; }
    return value;
  }
  private insert(order: number, base: number): void {
    const list = this.lists[order]; if (list === undefined) throw new Error('missing buddy order');
    let lower = this.heads[order] ?? 0; let upper = list.length;
    while (lower < upper) { const middle = Math.floor((lower + upper) / 2); if ((list[middle] ?? Infinity) < base) lower = middle + 1; else upper = middle; }
    list.splice(lower, 0, base);
  }
}
