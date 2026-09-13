import { memoryInteger } from './FrameTable';

/** Mirrors Rations in @game/types without importing across the kernel boundary. */
export type Rations = 'generous' | 'standard' | 'lean' | 'starved';
export type AllocationScheme = 'equal' | 'proportional';
export type ReplacementScope = 'local' | 'global';
export const DEFAULT_REPLACEMENT_SCOPE: ReplacementScope = 'local';
export const MIN_FRAMES = 3;
export type RationOptions = {
  readonly minFrames?: number;
  readonly allocationScheme?: AllocationScheme;
  readonly pageCount?: number;
  readonly totalPageCount?: number;
};
export type FrameBudgetOptions = { readonly totalFrames: number; readonly minFrames?: number; readonly devBuild?: boolean };

/** Suggested quotas always preserve the minimum, bounded by physical capacity. */
export function framesPerProcess(rations: Rations, totalFrames: number, activeProcesses: number, options: RationOptions = {}): number {
  memoryInteger(totalFrames, 'total frames');
  memoryInteger(activeProcesses, 'active process count');
  const minimum = Math.min(totalFrames, memoryInteger(options.minFrames ?? MIN_FRAMES, 'minimum frames', 1));
  if (activeProcesses === 0 || totalFrames === 0) return 0;
  let share = totalFrames / activeProcesses;
  if (options.allocationScheme === 'proportional') {
    const pages = memoryInteger(options.pageCount, 'process page count');
    const totalPages = memoryInteger(options.totalPageCount, 'total page count', 1);
    if (pages > totalPages) throw new Error('process page count exceeds the total page count');
    share = totalFrames * (pages / totalPages);
  }
  let budget: number;
  switch (rations) {
    case 'generous': budget = Math.floor(share * 1.5); break;
    case 'standard': budget = Math.floor(share); break;
    case 'lean': budget = Math.floor(share * 0.6); break;
    case 'starved': budget = minimum; break;
  }
  return Math.min(totalFrames, Math.max(minimum, budget));
}

/** Validate an explicit budget separately from computing the suggested quota. */
export function validateFrameBudget(requested: number, options: FrameBudgetOptions): number {
  memoryInteger(requested, 'requested frame budget');
  const total = memoryInteger(options.totalFrames, 'total frames');
  const minimum = Math.min(total, memoryInteger(options.minFrames ?? MIN_FRAMES, 'minimum frames', 1));
  if (options.devBuild && (requested < minimum || requested > total)) throw new Error('memory frame budget is outside physical allocation limits');
  return Math.min(total, Math.max(minimum, requested));
}
