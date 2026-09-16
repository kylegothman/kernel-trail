/** WP-L07 acceptance 11, 14 and 15: effective access time, the flush segment and the two routes. */
import { describe, expect, it } from 'vitest';
import { effectiveAccessTimeNs } from '@kernel/memory/Tlb';
import { runLeg } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';
import {
  contiguousSequence, EAT_TABLE, EAT_TABLE_WITH_SEARCH, flushDemonstration, measureHitRate,
  MEMORY_ACCESS_NS, PURCHASED_TLB_ENTRIES, readRoute, ROUTE_ACCESSES, scatteredSequence, SCATTERED_STRIDE,
} from '@legs/allocation_yards/routes';
import { TLB_ENTRIES } from '@legs/allocation_yards/config';
import { EAT_NS, FLUSH_RATIO, PURCHASED_SCATTERED_HIT_RATE, ROUTE_HIT_RATES } from '@legs/allocation_yards/fixtures';

const leg = await loadLegForTest('allocation_yards');
const entering = { cycles: 1022, quota: 900, blocks: 120, bandwidth: 60 } as const;

describe('MEM-TLB-1 and MEM-TLB-1b', () => {
  it('reproduces the four-row table at a 100 ns access and no lookup cost', () => {
    expect(EAT_TABLE.map((row) => Number(row.ns.toFixed(2)))).toEqual([150, 120, 110, 101]);
    for (const [hitRate, expected] of Object.entries(EAT_NS.noSearch)) {
      expect(effectiveAccessTimeNs(Number(hitRate), MEMORY_ACCESS_NS, 0)).toBeCloseTo(expected, 2);
    }
  });

  it('reproduces the two rows at a 10 ns lookup cost', () => {
    expect(EAT_TABLE_WITH_SEARCH.map((row) => Number(row.ns.toFixed(2)))).toEqual([130, 111]);
    for (const [hitRate, expected] of Object.entries(EAT_NS.withSearch)) {
      expect(effectiveAccessTimeNs(Number(hitRate), MEMORY_ACCESS_NS, 10)).toBeCloseTo(expected, 2);
    }
  });
});

describe('the flush demonstration', () => {
  it('a disabled cache takes between 1.95 and 2.05 times the warm segment, because every access became two', () => {
    const demonstration = flushDemonstration();
    expect(demonstration.disabledNs).toBe(200);
    expect(demonstration.warmNs).toBe(100);
    expect(demonstration.ratio).toBeGreaterThanOrEqual(1.95);
    expect(demonstration.ratio).toBeLessThanOrEqual(2.05);
    expect(demonstration.ratio).toBe(FLUSH_RATIO);
  });
});

describe('the two routes', () => {
  it('walk an identical distance and an identical number of accesses', () => {
    const contiguous = readRoute('route.contiguous');
    const scattered = readRoute('route.scattered');
    expect(scattered.distance).toBe(contiguous.distance);
    expect(scattered.accesses).toBe(contiguous.accesses);
    expect(contiguous.accesses).toBe(ROUTE_ACCESSES);
    expect(contiguousSequence()).toHaveLength(ROUTE_ACCESSES);
    expect(scatteredSequence()).toHaveLength(ROUTE_ACCESSES);
    // Only the stride differs, which is the entire point of the fork.
    expect(contiguous.stride).toBe(1);
    expect(scattered.stride).toBe(SCATTERED_STRIDE);
  });

  it('hit 92 and 41 percent on the same hardware, measured through a real sixteen-entry cache', () => {
    expect(measureHitRate(contiguousSequence())).toBeCloseTo(ROUTE_HIT_RATES.contiguous, 10);
    expect(measureHitRate(scatteredSequence())).toBeCloseTo(ROUTE_HIT_RATES.scattered, 10);
    expect(readRoute('route.contiguous').hitRate).toBe(0.92);
    expect(readRoute('route.scattered').hitRate).toBe(0.41);
  });

  it('buying entries helps a little and nowhere near enough to replace the route choice', () => {
    const bought = readRoute('route.scattered', PURCHASED_TLB_ENTRIES);
    expect(bought.hitRate).toBeGreaterThan(ROUTE_HIT_RATES.scattered);
    expect(bought.hitRate).toBeCloseTo(PURCHASED_SCATTERED_HIT_RATE, 10);
    expect(bought.hitRate).toBeLessThan(0.85);
    expect(PURCHASED_TLB_ENTRIES).toBeGreaterThan(TLB_ENTRIES);
  });

  it('fails the locality objective for a player who bought entries, whatever their hit rate', async () => {
    const script = (steps: { at: number; id: string; anchor: string }[]) => ({
      legId: 'allocation_yards' as const, label: 'tlb', steps: steps.map((step) => ({
        at: step.at, command: { kind: 'interaction' as const, id: step.id, anchor: step.anchor },
      })),
    });
    const honest = await runLeg(leg, {
      seed: 0x4b54524c, run: makeRunState({ seed: 0x4b54524c, legIndex: 7, ledger: entering }),
      script: script([{ at: 20, id: 'yards.route_contiguous', anchor: 'anchor.route_fork' }]),
    });
    expect(honest.outcome.objectivesMet).toContain('obj.allocation_yards.locality_over_hardware');

    const bought = await runLeg(leg, {
      seed: 0x4b54524c, run: makeRunState({ seed: 0x4b54524c, legIndex: 7, ledger: entering }),
      script: script([
        { at: 20, id: 'yards.route_contiguous', anchor: 'anchor.route_fork' },
        { at: 24, id: 'yards.buy_tlb_entries', anchor: 'anchor.tlb_console' },
      ]),
    });
    expect(bought.outcome.objectivesMet).not.toContain('obj.allocation_yards.locality_over_hardware');
  });
});
