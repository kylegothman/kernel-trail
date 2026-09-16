/**
 * KERNEL TRAIL: Quantum Pass, the replay machinery behind `gantt --replay`
 * and the debrief counterfactual.
 *
 * A shadow run is a fresh kernel built the way the live one was, driven by
 * the game layer's own replay loop (`runReplay`, architecture 8.6) with the
 * leg's recorded decisions applied at their ticks and one policy substituted.
 * The leg never constructs a kernel itself: the architecture matrix lets a
 * leg import the kernel as types only, and the replay loop already knows how
 * a decision lands. Two shapes of shadow run share the road:
 *
 * - `shadowLeg` mirrors the live leg: the same roster and segments, the same
 *   entry pace and therefore the same arrivals, the same decision log minus
 *   the scheduler changes, for the same number of ticks. Replaying the live
 *   policy reproduces the live event log byte for byte; replaying another
 *   policy is the counterfactual.
 * - `replayArrivalSet` runs one arrival set alone to completion, which is
 *   what reproduces sim spec 16.3's numbers to the tick and what
 *   `gantt --replay` prints for a segment.
 *
 * Every number the debrief quotes comes out of one of these two runs. The
 * shadow kernel emits into its own log, never the live stream, and mutates a
 * store of its own, never the live `RunState`.
 */
import type { KernelConfig, KernelEvent, KernelSnapshot, Pid, ProcessControlBlock, SchedulerId, SchedulerParams, SchedulingMetrics, Tick } from '@kernel/types';
import { hashEventLog } from '@game/replay/hash';
import { initialRunState, runReplay } from '@game/replay/runReplay';
import { REPLAY_KERNEL_OPTIONS, type HeadlessLeg, type ReplayHooks, type ReplayOverrides } from '@game/replay/types';
import type { DecisionRecord, DifficultyTier, DiscClass, LegOutcome, LegSetupContext, Pace, ProcessSpec, RunState } from '@game/types';
import { kernelConfig } from './config';
import { LEG_ID } from './decisions';
import { populate } from './populate';
import { PAGES_PER_WORKLOAD, type ArrivalRow } from './segments';

/** One band of the Gantt ribbon: a process holding the CPU over a textbook interval. */
export interface RibbonSegment {
  readonly pid: Pid;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** A context switch's cost drawn as area: the tick it landed and the ticks it charged. */
export interface RibbonGap {
  readonly at: number;
  readonly width: number;
}

export interface Ribbon {
  readonly segments: readonly RibbonSegment[];
  readonly gaps: readonly RibbonGap[];
  readonly ticks: number;
}

export interface ProcessMetrics {
  readonly pid: Pid;
  readonly name: string;
  readonly arrival: number;
  readonly firstRun: number | null;
  readonly completion: number | null;
  readonly waiting: number | null;
  readonly turnaround: number | null;
  readonly response: number | null;
}

export interface ShadowRun {
  readonly policy: SchedulerId;
  readonly ticks: number;
  /** The kernel at the tick the shadow stopped; null only when the run never stepped. */
  readonly snapshot: KernelSnapshot | null;
  readonly events: readonly KernelEvent[];
  readonly hash: string;
  readonly ribbon: Ribbon;
  readonly metrics: SchedulingMetrics;
  readonly perProcess: readonly ProcessMetrics[];
  readonly processes: readonly Readonly<ProcessControlBlock>[];
  /** Pids terminated by the starvation detector. */
  readonly starved: readonly Pid[];
  readonly fatalStarvations: number;
  readonly contextSwitches: number;
  readonly quantumExpiries: number;
}

const NEUTRAL: LegOutcome = {
  survived: true, objectivesMet: [], casualties: [], resourceDelta: {}, codexUnlocked: [],
  debrief: { headline: 'shadow', whatHappened: '', whyItHappened: '', counterfactual: null, chapter: { chapter: 5, title: 'CPU Scheduling', sections: [] } },
};

interface ShadowInput {
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  readonly pace: Pace;
  readonly config: KernelConfig;
  readonly populate: (ctx: LegSetupContext) => void;
  readonly decisions: readonly DecisionRecord[];
  readonly overrides: ReplayOverrides;
  /** Stop after this many ticks; null runs until the workload drains. */
  readonly ticks: number | null;
  readonly maxTicks: number;
  readonly degreeOfMultiprogramming?: number;
  /** Zero for the textbook sets: the engine charges every process two ticks of thread creation (amendment 2), which the textbook figures do not carry. */
  readonly threadCreateTicks?: number;
}

const NAME_SEQ_LIMIT = 4096;

function drive(input: ShadowInput): { readonly events: readonly KernelEvent[]; readonly snapshot: KernelSnapshot | null; readonly ticks: number } {
  const events: KernelEvent[] = [];
  let snapshot: KernelSnapshot | null = null;
  let ticks = 0;
  const seen = new Set<number>();
  const hooks: ReplayHooks = {
    enter: (_streams, store) => {
      store.mutate((run) => { run.policy = { ...run.policy, pace: input.pace }; });
    },
    afterStep: (tick, _kernel, stepped) => {
      ticks = tick;
      for (const event of stepped) {
        if (seen.has(event.seq)) continue;
        seen.add(event.seq);
        events.push(event);
      }
    },
    isComplete: (tick, kernel) => {
      const done = input.ticks === null ? kernel.processes.every((p) => p.pid <= 1 || p.state === 'terminated') : tick >= input.ticks;
      if (done && snapshot === null) {
        snapshot = kernel.snapshot();
        ticks = tick;
        // Decisions applied at the final boundary emit after the last step; keep them.
        for (const event of kernel.invariantState().lastFrame) {
          if (seen.has(event.seq)) continue;
          seen.add(event.seq);
          events.push(event);
        }
      }
      return done;
    },
  };
  const leg: HeadlessLeg = {
    id: LEG_ID, index: 3,
    kernelConfig: () => input.config,
    populate: input.populate,
    eventTable: [],
    evaluate: () => NEUTRAL,
    hooks,
  };
  const response = runReplay({
    seed: input.seed, discClass: input.discClass, difficulty: input.difficulty, legs: [LEG_ID],
    decisions: input.decisions, overrides: input.overrides, maxTicks: input.maxTicks,
  }, {
    legs: () => leg,
    kernelOptions: {
      ...REPLAY_KERNEL_OPTIONS,
      ...(input.degreeOfMultiprogramming === undefined ? {} : { degreeOfMultiprogramming: input.degreeOfMultiprogramming, maxProcesses: Math.max(64, input.degreeOfMultiprogramming) }),
      ...(input.threadCreateTicks === undefined ? {} : { threadCreateTicks: input.threadCreateTicks }),
    },
  });
  if (!response.ok) throw new Error(`quantum_pass shadow run failed: ${response.message}`);
  events.sort((a, b) => a.seq - b.seq);
  return { events, snapshot, ticks };
}

/** The Gantt ribbon from `context.switch` and `process.exited`, the same boundary convention as the textbook figures. */
export function ribbonOf(events: readonly KernelEvent[], names: ReadonlyMap<Pid, string>, ticks: number, switchCost: number): Ribbon {
  const segments: RibbonSegment[] = [];
  const gaps: RibbonGap[] = [];
  let active: { pid: Pid; start: number } | null = null;
  const close = (end: number): void => {
    if (active === null) return;
    if (end > active.start) segments.push({ pid: active.pid, name: names.get(active.pid) ?? `P${active.pid}`, start: active.start, end });
    active = null;
  };
  for (const event of events) {
    if (event.type === 'context.switch') {
      const start = event.tick - 1;
      close(start);
      if (event.to !== null) {
        active = { pid: event.to, start };
        if (switchCost > 0) gaps.push({ at: start, width: switchCost });
      }
    } else if (event.type === 'process.exited') {
      if (active?.pid === event.pid) close(event.tick);
    }
  }
  close(ticks);
  return { segments, gaps, ticks };
}

/** Per-process waiting, turnaround and response from the log, with the textbook's boundary convention; null where the process never completed or ran. */
export function perProcessOf(events: readonly KernelEvent[], names: ReadonlyMap<Pid, string>): readonly ProcessMetrics[] {
  const arrivals = new Map<Pid, number>();
  const firstRuns = new Map<Pid, number>();
  const completions = new Map<Pid, number>();
  const service = new Map<Pid, number>();
  let running: Pid | null = null;
  let sinceTick = 0;
  const credit = (upTo: number): void => {
    if (running !== null && upTo > sinceTick) service.set(running, (service.get(running) ?? 0) + (upTo - sinceTick));
  };
  for (const event of events) {
    if (event.type === 'process.state_changed' && event.from === 'new' && event.to === 'ready') arrivals.set(event.pid, event.tick - 1);
    else if (event.type === 'context.switch') {
      credit(event.tick - 1);
      running = event.to;
      sinceTick = event.tick - 1;
      if (event.to !== null && !firstRuns.has(event.to)) firstRuns.set(event.to, event.tick - 1);
    } else if (event.type === 'process.exited') {
      if (running === event.pid) { credit(event.tick); running = null; }
      completions.set(event.pid, event.tick);
    }
  }
  const rows: ProcessMetrics[] = [];
  for (const [pid, arrival] of [...arrivals].sort((a, b) => a[0] - b[0])) {
    const firstRun = firstRuns.get(pid) ?? null;
    const completion = completions.get(pid) ?? null;
    const served = service.get(pid) ?? 0;
    const turnaround = completion === null ? null : completion - arrival;
    rows.push({
      pid, name: names.get(pid) ?? `P${pid}`, arrival, firstRun, completion,
      turnaround, waiting: turnaround === null ? null : turnaround - served, response: firstRun === null ? null : firstRun - arrival,
    });
  }
  return rows;
}

export function namesOf(events: readonly KernelEvent[]): ReadonlyMap<Pid, string> {
  const names = new Map<Pid, string>();
  for (const event of events) if (event.type === 'process.created') names.set(event.pid, event.name);
  return names;
}

function finish(policy: SchedulerId, events: readonly KernelEvent[], snapshot: KernelSnapshot | null, ticks: number, switchCost: number): ShadowRun {
  const names = namesOf(events);
  const starved = events.filter((event): event is Extract<KernelEvent, { type: 'process.exited' }> => event.type === 'process.exited' && event.reason === 'starvation').map((event) => event.pid);
  return {
    policy, ticks, snapshot, events, hash: hashEventLog(events),
    ribbon: ribbonOf(events, names, ticks, switchCost),
    metrics: snapshot?.metrics.scheduling ?? { averageWaitingTime: 0, averageTurnaroundTime: 0, averageResponseTime: 0, throughput: 0, cpuUtilisation: 0, contextSwitches: 0, worstWait: 0 },
    perProcess: perProcessOf(events, names),
    processes: snapshot?.processes ?? [],
    starved,
    fatalStarvations: events.filter((event) => event.type === 'process.starving' && event.fatal).length,
    contextSwitches: events.filter((event) => event.type === 'context.switch').length,
    quantumExpiries: events.filter((event) => event.type === 'quantum.expired').length,
  };
}

export interface ShadowLegInput {
  readonly run: Readonly<RunState>;
  readonly pace: Pace;
  readonly ticks: number;
  readonly policy: SchedulerId;
  readonly quantum?: number;
  /** True keeps the player's own scheduler changes and applies the policy at entry only (the byte-for-byte mirror); false replaces them all. */
  readonly keepRecordedChanges: boolean;
  readonly switchCost?: number;
}

/** The live leg again with one policy in place of the player's, from the entry configuration. */
export function shadowLeg(input: ShadowLegInput): ShadowRun {
  const entry = initialRunState(input.run.seed, input.run.discClass, input.run.difficulty);
  entry.policy = { ...entry.policy, pace: input.pace };
  const config = kernelConfig(entry);
  const decisions = input.run.decisions.filter((record) => record.legId === LEG_ID);
  const overrides: ReplayOverrides = input.keepRecordedChanges
    ? { suppressRecordedPolicyChanges: false }
    : { scheduler: input.policy, ...(input.quantum === undefined ? {} : { quantum: input.quantum }), suppressRecordedPolicyChanges: true };
  const driven = drive({
    seed: input.run.seed, discClass: input.run.discClass, difficulty: input.run.difficulty, pace: input.pace,
    config: input.keepRecordedChanges ? { ...config, scheduler: input.policy } : config,
    populate, decisions, overrides, ticks: input.ticks, maxTicks: Math.max(input.ticks + 1, NAME_SEQ_LIMIT),
  });
  return finish(input.policy, driven.events, driven.snapshot, driven.ticks, input.switchCost ?? 1);
}

export interface ArrivalSetInput {
  readonly rows: readonly ArrivalRow[];
  readonly policy: SchedulerId;
  readonly params?: Partial<SchedulerParams>;
  readonly seed?: number;
  readonly maxTicks?: number;
  readonly switchCost?: number;
}

/** One arrival set alone, from tick 0 to completion, under the named policy: the textbook figure. */
export function replayArrivalSet(input: ArrivalSetInput): ShadowRun {
  const seed = input.seed ?? 0x4b54524c;
  const entry = initialRunState(seed, 'shell', 'operator');
  const base = kernelConfig(entry);
  const params: SchedulerParams = { ...base.schedulerParams, ...input.params };
  const config: KernelConfig = { ...base, scheduler: input.policy, schedulerParams: params };
  const specs: readonly ProcessSpec[] = input.rows.map((row) => ({ name: row.name, priority: row.priority, burst: row.burst, service: row.service, arrival: row.arrival + 1, pages: PAGES_PER_WORKLOAD }));
  const driven = drive({
    seed, discClass: 'shell', difficulty: 'operator', pace: 'steady', config,
    populate: (ctx) => { for (const spec of specs) ctx.spawn(spec); },
    decisions: [], overrides: { quantum: params.quantum, suppressRecordedPolicyChanges: true },
    ticks: null, maxTicks: input.maxTicks ?? NAME_SEQ_LIMIT, degreeOfMultiprogramming: Math.max(64, specs.length + 2), threadCreateTicks: 0,
  });
  return finish(input.policy, driven.events, driven.snapshot, driven.ticks, input.switchCost ?? 1);
}

export function renderRibbon(ribbon: Ribbon): string {
  return ribbon.segments.map((segment) => `${segment.name}[${segment.start}-${segment.end}]`).join(' ');
}

/** The first tick at which two ribbons make different decisions, or null when they agree. */
export function divergenceTick(a: Ribbon, b: Ribbon): number | null {
  const holder = (ribbon: Ribbon, tick: number): string | null => ribbon.segments.find((segment) => segment.start <= tick && tick < segment.end)?.name ?? null;
  const span = Math.max(a.ticks, b.ticks);
  for (let tick = 0; tick < span; tick++) if (holder(a, tick) !== holder(b, tick)) return tick;
  return null;
}

/** Averages over the named processes only, from a shadow run's per-process rows; null when none of them completed. */
export function segmentAverages(run: ShadowRun, names: readonly string[]): { readonly waiting: number; readonly turnaround: number; readonly response: number; readonly completed: number } | null {
  const rows = run.perProcess.filter((row) => names.includes(row.name) && row.waiting !== null && row.turnaround !== null && row.response !== null);
  if (rows.length === 0) return null;
  const sum = (pick: (row: ProcessMetrics) => number | null): number => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
  return { waiting: sum((row) => row.waiting) / rows.length, turnaround: sum((row) => row.turnaround) / rows.length, response: sum((row) => row.response) / rows.length, completed: rows.length };
}

export type { Tick };
