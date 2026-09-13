import type { Hole } from './HoleList';

export function select(holes: readonly Hole[], request: number): number {
  if (!Number.isSafeInteger(request) || request <= 0) throw new RangeError('allocation request must be positive integer bytes');
  let selected = -1;
  for (let index = 0; index < holes.length; index++) {
    const hole = holes[index];
    const best = holes[selected];
    if (hole !== undefined && hole.size >= request && (best === undefined
      || hole.size < best.size || (hole.size === best.size && hole.start < best.start))) selected = index;
  }
  return selected;
}
