/**
 * KERNEL TRAIL - the scheduler policy registry.
 *
 * `SCHEDULERS` is typed as a total record over `SchedulerId`, so adding an id
 * to the frozen union without adding a factory here is a compile error. That
 * is the whole enforcement mechanism (architecture 13.1) and it needs nothing
 * else.
 *
 * The shared policy helpers live in `./common` to keep this module free of an
 * import cycle; they are re-exported here so a policy author needs only one
 * import path.
 */

import type { SchedulerId, SchedulerParams, SchedulerPolicy } from '../types';
import { FcfsScheduler } from './FCFS';

export {
  tieBreak,
  EMPTY_METRICS,
  DEFAULT_SCHEDULER_PARAMS,
  isMetricsAware,
  isRunningAware,
} from './common';
export type { MetricsAwarePolicy, RunningAwarePolicy } from './common';
export { FcfsScheduler } from './FCFS';

/* ------------------------------------------------------------------ */
/* Not-yet-implemented policies                                        */
/* ------------------------------------------------------------------ */

export class UnimplementedSchedulerError extends Error {
  constructor(
    readonly policyId: SchedulerId,
    readonly specSection: string,
  ) {
    super(
      `Scheduler '${policyId}' is not implemented yet. Build it against sim spec ${specSection}, ` +
        'following the shape of src/kernel/scheduler/FCFS.ts.',
    );
    this.name = 'UnimplementedSchedulerError';
  }
}

const notYet =
  (id: SchedulerId, section: string) =>
  (): SchedulerPolicy => {
    throw new UnimplementedSchedulerError(id, section);
  };

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Total over `SchedulerId`. FCFS is the reference implementation; the other
 * six follow the same shape. Each factory is a thunk, so an unimplemented
 * policy costs nothing until something asks for it.
 */
export const SCHEDULERS: Readonly<Record<SchedulerId, () => SchedulerPolicy>> = {
  fcfs: () => new FcfsScheduler(),
  // TODO(astra): implement SjfScheduler in src/kernel/scheduler/SJF.ts per sim spec 5.3. Min-heap keyed by (serviceRemaining, arrivalTick, pid), non-preemptive, no decrease-key needed. Fixture SCHED-SJF-1 expects avg wait 7.0, turnaround 13.0, response 7.0.
  sjf: notYet('sjf', '5.3'),
  // TODO(astra): implement SrtfScheduler in src/kernel/scheduler/SRTF.ts per sim spec 5.4. Preempt only when a ready process has strictly smaller serviceRemaining. Fixture SCHED-SRTF-1 expects avg wait 6.5, turnaround 13.0, response 4.25.
  srtf: notYet('srtf', '5.4'),
  // TODO(astra): implement PriorityScheduler in src/kernel/scheduler/Priority.ts per sim spec 5.5. Lower priority number wins, tieBreak fallback. Fixture SCHED-PRIO-1 expects avg wait 8.2, turnaround 12.0, response 8.2.
  priority: notYet('priority', '5.5'),
  // TODO(astra): implement PriorityAgingScheduler in src/kernel/scheduler/PriorityAging.ts per sim spec 5.6. Aging is applied by kernel phase 6, not by the policy; the policy only re-sorts. Fixtures SCHED-AGING-1A and 1B.
  priority_aging: notYet('priority_aging', '5.6'),
  // TODO(astra): implement RoundRobinScheduler in src/kernel/scheduler/RR.ts per sim spec 5.7. Preemption test is sliceElapsed >= quantum, not >. Fixtures SCHED-RR-1, SCHED-RR-2a, SCHED-RR-2c.
  rr: notYet('rr', '5.7'),
  // TODO(astra): implement MlfqScheduler in src/kernel/scheduler/MLFQ.ts per sim spec 5.8. levelQuanta [4,8,16], demote on quantum expiry, promote on aging. Fixture SCHED-MLFQ-1 also asserts final queue levels P1=2, P2=1, P3=0.
  mlfq: notYet('mlfq', '5.8'),
};

/** Construct and configure a policy. Throws for an id with no implementation. */
export function createScheduler(id: SchedulerId, params: SchedulerParams): SchedulerPolicy {
  const policy = SCHEDULERS[id]();
  policy.configure(params);
  return policy;
}
