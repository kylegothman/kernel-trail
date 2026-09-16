/**
 * KERNEL TRAIL - phrasing the counterfactual. Architecture 8.7 step 5; WP-18
 * specification section 6, scope corrections U7 and U15, pre-flight ruling 13.
 *
 * Every sentence is a template with numeric slots, and every number comes
 * from the two results or the override that named the alternative, never
 * from a lookup table: a hand-written claim would eventually be wrong for
 * some seed and the game would be teaching something false. The rules for
 * this copy: no dashes, name the Program and the metric, then the two
 * numbers, then the outcome; at most two sentences; never tell the player
 * what to do, since remedies live in the codex.
 *
 * `ReplayResult` carries no per-Program wait, so a starving Program's wait is
 * `worstWait`, which on the starvation row is that Program's by definition.
 */

import type { AllocationStrategy, DiskSchedulingId, KernelConfig, PageReplacementId, SchedulerId, TerminationReason } from '@kernel/types';
import type { Pace, Rations } from '@game/types';
import type { CodexCounterfactual } from '@game/codexTypes';
import type { ObservedLeg, ReplayRequest, ReplayResult } from './types';

/* ------------------------------------------------------------------ */
/* Names in the player's terms                                         */
/* ------------------------------------------------------------------ */

const SCHEDULER_NAMES: Readonly<Record<SchedulerId, string>> = {
  fcfs: 'first come first served',
  sjf: 'shortest job first',
  srtf: 'shortest remaining time first',
  priority: 'priority scheduling',
  priority_aging: 'priority scheduling with aging',
  rr: 'round-robin',
  mlfq: 'a multilevel feedback queue',
};

const REPLACEMENT_NAMES: Readonly<Record<PageReplacementId, string>> = {
  fifo: 'FIFO replacement',
  lru: 'LRU replacement',
  clock: 'clock replacement',
  optimal: 'optimal replacement',
  lfu: 'LFU replacement',
  random: 'random replacement',
};

const DISK_NAMES: Readonly<Record<DiskSchedulingId, string>> = {
  fcfs: 'first come first served disk scheduling',
  sstf: 'shortest seek time first',
  scan: 'SCAN',
  cscan: 'C-SCAN',
  look: 'LOOK',
  clook: 'C-LOOK',
};

const ALLOCATION_NAMES: Readonly<Record<AllocationStrategy, string>> = {
  first_fit: 'first fit allocation',
  best_fit: 'best fit allocation',
  worst_fit: 'worst fit allocation',
  buddy: 'the buddy allocator',
};

const DEADLOCK_NAMES: Readonly<Record<KernelConfig['deadlockStrategy'], string>> = {
  ignore: 'no deadlock handling',
  detect: 'deadlock detection',
  avoid: 'deadlock avoidance',
  prevent: 'deadlock prevention',
};

export const schedulerName = (id: SchedulerId): string => SCHEDULER_NAMES[id];
export const replacementName = (id: PageReplacementId): string => REPLACEMENT_NAMES[id];
export const diskPolicyName = (id: DiskSchedulingId): string => DISK_NAMES[id];
export const allocationName = (s: AllocationStrategy): string => ALLOCATION_NAMES[s];
export const paceName = (pace: Pace): string => `a ${pace} pace`;
export const rationsName = (rations: Rations): string => `${rations} rations`;

/** "round-robin with a quantum of 4", "a degree of multiprogramming of 4", "deadlock avoidance". */
export function describeAlternative(request: Pick<ReplayRequest, 'overrides' | 'configPatch'>): string {
  const o = request.overrides;
  const parts: string[] = [];
  if (o.scheduler !== undefined && o.quantum !== undefined) parts.push(`${SCHEDULER_NAMES[o.scheduler]} with a quantum of ${o.quantum}`);
  else if (o.scheduler !== undefined) parts.push(SCHEDULER_NAMES[o.scheduler]);
  else if (o.quantum !== undefined) parts.push(`a quantum of ${o.quantum}`);
  if (o.replacement !== undefined) parts.push(REPLACEMENT_NAMES[o.replacement]);
  if (o.diskPolicy !== undefined) parts.push(DISK_NAMES[o.diskPolicy]);
  if (o.allocation !== undefined) parts.push(ALLOCATION_NAMES[o.allocation]);
  if (o.pace !== undefined) parts.push(paceName(o.pace));
  if (o.rations !== undefined) parts.push(rationsName(o.rations));
  if (o.degreeOfMultiprogramming !== undefined) parts.push(`a degree of multiprogramming of ${o.degreeOfMultiprogramming}`);
  const strategy = request.configPatch?.deadlockStrategy;
  if (strategy !== undefined) parts.push(DEADLOCK_NAMES[strategy]);
  if (parts.length === 0) return 'the same policy';
  if (parts.length === 1) return parts[0] ?? 'the same policy';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

/* ------------------------------------------------------------------ */
/* The metric the alternative bears on                                 */
/* ------------------------------------------------------------------ */

type Metric = 'waiting' | 'faults' | 'seek';

const METRIC_LABEL: Readonly<Record<Metric, string>> = {
  waiting: 'Average waiting time',
  faults: 'Page faults',
  seek: 'Head movement',
};

/** "Page faults fall"; "Average waiting time falls". */
const METRIC_PLURAL: Readonly<Record<Metric, boolean>> = { waiting: false, faults: true, seek: false };

function verb(metric: Metric, before: number, after: number): string {
  const plural = METRIC_PLURAL[metric];
  if (after === before) return plural ? 'stay at' : 'stays at';
  if (after < before) return plural ? 'fall from' : 'falls from';
  return plural ? 'rise from' : 'rises from';
}

function metricFor(request: Pick<ReplayRequest, 'overrides' | 'configPatch'>): Metric {
  const o = request.overrides;
  if (o.replacement !== undefined || o.degreeOfMultiprogramming !== undefined || o.rations !== undefined) return 'faults';
  if (o.diskPolicy !== undefined) return 'seek';
  return 'waiting';
}

function metricValue(leg: ObservedLeg, metric: Metric): number {
  switch (metric) {
    case 'waiting':
      return Math.round(leg.scheduling.averageWaitingTime);
    case 'faults':
      return leg.memory.pageFaults;
    case 'seek':
      return leg.storage.seekDistance;
    default:
      return 0;
  }
}

const REASON_TEXT: Readonly<Record<TerminationReason, string>> = {
  normal_exit: 'a normal exit',
  killed_by_user: 'a kill',
  killed_by_parent: 'its parent',
  starvation: 'starvation',
  deadlock_victim: 'a deadlock',
  out_of_memory: 'memory exhaustion',
  thrashing_collapse: 'thrashing collapse',
  protection_fault: 'a protection fault',
  io_timeout: 'an I/O timeout',
  storage_corruption: 'storage corruption',
};

function reasonText(reason: string): string {
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, reason) ? REASON_TEXT[reason as TerminationReason] : reason.replace(/_/g, ' ');
}

const programName = (member: string): string => member.toUpperCase();

/* ------------------------------------------------------------------ */
/* The sentences                                                       */
/* ------------------------------------------------------------------ */

export interface PhrasingInput {
  /** The leg as it happened. */
  readonly baseline: ObservedLeg;
  /** The same leg under the alternative. */
  readonly alternative: ReplayResult;
  readonly request: Pick<ReplayRequest, 'overrides' | 'configPatch'>;
  /** The optimal row: say the floor is unachievable. */
  readonly floor?: boolean;
}

/** The metric sentence: "Average waiting time falls from 94 to 38." */
function metricSentence(input: PhrasingInput, metric: Metric): string {
  const before = metricValue(input.baseline, metric);
  const after = metricValue(input.alternative, metric);
  const label = METRIC_LABEL[metric];
  const unit = metric === 'seek' ? ' cylinders' : '';
  if (after === before) return `${label} ${verb(metric, before, after)} ${before}${unit}.`;
  return `${label} ${verb(metric, before, after)} ${before} to ${after}${unit}.`;
}

/** The Program sentence for a casualty of the leg as it happened. */
function programSentence(input: PhrasingInput, alt: string): string {
  const lost = input.baseline.casualties[0];
  if (lost === undefined) return '';
  const name = programName(lost.member);
  const again = input.alternative.casualties.find((c) => c.member === lost.member);
  if (again !== undefined) return `Under ${alt}, ${name} still derezzes, at tick ${again.tick} instead of ${lost.tick}.`;
  switch (lost.reason) {
    case 'starvation':
      return `Under ${alt}, ${name} waits ${Math.round(input.alternative.scheduling.worstWait)} ticks instead of ${Math.round(input.baseline.scheduling.worstWait)} and survives.`;
    case 'thrashing_collapse':
    case 'out_of_memory':
      return `Under ${alt}, ${name} sees ${input.alternative.memory.pageFaults} page faults instead of ${input.baseline.memory.pageFaults} and survives.`;
    default:
      return `Under ${alt}, ${name}, lost to ${reasonText(lost.reason)} at tick ${lost.tick}, survives.`;
  }
}

/**
 * At most two sentences. With a casualty: the Program sentence, then the
 * metric. Without one: the metric sentence, then what the alternative did to
 * the convoy.
 */
export function phraseCounterfactual(input: PhrasingInput): string {
  const alt = input.floor === true ? `${describeAlternative(input.request)}, an unachievable floor` : describeAlternative(input.request);
  const metric = metricFor(input.request);
  if (input.baseline.casualties.length > 0) return `${programSentence(input, alt)} ${metricSentence(input, metric)}`;
  const before = metricValue(input.baseline, metric);
  const after = metricValue(input.alternative, metric);
  const label = METRIC_LABEL[metric].toLowerCase();
  const unit = metric === 'seek' ? ' cylinders' : '';
  const first = after === before ? `Under ${alt}, ${label} ${verb(metric, before, after)} ${before}${unit}.` : `Under ${alt}, ${label} ${verb(metric, before, after)} ${before} to ${after}${unit}.`;
  const lost = input.alternative.casualties[0];
  const second = lost === undefined ? 'Every Program survives either way.' : `${programName(lost.member)} is lost to ${reasonText(lost.reason)} at tick ${lost.tick}, where the run that happened kept every Program.`;
  return `${first} ${second}`;
}

/** Every integer or decimal in a sentence, for the numbers-from-result assertion. */
export function numbersIn(text: string): number[] {
  return Array.from(text.matchAll(/\d+(?:\.\d+)?/g), (m) => Number(m[0]));
}

/* ------------------------------------------------------------------ */
/* U7: the codex side                                                  */
/* ------------------------------------------------------------------ */

/** `scheduling.*`, `memory.*` and `storage.*` flattened into dotted keys, plus the tick count. */
export function toCodexCounterfactual(result: ReplayResult, alternative: string, decisionIndex: number, replaySeed: number, narrative: string): CodexCounterfactual {
  const projected: Record<string, number> = { ticks: result.ticks };
  for (const [key, value] of Object.entries(result.scheduling)) projected[`scheduling.${key}`] = value;
  for (const [key, value] of Object.entries(result.memory)) projected[`memory.${key}`] = value;
  for (const [key, value] of Object.entries(result.storage)) projected[`storage.${key}`] = value;
  return { alternative, decisionIndex, replaySeed, projected, narrative };
}
