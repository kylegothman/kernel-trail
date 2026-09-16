/** WP-L07 acceptance 8, 9 and 17: the strategy fixtures and the arbiter's purity. */
import { describe, expect, it } from 'vitest';
import type { AllocationStrategy } from '@kernel/types';
import { runFixture } from '../harness/fixtureContract';
import { loadLegForTest } from '../harness/loadLeg';
import {
  buddyFixture, compareStrategies, fitFixture, FIT_REQUESTS, replayYard, bestStrategy,
} from '@legs/allocation_yards/yard';
import { BUDDY_1, STRATEGY_FRAGMENTATION, STRATEGY_FRAGMENTATION_UNCOMPACTED } from '@legs/allocation_yards/fixtures';
import { knownBad, knownGood } from './fixtures';

const leg = await loadLegForTest('allocation_yards');
const STRATEGIES: readonly AllocationStrategy[] = ['first_fit', 'best_fit', 'worst_fit', 'buddy'];

describe('the sim spec comparison set replays exactly', () => {
  it('MEM-FIT-1a: first fit places 212, 417 and 112 and strands 426', () => {
    const outcome = fitFixture('first_fit');
    expect(outcome.placements).toEqual([500, 600, 288, null]);
    expect(outcome.freeAfter).toBe(959);
    expect(outcome.largestAfter).toBe(300);
  });

  it('MEM-FIT-1b: best fit places all four', () => {
    const outcome = fitFixture('best_fit');
    expect(outcome.placements).toEqual([300, 500, 200, 600]);
    expect(outcome.freeAfter).toBe(533);
    expect(outcome.largestAfter).toBe(174);
  });

  it('MEM-FIT-1c: worst fit strands 426 with the same totals first fit leaves', () => {
    const outcome = fitFixture('worst_fit');
    expect(outcome.placements).toEqual([600, 500, 388, null]);
    expect(outcome.freeAfter).toBe(959);
    expect(outcome.largestAfter).toBe(300);
  });

  it('prints the placement and not only the totals, because first and worst fit share the totals', () => {
    const first = fitFixture('first_fit');
    const worst = fitFixture('worst_fit');
    expect(first.freeAfter).toBe(worst.freeAfter);
    expect(first.largestAfter).toBe(worst.largestAfter);
    expect(first.placements).not.toEqual(worst.placements);
    expect(FIT_REQUESTS).toEqual([212, 417, 112, 426]);
  });

  it('MEM-BUDDY-1: a 21 KB request takes a 32 KB block and wastes 11 KB inside it', () => {
    const outcome = buddyFixture();
    expect(outcome.blockSize).toBe(BUDDY_1.blockSize);
    expect(outcome.internalFragmentation).toBe(BUDDY_1.internalFragmentation);
    expect(outcome.freeLists).toEqual([...BUDDY_1.freeLists]);
  });
});

describe('the four strategies over the leg recorded sequence', () => {
  it('ends with worst fit the highest of the four on the golden sequence', async () => {
    const result = await runFixture(knownGood, leg);
    const compared = compareStrategies(result.run.decisions, result.ticks);
    for (const strategy of STRATEGIES) {
      expect(compared[strategy].externalFragmentation, strategy).toBeCloseTo(STRATEGY_FRAGMENTATION[strategy], 4);
    }
    const worst = compared.worst_fit.externalFragmentation;
    for (const strategy of STRATEGIES) {
      if (strategy !== 'worst_fit') expect(worst, strategy).toBeGreaterThan(compared[strategy].externalFragmentation);
    }
    expect(bestStrategy(compared)).toBe('best_fit');
  });

  it('reports the uncompacted sequence honestly, where buddy restriping reads higher than worst fit', async () => {
    const result = await runFixture(knownBad, leg);
    const compared = compareStrategies(result.run.decisions, result.ticks);
    for (const strategy of STRATEGIES) {
      expect(compared[strategy].externalFragmentation, strategy).toBeCloseTo(STRATEGY_FRAGMENTATION_UNCOMPACTED[strategy], 4);
    }
    // Buddy reaches a low ratio only by having little free space left to split,
    // so `bestStrategy` ranks on the largest run before the ratio.
    expect(compared.buddy.externalFragmentation).toBeGreaterThan(compared.worst_fit.externalFragmentation);
    expect(bestStrategy(compared)).toBe('best_fit');
  });

  it('leaves the live frame table and the live event log untouched over 200 comparisons', async () => {
    const result = await runFixture(knownGood, leg);
    const before = result.logHash;
    const decisions = result.run.decisions.map((record) => ({ ...record }));
    for (let round = 0; round < 200; round++) compareStrategies(result.run.decisions, result.ticks);
    expect(result.logHash).toBe(before);
    expect(result.run.decisions).toEqual(decisions);
    expect(result.eventTypes.has('memory.page_evicted')).toBe(false);
    const again = compareStrategies(result.run.decisions, result.ticks);
    expect(again.best_fit.externalFragmentation).toBeCloseTo(STRATEGY_FRAGMENTATION.best_fit, 4);
  });

  it('replays deterministically: the same decisions and tick give the same yard every time', () => {
    const first = replayYard([], 85, 'first_fit');
    const second = replayYard([], 85, 'first_fit');
    expect(second.freeSlots).toBe(first.freeSlots);
    expect(second.freeRuns).toBe(first.freeRuns);
    expect(second.largestRun).toBe(first.largestRun);
  });
});
