import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import type { KernelImpl } from '@kernel/Kernel';
import { createPhilosophers } from '@kernel/sync/scenarios/philosophers';
import type { PhilosophersState } from '@kernel/sync/scenarios/philosophers';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

function fixture(solution: PhilosophersState['solution'], monitorStarvationWitness = false) {
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
    enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0 });
  const initial = createPhilosophers(kernel, { solution, monitorStarvationWitness });
  const state = (): PhilosophersState => {
    const value = kernel.syncSubsystem.scenario(initial.id); if (value.kind !== 'philosophers') throw new Error('missing philosophers'); return value;
  };
  return { kernel, initial, state };
}

/** Test-only topology assertion; production deadlock detection belongs to WP-08. */
function fiveWayWait(kernel: KernelImpl, state: PhilosophersState): boolean {
  if (state.bindings.kind !== 'chopsticks') return false;
  const sticks = state.bindings.chopsticks;
  return state.actors.every(row => {
    const reason = kernel.process(row.actor.pid)?.blockedOn;
    if (reason?.kind !== 'semaphore' || !sticks.includes(reason.resource)) return false;
    const owned = kernel.syncSubsystem.primitives.filter(value => sticks.includes(value.id) && value.holders.includes(row.actor.pid));
    const requested = kernel.syncSubsystem.primitives.find(value => value.id === reason.resource);
    return owned.length === 1 && requested?.holders.length === 1 && requested.holders[0] !== row.actor.pid;
  });
}

describe('dining philosophers', () => {
  it('SYNC-PHIL-NAIVE reaches the identical five-way circular wait before tick 200 in 20 runs', () => {
    const ticks: number[] = [];
    for (let run = 0; run < 20; run++) {
      const f = fixture('naive');
      for (let tick = 0; tick < 200; tick++) {
        f.kernel.step(); if (fiveWayWait(f.kernel, f.state())) { ticks.push(f.kernel.tick); break; }
      }
    }
    expect(ticks).toHaveLength(20); expect(new Set(ticks).size).toBe(1);
    expect(ticks).toEqual(Array.from({ length: 20 }, () => 61));
  });

  it.each(['asymmetric', 'room', 'monitor'] as const)('%s remains free of the forbidden state for 20,000 ticks', solution => {
    const f = fixture(solution);
    for (let tick = 0; tick < 20_000; tick++) {
      f.kernel.step(); const state = f.state(); expect(fiveWayWait(f.kernel, state)).toBe(false);
      if (solution === 'monitor') {
        for (let index = 0; index < 5; index++) expect(state.actors[index]?.state === 'eating' && state.actors[(index + 1) % 5]?.state === 'eating').toBe(false);
      }
      if (state.bindings.kind === 'chopsticks' && state.bindings.room !== null) {
        const room = state.bindings.room;
        expect(f.kernel.syncSubsystem.primitives.find(value => value.id === room)?.holders.length).toBeLessThanOrEqual(4);
      }
    }
    expect(f.state().actors.reduce((sum, row) => sum + row.meals, 0)).toBeGreaterThan(0);
  });

  it('the explicit monitor witness alternates nonadjacent neighbors past the unchanged starvation bound', () => {
    // First draws and rendezvous stay unchanged. Actors 3/4 do 100,000 useful
    // remainder ticks; 0/2 eat 20/40 ticks with one-tick remainders. Actor 0
    // finishes and re-enters while actor 2 covers the intervening interval.
    const f = fixture('monitor', true); const victim = f.initial.actors[1];
    let warned = false; let witnessed = false; let continuouslyCovered = true;
    f.kernel.events.on('process.starving', event => { if (!event.fatal && event.pid === victim?.actor.pid) warned = true; });
    for (let tick = 0; tick < 1000; tick++) {
      f.kernel.step(); const rows = f.state().actors;
      if (rows[1]?.state === 'hungry') continuouslyCovered &&= rows[0]?.state === 'eating' || rows[2]?.state === 'eating';
      if (warned && rows[1]?.state === 'hungry' && rows[0]?.state === 'eating' && rows[2]?.state === 'eating' && (rows[0]?.meals ?? 0) > 0) {
        witnessed = continuouslyCovered; break;
      }
    }
    expect(warned).toBe(true); expect(witnessed).toBe(true); expect(f.kernel.tick).toBe(182);
    expect(f.state().actors[1]?.meals).toBe(0);
  });

  it('SYNC-PHIL-TABLE records all four ordinary reference-seed runs', () => {
    const rows = (['naive', 'asymmetric', 'room', 'monitor'] as const).map(solution => {
      const f = fixture(solution); f.kernel.run(20_000); const state = f.state();
      return { solution, meals: state.actors.reduce((sum, row) => sum + row.meals, 0),
        worstWait: solution === 'naive' ? null : Math.max(...state.actors.map(row => row.worstWait)) };
    });
    expect(rows).toEqual([{ solution: 'naive', meals: 0, worstWait: null }, { solution: 'asymmetric', meals: 869, worstWait: 128 },
      { solution: 'room', meals: 799, worstWait: 102 }, { solution: 'monitor', meals: 687, worstWait: 167 }]);
  });

  it('all think and eat draws belong to root/sync; program lookup consumes no draws', () => {
    const f = fixture('asymmetric'); const rng = f.kernel.syncSubsystem.rng; const before = rng.save();
    const first = f.initial.actors[0]; if (first === undefined) throw new Error('missing first philosopher');
    for (let index = 0; index < 1000; index++) f.kernel.program(first.actor.pid)?.at(index);
    expect(rng.save()).toEqual(before); f.kernel.run(1000);
    expect(rng.save().label).toBe('root/sync'); expect(rng.save()).not.toEqual(before);
  });
});
