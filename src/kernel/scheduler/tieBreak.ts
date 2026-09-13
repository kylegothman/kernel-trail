import type { ProcessControlBlock } from '../types';

/** The universal scheduler tie-break from sim spec 5.1. */
export function tieBreak(a: ProcessControlBlock, b: ProcessControlBlock): number {
  if (a.arrivalTick !== b.arrivalTick) return a.arrivalTick - b.arrivalTick;
  return a.pid - b.pid;
}

/** Check finite, antisymmetric comparisons and reject distinct-pid ties. */
export function assertTotalOrder(
  comparator: (a: ProcessControlBlock, b: ProcessControlBlock) => number,
  samples: readonly ProcessControlBlock[],
): void {
  for (const a of samples) {
    if (comparator(a, a) !== 0) throw new Error(`scheduler comparator does not compare P${a.pid} equal to itself`);
    for (const b of samples) {
      if (a.pid === b.pid) continue;
      const forward = comparator(a, b);
      const reverse = comparator(b, a);
      if (!Number.isFinite(forward) || !Number.isFinite(reverse) || forward === 0 || reverse === 0) {
        throw new Error(`scheduler comparator does not order distinct processes P${a.pid} and P${b.pid}`);
      }
      if (Math.sign(forward) !== -Math.sign(reverse)) {
        throw new Error(`scheduler comparator is not antisymmetric for P${a.pid} and P${b.pid}`);
      }
    }
  }
}
