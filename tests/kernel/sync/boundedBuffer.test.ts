import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { createBoundedBuffer } from '@kernel/sync/scenarios/boundedBuffer';
import type { BoundedBufferOptions, BoundedBufferState } from '@kernel/sync/scenarios/boundedBuffer';
import type { KernelEvent, ResourceId } from '@kernel/types';
import { canonical } from '../canonical';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

function fixture(options: BoundedBufferOptions = {}) {
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
    enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0 });
  const initial = createBoundedBuffer(kernel, options);
  const state = (): BoundedBufferState => {
    const value = kernel.syncSubsystem.scenario(initial.id); if (value.kind !== 'bounded_buffer') throw new Error('missing buffer'); return value;
  };
  const value = (resource: ResourceId): number => {
    const primitive = kernel.syncSubsystem.primitives.find(row => row.id === resource); if (primitive === undefined) throw new Error('missing semaphore'); return primitive.value;
  };
  return { kernel, initial, state, value };
}

describe('bounded buffer through the real kernel', () => {
  it('SYNC-BB-1: 3x20 producers and 2x30 consumers preserve occupancy and signed-count conservation', () => {
    const f = fixture(); const races: KernelEvent[] = []; const panics: KernelEvent[] = [];
    f.kernel.events.on('sync.race_detected', event => races.push(event)); f.kernel.events.on('kernel.panic', event => panics.push(event));
    for (let tick = 0; tick < 10_000; tick++) {
      f.kernel.step(); const state = f.state();
      expect(state.items.length).toBeGreaterThanOrEqual(0); expect(state.items.length).toBeLessThanOrEqual(4);
      expect(Math.max(f.value(state.empty), 0) + Math.max(f.value(state.full), 0) + state.inFlight).toBe(4);
      expect(state.inFlight).toBe(state.reservations.length);
    }
    expect(f.state()).toMatchObject({ produced: 60, consumed: 60, items: [], inFlight: 0 });
    expect(races).toEqual([]); expect(panics).toEqual([]);
  });

  it('SYNC-BB-DEADLOCK: wrong order blocks a producer on empty while owning mutex and every consumer waits for mutex', () => {
    const f = fixture({ variant: 'wrong_order' }); let found = false;
    for (let tick = 0; tick < 300 && !found; tick++) {
      f.kernel.step(); const state = f.state();
      const held = f.kernel.syncSubsystem.primitives.find(row => row.id === state.mutex)?.holders ?? [];
      const producer = state.actors.find(row => {
        const reason = f.kernel.process(row.actor.pid)?.blockedOn;
        return row.role === 'producer' && held.includes(row.actor.pid) && reason?.kind === 'semaphore' && reason.resource === state.empty;
      });
      const consumersBlocked = state.actors.filter(row => row.role === 'consumer').every(row => {
        const reason = f.kernel.process(row.actor.pid)?.blockedOn; return reason?.kind === 'semaphore' && reason.resource === state.mutex;
      });
      found = producer !== undefined && consumersBlocked;
    }
    // WP-08 turns this reproducible state into deadlock.detected.
    expect(found).toBe(true);
  });

  it('the ordering remedy completes the same workload', () => {
    const f = fixture({ variant: 'correct' }); f.kernel.run(10_000);
    expect(f.state()).toMatchObject({ produced: 60, consumed: 60, inFlight: 0 });
    expect(f.kernel.syncSubsystem.primitives.every(row => row.waitQueue.length === 0)).toBe(true);
  });

  it('SYNC-BB-UNBALANCED records actual utilization and exhausts available slot capacity', () => {
    const f = fixture({ variant: 'unbalanced' }); let peak = 0; let producerBlocked = false; let saturated = false;
    for (let tick = 0; tick < 10_000; tick++) {
      f.kernel.step(); const state = f.state(); peak = Math.max(peak, state.items.length); saturated ||= f.value(state.empty) <= 0;
      producerBlocked ||= state.actors.some(row => {
        const reason = f.kernel.process(row.actor.pid)?.blockedOn; return row.role === 'producer' && reason?.kind === 'semaphore' && reason.resource === state.empty;
      });
    }
    expect(saturated).toBe(true); expect(producerBlocked).toBe(true); expect(f.state().consumed).toBe(60);
    const busy = f.kernel.saveSchedulerState().payload.accounting.busyTicks;
    // Reserved slots make all four unavailable although FIFO occupancy peaks at three.
    expect(peak).toBe(3); expect(busy).toBe(840); expect(busy / 10_000).toBe(0.084);
  });

  it('a populated contribution detaches and continues identically against equivalent staged kernel state', () => {
    const a = fixture({ reordering: true }); const b = fixture({ reordering: true }); let captured = false;
    for (let tick = 0; tick < 500; tick++) {
      a.kernel.step(); b.kernel.step(); const saved = a.kernel.syncSubsystem.saveState().sync;
      if (saved.payload.memoryOrder.buffers.some(row => row.writes.length > 0) && saved.payload.waits.length > 0) {
        const detached = structuredClone(saved); const before = canonical(detached);
        b.kernel.syncSubsystem.prepareRestore(detached)();
        expect(canonical(b.kernel.syncSubsystem.saveState().sync)).toBe(canonical(saved));
        expect(b.kernel.run(500)).toEqual(a.kernel.run(500));
        expect(canonical(a.kernel.syncSubsystem.saveState())).toBe(canonical(b.kernel.syncSubsystem.saveState()));
        expect(canonical(detached)).toBe(before); captured = true; break;
      }
    }
    expect(captured).toBe(true);
  });
});
