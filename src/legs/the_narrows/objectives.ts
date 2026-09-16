/**
 * KERNEL TRAIL, the Narrows: the six learning objectives.
 *
 * Transcribed from `docs/05-CURRICULUM-MAP.md`, "Leg 4. THE NARROWS",
 * "Learning objectives". The statements are the map's; the citations are
 * rebuilt through `cite` so each one is checked against the leg's declared
 * coverage. `evaluate` judges each of them and names them by these ids.
 */
import type { LearningObjective } from '@game/types';
import { cite } from './chapters';

export const THREE_REQUIREMENTS = 'obj.the_narrows.three_requirements';
export const SPIN_VERSUS_BLOCK = 'obj.the_narrows.spin_versus_block';
export const MINIMAL_CRITICAL_SECTION = 'obj.the_narrows.minimal_critical_section';
export const ATOMIC_PRIMITIVE = 'obj.the_narrows.atomic_primitive';
export const SEMAPHORE_CAPACITY = 'obj.the_narrows.semaphore_capacity';
export const PRIORITY_INVERSION = 'obj.the_narrows.priority_inversion';

export const objectives: readonly LearningObjective[] = [
  {
    id: THREE_REQUIREMENTS,
    statement: 'Selects a ford protocol that holds mutual exclusion, progress and bounded waiting together, ending the leg with zero sync.race_detected events and no Program waiting more than three turns for the plank.',
    chapter: cite('6.2'),
    assessedBy: 'outcome',
  },
  {
    id: SPIN_VERSUS_BLOCK,
    statement: 'Spins only where the expected hold time is under the 4-tick context switch cost and blocks otherwise, keeping total sync.busy_wait spun ticks under 25 for the leg.',
    chapter: cite('6.5', '6.9'),
    assessedBy: 'decision',
  },
  {
    id: MINIMAL_CRITICAL_SECTION,
    statement: 'Marks a guarded region with lock --mark that covers every write to the shared ledger and is under 6 ticks long, so no unguarded write remains and no Program is excluded longer than necessary.',
    chapter: cite('6.2', '6.5'),
    assessedBy: 'terminal_command',
  },
  {
    id: ATOMIC_PRIMITIVE,
    statement: 'Replaces the test-then-set crossing with compare_and_swap and reruns the identical recorded interleaving with trace --replay, observing the race count fall to zero.',
    chapter: cite('6.4.2', '6.4.3'),
    assessedBy: 'terminal_command',
  },
  {
    id: SEMAPHORE_CAPACITY,
    statement: 'Sets the ford semaphore count to the number of Programs the ford physically holds, so no Program blocks while capacity is free and none is admitted past capacity.',
    chapter: cite('6.6.1'),
    assessedBy: 'outcome',
  },
  {
    id: PRIORITY_INVERSION,
    statement: 'Clears a priority_inversion affliction before the high-priority Program deadline, by enabling priority inheritance on the contended mutex or by spending SABLE shield on it.',
    chapter: cite('6.8'),
    assessedBy: 'survival',
  },
];

export const OBJECTIVE_IDS: readonly string[] = objectives.map((objective) => objective.id);
