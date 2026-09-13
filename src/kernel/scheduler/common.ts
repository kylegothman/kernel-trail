/**
 * KERNEL TRAIL - things every scheduling policy shares.
 *
 * This module exists to break the import cycle that would otherwise form
 * between `SchedulerRegistry` (which must import every policy in order to be a
 * total record over `SchedulerId`) and each policy (which needs `tieBreak` and
 * `EMPTY_METRICS`). Policies import from here; the registry re-exports
 * everything here so that `@kernel/scheduler/SchedulerRegistry` stays the one
 * public entry point.
 */

import type {
  ProcessControlBlock,
  SchedulerParams,
  SchedulerPolicy,
  SchedulingMetrics,
} from '../types';

export { tieBreak } from './tieBreak';

/**
 * Metrics before the kernel has computed any. Sim spec 5.10 recomputes
 * `SchedulingMetrics` from scratch in phase 10; a policy never accumulates
 * them, because an accumulated float would drift across a snapshot/restore
 * boundary (sim spec 1.3).
 */
export const EMPTY_METRICS: SchedulingMetrics = Object.freeze({
  averageWaitingTime: 0,
  averageTurnaroundTime: 0,
  averageResponseTime: 0,
  throughput: 0,
  cpuUtilisation: 0,
  contextSwitches: 0,
  worstWait: 0,
});

/** Defaults matching `REFERENCE_CONFIG` in sim spec 16.1. */
export const DEFAULT_SCHEDULER_PARAMS: SchedulerParams = Object.freeze({
  quantum: 4,
  levelQuanta: Object.freeze([4, 8, 16]),
  agingInterval: 50,
  starvationThreshold: 120,
  starvationFatalThreshold: 300,
  preemptive: true,
});

/**
 * A policy that accepts the metrics the kernel recomputes in phase 10, so that
 * `SchedulerSnapshot.metrics` reports live numbers. This is deliberately not
 * part of the frozen `SchedulerPolicy` contract: metrics are owned by the
 * kernel, and a policy that does not care simply does not implement this.
 */
export interface MetricsAwarePolicy extends SchedulerPolicy {
  acceptMetrics(metrics: SchedulingMetrics): void;
}

export function isMetricsAware(policy: SchedulerPolicy): policy is MetricsAwarePolicy {
  return 'acceptMetrics' in policy && typeof policy.acceptMetrics === 'function';
}

/**
 * A policy that lets the kernel keep `SchedulerSnapshot.running` current
 * without the policy having to infer it. Same rationale as `MetricsAwarePolicy`.
 */
export interface RunningAwarePolicy extends SchedulerPolicy {
  setRunning(pid: ProcessControlBlock['pid'] | null): void;
}

export function isRunningAware(policy: SchedulerPolicy): policy is RunningAwarePolicy {
  return 'setRunning' in policy && typeof policy.setRunning === 'function';
}
