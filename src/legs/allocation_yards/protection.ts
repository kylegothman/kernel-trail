/**
 * KERNEL TRAIL: the Allocation Yards' long fuse, and the leg's one write
 * channel.
 *
 * A leg cannot write to `RunState` from `evaluate`, and it gets no per-tick
 * hook, so everything this leg owes the run is settled at the top of every
 * interaction handler (pre-flight ruling 4). `settle` is idempotent: it looks
 * at what the decision log already says, writes only what is missing, and is
 * safe to call on every interaction.
 *
 * The fuse itself is the run's longest causal chain. Leaving the executable
 * bit set on the data pages lets the scripted injection run, which kills
 * nothing here and plants a modified Program image that the Arbiter Wall
 * reads five legs later. This leg's only job is to record it faithfully.
 */
import type { Tick } from '@kernel/types';
import { AFFLICTION_TABLE } from '@game/afflictions/table';
import type { Affliction, DecisionRecord, RunState } from '@game/types';
import { replayYard } from './yard';

export const LEG_ID = 'allocation_yards';

/** The injection runs at four fifths of the way across, not at a fixed tick: the leg is 41 ticks at reckless and 142 at conservative. */
export const INJECTION_PROGRESS = 0.8;

/** Ticks a Program may stand unplaced before it acquires `fragmented`. */
export const UNPLACED_GRACE = 30;
/** This leg's instance of `fragmented`: the ambient table's 0.7 with no fatal clock is the out-of-leg baseline. */
export const FUSE_DRAIN_PER_TICK = 1.5;
export const FUSE_FATAL_AFTER = 30;

/** The only Program the yard can refuse fatally: she is the one who has to fit into the holes (narrative 3.5). */
export const FUSED_MEMBER = 'vesper';

export type YardDecisionKind =
  | 'executable_bit'
  | 'unplaced_program'
  | 'buy_quota_on_fragmentation';

export function legDecisions(run: Readonly<RunState>): readonly DecisionRecord[] {
  return run.decisions.filter((record) => record.legId === LEG_ID);
}

export function findDecision(run: Readonly<RunState>, kind: YardDecisionKind): DecisionRecord | undefined {
  return run.decisions.find((record) => record.legId === LEG_ID && record.kind === kind);
}

/** Append one record. Only a handler may call this, and only through `settle` or an interaction. */
export function record(run: RunState, at: Tick, kind: YardDecisionKind, choice: string,
  outcome: DecisionRecord['outcome'], relatedObjective: string | null): void {
  run.decisions.push({ tick: at, legId: LEG_ID, kind, choice, outcome, relatedObjective });
}

/** This leg's own `fragmented`, acquired at the tick the grace ran out. */
export function fragmentedFuse(acquiredAtTick: Tick): Affliction {
  return {
    id: 'fragmented',
    displayName: AFFLICTION_TABLE.fragmented.displayName,
    acquiredAtTick,
    drainPerTick: FUSE_DRAIN_PER_TICK,
    fatalAfter: FUSE_FATAL_AFTER,
    remedy: { ...AFFLICTION_TABLE.fragmented.remedy },
  };
}

/** Whether the injection has already run, at the progress the draft reports. */
export function injectionHasRun(run: Readonly<RunState>): boolean {
  return run.legProgress >= INJECTION_PROGRESS;
}

/** The quota lots bought at the depot, in order. */
function quotaLotTicks(run: Readonly<RunState>): readonly Tick[] {
  return run.decisions
    .filter((candidate) => candidate.legId === LEG_ID && candidate.kind === 'depot' && candidate.outcome === 'good'
      && candidate.choice.includes('"item":"quota_lot"'))
    .map((candidate) => candidate.tick);
}

/**
 * Write everything the leg owes the run as of `at`, once each.
 *
 * 1. The fuse. A Program the yard has refused for `UNPLACED_GRACE` ticks
 *    acquires this leg's `fragmented`, back-dated to the tick the grace ran
 *    out, so the fatal clock is the one the refusal started rather than the
 *    one the player's next interaction started.
 * 2. The fatal mark, once the fuse has taken her.
 * 3. The instructive wrong remedy: quota bought while the yard was refusing
 *    for shape rather than for space.
 * 4. The injection, once it has run with the executable bit still set.
 */
export function settle(run: RunState, at: Tick): void {
  const yard = replayYard(run.decisions, at);

  const since = yard.unplacedSince.get(FUSED_MEMBER);
  const member = run.convoy.find((candidate) => candidate.id === FUSED_MEMBER);
  if (since !== undefined && member !== undefined && member.status !== 'derezzed' && at >= since + UNPLACED_GRACE
    && !member.afflictions.some((affliction) => affliction.id === 'fragmented')) {
    member.afflictions.push(fragmentedFuse((since + UNPLACED_GRACE) as Tick));
    if (findDecision(run, 'unplaced_program') === undefined) {
      record(run, at, 'unplaced_program', FUSED_MEMBER, 'pending', 'obj.allocation_yards.strategy_choice');
    }
  }

  const unplaced = findDecision(run, 'unplaced_program');
  if (unplaced !== undefined && unplaced.outcome === 'pending'
    && run.convoy.some((candidate) => candidate.id === unplaced.choice && candidate.status === 'derezzed')) {
    unplaced.outcome = 'fatal';
  }

  const bought = quotaLotTicks(run);
  if (bought.length > 0 && findDecision(run, 'buy_quota_on_fragmentation') === undefined) {
    const first = bought[0] ?? at;
    const shape = replayYard(run.decisions, first);
    if (shape.failures.some((failure) => failure.reason === 'fragmentation' && failure.at <= first)) {
      // The choice carries the free figure at the moment of purchase, so the
      // debrief prints the number the player actually bought against.
      record(run, at, 'buy_quota_on_fragmentation', String(shape.freeSlots), 'costly',
        'obj.allocation_yards.diagnose_fragmentation');
    }
  }

  if (injectionHasRun(run) && findDecision(run, 'executable_bit') === undefined) {
    record(run, at, 'executable_bit', 'left_set', 'pending', 'obj.allocation_yards.protection_bits');
  }
}

/** Hand-off 2's record, as the Arbiter Wall reads it back. */
export function executableBitChoice(run: Readonly<RunState>): 'left_set' | 'cleared' | null {
  const decision = findDecision(run, 'executable_bit');
  if (decision === undefined) return null;
  return decision.choice === 'left_set' ? 'left_set' : 'cleared';
}
