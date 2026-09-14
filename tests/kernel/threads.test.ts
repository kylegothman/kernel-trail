import { describe, expect, it } from 'vitest';
import { amdahlSpeedup, usableCores } from '@kernel/process/amdahl';
import { assignLwps, ThreadManager } from '@kernel/process/threads';
import type { ThreadConfig, ThreadControlBlock, ThreadModel } from '@kernel/process/threads';
import type { RawProcessWork } from '@kernel/process/ProcessTable';
import type { EmittableEvent } from '@kernel/EventBus';
import { asPid, asTick } from '@kernel/types';
import type { AddressSpaceId, DomainId, Pid, ProcessControlBlock, Tid } from '@kernel/types';

const CORES = [1, 2, 4, 8, 16, 32];

function fixture(model: ThreadModel = 'one_to_one', count = 1, cores = 4, overhead = 0) {
  const cfg: ThreadConfig = {
    model, coreCount: cores, lwpPoolSize: cores, maxThreadsPerProcess: Math.max(16, count),
    threadCreateTicks: overhead,
  };
  const pcb: ProcessControlBlock = {
    pid: asPid(2), parent: asPid(1), name: 'thread fixture', state: 'ready',
    priority: 20, basePriority: 20, arrivalTick: asTick(0),
    cpuBurstRemaining: 100, serviceRemaining: 100, totalCpuUsed: 0,
    readySince: asTick(0), lastScheduledTick: null, queueLevel: 0,
    addressSpaceId: 2 as AddressSpaceId, threads: [], openFiles: [],
    heldResources: [], requestedResources: [], blockedOn: null,
    domain: 'user' as DomainId, exitCode: null, terminationReason: null,
    convoyMemberId: null,
  };
  const work: RawProcessWork = { rawBurst: 100, rawService: 100, serialFraction: 0.25 };
  const raw = new Map<Pid, RawProcessWork>([[pcb.pid, work]]);
  const events: EmittableEvent[] = [];
  const exitRequests: { pid: Pid; code: number }[] = [];
  const manager = new ThreadManager(cfg, raw, event => events.push(event), process => {
    exitRequests.push({ pid: process.pid, code: 0 });
  });
  for (let index = 0; index < count; index++) pcb.threads.push(manager.newTid());
  manager.attach(pcb);
  const thread = (index: number): ThreadControlBlock => {
    const tid = pcb.threads[index];
    if (tid === undefined) throw new Error('fixture thread missing');
    const value = manager.table.get(tid);
    if (value === undefined) throw new Error('fixture TCB missing');
    return value;
  };
  return { cfg, pcb, work, manager, events, exitRequests, thread };
}

describe('sim spec 16.4: Amdahl fixtures', () => {
  it.each([
    ['AMDAHL-1', 0.25, [1.0000, 1.6000, 2.2857, 2.9091, 3.3684, 3.6571]],
    ['AMDAHL-1b', 0.10, [1.0000, 1.8182, 3.0769, 4.7059, 6.4000, 7.8049]],
    ['AMDAHL-1c', 0.50, [1.0000, 1.3333, 1.6000, 1.7778, 1.8824, 1.9394]],
  ] as const)('%s', (_name, serial, expected) => {
    CORES.forEach((cores, index) => {
      const value = expected[index];
      if (value === undefined) throw new Error('missing numeric fixture');
      expect(Math.abs(amdahlSpeedup(serial, cores) - value)).toBeLessThanOrEqual(1e-4);
    });
  });

  it('AMDAHL-2: useful work uses ceil and creation debt is charged after speedup', () => {
    const actual = CORES.map(cores => {
      const { manager, pcb } = fixture('one_to_one', cores, cores, 2);
      manager.recompute(pcb);
      expect(pcb.serviceRemaining).toBe(pcb.cpuBurstRemaining);
      return pcb.cpuBurstRemaining;
    });
    expect(actual).toEqual([102, 67, 52, 51, 62, 92]);
  });

  it('AMDAHL-3: a fully serial program cannot gain speedup', () => {
    expect(amdahlSpeedup(1.0, 1024)).toBe(1);
  });

  it('amdahl guards', () => {
    expect(() => amdahlSpeedup(-0.1, 4)).toThrow(RangeError);
    expect(() => amdahlSpeedup(0.5, 0)).toThrow(RangeError);
    expect(() => amdahlSpeedup(0.5, 2.5)).toThrow(RangeError);
    expect(() => amdahlSpeedup(Number.NaN, 4)).toThrow(RangeError);
    expect(() => amdahlSpeedup(1.1, 4)).toThrow(RangeError);
  });
});

describe('sim spec 16.4: thread models', () => {
  it('THREAD-M1: a blocked user thread stalls all four threads', () => {
    const { manager, pcb, thread } = fixture('many_to_one', 4);
    const reason = { kind: 'sleep', untilTick: asTick(10) } as const;
    expect(manager.block(pcb, thread(0).tid, reason)).toBe(true);
    const delivered: Tid[] = [];
    for (let tick = 0; tick < 3; tick++) {
      expect(manager.deliver(pcb, current => {
        delivered.push(current.tid);
        return true;
      })).toBeNull();
    }
    expect(delivered).toEqual([]);
    expect(manager.effectiveCores(pcb)).toBe(1);
    expect(pcb.threads.map(tid => manager.table.get(tid)?.lwp)).toEqual([null, null, null, null]);
  });

  it('THREAD-11: the other three threads remain runnable', () => {
    const { manager, pcb, cfg, thread } = fixture('one_to_one', 4);
    expect(usableCores(manager.runnable(pcb).length, cfg)).toBe(4);
    expect(manager.block(pcb, thread(0).tid, { kind: 'sleep', untilTick: asTick(10) })).toBe(false);
    expect(pcb.state).toBe('ready');
    expect(usableCores(manager.runnable(pcb).length, cfg)).toBe(3);
    const delivered = manager.deliver(pcb, () => true);
    expect(delivered).not.toBeNull();
    expect(delivered).not.toBe(thread(0).tid);
    expect(pcb.threads.every(tid => manager.table.get(tid)?.lwp === tid)).toBe(true);
  });

  it('THREAD-MM: eight threads map to four LWPs in ascending tid order', () => {
    const { manager, pcb, cfg } = fixture('many_to_many', 8);
    expect(usableCores(manager.runnable(pcb).length, cfg)).toBe(4);
    expect(pcb.threads.map(tid => manager.table.get(tid)?.lwp)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });

  it('a blocked LWP stalls its users while other LWPs continue', () => {
    const { manager, pcb, thread } = fixture('many_to_many', 8);
    expect(manager.block(pcb, thread(0).tid, { kind: 'sleep', untilTick: asTick(10) })).toBe(false);
    expect(manager.runnable(pcb).map(current => current.tid)).not.toContain(thread(4).tid);
    expect(manager.effectiveCores(pcb)).toBe(3);
    expect(manager.deliver(pcb, () => true)).not.toBeNull();
    expect(manager.wake(pcb, thread(0).tid)).toBe(true);
    expect(manager.effectiveCores(pcb)).toBe(4);
  });

  it('lwp assignment is pure for the same tids in different input orders', () => {
    const { pcb, cfg } = fixture('many_to_many', 8);
    const before = [...pcb.threads];
    expect([...assignLwps(pcb.threads, cfg)]).toEqual([...assignLwps([...pcb.threads].reverse(), cfg)]);
    expect(pcb.threads).toEqual(before);
  });

  it('honours an explicit LWP binding through thread-set changes', () => {
    const { manager, pcb, thread } = fixture('many_to_many', 4);
    const result = manager.create(pcb, thread(0).tid, { lwp: 9 });
    expect(result.ok).toBe(true);
    const bound = thread(4);
    expect(bound.lwp).toBe(9);
    manager.create(pcb, thread(0).tid);
    manager.join(pcb, thread(1).tid, thread(0).tid);
    expect(manager.table.get(bound.tid)?.lwp).toBe(9);
  });

  it('many-to-one keeps delivering to the first thread until it blocks or finishes', () => {
    const { manager, pcb, thread } = fixture('many_to_one', 4);
    const first = thread(0).tid;
    expect(manager.deliver(pcb, () => true)).toBe(first);
    expect(manager.deliver(pcb, () => true)).toBe(first);
    expect(thread(0).programCounter).toBe(2);
    expect(thread(1).programCounter).toBe(0);
  });
});

describe('thread lifecycle and service accounting', () => {
  it('thread cap: the seventeenth thread returns EAGAIN without charging work', () => {
    const { manager, pcb, work, events } = fixture('one_to_one', 16);
    const original = { ...work };
    expect(manager.create(pcb)).toMatchObject({ ok: false, errno: 'EAGAIN' });
    expect(pcb.threads).toHaveLength(16);
    expect(work).toEqual(original);
    expect(events).toEqual([]);
  });

  it('thread creation adds debt without inflating useful raw service', () => {
    const { manager, pcb, work, cfg, events } = fixture('one_to_one', 1, 4, 2);
    const originalRaw = work.rawService;
    expect(manager.create(pcb).ok).toBe(true);
    expect(work.rawService).toBe(originalRaw);
    expect(pcb.serviceRemaining).toBe(Math.ceil(originalRaw / amdahlSpeedup(work.serialFraction, 2))
      + cfg.threadCreateTicks * pcb.threads.length);
    expect(events).toEqual([{ type: 'thread.created', pid: pcb.pid, tid: pcb.threads[1] }]);
  });

  it('joining folds the remaining service into its joiner', () => {
    const { manager, pcb, thread, events } = fixture('many_to_one', 4);
    const joined = thread(1);
    const joiner = thread(0);
    const expected = joined.serviceRemaining + joiner.serviceRemaining;
    expect(manager.join(pcb, joined.tid, joiner.tid).ok).toBe(true);
    expect(joiner.serviceRemaining).toBe(expected);
    expect(pcb.threads).not.toContain(joined.tid);
    expect(manager.table.has(joined.tid)).toBe(false);
    expect(events).toEqual([{ type: 'thread.joined', pid: pcb.pid, tid: joined.tid }]);
  });

  it('empty threads exits: joining the final thread requests exit code zero', () => {
    const { manager, pcb, thread, exitRequests } = fixture();
    expect(manager.join(pcb, thread(0).tid).ok).toBe(true);
    expect(pcb.threads).toEqual([]);
    expect(manager.table.size).toBe(0);
    expect(exitRequests).toEqual([{ pid: pcb.pid, code: 0 }]);
  });

  it('thread ids never repeat after joins or process cleanup', () => {
    const { manager, pcb, thread } = fixture();
    const original = thread(0).tid;
    manager.clear(pcb);
    manager.attach(pcb);
    expect(thread(0).tid).toBeGreaterThan(original);
    expect(manager.table.has(original)).toBe(false);
  });

  it('service stays integral and conserved through create, delivery, recomputation and join', () => {
    const { manager, pcb, work, thread } = fixture('one_to_one', 4);
    const verify = () => {
      const services = pcb.threads.map(tid => manager.table.get(tid)?.serviceRemaining ?? 0);
      expect(services.reduce((sum, service) => sum + service, 0)).toBe(pcb.serviceRemaining);
      expect(services.every(Number.isInteger)).toBe(true);
      expect(Number.isInteger(work.rawService)).toBe(true);
      expect(Number.isInteger(work.rawBurst)).toBe(true);
    };
    manager.recompute(pcb);
    verify();
    manager.create(pcb, thread(0).tid);
    verify();
    manager.deliver(pcb, () => true);
    verify();
    manager.recompute(pcb);
    verify();
    manager.join(pcb, thread(1).tid, thread(0).tid);
    verify();
  });

  it('a fault charges the tick but leaves the selected program counter unchanged', () => {
    const { manager, pcb, thread } = fixture();
    const initialService = pcb.serviceRemaining;
    manager.deliver(pcb, () => false);
    expect(pcb.totalCpuUsed).toBe(1);
    expect(pcb.serviceRemaining).toBe(initialService - 1);
    expect(thread(0).programCounter).toBe(0);
  });

  it('exec can replace the thread set inside instruction delivery', () => {
    const { manager, pcb, thread } = fixture();
    const old = thread(0).tid;
    manager.deliver(pcb, () => {
      manager.clear(pcb);
      manager.attach(pcb);
      return false;
    });
    expect(manager.table.has(old)).toBe(false);
    expect(thread(0).programCounter).toBe(0);
  });
});

it('invalid explicit LWP creation leaves service and the thread set unchanged', () => {
  const { manager, pcb, thread } = fixture(); const before = { ...thread(0) }; const ids = [...pcb.threads];
  expect(() => manager.create(pcb, thread(0).tid, { lwp: -1 })).toThrow(RangeError);
  expect(thread(0)).toEqual(before); expect(pcb.threads).toEqual(ids);
});
