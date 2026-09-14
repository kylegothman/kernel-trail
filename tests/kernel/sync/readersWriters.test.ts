import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { createReadersWriters } from '@kernel/sync/scenarios/readersWriters';
import type { ReadersWritersState } from '@kernel/sync/scenarios/readersWriters';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

function fixture(policy: ReadersWritersState['policy']) {
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
    enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0 });
  const initial = createReadersWriters(kernel, { policy });
  const state = (): ReadersWritersState => {
    const value = kernel.syncSubsystem.scenario(initial.id); if (value.kind !== 'readers_writers') throw new Error('missing readers-writers scenario'); return value;
  };
  return { kernel, initial, state };
}

describe('the three readers-writers policies', () => {
  it('SYNC-RW-STARVE: repeated readers cause exactly one fatal event naming the writer', () => {
    const f = fixture('reader_pref'); const writer = f.initial.actors.find(row => row.role === 'writer');
    const events = f.kernel.run(5000); const fatal = events.filter(event => event.type === 'process.starving' && event.fatal);
    expect(fatal).toHaveLength(1); expect(fatal[0]).toMatchObject({ pid: writer?.actor.pid, fatal: true });
    expect(f.state().actors.find(row => row.role === 'writer')).toMatchObject({ outcome: 'starved', completedOperations: 0 });
    expect(f.state().actors.filter(row => row.role === 'reader').every(row => row.completedOperations > 1)).toBe(true);
  });

  it('SYNC-RW-WRITERPREF: the writer completes and a reader waits longest', () => {
    const f = fixture('writer_pref'); f.kernel.run(5000); const state = f.state();
    expect(state.actors.find(row => row.role === 'writer')).toMatchObject({ completedOperations: 1, outcome: 'completed' });
    const longest = [...state.actors].sort((a, b) => b.worstWait - a.worstWait)[0]; expect(longest?.role).toBe('reader');
  });

  it('fair tickets complete the writer and repeatedly serve every reader without fatal starvation', () => {
    const f = fixture('fair'); const events = f.kernel.run(5000);
    expect(events.filter(event => event.type === 'process.starving' && event.fatal)).toEqual([]);
    expect(f.state().actors.every(row => row.completedOperations > 0)).toBe(true);
  });

  it('reader preference follows the exact first-reader/last-reader semaphore protocol', () => {
    const f = fixture('reader_pref'); const bindings = f.initial.bindings;
    if (bindings.kind !== 'semaphores') throw new Error('missing reader protocol');
    let countPositive = false; let sharedAcquisitions = 0;
    f.kernel.events.on('sync.acquired', event => { if (event.resource === bindings.rwMutex) sharedAcquisitions++; });
    f.kernel.run(200);
    const word = f.kernel.syncSubsystem.saveState().sync.payload.memoryOrder.cells.find(value => value.id === bindings.readCountCell);
    if (word?.kind === 'control') countPositive = word.value > 0;
    expect(countPositive).toBe(true); expect(sharedAcquisitions).toBe(1);
  });

  it('records throughput without asserting an unjustified universal policy ranking', () => {
    const rows = (['reader_pref', 'writer_pref', 'fair'] as const).map(policy => {
      const f = fixture(policy); f.kernel.run(5000);
      return { policy, completed: f.state().actors.reduce((sum, row) => sum + row.completedOperations, 0) };
    });
    expect(rows).toEqual([{ policy: 'reader_pref', completed: 275 }, { policy: 'writer_pref', completed: 413 }, { policy: 'fair', completed: 413 }]);
  });
});
