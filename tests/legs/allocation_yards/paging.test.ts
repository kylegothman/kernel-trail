/** WP-L07 acceptance 12, 13 and 18: the conversion, the two meters and the dial. */
import { describe, expect, it } from 'vitest';
import { pagingFragmentation } from '@kernel/memory/fragmentation';
import { runFixture } from '../harness/fixtureContract';
import { loadLegForTest } from '../harness/loadLeg';
import { admissiblePageSizes, PAGE_SIZES, readPaging, MAX_INDEX_ROWS, MAX_INTERNAL_SHARE } from '@legs/allocation_yards/routes';
import { BERTHS, replayYard } from '@legs/allocation_yards/yard';
import { internalBound, readLeg } from '@legs/allocation_yards/evaluate';
import { PAGE_SIZE_VERDICTS } from '@legs/allocation_yards/fixtures';
import { knownGood } from './fixtures';

const leg = await loadLegForTest('allocation_yards');

describe('MEM-FRAG-1 holds for every configuration the player can reach', () => {
  it('external fragmentation under paging is exactly zero at every page size on the dial', () => {
    for (const pageSize of PAGE_SIZES) {
      expect(readPaging(pageSize).externalFragmentation, String(pageSize)).toBe(0);
      const allocations = BERTHS.map((berth) => ({ framesHeld: Math.ceil(berth.bytes / pageSize), bytesRequested: berth.bytes }));
      expect(pagingFragmentation(allocations, pageSize).externalFragmentation, String(pageSize)).toBe(0);
    }
  });
});

describe('the two meters move in the same frame', () => {
  it('external drops to exactly zero while internal rises from zero, on one conversion', async () => {
    const result = await runFixture(knownGood, leg);
    const before = replayYard(result.run.decisions, 19);
    expect(before.externalFragmentation).toBeGreaterThan(0);
    // `readLeg` reads the decision log, the event log and the tick; the snapshot
    // is part of the frozen context shape and nothing in this path consults it.
    const reading = readLeg({ run: result.run, kernelSnapshot: {} as never, events: result.events, ticksElapsed: result.ticks });
    expect(reading.converted).toBe(true);
    expect(reading.externalFragmentation).toBe(0);
    expect(reading.internalFragmentation).toBeGreaterThan(0);
  });

  it('internal fragmentation stays under half a frame per Program at every admissible size', () => {
    for (const pageSize of admissiblePageSizes()) {
      expect(readPaging(pageSize).internalFragmentation, String(pageSize)).toBeLessThanOrEqual(internalBound(pageSize));
    }
  });
});

describe('the page size dial', () => {
  it('moves the index board and the internal meter in opposite directions at every reachable size', () => {
    const readings = PAGE_SIZES.map((size) => readPaging(size));
    for (let index = 1; index < readings.length; index++) {
      const smaller = readings[index - 1];
      const larger = readings[index];
      expect(larger?.indexRows ?? 0, String(larger?.pageSize)).toBeLessThan(smaller?.indexRows ?? 0);
      expect(larger?.internalFragmentation ?? 0, String(larger?.pageSize)).toBeGreaterThan(smaller?.internalFragmentation ?? -1);
    }
  });

  it('has a real solution space: four sizes pass both clauses and three fail exactly one', () => {
    expect([...admissiblePageSizes()]).toEqual([...PAGE_SIZE_VERDICTS.admissible]);
    expect(admissiblePageSizes().length).toBeGreaterThanOrEqual(2);
    const failsOne = PAGE_SIZES.filter((size) => {
      const reading = readPaging(size);
      return Number(reading.meetsRowBound) + Number(reading.meetsInternalBound) === 1;
    });
    expect(failsOne.length).toBeGreaterThanOrEqual(2);
    for (const size of PAGE_SIZE_VERDICTS.failsRowsOnly) {
      expect(readPaging(size).meetsRowBound, String(size)).toBe(false);
      expect(readPaging(size).meetsInternalBound, String(size)).toBe(true);
      expect(readPaging(size).largestTable).toBeGreaterThanOrEqual(MAX_INDEX_ROWS);
    }
    for (const size of PAGE_SIZE_VERDICTS.failsInternalOnly) {
      expect(readPaging(size).meetsRowBound, String(size)).toBe(true);
      expect(readPaging(size).meetsInternalBound, String(size)).toBe(false);
      expect(readPaging(size).internalShare).toBeGreaterThanOrEqual(MAX_INTERNAL_SHARE);
    }
  });

  it('keeps every Program page table countable at a glance on an admissible size', () => {
    for (const size of admissiblePageSizes()) expect(readPaging(size).largestTable, String(size)).toBeLessThan(64);
  });
});
