import type { Hole, Partition } from './contiguous/HoleList';
import { memoryInteger } from './FrameTable';

export type FragmentationMetrics = { readonly externalFragmentation: number; readonly internalFragmentation: number };
export type PagingAllocation = { readonly framesHeld: number; readonly bytesRequested: number };

export function contiguousFragmentation(holes: readonly Hole[], partitions: readonly Partition[]): FragmentationMetrics {
  let totalFree = 0;
  let largest = 0;
  let internal = 0;
  for (const hole of holes) {
    memoryInteger(hole.size, 'hole size');
    totalFree += hole.size;
    largest = Math.max(largest, hole.size);
  }
  for (const partition of partitions) {
    memoryInteger(partition.limit, 'allocated partition bytes');
    memoryInteger(partition.requested, 'requested partition bytes');
    if (partition.requested > partition.limit) throw new Error('memory partition is smaller than its request');
    internal += partition.limit - partition.requested;
  }
  return { externalFragmentation: totalFree === 0 ? 0 : 1 - largest / totalFree, internalFragmentation: internal };
}

export function pagingFragmentation(allocations: readonly PagingAllocation[], pageSize: number): FragmentationMetrics {
  memoryInteger(pageSize, 'page size', 1);
  let internal = 0;
  for (const allocation of allocations) {
    memoryInteger(allocation.framesHeld, 'held frame count');
    memoryInteger(allocation.bytesRequested, 'resident requested bytes');
    const allocated = memoryInteger(allocation.framesHeld * pageSize, 'resident allocated bytes');
    if (allocated < allocation.bytesRequested) throw new Error('memory resident allocation is smaller than its request');
    internal += allocated - allocation.bytesRequested;
  }
  return { externalFragmentation: 0, internalFragmentation: internal };
}
