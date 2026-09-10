/**
 * Fixtures SCHED-FCFS-1 and SCHED-FCFS-2 from sim spec 16.3, plus the
 * tie-break rule of sim spec 5.1 and 5.2.
 *
 * The kernel's phases 1 to 10 are not implemented yet, so this file drives the
 * policy through a minimal harness that reproduces exactly the three phases a
 * pure-CPU workload touches: phase 5 (admit), phase 7 (schedule), phase 8
 * (execute one tick). Everything else is a no-op for a workload with no I/O, no
 * memory pressure and no synchronisation, which is precisely the workload the
 * textbook example uses.
 *
 * Metric definitions, sim spec 5.1, for arrival a, total service b, first
 * dispatch f and completion c:
 *
 *     turnaround = c - a
 *     waiting    = turnaround - b
 *     response   = f - a
 */

import { describe, expect, it } from 'vitest';
import { FcfsScheduler } from '@kernel/scheduler/FCFS';
import { createRng } from '@kernel/rng';
import { DEFAULT_SCHEDULER_PARAMS } from '@kernel/scheduler/SchedulerRegistry';
import { asPid, asTick } from '@kernel/types';
import type {
  KernelEvent,
  Pid,
  ProcessControlBlock,
  SchedulerContext,
  Tick,
} from '@kernel/types';

/* ------------------------------------------------------------------ */
/* The harness                                                         */
/* ------------------------------------------------------------------ */

interface JobSpec {
  /** Display label from the textbook. Not necessarily the pid. */
  readonly label: string;
  readonly arrival: number;
  readonly burst: number;
}

interface JobResult {
  readonly label: string;
  readonly pid: Pid;
  readonly firstRun: number;
  readonly completion: number;
  readonly waiting: number;
  readonly turnaround: number;
  readonly response: number;
}

interface RunResult {
  /** `label[start-end]` per contiguous run, in dispatch order. */
  readonly gantt: readonly string[];
  readonly jobs: readonly JobResult[];
  readonly averageWaitingTime: number;
  readonly averageTurnaroundTime: number;
  readonly averageResponseTime: number;
  readonly contextSwitches: number;
  readonly rationales: readonly string[];
}

function makePcb(pid: Pid, spec: JobSpec): ProcessControlBlock {
  return {
    pid,
    parent: null,
    name: spec.label,
    state: 'new',
    priority: 20,
    basePriority: 20,
    arrivalTick: asTick(spec.arrival),
    cpuBurstRemaining: spec.burst,
    serviceRemaining: spec.burst,
    totalCpuUsed: 0,
    readySince: null,
    lastScheduledTick: null,
    queueLevel: 0,
    addressSpaceId: pid as unknown as ProcessControlBlock['addressSpaceId'],
    threads: [],
    openFiles: [],
    heldResources: [],
    requestedResources: [],
    blockedOn: null,
    domain: 'domain:user' as ProcessControlBlock['domain'],
    exitCode: null,
    terminationReason: null,
    convoyMemberId: null,
  };
}

/**
 * `jobs` is given in SUBMISSION order, and pids are allocated in that order.
 * That is the reconciliation between the tie-break rule and fixture
 * SCHED-FCFS-2: the universal tie-break of sim spec 5.1 falls back to lower
 * pid, and because the kernel allocates pids in submission order, the fallback
 * reproduces submission order exactly rather than overriding it.
 */
function runFcfs(jobs: readonly JobSpec[], maxTicks = 1000): RunResult {
  const policy = new FcfsScheduler();
  policy.configure(DEFAULT_SCHEDULER_PARAMS);

  const rng = createRng(1, 'scheduler');
  const table = new Map<Pid, ProcessControlBlock>();
  const specs = new Map<Pid, JobSpec>();
  const order: Pid[] = [];

  jobs.forEach((spec, index) => {
    const pid = asPid(index + 1);
    table.set(pid, makePcb(pid, spec));
    specs.set(pid, spec);
    order.push(pid);
  });

  let running: Pid | null = null;
  let sliceElapsed = 0;
  let contextSwitches = 0;
  const firstRun = new Map<Pid, number>();
  const completion = new Map<Pid, number>();
  const gantt: string[] = [];
  const rationales: string[] = [];

  const context = (tick: Tick): SchedulerContext => ({
    tick,
    rng,
    params: DEFAULT_SCHEDULER_PARAMS,
    running,
    sliceElapsed,
    process: (pid: Pid) => table.get(pid),
    readyQueue: order.filter((pid) => table.get(pid)?.state === 'ready'),
    emit: (_event: KernelEvent) => {
      /* the harness does not collect events */
    },
  });

  for (let t = 0; t < maxTicks; t++) {
    const tick = asTick(t);

    // Phase 5: admit. Submission order, which is ascending pid here.
    for (const pid of order) {
      const pcb = table.get(pid);
      if (pcb === undefined || pcb.state !== 'new') continue;
      if (pcb.arrivalTick > tick) continue;
      pcb.state = 'ready';
      pcb.readySince = tick;
      policy.onAdmit(pcb, context(tick));
    }

    // Phase 7: schedule. The decision is applied verbatim.
    const decision = policy.onTick(context(tick));
    if (decision.isContextSwitch) {
      contextSwitches += 1;
      rationales.push(decision.rationale);
      const outgoing = running === null ? undefined : table.get(running);
      if (outgoing !== undefined && outgoing.state === 'running') {
        outgoing.state = 'ready';
        outgoing.readySince = tick;
      }
      running = decision.next;
      sliceElapsed = 0;
      if (running !== null) {
        const incoming = table.get(running);
        if (incoming !== undefined) {
          incoming.state = 'running';
          incoming.readySince = null;
          incoming.lastScheduledTick = tick;
          if (!firstRun.has(running)) firstRun.set(running, t);
          gantt.push(`${incoming.name}[${t}-`);
        }
      }
    }

    // Phase 8: execute exactly one unit of CPU service.
    if (running !== null) {
      const pcb = table.get(running);
      if (pcb !== undefined && pcb.state === 'running') {
        pcb.totalCpuUsed += 1;
        pcb.cpuBurstRemaining -= 1;
        pcb.serviceRemaining -= 1;
        sliceElapsed += 1;
        if (pcb.serviceRemaining === 0) {
          // T7: running -> zombie. `running` still names it; phase 7 of the
          // next tick is what notices and frees the CPU.
          pcb.state = 'zombie';
          pcb.exitCode = 0;
          pcb.terminationReason = 'normal_exit';
          completion.set(running, t + 1);
          const open = gantt[gantt.length - 1];
          if (open !== undefined) gantt[gantt.length - 1] = `${open}${t + 1}]`;
          policy.onExit(pcb, context(tick));
        }
      }
    }

    if (completion.size === jobs.length) break;
  }

  const results: JobResult[] = order.map((pid) => {
    const spec = specs.get(pid) as JobSpec;
    const c = completion.get(pid) ?? Number.NaN;
    const f = firstRun.get(pid) ?? Number.NaN;
    const turnaround = c - spec.arrival;
    return {
      label: spec.label,
      pid,
      firstRun: f,
      completion: c,
      turnaround,
      waiting: turnaround - spec.burst,
      response: f - spec.arrival,
    };
  });

  const mean = (pick: (r: JobResult) => number): number =>
    results.reduce((sum, r) => sum + pick(r), 0) / results.length;

  return {
    gantt,
    jobs: results,
    averageWaitingTime: mean((r) => r.waiting),
    averageTurnaroundTime: mean((r) => r.turnaround),
    averageResponseTime: mean((r) => r.response),
    contextSwitches,
    rationales,
  };
}

/* ------------------------------------------------------------------ */
/* SCHED-FCFS-1                                                        */
/* ------------------------------------------------------------------ */

describe('SCHED-FCFS-1: three processes at tick 0, submitted P1, P2, P3', () => {
  const result = runFcfs([
    { label: 'P1', arrival: 0, burst: 24 },
    { label: 'P2', arrival: 0, burst: 3 },
    { label: 'P3', arrival: 0, burst: 3 },
  ]);

  it('produces the textbook Gantt chart', () => {
    expect(result.gantt).toEqual(['P1[0-24]', 'P2[24-27]', 'P3[27-30]']);
  });

  it('produces the textbook per-process table', () => {
    expect(
      result.jobs.map((j) => [j.label, j.firstRun, j.completion, j.waiting, j.turnaround, j.response]),
    ).toEqual([
      ['P1', 0, 24, 0, 24, 0],
      ['P2', 24, 27, 24, 27, 24],
      ['P3', 27, 30, 27, 30, 27],
    ]);
  });

  it('averages waiting 17.0, turnaround 27.0, response 17.0', () => {
    expect(result.averageWaitingTime).toBe(17.0);
    expect(result.averageTurnaroundTime).toBe(27.0);
    expect(result.averageResponseTime).toBe(17.0);
  });

  it('counts 3 context switches, including the initial dispatch', () => {
    expect(result.contextSwitches).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* SCHED-FCFS-2: the convoy effect                                     */
/* ------------------------------------------------------------------ */

describe('SCHED-FCFS-2: the same processes, submitted P2, P3, P1', () => {
  const result = runFcfs([
    { label: 'P2', arrival: 0, burst: 3 },
    { label: 'P3', arrival: 0, burst: 3 },
    { label: 'P1', arrival: 0, burst: 24 },
  ]);

  it('produces the textbook Gantt chart', () => {
    expect(result.gantt).toEqual(['P2[0-3]', 'P3[3-6]', 'P1[6-30]']);
  });

  it('averages waiting 3.0, turnaround 13.0, response 3.0', () => {
    expect(result.averageWaitingTime).toBe(3.0);
    expect(result.averageTurnaroundTime).toBe(13.0);
    expect(result.averageResponseTime).toBe(3.0);
  });

  it('demonstrates the convoy effect: the same work, a 14-tick swing in average wait', () => {
    const forward = runFcfs([
      { label: 'P1', arrival: 0, burst: 24 },
      { label: 'P2', arrival: 0, burst: 3 },
      { label: 'P3', arrival: 0, burst: 3 },
    ]);
    expect(forward.averageWaitingTime - result.averageWaitingTime).toBe(14.0);
    // Total work is identical; only the order changed.
    expect(forward.jobs.at(-1)?.completion).toBe(30);
    expect(result.jobs.at(-1)?.completion).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* The tie-break, sim spec 5.1 and 5.2                                 */
/* ------------------------------------------------------------------ */

describe('FCFS deterministic tie-break', () => {
  it('orders same-tick admissions by arrivalTick before pid', () => {
    // Two processes enter `ready` in the same phase of the same tick, but one
    // arrived earlier and was held back. tieBreak puts the earlier arrival
    // first even though it has the higher pid.
    const policy = new FcfsScheduler();
    policy.configure(DEFAULT_SCHEDULER_PARAMS);
    const rng = createRng(1, 'scheduler');

    const late = makePcb(asPid(1), { label: 'late', arrival: 9, burst: 1 });
    const early = makePcb(asPid(2), { label: 'early', arrival: 4, burst: 1 });
    const table = new Map<Pid, ProcessControlBlock>([
      [late.pid, late],
      [early.pid, early],
    ]);

    const tick = asTick(9);
    const ctx: SchedulerContext = {
      tick,
      rng,
      params: DEFAULT_SCHEDULER_PARAMS,
      running: null,
      sliceElapsed: 0,
      process: (pid) => table.get(pid),
      readyQueue: [late.pid, early.pid],
      emit: () => {
        /* unused */
      },
    };

    for (const pcb of [late, early]) {
      pcb.state = 'ready';
      pcb.readySince = tick;
      policy.onAdmit(pcb, ctx);
    }

    expect(policy.snapshot().queues[0]).toEqual([early.pid, late.pid]);
    expect(policy.onTick(ctx).next).toBe(early.pid);
  });

  it('never reorders across ticks, whatever the arrival times say', () => {
    // A process admitted on an earlier tick always precedes one admitted later,
    // even when the later one has a lower pid and an earlier arrivalTick. The
    // insertion tick is the outer key; tieBreak only ever sorts within one tick.
    const policy = new FcfsScheduler();
    policy.configure(DEFAULT_SCHEDULER_PARAMS);
    const rng = createRng(1, 'scheduler');

    const first = makePcb(asPid(7), { label: 'first', arrival: 6, burst: 1 });
    const second = makePcb(asPid(2), { label: 'second', arrival: 1, burst: 1 });
    const table = new Map<Pid, ProcessControlBlock>([
      [first.pid, first],
      [second.pid, second],
    ]);
    const ctxAt = (t: number): SchedulerContext => ({
      tick: asTick(t),
      rng,
      params: DEFAULT_SCHEDULER_PARAMS,
      running: null,
      sliceElapsed: 0,
      process: (pid) => table.get(pid),
      readyQueue: [first.pid, second.pid],
      emit: () => {
        /* unused */
      },
    });

    first.state = 'ready';
    first.readySince = asTick(10);
    policy.onAdmit(first, ctxAt(10));

    second.state = 'ready';
    second.readySince = asTick(11);
    policy.onAdmit(second, ctxAt(11));

    expect(policy.snapshot().queues[0]).toEqual([first.pid, second.pid]);
  });
});

/* ------------------------------------------------------------------ */
/* Policy contract                                                     */
/* ------------------------------------------------------------------ */

describe('FcfsScheduler contract', () => {
  it('declares itself non-preemptive', () => {
    const policy = new FcfsScheduler();
    expect(policy.id).toBe('fcfs');
    expect(policy.isPreemptive).toBe(false);
  });

  it('returns the same snapshot object every call, allocating nothing per tick', () => {
    const policy = new FcfsScheduler();
    policy.configure(DEFAULT_SCHEDULER_PARAMS);
    const a = policy.snapshot();
    const b = policy.snapshot();
    expect(b).toBe(a);
    expect(b.queues).toBe(a.queues);
    expect(b.queues[0]).toBe(a.queues[0]);
    expect(a.policy).toBe('fcfs');
    // FCFS has no quantum, so quantumRemaining is reported as 0 rather than
    // Infinity, which would fail the finiteness check of invariant I-19.
    expect(a.quantumRemaining).toBe(0);
  });

  it('removes a dispatched process from its queue, so invariant I-13 holds', () => {
    const policy = new FcfsScheduler();
    policy.configure(DEFAULT_SCHEDULER_PARAMS);
    const rng = createRng(1, 'scheduler');
    const pcb = makePcb(asPid(1), { label: 'solo', arrival: 0, burst: 5 });
    const table = new Map<Pid, ProcessControlBlock>([[pcb.pid, pcb]]);
    const ctx: SchedulerContext = {
      tick: asTick(0),
      rng,
      params: DEFAULT_SCHEDULER_PARAMS,
      running: null,
      sliceElapsed: 0,
      process: (pid) => table.get(pid),
      readyQueue: [pcb.pid],
      emit: () => {
        /* unused */
      },
    };
    pcb.state = 'ready';
    pcb.readySince = asTick(0);
    policy.onAdmit(pcb, ctx);
    expect(policy.snapshot().queues[0]).toEqual([pcb.pid]);

    const decision = policy.onTick(ctx);
    expect(decision.next).toBe(pcb.pid);
    expect(policy.snapshot().queues[0]).toEqual([]);
  });

  it('idles when nothing is ready', () => {
    const policy = new FcfsScheduler();
    policy.configure(DEFAULT_SCHEDULER_PARAMS);
    const ctx: SchedulerContext = {
      tick: asTick(0),
      rng: createRng(1, 'scheduler'),
      params: DEFAULT_SCHEDULER_PARAMS,
      running: null,
      sliceElapsed: 0,
      process: () => undefined,
      readyQueue: [],
      emit: () => {
        /* unused */
      },
    };
    const decision = policy.onTick(ctx);
    expect(decision.next).toBeNull();
    expect(decision.isContextSwitch).toBe(false);
    expect(decision.rationale).toMatch(/idle/i);
  });
});
