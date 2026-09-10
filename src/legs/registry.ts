/**
 * KERNEL TRAIL - the leg registry. Architecture section 12.3.
 *
 * The only place a leg module is referenced. Each entry is a thunk containing a
 * literal dynamic import, so Rollup emits one chunk per leg and the network
 * fetch happens at the leg transition rather than at boot. Fourteen legs, each
 * with its own world structures, geometry generators and content strings:
 * statically importing them all would put every leg's code in the initial
 * bundle for a player who has only reached leg 1.
 *
 * NONE OF THE FOURTEEN MODULES EXIST YET. The paths below are where each one
 * goes. A leg module is a directory under src/legs with an `index.ts` whose
 * default export satisfies the frozen `Leg` interface from @game/types; see
 * architecture section 13.2 for the directory shape.
 *
 * The ambient declaration in src/legs/legs.d.ts is what lets this file compile
 * before those modules exist. Delete the matching line from that file as each
 * leg lands and the real module takes over.
 */

import type { Leg, LegId } from '@game/types';
import { LEG_ORDER } from '@game/types';

export const LEG_LOADERS: Readonly<Record<LegId, () => Promise<{ default: Leg }>>> = {
  // TODO(astra): build src/legs/boot_sector/index.ts. Legs are specified in the curriculum map; the kernel side is sim spec 3 (process management).
  boot_sector: () => import('@legs/boot_sector'),
  // TODO(astra): build src/legs/fork_fields/index.ts. Kernel side is sim spec 3.4 to 3.6 (fork, exec, exit, wait, orphans).
  fork_fields: () => import('@legs/fork_fields'),
  // TODO(astra): build src/legs/the_weave/index.ts. Kernel side is sim spec 4 (threads, the three models, Amdahl).
  the_weave: () => import('@legs/the_weave'),
  // TODO(astra): build src/legs/quantum_pass/index.ts. Kernel side is sim spec 5 (all seven CPU scheduling policies).
  quantum_pass: () => import('@legs/quantum_pass'),
  // TODO(astra): build src/legs/the_narrows/index.ts. Kernel side is sim spec 8 (synchronisation, critical sections, primitives).
  the_narrows: () => import('@legs/the_narrows'),
  // TODO(astra): build src/legs/the_cistern/index.ts. Kernel side is sim spec 8.7 to 8.9 (bounded buffer, readers-writers, dining philosophers).
  the_cistern: () => import('@legs/the_cistern'),
  // TODO(astra): build src/legs/the_gridlock/index.ts. Kernel side is sim spec 9 (deadlock, Coffman, wait-for graph, Banker's).
  the_gridlock: () => import('@legs/the_gridlock'),
  // TODO(astra): build src/legs/allocation_yards/index.ts. Kernel side is sim spec 6 (contiguous allocation, fragmentation, paging).
  allocation_yards: () => import('@legs/allocation_yards'),
  // TODO(astra): build src/legs/drowned_reach/index.ts. Kernel side is sim spec 7 (demand paging, replacement, working sets, thrashing).
  drowned_reach: () => import('@legs/drowned_reach'),
  // TODO(astra): build src/legs/the_platters/index.ts. Kernel side is sim spec 10 (disk geometry, scheduling, RAID).
  the_platters: () => import('@legs/the_platters'),
  // TODO(astra): build src/legs/the_bus/index.ts. Kernel side is sim spec 11 (polling, interrupts, DMA, interrupt storms).
  the_bus: () => import('@legs/the_bus'),
  // TODO(astra): build src/legs/the_archive/index.ts. Kernel side is sim spec 12 and 13 (inodes, allocation methods, free space, journalling).
  the_archive: () => import('@legs/the_archive'),
  // TODO(astra): build src/legs/arbiter_wall/index.ts. Kernel side is sim spec 13 (protection domains, access matrix, rings).
  arbiter_wall: () => import('@legs/arbiter_wall'),
  // TODO(astra): build src/legs/the_portal/index.ts. The finale; it composes every enabled subsystem rather than introducing one.
  the_portal: () => import('@legs/the_portal'),
};

export interface LegLoadResult {
  readonly leg: Leg | null;
  readonly error: unknown;
}

/** Retries once, because a transient network failure should not end a run. */
export async function loadLeg(id: LegId): Promise<LegLoadResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const mod = await LEG_LOADERS[id]();
      return { leg: mod.default, error: null };
    } catch (error) {
      if (attempt === 1) return { leg: null, error };
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  return { leg: null, error: new Error('unreachable') };
}

/**
 * Warm the next leg's chunk during the current leg's debrief, so that by the
 * time the player has read it the chunk is in the HTTP cache and the transition
 * has no network wait.
 */
export function prefetchLeg(id: LegId): void {
  void LEG_LOADERS[id]().catch(() => {
    /* prefetch failure is not an error */
  });
}

/** The leg after this one, or null at the end of the journey. */
export function nextLegId(id: LegId): LegId | null {
  const i = LEG_ORDER.indexOf(id);
  if (i === -1 || i + 1 >= LEG_ORDER.length) return null;
  return LEG_ORDER[i + 1] ?? null;
}
