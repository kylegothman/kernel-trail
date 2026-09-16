/**
 * WP-L04 acceptance 12: the four options against the shared cost formulas at
 * five contention values, and the crossing definitions this leg opens.
 *
 * The formulas are WP-19's and are not reimplemented here. What this asserts
 * is the table of narrative 12.2 and 12.3, computed by the shipped `quote`,
 * so a change to either the formulas or this leg shows up as a number.
 */
import { describe, expect, it } from 'vitest';
import { quote, quoteAll, type CrossingContext } from '@game/crossing/options';
import { quotaPerTick } from '@game/travel/paceRations';
import theNarrows, { content } from '@legs/the_narrows';
import { CORES, crossings, PLANK, SECOND_FORD, WIDE_FORD, WIDE_FORD_3, WIDE_FORD_4, wideFordFor } from '@legs/the_narrows/crossings';
import { FORD_WIDTH } from '@legs/the_narrows/ledger';

const CONTENTIONS = [0, 0.2, 0.45, 0.7, 1] as const;
const context = (contention: number, ordered = true): CrossingContext =>
  ({ contention, ordered, rations: 'standard', aliveCount: 5, crosserHoldsResource: false });

describe('the four options, against the shared formulas', () => {
  it.each(CONTENTIONS)('spin at C = %s costs round(12 + 90C) cycles and round(4 + 30C) ticks at 1 - 0.85C squared', (c) => {
    const spin = quote('spin', context(c));
    expect(spin.cyclesCost).toBe(Math.round(12 + 90 * c));
    expect(spin.ticksCost).toBe(Math.round(4 + 30 * c));
    expect(spin.successP).toBeCloseTo(1 - 0.85 * c ** 2, 10);
    expect(spin.quotaCost).toBe(0);
  });

  it.each(CONTENTIONS)('block at C = %s costs round(20 + 60C) ticks, no cycles, and 0.99 on an ordered queue', (c) => {
    const block = quote('block', context(c));
    expect(block.ticksCost).toBe(Math.round(20 + 60 * c));
    expect(block.cyclesCost).toBe(0);
    expect(block.quotaCost).toBe(block.ticksCost * quotaPerTick('standard', 5));
    expect(block.successP).toBeCloseTo(0.99, 10);
    expect(quote('block', context(c, false)).successP).toBeCloseTo(1 - 0.55 * c ** 2, 10);
  });

  it.each(CONTENTIONS)('the monitor at C = %s costs round(45 + 120C) cycles, six bandwidth and eight ticks at 0.97', (c) => {
    const monitor = quote('monitor', context(c));
    expect(monitor.cyclesCost).toBe(Math.round(45 + 120 * c));
    expect(monitor.bandwidthCost).toBe(6);
    expect(monitor.ticksCost).toBe(8);
    expect(monitor.successP).toBeCloseTo(0.97, 10);
  });

  it.each(CONTENTIONS)('waiting at C = %s costs round(40 + 120C) ticks and draws one event per ten of them', (c) => {
    const wait = quote('wait', context(c));
    expect(wait.ticksCost).toBe(Math.round(40 + 120 * c));
    expect(wait.cyclesCost).toBe(0);
    expect(wait.eventDraws).toBe(Math.floor(wait.ticksCost / 10));
    const after = c * 0.86 ** (wait.ticksCost / 10);
    expect(wait.successP).toBeCloseTo(1 - 0.2 * after ** 2, 10);
  });

  it('reproduces the side-by-side table of narrative 12.3 at C = 0.20', () => {
    const quotes = quoteAll(context(0.2));
    expect(quotes.spin.cyclesCost).toBe(30);
    expect(Math.round(quotes.spin.successP * 1000) / 10).toBe(96.6);
    expect(quotes.block.ticksCost).toBe(32);
    expect(quotes.block.quotaCost).toBe(80);
    expect(quotes.monitor.cyclesCost).toBe(69);
    expect(quotes.wait.ticksCost).toBe(64);
    expect(quotes.wait.quotaCost).toBe(160);
  });

  it('the monitor keeps its three percent, which is the spurious wakeup and is not this leg to remove', () => {
    for (const c of CONTENTIONS) expect(quote('monitor', context(c)).successP).toBeLessThan(1);
  });
});

describe('the crossings this leg opens', () => {
  it('ships five definitions for three crossings in the world, one per count the ford can admit', () => {
    expect(content.crossings).toBe(crossings);
    expect(crossings.map((def) => def.id)).toEqual([PLANK, SECOND_FORD, WIDE_FORD, WIDE_FORD_3, WIDE_FORD_4]);
    expect(new Set(crossings.map((def) => def.anchor)).size).toBe(3);
    for (const def of crossings) {
      expect(def.legId).toBe('the_narrows');
      expect(def.ordered).toBe(true);
      expect(def.crosser).toBeNull();
    }
  });

  it('points each crossing at an anchor the layout carries and an interaction can reach', () => {
    const stage = theNarrows.createStage({ quality: 'low', run: { } as never });
    for (const def of crossings) expect(stage.anchor(def.anchor), def.id).not.toBeNull();
  });

  it('selects the ford definition the capacity dial names', () => {
    expect(wideFordFor(1)).toBe(WIDE_FORD);
    expect(wideFordFor(FORD_WIDTH)).toBe(WIDE_FORD_3);
    expect(wideFordFor(4)).toBe(WIDE_FORD_4);
  });

  it('is one core at the plank and the second ford, and four at the wide ford', () => {
    expect(CORES[PLANK]).toBe(1);
    expect(CORES[SECOND_FORD]).toBe(1);
    expect(CORES[WIDE_FORD]).toBe(4);
    expect(CORES[WIDE_FORD_3]).toBe(4);
  });
});
