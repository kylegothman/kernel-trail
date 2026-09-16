/**
 * KERNEL TRAIL: Quantum Pass, judged at leg end.
 *
 * Everything here is read from three sources and nothing else: the kernel
 * event log the runner passes (narrowed by `asKernelEvents`), the closing
 * kernel snapshot, and the decision log. The counterfactual is a real shadow
 * replay through `replay.ts`, never a text template.
 */
import type { ConvoyMemberId, KernelEvent, Pid, ProcessControlBlock, SchedulerId } from '@kernel/types';
import { PACE_TABLE } from '@game/travel/paceRations';
import type { DebriefCard, LegEvaluationContext, LegOutcome, Pace, RunState } from '@game/types';
import { asKernelEvents } from '@legs/events';
import { cite } from './chapters';
import { AGING_INTERVAL, SWITCH_COST, quantumForPace } from './config';
import { CODEX_IDS, HEADLINE_CLEAN, WHY_CONVOY, WHY_STARVED, headlineStarved, whyClean, whySwitchOverhead } from './copy';
import { LEG_ID, legDecisions, policyChanges, policyTimeline, replayInvocations, schedulerAt, terminalLines, type PolicySpan } from './decisions';
import { OBJECTIVE_IDS } from './objectives';
import { namesOf, perProcessOf, replayArrivalSet, segmentAverages, shadowLeg, type ProcessMetrics, type ShadowRun } from './replay';
import { ALL_POLICIES, LIVE_SEGMENTS, NON_PREEMPTIVE, PREEMPTIVE, ROSTER, SEGMENTS, medianBurst, segment, type Segment } from './segments';

export const WAITING_TARGET = 12;
export const RESPONSE_TARGET = 8;
export const OVERHEAD_LIMIT = 0.10;
export const SWITCH_RATE_LIMIT = 1 / 6;
export const CLEAR_WINDOW = 20;
export const CONVOY_MARGIN = 0.30;
export const QUANTUM_RANGE: readonly [number, number] = [1.2, 4.0];
/** The arrival the entry pace is read back from: segment 4's first row, which every pace admits well inside the leg. */
const PACE_MARKER = 'pass.grind';

/**
 * Every number an objective turns on, kept beside the verdict so the leg's own
 * suite asserts the arithmetic rather than the outcome, and so a balance pass
 * can read why a run missed a target.
 */
export interface Clauses {
  readonly averageWaitingTime: number;
  readonly averageResponseTime: number;
  readonly fatalStarvations: number;
  readonly distinctNonPreemptiveReplays: number;
  readonly sjfCommittedAfterReplays: boolean;
  readonly rrQuantum: number | null;
  readonly sweepMedianBurst: number;
  readonly rrOverhead: number | null;
  readonly convoyLiveWaiting: number | null;
  readonly convoyFcfsBaseline: number | null;
  readonly mlfqLevels: Readonly<Record<string, number | null>>;
  readonly worstWait: number;
  readonly preemptiveRate: number | null;
  readonly preemptiveSpanTicks: number;
  readonly preemptiveSwitches: number;
  readonly preemptivePreemptions: number;
  readonly preemptiveExpiries: number;
  readonly rrSpanTicks: number;
  readonly rrExpiries: number;
  readonly rrResponse: number | null;
  /** Leg-wide preemptions per tick: the overhead the player's dials actually control. */
  readonly preemptionRate: number;
}

export interface Assessment {
  readonly pace: Pace;
  readonly names: ReadonlyMap<Pid, string>;
  readonly pidOf: ReadonlyMap<string, Pid>;
  readonly members: ReadonlyMap<ConvoyMemberId, Pid>;
  readonly live: readonly ProcessMetrics[];
  readonly timeline: readonly PolicySpan[];
  readonly starvedMembers: readonly { readonly member: ConvoyMemberId; readonly tick: number }[];
  readonly firstWarning: { readonly pid: Pid; readonly member: ConvoyMemberId | null; readonly tick: number } | null;
  readonly met: readonly string[];
  readonly codex: readonly string[];
  readonly switchOverhead: number;
  readonly clauses: Clauses;
}

const memberByName = new Map(ROSTER.map((entry) => [entry.name, entry.member] as const));

/** The pace the leg entered at, read back from a marker process's transformed arrival in the closing snapshot; the run's current pace when the marker is absent. */
export function inferEntryPace(processes: readonly Readonly<ProcessControlBlock>[], fallback: Pace): Pace {
  const spec = SEGMENTS.flatMap((candidate) => candidate.rows).find((row) => row.name === PACE_MARKER);
  const pcb = processes.find((process) => process.name === PACE_MARKER);
  if (pcb === undefined || spec === undefined) return fallback;
  const arrival = spec.arrival + 1;
  for (const pace of ['conservative', 'steady', 'aggressive', 'reckless'] as const) {
    if (Math.round(arrival / PACE_TABLE[pace].workloadArrivalRate) === pcb.arrivalTick) return pace;
  }
  return fallback;
}

function quantumInForceAt(run: Readonly<RunState>, tick: number, entryPace: Pace): number {
  let quantum = quantumForPace(entryPace);
  for (const record of legDecisions(run)) {
    if (record.tick > tick) continue;
    if (record.kind === 'set_pace' && (record.choice === 'conservative' || record.choice === 'steady' || record.choice === 'aggressive' || record.choice === 'reckless')) quantum = quantumForPace(record.choice);
  }
  for (const change of policyChanges(run)) if (change.tick <= tick && change.quantum !== null) quantum = change.quantum;
  return quantum;
}

function spansOf(timeline: readonly PolicySpan[], policies: readonly SchedulerId[]): readonly PolicySpan[] {
  return timeline.filter((span) => policies.includes(span.policy) && span.to > span.from);
}

/**
 * The switches the quantum controls. A process that finishes hands the
 * processor on at any quantum, and no dial prevents that; a process taken off
 * the processor while it still has work is a preemption, and that is what a
 * quantum buys and charges for.
 *
 * The log distinguishes them by exit tick rather than by the switch tick. A
 * process exits inside phase 8 of one tick and the scheduler hands the
 * processor on in phase 7 of the next, so the switch away from a finished
 * process always carries a later tick than its `process.exited`. A switch away
 * from a process that has exited by then is voluntary; every other one is not.
 */
function preemptionsIn(events: readonly KernelEvent[], spans: readonly PolicySpan[]): { readonly preemptions: number; readonly switches: number; readonly expiries: number; readonly ticks: number } {
  const exitTick = new Map<Pid, number>();
  for (const event of events) if (event.type === 'process.exited' && !exitTick.has(event.pid)) exitTick.set(event.pid, event.tick);
  let preemptions = 0;
  let switches = 0;
  let expiries = 0;
  let ticks = 0;
  for (const span of spans) {
    ticks += span.to - span.from;
    for (const event of events) {
      if (event.tick <= span.from || event.tick > span.to) continue;
      if (event.type === 'quantum.expired') expiries += 1;
      if (event.type !== 'context.switch') continue;
      switches += 1;
      const left = event.from;
      if (left !== null && (exitTick.get(left) ?? Number.POSITIVE_INFINITY) > event.tick) preemptions += 1;
    }
  }
  return { preemptions, switches, expiries, ticks };
}

function policyDuring(run: Readonly<RunState>, from: number, to: number): readonly SchedulerId[] {
  const policies = new Set<SchedulerId>([schedulerAt(run, from)]);
  for (const change of policyChanges(run)) if (change.tick > from && change.tick <= to) policies.add(change.to);
  return [...policies];
}

export function assess(ctx: LegEvaluationContext): Assessment {
  const events = asKernelEvents(ctx.events);
  const run = ctx.run;
  const ticks = ctx.ticksElapsed;
  const names = namesOf(events);
  const pidOf = new Map([...names].map(([pid, name]) => [name, pid] as const));
  const members = new Map<ConvoyMemberId, Pid>();
  for (const [name, member] of memberByName) { const pid = pidOf.get(name); if (pid !== undefined) members.set(member, pid); }
  const memberOf = (pid: Pid): ConvoyMemberId | null => { for (const [member, bound] of members) if (bound === pid) return member; return null; };
  const pace = inferEntryPace(ctx.kernelSnapshot.processes, run.policy.pace);
  const live = perProcessOf(events, names);
  const timeline = policyTimeline(run, ticks);
  const metrics = ctx.kernelSnapshot.metrics.scheduling;
  const fatal = events.filter((event): event is Extract<KernelEvent, { type: 'process.starving' }> => event.type === 'process.starving' && event.fatal);
  const starvedMembers = run.tombstones.filter((stone) => stone.legId === LEG_ID && stone.reason === 'starvation').map((stone) => ({ member: stone.member, tick: stone.tick }));
  const warning = events.find((event): event is Extract<KernelEvent, { type: 'process.starving' }> => event.type === 'process.starving' && !event.fatal && memberOf(event.pid) !== null);
  const firstWarning = warning === undefined ? null : { pid: warning.pid, member: memberOf(warning.pid), tick: warning.tick };
  const met: string[] = [];
  const codex = new Set<string>();

  // 1. waiting time target
  if (metrics.averageWaitingTime < WAITING_TARGET && fatal.length === 0) met.push(OBJECTIVE_IDS.waitingTimeTarget);
  let sjfCommitted = false;
  let rrQuantum: number | null = null;
  let rrOverhead: number | null = null;
  let convoyLive: number | null = null;
  let convoyBaseline: number | null = null;

  // 2. sjf is optimal: three distinct non-preemptive replays, then sjf committed.
  const replays = replayInvocations(run);
  const distinct = new Set(replays.map((invocation) => invocation.policy).filter((policy): policy is SchedulerId => (NON_PREEMPTIVE as readonly string[]).includes(policy)));
  if (distinct.size >= 3) {
    codex.add(CODEX_IDS.sjf);
    const third = replays.filter((invocation) => distinct.has(invocation.policy as SchedulerId))[2];
    sjfCommitted = third !== undefined && policyChanges(run).some((change) => change.to === 'sjf' && change.tick >= third.tick);
    if (sjfCommitted) met.push(OBJECTIVE_IDS.sjfIsOptimal);
  }

  // 3. quantum sizing on the switch-rate segment.
  const rrSpans = spansOf(timeline, ['rr']);
  const median = medianBurst(segment(3).rows);
  const firstRr = rrSpans[0];
  const forced = preemptionsIn(events, rrSpans);
  // The response time a quantum bounds is that of the set the quantum is sized against, which is
  // the sweep stream: the same set whose median burst fixes the admissible range, so one arrival
  // set defines both halves of the objective. The leg-wide figure is dominated by the opening
  // cluster, which arrives before any quantum is chosen and which round robin never sees.
  const rrResponse = averagesOf(live, segment(3).rows.map((row) => row.name))?.response ?? null;
  if (firstRr !== undefined && forced.ticks > 0) {
    rrQuantum = quantumInForceAt(run, firstRr.from, pace);
    const [low, high] = QUANTUM_RANGE;
    rrOverhead = (forced.preemptions * SWITCH_COST) / forced.ticks;
    if (rrQuantum >= low * median && rrQuantum <= high * median && rrOverhead < OVERHEAD_LIMIT && (rrResponse ?? metrics.averageResponseTime) < RESPONSE_TARGET) met.push(OBJECTIVE_IDS.quantumSizing);
  }

  // 4. Clear the affliction within the window, and bring the Program through.
  //
  // Only a switch to priority_aging clears it. `AfflictionClock.isCuredBy` matches the affliction's
  // own remedy and starvation's is `set_scheduler priority_aging`, so a nice moves the Program to the
  // front of the queue and leaves the affliction draining it. That is narrative 7.2's misleading
  // remedy working exactly as written: it fixes this process now and nothing else, and the bible says
  // to accept nothing else as full credit. The package offers a nice as an alternative here; the
  // engine and the bible agree against it, so the alternative loses.
  if (firstWarning !== null && firstWarning.member !== null) {
    const member = run.convoy.find((candidate) => candidate.id === firstWarning.member);
    const deadline = firstWarning.tick + CLEAR_WINDOW;
    const aged = policyChanges(run).some((change) => change.to === 'priority_aging' && change.tick >= firstWarning.tick && change.tick <= deadline);
    const cleared = member !== undefined && member.status !== 'derezzed' && !member.afflictions.some((affliction) => affliction.id === 'starvation');
    if (aged && cleared) met.push(OBJECTIVE_IDS.clearStarvation);
  }

  // 5. avoid the convoy effect on segment 1 against a real FCFS baseline.
  // The recorded FCFS baseline is this leg's own segment 1 replayed under fcfs from entry, so the
  // comparison carries the same convoy and the same arrivals as the run being judged.
  const convoy = segment(1);
  const convoyNames = convoy.rows.map((row) => row.name);
  const liveConvoy = averagesOf(live, convoyNames);
  const convoyPolicies = policyDuring(run, 0, liveConvoy?.lastCompletion ?? ticks);
  // Three clauses, so inaction does not meet it: the player has to have asked what first come
  // first served would have cost, must not have committed it, and must finish clear of it.
  const askedForFcfs = replays.some((invocation) => invocation.policy === 'fcfs');
  if (liveConvoy !== null && askedForFcfs && !convoyPolicies.includes('fcfs')) {
    convoyLive = liveConvoy.waiting;
    convoyBaseline = segmentAverages(shadowLeg({ run, pace, ticks, policy: 'fcfs', keepRecordedChanges: false }), convoyNames)?.waiting ?? null;
    if (convoyBaseline !== null && convoyLive <= (1 - CONVOY_MARGIN) * convoyBaseline) met.push(OBJECTIVE_IDS.avoidConvoyEffect);
  }
  if (convoyPolicies.includes('fcfs') || replays.some((invocation) => invocation.policy === 'fcfs')) codex.add(CODEX_IDS.convoy);

  // 6. tune MLFQ: read queueLevel, not a proxy.
  const mlfq = segment(4);
  const levelOf = (name: string): number | null => { const pid = pidOf.get(name); const pcb = pid === undefined ? undefined : ctx.kernelSnapshot.processes.find((process) => process.pid === pid); return pcb?.queueLevel ?? null; };
  const grind = levelOf('pass.grind');
  const taps = mlfq.rows.filter((row) => row.name !== 'pass.grind').map((row) => levelOf(row.name));
  if (schedulerAt(run, ticks) === 'mlfq' && grind !== null && grind >= 2 && taps.every((level) => level === 0) && metrics.worstWait <= AGING_INTERVAL) met.push(OBJECTIVE_IDS.tuneMlfq);

  // 7. switch rate under preemptive policies.
  const preemptive = preemptionsIn(events, spansOf(timeline, PREEMPTIVE));
  if (preemptive.ticks > 0 && preemptive.preemptions / preemptive.ticks < SWITCH_RATE_LIMIT) met.push(OBJECTIVE_IDS.switchRate);

  // Codex entries the leg adds by what happened.
  const lines = terminalLines(run);
  if (lines.some((line) => line.name === 'gantt' && line.argv.includes('--metrics'))) codex.add(CODEX_IDS.criteria);
  if (lines.some((line) => line.name === 'sched' && line.argv.includes('--levels'))) codex.add(CODEX_IDS.mlfq);
  if (events.some((event) => event.type === 'process.starving')) codex.add(CODEX_IDS.starvation);
  if (policyChanges(run).some((change) => change.quantum !== null && (change.to === 'rr' || schedulerAt(run, change.tick - 1) === 'rr'))) codex.add(CODEX_IDS.roundRobin);
  // Two overheads, for two questions. The card and the codex report what the processor spent on
  // switching, which is every switch. The debrief's explanation and the objectives read the
  // preemptions, because a process that finishes hands the processor on at any quantum and no dial
  // the player has prevents that.
  const totalSwitches = events.filter((event) => event.type === 'context.switch').length;
  const switchOverhead = ticks === 0 ? 0 : (totalSwitches * SWITCH_COST) / ticks;
  const legWide = preemptionsIn(events, [{ policy: schedulerAt(run, ticks), from: 0, to: ticks }]);
  const preemptionRate = ticks === 0 ? 0 : (legWide.preemptions * SWITCH_COST) / ticks;
  if (switchOverhead > 0.15) codex.add(CODEX_IDS.preemption);

  const clauses: Clauses = {
    averageWaitingTime: metrics.averageWaitingTime,
    averageResponseTime: metrics.averageResponseTime,
    fatalStarvations: fatal.length,
    distinctNonPreemptiveReplays: distinct.size,
    sjfCommittedAfterReplays: sjfCommitted,
    rrQuantum,
    sweepMedianBurst: median,
    rrOverhead,
    convoyLiveWaiting: convoyLive,
    convoyFcfsBaseline: convoyBaseline,
    mlfqLevels: Object.fromEntries(mlfq.rows.map((row) => [row.name, levelOf(row.name)])),
    worstWait: metrics.worstWait,
    preemptiveRate: preemptive.ticks === 0 ? null : preemptive.preemptions / preemptive.ticks,
    preemptiveSpanTicks: preemptive.ticks,
    preemptiveSwitches: preemptive.switches,
    preemptivePreemptions: preemptive.preemptions,
    preemptiveExpiries: preemptive.expiries,
    rrSpanTicks: forced.ticks,
    rrExpiries: forced.expiries,
    rrResponse,
    preemptionRate,
  };
  return { pace, names, pidOf, members, live, timeline, starvedMembers, firstWarning, met, codex: [...codex], switchOverhead, clauses };
}

function averagesOf(rows: readonly ProcessMetrics[], names: readonly string[]): { readonly waiting: number; readonly response: number; readonly lastCompletion: number } | null {
  const done = rows.filter((row) => names.includes(row.name) && row.waiting !== null && row.completion !== null);
  if (done.length === 0) return null;
  return {
    waiting: done.reduce((sum, row) => sum + (row.waiting ?? 0), 0) / done.length,
    response: done.reduce((sum, row) => sum + (row.response ?? 0), 0) / done.length,
    lastCompletion: Math.max(...done.map((row) => row.completion ?? 0)),
  };
}

/** The segment with the worst live average waiting time, replayed alone under every policy; the best alternative and both numbers. */
function worstSegmentCounterfactual(assessment: Assessment, run: Readonly<RunState>): string | null {
  let worst: { segment: Segment; waiting: number } | null = null;
  for (const candidate of LIVE_SEGMENTS) {
    const averages = averagesOf(assessment.live, candidate.rows.map((row) => row.name));
    if (averages !== null && (worst === null || averages.waiting > worst.waiting)) worst = { segment: candidate, waiting: averages.waiting };
  }
  if (worst === null) return null;
  const actual = schedulerAt(run, worst.segment.rows[0]?.arrival ?? 0);
  let best: { policy: SchedulerId; waiting: number } | null = null;
  for (const policy of ALL_POLICIES) {
    if (policy === actual) continue;
    const alone = replayArrivalSet({ rows: worst.segment.rows, policy });
    const averages = segmentAverages(alone, worst.segment.rows.map((row) => row.name));
    if (averages !== null && (best === null || averages.waiting < best.waiting)) best = { policy, waiting: averages.waiting };
  }
  if (best === null) return null;
  return `Segment ${worst.segment.index} ran ${worst.waiting.toFixed(2)} average waiting under ${actual}. The same arrivals under ${best.policy} run ${best.waiting.toFixed(2)}.`;
}

/** A Program starved: the same pass under priority_aging from the entry configuration, and whether that Program survives it. */
function starvationCounterfactual(assessment: Assessment, run: Readonly<RunState>, ticks: number): string | null {
  const death = assessment.starvedMembers[0];
  if (death === undefined) return null;
  const pid = assessment.members.get(death.member);
  const name = ROSTER.find((entry) => entry.member === death.member)?.name ?? death.member;
  const aged: ShadowRun = shadowLeg({ run, pace: assessment.pace, ticks, policy: 'priority_aging', keepRecordedChanges: false });
  const survives = pid !== undefined && !aged.starved.includes(pid);
  const firstRun = pid === undefined ? null : aged.perProcess.find((row) => row.pid === pid)?.firstRun ?? null;
  return survives
    ? `${name} was ready for ${death.tick - 1} ticks and derezzed at tick ${death.tick}. The same pass under priority_aging from the start dispatches ${name} at tick ${firstRun ?? 0} and ${name} survives.`
    : `${name} derezzed at tick ${death.tick}. The same pass under priority_aging from the start still does not dispatch ${name} in time, and ${name} does not survive it either.`;
}

export function evaluate(ctx: LegEvaluationContext): LegOutcome {
  const assessment = assess(ctx);
  const run = ctx.run;
  const ticks = ctx.ticksElapsed;
  const metrics = ctx.kernelSnapshot.metrics.scheduling;
  const casualties = run.tombstones.filter((stone) => stone.legId === LEG_ID).map((stone) => stone.member);
  const changes = policyChanges(run);
  const policyList = [schedulerAt(run, 0), ...changes.map((change) => change.to)].filter((policy, index, all) => index === 0 || all[index - 1] !== policy);
  const worst = assessment.live.filter((row) => row.waiting !== null).sort((a, b) => (b.waiting ?? 0) - (a.waiting ?? 0))[0];
  const starved = assessment.starvedMembers[0];
  const starvedName = starved === undefined ? null : ROSTER.find((entry) => entry.member === starved.member)?.name ?? starved.member;
  const convoyPolicies = policyDuring(run, 0, 20);
  const rrSpan = assessment.timeline.find((span) => span.policy === 'rr');
  const quantum = rrSpan === undefined ? quantumForPace(assessment.pace) : quantumInForceAt(run, rrSpan.from, assessment.pace);
  const median = medianBurst(segment(3).rows);
  const whyItHappened = starvedName !== null ? WHY_STARVED
    : convoyPolicies.includes('fcfs') ? WHY_CONVOY
    : assessment.clauses.preemptionRate > OVERHEAD_LIMIT ? whySwitchOverhead(quantum, median)
    : whyClean(changes.length);
  const counterfactual = starvedName !== null ? starvationCounterfactual(assessment, run, ticks) : worstSegmentCounterfactual(assessment, run);
  // The response time the quantum is judged on is the sweep stream's, so the card names that set
  // rather than leaving the player to guess which processes the number came from.
  const sweepResponse = assessment.clauses.rrResponse === null ? ''
    : ` The sweep stream, the set the quantum is sized against, answered in ${assessment.clauses.rrResponse.toFixed(1)} ticks on average.`;
  const debrief: DebriefCard = {
    headline: starvedName === null ? HEADLINE_CLEAN : headlineStarved(starvedName),
    whatHappened: `You crossed under ${policyList.join(', then ')}. Average waiting time was ${metrics.averageWaitingTime.toFixed(1)} ticks against a target of ${WAITING_TARGET}. Context switches: ${metrics.contextSwitches}, of which ${Math.round(assessment.clauses.preemptionRate * ticks)} were preemptions, costing ${(assessment.switchOverhead * 100).toFixed(0)} percent of total processor time. Worst wait: ${worst?.waiting ?? 0} ticks, by ${worst?.name ?? 'nobody'}.${sweepResponse}`,
    whyItHappened,
    counterfactual,
    chapter: cite('5.3.4'),
  };
  return {
    survived: run.convoy.some((member) => member.status !== 'derezzed' && !casualties.includes(member.id)),
    objectivesMet: assessment.met,
    casualties,
    resourceDelta: {},
    codexUnlocked: assessment.codex,
    debrief,
  };
}
