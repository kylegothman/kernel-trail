import { describe, expect, it, vi } from 'vitest';
import { type Tid, asResourceId, createKernel, asTick as tick, type ConvoyMemberId, type InvariantView, type SyncPrimitive } from '@kernel/index';
import { quote, quoteAll, type CrossingContext } from '../../../src/game/crossing/options';
import { CrossingRunner, type CrossingDef } from '../../../src/game/crossing/Crossing';
import { createRunStreams } from '../../../src/game/replay/types';
import { initialRunState } from '../../../src/game/replay/runReplay';
import { createRunStore } from '../../../src/game/runStore';
import { syntheticConfig } from '../fixtures/syntheticLeg';

const context = (contention: number, ordered = true): CrossingContext => ({ contention, ordered, rations: 'standard', aliveCount: 5, crosserHoldsResource: false });
const def: CrossingDef = { id: 'test', legId: 'the_narrows', lockId: 'lock', kind: 'mutex', ordered: true, anchor: 'lock', crosser: 'lumen' };

function harness(c = 0.8, ordered = true, held = false) {
  const store = createRunStore(initialRunState(5, 'shell', 'operator'));
  store.mutate((run) => { run.resources = { cycles: 10000, quota: 10000, blocks: 1000, bandwidth: 1000 }; });
  const kernel = createKernel(syntheticConfig(5));
  const pid = kernel.spawn({ name: 'lumen', priority: 10, burst: 1000, service: 1000, arrival: 0, pages: 1 });
  store.mutate((run) => { const member = run.convoy.find((candidate) => candidate.id === 'lumen'); if (member !== undefined) member.pid = pid; });
  let pressure = c;
  const lock: SyncPrimitive = { id: asResourceId('lock'), displayName: 'lock', kind: 'mutex', value: 0, capacity: 1, holders: [], waitQueue: [pid, pid], ordered };
  const view = (): InvariantView => {
    const base = kernel.invariantState();
    return {
      ...base, schedulerParams: { ...base.schedulerParams, quantum: 3 }, syncPrimitives: [lock],
      processes: base.processes.map((process) => ({ ...process, state: 'waiting', heldResources: held ? [asResourceId('other')] : [] })),
      syncWaits: [{ generation: 1, actor: { pid, tid: 1 as Tid }, resource: lock.id, operation: { kind: 'mutex' }, requestedAt: tick(base.tick - (pressure - 0.7) * 10), entriesObserved: 0, boundedWarningEmitted: false, starvationWarningEmitted: false, starvationFatalEmitted: false }],
    };
  };
  const rng = createRunStreams(5).crossing;
  const inflict = vi.fn(); const record = vi.fn(); const drawEvent = vi.fn(() => 'event');
  const derezz = vi.fn((memberId: ConvoyMemberId) => store.mutate((run) => { const member = run.convoy.find((candidate) => candidate.id === memberId); if (member !== undefined) { member.status = 'derezzed'; member.integrity = 0; } }));
  const step = vi.fn(() => { kernel.step(); });
  const runner = new CrossingRunner({ getRun: store.get, mutate: store.mutate, view, rng, step, drawEvent, inflict, derezz, record });
  return { runner, kernel, store, rng, inflict, derezz, record, drawEvent, step, pressure: (next: number) => { pressure = next; } };
}

describe('crossing formulas', () => {
  it.each([
    [0.2, 30, 96.6, 32, 80, 69, 64, 160, '99.9'],
    [0.4, 48, 86.4, 44, 110, 93, 88, 220, '99.8'],
    [0.6, 66, 69.4, 56, 140, 117, 112, 280, '99.8'],
    [0.8, 84, 45.6, 68, 170, 141, 136, 340, '99.8'],
  ] as const)('all narrative 12.3 cells at C=%s', (c, spinCycles, spinP, blockTicks, blockQuota, monitorCycles, waitTicks, waitQuota, waitDisplay) => {
    const all = quoteAll(context(c));
    expect(all.spin.cyclesCost).toBe(spinCycles); expect(all.spin.successP * 100).toBeCloseTo(spinP, 10);
    expect([all.block.ticksCost, all.block.quotaCost, all.block.successP]).toEqual([blockTicks, blockQuota, 0.99]);
    expect([all.monitor.cyclesCost, all.monitor.successP]).toEqual([monitorCycles, 0.97]);
    expect([all.wait.ticksCost, all.wait.quotaCost]).toEqual([waitTicks, waitQuota]);
    expect((all.wait.successP * 100).toFixed(1)).toBe(waitDisplay);
    expect(all.wait.successP).toBe(1 - 0.20 * (c * 0.86 ** (waitTicks / 10)) ** 2);
  });
  it.each([[0.2, 97.8], [0.4, 91.2], [0.6, 80.2], [0.8, 64.8]])('unordered block at %s', (c, percent) => expect(quote('block', context(c, false)).successP * 100).toBeCloseTo(percent, 10));
  it('quotes consume no random draws across 1000 calls', () => {
    const rng = createRunStreams(7).crossing; const before = rng.save();
    for (let i = 0; i < 1000; i++) { quoteAll(context(i / 1000)); quote('spin', context(i / 1000)); }
    expect(rng.save()).toEqual(before);
  });
  it('monitor chance remains 0.97 across the full contention interval', () => {
    for (let i = 0; i <= 100; i++) expect(quote('monitor', context(i / 100)).successP).toBe(0.97);
  });
});

describe('crossing resolution', () => {
  it('a capped prepaid step halts without a random roll or another attempt', () => {
    const h = harness(); h.step.mockImplementation(() => false);
    const before = h.rng.save(); const result = h.runner.resolve(def, 'wait', tick(0));
    expect(result.attempts).toBe(1); expect(result.succeeded).toBe(false); expect(result.refused).toBeNull();
    expect(h.step).toHaveBeenCalledTimes(1); expect(h.drawEvent).not.toHaveBeenCalled(); expect(h.rng.save()).toEqual(before);
  });
  it('refuses an unaffordable attempt before costs, ticks and rolls', () => {
    const h = harness(); h.store.mutate((run) => { run.resources.bandwidth = 0; });
    const before = h.rng.save(); const ledger = { ...h.store.get().resources };
    const result = h.runner.resolve(def, 'monitor', tick(0));
    expect(result.attempts).toBe(0); expect(result.refused).not.toBeNull();
    expect(h.rng.save()).toEqual(before); expect(h.kernel.tick).toBe(0); expect(h.store.get().resources).toEqual(ledger);
    expect(h.record).toHaveBeenCalledExactlyOnceWith('test:monitor', 'costly', tick(0));
  });
  it('charges once up front and makes real ticks plus exactly the wait draws', () => {
    const h = harness(); vi.spyOn(h.rng, 'next').mockReturnValue(0);
    const start = { ...h.store.get().resources };
    h.step.mockImplementation(() => { expect(h.store.get().resources.quota).toBe(start.quota - 340); h.kernel.step(); });
    const result = h.runner.resolve(def, 'wait', tick(0));
    expect(result.quote.quotaCost).toBe(340); expect(h.kernel.tick).toBe(136); expect(h.step).toHaveBeenCalledTimes(136);
    expect(h.drawEvent).toHaveBeenCalledTimes(13); expect(result.eventsDrawn).toHaveLength(13);
    expect(h.rng.next).toHaveBeenCalledTimes(1); expect(h.store.get().resources.cycles).toBe(start.cycles);
  });
  it('retries at fresh contention, uses four attempts at most and records once', () => {
    const h = harness(0.7); vi.spyOn(h.rng, 'next').mockReturnValue(0.9999);
    h.inflict.mockImplementation(() => { h.pressure(1); });
    const result = h.runner.resolve(def, 'spin', tick(0));
    expect(result.attempts).toBe(4); expect(result.succeeded).toBe(false);
    expect(result.spent.cycles).toBe(75 + 3 * 102); expect(h.kernel.tick).toBe(25 + 3 * 34);
    expect(result.afflicted.some((entry) => entry.id === 'lock_convoy')).toBe(true);
    expect(result.afflicted.some((entry) => entry.id === 'livelock')).toBe(true);
    expect(h.record).toHaveBeenCalledTimes(1);
  });
  it('unordered block failures inflict starvation', () => {
    const h = harness(0.8, false); vi.spyOn(h.rng, 'next').mockReturnValue(0.9999);
    h.runner.resolve(def, 'block', tick(0));
    expect(h.inflict).toHaveBeenCalledWith('lumen', 'starvation', expect.any(Number));
  });
  it.each([0, 0.9999])('hold-and-wait independently kills after first roll %s', (first) => {
    const h = harness(0.8, true, true); const rolls = vi.spyOn(h.rng, 'next').mockReturnValueOnce(first).mockReturnValueOnce(0.119);
    const result = h.runner.resolve(def, 'block', tick(0));
    expect(rolls).toHaveBeenCalledTimes(2); expect(h.derezz).toHaveBeenCalledWith('lumen', 'deadlock_victim', tick(68));
    expect(result.casualties).toEqual(['lumen']); expect(result.succeeded).toBe(false); expect(h.record).toHaveBeenCalledExactlyOnceWith('test:block', 'fatal', tick(0));
  });
  it('the second roll uses the exact 12 percent boundary', () => {
    const h = harness(0.8, true, true); vi.spyOn(h.rng, 'next').mockReturnValueOnce(0).mockReturnValueOnce(0.12);
    expect(h.runner.resolve(def, 'block', tick(0)).succeeded).toBe(true); expect(h.derezz).not.toHaveBeenCalled();
  });
  it('monitor failure costs 20 blocks and bit_rot before a successful retry', () => {
    const h = harness(); vi.spyOn(h.rng, 'next').mockReturnValueOnce(0.99).mockReturnValueOnce(0);
    const result = h.runner.resolve(def, 'monitor', tick(0));
    expect(result.attempts).toBe(2); expect(result.spent.blocks).toBe(20); expect(h.inflict).toHaveBeenCalledWith('lumen', 'bit_rot', tick(8));
    expect(h.kernel.tick).toBe(16); expect(h.store.get().resources.blocks).toBe(980);
  });
});
