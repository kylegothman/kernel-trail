/**
 * KERNEL TRAIL: Quantum Pass, population. The five convoy Programs first, in
 * roster order so their pids are the lowest and the tie-break favours them,
 * then the live segments in arrival order. No resource and no sync primitive:
 * this leg teaches scheduling and nothing else.
 */
import type { LegSetupContext } from '@game/types';
import { LIVE_SEGMENTS, PAGES_PER_PROGRAM, ROSTER, toSpecs } from './segments';

export function populate(ctx: LegSetupContext): void {
  for (const entry of ROSTER) {
    const pid = ctx.spawn({ name: entry.name, priority: entry.priority, burst: entry.burst, service: entry.service, arrival: entry.arrival, pages: PAGES_PER_PROGRAM });
    ctx.bind(entry.member, pid);
  }
  for (const segment of LIVE_SEGMENTS) {
    for (const spec of toSpecs(segment.rows)) ctx.spawn(spec);
  }
}

/** Five convoy spawns plus the nine workload spawns of the three live segments. */
export const SPAWN_COUNT = ROSTER.length + LIVE_SEGMENTS.reduce((sum, segment) => sum + segment.rows.length, 0);
