/** WP-L07 acceptance 7 and 23: the opening refusal, the two reasons, and the yard accumulating. */
import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '@game/types';
import { runFixture } from '../harness/fixtureContract';
import { loadLegForTest } from '../harness/loadLeg';
import { OPENING_FREE_RUNS, openingHoles, replayYard, YARD_SLOTS, OPENING_FREE_SLOTS, OPENING_REQUEST_SLOTS } from '@legs/allocation_yards/yard';
import { ACCUMULATION, OPENING_REFUSAL } from '@legs/allocation_yards/fixtures';
import { knownBad, knownGood } from './fixtures';

const leg = await loadLegForTest('allocation_yards');

const decisions = (rows: readonly [number, string, string][]): readonly DecisionRecord[] =>
  rows.map(([tick, kind, choice]) => ({ tick: tick as never, legId: 'allocation_yards', kind, choice, outcome: 'pending', relatedObjective: null }));

describe('the opening refusal', () => {
  it('reports forty one free runs, largest nine, against a request for twelve, with the yard 38 percent free', () => {
    const holes = openingHoles();
    expect(holes).toHaveLength(OPENING_REFUSAL.freeRuns);
    expect(holes).toHaveLength(41);
    expect(Math.max(...holes.map((hole) => hole.size))).toBe(OPENING_REFUSAL.largestRun);
    expect(holes.reduce((sum, hole) => sum + hole.size, 0)).toBe(OPENING_REFUSAL.freeSlots);
    expect(OPENING_FREE_SLOTS).toBe(97);
    expect(Math.round((OPENING_FREE_SLOTS / YARD_SLOTS) * 100)).toBe(OPENING_REFUSAL.freePercent);
    expect(OPENING_REQUEST_SLOTS).toBe(OPENING_REFUSAL.requestSlots);
  });

  it('is thirty two runs of two, eight of three and one of nine, and the runs never touch', () => {
    const sizes = OPENING_FREE_RUNS.reduce<Record<number, number>>((counts, size) => ({ ...counts, [size]: (counts[size] ?? 0) + 1 }), {});
    expect(sizes).toEqual({ 2: 32, 3: 8, 9: 1 });
    const holes = openingHoles();
    for (let index = 1; index < holes.length; index++) {
      const previous = holes[index - 1];
      const hole = holes[index];
      expect(hole?.start ?? 0).toBeGreaterThan((previous?.start ?? 0) + (previous?.size ?? 0));
    }
  });

  it('refuses the largest berth for shape rather than for space', () => {
    const opening = replayYard([], 0);
    const failure = opening.failures[0];
    expect(failure?.occupant).toBe('lumen');
    expect(failure?.requested).toBe(12);
    expect(failure?.reason).toBe('fragmentation');
    expect(failure?.largestRun).toBe(9);
    expect(failure?.freeSlots).toBe(97);
    // Free space exceeds the request three times over, which is the misconception in one row.
    expect(failure?.freeSlots ?? 0).toBeGreaterThan((failure?.requested ?? 0) * 3);
  });

  it('places only the berth the nine-slab run can hold', () => {
    const opening = replayYard([], 0);
    expect(opening.placed).toEqual(['kestrel']);
    expect([...opening.unplaced]).toEqual(['lumen', 'sable', 'orrery', 'vesper']);
  });
});

describe('the two reasons need opposite responses', () => {
  it('the kernel refuses for space while the yard refuses for shape, and both are on the log', async () => {
    const result = await runFixture(knownGood, leg);
    const exhaustion = result.events.filter((event) => event.type === 'memory.allocation_failed');
    expect(exhaustion.length).toBeGreaterThan(0);
    for (const event of exhaustion) {
      expect(event.type === 'memory.allocation_failed' && event.reason).toBe('no_space');
    }
    const yard = replayYard(result.run.decisions, result.ticks);
    expect(yard.failures.some((failure) => failure.reason === 'fragmentation')).toBe(true);
  });

  it('compaction turns forty one runs into one, which is what makes the berths fit', () => {
    const before = replayYard([], 8);
    expect(before.unplaced.length).toBeGreaterThan(0);
    const after = replayYard(decisions([[8, 'interaction', 'yards.compact @ anchor.compaction_crew']]), 8);
    expect(after.unplaced).toEqual([]);
    expect(after.freeRuns).toBe(1);
    expect(after.compactions).toBe(1);
  });
});

describe('the yard accumulates', () => {
  it('is never reset between segments: worst fit for the first half ends measurably worse', () => {
    const worstFirstHalf = replayYard(decisions([
      [3, 'set_allocation', 'worst_fit'], [43, 'set_allocation', 'best_fit'],
    ]), 85);
    const bestThroughout = replayYard(decisions([[3, 'set_allocation', 'best_fit']]), 85);
    expect(worstFirstHalf.externalFragmentation).toBeCloseTo(ACCUMULATION.worstFirstHalf.externalFragmentation, 4);
    expect(bestThroughout.externalFragmentation).toBeCloseTo(ACCUMULATION.bestThroughout.externalFragmentation, 4);
    expect(worstFirstHalf.externalFragmentation).toBeGreaterThan(bestThroughout.externalFragmentation);
    expect(worstFirstHalf.largestRun).toBeLessThan(bestThroughout.largestRun);
    expect(worstFirstHalf.freeRuns).toBeGreaterThan(bestThroughout.freeRuns);
  });

  it('carries the shape forward: the yard at leg end is the yard the decisions built', async () => {
    const good = await runFixture(knownGood, leg);
    const bad = await runFixture(knownBad, leg);
    const tidy = replayYard(good.run.decisions, good.ticks);
    const ragged = replayYard(bad.run.decisions, bad.ticks);
    expect(tidy.externalFragmentation).toBeLessThan(0.12);
    expect(ragged.externalFragmentation).toBeGreaterThan(0.9);
    expect(tidy.unplaced).toEqual([]);
    expect(ragged.unplaced.length).toBeGreaterThan(0);
  });
});
