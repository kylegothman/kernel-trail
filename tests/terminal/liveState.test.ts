// @vitest-environment happy-dom
/**
 * WP-15 live-state cases: every command reads the simulator as it is now, never
 * a copy taken when the terminal opened. The DOM batching and scrollback cases
 * run under happy-dom, which counts nodes and mutations but does not lay out.
 */
import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { instructionProgram } from '@kernel/process/Program';
import type { Actor } from '@kernel/sync/SyncSubsystem';
import { asPid, asResourceId, asTick } from '@kernel/types';
import { REFERENCE_CONFIG } from '../kernel/fixtures/referenceConfig';

/** The spinlock workload of tests/kernel/sync/atomics.test.ts: a holder sleeps on the lock while a spinner burns ticks. */
function spinlockKernel() {
  const resource = asResourceId('atomic:lock');
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr',
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 }, enabledSubsystems: ['process', 'scheduler', 'sync'] },
  { threadCreateTicks: 0, contextSwitchTicks: 0 });
  const program = instructionProgram([{ kind: 'sync', operation: { op: 'scenario', scenario: 'spin', step: 0 } }]);
  const spawnActor = (name: string): Actor => {
    const pid = kernel.spawn({ name, priority: 1, burst: 1000, service: 1000, arrival: 0, pages: 0 }, { program, serialFraction: 1 });
    const tid = kernel.process(pid)?.threads[0];
    if (tid === undefined) throw new Error('missing thread');
    return { pid, tid };
  };
  const holder = spawnActor('holder'); const spinner = spawnActor('spinner');
  kernel.syncSubsystem.createAtomicLock(resource, 'tas', [holder, spinner], 'lock');
  kernel.syncSubsystem.addScenario({ id: 'spin', kind: 'spinlock', resource, criticalTicks: 1,
    remainderTicks: 0, iterationLimit: null, actors: [holder, spinner].map(actor => ({ actor, completedEntries: 0 })) });
  kernel.step(); kernel.blockProcess(holder.pid, { kind: 'sleep', untilTick: asTick(200) });
  return { kernel, holder, spinner };
}

describe('SyncSubsystem.spinTicks (T3)', () => {
  it('counts the busy-wait ticks of the spinner and nothing for the holder or an unknown pid', () => {
    const { kernel, holder, spinner } = spinlockKernel();
    expect(kernel.syncSubsystem.spinTicks(spinner.pid)).toBe(0);
    kernel.run(100);
    expect(kernel.syncSubsystem.spinTicks(spinner.pid)).toBe(100);
    expect(kernel.syncSubsystem.spinTicks(holder.pid)).toBe(0);
    expect(kernel.syncSubsystem.spinTicks(asPid(999))).toBe(0);
    expect(kernel.syncSubsystem.saveState().sync.payload.spinTicks).toEqual([[spinner.pid, 100]]);
  });
});
