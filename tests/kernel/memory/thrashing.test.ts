import { describe, expect, it } from 'vitest';
import { ThrashingController, nextFaultAccumulator } from '@kernel/memory/thrashing';
import type { Suspension, ThrashingInput, ThrashingSettings } from '@kernel/memory/thrashing';
import { DEFAULT_TUNING } from '@kernel/config';
import { asPageId, asPid, asTick } from '@kernel/types';
import type { Pid, Tid } from '@kernel/types';

function fixture(pids: readonly number[] = [2, 3, 4, 5], overrides: Partial<ThrashingSettings> = {}, totalFrames = 64, degree = 16) {
  const events: (readonly [string, number, number?])[] = [];
  const resumed: Suspension[] = [];
  const terminated = new Set<Pid>();
  let allowResize = true;
  const controller = new ThrashingController({ ...DEFAULT_TUNING, thrashingThreshold: 200, ...overrides }, totalFrames, degree, {
    suspend: (pid, tick, untilTick) => {
      events.push(['suspend', pid, tick]);
      return {
        pid, suspendedAt: tick, untilTick, previousState: 'ready', previousBlockedOn: null,
        threads: [
          { tid: (pid * 10) as Tid, state: 'ready', blockedOn: null },
          { tid: (pid * 10 + 1) as Tid, state: 'waiting', blockedOn: { kind: 'page_fault', page: asPageId(7) } },
        ],
      };
    },
    resume: saved => { events.push(['resume', saved.pid]); resumed.push(saved); },
    terminate: pid => { events.push(['terminate', pid]); terminated.add(pid); },
    emit: (severity, rate) => { events.push([severity, rate]); },
    panic: pid => { events.push(['panic', pid]); },
    resizeBudget: (pid, budget) => { events.push(['budget', pid, budget]); return allowResize; },
  });
  for (const pid of pids) controller.admit(asPid(pid), asTick(0), Math.min(8, totalFrames));
  const input = (sizes: readonly number[] = pids.map(() => 0), faultRate = 0, freeFrames = 64): ThrashingInput => ({
    workingSets: new Map(pids.map((pid, index) => [asPid(pid), sizes[index] ?? 0])), faultRate,
    activePids: pids.map(asPid).filter(pid => !terminated.has(pid)), freeFrames,
  });
  return { controller, events, resumed, input, setAllowResize: (value: boolean) => { allowResize = value; } };
}

describe('integer fault EWMA', () => {
  it('stays integral for 5000 updates and reaches the eight-fault steady-state rate 8000', () => {
    let accumulator = 0;
    for (let tick = 0; tick < 5000; tick += 1) {
      accumulator = nextFaultAccumulator(accumulator, 8);
      expect(Number.isInteger(accumulator)).toBe(true);
    }
    expect(accumulator).toBe(64); expect(accumulator * 1000 / 8).toBe(8000);
  });
  it('clamps the zero-input tail instead of getting stuck at seven and 875 faults per thousand ticks', () => {
    let accumulator = 64;
    const history: number[] = [];
    for (let tick = 0; tick < 100; tick += 1) { accumulator = nextFaultAccumulator(accumulator, 0); history.push(accumulator); }
    expect(history.slice(0, 5)).toEqual([56, 49, 43, 38, 34]);
    expect(accumulator).toBe(0); expect(history).not.toContain(7);
    expect(nextFaultAccumulator(7, 1)).toBe(8);
  });
  it('continues the same integer trace from a serialized accumulator', () => {
    let live = 0;
    for (let tick = 0; tick < 35; tick += 1) live = nextFaultAccumulator(live, tick % 7);
    let restored: number = JSON.parse(JSON.stringify(live));
    for (let tick = 35; tick < 5000; tick += 1) {
      live = nextFaultAccumulator(live, tick % 9); restored = nextFaultAccumulator(restored, tick % 9);
      expect(restored).toBe(live);
    }
    expect(() => nextFaultAccumulator(-1, 0)).toThrow();
    expect(() => nextFaultAccumulator(0, 0.5)).toThrow();
  });
});

describe('thrashing severity and process control', () => {
  it('VM-THRASH-1: D=70 with 64 frames warns and vetoes admission; D=64 stays healthy', () => {
    const test = fixture([2, 3, 4, 5, 6, 7, 8]);
    test.controller.update(asTick(1), test.input([10, 10, 10, 10, 10, 10, 10]));
    expect(test.controller.severity).toBe('warning'); expect(test.controller.admissionAllowed()).toBe(false);
    expect(test.events).toEqual([['warning', 0]]);
    test.controller.update(asTick(2), test.input([10, 10, 10, 10, 10, 10, 4]));
    expect(test.controller.severity).toBe('healthy'); expect(test.controller.admissionAllowed()).toBe(true);
  });
  it('VM-THRASH-1: D=100 is critical and suspends the highest PID among equal largest working sets', () => {
    const test = fixture([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    test.controller.update(asTick(1), test.input(Array(10).fill(10)));
    expect(test.events).toEqual([['critical', 0], ['suspend', 11, 1]]);
    expect(test.controller.suspendedRecords[0]?.untilTick).toBe(101);
    test.controller.update(asTick(2), test.input(Array(10).fill(10)));
    expect(test.controller.severity).toBe('warning');
  });
  it('selects by true working set before PID and excludes other process states from demand', () => {
    const test = fixture([2, 3, 4]);
    const input = test.input([50, 60, 50]);
    test.controller.update(asTick(0), input);
    expect(test.controller.suspendedRecords.map(record => record.pid)).toEqual([3]);
    test.controller.update(asTick(1), {
      ...test.input([0, 1000, 0]),
      workingSets: new Map([[asPid(0), 1000], [asPid(1), 1000], [asPid(2), 0], [asPid(3), 1000], [asPid(4), 0], [asPid(9), 1000]]),
    });
    expect(test.controller.severity).toBe('healthy');
  });
  it('uses both inclusive fault thresholds and the strict demand critical threshold', () => {
    const test = fixture([2, 3]);
    test.controller.update(asTick(1), test.input([48, 48], 199));
    expect(test.controller.severity).toBe('warning'); expect(test.controller.suspendedRecords).toEqual([]);
    test.controller.update(asTick(2), test.input([0, 0], 200)); expect(test.controller.severity).toBe('warning');
    test.controller.update(asTick(3), test.input([0, 0], 399)); expect(test.controller.severity).toBe('warning');
    test.controller.update(asTick(4), test.input([0, 0], 400)); expect(test.controller.severity).toBe('critical');
  });
  it('escalates once every 50 ticks and terminates the final process with a collapse panic', () => {
    const test = fixture();
    for (let tick = 0; tick <= 100; tick += 1) test.controller.update(asTick(tick), test.input([10, 10, 10, 10], 400));
    expect(test.events.filter(event => event[0] === 'suspend')).toEqual([['suspend', 5, 0], ['suspend', 4, 50], ['suspend', 3, 100]]);
    expect(test.events.filter(event => ['terminate', 'panic'].includes(event[0]))).toEqual([['terminate', 2], ['panic', 2]]);
  });
  it('does not collapse a single remaining process on demand alone', () => {
    const test = fixture([2, 3]);
    test.controller.update(asTick(0), test.input([100, 100]));
    test.controller.update(asTick(50), test.input([100, 100]));
    expect(test.events.filter(event => ['terminate', 'panic'].includes(event[0]))).toEqual([]);
  });
  it('requires 100 consecutive healthy ticks and preserves prior waits on lowest-PID-first recovery', () => {
    const test = fixture([2, 3, 4]);
    test.controller.setDegree(1, asTick(0), test.input([10, 10, 10]));
    expect(test.controller.admissionAllowed()).toBe(false);
    test.controller.setDegree(3, asTick(0), test.input());
    for (let tick = 1; tick < 100; tick += 1) test.controller.update(asTick(tick), test.input());
    expect(test.resumed).toHaveLength(0);
    test.controller.update(asTick(100), test.input());
    expect(test.resumed.map(record => record.pid)).toEqual([3]);
    expect(test.resumed[0]?.threads[1]?.blockedOn).toEqual({ kind: 'page_fault', page: 7 });
    for (let tick = 101; tick < 150; tick += 1) test.controller.update(asTick(tick), test.input());
    expect(test.resumed).toHaveLength(1);
    test.controller.update(asTick(150), test.input()); expect(test.resumed.map(record => record.pid)).toEqual([3, 4]);
  });
  it('restarts the healthy observation period after warning and honors minimum suspension time', () => {
    const test = fixture([2, 3], { thrashingSuspendDuration: 200 });
    test.controller.update(asTick(0), test.input([50, 50]));
    for (let tick = 1; tick < 100; tick += 1) test.controller.update(asTick(tick), test.input());
    test.controller.update(asTick(100), test.input([], 200));
    for (let tick = 101; tick < 200; tick += 1) test.controller.update(asTick(tick), test.input());
    expect(test.resumed).toHaveLength(0);
    test.controller.update(asTick(200), test.input()); expect(test.resumed.map(record => record.pid)).toEqual([3]);
  });
  it('lowers the active degree with largest-first suspensions and cannot exceed the immutable ceiling', () => {
    const test = fixture([2, 3, 4, 5], {}, 64, 4);
    test.controller.setDegree(2, asTick(3), test.input([1, 4, 2, 3]));
    expect(test.events).toEqual([['suspend', 3, 3], ['suspend', 5, 3]]);
    expect(test.controller.degreeOfMultiprogramming).toBe(2);
    expect(test.controller.admissionAllowed(2)).toBe(false);
    expect(test.controller.admissionAllowed(1)).toBe(true);
    expect(() => test.controller.setDegree(5, asTick(3), test.input())).toThrow('ceiling');
    for (let tick = 4; tick <= 200; tick += 1) test.controller.update(asTick(tick), test.input());
    expect(test.resumed).toEqual([]);
  });
  it('enforces a restored lower target when a later unchanged phase-5 batch crosses it from below', () => {
    const test = fixture([2, 3, 4], {}, 64, 4);
    test.controller.setDegree(2, asTick(0), { ...test.input(), activePids: [asPid(2)] });
    expect(test.controller.admissionAllowed(1)).toBe(true);
    const restored = fixture([2, 3, 4], {}, 64, 4);
    restored.controller.prepareRestore(JSON.parse(JSON.stringify(test.controller.saveState())))();
    restored.controller.update(asTick(1), restored.input([1, 3, 2]));
    expect(restored.controller.suspendedRecords.map(record => record.pid)).toEqual([3]);
    expect(restored.controller.admissionAllowed()).toBe(false);
  });
});

describe('page-fault-frequency budgets', () => {
  it('accepts a recomputed rations quota only within the existing frame-budget limits', () => {
    const test = fixture([2]);
    test.controller.setFrameBudget(asPid(2), 12);
    expect(test.controller.frameBudget(asPid(2))).toBe(12);
    expect(test.events).toEqual([]);
    expect(() => test.controller.setFrameBudget(asPid(2), 2)).toThrow();
    expect(() => test.controller.setFrameBudget(asPid(2), 65)).toThrow();
    expect(() => test.controller.setFrameBudget(asPid(3), 3)).toThrow('admission');
  });
  it('grants one frame above the upper bound at each control interval and expires the 1000-tick window', () => {
    const test = fixture([2], { thrashingControl: 'pff' });
    test.controller.recordFault(asPid(2), asTick(1), 301);
    test.controller.update(asTick(49), test.input([], 0, 2)); expect(test.controller.frameBudget(asPid(2))).toBe(8);
    test.controller.update(asTick(50), test.input([], 0, 2)); expect(test.controller.frameBudget(asPid(2))).toBe(9);
    test.controller.update(asTick(51), test.input([], 0, 1)); expect(test.controller.frameBudget(asPid(2))).toBe(9);
    test.controller.update(asTick(100), test.input([], 0, 1)); expect(test.controller.frameBudget(asPid(2))).toBe(10);
    expect(test.controller.faultRate(asPid(2), asTick(1000))).toBe(301);
    expect(test.controller.faultRate(asPid(2), asTick(1001))).toBe(0);
    test.controller.update(asTick(1001), test.input()); expect(test.controller.frameBudget(asPid(2))).toBe(9);
  });
  it('preserves exact bound equality, coalesces faults within a tick, and reduces to the minimum', () => {
    const test = fixture([2, 3], { thrashingControl: 'pff' });
    test.controller.recordFault(asPid(2), asTick(1), 100); test.controller.recordFault(asPid(2), asTick(1), 200);
    test.controller.recordFault(asPid(3), asTick(1), 50);
    test.controller.update(asTick(50), test.input());
    expect(test.controller.frameBudget(asPid(2))).toBe(8); expect(test.controller.frameBudget(asPid(3))).toBe(8);
    expect(test.controller.saveState().pff[0]?.faultTicks).toEqual([[1, 300]]);
    for (let tick = 1050; tick <= 2000; tick += 50) test.controller.update(asTick(tick), test.input());
    expect(test.controller.frameBudget(asPid(2))).toBe(3); expect(test.controller.frameBudget(asPid(3))).toBe(3);
  });
  it('suspends the largest working set when a high-rate process cannot receive a free frame', () => {
    const test = fixture([2, 3], { thrashingControl: 'pff' });
    test.controller.recordFault(asPid(2), asTick(1), 301);
    test.controller.update(asTick(50), test.input([3, 4], 0, 0));
    expect(test.controller.suspendedRecords.map(record => record.pid)).toEqual([3]);
    expect(test.controller.frameBudget(asPid(2))).toBe(8);
  });
  it('does not lend one available frame twice and honors pinned-frame release refusal', () => {
    const test = fixture([2, 3], { thrashingControl: 'pff' });
    for (const pid of [2, 3].map(asPid)) test.controller.recordFault(pid, asTick(1), 301);
    test.controller.update(asTick(50), test.input([1, 2], 0, 1));
    expect(test.controller.frameBudget(asPid(2))).toBe(9); expect(test.controller.frameBudget(asPid(3))).toBe(8);
    expect(test.controller.isSuspended(asPid(3))).toBe(true);
    test.setAllowResize(false);
    test.controller.update(asTick(1100), test.input()); expect(test.controller.frameBudget(asPid(2))).toBe(9);
  });
  it('caps the minimum at the actual frame capacity for tiny memories', () => {
    const test = fixture([2], { thrashingControl: 'pff' }, 2);
    for (let tick = 50; tick <= 1000; tick += 50) test.controller.update(asTick(tick), test.input());
    expect(test.controller.frameBudget(asPid(2))).toBe(2);
  });
});

describe('control snapshot continuation', () => {
  it('round-trips suspension membership, prior thread waits, PFF windows and recovery clocks', () => {
    const live = fixture([2, 3, 4]);
    live.controller.setDegree(1, asTick(0), live.input([10, 10, 10]));
    live.controller.setDegree(3, asTick(0), live.input());
    live.controller.recordFault(asPid(2), asTick(5), 2);
    for (let tick = 1; tick <= 75; tick += 1) live.controller.update(asTick(tick), live.input());
    const saved = JSON.parse(JSON.stringify(live.controller.saveState()));
    const replay = fixture([2, 3, 4]);
    replay.controller.prepareRestore(saved)(); expect(replay.events).toEqual([]);
    expect(replay.controller.isSuspended(asPid(3))).toBe(true);
    expect(replay.controller.suspendedRecords).toEqual(live.controller.suspendedRecords);
    live.events.length = 0;
    for (let tick = 76; tick <= 200; tick += 1) {
      live.controller.update(asTick(tick), live.input()); replay.controller.update(asTick(tick), replay.input());
      expect(replay.controller.saveState()).toEqual(live.controller.saveState());
    }
    expect(replay.events).toEqual(live.events); expect(replay.resumed).toEqual(live.resumed);
  });
  it('rejects malformed suspension and PFF state before changing any live control state', () => {
    const test = fixture([2, 3]);
    test.controller.setDegree(1, asTick(0), test.input());
    const before = test.controller.saveState();
    const suspended = before.suspended[0]!;
    for (const invalid of [
      { ...before, severity: 'unknown' },
      { ...before, degreeOfMultiprogramming: 100 },
      { ...before, suspended: [{ ...suspended, untilTick: 4 }] },
      { ...before, suspended: [{ ...suspended, previousState: 'ready', previousBlockedOn: { kind: 'sleep', untilTick: 2 } }] },
      { ...before, suspended: [{ ...suspended, threads: [{ tid: 30, state: 'waiting', blockedOn: null }] }] },
      { ...before, pff: [] },
      { ...before, pff: [{ ...before.pff[0], faultTicks: [[2, 1], [2, 1]] }] },
    ]) {
      expect(() => test.controller.prepareRestore(invalid)).toThrow(); expect(test.controller.saveState()).toEqual(before);
    }
    test.controller.remove(asPid(3)); expect(test.controller.isSuspended(asPid(3))).toBe(false);
    expect(before.suspended).toHaveLength(1);
  });
});
