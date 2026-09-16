/**
 * WP-L03 acceptance 9, 12, 13 and 14: every `SCHED-*` row of sim spec 16.3,
 * run through this leg's own replay rather than a second implementation, so
 * the machinery `gantt --replay` uses is the machinery the textbook numbers
 * are checked against.
 *
 * Scope correction 17.1: there are thirteen rows, not the fourteen the package
 * names. Scope correction 17.2: `SCHED-RR-2a` is round robin at quantum 1, and
 * the reckless pace is quantum 2, so the row bounds the switch-overhead lesson
 * and does not supply the reckless-pace numbers.
 */
import { describe, expect, it } from 'vitest';
import { renderRibbon, replayArrivalSet, segmentAverages } from '@legs/quantum_pass/replay';
import { SCHED_FIXTURES } from '@legs/quantum_pass/segments';

/** Sim spec 16.3 prints its averages to six decimals, so the comparison is made at the precision the document states. */
const printed = (value: number): number => Number(value.toFixed(6));
const TOLERANCE = 9;

describe('the thirteen scheduler fixtures of sim spec 16.3', () => {
  it('has thirteen rows, not fourteen (scope correction 17.1)', () => {
    expect(SCHED_FIXTURES).toHaveLength(13);
    expect(SCHED_FIXTURES.map((fixture) => fixture.id)).toEqual([
      'SCHED-FCFS-1', 'SCHED-FCFS-2', 'SCHED-SJF-1', 'SCHED-SJF-1F', 'SCHED-SRTF-1', 'SCHED-SRTF-1S',
      'SCHED-PRIO-1', 'SCHED-AGING-1A', 'SCHED-AGING-1B', 'SCHED-RR-1', 'SCHED-RR-2a', 'SCHED-RR-2c', 'SCHED-MLFQ-1',
    ]);
  });

  for (const fixture of SCHED_FIXTURES) {
    describe(fixture.id, () => {
      const run = replayArrivalSet({ rows: fixture.rows, policy: fixture.policy, params: fixture.params });
      const averages = segmentAverages(run, fixture.rows.map((row) => row.name));

      it('reproduces the Gantt chart and the three averages', () => {
        if (fixture.gantt !== null) expect(renderRibbon(run.ribbon)).toBe(fixture.gantt);
        expect(averages).not.toBeNull();
        expect(printed(averages?.waiting ?? NaN)).toBe(fixture.averages.waiting);
        expect(printed(averages?.turnaround ?? NaN)).toBe(fixture.averages.turnaround);
        expect(printed(averages?.response ?? NaN)).toBe(fixture.averages.response);
      });

      if (fixture.dispatches !== undefined) {
        it(`dispatches ${fixture.dispatches} times`, () => {
          expect(run.events.filter((event) => event.type === 'context.switch' && event.to !== null)).toHaveLength(fixture.dispatches ?? 0);
        });
      }

      if (fixture.perProcess !== undefined) {
        it('reproduces the per-process detail table', () => {
          for (const [name, want] of Object.entries(fixture.perProcess ?? {})) {
            const row = run.perProcess.find((candidate) => candidate.name === name);
            expect(row?.waiting, `${name} waiting`).toBe(want.waiting);
            expect(row?.turnaround, `${name} turnaround`).toBe(want.turnaround);
            expect(row?.response, `${name} response`).toBe(want.response);
          }
        });
      }

      if (fixture.finalLevels !== undefined) {
        it('settles each process at its recorded queue level (acceptance 14)', () => {
          for (const [name, level] of Object.entries(fixture.finalLevels ?? {})) {
            expect(run.processes.find((process) => process.name === name)?.queueLevel, name).toBe(level);
          }
        });
      }

      if (fixture.worstWait !== undefined) {
        it('reproduces the worst wait, read as the longest completed waiting time', () => {
          // `SchedulingMetrics.worstWait` is the maximum over currently ready processes and is zero
          // once the workload has drained, so the figure the spec quotes is read from the completions.
          const worst = Math.max(...run.perProcess.map((row) => row.waiting ?? 0));
          expect(worst).toBe(fixture.worstWait);
        });
      }
    });
  }

  it('shortest job first beats arrival order on the comparison set by exactly 3.25 ticks (acceptance 12)', () => {
    const rows = SCHED_FIXTURES.find((fixture) => fixture.id === 'SCHED-SJF-1')?.rows ?? [];
    const names = rows.map((row) => row.name);
    const sjf = segmentAverages(replayArrivalSet({ rows, policy: 'sjf' }), names);
    const fcfs = segmentAverages(replayArrivalSet({ rows, policy: 'fcfs' }), names);
    expect(sjf?.waiting).toBeCloseTo(7, TOLERANCE);
    expect(fcfs?.waiting).toBeCloseTo(10.25, TOLERANCE);
    expect((fcfs?.waiting ?? 0) - (sjf?.waiting ?? 0)).toBeCloseTo(3.25, TOLERANCE);
  });

  it('aging halves the worst wait and costs a little average waiting (acceptance 13)', () => {
    const rows = SCHED_FIXTURES.find((fixture) => fixture.id === 'SCHED-AGING-1A')?.rows ?? [];
    const names = rows.map((row) => row.name);
    const without = replayArrivalSet({ rows, policy: 'priority', params: { preemptive: false, agingInterval: 0 } });
    const withAging = replayArrivalSet({ rows, policy: 'priority_aging', params: { preemptive: false, agingInterval: 2 } });
    const worst = (run: typeof without): number => Math.max(...run.perProcess.map((row) => row.waiting ?? 0));
    expect(worst(without)).toBe(16);
    expect(worst(withAging)).toBe(8);
    expect(segmentAverages(without, names)?.waiting).toBeCloseTo(3.2, TOLERANCE);
    expect(segmentAverages(withAging, names)?.waiting).toBeCloseTo(3.6, TOLERANCE);
    // Both directions: the worst case halves and the average rises. That trade is the whole lesson.
    expect(worst(withAging)).toBeLessThan(worst(without));
    expect(segmentAverages(withAging, names)?.waiting ?? 0).toBeGreaterThan(segmentAverages(without, names)?.waiting ?? 0);
  });

  it('round robin at a quantum above the longest burst is first come first served exactly', () => {
    const rows = SCHED_FIXTURES.find((fixture) => fixture.id === 'SCHED-RR-1')?.rows ?? [];
    expect(renderRibbon(replayArrivalSet({ rows, policy: 'rr', params: { quantum: 24 } }).ribbon))
      .toBe(renderRibbon(replayArrivalSet({ rows, policy: 'fcfs' }).ribbon));
  });

  it('round robin at quantum 1 buys response time and changes no waiting time (scope correction 17.2)', () => {
    const rows = SCHED_FIXTURES.find((fixture) => fixture.id === 'SCHED-RR-1')?.rows ?? [];
    const names = rows.map((row) => row.name);
    const fine = replayArrivalSet({ rows, policy: 'rr', params: { quantum: 1 } });
    const coarse = replayArrivalSet({ rows, policy: 'rr', params: { quantum: 4 } });
    expect(segmentAverages(fine, names)?.waiting).toBeCloseTo(segmentAverages(coarse, names)?.waiting ?? 0, TOLERANCE);
    expect(segmentAverages(fine, names)?.response).toBeCloseTo(1, TOLERANCE);
    expect(printed(segmentAverages(coarse, names)?.response ?? NaN)).toBe(3.666667);
    expect(fine.events.filter((event) => event.type === 'context.switch' && event.to !== null)).toHaveLength(10);
  });
});
