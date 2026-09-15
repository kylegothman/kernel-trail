import { KernelConfigError } from '../../errors';
import type { EmittableEvent } from '../../EventBus';
import type { BlockId, FileAllocationMethod, FsInodeSnapshot } from '../../types';
import { fsBlock, validateAllocationPair } from '../freeSpace';
import type { FreeSpace } from '../freeSpace';
import { MAX_FILE_SIZE } from '../InodeTable';
import { planContiguous } from './contiguous';
import { planLinked, LINKED_USABLE_BYTES } from './linked';
import { indexedAddress, planIndexed } from './indexed';
import { planExtent } from './extent';

export interface LayoutPlan {
  readonly blocks: readonly BlockId[];
  readonly mapping: readonly { readonly logicalBlock: number; readonly block: BlockId }[];
  readonly allocation: FsInodeSnapshot['allocation'];
  readonly indexBlock: BlockId | null;
  readonly allocated: readonly BlockId[];
  readonly freed: readonly BlockId[];
  readonly reads: number;
  /** All changed physical blocks, including index and in-block link changes. */
  readonly writes: number;
  /** Subset of writes for separate index blocks, or FAT updates. */
  readonly metadataWrites: number;
  readonly relocations: readonly { readonly from: BlockId; readonly to: BlockId }[];
}
export type AllocationResult = { readonly ok: true; readonly inode: FsInodeSnapshot } & LayoutPlan
  | { readonly ok: false; readonly errno: 'EINVAL' | 'ENOSPC' };
export interface AllocationOptions {
  readonly nextGeneration?: (block: BlockId) => number;
  readonly emit?: (event: EmittableEvent) => void;
  readonly fragmentationWarnExtents?: number;
}
export interface ReadPlan {
  /** Real ordered reads, including pointer traversal and index blocks. */
  readonly blocks: readonly BlockId[];
  readonly reads: number;
  /** Logical file-run starts, distinct from media cylinder travel. */
  readonly logicalRunStarts: number;
  readonly dataBlocks: readonly BlockId[];
}
export interface AllocationPolicy {
  readonly id: FileAllocationMethod;
  allocate(inode: FsInodeSnapshot, positions: readonly number[], free: FreeSpace, options?: AllocationOptions): AllocationResult;
  readPlan(inode: FsInodeSnapshot, positions: readonly number[], mode?: 'random' | 'sequential'): ReadPlan;
}

const planners = { contiguous: planContiguous, linked: planLinked, indexed: planIndexed, extent: planExtent };
export function usableBlockBytes(inode: FsInodeSnapshot): number { return inode.allocation.kind === 'linked' && inode.allocation.variant === 'in_block' ? LINKED_USABLE_BYTES : 4096; }
export function allocateBlocks(inode: FsInodeSnapshot, positions: readonly number[], free: FreeSpace, options: AllocationOptions = {}): AllocationResult {
  validateAllocationPair(inode.method, free.method);
  if (positions.some(position => !Number.isSafeInteger(position) || position < 0 || position >= Math.ceil(MAX_FILE_SIZE / usableBlockBytes(inode)))) return { ok: false, errno: 'EINVAL' };
  const sorted = [...new Set(positions)].sort((a, b) => a - b); const trial = free.clone();
  const plan = planners[inode.method](inode, sorted, trial); if (plan === null) return { ok: false, errno: 'ENOSPC' };
  const generations = new Map(inode.mapping.map(entry => [entry.block, entry.generation]));
  for (const block of plan.allocated) generations.set(block, options.nextGeneration?.(block) ?? (generations.get(block) ?? 0) + 1);
  const result: FsInodeSnapshot = { ...inode, blocks: [...plan.blocks], indexBlock: plan.indexBlock, allocation: plan.allocation,
    mapping: plan.mapping.map(entry => ({ ...entry, generation: generations.get(entry.block) ?? 1 })) };
  free.restore(trial.snapshot()); free.wordsScanned += trial.wordsScanned; free.reads += trial.reads; free.writes += trial.writes;
  for (const block of plan.allocated) options.emit?.({ type: 'fs.block_allocated', inode: inode.id, block, method: inode.method });
  if (result.allocation.kind === 'extent' && plan.allocated.length > 0 && result.allocation.extents.length > (options.fragmentationWarnExtents ?? 4)) options.emit?.({ type: 'fs.fragmented', inode: inode.id, extents: result.allocation.extents.length });
  return { ok: true, ...plan, inode: result };
}

export function readPlan(inode: FsInodeSnapshot, positions: readonly number[], mode: 'random' | 'sequential' = 'random'): ReadPlan {
  if (positions.some(position => !Number.isSafeInteger(position) || position < 0)) throw new KernelConfigError('invalid logical read position');
  const reads: BlockId[] = []; const dataBlocks: BlockId[] = []; const visitedIndexes = new Set<BlockId>();
  const mapping = new Map(inode.mapping.map(entry => [entry.logicalBlock, entry.block]));
  for (const position of positions) {
    const block = mapping.get(position); if (block === undefined) continue; // Sparse holes produce zeros without media access.
    dataBlocks.push(block);
    if (inode.allocation.kind === 'linked' && mode === 'random') {
      const links = new Map(inode.allocation.links.map(link => [link.block, link.next])); const visited = new Set<BlockId>();
      for (let cursor: BlockId | null = inode.blocks[0] ?? null; cursor !== null;) {
        if (visited.has(cursor) || !links.has(cursor)) throw new KernelConfigError('invalid linked allocation chain');
        visited.add(cursor); if (inode.allocation.variant === 'in_block') reads.push(cursor); if (cursor === block) break; cursor = links.get(cursor) ?? null;
      }
      if (!visited.has(block)) throw new KernelConfigError('linked allocation target is disconnected');
      if (inode.allocation.variant === 'fat') reads.push(block);
    } else if (inode.allocation.kind === 'indexed') {
      const address = indexedAddress(position); const root = inode.allocation.roots.find(entry => entry.logicalStart === address.logicalStart);
      let cursor = root?.block;
      for (const index of address.indices) {
        if (cursor === undefined) throw new KernelConfigError('missing index root');
        const node = inode.allocation.nodes.find(entry => entry.block === cursor); if (node === undefined) throw new KernelConfigError('missing index node');
        if (mode === 'random' || !visitedIndexes.has(cursor)) reads.push(cursor);
        visitedIndexes.add(cursor); cursor = node.pointers[index] ?? undefined;
      }
      if (cursor !== block) throw new KernelConfigError('index pointer disagrees with mapping'); reads.push(block);
    } else reads.push(block);
  }
  let logicalRunStarts = 0;
  for (let i = 0; i < dataBlocks.length; i += 1) if (mode === 'random' || i === 0 || dataBlocks[i] !== dataBlocks[i - 1]! + 1) logicalRunStarts += 1;
  return { blocks: reads, reads: reads.length, logicalRunStarts, dataBlocks };
}

const policies = new Map<FileAllocationMethod, AllocationPolicy>(Object.keys(planners).map(key => {
  const id = key as FileAllocationMethod;
  return [id, { id, allocate: (inode, positions, free, options) => { if (inode.method !== id) throw new KernelConfigError('allocation policy does not match inode'); return allocateBlocks(inode, positions, free, options); }, readPlan: (inode, positions, mode) => { if (inode.method !== id) throw new KernelConfigError('allocation policy does not match inode'); return readPlan(inode, positions, mode); } }];
}));
export function allocationPolicy(method: FileAllocationMethod): AllocationPolicy { const policy = policies.get(method); if (policy === undefined) throw new KernelConfigError(`unknown allocation method ${method}`); return policy; }
export const createAllocationPolicy = allocationPolicy;
export const ALLOCATION_METHODS: readonly FileAllocationMethod[] = ['contiguous', 'linked', 'indexed', 'extent'];

/** Unit conversion at the storage boundary: 4096 bytes contain eight sectors. */
export function fsBlockSectors(block: BlockId): BlockId[] { return Array.from({ length: 8 }, (_, i) => fsBlock(block * 8 + i)); }
export function physicalReadCost(blocks: readonly BlockId[], startingCylinder = 0): { readonly sectorReads: number; readonly cylinderTransitions: number; readonly headMovement: number } {
  let cylinder = startingCylinder; let transitions = 0; let movement = 0;
  for (const block of blocks) { const target = Math.floor(block / 32); if (target !== cylinder) transitions += 1; movement += Math.abs(target - cylinder); cylinder = target; }
  return { sectorReads: blocks.length * 8, cylinderTransitions: transitions, headMovement: movement };
}
