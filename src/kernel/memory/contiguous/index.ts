import type { AllocationStrategy } from '../../types';
import type { Hole } from './HoleList';
import { select as firstFit } from './firstFit';
import { select as bestFit } from './bestFit';
import { select as worstFit } from './worstFit';
import { select as buddy } from './buddy';

export interface HoleSelector { select(holes: readonly Hole[], request: number): number }
export const ALLOCATORS: Readonly<Record<AllocationStrategy, HoleSelector>> = {
  first_fit: { select: firstFit }, best_fit: { select: bestFit },
  worst_fit: { select: worstFit }, buddy: { select: buddy },
};
export { HoleList } from './HoleList';
export type { Hole, Partition, AllocationResult, HoleListState } from './HoleList';
export { BuddyAllocator, buddyAddress } from './buddy';
export type { BuddyBlock, BuddyState } from './buddy';
