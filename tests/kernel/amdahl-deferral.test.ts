import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { amdahlSpeedup } from '@kernel/process/amdahl';
import { ThreadManager, type ThreadModel } from '@kernel/process/threads';
import type { RawProcessWork } from '@kernel/process/ProcessTable';
import { instructionProgram } from '@kernel/process/Program';
import { asPid, asTick } from '@kernel/types';
import type { AddressSpaceId, DomainId, Pid, ProcessControlBlock, Tid } from '@kernel/types';
import { REFERENCE_CONFIG } from './fixtures/referenceConfig';

function fixture(options: {
  raw?: number; burst?: number; threads?: number; cores?: number; pool?: number;
  serial?: number; overhead?: number; model?: ThreadModel; maxThreads?: number;
} = {}) {
  const rawService = options.raw ?? 100;
  const count = options.threads ?? 1;
  const coreCount = options.cores ?? count;
  const work: RawProcessWork = {
    rawBurst: options.burst ?? rawService, rawService, serialFraction: options.serial ?? 0.25,
  };
  const pcb: ProcessControlBlock = {
    pid: asPid(2), parent: asPid(1), name: 'creation debt', state: 'ready',
    priority: 20, basePriority: 20, arrivalTick: asTick(0),
    cpuBurstRemaining: work.rawBurst, serviceRemaining: work.rawService, totalCpuUsed: 0,
    readySince: asTick(0), lastScheduledTick: null, queueLevel: 0,
    addressSpaceId: 2 as AddressSpaceId, threads: [], openFiles: [],
    heldResources: [], requestedResources: [], blockedOn: null,
    domain: 'user' as DomainId, exitCode: null, terminationReason: null, convoyMemberId: null,
  };
  const onEmpty = vi.fn();
  const manager = new ThreadManager({
    model: options.model ?? 'one_to_one', coreCount, lwpPoolSize: options.pool ?? coreCount,
    maxThreadsPerProcess: options.maxThreads ?? 64, threadCreateTicks: options.overhead ?? 2,
  }, new Map<Pid, RawProcessWork>([[pcb.pid, work]]), () => {}, onEmpty);
  for (let index = 0; index < count; index++) pcb.threads.push(manager.newTid());
  manager.attach(pcb);
  manager.recompute(pcb);
  const thread = (index: number) => {
    const tid = pcb.threads[index];
    const value = tid === undefined ? undefined : manager.table.get(tid);
    if (value === undefined) throw new Error('missing fixture thread');
    return value;
  };
  const state = () => ({
    raw: { ...work }, burst: pcb.cpuBurstRemaining, service: pcb.serviceRemaining,
    accounting: manager.accountingState(pcb.pid),
    threads: pcb.threads.map(tid => {
      const value = manager.table.get(tid);
      return { tid, service: value?.serviceRemaining, pc: value?.programCounter };
    }),
  });
  return { manager, pcb, work, thread, state, onEmpty };
}

function conserved(value: ReturnType<typeof fixture>): void {
  const { manager, pcb, work } = value;
  const services = pcb.threads.map(tid => manager.table.get(tid)?.serviceRemaining ?? 0);
  expect(services.reduce((sum, service) => sum + service, 0)).toBe(pcb.serviceRemaining);
  expect([...services, work.rawBurst, work.rawService, pcb.cpuBurstRemaining, pcb.serviceRemaining]
    .every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
}

describe('Amdahl creation debt', () => {
  it.each([
    ['one_to_one', 4, 4], ['many_to_many', 2, 2], ['many_to_one', 8, 1],
  ] as const)('%s charges eight threads while speedup uses the available cores', (model, pool, cores) => {
    const { manager, pcb } = fixture({ model, threads: 8, cores: 4, pool });
    expect(manager.accountingState(pcb.pid)).toEqual({ overheadRemaining: 16, pricedCores: cores });
    expect(pcb.serviceRemaining).toBe(Math.ceil(100 / amdahlSpeedup(0.25, cores)) + 16);
  });

  it('overhead is CPU service with no callback, PC advance, fault or useful raw progress', () => {
    const value = fixture({ threads: 2 });
    const { manager, pcb, work } = value;
    const execute = vi.fn(() => true);
    for (let tick = 0; tick < 4; tick++) {
      expect(manager.deliver(pcb, execute)).not.toBeNull();
      expect(work).toEqual({ rawBurst: 100, rawService: 100, serialFraction: 0.25 });
      conserved(value);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(value.state().threads.map(thread => thread.pc)).toEqual([0, 0]);
    expect(pcb.totalCpuUsed).toBe(4);
    expect(pcb.serviceRemaining).toBe(63);
    expect(manager.accountingState(pcb.pid)).toEqual({ overheadRemaining: 0, pricedCores: 2 });
    manager.deliver(pcb, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(work.rawService).toBe(99);
    expect(pcb.serviceRemaining).toBe(62);
    conserved(value);
  });

  it('recompute and duplicate wake never recharge partially paid creation debt', () => {
    const { manager, pcb, thread, state } = fixture({ threads: 2 });
    manager.deliver(pcb, () => true);
    manager.block(pcb, thread(0).tid, { kind: 'sleep', untilTick: asTick(10) });
    manager.recompute(pcb);
    expect(manager.accountingState(pcb.pid)).toEqual({ overheadRemaining: 3, pricedCores: 1 });
    manager.wake(pcb, thread(0).tid);
    const expected = state();
    for (let repeat = 0; repeat < 5; repeat++) {
      manager.recompute(pcb);
      manager.wake(pcb, thread(0).tid);
      expect(state()).toEqual(expected);
    }
    expect(expected.accounting).toEqual({ overheadRemaining: 3, pricedCores: 2 });
  });

  it('a join retains incurred debt and final join deletes it even without a cleanup callback', () => {
    const { manager, pcb, thread, onEmpty } = fixture({ threads: 2 });
    manager.deliver(pcb, () => true);
    expect(manager.join(pcb, thread(0).tid, thread(1).tid).ok).toBe(true);
    expect(manager.accountingState(pcb.pid)).toEqual({ overheadRemaining: 3, pricedCores: 1 });
    expect(pcb.serviceRemaining).toBe(103);
    expect(manager.join(pcb, thread(0).tid).ok).toBe(true);
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(manager.accountingState(pcb.pid)).toBeUndefined();
  });

  it('failed creation leaves raw work, debt, service and thread identity unchanged', () => {
    const { manager, pcb, state } = fixture({ maxThreads: 1 });
    const before = state();
    expect(manager.create(pcb)).toMatchObject({ ok: false, errno: 'EAGAIN' });
    expect(state()).toEqual(before);
    const invalid = fixture();
    const validState = invalid.state();
    expect(() => invalid.manager.create(invalid.pcb, undefined, { lwp: -1 })).toThrow(RangeError);
    expect(invalid.state()).toEqual(validState);
  });

  it('creation on the last useful unit preserves debt after raw service reaches zero', () => {
    const value = fixture({ raw: 1 });
    const { manager, pcb, work } = value;
    manager.deliver(pcb, () => true);
    manager.deliver(pcb, () => true);
    manager.deliver(pcb, thread => {
      expect(work.rawService).toBe(0);
      expect(manager.create(pcb, thread.tid).ok).toBe(true);
      return true;
    });
    expect(work.rawService).toBe(0);
    expect(manager.accountingState(pcb.pid)?.overheadRemaining).toBe(2);
    expect(pcb.serviceRemaining).toBe(2);
    const execute = vi.fn(() => true);
    manager.deliver(pcb, execute);
    manager.deliver(pcb, execute);
    expect(execute).not.toHaveBeenCalled();
    expect(pcb.totalCpuUsed).toBe(5);
    expect(pcb.serviceRemaining).toBe(0);
    manager.recompute(pcb);
    expect(pcb.cpuBurstRemaining).toBe(0);
    expect(pcb.serviceRemaining).toBe(0);
    expect(manager.deliver(pcb, execute)).toBeNull();
    conserved(value);
  });

  it('burst rollover reprices useful work without a second overhead pool', () => {
    const { manager, pcb, work } = fixture({ raw: 30, burst: 3 });
    for (let tick = 0; tick < 5; tick++) manager.deliver(pcb, () => true);
    expect(pcb.cpuBurstRemaining).toBe(0);
    expect(work.rawService).toBe(27);
    work.rawBurst = 3;
    manager.recompute(pcb);
    expect(pcb.cpuBurstRemaining).toBe(3);
    expect(pcb.serviceRemaining).toBe(27);
    expect(manager.accountingState(pcb.pid)?.overheadRemaining).toBe(0);
  });

  it('halving a blocked process preserves debt and prices at cached cores without waking', () => {
    const value = fixture({ raw: 101, burst: 51, threads: 2 });
    const { manager, pcb, work, thread } = value;
    manager.deliver(pcb, () => true);
    const reason = { kind: 'sleep', untilTick: asTick(50) } as const;
    manager.block(pcb, thread(0).tid, reason);
    manager.block(pcb, thread(1).tid, reason);
    manager.halveUsefulWork(pcb);
    expect(work).toEqual({ rawBurst: 26, rawService: 51, serialFraction: 0.25 });
    expect(manager.accountingState(pcb.pid)).toEqual({ overheadRemaining: 3, pricedCores: 2 });
    expect(pcb.cpuBurstRemaining).toBe(20);
    expect(pcb.serviceRemaining).toBe(35);
    expect(pcb.threads.map(tid => manager.table.get(tid)?.state)).toEqual(['waiting', 'waiting']);
    expect(thread(0).blockedOn).toEqual(reason);
    expect(thread(1).blockedOn).toEqual(reason);
    conserved(value);
  });

  it('accounting views are detached and fresh program attachment and reset discard old debt', () => {
    const { manager, pcb } = fixture({ threads: 2 });
    const held = manager.accountingState(pcb.pid);
    manager.deliver(pcb, () => true);
    expect(held).toEqual({ overheadRemaining: 4, pricedCores: 2 });
    expect(Object.isFrozen(held)).toBe(true);
    manager.clear(pcb);
    expect(manager.accountingState(pcb.pid)).toBeUndefined();
    manager.attach(pcb);
    expect(manager.accountingState(pcb.pid)).toEqual({ overheadRemaining: 2, pricedCores: null });
    manager.reset();
    expect(manager.accountingState(pcb.pid)).toBeUndefined();
  });
});

describe('integer useful progress and deferred delivery', () => {
  it('every remaining useful budget equals the ceiling of its integral raw remainder', () => {
    for (const cores of [1, 2, 3, 4, 7, 16, 32]) {
      for (const serial of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
        for (const raw of [1, 2, 9, 67, 100]) {
          const value = fixture({ raw, threads: cores, serial, overhead: 0 });
          const { manager, pcb, work } = value;
          const speedup = amdahlSpeedup(serial, cores);
          const ticks = pcb.serviceRemaining;
          for (let tick = 0; tick < ticks; tick++) {
            const previousRaw = work.rawService;
            expect(manager.deliver(pcb, () => true)).not.toBeNull();
            expect(work.rawService).toBeLessThan(previousRaw);
            expect(Math.ceil(work.rawService / speedup)).toBe(pcb.serviceRemaining);
            expect(Math.ceil(work.rawBurst / speedup)).toBe(pcb.cpuBurstRemaining);
            if (manager.effectiveCores(pcb, true) === cores) {
              const before = value.state();
              manager.recompute(pcb);
              expect(value.state()).toEqual(before);
            }
            conserved(value);
          }
          expect(work.rawService).toBe(0);
          expect(pcb.totalCpuUsed).toBe(ticks);
        }
      }
    }
  });

  it('a deferred useful tick restores raw work, budgets and both side values while charging CPU', () => {
    const value = fixture({ threads: 4 });
    const { manager, pcb } = value;
    for (let tick = 0; tick < 8; tick++) manager.deliver(pcb, () => true);
    const before = value.state();
    manager.deliver(pcb, () => {
      manager.deferServiceCharge();
      return false;
    });
    expect(value.state()).toEqual(before);
    expect(pcb.totalCpuUsed).toBe(9);
    manager.recompute(pcb);
    expect(value.state()).toEqual(before);
    conserved(value);
  });

  it('fault deferral restores sibling shares and the old price while retaining the actual wait', () => {
    const value = fixture({ threads: 4 });
    const { manager, pcb } = value;
    for (let tick = 0; tick < 8; tick++) manager.deliver(pcb, () => true);
    const before = value.state();
    let blocked: Tid | undefined;
    manager.deliver(pcb, thread => {
      blocked = thread.tid;
      manager.deferServiceCharge();
      manager.block(pcb, thread.tid, { kind: 'sleep', untilTick: asTick(5) });
      manager.recompute(pcb);
      expect(manager.accountingState(pcb.pid)?.pricedCores).toBe(3);
      return false;
    });
    if (blocked === undefined) throw new Error('fault callback did not execute');
    expect(value.state()).toEqual(before);
    expect(manager.table.get(blocked)?.state).toBe('waiting');
    expect(pcb.totalCpuUsed).toBe(9);
    manager.wake(pcb, blocked);
    manager.recompute(pcb);
    expect(value.state()).toEqual(before);
    manager.deliver(pcb, () => true);
    expect(pcb.serviceRemaining).toBe(before.service - 1);
    conserved(value);
  });
});

describe('creation debt at kernel lifecycle boundaries', () => {
  const config = { ...REFERENCE_CONFIG, scheduler: 'fcfs' as const, enabledSubsystems: ['process', 'scheduler'] as const };
  const work = { name: 'initial', priority: 20, burst: 100, service: 100, arrival: 0, pages: 0 };

  it('fork copies useful raw work but admits the child with fresh initial debt', () => {
    const kernel = createKernel(config, { threadCreateTicks: 2 });
    const pid = kernel.spawn(work, { program: instructionProgram([{ kind: 'compute' }]) });
    kernel.step();
    expect(kernel.threads.accountingState(pid)?.overheadRemaining).toBe(1);
    const forked = kernel.syscall({ name: 'fork', pid, args: [] });
    if (!forked.ok || typeof forked.value !== 'number') throw new Error('fork failed');
    const child = asPid(forked.value);
    expect(kernel.table.raw.get(child)).toEqual(kernel.table.raw.get(pid));
    expect(kernel.threads.accountingState(child)).toEqual({ overheadRemaining: 2, pricedCores: null });
    kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(100) });
    kernel.step();
    expect(kernel.threads.accountingState(child)).toEqual({ overheadRemaining: 1, pricedCores: 1 });
    expect(kernel.table.raw.get(child)?.rawService).toBe(100);
  });

  it('successful exec replaces old debt after raw reset; failed exec leaves accounting unchanged', () => {
    const kernel = createKernel(config, { threadCreateTicks: 2 });
    const pid = kernel.spawn(work, { program: instructionProgram([{ kind: 'compute' }]) });
    kernel.step();
    const before = kernel.threads.accountingState(pid);
    expect(kernel.syscall({ name: 'exec', pid, args: ['missing'] }).ok).toBe(false);
    expect(kernel.threads.accountingState(pid)).toEqual(before);
    kernel.registerProgram('next', instructionProgram([{ kind: 'compute' }, { kind: 'compute' }, { kind: 'compute' }]));
    expect(kernel.syscall({ name: 'exec', pid, args: ['next'] }).ok).toBe(true);
    expect(kernel.threads.accountingState(pid)).toEqual({ overheadRemaining: 2, pricedCores: 1 });
    expect(kernel.process(pid)?.serviceRemaining).toBe(5);
    const tid = kernel.process(pid)?.threads[0];
    if (tid === undefined) throw new Error('exec thread missing');
    kernel.run(2);
    expect(kernel.threads.table.get(tid)?.programCounter).toBe(0);
    expect(kernel.table.raw.get(pid)?.rawService).toBe(3);
    kernel.step();
    expect(kernel.threads.table.get(tid)?.programCounter).toBe(1);
    expect(kernel.table.raw.get(pid)?.rawService).toBe(2);
  });
});
