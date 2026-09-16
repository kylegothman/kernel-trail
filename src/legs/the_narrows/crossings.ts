/**
 * KERNEL TRAIL, the Narrows: three crossings in the world, five definitions in
 * data.
 *
 * The four options and their cost formulas are WP-19's and are not restated
 * here; a crossing is a lock to read contention from, an anchor to stand at,
 * and an id the debrief can name. Contention is computed from the live
 * `KernelSnapshot` by the shared formula, so the numbers below are what the
 * workload produces rather than authored difficulty.
 *
 * The plank reads `lock.plank`, which no Program ever takes. That is not a
 * workaround: the plank is the unguarded crossing, its queue is empty by
 * construction, and what is left of the shared formula is the system pressure
 * term, which is the 0.20 the plank is designed to sit at.
 *
 * The wide ford has one definition per capacity the dial can select, because
 * a semaphore's count is fixed when it is created. The one the player crosses
 * is the one the dial is pointing at, and the debrief names the count.
 */
import type { CrossingDef } from '@game/crossing/Crossing';
import { FORD_WIDTH, LOCK_FORD_A, SEM_FORD, SEM_FORD_3, SEM_FORD_4 } from './ledger';
import { LOCK_PLANK } from './populate';

export const PLANK = 'crossing.plank';
export const SECOND_FORD = 'crossing.second_ford';
export const WIDE_FORD = 'crossing.wide_ford';
export const WIDE_FORD_3 = 'crossing.wide_ford.3';
export const WIDE_FORD_4 = 'crossing.wide_ford.4';

const def = (id: string, lockId: string, kind: CrossingDef['kind'], anchor: string): CrossingDef => ({
  id, legId: 'the_narrows', lockId, kind, ordered: true, anchor, crosser: null,
});

export const crossings: readonly CrossingDef[] = [
  def(PLANK, LOCK_PLANK, 'mutex', 'anchor.turnstile'),
  def(SECOND_FORD, LOCK_FORD_A, 'mutex', 'anchor.second_ford'),
  def(WIDE_FORD, SEM_FORD, 'semaphore', 'anchor.wide_ford'),
  def(WIDE_FORD_3, SEM_FORD_3, 'semaphore', 'anchor.wide_ford'),
  def(WIDE_FORD_4, SEM_FORD_4, 'semaphore', 'anchor.wide_ford'),
];

/** The wide ford definition the capacity dial is pointing at. */
export function wideFordFor(capacity: number): string {
  return capacity === FORD_WIDTH ? WIDE_FORD_3 : capacity === 4 ? WIDE_FORD_4 : WIDE_FORD;
}

export const WIDE_FORD_IDS: readonly string[] = [WIDE_FORD, WIDE_FORD_3, WIDE_FORD_4];

/** Crossing three is four cores. Crossings one and two are one core, which is what makes the interrupt switch a lesson. */
export const CORES: Readonly<Record<string, number>> = {
  [PLANK]: 1, [SECOND_FORD]: 1, [WIDE_FORD]: 4, [WIDE_FORD_3]: 4, [WIDE_FORD_4]: 4,
};
