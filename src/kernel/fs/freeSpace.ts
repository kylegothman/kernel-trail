import { KernelConfigError } from '../errors';
import type { BlockId, FileAllocationMethod, FsFreeSpaceSnapshot } from '../types';

export type FreeSpaceMethod = FsFreeSpaceSnapshot['kind'];
export const fsBlock = (value: number): BlockId => value as BlockId;

/** Sim spec 12.4: skip full words and extract their lowest free bit. */
export function firstFreeBlock(bitmap: Uint32Array, visit?: () => void): BlockId | null {
  for (let w = 0; w < bitmap.length; w += 1) {
    visit?.();
    if (bitmap[w] === 0xffffffff) continue;
    const inverted = ~bitmap[w]! >>> 0;
    const bit = 31 - Math.clz32(inverted & -inverted);
    return fsBlock(w * 32 + bit);
  }
  return null;
}

export function validateAllocationPair(method: FileAllocationMethod, freeSpace: FreeSpaceMethod): void {
  if (method === 'contiguous' && freeSpace === 'linked_list') {
    throw new KernelConfigError('contiguous allocation cannot use linked_list free space');
  }
}

/** Bitmap membership also makes validation independent of free-list order. */
export class FreeSpace {
  readonly bitmap: Uint32Array;
  wordsScanned = 0;
  reads = 0;
  writes = 0;
  private head: BlockId | null = null;
  private readonly next = new Map<BlockId, BlockId | null>();
  private readonly previous = new Map<BlockId, BlockId | null>();

  constructor(readonly totalBlocks: number, readonly method: FreeSpaceMethod = 'bitmap', reserved: readonly BlockId[] = []) {
    if (!Number.isSafeInteger(totalBlocks) || totalBlocks < 0) throw new KernelConfigError('invalid filesystem block count');
    this.bitmap = new Uint32Array(Math.ceil(totalBlocks / 32));
    // Padding is permanently occupied; it must never escape firstFreeBlock.
    if (totalBlocks % 32 !== 0) this.bitmap[this.bitmap.length - 1] = (0xffffffff << (totalBlocks % 32)) >>> 0;
    for (let b = totalBlocks - 1; b >= 0; b -= 1) this.linkHead(fsBlock(b));
    this.reserve(reserved);
    this.reads = 0; this.writes = 0;
  }

  get overheadBytes(): number { return this.method === 'bitmap' ? this.bitmap.byteLength : 0; }
  get freeCount(): number { return this.next.size; }
  isFree(block: BlockId): boolean { return Number.isSafeInteger(block) && block >= 0 && block < this.totalBlocks && (this.bitmap[block >>> 5]! & (1 << (block & 31))) === 0; }

  allocate(count = 1): BlockId[] | null {
    if (!Number.isSafeInteger(count) || count < 0) throw new KernelConfigError('invalid free-space request');
    if (count > this.freeCount) return null;
    const result: BlockId[] = [];
    for (let i = 0; i < count; i += 1) {
      const block = this.method === 'linked_list' || this.method === 'grouping'
        ? this.head : firstFreeBlock(this.bitmap, () => { this.wordsScanned += 1; });
      if (block === null) throw new Error('free-space membership disagrees with allocator');
      this.take(block); result.push(block); this.reads += 1;
    }
    return result;
  }

  allocateRun(count: number, preferred?: BlockId): BlockId[] | null {
    if (!Number.isSafeInteger(count) || count < 0) throw new KernelConfigError('invalid run length');
    if (count === 0) return [];
    if (this.method === 'linked_list') return null;
    const fits = (start: number): boolean => start >= 0 && start + count <= this.totalBlocks
      && Array.from({ length: count }, (_, i) => this.isFree(fsBlock(start + i))).every(Boolean);
    let start = preferred !== undefined && fits(preferred) ? Number(preferred) : -1;
    if (start < 0) {
      let run = 0;
      for (let b = 0; b < this.totalBlocks; b += 1) {
        if ((b & 31) === 0) this.wordsScanned += 1;
        run = this.isFree(fsBlock(b)) ? run + 1 : 0;
        if (run === count) { start = b - count + 1; break; }
      }
    }
    if (start < 0) return null;
    const result = Array.from({ length: count }, (_, i) => fsBlock(start + i));
    this.reserve(result); return result;
  }

  reserve(blocks: readonly BlockId[]): void {
    const unique = new Set(blocks);
    if (unique.size !== blocks.length || blocks.some(block => !this.isFree(block))) throw new KernelConfigError('block reservation is not free');
    for (const block of blocks) this.take(block);
  }

  release(blocks: readonly BlockId[]): void {
    if (new Set(blocks).size !== blocks.length || blocks.some(block => !Number.isSafeInteger(block) || block < 0 || block >= this.totalBlocks || this.isFree(block))) throw new KernelConfigError('invalid block release');
    for (const block of blocks) {
      this.bitmap[block >>> 5] = (this.bitmap[block >>> 5]! & ~(1 << (block & 31))) >>> 0;
      this.linkHead(block); this.writes += 1;
    }
  }

  snapshot(): FsFreeSpaceSnapshot {
    if (this.method === 'bitmap') return { kind: 'bitmap', words: [...this.bitmap] };
    if (this.method === 'counting') {
      const runs: { start: BlockId; length: number }[] = [];
      for (let b = 0; b < this.totalBlocks; b += 1) {
        if (!this.isFree(fsBlock(b))) continue;
        const last = runs.at(-1);
        if (last !== undefined && last.start + last.length === b) last.length += 1;
        else runs.push({ start: fsBlock(b), length: 1 });
      }
      return { kind: 'counting', runs };
    }
    const order: BlockId[] = [];
    for (let b = this.head; b !== null; b = this.next.get(b) ?? null) order.push(b);
    if (this.method === 'linked_list') return { kind: 'linked_list', head: this.head, nodes: order.map(block => ({ block, next: this.next.get(block) ?? null })) };
    const groups = [];
    for (let i = 0; i < order.length; i += 128) groups.push({ block: order[i]!, entries: order.slice(i + 1, i + 128), next: order[i + 128] ?? null });
    return { kind: 'grouping', head: this.head, groups };
  }

  restore(snapshot: FsFreeSpaceSnapshot): void {
    if (snapshot.kind !== this.method) throw new KernelConfigError('free-space method mismatch');
    const free: BlockId[] = [];
    if (snapshot.kind === 'bitmap') {
      if (snapshot.words.length !== this.bitmap.length || snapshot.words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffffffff)) throw new KernelConfigError('invalid bitmap');
      for (let b = 0; b < this.totalBlocks; b += 1) if ((snapshot.words[b >>> 5]! & (1 << (b & 31))) === 0) free.push(fsBlock(b));
      if (this.totalBlocks % 32 !== 0) {
        const mask = (0xffffffff << (this.totalBlocks % 32)) >>> 0;
        if (((snapshot.words.at(-1)! & mask) >>> 0) !== mask) throw new KernelConfigError('bitmap padding must be reserved');
      }
    } else if (snapshot.kind === 'counting') {
      let end = -1;
      for (const run of snapshot.runs) {
        if (!Number.isSafeInteger(run.start) || !Number.isSafeInteger(run.length) || run.length < 1 || run.start <= end) throw new KernelConfigError('invalid counting run');
        for (let i = 0; i < run.length; i += 1) free.push(fsBlock(run.start + i));
        end = run.start + run.length - 1;
      }
    } else if (snapshot.kind === 'linked_list') {
      const nodes = new Map(snapshot.nodes.map(node => [node.block, node.next]));
      if (nodes.size !== snapshot.nodes.length) throw new KernelConfigError('duplicate free-list node');
      const seen = new Set<BlockId>();
      for (let b = snapshot.head; b !== null; b = nodes.get(b) ?? null) {
        if (seen.has(b) || !nodes.has(b)) throw new KernelConfigError('invalid free-list chain');
        seen.add(b); free.push(b);
      }
      if (seen.size !== nodes.size) throw new KernelConfigError('disconnected free-list node');
    } else {
      const groups = new Map(snapshot.groups.map(group => [group.block, group]));
      const seen = new Set<BlockId>();
      for (let b = snapshot.head; b !== null;) {
        const group = groups.get(b);
        if (group === undefined || seen.has(b) || group.entries.length > 127) throw new KernelConfigError('invalid free-space group');
        seen.add(b); free.push(b, ...group.entries); b = group.next;
      }
      if (seen.size !== groups.size) throw new KernelConfigError('disconnected free-space group');
    }
    if (new Set(free).size !== free.length || free.some(b => !Number.isSafeInteger(b) || b < 0 || b >= this.totalBlocks)) throw new KernelConfigError('invalid free block');
    this.bitmap.fill(0xffffffff); this.next.clear(); this.previous.clear(); this.head = null;
    for (let i = free.length - 1; i >= 0; i -= 1) {
      const b = free[i]!; this.bitmap[b >>> 5] = (this.bitmap[b >>> 5]! & ~(1 << (b & 31))) >>> 0; this.linkHead(b);
    }
  }

  clone(): FreeSpace { const copy = new FreeSpace(this.totalBlocks, this.method); copy.restore(this.snapshot()); return copy; }

  private linkHead(block: BlockId): void {
    this.next.set(block, this.head); this.previous.set(block, null);
    if (this.head !== null) this.previous.set(this.head, block);
    this.head = block;
  }
  private take(block: BlockId): void {
    const next = this.next.get(block) ?? null; const previous = this.previous.get(block) ?? null;
    if (previous === null) this.head = next; else this.next.set(previous, next);
    if (next !== null) this.previous.set(next, previous);
    this.next.delete(block); this.previous.delete(block);
    this.bitmap[block >>> 5] = (this.bitmap[block >>> 5]! | (1 << (block & 31))) >>> 0;
  }
}
