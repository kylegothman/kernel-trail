/**
 * WP-20 section 6: the suite every leg's acceptance criterion 2 refers to.
 * It runs for every shipped leg and prints one line per unshipped leg. No
 * `it.skip`: a suite with no shipped leg passes on its status case alone.
 *
 * Budgets (W11): maxTickMs under 7 ms everywhere, and wallMs under 1000 ms
 * locally against 3500 ms under CI, which runs a slower container. The first
 * run of a leg in a process is a warm-up and is not timed, so the JIT's cold
 * path does not read as a budget breach.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { validateTable } from '@game/events/EventDeck';
import { LEG_SEGMENTS } from '@game/travel/segments';
import { LEG_ORDER, type Leg, type Pace } from '@game/types';
import { loadFixtures } from './harness/fixtureContract';
import { assertClean, runLeg, withInertPoison } from './harness/LegHarness';
import { loadShippedSet, skipLine } from './harness/loadLeg';
import { makeRunState } from './harness/makeRunState';
import { REQUIRED_EVENTS } from './harness/requiredEvents';

const CI = process.env.CI !== undefined && process.env.CI !== '';
/**
 * One bound, local and CI alike (WP-L00 ruling 3). The 2 ms local figure it
 * replaces predates every shipped leg and was never measured against one: the
 * first real leg averages 0.1 ms a tick and takes isolated 2 to 4 ms spikes
 * inside `kernel.step` when the suites run in parallel, which the old bound
 * read as a failure. A retry or a minimum over runs would hide that; a loose
 * bound that always means the same thing does not.
 */
export const TICK_BUDGET_MS = 7;
export const WALL_BUDGET_MS = CI ? 3500 : 1000;
const SEEDS = [1, 17, 2026] as const;
const PACES: readonly Pace[] = ['conservative', 'steady', 'aggressive', 'reckless'];
const INERT_TICKS = 400;

const shipped = await loadShippedSet();
console.log(`smoke: budgets maxTickMs<${TICK_BUDGET_MS} wallMs<${WALL_BUDGET_MS}${CI ? ' (CI)' : ''}; shipped ${shipped.legs.length} of ${LEG_ORDER.length} legs`);
for (const entry of shipped.skipped) console.log(skipLine('smoke', entry.id, entry.reason));

describe('every leg runs headlessly to completion', () => {
  it('reports the shipped set and skips the rest with a printed line', () => {
    expect(shipped.legs.length + shipped.skipped.length).toBe(LEG_ORDER.length);
    for (const leg of shipped.legs) expect(LEG_ORDER[leg.index]).toBe(leg.id);
  });

  for (const leg of shipped.legs) {
    /** A zero-segment leg ends on its own record or at the tick allowance, and only its known-good script issues a syscall (WP-L00 ruling 1). */
    const zeroSegment = LEG_SEGMENTS[leg.id] === 0;
    describe(leg.id, () => {
      beforeAll(async () => {
        // Warm-up: the first run of a leg in a process carries the JIT's cold path and is not timed.
        await runLeg(leg, { seed: SEEDS[0], policy: 'competent' });
      });

      for (const seed of SEEDS) {
        it(`seed ${seed} terminates, panics never, and evaluates`, async () => {
          const result = await runLeg(leg, { seed, policy: 'competent' });
          console.log(`smoke: ${leg.id} seed ${seed}: ticks=${result.ticks} events=${result.events.length} maxTickMs=${result.maxTickMs.toFixed(3)} wallMs=${result.wallMs.toFixed(1)} hash=${result.logHash}`);
          assertClean(result);
          expect(result.panics).toEqual([]);
          expect(result.legFailures).toEqual([]);
          if (!zeroSegment) expect(result.ticks).toBeGreaterThan(50);
          expect(result.ticks).toBeLessThan(20_000);
          if (!zeroSegment) expect(result.events.length).toBeGreaterThan(100);
          expect(result.outcome.debrief.headline.length).toBeGreaterThan(0);
          expect(result.maxTickMs).toBeLessThan(TICK_BUDGET_MS);
          expect(result.wallMs).toBeLessThan(WALL_BUDGET_MS);
          const chapter = result.outcome.debrief.chapter;
          const declared = leg.chapters.find((candidate) => candidate.chapter === chapter.chapter);
          expect(declared, `debrief chapter ${chapter.chapter} is not among the leg's declared chapters`).toBeDefined();
          expect(chapter.sections.length).toBeGreaterThan(0);
          for (const section of chapter.sections) expect(declared?.sections, `section ${section}`).toContain(section);
        });
      }

      it('emits the events its objectives claim to assess', async () => {
        const fixtures = zeroSegment ? await loadFixtures(leg.id) : null;
        const result = fixtures === null ? await runLeg(leg, { seed: 4, policy: 'chaotic' }) : await runLeg(leg, { seed: 4, script: fixtures.knownGood.script });
        for (const required of REQUIRED_EVENTS[leg.id]) {
          expect(result.eventTypes.has(required), `${leg.id} never emitted ${required}`).toBe(true);
        }
      });

      it('declares interactions whose anchors the stage can resolve', () => {
        const run = makeRunState({ seed: 1, legIndex: leg.index });
        let stage: ReturnType<Leg['createStage']>;
        try {
          stage = leg.createStage({ quality: 'low', run });
        } catch (error) {
          throw new Error(`${leg.id}: createStage threw under Node, which is an integration break of the leg: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          for (const interaction of leg.interactions) {
            expect(stage.anchor(interaction.anchor), `${leg.id}: unresolved anchor ${interaction.anchor}`).not.toBeNull();
          }
        } finally {
          stage.dispose();
        }
      });

      it('never reads a KernelConfig field it does not enable', async () => {
        const run = makeRunState({ seed: 1, legIndex: leg.index });
        const poisoned = withInertPoison(leg, run);
        if (poisoned.fields.length === 0) {
          console.log(`smoke: ${leg.id} enables every subsystem; no inert field to poison`);
          return;
        }
        const clean = await runLeg(leg, { seed: 1, maxTicks: INERT_TICKS });
        const dirty = await runLeg(poisoned.leg, { seed: 1, maxTicks: INERT_TICKS });
        expect(dirty.logHash, `poisoning ${poisoned.fields.join(', ')} changed the log`).toBe(clean.logHash);
      });

      it('event table validates', () => {
        expect(validateTable(leg.eventTable)).toEqual([]);
      });

      for (const pace of PACES) {
        it(`completes at ${pace} pace with no panic and no leg failure`, async () => {
          const result = await runLeg(leg, { seed: 1, run: makeRunState({ seed: 1, legIndex: leg.index, pace }) });
          assertClean(result);
        });
      }
    });
  }
});
