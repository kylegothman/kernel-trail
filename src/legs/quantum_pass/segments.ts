/**
 * KERNEL TRAIL: Quantum Pass, the arrival sets.
 *
 * Two kinds of data live here. The leg's own population is the convoy roster
 * plus four designed segments, sized to the seventy-tick leg the runner plays
 * at steady pace (LEG_SEGMENTS.quantum_pass is 70, one segment per tick).
 * The thirteen `SCHED-*` fixture rows of sim spec 16.3 are transcribed beside
 * them, so `gantt --replay` and the fixture suite run the textbook sets
 * through the same replay road as the live segments.
 *
 * Arrival convention: the kernel's first service interval is tick 1 and the
 * textbook's is interval 0, so a textbook arrival `a` is spawned with
 * `arrival: a + 1` (tests/kernel/scheduler/workloadRunner.ts). Both tables
 * store textbook arrivals; `toSpecs` adds the one.
 */
import type { ConvoyMemberId, SchedulerId, SchedulerParams } from '@kernel/types';
import type { ProcessSpec } from '@game/types';

export interface ArrivalRow {
  readonly name: string;
  /** Textbook arrival; interval 0 is the kernel's tick 1. */
  readonly arrival: number;
  readonly burst: number;
  readonly service: number;
  readonly priority: number;
}

export interface Segment {
  readonly index: 1 | 2 | 3 | 4;
  readonly id: 'convoy_effect' | 'sjf_comparison' | 'switch_rate' | 'mlfq';
  readonly title: string;
  readonly rows: readonly ArrivalRow[];
  /** False for an arrival set the leg holds for `gantt --replay` without spawning it: the seventy-tick pass has no room to run it live. */
  readonly live: boolean;
  /** The three non-preemptive policies `gantt --replay` may name on this set. */
  readonly nonPreemptive: readonly SchedulerId[];
}

export const NON_PREEMPTIVE: readonly SchedulerId[] = ['fcfs', 'sjf', 'priority'];
export const PREEMPTIVE: readonly SchedulerId[] = ['srtf', 'rr', 'mlfq'];
export const ALL_POLICIES: readonly SchedulerId[] = ['fcfs', 'sjf', 'srtf', 'priority', 'priority_aging', 'rr', 'mlfq'];

export const PAGES_PER_PROGRAM = 6;
export const PAGES_PER_WORKLOAD = 3;

/**
 * The convoy. SABLE carries the high priority number, which under Silberschatz's
 * convention is the low priority, and the longest service in the convoy: she is
 * the one the pass starves. The other four sit at 1 to 3 and run early under
 * every policy, and the whole convoy arrives together so that no Program but
 * SABLE waits long enough for a warning it does not deserve. Bursts are raw;
 * the engine charges two ticks of thread creation on top of every process
 * (amendment 2), so a burst of one holds the processor for three.
 */
export const ROSTER: readonly { readonly member: ConvoyMemberId; readonly name: string; readonly priority: number; readonly burst: number; readonly service: number; readonly arrival: number }[] = [
  { member: 'lumen', name: 'LUMEN', priority: 2, burst: 1, service: 1, arrival: 0 },
  { member: 'sable', name: 'SABLE', priority: 5, burst: 3, service: 3, arrival: 0 },
  { member: 'orrery', name: 'ORRERY', priority: 1, burst: 1, service: 1, arrival: 0 },
  { member: 'kestrel', name: 'KESTREL', priority: 1, burst: 1, service: 1, arrival: 0 },
  { member: 'vesper', name: 'VESPER', priority: 2, burst: 1, service: 1, arrival: 0 },
];

/**
 * Segment 1, the convoy effect: one long job ahead of two short ones, which is
 * `SCHED-FCFS-1`'s shape exactly. The checks sit one priority level above the
 * haul, so the entry policy already declines the arrival order; first come
 * first served, replayed over the same leg, is the baseline the objective is
 * measured against.
 */
const CONVOY_EFFECT: Segment = {
  index: 1, id: 'convoy_effect', title: 'the convoy effect', live: true,
  rows: [
    { name: 'pass.haul', arrival: 0, burst: 5, service: 5, priority: 3 },
    { name: 'pass.check_a', arrival: 0, burst: 1, service: 1, priority: 2 },
    { name: 'pass.check_b', arrival: 0, burst: 1, service: 1, priority: 2 },
  ],
  nonPreemptive: NON_PREEMPTIVE,
};

/** Segment 2, the SJF comparison set: SCHED-SJF-1 exactly, held for `gantt --replay` (sjf 7.0 against fcfs 10.25, a margin of 3.25). */
const SJF_COMPARISON: Segment = {
  index: 2, id: 'sjf_comparison', title: 'the shortest-job comparison', live: false,
  rows: [
    { name: 'pass.sjf_1', arrival: 0, burst: 6, service: 6, priority: 3 },
    { name: 'pass.sjf_2', arrival: 0, burst: 8, service: 8, priority: 3 },
    { name: 'pass.sjf_3', arrival: 0, burst: 7, service: 7, priority: 3 },
    { name: 'pass.sjf_4', arrival: 0, burst: 3, service: 3, priority: 3 },
  ],
  nonPreemptive: NON_PREEMPTIVE,
};

/**
 * Segment 3, the maintenance sweep of the event table: four arrivals at
 * priority 4, one level above SABLE and below everything else on the board.
 * They arrive early and queue, which is the point. A stream that arrives just
 * in time leaves gaps, and a single idle tick is enough for a priority policy
 * to dispatch SABLE and reset her wait counter, so the sweep is what makes the
 * exclusion continuous rather than nearly continuous.
 *
 * Each sweep arrives as the one before it takes the processor, so the stream
 * is a pipeline rather than a pile: the queue behind the running process stays
 * one deep, which is what keeps the leg's waiting and response times inside
 * the targets while the exclusion stays unbroken. A stream that arrives all at
 * once would starve itself, and one that arrives late would leave an idle tick,
 * and a single idle tick is enough for a priority policy to dispatch SABLE and
 * reset her wait counter.
 *
 * It is also the set the quantum is sized against: bursts 2 and 6, median 4,
 * so `obj.quantum_pass.quantum_sizing` admits 4.8 through 16. Steady's 8 and
 * conservative's 16 pass; aggressive's 4 and reckless's 2 fail.
 */
const SWITCH_RATE: Segment = {
  index: 3, id: 'switch_rate', title: 'the priority sweep', live: true,
  rows: [
    { name: 'pass.sweep_1', arrival: 22, burst: 2, service: 2, priority: 4 },
    { name: 'pass.sweep_2', arrival: 26, burst: 6, service: 6, priority: 4 },
  ],
  nonPreemptive: NON_PREEMPTIVE,
};

/**
 * Segment 4, the feedback queue's set: `SCHED-MLFQ-1`'s shape, one CPU-bound
 * job and two taps. The grind's eleven ticks of burst plus the two the engine
 * charges for thread creation are thirteen ticks of processor time, which is
 * one more than the twelve a process must spend to expire the level-0 quantum
 * of four and the level-1 quantum of eight and settle at level 2. Each tap
 * finishes inside one level-0 quantum and stays where it started, which is the
 * distinction the queue is there to make without being told.
 *
 * The taps arrive while the grind is still inside its first level-0 quantum,
 * which matters under the engine's default per-slice accounting: a level-0
 * arrival preempts a lower-level process and resets its slice, so a tap that
 * landed in the middle of the grind's level-1 quantum would keep resetting it
 * and the grind would never reach level 2.
 */
const MLFQ: Segment = {
  index: 4, id: 'mlfq', title: 'the feedback queue', live: true,
  rows: [
    { name: 'pass.grind', arrival: 36, burst: 11, service: 11, priority: 3 },
    { name: 'pass.tap_a', arrival: 44, burst: 1, service: 1, priority: 3 },
    { name: 'pass.tap_b', arrival: 46, burst: 1, service: 1, priority: 3 },
  ],
  nonPreemptive: NON_PREEMPTIVE,
};

export const SEGMENTS: readonly Segment[] = [CONVOY_EFFECT, SJF_COMPARISON, SWITCH_RATE, MLFQ];
/** The segments `populate` spawns, in arrival order. */
export const LIVE_SEGMENTS: readonly Segment[] = SEGMENTS.filter((candidate) => candidate.live);

export function segment(index: Segment['index']): Segment {
  const found = SEGMENTS.find((candidate) => candidate.index === index);
  if (found === undefined) throw new Error(`quantum_pass: no segment ${index}`);
  return found;
}

/** The segment a workload name belongs to, or null for a convoy Program. */
export function segmentOf(name: string): Segment | null {
  return SEGMENTS.find((candidate) => candidate.rows.some((row) => row.name === name)) ?? null;
}

/** Textbook rows to spawn specs: arrival plus one, pages fixed. */
export function toSpecs(rows: readonly ArrivalRow[], pages = PAGES_PER_WORKLOAD): readonly ProcessSpec[] {
  return rows.map((row) => ({ name: row.name, priority: row.priority, burst: row.burst, service: row.service, arrival: row.arrival + 1, pages }));
}

/** The median of the segment's bursts, computed rather than hardcoded. */
export function medianBurst(rows: readonly ArrivalRow[]): number {
  const sorted = rows.map((row) => row.burst).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (high === undefined) return 0;
  return sorted.length % 2 === 0 && low !== undefined ? (low + high) / 2 : high;
}

/* ------------------------------------------------------------------ */
/* Sim spec 16.3, the thirteen SCHED fixtures, verbatim                */
/* ------------------------------------------------------------------ */

export interface SchedFixture {
  readonly id: string;
  readonly policy: SchedulerId;
  readonly params: Partial<SchedulerParams>;
  readonly rows: readonly ArrivalRow[];
  readonly gantt: string | null;
  readonly averages: { readonly waiting: number; readonly turnaround: number; readonly response: number };
  readonly worstWait?: number;
  readonly dispatches?: number;
  readonly perProcess?: Readonly<Record<string, { readonly waiting: number; readonly turnaround: number; readonly response: number }>>;
  readonly finalLevels?: Readonly<Record<string, number>>;
}

const row = (name: string, arrival: number, burst: number, priority = 20): ArrivalRow => ({ name, arrival, burst, service: burst, priority });

const FCFS_SET = [row('P1', 0, 24), row('P2', 0, 3), row('P3', 0, 3)];
const SJF_SET = [row('P1', 0, 6), row('P2', 0, 8), row('P3', 0, 7), row('P4', 0, 3)];
const SRTF_SET = [row('P1', 0, 8), row('P2', 1, 4), row('P3', 2, 9), row('P4', 3, 5)];
const AGING_SET = [row('PL', 0, 5, 5), row('H1', 0, 4, 1), row('H2', 4, 4, 1), row('H3', 8, 4, 1), row('H4', 12, 4, 1)];

export const SCHED_FIXTURES: readonly SchedFixture[] = [
  { id: 'SCHED-FCFS-1', policy: 'fcfs', params: {}, rows: FCFS_SET, gantt: 'P1[0-24] P2[24-27] P3[27-30]', averages: { waiting: 17, turnaround: 27, response: 17 } },
  { id: 'SCHED-FCFS-2', policy: 'fcfs', params: {}, rows: [row('P2', 0, 3), row('P3', 0, 3), row('P1', 0, 24)], gantt: 'P2[0-3] P3[3-6] P1[6-30]', averages: { waiting: 3, turnaround: 13, response: 3 } },
  { id: 'SCHED-SJF-1', policy: 'sjf', params: {}, rows: SJF_SET, gantt: 'P4[0-3] P1[3-9] P3[9-16] P2[16-24]', averages: { waiting: 7, turnaround: 13, response: 7 } },
  { id: 'SCHED-SJF-1F', policy: 'fcfs', params: {}, rows: SJF_SET, gantt: 'P1[0-6] P2[6-14] P3[14-21] P4[21-24]', averages: { waiting: 10.25, turnaround: 16.25, response: 10.25 } },
  {
    id: 'SCHED-SRTF-1', policy: 'srtf', params: {}, rows: SRTF_SET, gantt: 'P1[0-1] P2[1-5] P4[5-10] P1[10-17] P3[17-26]',
    averages: { waiting: 6.5, turnaround: 13, response: 4.25 },
    perProcess: { P1: { waiting: 9, turnaround: 17, response: 0 }, P2: { waiting: 0, turnaround: 4, response: 0 }, P3: { waiting: 15, turnaround: 24, response: 15 }, P4: { waiting: 2, turnaround: 7, response: 2 } },
  },
  { id: 'SCHED-SRTF-1S', policy: 'sjf', params: {}, rows: SRTF_SET, gantt: 'P1[0-8] P2[8-12] P4[12-17] P3[17-26]', averages: { waiting: 7.75, turnaround: 14.25, response: 7.75 } },
  {
    id: 'SCHED-PRIO-1', policy: 'priority', params: { preemptive: false }, rows: [row('P1', 0, 10, 3), row('P2', 0, 1, 1), row('P3', 0, 2, 4), row('P4', 0, 1, 5), row('P5', 0, 5, 2)],
    gantt: 'P2[0-1] P5[1-6] P1[6-16] P3[16-18] P4[18-19]', averages: { waiting: 8.2, turnaround: 12, response: 8.2 },
    perProcess: { P1: { waiting: 6, turnaround: 16, response: 6 }, P2: { waiting: 0, turnaround: 1, response: 0 }, P3: { waiting: 16, turnaround: 18, response: 16 }, P4: { waiting: 18, turnaround: 19, response: 18 }, P5: { waiting: 1, turnaround: 6, response: 1 } },
  },
  { id: 'SCHED-AGING-1A', policy: 'priority', params: { preemptive: false, agingInterval: 0 }, rows: AGING_SET, gantt: 'H1[0-4] H2[4-8] H3[8-12] H4[12-16] PL[16-21]', averages: { waiting: 3.2, turnaround: 7.4, response: 3.2 }, worstWait: 16 },
  { id: 'SCHED-AGING-1B', policy: 'priority_aging', params: { preemptive: false, agingInterval: 2 }, rows: AGING_SET, gantt: 'H1[0-4] H2[4-8] PL[8-13] H3[13-17] H4[17-21]', averages: { waiting: 3.6, turnaround: 7.8, response: 3.6 }, worstWait: 8 },
  { id: 'SCHED-RR-1', policy: 'rr', params: { quantum: 4 }, rows: FCFS_SET, gantt: 'P1[0-4] P2[4-7] P3[7-10] P1[10-30]', averages: { waiting: 5.666667, turnaround: 15.666667, response: 3.666667 }, dispatches: 4 },
  { id: 'SCHED-RR-2a', policy: 'rr', params: { quantum: 1 }, rows: FCFS_SET, gantt: null, averages: { waiting: 5.666667, turnaround: 15.666667, response: 1 }, dispatches: 10 },
  { id: 'SCHED-RR-2c', policy: 'rr', params: { quantum: 24 }, rows: FCFS_SET, gantt: 'P1[0-24] P2[24-27] P3[27-30]', averages: { waiting: 17, turnaround: 27, response: 17 } },
  {
    id: 'SCHED-MLFQ-1', policy: 'mlfq', params: { levelQuanta: [4, 8, 16], agingInterval: 50 }, rows: [row('P1', 0, 20), row('P2', 0, 6), row('P3', 10, 4)],
    gantt: 'P1[0-4] P2[4-8] P1[8-10] P3[10-14] P2[14-16] P1[16-30]', averages: { waiting: 6.666667, turnaround: 16.666667, response: 1.333333 },
    perProcess: { P1: { waiting: 10, turnaround: 30, response: 0 }, P2: { waiting: 10, turnaround: 16, response: 4 }, P3: { waiting: 0, turnaround: 4, response: 0 } },
    finalLevels: { P1: 2, P2: 1, P3: 0 }, dispatches: 6,
  },
];
