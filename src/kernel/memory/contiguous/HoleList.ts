import { asPid } from '../../types';
import type { AllocationStrategy, Pid } from '../../types';
import { select as firstFit } from './firstFit';
import { select as bestFit } from './bestFit';
import { select as worstFit } from './worstFit';
import { BuddyAllocator, isPowerOfTwo } from './buddy';

export interface Hole { start: number; size: number }
/** The limit register contains a length, so the occupied range is [base, base + limit). */
export interface Partition { readonly pid: Pid; base: number; limit: number; requested: number }
export type AllocationResult = { readonly ok: true; readonly partition: Readonly<Partition> }
  | { readonly ok: false; readonly reason: 'no_space' | 'fragmentation' };
export type HoleListState = {
  readonly totalBytes: number;
  readonly minBlock: number;
  readonly strategy: AllocationStrategy;
  readonly holes: readonly { readonly start: number; readonly size: number }[];
  readonly partitions: readonly { readonly pid: Pid; readonly base: number; readonly limit: number; readonly requested: number }[];
  readonly reserved: readonly { readonly start: number; readonly size: number }[];
};

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strategy(value: unknown): value is AllocationStrategy {
  return value === 'first_fit' || value === 'best_fit' || value === 'worst_fit' || value === 'buddy';
}
function ranges(value: unknown, total: number): Hole[] {
  if (!Array.isArray(value)) throw new RangeError('memory ranges must be an array');
  const result: Hole[] = []; const values: readonly unknown[] = value;
  for (const entry of values) {
    if (!object(entry) || !integer(entry['start'], 0) || !integer(entry['size'], 1)
      || !Number.isSafeInteger(entry['start'] + entry['size']) || entry['start'] + entry['size'] > total) throw new RangeError('invalid memory range');
    const previous = result[result.length - 1];
    if (previous !== undefined && previous.start + previous.size >= entry['start']) throw new RangeError('memory ranges must be sorted, disjoint and coalesced');
    result.push({ start: entry['start'], size: entry['size'] });
  }
  return result;
}
function coalesce(holes: readonly Hole[], total: number): Hole[] {
  const result: Hole[] = [];
  for (const hole of [...holes].sort((a, b) => a.start - b.start)) {
    if (!integer(hole.start, 0) || !integer(hole.size, 1) || !Number.isSafeInteger(hole.start + hole.size)
      || hole.start + hole.size > total) throw new RangeError('invalid free hole');
    const previous = result[result.length - 1];
    if (previous !== undefined && previous.start + previous.size > hole.start) throw new RangeError('free holes overlap');
    if (previous !== undefined && previous.start + previous.size === hole.start) previous.size += hole.size;
    else result.push({ ...hole });
  }
  return result;
}

/** Physical free ranges and placements are shared by every allocation strategy. */
export class HoleList {
  private freeRanges: Hole[];
  private readonly placements: Partition[] = [];
  private reserved: Hole[];
  private currentStrategy: AllocationStrategy;
  private buddy: BuddyAllocator | undefined;
  private readonly visible: Hole[] = [];

  constructor(readonly totalBytes: number, allocationStrategy: AllocationStrategy = 'first_fit',
    readonly minBlock = 4096, initialHoles: readonly Hole[] = [{ start: 0, size: totalBytes }]) {
    if (!integer(totalBytes, 1) || !isPowerOfTwo(minBlock) || !strategy(allocationStrategy)) throw new RangeError('invalid contiguous memory configuration');
    this.freeRanges = coalesce(initialHoles, totalBytes);
    this.reserved = []; let cursor = 0;
    for (const hole of this.freeRanges) {
      if (hole.start > cursor) this.reserved.push({ start: cursor, size: hole.start - cursor });
      cursor = hole.start + hole.size;
    }
    if (cursor < totalBytes) this.reserved.push({ start: cursor, size: totalBytes - cursor });
    this.currentStrategy = allocationStrategy;
    this.refresh();
  }

  get strategy(): AllocationStrategy { return this.currentStrategy; }
  get holes(): readonly Readonly<Hole>[] { return this.visible; }
  get partitions(): readonly Readonly<Partition>[] { return this.placements; }
  get totalFreeBytes(): number { return this.freeRanges.reduce((sum, hole) => sum + hole.size, 0); }
  get largestFreeHole(): number { return this.visible.reduce((largest, hole) => Math.max(largest, hole.size), 0); }
  get buddyFreeLists(): readonly (readonly number[])[] { return this.buddy?.freeLists ?? []; }

  allocate(pid: Pid, request: number): AllocationResult {
    if (!integer(pid, 0) || !integer(request, 1)) throw new RangeError('pid and allocation request must be integers');
    if (this.placements.some(partition => partition.pid === pid)) throw new RangeError('process already has a contiguous partition');
    let base: number; let size = request; let selected = -1;
    if (this.currentStrategy === 'buddy') {
      const block = this.buddy?.allocate(request);
      if (block === null || block === undefined) return { ok: false, reason: 'no_space' };
      base = block.base; size = block.size;
      selected = this.freeRanges.findIndex(hole => hole.start <= base && hole.start + hole.size >= base + size);
    } else {
      const choose = this.currentStrategy === 'first_fit' ? firstFit : this.currentStrategy === 'best_fit' ? bestFit : worstFit;
      selected = choose(this.freeRanges, request);
      const hole = this.freeRanges[selected];
      if (hole === undefined) return { ok: false, reason: this.totalFreeBytes >= request ? 'fragmentation' : 'no_space' };
      base = hole.start;
    }
    const hole = this.freeRanges[selected];
    if (hole === undefined) throw new Error('allocator selected bytes outside free memory');
    const replacement: Hole[] = [];
    if (base > hole.start) replacement.push({ start: hole.start, size: base - hole.start });
    if (base + size < hole.start + hole.size) replacement.push({ start: base + size, size: hole.start + hole.size - base - size });
    this.freeRanges.splice(selected, 1, ...replacement);
    const partition: Partition = { pid, base, limit: size, requested: request };
    this.placements.push(partition); this.refresh();
    return { ok: true, partition };
  }

  free(pid: Pid): boolean {
    const index = this.placements.findIndex(partition => partition.pid === pid);
    const partition = this.placements[index]; if (partition === undefined) return false;
    const next = coalesce([...this.freeRanges, { start: partition.base, size: partition.limit }], this.totalBytes);
    this.placements.splice(index, 1); this.freeRanges = next; this.refresh(); return true;
  }

  setStrategy(next: AllocationStrategy): void {
    if (!strategy(next)) throw new RangeError('unknown contiguous allocation strategy');
    if (next === 'buddy' && (!isPowerOfTwo(this.totalBytes) || this.minBlock > this.totalBytes)) throw new RangeError('buddy requires a power-of-two region at least one minimum block long');
    this.currentStrategy = next; this.refresh();
  }

  saveState(): HoleListState {
    return { totalBytes: this.totalBytes, minBlock: this.minBlock, strategy: this.currentStrategy,
      holes: this.freeRanges.map(hole => ({ ...hole })), partitions: this.placements.map(partition => ({ ...partition })),
      reserved: this.reserved.map(hole => ({ ...hole })) };
  }

  restoreState(state: unknown): void {
    if (!object(state) || state['totalBytes'] !== this.totalBytes || state['minBlock'] !== this.minBlock
      || !strategy(state['strategy']) || !Array.isArray(state['partitions'])) throw new RangeError('invalid contiguous allocation state');
    const free = ranges(state['holes'], this.totalBytes);
    const reserved = ranges(state['reserved'], this.totalBytes);
    const placements: Partition[] = []; const pids = new Set<Pid>();
    const entries: readonly unknown[] = state['partitions'];
    for (const entry of entries) {
      if (!object(entry) || !integer(entry['pid'], 0) || !integer(entry['base'], 0)
        || !integer(entry['limit'], 1) || !integer(entry['requested'], 1)
        || entry['requested'] > entry['limit'] || !Number.isSafeInteger(entry['base'] + entry['limit'])
        || entry['base'] + entry['limit'] > this.totalBytes) throw new RangeError('invalid contiguous partition');
      const pid = asPid(entry['pid']);
      if (pids.has(pid)) throw new RangeError('duplicate contiguous partition pid');
      pids.add(pid); placements.push({ pid, base: entry['base'], limit: entry['limit'], requested: entry['requested'] });
    }
    const covered = [...free, ...reserved, ...placements.map(partition => ({ start: partition.base, size: partition.limit }))]
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const range of covered) {
      if (range.start !== cursor) throw new RangeError('contiguous state overlaps or loses bytes');
      cursor += range.size;
    }
    if (cursor !== this.totalBytes) throw new RangeError('contiguous state does not cover region');
    const nextBuddy = state['strategy'] === 'buddy' ? new BuddyAllocator(this.totalBytes, this.minBlock, free) : undefined;
    this.currentStrategy = state['strategy']; this.freeRanges = free; this.reserved = reserved;
    this.placements.length = 0; this.placements.push(...placements); this.buddy = nextBuddy; this.refresh();
  }

  private refresh(): void {
    this.visible.length = 0;
    if (this.currentStrategy !== 'buddy') {
      this.buddy = undefined; this.visible.push(...this.freeRanges.map(hole => ({ ...hole }))); return;
    }
    if (this.buddy === undefined) this.buddy = new BuddyAllocator(this.totalBytes, this.minBlock, this.freeRanges);
    else this.buddy.resetFromHoles(this.freeRanges);
    const blocks = this.buddy.freeHoles;
    for (const range of this.freeRanges) {
      let cursor = range.start;
      for (const block of blocks) {
        if (block.start < range.start || block.start >= range.start + range.size) continue;
        if (block.start > cursor) this.visible.push({ start: cursor, size: block.start - cursor });
        this.visible.push({ ...block }); cursor = block.start + block.size;
      }
      if (cursor < range.start + range.size) this.visible.push({ start: cursor, size: range.start + range.size - cursor });
    }
  }
}
