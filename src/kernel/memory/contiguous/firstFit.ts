import type { Hole } from './HoleList';

export function select(holes: readonly Hole[], request: number): number {
  if (!Number.isSafeInteger(request) || request <= 0) throw new RangeError('allocation request must be positive integer bytes');
  return holes.findIndex(hole => hole.size >= request);
}
