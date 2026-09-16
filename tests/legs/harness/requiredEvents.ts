/**
 * Architecture 11.5's `REQUIRED_EVENTS` table, verbatim, all fourteen rows
 * (WP-20 section 6, acceptance 22). Every leg declares the signature
 * pathology it teaches; the chaotic policy is designed to trigger it, and a
 * leg whose pathology never fires cannot teach it.
 */
import type { Leg, LegId } from '@game/types';
import { loadFixtures, runFixture } from './fixtureContract';
import { runLeg, type HarnessResult } from './LegHarness';

/** The seed the chaotic rotation is driven from; shared across every leg's measurements. */
export const CHAOS_SEED = 4;

/**
 * Legs whose required-events row is asserted against their own known-good
 * script rather than the chaotic rotation.
 *
 * The rotation installs a policy drawn from its own stream every forty ticks,
 * so which policies a leg ever sees is a property of the shared seed and of
 * how long the leg runs, not of the leg. `quantum_pass` must fire
 * `quantum.expired`, and only round robin and the multilevel feedback queue
 * emit it; at the shared seed the first rotation installs `priority` at a
 * reckless pace, which ends the leg before the second rotation. Requiring the
 * event under those conditions tests the rotation rather than the leg.
 *
 * `boot_sector` is here for the second reason: it declares zero travel
 * segments, so it ends on its own `leg_done` record rather than on travel
 * progress, and the chaotic rotation has nothing to rotate before the leg is
 * over. Its required events are issued by its known-good script or not at all.
 *
 * The known-good script is the stricter reading in any case: the leg has to
 * fire its signature events on the path it ships as correct play, every time,
 * rather than on a path a different seed might happen to produce.
 */
export const REQUIRED_EVENTS_FROM_KNOWN_GOOD: ReadonlySet<LegId> = new Set<LegId>(['quantum_pass', 'boot_sector']);

/** The run a leg's required-events row is asserted against. */
export async function runForRequiredEvents(leg: Leg): Promise<HarnessResult> {
  if (!REQUIRED_EVENTS_FROM_KNOWN_GOOD.has(leg.id)) return runLeg(leg, { seed: CHAOS_SEED, policy: 'chaotic' });
  const fixtures = await loadFixtures(leg.id);
  if (fixtures === null) throw new Error(`${leg.id} is listed in REQUIRED_EVENTS_FROM_KNOWN_GOOD but ships no fixtures`);
  return runFixture(fixtures.knownGood, leg);
}

export const REQUIRED_EVENTS: Readonly<Record<LegId, readonly string[]>> = {
  boot_sector:      ['syscall.invoked', 'process.created'],
  fork_fields:      ['process.created', 'process.exited', 'process.reaped'],
  the_weave:        ['thread.created', 'thread.joined', 'context.switch'],
  quantum_pass:     ['context.switch', 'quantum.expired', 'process.starving'],
  the_narrows:      ['sync.acquired', 'sync.blocked', 'sync.race_detected'],
  the_cistern:      ['sync.blocked', 'sync.released'],
  the_gridlock:     ['resource.requested', 'deadlock.detected', 'bankers.evaluated'],
  allocation_yards: ['memory.allocated', 'memory.allocation_failed', 'tlb.miss'],
  drowned_reach:    ['memory.page_fault', 'memory.page_evicted', 'memory.thrashing'],
  the_platters:     ['disk.queued', 'disk.seek', 'disk.served'],
  the_bus:          ['io.request', 'io.interrupt', 'io.poll_wasted'],
  the_archive:      ['fs.block_allocated', 'fs.journal', 'fs.corruption'],
  arbiter_wall:     ['security.access_denied', 'security.escalation_attempt'],
  the_portal:       ['context.switch', 'syscall.invoked'],
};
