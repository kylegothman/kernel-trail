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
import { asPageId, asPid, asResourceId, asTick } from '@kernel/types';
import type { Instruction } from '@kernel/process/Program';
import { REFERENCE_CONFIG } from '../kernel/fixtures/referenceConfig';
import { curriculumDefinitions, expectOk, makeFixture, makeKernel, runUntil } from './harness';

const DEFINED = curriculumDefinitions();
function shellWith(names: readonly string[], kernel = makeKernel()) {
  const fixture = makeFixture(kernel);
  for (const name of names) {
    const def = DEFINED.get(name);
    if (def === undefined) throw new Error(`no curriculum definition for ${name}`);
    fixture.shell.register(def);
  }
  return fixture;
}

function pagingKernel(frames = 8, tuning = {}, count = 1, thrashingThreshold = REFERENCE_CONFIG.thrashingThreshold) {
  const kernel = makeKernel({ totalFrames: frames, thrashingThreshold, enabledSubsystems: ['process', 'scheduler', 'memory', 'vm'] }, tuning);
  const pids = Array.from({ length: count }, (_, index) => kernel.spawn({ name: `pager${index}`, priority: 1, arrival: 0, burst: 200, service: 200, pages: 4, referenceString: Array.from({ length: 200 }, (_, i) => i % 4) }));
  return { kernel, pid: pids[0] ?? (0 as never), pids };
}

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

describe('live state', () => {
  it('ps live: spawning a process changes the next invocation with no cache flush', () => {
    const f = shellWith(['ps']);
    const before = expectOk(f.shell, 'ps');
    const pid = f.kernel.spawn({ name: 'newcomer', priority: 1, arrival: 0, burst: 10, service: 10, pages: 0 }, { program: instructionProgram([{ kind: 'compute' }]) });
    const after = expectOk(f.shell, 'ps');
    expect(after).not.toEqual(before);
    expect(after.some(line => line.includes(`${pid}`) && line.includes('newcomer'))).toBe(true);
  });

  it('free live: allocating frames changes the output', () => {
    const { kernel } = pagingKernel();
    const f = shellWith(['free'], kernel);
    const before = expectOk(f.shell, 'free');
    runUntil(kernel, () => f.host.view().freeList.length < 8, 40);
    expect(expectOk(f.shell, 'free')).not.toEqual(before);
  });

  it('vmstat live: a burst of page faults changes the fault rate', () => {
    // The smoothed rate is a per-tick shift average: it rises on the tick a fault lands and decays
    // to zero within a tick when faults are sparse, so the reading is taken on a fault tick.
    const { kernel } = pagingKernel(2);
    const f = shellWith(['vmstat'], kernel);
    const before = expectOk(f.shell, 'vmstat');
    const rate = (lines: readonly string[]): string | undefined => lines.find(line => line.startsWith('fault rate'));
    expect(rate(before)).toContain('0.00');
    runUntil(kernel, () => kernel.events.lastFrame.some(event => event.type === 'memory.page_fault'), 100);
    const after = expectOk(f.shell, 'vmstat');
    expect(after).not.toEqual(before);
    expect(rate(after)).not.toBe(rate(before));
    expect(after.find(line => line.startsWith('page faults'))).not.toBe(before.find(line => line.startsWith('page faults')));
  });

  it('iostat live: queuing disk requests changes the output', () => {
    const kernel = makeKernel({ totalFrames: 3, replacementPolicy: 'fifo', thrashingThreshold: 1e9, enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'storage', 'io'] },
      { majorFaultTicks: 3, tlbMissTicks: 1, tlbHitTicks: 1, thrashingCriticalDemandRatio: 1e9, thrashingSuspendInterval: 1000 });
    kernel.attachPagingStorage();
    const access = (page: number): Instruction => ({ kind: 'access', page: asPageId(page), write: false });
    kernel.spawn({ name: 'reader', priority: 10, arrival: 0, burst: 100, service: 100, pages: 3 }, { program: instructionProgram([access(0), access(1), access(2), { kind: 'compute' }]) });
    const f = shellWith(['iostat'], kernel);
    const before = expectOk(f.shell, 'iostat');
    runUntil(kernel, () => f.host.view().diskQueue.length > 0 || f.shell.rings.diskQueued.length > 0, 20);
    const queued = expectOk(f.shell, 'iostat');
    expect(queued).not.toEqual(before);
    runUntil(kernel, () => f.shell.rings.diskServed.length > 0, 100);
    expect(expectOk(f.shell, 'iostat')).not.toEqual(queued);
  });

  it('pagetable live: a page load changes the table for that address space', () => {
    const { kernel, pid } = pagingKernel();
    const f = shellWith(['pagetable'], kernel);
    const before = expectOk(f.shell, `pagetable ${pid}`);
    runUntil(kernel, () => (f.host.view().pageTables.get(kernel.process(pid)?.addressSpaceId ?? (0 as never)) ?? []).some(entry => entry.valid), 40);
    const after = expectOk(f.shell, `pagetable ${pid}`);
    expect(after).not.toEqual(before);
    expect(after[0]).not.toContain('0 resident');
  });

  it('sched applies: sched --policy srtf goes through the command bus and the next dispatch follows SRTF', () => {
    const kernel = makeKernel({ enabledSubsystems: ['process', 'scheduler'] });
    const f = shellWith(['sched'], kernel);
    expect(expectOk(f.shell, 'sched --policy srtf')[0]).toContain('scheduler set to srtf');
    expect(f.run.decisions).toEqual([expect.objectContaining({ kind: 'set_scheduler', choice: 'sched --policy srtf' })]);
    expect(f.host.view().schedulerId).toBe('srtf');
    const long = kernel.spawn({ name: 'long', priority: 5, arrival: 0, burst: 40, service: 40, pages: 0 }, { program: instructionProgram([{ kind: 'compute' }]) });
    const short = kernel.spawn({ name: 'short', priority: 5, arrival: 0, burst: 3, service: 3, pages: 0 }, { program: instructionProgram([{ kind: 'compute' }]) });
    kernel.step();
    expect(f.host.view().running).toBe(short);
    expect(kernel.process(long)?.state).toBe('ready');
  });

  it('no stale copy: a shell opened early reflects 100 more ticks without reopening', () => {
    const { kernel } = pagingKernel();
    const f = shellWith(['ps', 'vmstat', 'free'], kernel);
    const snapshot = [expectOk(f.shell, 'ps -l'), expectOk(f.shell, 'vmstat'), expectOk(f.shell, 'free')];
    kernel.run(100);
    const later = [expectOk(f.shell, 'ps -l'), expectOk(f.shell, 'vmstat'), expectOk(f.shell, 'free')];
    expect(later[0]).not.toEqual(snapshot[0]);
    expect(later[1]).not.toEqual(snapshot[1]);
    expect(later[1]?.find(line => line.startsWith('page faults'))).not.toBe(snapshot[1]?.find(line => line.startsWith('page faults')));
    expect(later[2]).not.toEqual(snapshot[2]);
  });
});
