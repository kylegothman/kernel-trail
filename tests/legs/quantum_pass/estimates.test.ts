/**
 * WP-L03 acceptance 15: burst estimates by exponential averaging, and the
 * segment where the estimate is wrong.
 *
 * Sim spec 5.3: tau(n+1) = alpha * t(n) + (1 - alpha) * tau(n), alpha 0.5,
 * tau(0) the declared burst. The prediction is honest arithmetic over the
 * Program's own history, which is exactly why it is wrong about a Program
 * whose behaviour changed: the feedback queue chops the grind into slices that
 * look nothing like the burst it declared.
 */
import { describe, expect, it } from 'vitest';
import type { Pid } from '@kernel/types';
import { ALPHA, burstEstimates, exponentialAverage, observedBursts } from '@legs/quantum_pass/estimates';
import { namesOf } from '@legs/quantum_pass/replay';
import { segment } from '@legs/quantum_pass/segments';
import { loadFixtures } from '../harness/fixtureContract';
import { runFixture } from '../harness/fixtureContract';
import { loadLegForTest } from '../harness/loadLeg';

const leg = await loadLegForTest('quantum_pass');
const fixtures = await loadFixtures('quantum_pass');
const known = await runFixture(fixtures!.knownGood, leg);

describe('exponential averaging', () => {
  it('uses alpha one half', () => {
    expect(ALPHA).toBe(0.5);
  });

  it('is the textbook series, worked by hand', () => {
    // tau(0) = 10; observing 6 gives 8; observing 4 gives 6; observing 6 gives 6.
    expect(exponentialAverage(10, [6, 4, 6])).toEqual([10, 8, 6, 6]);
    // A process that keeps to its declared burst is predicted exactly, for ever.
    expect(exponentialAverage(4, [4, 4, 4])).toEqual([4, 4, 4, 4]);
    // The average approaches a changed behaviour by halves and never overshoots it.
    const series = exponentialAverage(20, [2, 2, 2, 2, 2]);
    expect(series).toEqual([20, 11, 6.5, 4.25, 3.125, 2.5625]);
    for (let index = 1; index < series.length; index++) expect(series[index]).toBeGreaterThan(2);
  });

  it('weights the last burst and the previous estimate equally', () => {
    const [, first] = exponentialAverage(8, [2]);
    expect(first).toBe(ALPHA * 2 + (1 - ALPHA) * 8);
  });
});

describe('the estimates the depot sells', () => {
  it('reads each process CPU intervals out of the live log', () => {
    const observed = observedBursts(known.events);
    expect(observed.size).toBeGreaterThan(0);
    for (const [, bursts] of observed) for (const burst of bursts) expect(burst).toBeGreaterThan(0);
  });

  it('is wrong about the Program whose behaviour changed, by more than forty percent', () => {
    const names = namesOf(known.events);
    const declared = new Map<Pid, { name: string; burst: number }>();
    for (const [pid, name] of names) {
      const row = segment(4).rows.find((candidate) => candidate.name === name);
      if (row !== undefined) declared.set(pid, { name, burst: row.burst });
    }
    const grind = burstEstimates(known.events, declared).find((row) => row.name === 'pass.grind');
    expect(grind, 'the grind never ran').toBeDefined();
    expect(grind?.observed.length, 'the grind ran in one piece, so no behaviour change was observed').toBeGreaterThan(1);
    expect(grind?.error, 'the estimate was not wrong enough to teach anything').toBeGreaterThanOrEqual(0.4);
    // The declared burst is the whole job; the feedback queue hands it out in slices, so the
    // prediction made from the first slice is nothing like the next one.
    expect(Math.max(...(grind?.observed ?? []))).toBeLessThan(grind?.declared ?? 0);
  });

  it('predicts a steady Program exactly, which is why the wrong one is instructive', () => {
    const names = namesOf(known.events);
    const declared = new Map<Pid, { name: string; burst: number }>();
    for (const [pid, name] of names) {
      const row = segment(1).rows.find((candidate) => candidate.name === name);
      if (row !== undefined) declared.set(pid, { name, burst: row.burst });
    }
    const rows = burstEstimates(known.events, declared).filter((row) => row.observed.length === 1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // One uninterrupted burst: the estimate moves halfway from the declared burst to what it saw.
      expect(row.estimate).toBe(ALPHA * (row.actual ?? 0) + (1 - ALPHA) * row.declared);
    }
  });
});
