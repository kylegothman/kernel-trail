import type { Pid, SchedulerId, SchedulerParams, SchedulerPolicy } from '../types';
import { FcfsScheduler } from './FCFS';
import { SjfScheduler } from './sjf';
import { SrtfScheduler } from './srtf';
import { PriorityScheduler } from './priority';

export { tieBreak, EMPTY_METRICS, DEFAULT_SCHEDULER_PARAMS, isMetricsAware, isRunningAware } from './common';
export type { MetricsAwarePolicy, RunningAwarePolicy } from './common';
export { FcfsScheduler } from './FCFS';
export { SjfScheduler } from './sjf';
export { SrtfScheduler } from './srtf';
export { PriorityScheduler } from './priority';
export type SchedulerFactory = () => SchedulerPolicy;

// TODO(astra): WP-04 implements this policy
function priorityAging(): never { throw new Error('not implemented: priority_aging. Policy not implemented yet; see sim spec 5.6 (WP-04).'); }
// TODO(astra): WP-04 implements this policy
function roundRobin(): never { throw new Error('not implemented: rr. Policy not implemented yet; see sim spec 5.7 (WP-04).'); }
// TODO(astra): WP-04 implements this policy
function mlfq(): never { throw new Error('not implemented: mlfq. Policy not implemented yet; see sim spec 5.8 (WP-04).'); }

export const SCHEDULERS: Readonly<Record<SchedulerId, SchedulerFactory>> = {
  fcfs: () => new FcfsScheduler(), sjf: () => new SjfScheduler(),
  srtf: () => new SrtfScheduler(), priority: () => new PriorityScheduler(),
  priority_aging: priorityAging, rr: roundRobin, mlfq,
};
export function createScheduler(id: SchedulerId, params: SchedulerParams): SchedulerPolicy {
  const policy = SCHEDULERS[id](); policy.configure(params); return policy;
}

/** Supply raw workload bursts without adding fields to the frozen policy or PCB. */
export function configureSchedulerWorkload(policy: SchedulerPolicy, initialBurst: (pid: Pid) => number | undefined): void {
  if (policy instanceof SjfScheduler) policy.setInitialBurstSource(initialBurst);
}
