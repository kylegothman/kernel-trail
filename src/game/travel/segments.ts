import type { LegId } from '../types';

/** Narrative bible 5.3. Boot Sector has no travel phase. */
export const LEG_SEGMENTS: Readonly<Record<LegId, number>> = {
  boot_sector: 0, fork_fields: 60, the_weave: 65, quantum_pass: 70,
  the_narrows: 75, the_cistern: 75, the_gridlock: 80, allocation_yards: 85,
  drowned_reach: 100, the_platters: 85, the_bus: 80, the_archive: 90,
  arbiter_wall: 85, the_portal: 70,
};

/** Narrative bible 10.2. The Drowned Reach deliberately has no depot. */
export const DEPOT_LEGS: readonly LegId[] = [
  'fork_fields', 'quantum_pass', 'the_cistern', 'allocation_yards',
  'the_platters', 'the_archive', 'arbiter_wall',
];
