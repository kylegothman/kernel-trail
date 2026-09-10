/**
 * KERNEL TRAIL - first come, first served. Sim spec 5.2, Silberschatz 5.3.1.
 *
 * This is the reference implementation of `SchedulerPolicy`. The other six
 * policies follow its shape exactly: a private ordering structure, an insert
 * used by both `onAdmit` and `onUnblock`, a single reused snapshot object, and
 * a comparator that always falls through to `tieBreak`.
 *
 * The rules, restated from sim spec 5.2:
 *
 *  - Selection: the head of the kernel's insertion-ordered ready queue.
 *  - Preemption: none. `isPreemptive` is false and a dispatched process holds
 *    the CPU until it blocks or finishes.
 *  - Tie-break: insertion order is already a total order. Two processes that
 *    enter `ready` in the same phase of the same tick are ordered by
 *    `tieBreak` (lower `arrivalTick`, then lower `pid`), which is what makes
 *    the result reproducible regardless of the order the kernel happened to
 *    walk its process table.
 *  - Data structure: a `Pid[]` used as a FIFO, with a parallel array of
 *    insertion ticks so the tie-break only ever reorders within one tick.
 *
 * Ownership note: the policy owns the *order*, the kernel owns the ready set.
 * A pid leaves this queue at the moment it is dispatched, so invariant I-13
 * ("the union of the queues plus the running pid equals the ready-or-running
 * set") holds without the kernel having to reach in here.
 */

import type {
  Pid,
  ProcessControlBlock,
  SchedulerContext,
  SchedulerParams,
  SchedulerPolicy,
  SchedulerSnapshot,
  SchedulingDecision,
  SchedulingMetrics,
  Tick,
} from '../types';
import {
  DEFAULT_SCHEDULER_PARAMS,
  EMPTY_METRICS,
  tieBreak,
  type MetricsAwarePolicy,
  type RunningAwarePolicy,
} from './common';

/** Writable view of the snapshot, so one object can be reused every tick. */
type MutableSnapshot = { -readonly [K in keyof SchedulerSnapshot]: SchedulerSnapshot[K] };

const RATIONALE_HOLD = 'First come, first served: the running process keeps the CPU until it blocks or finishes.';
const RATIONALE_IDLE = 'No process is ready. The CPU idles.';

export class FcfsScheduler implements SchedulerPolicy, MetricsAwarePolicy, RunningAwarePolicy {
  readonly id = 'fcfs' as const;
  readonly displayName = 'First Come, First Served';
  readonly isPreemptive = false;

  private params: Readonly<SchedulerParams> = DEFAULT_SCHEDULER_PARAMS;

  /** The FIFO. Head is index 0. */
  private readonly queue: Pid[] = [];
  /** Tick each queued pid was inserted, aligned with `queue`. */
  private readonly queueTicks: Tick[] = [];

  /**
   * Reused every tick. The frozen contract says `snapshot()` must not allocate
   * per tick, so this object and the `queues` array inside it are built once.
   * `queues[0]` aliases the live `queue`, which is what the world layer draws.
   */
  private readonly snap: MutableSnapshot = {
    policy: 'fcfs',
    running: null,
    queues: [this.queue],
    quantumRemaining: 0,
    metrics: EMPTY_METRICS,
  };

  configure(params: SchedulerParams): void {
    this.params = params;
  }

  /** A process entering `ready` for the first time. Transition T2. */
  onAdmit(pcb: ProcessControlBlock, ctx: SchedulerContext): void {
    this.insert(pcb, ctx);
  }

  /** A process re-entering `ready` after waiting. Transition T6. */
  onUnblock(pcb: ProcessControlBlock, ctx: SchedulerContext): void {
    this.insert(pcb, ctx);
  }

  /** A process leaving for `waiting`. Transition T5. It was running, not queued. */
  onBlock(pcb: ProcessControlBlock, _ctx: SchedulerContext): void {
    this.remove(pcb.pid);
  }

  /** A process dying. Transitions T7, T8, T9. */
  onExit(pcb: ProcessControlBlock, _ctx: SchedulerContext): void {
    this.remove(pcb.pid);
  }

  /**
   * Phase 7. Called exactly once per tick; the kernel applies the returned
   * decision verbatim.
   *
   * A fresh decision object is allocated per tick rather than reused. It is
   * four fields, and reuse would let a caller that holds the previous tick's
   * decision see it mutate underneath, which is a bug class worth more than
   * the allocation.
   */
  onTick(ctx: SchedulerContext): SchedulingDecision {
    // Non-preemptive: if something is still running, it keeps the CPU. The
    // kernel moves a process out of `running` in phase 8 when it blocks or
    // exits, so by the time we see `state !== 'running'` the CPU is genuinely
    // free.
    if (ctx.running !== null) {
      const current = ctx.process(ctx.running);
      if (current !== undefined && current.state === 'running') {
        return { next: ctx.running, isContextSwitch: false, rationale: RATIONALE_HOLD };
      }
    }

    // The CPU is free. Take the head, discarding any pid the kernel has since
    // moved out of `ready` without telling us (a killed process, for example).
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (head === undefined) {
        this.dropHead();
        continue;
      }
      const pcb = ctx.process(head);
      if (pcb === undefined || pcb.state !== 'ready') {
        this.dropHead();
        continue;
      }
      this.dropHead();
      const waited = pcb.readySince === null ? 0 : ctx.tick - pcb.readySince;
      return {
        next: head,
        isContextSwitch: head !== ctx.running,
        rationale: `${pcb.name} (P${head}) reached the head of the queue after waiting ${waited} tick${waited === 1 ? '' : 's'}. FCFS never reorders.`,
      };
    }

    return { next: null, isContextSwitch: ctx.running !== null, rationale: RATIONALE_IDLE };
  }

  /** Read-only view for the world and the HUD. Allocates nothing. */
  snapshot(): SchedulerSnapshot {
    return this.snap;
  }

  /** Phase 10 pushes the recomputed metrics in. See `MetricsAwarePolicy`. */
  acceptMetrics(metrics: SchedulingMetrics): void {
    this.snap.metrics = metrics;
  }

  /** Kept current by the kernel so `snapshot().running` is live. */
  setRunning(pid: Pid | null): void {
    this.snap.running = pid;
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Append to the tail, then slide left past any entry inserted on this same
   * tick that sorts after us by `tieBreak`. Entries from earlier ticks are
   * never passed, so arrival order across ticks is preserved exactly.
   */
  private insert(pcb: ProcessControlBlock, ctx: SchedulerContext): void {
    if (this.queue.indexOf(pcb.pid) !== -1) return;

    let i = this.queue.length;
    while (i > 0) {
      if (this.queueTicks[i - 1] !== ctx.tick) break;
      const otherPid = this.queue[i - 1];
      if (otherPid === undefined) break;
      const other = ctx.process(otherPid);
      if (other === undefined || tieBreak(other, pcb) <= 0) break;
      i -= 1;
    }

    this.queue.splice(i, 0, pcb.pid);
    this.queueTicks.splice(i, 0, ctx.tick);
  }

  private remove(pid: Pid): void {
    const i = this.queue.indexOf(pid);
    if (i === -1) return;
    this.queue.splice(i, 1);
    this.queueTicks.splice(i, 1);
  }

  private dropHead(): void {
    this.queue.shift();
    this.queueTicks.shift();
  }

  /** Params are read by the kernel for starvation thresholds; exposed for tests. */
  get configuredParams(): Readonly<SchedulerParams> {
    return this.params;
  }
}
