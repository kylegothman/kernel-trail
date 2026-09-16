import { describe, expect, it, vi } from 'vitest';
import { createKernel, asTick as tick } from '@kernel/index';
import type { DifficultyTier, DiscClass } from '@game/types';
import { Depot, policyHint } from '../../../src/game/depot/Depot';
import { DEPOT_ITEMS, DEPOT_TIER_FACTOR, depotPrice, price } from '../../../src/game/depot/prices';
import { initialRunState } from '../../../src/game/replay/runReplay';
import { createRunStore } from '../../../src/game/runStore';
import { syntheticConfig } from '../fixtures/syntheticLeg';
import { makeAffliction } from '../../../src/game/afflictions/table';

const indices = [1, 3, 5, 7, 9, 11, 12];
const printed = [
  [[55, 0], [64, 0], [73, 0], [82, 0], [91, 0], [100, 0], [104, 0]],
  [[33, 0], [38, 0], [44, 0], [49, 0], [54, 0], [60, 0], [62, 0]],
  [[22, 0], [25, 0], [29, 0], [33, 0], [36, 0], [40, 0], [42, 0]],
  [[16, 9], [19, 10], [22, 12], [24, 13], [27, 14], [30, 16], [31, 17]],
  [[65, 0], [76, 0], [87, 0], [98, 0], [109, 0], [119, 0], [125, 0]],
  [[98, 27], [114, 32], [131, 36], [147, 41], [163, 45], [179, 50], [187, 52]],
  [[240, 44], [279, 51], [319, 58], [359, 65], [398, 72], [438, 80], [458, 83]],
];

function harness(tier: DifficultyTier = 'operator', disc: DiscClass = 'shell') {
  const store = createRunStore(initialRunState(10, disc, tier));
  store.mutate((run) => {
    run.resources = { cycles: 10000, quota: 0, blocks: 10000, bandwidth: 0 };
    const member = run.convoy.find((candidate) => candidate.id === 'lumen');
    if (member !== undefined) { member.integrity = 10; member.status = 'critical'; }
  });
  const kernel = createKernel(syntheticConfig(10));
  let recruited = false;
  const recruit = vi.fn(() => { recruited = true; });
  const checkpoint = vi.fn(); const record = vi.fn();
  const deps = { getRun: store.get, mutate: store.mutate, view: () => kernel.invariantState(), hasRecruited: () => recruited, recruit, checkpoint, record };
  const depot = new Depot(1, tier, disc, deps);
  return { depot, store, kernel, recruit, checkpoint, record, deps };
}

describe('depot prices', () => {
  for (const [row, item] of DEPOT_ITEMS.entries()) {
    for (const [column, leg] of indices.entries()) {
      it(`operator table: ${item} at leg ${leg}`, () => {
        const expected = printed[row]?.[column];
        if (expected === undefined) throw new Error('missing printed depot cell');
        expect(depotPrice(item, leg, 'operator')).toEqual({ cycles: expected[0], blocks: expected[1] });
      });
    }
  }
  it.each([['novice', 0.80], ['operator', 1], ['architect', 1.15], ['kernel_space', 1.35]] as const)('tier factor %s at both end depots', (tier, factor) => {
    expect(DEPOT_TIER_FACTOR[tier]).toBe(factor);
    expect(price(50, 1, tier)).toBe(Math.round(50 * 1.09 * factor));
    expect(price(50, 12, tier)).toBe(Math.round(50 * 2.08 * factor));
  });
  it('independently rounds repair cycles and blocks', () => expect(depotPrice('repair', 1, 'operator')).toEqual({ cycles: 16, blocks: 9 }));
});

describe('depot transactions', () => {
  it('repair preserves afflictions and their original fatal clocks', () => {
    const h = harness(); const affliction = makeAffliction('bit_rot', tick(17));
    h.store.mutate((run) => { const member = run.convoy.find((candidate) => candidate.id === 'lumen'); if (member !== undefined) member.afflictions.push(affliction); });
    expect(h.depot.buy('repair', 'lumen').ok).toBe(true);
    expect(h.store.get().convoy.find((member) => member.id === 'lumen')?.afflictions).toEqual([affliction]);
  });
  it('repairs at most 30 points for a Program critical at entry, surviving status changes and restore', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) expect(h.depot.buy('repair', 'lumen').ok).toBe(true);
    expect(h.store.get().convoy.find((member) => member.id === 'lumen')?.integrity).toBe(40);
    expect(h.depot.buy('repair', 'lumen').ok).toBe(false);
    const restored = new Depot(1, 'operator', 'shell', h.deps); restored.restore(h.depot.snapshot());
    expect(restored.buy('repair', 'lumen').ok).toBe(false);
    const nextVisit = new Depot(3, 'operator', 'shell', h.deps);
    expect(nextVisit.buy('repair', 'lumen').ok).toBe(true);
  });
  it('daemon halves the independently rounded blocks upward', () => {
    const h = harness('operator', 'daemon');
    expect(h.depot.buy('repair', 'lumen').spent).toEqual({ cycles: 16, blocks: 5 });
  });
  it('does not repair through a stale catalogue or an empty block ledger', () => {
    const h = harness(); expect(h.depot.catalogue().find((offer) => offer.item === 'repair')?.available).toBe(true);
    h.store.mutate((run) => { run.resources.blocks = 0; }); const before = h.store.get().resources.cycles;
    expect(h.depot.buy('repair', 'lumen').ok).toBe(false); expect(h.store.get().resources.cycles).toBe(before);
  });
  it('refills bandwidth on entry and adds purchased lots above the cap', () => {
    const h = harness(); expect(h.store.get().resources.bandwidth).toBe(60);
    h.depot.buy('bandwidth_lot', null); expect(h.store.get().resources.bandwidth).toBe(65);
    h.depot.buy('quota_lot', null); expect(h.store.get().resources.quota).toBe(25);
    const blocks = h.store.get().resources.blocks; h.depot.buy('block_lot', null); expect(h.store.get().resources.blocks).toBe(blocks + 10);
  });
  it('recruit requires a death and remains once per run across visits', () => {
    const h = harness(); expect(h.depot.buy('recruit', 'orrery').ok).toBe(false);
    h.store.mutate((run) => { const member = run.convoy.find((candidate) => candidate.id === 'orrery'); if (member !== undefined) { member.status = 'derezzed'; member.integrity = 0; } });
    expect(h.depot.recruitNotice('orrery')).toContain('passive does not return');
    expect(h.depot.buy('recruit', 'orrery').ok).toBe(true); expect(h.recruit).toHaveBeenCalledExactlyOnceWith('orrery');
    expect(new Depot(3, 'operator', 'shell', h.deps).buy('recruit', 'orrery').ok).toBe(false);
  });
  it.each(['novice', 'operator', 'architect', 'kernel_space'] as const)('hint tier %s and one-time service guard', (tier) => {
    const h = harness(tier); const result = h.depot.buy('policy_hint', null);
    expect(result.ok).toBe(tier !== 'kernel_space');
    if (tier !== 'kernel_space') {
      expect(h.depot.hint).toContain('Scheduler: rr. agingInterval: 50.');
      expect(h.depot.hint?.includes('Remedy')).toBe(tier === 'novice');
      expect(h.depot.buy('policy_hint', null).ok).toBe(false);
    }
  });
  it('hint extracts scheduler and ready wait from the live view', () => {
    const h = harness(); h.kernel.spawn({ name: 'waiting', priority: 10, burst: 5, service: 10, arrival: 0, pages: 1 });
    const view = h.kernel.invariantState();
    const text = policyHint({ ...view, tick: tick(141), schedulerId: 'priority', schedulerParams: { ...view.schedulerParams, agingInterval: 0, starvationFatalThreshold: 180 }, processes: view.processes.map((process) => ({ ...process, state: 'ready', readySince: tick(0) })) }, 'operator');
    expect(text).toBe('Scheduler: priority. agingInterval: 0. Longest current ready wait: 141 ticks. Starvation fatal threshold: 180.');
  });
  it('checkpoints are one per depot and a later depot delegates replacement', () => {
    const h = harness(); expect(h.depot.buy('journal_checkpoint', null).ok).toBe(true);
    expect(h.depot.buy('journal_checkpoint', null).ok).toBe(false); expect(h.checkpoint).toHaveBeenCalledTimes(1);
    expect(new Depot(3, 'operator', 'shell', h.deps).buy('journal_checkpoint', null).ok).toBe(true); expect(h.checkpoint).toHaveBeenCalledTimes(2);
    expect(harness('kernel_space').depot.buy('journal_checkpoint', null).ok).toBe(false);
  });
});
