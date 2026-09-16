/**
 * KERNEL TRAIL: Quantum Pass, every line the player reads: the leg's own
 * epitaph stones, its seven codex entries in full, and the debrief phrases.
 * Tone guide register (narrative bible 2.1): flat, specific, no address to
 * the player, no dashes.
 */
import type { CodexEntry } from '@game/codexTypes';
import type { EpitaphTemplate } from '@game/convoy/derezz';
import { cite } from './chapters';
import { STARVATION_FATAL_THRESHOLD } from './config';
import { LEG_ID } from './decisions';
import { OBJECTIVE_IDS } from './objectives';

export const TITLE = 'Quantum Pass';
export const SUBTITLE = 'Someone has to go last.';

/**
 * The cause line the package pins, with the number the wait counter showed.
 * The counter is `readySince` read directly, and the derezz lands on the tick
 * the wait reaches `starvationFatalThreshold`, so the number is the threshold
 * by construction rather than a tuning that has to be re-measured.
 */
export const STARVATION_CAUSE = `it was ready to run for ${STARVATION_FATAL_THRESHOLD} consecutive ticks. A priority policy with no aging will pick a higher-priority process every single time one exists.`;

export const CODEX_IDS = {
  criteria: 'codex.scheduling_criteria',
  convoy: 'codex.fcfs_convoy',
  sjf: 'codex.sjf_optimality',
  roundRobin: 'codex.round_robin',
  starvation: 'codex.priority_starvation',
  mlfq: 'codex.mlfq',
  preemption: 'codex.preemption_cost',
} as const;

/** Section 16: the stone pinned to SABLE, and an unpinned companion so a derezz of any other Program for this reason on this leg has a candidate. */
export const epitaphs: readonly EpitaphTemplate[] = [
  {
    id: 'ep.quantum_pass.sable_never_ran', reason: 'starvation', member: 'sable', legId: LEG_ID,
    inscription: 'HERE LIES SABLE, READY SINCE TICK ONE',
    cause: STARVATION_CAUSE,
    codexEntry: CODEX_IDS.starvation,
  },
  {
    id: 'ep.quantum_pass.went_last', reason: 'starvation', legId: LEG_ID,
    inscription: 'HERE LIES {NAME}, SOMEONE HAD TO GO LAST',
    cause: STARVATION_CAUSE,
    codexEntry: CODEX_IDS.starvation,
  },
];

const entry = (fields: Omit<CodexEntry, 'workedExample' | 'counterfactual'>): CodexEntry => ({ ...fields, workedExample: null, counterfactual: null });

/**
 * The seven entries of the curriculum map's table, each with the nearest
 * unlock arm (scope correction section 5). Where the map's "Added when" has
 * no exact arm the approximation is noted on the entry.
 */
export const codex: readonly CodexEntry[] = [
  entry({
    id: CODEX_IDS.criteria,
    title: 'Scheduling criteria',
    chapter: cite('5.2'),
    concept: 'Five numbers decide whether a policy is doing well: CPU utilisation, throughput, turnaround time, waiting time and response time. They cannot all be maximised at once. A policy that minimises response time switches often and pays for it in utilisation, and a policy that maximises throughput keeps long jobs running while short ones wait. Choosing which number matters is the scheduling problem; the algorithms are answers to different versions of it.',
    // Exact: the first gantt --metrics invocation.
    unlock: { kind: 'command', name: 'gantt', flag: '--metrics' },
    remedy: null,
    remedyVisibility: 'never',
    related: [CODEX_IDS.convoy, CODEX_IDS.sjf, CODEX_IDS.roundRobin],
    commands: ['gantt', 'sched', 'top'],
    epitaphs: [],
  }),
  entry({
    id: CODEX_IDS.convoy,
    title: 'First come first served and the convoy effect',
    chapter: cite('5.3.1'),
    concept: 'First come first served runs each process to completion in arrival order. When one long job arrives ahead of several short ones, every short job waits for the whole of it, and the average waiting time is set by an accident of ordering rather than by the work. On this pass the same three jobs give an average wait of 17 ticks in one order and 3 ticks in the other. That is the convoy effect, and it is why the policy is a teaching example rather than a choice.',
    // Approximation: the map adds this when the convoy segment completes under fcfs or a replay names fcfs; the command arm covers the replay.
    unlock: { kind: 'command', name: 'gantt', flag: '--replay' },
    remedy: { kind: 'set_scheduler', to: 'sjf' },
    remedyVisibility: 'on_unlock',
    related: [CODEX_IDS.criteria, CODEX_IDS.sjf],
    commands: ['gantt', 'sched'],
    epitaphs: [],
  }),
  entry({
    id: CODEX_IDS.sjf,
    title: 'Shortest job first is optimal',
    chapter: cite('5.3.2', '5.8.2'),
    concept: 'Running the shortest job next provably minimises the average waiting time for a fixed set of jobs, because moving a short job ahead of a long one reduces the short job\'s wait by more than it raises the long job\'s. On the comparison set the margin over arrival order is 3.25 ticks. The catch is that the policy needs the next burst length before the burst runs, which no real system has; it estimates from history, and the estimate is wrong exactly when a Program changes its behaviour.',
    // Approximation: three gantt --replay invocations, counted without checking that the three policies are distinct and non-preemptive.
    unlock: { kind: 'command', name: 'gantt', flag: '--replay', nth: 3 },
    remedy: null,
    remedyVisibility: 'never',
    related: [CODEX_IDS.convoy, CODEX_IDS.criteria],
    commands: ['gantt', 'sched'],
    epitaphs: [],
  }),
  entry({
    id: CODEX_IDS.roundRobin,
    title: 'Round robin and the quantum',
    chapter: cite('5.3.3'),
    concept: 'Round robin gives each ready process one quantum in turn, so no process waits longer than the others\' quanta added together. That bound is what interactive work needs. The quantum can be wrong in two directions: set near one tick, the processor spends its time saving and restoring registers; set above the longest burst, every job finishes inside its slice and the policy degenerates into first come first served. The useful range is a small multiple of the typical burst.',
    // Approximation: the map adds this on the first quantum change under rr; the arm fires on any sched --quantum.
    unlock: { kind: 'command', name: 'sched', flag: '--quantum' },
    remedy: { kind: 'adjust_quantum', direction: 'increase' },
    remedyVisibility: 'on_unlock',
    related: [CODEX_IDS.preemption, CODEX_IDS.criteria, CODEX_IDS.mlfq],
    commands: ['sched', 'gantt', 'top'],
    epitaphs: [],
  }),
  entry({
    id: CODEX_IDS.starvation,
    title: 'Priority scheduling and indefinite blocking',
    chapter: cite('5.3.4'),
    concept: 'The convoy comes over this pass under priority scheduling with aging switched off, which is a legal and ordinary configuration. Priority picks the ready process with the lowest priority number, every time, so a process with a high number runs only when nothing above it is ready, and on a busy system that moment never comes; it is not blocked, not faulted and not wrong, it is simply never chosen. Aging is the structural fix: every interval a process spends ready raises its priority one level, so waiting is itself a path to the front. Raising one process by hand fixes that process once and leaves the policy that starved it in place.',
    // Exact: the first process.starving event, at either severity, so the remedy is readable before the fatal threshold.
    unlock: { kind: 'event', type: 'process.starving' },
    remedy: { kind: 'set_scheduler', to: 'priority_aging' },
    remedyVisibility: 'on_unlock',
    related: [CODEX_IDS.criteria, CODEX_IDS.mlfq],
    commands: ['sched', 'nice', 'ps'],
    epitaphs: ['ep.quantum_pass.sable_never_ran', 'ep.quantum_pass.went_last'],
  }),
  entry({
    id: CODEX_IDS.mlfq,
    title: 'Multilevel feedback queues',
    chapter: cite('5.3.5', '5.3.6'),
    concept: 'A multilevel feedback queue is several round-robin queues at different priorities with different quanta. A process that uses its whole slice drops a level; a process that gives the processor up early stays where it is. The queue a process settles in is therefore a measurement of its burst length that the scheduler makes without being told anything, which separates interactive work from CPU-bound work by behaviour alone. Aging promotes a process that has waited too long, so the bottom level is survivable.',
    // Exact: the first sched --levels invocation.
    unlock: { kind: 'command', name: 'sched', flag: '--levels' },
    remedy: null,
    remedyVisibility: 'never',
    related: [CODEX_IDS.roundRobin, CODEX_IDS.starvation],
    commands: ['sched', 'gantt'],
    epitaphs: [],
  }),
  entry({
    id: CODEX_IDS.preemption,
    title: 'What preemption costs',
    chapter: cite('5.1.3', '5.3.3'),
    concept: 'Preemption buys bounded response time: a newly ready process gets the processor within one quantum of everyone else. It charges a context switch each time, and a switch is real processor time spent on saving and restoring state rather than on work. On the ribbon the cost is drawn as a gap between bands; at a small quantum the gaps become wider than the work. Response time improves by a fraction of a tick while utilisation falls by a fifth, and both halves of that trade are in one chart.',
    // Approximation: the map adds this when switch overhead first exceeds 15 percent of total CPU; the metric id follows WP-21's example and no telemetry publishes it yet.
    unlock: { kind: 'metric', id: 'scheduling.contextSwitchOverhead', above: 0.15 },
    remedy: { kind: 'adjust_quantum', direction: 'increase' },
    remedyVisibility: 'on_unlock',
    related: [CODEX_IDS.roundRobin, CODEX_IDS.criteria],
    commands: ['gantt', 'sched', 'top'],
    epitaphs: [],
  }),
];

export const OBJECTIVE_FOR_CODEX: Readonly<Record<string, string | null>> = {
  [CODEX_IDS.criteria]: null,
  [CODEX_IDS.convoy]: OBJECTIVE_IDS.avoidConvoyEffect,
  [CODEX_IDS.sjf]: OBJECTIVE_IDS.sjfIsOptimal,
  [CODEX_IDS.roundRobin]: OBJECTIVE_IDS.quantumSizing,
  [CODEX_IDS.starvation]: OBJECTIVE_IDS.clearStarvation,
  [CODEX_IDS.mlfq]: OBJECTIVE_IDS.tuneMlfq,
  [CODEX_IDS.preemption]: OBJECTIVE_IDS.switchRate,
};

/* ------------------------------------------------------------------ */
/* Debrief phrases                                                     */
/* ------------------------------------------------------------------ */

export const HEADLINE_CLEAN = 'Over the pass.';
export const headlineStarved = (name: string): string => `${name} never ran.`;

export const WHY_STARVED = 'A priority policy selects the lowest priority number that is ready. With aging disabled there is no path from waiting to the front except becoming more urgent, and nothing was going to make it more urgent.';
export const WHY_CONVOY = 'First come first served ran the long job to completion while two three-tick jobs waited behind all of it. Nothing failed. The ordering was the cost.';
export const whySwitchOverhead = (quantum: number, median: number): string => `The quantum was ${quantum} against the sweep stream's median burst of ${median}. Almost no burst finished inside a slice, so almost every slice ended in a save and a restore.`;
export const whyClean = (changes: number): string => `You changed policy ${changes} times and each change was in response to something on the ribbon.`;
