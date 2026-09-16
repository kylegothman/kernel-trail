import { describe, expect, it } from 'vitest';
import { type Tid, asPid, asResourceId, createKernel, asTick as tick, type InvariantView, type SyncPrimitive } from '@kernel/index';
import { contention, meanWaitAge } from '../../../src/game/crossing/contention';
import { syntheticConfig } from '../fixtures/syntheticLeg';

function fixture(queued: number, age: number, blocked: number, runnable: number): { view: InvariantView; lock: SyncPrimitive } {
  const kernel = createKernel(syntheticConfig(1));
  for (let i = 0; i < blocked + runnable; i++) kernel.spawn({ name: `process${i}`, priority: 10, burst: 10, service: 10, arrival: 0, pages: 1 });
  const base = kernel.invariantState();
  const lock: SyncPrimitive = { id: asResourceId('crossing'), displayName: 'crossing', kind: 'mutex', value: 0, capacity: 1, holders: [], waitQueue: Array.from({ length: queued }, (_, i) => asPid(i + 1)), ordered: true };
  const view: InvariantView = {
    ...base, tick: tick(20), schedulerParams: { ...base.schedulerParams, quantum: 8 },
    processes: base.processes.filter((process) => process.pid > 1).map((process, index) => ({ ...process, state: index < blocked ? 'waiting' : 'ready' })),
    syncPrimitives: [lock], syncWaits: age === 0 ? [] : [{ generation: 1, actor: { pid: asPid(1), tid: 1 as Tid }, resource: lock.id, operation: { kind: 'mutex' }, requestedAt: tick(20 - age), entriesObserved: 0, boundedWarningEmitted: false, starvationWarningEmitted: false, starvationFatalEmitted: false }],
  };
  return { view, lock };
}

describe('crossing contention with V8 live wait ages', () => {
  it.each([
    [0, 0, 0, 0, 0], [1, 0, 0, 2, 0.25], [0, 8, 0, 2, 0.30],
    [0, 0, 2, 0, 0.20], [2, 4, 1, 1, 0.75], [8, 80, 2, 0, 1],
  ])('six hand-built views: queue %s age %s blocked %s runnable %s', (queued, age, blocked, runnable, expected) => {
    const { view, lock } = fixture(queued, age, blocked, runnable);
    expect(contention(view, lock)).toBeCloseTo(expected, 12);
    expect(contention(view, lock)).toBeGreaterThanOrEqual(0);
    expect(contention(view, lock)).toBeLessThanOrEqual(1);
  });

  it('means only the matching current wait episodes and reads the live quantum', () => {
    const { view, lock } = fixture(0, 4, 0, 0);
    const first = view.syncWaits[0];
    if (first === undefined) throw new Error('missing fixture wait');
    const next: InvariantView = { ...view, syncWaits: [first, { ...first, generation: 2, requestedAt: tick(8) }, { ...first, generation: 3, resource: asResourceId('other'), requestedAt: tick(0) }] };
    expect(meanWaitAge(next, lock.id)).toBe(8);
    expect(contention(next, lock)).toBe(0.30);
    expect(contention({ ...next, schedulerParams: { ...next.schedulerParams, quantum: 16 } }, lock)).toBe(0.15);
  });
});
