/**
 * WP-20 section 8 and scope corrections W2, W9, W10 and ruling F8: the
 * fourteen-leg journey as one deterministic function of its seed plus its
 * decision log.
 *
 * One `RunStore` and one `LegRunner` carry every leg, entered in `LEG_ORDER`;
 * `prepareLegEntry` runs inside `enter`. Boundary saves are the runner's own
 * `persist` inputs, built into a `SaveFile` with `buildSaveFile`; with
 * `restoreAtBoundaries` a fresh runner over a fresh store resumes from that
 * file at every boundary and continues. `journeyHash` is `fnv1a64` over the
 * per-leg log hashes in order plus the canonical serialisation of the final
 * `RunState`, both from `@game/save`.
 *
 * Assertion 4 replays the journey through `runReplay` from the seed and the
 * decision log alone against the headless factories the runner registers
 * at entry, and compares per-leg hashes and the final run. `runReplay`
 * counts a hand-off record as a skipped decision, so `decisions` is compared
 * with the hand-off kinds excluded and the skip count is asserted equal to
 * their number.
 */
import { HEADLESS_LEGS, registerHeadlessLeg, resolveHeadlessLeg } from '@game/replay/headlessLegs';
import { initialRunState, runReplay } from '@game/replay/runReplay';
import type { HeadlessLeg, ReplayHooks } from '@game/replay/types';
import { buildSaveFile, canonicalise, fnv1a64 } from '@game/save';
import { scoreFromRun, SCORE_WEIGHTS } from '@game/scoring';
import type { Store } from '@game/store';
import { emergencyCreditNeeded } from '@game/travel/ledger';
import { LEG_ORDER, type DecisionRecord, type DifficultyTier, type DiscClass, type Leg, type LegId, type ResourceLedger, type RunState } from '@game/types';
import type { LegRunner } from '@game/LegRunner';
import type { DecisionScript } from './decisionScript';
import { DEFAULT_MAX_TICKS, DEFAULT_THROUGHPUT_TARGET, HarnessSession, runLegInSession, type HarnessResult } from './LegHarness';
import { loadShippedPrefix } from './loadLeg';
import type { PolicyName } from './scriptedDecisions';

export interface JourneyOptions {
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  /** One script per leg, in LEG_ORDER. A leg without one runs on `policy`, passive by default. */
  readonly scripts: ReadonlyMap<LegId, DecisionScript>;
  readonly maxTicksPerLeg?: number;
  /** Snapshot and restore at every leg boundary. */
  readonly restoreAtBoundaries?: boolean;
  /** The legs to run, in order from index 0; the shipped prefix when omitted. */
  readonly legs?: readonly Leg[];
  readonly policy?: PolicyName;
  readonly throughputTarget?: number;
}

export interface HandoffSpec {
  readonly handoff: 1 | 2 | 3 | 4 | 5;
  readonly producer: LegId;
  readonly consumer: LegId;
  readonly kinds: readonly string[];
  /** The consumer's documented default when the record is absent (00-LEG-BUILD-ORDER, the five hand-offs). */
  readonly defaultWhenAbsent: string;
}

/** The five hand-offs of `00-LEG-BUILD-ORDER.md`, the only cross-leg couplings in the project. */
export const HANDOFFS: readonly HandoffSpec[] = [
  { handoff: 1, producer: 'the_cistern', consumer: 'the_gridlock', kinds: ['ring_closed'], defaultWhenAbsent: 'the opening card omits the tick' },
  { handoff: 2, producer: 'allocation_yards', consumer: 'arbiter_wall', kinds: ['executable_bit'], defaultWhenAbsent: 'cleared; the leg opens clean' },
  { handoff: 3, producer: 'the_bus', consumer: 'the_archive', kinds: ['device_attach'], defaultWhenAbsent: 'open clean' },
  { handoff: 4, producer: 'the_archive', consumer: 'arbiter_wall', kinds: ['crash_outcome', 'manifest_integrity'], defaultWhenAbsent: 'intact' },
  { handoff: 5, producer: 'arbiter_wall', consumer: 'the_portal', kinds: ['escalation_outcome', 'privilege_excess'], defaultWhenAbsent: 'all_blocked and an excess of 0' },
];

export const HANDOFF_KINDS: ReadonlySet<string> = new Set(HANDOFFS.flatMap((spec) => spec.kinds));

export interface HandoffObservation extends HandoffSpec {
  readonly status: 'observed' | 'defaulted' | 'skipped';
  /** The kinds the producer had written when the consumer entered. */
  readonly producerWrote: readonly string[];
  readonly producerRan: boolean;
  readonly consumerRan: boolean;
  /** Hand-off 2 only: the producer's record no longer reads `pending` after the consumer ran; null elsewhere. */
  readonly writeBack: boolean | null;
  readonly reason: string;
}

export interface JourneyResult {
  readonly legs: readonly HarnessResult[];
  readonly finalRun: RunState;
  readonly journeyHash: string;
  readonly ledgerByLeg: readonly ResourceLedger[];
  readonly survivors: number;
  readonly objectivesMet: readonly string[];
  readonly handoffs: readonly HandoffObservation[];
  /** Legs of `LEG_ORDER` the journey did not run. */
  readonly skipped: readonly LegId[];
  /** Legs on the emergency preemption credit at exit. */
  readonly creditLegs: readonly LegId[];
  /** Legs whose entering ledger could not pay the conservative-pace cost, where WP-19 says the credit fires. */
  readonly creditPredicted: readonly LegId[];
  readonly boundaryRestores: number;
  readonly wallMs: number;
  /** Put the headless registry back as it was before the journey; call after any replay check. */
  release(): void;
}

export function journeyHashOf(legHashes: readonly string[], finalRun: RunState): string {
  return fnv1a64(legHashes.join('') + canonicalise(finalRun));
}

function configureFor(scripts: ReadonlyMap<LegId, DecisionScript>): (runner: LegRunner, leg: Leg) => void {
  return (runner, leg) => {
    const script = scripts.get(leg.id);
    if (script === undefined) return;
    runner.registerCrossings(script.crossings ?? []);
    for (const interaction of script.interactions ?? []) runner.registerInteraction(interaction.id, () => undefined, interaction.target);
  };
}

function recordsFor(decisions: readonly DecisionRecord[], spec: HandoffSpec): readonly DecisionRecord[] {
  return decisions.filter((record) => record.legId === spec.producer && spec.kinds.includes(record.kind));
}

export async function runJourney(opts: JourneyOptions): Promise<JourneyResult> {
  const legs = opts.legs ?? (await loadShippedPrefix());
  legs.forEach((leg, i) => {
    if (leg.index !== i) throw new Error(`runJourney: the legs must be contiguous from index 0; ${leg.id} has index ${leg.index} at position ${i}`);
  });
  const maxTicks = opts.maxTicksPerLeg ?? DEFAULT_MAX_TICKS;
  const throughputTarget = opts.throughputTarget ?? DEFAULT_THROUGHPUT_TARGET;
  const undo = legs.map((leg) => registerHeadlessLeg(leg.id, HEADLESS_LEGS[leg.id]));
  const release = (): void => { for (const restore of [...undo].reverse()) restore(); };
  const configure = configureFor(opts.scripts);
  const started = performance.now();
  let session = new HarnessSession(opts.seed, initialRunState(opts.seed, opts.discClass, opts.difficulty), throughputTarget);
  const results: HarnessResult[] = [];
  const ledgerByLeg: ResourceLedger[] = [];
  const creditLegs: LegId[] = [];
  const creditPredicted: LegId[] = [];
  const entryRecords = new Map<LegId, readonly DecisionRecord[]>();
  let boundaryRestores = 0;
  try {
    for (const [i, leg] of legs.entries()) {
      let alreadyEntered = false;
      if (opts.restoreAtBoundaries === true && i > 0) {
        const input = session.lastBoundary();
        if (input === null) throw new Error(`runJourney: no boundary save after ${legs[i - 1]?.id ?? 'the previous leg'}`);
        const file = buildSaveFile(input);
        session.detach();
        const next = new HarnessSession(opts.seed, initialRunState(opts.seed, opts.discClass, opts.difficulty), throughputTarget, session.collectors);
        next.resuming = true;
        let resumed: boolean;
        try {
          resumed = next.runner.resume(file, legs.slice(0, i + 1), { maxTicks, stageContext: null }, configure);
        } finally {
          next.resuming = false;
        }
        if (!resumed) throw new Error(`runJourney: the boundary resume into ${leg.id} failed: ${next.collectors.runnerFailures.at(-1) ?? 'no reason reported'}`);
        session = next;
        boundaryRestores += 1;
        alreadyEntered = true;
      }
      const entering = session.store.get();
      if (emergencyCreditNeeded(entering.resources, leg.id)) creditPredicted.push(leg.id);
      entryRecords.set(leg.id, entering.decisions.map((record) => ({ ...record })));
      const script = opts.scripts.get(leg.id);
      const outcome = runLegInSession(session, leg, {
        seed: opts.seed, maxTicks, throughputTarget,
        ...(script === undefined ? { policy: opts.policy ?? 'passive' } : { script }),
      }, alreadyEntered);
      session = outcome.session;
      results.push(outcome.result);
      ledgerByLeg.push({ ...outcome.result.ledgerAfter });
      if (outcome.result.onCredit) creditLegs.push(leg.id);
    }
  } catch (error) {
    release();
    throw error;
  }
  const finalRun = structuredClone(session.store.get());
  const ran = new Set(legs.map((leg) => leg.id));
  const handoffs: HandoffObservation[] = HANDOFFS.map((spec) => {
    const producerRan = ran.has(spec.producer);
    const consumerRan = ran.has(spec.consumer);
    const atEntry = entryRecords.get(spec.consumer) ?? [];
    const producerWrote = [...new Set(recordsFor(atEntry, spec).map((record) => record.kind))];
    const writeBack = spec.handoff === 2 && consumerRan ? recordsFor(finalRun.decisions, spec).some((record) => record.outcome !== 'pending') : null;
    if (!producerRan || !consumerRan) {
      const missing = [!producerRan ? spec.producer : null, !consumerRan ? spec.consumer : null].filter((id) => id !== null).join(' and ');
      return { ...spec, status: 'skipped', producerWrote, producerRan, consumerRan, writeBack, reason: `${missing} did not run` };
    }
    if (producerWrote.length === 0) return { ...spec, status: 'defaulted', producerWrote, producerRan, consumerRan, writeBack, reason: `${spec.producer} wrote no ${spec.kinds.join(' or ')} record; ${spec.consumer} fell back to its default (${spec.defaultWhenAbsent})` };
    return { ...spec, status: 'observed', producerWrote, producerRan, consumerRan, writeBack, reason: `${spec.consumer} entered with ${producerWrote.join(', ')} from ${spec.producer}` };
  });
  return {
    legs: results,
    finalRun,
    journeyHash: journeyHashOf(results.map((result) => result.logHash), finalRun),
    ledgerByLeg,
    survivors: finalRun.convoy.filter((member) => member.status !== 'derezzed').length,
    objectivesMet: [...finalRun.objectivesMet],
    handoffs,
    skipped: LEG_ORDER.filter((id) => !ran.has(id)),
    creditLegs,
    creditPredicted,
    boundaryRestores,
    wallMs: performance.now() - started,
    release,
  };
}

export interface JourneyReplayCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly skippedDecisions: number;
  readonly handoffRecords: number;
  readonly replayHash: string | null;
}

const withoutHandoffs = (records: readonly DecisionRecord[]): readonly DecisionRecord[] => records.filter((record) => !HANDOFF_KINDS.has(record.kind));

/**
 * The run with the hand-off records removed and the score recomputed over
 * what remains, recovering the workload completions the way the runner does
 * (`throughput / perCompletion`). A hand-off record's outcome feeds the
 * correctness score, and the replay never sees it (F8).
 */
function comparableRun(run: RunState): RunState {
  // A derezzed Program carries no pid at entry under the live runner (LegRunner.enter), while runReplay
  // rebinds whatever a leg's populate binds; the runner's rule is applied to both sides here and the
  // disagreement is reported against WP-18.
  const convoy = run.convoy.map((member) => (member.status === 'derezzed' ? { ...member, pid: null } : member));
  const stripped: RunState = { ...run, convoy, decisions: [...withoutHandoffs(run.decisions)] };
  return { ...stripped, score: scoreFromRun(stripped, { workloadCompletions: run.score.throughput / SCORE_WEIGHTS.perCompletion, privilegeExcess: 0 }) };
}

/** The first path at which two canonical values differ, for a failure message a human can act on. */
export function firstDifference(a: unknown, b: unknown, path = 'run'): string | null {
  if (canonicalise(a) === canonicalise(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} versus ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const inner = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (inner !== null) return inner;
    }
  } else if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const inner = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (inner !== null) return inner;
    }
  }
  return `${path}: ${canonicalise(a).slice(0, 120)} versus ${canonicalise(b).slice(0, 120)}`;
}

/**
 * Assertion 4: replay the journey through `runReplay` from the seed and the
 * decision log alone, against the headless factories the runner registered
 * at entry, and compare per-leg hashes and the final run (ruling F8). Call
 * before `journey.release()`.
 */
export function replayJourney(journey: JourneyResult, opts: Pick<JourneyOptions, 'seed' | 'discClass' | 'difficulty' | 'maxTicksPerLeg'>): JourneyReplayCheck {
  const problems: string[] = [];
  const legIds = journey.legs.map((result) => result.legId);
  const handoffRecords = journey.finalRun.decisions.filter((record) => HANDOFF_KINDS.has(record.kind)).length;
  const capture: { store: Store<RunState> | null } = { store: null };
  const response = runReplay({
    seed: opts.seed, discClass: opts.discClass, difficulty: opts.difficulty, legs: legIds,
    decisions: journey.finalRun.decisions, overrides: { suppressRecordedPolicyChanges: false },
    maxTicks: (opts.maxTicksPerLeg ?? DEFAULT_MAX_TICKS) * Math.max(1, legIds.length),
  }, {
    legs: (id): HeadlessLeg => {
      const base = resolveHeadlessLeg(id);
      const hooks: ReplayHooks = base.hooks ?? {};
      return { ...base, hooks: { ...hooks, enter: (streams, store) => { capture.store = store; hooks.enter?.(streams, store); } } };
    },
  });
  if (!response.ok) return { ok: false, problems: [`replay failed: ${response.reason}: ${response.message}`], skippedDecisions: 0, handoffRecords, replayHash: null };
  journey.legs.forEach((result, i) => {
    const replayed = response.diagnostics.legs[i];
    if (replayed === undefined) problems.push(`${result.legId}: the replay ran no leg at position ${i}`);
    else if (replayed.eventLogHash !== result.logHash) problems.push(`${result.legId}: live hash ${result.logHash}, replayed ${replayed.eventLogHash}`);
  });
  if (response.diagnostics.skippedDecisions !== handoffRecords) problems.push(`skipped decisions: replay reports ${response.diagnostics.skippedDecisions}, the journey wrote ${handoffRecords} hand-off record(s)`);
  const finalStore = capture.store;
  let replayHash: string | null = null;
  if (finalStore === null) problems.push('the replay never entered a leg');
  else {
    const replayed = finalStore.get();
    replayHash = journeyHashOf(response.diagnostics.legs.map((leg) => leg.eventLogHash), replayed);
    const difference = firstDifference(comparableRun(journey.finalRun), comparableRun(replayed));
    if (difference !== null) problems.push(`final run differs, live versus replayed: ${difference}`);
  }
  return { ok: problems.length === 0, problems, skippedDecisions: response.diagnostics.skippedDecisions, handoffRecords, replayHash };
}
