/**
 * KERNEL TRAIL, the Narrows: the workload and the primitives.
 *
 * Nine processes and five bindings. Spawn order is admission order, because
 * phase 5 admits new processes in pid order up to the degree of
 * multiprogramming, so the four Programs that actually contend for something
 * are spawned before the four convoy Programs that only travel. SABLE is
 * spawned fifth for the same reason: she has to be resident to block.
 *
 * Every process asks for three pages or fewer. With `vm` disabled a process
 * that touches a page past its admission budget throws out of the tick, and
 * the floor is three frames at starved rations, which is what the chaotic
 * policy sets at tick 0.
 *
 * Seven primitives. Five are the package's; `lock.plank` and the two extra
 * ford semaphores are the shape the engine actually permits. `declareSync`
 * fixes a semaphore's count at creation and there is no runtime raise, so the
 * ford's three capacities are three declared semaphores and the dial selects
 * between them (WP-L04 ruling 6). Every one of them is ordered, because
 * `declareSync` creates ordered primitives and a leg cannot ask for an
 * unordered wait queue (ruling 7).
 */
import type { ConvoyMemberId } from '@kernel/types';
import type { LegSetupContext } from '@game/types';
import {
  FORD_WIDTH, HAULER, LOCK_FORD_A, LOCK_FORD_B, LOCK_MANIFEST, MON_FORD, PILGRIM_A, PILGRIM_B,
  PROGRAM_SERVICE, SABLE_PROCESS, SEM_FORD, SEM_FORD_3, SEM_FORD_4, SWEEP,
} from './ledger';

/** The mutex the plank crossing reads its contention from. No Program ever takes it: the plank is unguarded, which is the lesson, and its pressure is the system's own. */
export const LOCK_PLANK = 'lock.plank';

interface Spec {
  readonly name: string;
  readonly priority: number;
  readonly burst: number;
  readonly service: number;
  readonly arrival: number;
  readonly member: ConvoyMemberId | null;
}

/**
 * Pid order is admission order: phase 5 admits new processes in pid order up
 * to the degree of multiprogramming, so the two Programs that contend for the
 * same mutex are the two lowest pids and a run at any degree above one has
 * something to teach. The Programs that only travel are last and cost a tick
 * each.
 */
export const ROSTER: readonly Spec[] = [
  { name: SWEEP, priority: 9, burst: 4, service: PROGRAM_SERVICE[SWEEP] ?? 140, arrival: 0, member: null },
  { name: PILGRIM_A, priority: 4, burst: 3, service: PROGRAM_SERVICE[PILGRIM_A] ?? 140, arrival: 8, member: null },
  { name: PILGRIM_B, priority: 4, burst: 3, service: PROGRAM_SERVICE[PILGRIM_B] ?? 140, arrival: 8, member: null },
  { name: HAULER, priority: 5, burst: 8, service: PROGRAM_SERVICE[HAULER] ?? 60, arrival: 16, member: null },
  { name: 'LUMEN', priority: 2, burst: 6, service: PROGRAM_SERVICE['LUMEN'] ?? 26, arrival: 14, member: 'lumen' },
  { name: SABLE_PROCESS, priority: 1, burst: 5, service: PROGRAM_SERVICE[SABLE_PROCESS] ?? 90, arrival: 20, member: 'sable' },
  { name: 'ORRERY', priority: 3, burst: 5, service: PROGRAM_SERVICE['ORRERY'] ?? 12, arrival: 44, member: 'orrery' },
  { name: 'KESTREL', priority: 3, burst: 4, service: PROGRAM_SERVICE['KESTREL'] ?? 12, arrival: 48, member: 'kestrel' },
  { name: 'VESPER', priority: 3, burst: 5, service: PROGRAM_SERVICE['VESPER'] ?? 12, arrival: 52, member: 'vesper' },
];

export const SYNC_DECLARATIONS: readonly { readonly id: string; readonly kind: 'mutex' | 'semaphore' | 'monitor' | 'rwlock'; readonly capacity: number }[] = [
  { id: LOCK_PLANK, kind: 'mutex', capacity: 1 },
  { id: LOCK_FORD_A, kind: 'mutex', capacity: 1 },
  { id: LOCK_FORD_B, kind: 'mutex', capacity: 1 },
  { id: SEM_FORD, kind: 'semaphore', capacity: 1 },
  { id: SEM_FORD_3, kind: 'semaphore', capacity: FORD_WIDTH },
  { id: SEM_FORD_4, kind: 'semaphore', capacity: 4 },
  { id: MON_FORD, kind: 'monitor', capacity: 1 },
  { id: LOCK_MANIFEST, kind: 'mutex', capacity: 1 },
];

export function populate(ctx: LegSetupContext): void {
  for (const spec of ROSTER) {
    const pid = ctx.spawn({ name: spec.name, priority: spec.priority, burst: spec.burst, service: spec.service, arrival: spec.arrival, pages: 3 });
    if (spec.member !== null) ctx.bind(spec.member, pid);
  }
  for (const declaration of SYNC_DECLARATIONS) ctx.declareSync(declaration.id, declaration.kind, declaration.capacity);
}
