import { describe, expect, it } from 'vitest';
import type { DifficultyTier, DiscClass } from '@game/types';
import { LEG_ORDER } from '@game/types';
import { applyDelta, canAfford, emergencyCreditNeeded, legDividend, refillBandwidth, startingLedger } from '@game/travel/ledger';
import { LEG_SEGMENTS } from '@game/travel/segments';
import { TIER_TABLE, afflictionFrequency } from '@game/tiers';

describe('resource economy', () => {
  it('scales and floors all twelve starting ledgers', () => {
    const bases = { shell: [1600, 900, 120, 60], daemon: [1100, 650, 160, 45], compiler: [700, 420, 90, 30] };
    const factors = { novice: 1.35, operator: 1, architect: .8, kernel_space: .65 };
    for (const disc of Object.keys(bases) as DiscClass[]) for (const tier of Object.keys(factors) as DifficultyTier[]) {
      expect(Object.values(startingLedger(disc, tier))).toEqual(bases[disc].map(value => Math.floor(value * factors[tier])));
    }
    expect(startingLedger('compiler', 'architect')).toEqual({ cycles: 560, quota: 336, blocks: 72, bandwidth: 24 });
  });
  it('refills bandwidth to the tier-scaled cap, including its fractional 60percent value', () => {
    const ledger = startingLedger('compiler', 'architect'); ledger.bandwidth = 0;
    refillBandwidth(ledger, 'compiler', 'architect', false); expect(ledger.bandwidth).toBeCloseTo(14.4, 12);
    refillBandwidth(ledger, 'compiler', 'architect', true); expect(ledger.bandwidth).toBe(24);
  });
  it('matches all base dividends and clamps the throughput factor', () => {
    const dividends = Array.from({ length: 13 }, (_, i) => legDividend(i + 1, 1, 'shell'));
    expect(dividends).toEqual([66, 72, 78, 84, 90, 96, 102, 108, 114, 120, 126, 132, 138]);
    expect(dividends.reduce((sum, n) => sum + n, 0)).toBe(1326);
    expect(legDividend(8, 0, 'compiler')).toBe(108 * .6 * 1.25);
    expect(legDividend(8, 20, 'compiler')).toBe(108 * 1.4 * 1.25);
  });
  it('reproduces narrative5.5 as an analytical fixture with rounded leg costs and half-away display', () => {
    // R8: this analytical curve excludes credit, deaths and reclamation. Runtime charges stay fractional.
    const expected = {
      shell: [1516, 1425, 1328, 1224, 1126, 1022, 911, 769, 670, 590, 491, 410, 373],
      daemon: [1016, 925, 828, 724, 626, 522, 411, 269, 170, 90, -9],
      compiler: [633, 560, 482, 399, 324, 244, 158, 43, -28],
    };
    for (const disc of Object.keys(expected) as DiscClass[]) {
      let balance = startingLedger(disc, 'operator').cycles;
      const actual: number[] = [];
      LEG_ORDER.slice(1).forEach((legId, index) => {
        balance -= Math.round(LEG_SEGMENTS[legId] * 2.5);
        balance += legDividend(index + 1, 1, disc);
        actual.push(Math.sign(balance) * Math.round(Math.abs(balance)));
      });
      expect(actual.slice(0, expected[disc].length)).toEqual(expected[disc]);
    }
    expect(LEG_ORDER.reduce((sum, id) => sum + Math.round(LEG_SEGMENTS[id] * 2.5), 0)).toBe(2553);
    expect(LEG_ORDER.reduce((sum, id) => sum + LEG_SEGMENTS[id] * 2.5, 0)).toBe(2550);
  });
  it('floors resource event deltas, and checks optional costs before mutating', () => {
    const ledger = { cycles: 1, quota: 2, blocks: 3, bandwidth: 4 };
    expect(canAfford(ledger, { cycles: 2 })).toBe(false);
    expect(ledger.cycles).toBe(1);
    applyDelta(ledger, { cycles: -10, quota: -10, blocks: -10, bandwidth: -10 });
    expect(ledger).toEqual({ cycles: 0, quota: 0, blocks: 0, bandwidth: 0 });
    expect(emergencyCreditNeeded(ledger, 'fork_fields')).toBe(true);
    expect(emergencyCreditNeeded(ledger, 'boot_sector')).toBe(false);
    expect(emergencyCreditNeeded({ ...ledger, cycles: 94.5 }, 'fork_fields')).toBe(false);
  });
  it('pins all seven tier columns and the affliction probability clamp', () => {
    expect(Object.values(TIER_TABLE).map(Object.values)).toEqual([
      [1.35, .6, .75, 1.5, 0, 0, .5], [1, 1, 1, 1, 0, 0, 1],
      [.8, 1.35, 1.1, .9, 15, 1, 1.6], [.65, 1.7, 1.25, .8, 25, 2, 2.5],
    ]);
    expect(afflictionFrequency(.04, 'architect')).toBeCloseTo(.054, 12);
    expect(afflictionFrequency(1, 'kernel_space')).toBe(1);
  });
});
