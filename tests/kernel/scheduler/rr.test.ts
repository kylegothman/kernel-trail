import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createKernel } from '@kernel/Kernel';
import { KernelInvariantError } from '@kernel/errors';
import { CircularQueue } from '@kernel/scheduler/CircularQueue';
import { RR_PACE_QUANTA } from '@kernel/scheduler/rr';
import { asPid } from '@kernel/types';
import type { SchedulerId } from '@kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import { createWorkloadKernel, runWorkload, type WorkloadRow } from './workloadRunner';

const TEXTBOOK: readonly WorkloadRow[] = [
  { name: 'P1', arrival: 0, burst: 24 },
  { name: 'P2', arrival: 0, burst: 3 },
  { name: 'P3', arrival: 0, burst: 3 },
];

describe('round robin textbook behavior', () => {
  it('SCHED-RR-1: q=4 reproduces the textbook chart, exact means and counts', () => {
    const result = runWorkload('rr', { quantum: 4 }, TEXTBOOK);
    expect(result.gantt).toBe('P1[0-4] P2[4-7] P3[7-10] P1[10-30]');
    expect(result.averages.waiting).toBeCloseTo(17 / 3, 9);
    expect(result.averages.turnaround).toBeCloseTo(47 / 3, 9);
    expect(result.averages.response).toBeCloseTo(11 / 3, 9);
    expect(result.dispatches).toBe(4);
    expect(result.quantumExpiries).toBe(5);
    expect(result.perProcess).toEqual(new Map([
      ['P1', { waiting: 6, turnaround: 30, response: 0 }],
      ['P2', { waiting: 4, turnaround: 7, response: 4 }],
      ['P3', { waiting: 7, turnaround: 10, response: 7 }],
    ]));
  });

  it('emits P1 quantum expiry exactly at boundaries 4, 14, 18, 22 and 26 at level 0', () => {
    const { kernel, pids } = createWorkloadKernel('rr', { quantum: 4 }, TEXTBOOK);
    const expiry = kernel.run(30).filter(event => event.type === 'quantum.expired');
    expect(expiry.map(event => ({ tick: event.tick - 1, pid: event.pid, level: event.level })))
      .toEqual([4, 14, 18, 22, 26].map(tick => ({ tick, pid: pids.get('P1'), level: 0 })));
  });

  it('SCHED-RR-2a: q=1 gives the textbook response and ten dispatches', () => {
    const result = runWorkload('rr', { quantum: 1 }, TEXTBOOK);
    expect(result.averages.waiting).toBeCloseTo(17 / 3, 9);
    expect(result.averages.turnaround).toBeCloseTo(47 / 3, 9);
    expect(result.averages.response).toBeCloseTo(1, 9);
    expect(result.dispatches).toBe(10);
  });

  it('SCHED-RR-2c: q=24 equals FCFS exactly', () => {
    const result = runWorkload('rr', { quantum: 24 }, TEXTBOOK);
    expect(result.averages).toEqual({ waiting: 17, turnaround: 27, response: 17 });
    expect(result.dispatches).toBe(3);
    expect(result.gantt).toBe(runWorkload('fcfs', {}, TEXTBOOK).gantt);
  });

  it('enqueues a same-tick phase-5 arrival ahead of the phase-7 outgoing process', () => {
    const { kernel, pids } = createWorkloadKernel('rr', { quantum: 4 }, [
      { name: 'outgoing', arrival: 0, burst: 8 },
      { name: 'arrival', arrival: 4, burst: 1 },
    ]);
    kernel.run(4);
    const events = kernel.step();
    expect(events.filter(event => event.type === 'context.switch')).toMatchObject([{ to: pids.get('arrival') }]);
    expect(kernel.process(pids.get('outgoing')!)?.totalCpuUsed).toBe(4);
    expect(kernel.process(pids.get('arrival')!)?.totalCpuUsed).toBe(1);
  });

  it('preempts at >= quantum after exactly four executed ticks, not one tick later', () => {
    const { kernel, pids } = createWorkloadKernel('rr', { quantum: 4 }, [
      { name: 'first', arrival: 0, burst: 8 }, { name: 'second', arrival: 0, burst: 8 },
    ]);
    expect(kernel.run(4).filter(event => event.type === 'quantum.expired')).toEqual([]);
    expect(kernel.process(pids.get('first')!)?.totalCpuUsed).toBe(4);
    const fifth = kernel.step();
    expect(fifth.filter(event => event.type === 'quantum.expired')).toHaveLength(1);
    expect(kernel.process(pids.get('first')!)?.totalCpuUsed).toBe(4);
    expect(kernel.process(pids.get('second')!)?.totalCpuUsed).toBe(1);
  });

  it.each([2, 7, 100])('renews a lone process every %i CPU ticks without extra dispatches', quantum => {
    const result = runWorkload('rr', { quantum }, [{ name: 'alone', arrival: 0, burst: quantum * 3 + 1 }]);
    expect(result.events.filter(event => event.type === 'quantum.expired').map(event => event.tick - 1))
      .toEqual([quantum, 2 * quantum, 3 * quantum]);
    expect(result.dispatches).toBe(1);
    expect(result.gantt).toBe(`alone[0-${quantum * 3 + 1}]`);
  });

  it('exports the frozen pace mapping for downstream callers', () => {
    expect(RR_PACE_QUANTA).toEqual({ conservative: 16, steady: 8, aggressive: 4, reckless: 1 });
    expect(Object.isFrozen(RR_PACE_QUANTA)).toBe(true);
  });
});

describe('bounded circular scheduler queue', () => {
  it('preserves FIFO order, membership and removal across buffer wraparound', () => {
    const queue = new CircularQueue(3);
    expect(queue.peek()).toBeNull();
    expect(queue.dequeue()).toBeNull();
    for (const pid of [2, 3, 4]) queue.enqueue(asPid(pid));
    expect(queue.dequeue()).toBe(asPid(2));
    queue.enqueue(asPid(5));
    expect(queue.toArray()).toEqual([3, 4, 5]);
    expect(queue.size).toBe(3);
    expect(queue.contains(asPid(2))).toBe(false);
    expect(queue.contains(asPid(4))).toBe(true);
    expect(queue.remove(asPid(4))).toBe(true);
    expect(queue.remove(asPid(4))).toBe(false);
    expect(queue.toArray()).toEqual([3, 5]);
    expect(queue.dequeue()).toBe(asPid(3));
    expect(queue.dequeue()).toBe(asPid(5));
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeNull();
  });

  it('reuses one toArray backing object while resizing it', () => {
    const queue = new CircularQueue(3);
    queue.enqueue(asPid(2)); queue.enqueue(asPid(3));
    const view = queue.toArray();
    queue.dequeue(); queue.enqueue(asPid(4));
    expect(queue.toArray()).toBe(view);
    expect(view).toEqual([3, 4]);
    queue.dequeue(); queue.dequeue();
    expect(queue.toArray()).toBe(view);
    expect(view).toEqual([]);
  });

  it('throws KernelInvariantError before exceeding capacity', () => {
    const queue = new CircularQueue(2);
    queue.enqueue(asPid(2)); queue.enqueue(asPid(3));
    expect(() => queue.enqueue(asPid(4))).toThrow(KernelInvariantError);
    expect(queue.toArray()).toEqual([2, 3]);
    expect(queue.size).toBe(2);
  });

  it('performs 100,000 enqueue/dequeue pairs in under 50 ms without a shifting queue', () => {
    const queue = new CircularQueue(64);
    const pid = asPid(2);
    for (let index = 0; index < 10_000; index++) { queue.enqueue(pid); queue.dequeue(); }
    let checksum = 0;
    const started = performance.now();
    for (let index = 0; index < 100_000; index++) { queue.enqueue(pid); checksum += queue.dequeue() ?? 0; }
    const elapsed = performance.now() - started;
    expect(checksum).toBe(200_000);
    expect(elapsed).toBeLessThan(50);
  });
});

const ALL_POLICIES: readonly SchedulerId[] = ['fcfs', 'sjf', 'srtf', 'priority', 'priority_aging', 'rr', 'mlfq'];
describe('INV-ALL-2 scheduler axis', () => {
  it.each(ALL_POLICIES)('%s runs 2,000 ticks against REFERENCE_CONFIG with real user work', scheduler => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler });
    for (const [index, burst] of [40, 120, 20, 70, 24].entries()) {
      kernel.spawn({ name: `invariant-${index}`, arrival: index === 4 ? 1900 : index * 10,
        burst, service: burst, priority: index + 1, pages: 0 });
    }
    const events = kernel.run(2000);
    expect(kernel.tick).toBe(2000);
    expect(events.filter(event => event.type === 'process.created')).toHaveLength(5);
    expect(events.filter(event => event.type === 'process.exited')).toHaveLength(5);
    expect(events.some(event => event.type === 'kernel.panic')).toBe(false);
  });
});
