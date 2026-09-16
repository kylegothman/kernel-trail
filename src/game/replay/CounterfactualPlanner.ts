/**
 * KERNEL TRAIL - the counterfactual planner. Architecture 8.7 step 2; WP-18
 * specification section 5, scope correction U12, pre-flight rulings 2, 5
 * and 12.
 *
 * It does not run every alternative; it picks at most two, from a table
 * keyed by what actually went wrong:
 *
 *   starvation casualty            the same leg with priority_aging, or rr
 *                                  if the player was already aging
 *   thrashing_collapse             the same leg with degreeOfMultiprogramming - 2
 *   deadlock_victim                the same leg with deadlockStrategy: 'avoid'
 *   high averageWaitingTime,       the same leg with srtf, the theoretical
 *   no casualty                    floor for average waiting time
 *   high pageFaults, no casualty   the same leg with optimal, an unachievable floor
 *   high seek distance             the same leg with clook
 *   nothing went wrong             the next-worse policy, so success is explained
 *
 * The deadlock row cannot go through `ReplayOverrides`, which has no
 * strategy field and stays untouched. It rides on `ReplayRequest.configPatch`
 * (ruling 2), which `runReplay` applies by substituting the modified
 * `KernelConfig` in the headless factory for that one replay.
 */

import type { DiskSchedulingId, PageReplacementId, SchedulerId } from '@kernel/types';
import type { DecisionRecord, DifficultyTier, DiscClass, LegId, TravelPolicy } from '@game/types';
import { describeAlternative } from './phrasing';
import type { ObservedLeg, ReplayEntry, ReplayKernel, ReplayOverrides, ReplayRequest } from './types';

export type CounterfactualRow = 'starvation' | 'thrashing' | 'deadlock' | 'waiting' | 'faults' | 'seek' | 'clean';

export interface CounterfactualPlan {
  readonly row: CounterfactualRow;
  /** The alternative in the player's terms, from `describeAlternative`. */
  readonly label: string;
  readonly request: ReplayRequest;
  /** The optimal row: an unachievable floor, and the card says so. */
  readonly floor: boolean;
}

export interface PlannerThresholds {
  readonly averageWaitingTime: number;
  readonly pageFaults: number;
  readonly seekDistance: number;
}

// TODO(astra): balance pass in phase 2. Placeholder thresholds; the planner takes them as input and nothing else reads them.
export const DEFAULT_THRESHOLDS: PlannerThresholds = { averageWaitingTime: 40, pageFaults: 200, seekDistance: 2000 };

// TODO(astra): balance pass in phase 2. Placeholder next-worse rankings for the clean row, one step down each dimension.
export const NEXT_WORSE_SCHEDULER: Readonly<Partial<Record<SchedulerId, SchedulerId>>> = {
  srtf: 'sjf',
  sjf: 'fcfs',
  priority_aging: 'priority',
  priority: 'fcfs',
  mlfq: 'rr',
  rr: 'fcfs',
};
export const NEXT_WORSE_REPLACEMENT: Readonly<Partial<Record<PageReplacementId, PageReplacementId>>> = {
  optimal: 'lru',
  lru: 'clock',
  clock: 'fifo',
  lfu: 'fifo',
  fifo: 'random',
};
export const NEXT_WORSE_DISK: Readonly<Partial<Record<DiskSchedulingId, DiskSchedulingId>>> = {
  clook: 'look',
  look: 'cscan',
  cscan: 'scan',
  scan: 'sstf',
  sstf: 'fcfs',
};

export interface PlannerInput {
  readonly legId: LegId;
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  readonly decisions: readonly DecisionRecord[];
  /** The leg as it happened. */
  readonly observed: ObservedLeg;
  /** The live kernel at leg end: the policies in force and `allProgramsScripted()`. */
  readonly kernel: ReplayKernel;
  readonly policy: Readonly<TravelPolicy>;
  readonly maxTicks: number;
  readonly thresholds?: PlannerThresholds;
  /** Live leg-entry data; omitted only by legacy planner callers. */
  readonly entry?: ReplayEntry;
}

/**
 * Whether the optimal policy can run. `allProgramsScripted()` is vacuously
 * true whenever no process is ready or running, which is the state at leg
 * end (pre-flight finding 5), so the check also walks every process above
 * init and asks its program for a reference string.
 */
export function workloadIsScripted(kernel: ReplayKernel): boolean {
  if (!kernel.allProgramsScripted()) return false;
  return kernel.processes.filter((p) => p.pid > 1).every((p) => (kernel.program(p.pid)?.referenceString ?? null) !== null);
}

export function planCounterfactuals(input: PlannerInput): readonly CounterfactualPlan[] {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const view = input.kernel.invariantState();
  const activeScheduler = view.schedulerId;
  const activeReplacement = input.kernel.activeReplacementPolicy;
  const activeDisk = input.kernel.activeDiskPolicy;
  const enabled = new Set(input.kernel.config.enabledSubsystems);
  const observed = input.observed;
  const reasons = new Set(observed.casualties.map((c) => c.reason));
  const plans: CounterfactualPlan[] = [];

  const plan = (row: CounterfactualRow, overrides: Omit<ReplayOverrides, 'suppressRecordedPolicyChanges'>, floor = false, configPatch?: ReplayRequest['configPatch']): void => {
    if (plans.length >= 2) return;
    const request: ReplayRequest = {
      seed: input.seed,
      discClass: input.discClass,
      difficulty: input.difficulty,
      legs: [input.legId],
      decisions: input.decisions,
      // A policy row replaces the player's choice for the whole leg, so the recorded changes of that kind are dropped.
      overrides: { ...overrides, suppressRecordedPolicyChanges: true },
      maxTicks: input.maxTicks,
      ...(input.entry === undefined ? {} : { entry: input.entry }),
      ...(configPatch === undefined ? {} : { configPatch }),
    };
    plans.push({ row, label: describeAlternative(request), request, floor });
  };

  if (reasons.has('starvation')) plan('starvation', { scheduler: activeScheduler === 'priority_aging' ? 'rr' : 'priority_aging' });
  if (reasons.has('thrashing_collapse')) plan('thrashing', { degreeOfMultiprogramming: Math.max(1, input.policy.degreeOfMultiprogramming - 2) });
  if (reasons.has('deadlock_victim')) plan('deadlock', {}, false, { deadlockStrategy: 'avoid' });
  const noCasualty = observed.casualties.length === 0;
  if (noCasualty && observed.scheduling.averageWaitingTime > thresholds.averageWaitingTime && activeScheduler !== 'srtf') plan('waiting', { scheduler: 'srtf' });
  if (noCasualty && observed.memory.pageFaults > thresholds.pageFaults && activeReplacement !== 'optimal' && workloadIsScripted(input.kernel)) plan('faults', { replacement: 'optimal' }, true);
  if (observed.storage.seekDistance > thresholds.seekDistance && activeDisk !== 'clook') plan('seek', { diskPolicy: 'clook' });

  if (plans.length === 0) {
    const scheduler = enabled.has('scheduler') ? NEXT_WORSE_SCHEDULER[activeScheduler] : undefined;
    const replacement = enabled.has('vm') ? NEXT_WORSE_REPLACEMENT[activeReplacement] : undefined;
    const disk = enabled.has('storage') ? NEXT_WORSE_DISK[activeDisk] : undefined;
    if (scheduler !== undefined) plan('clean', { scheduler });
    else if (replacement !== undefined) plan('clean', { replacement });
    else if (disk !== undefined) plan('clean', { diskPolicy: disk });
  }
  return plans;
}
