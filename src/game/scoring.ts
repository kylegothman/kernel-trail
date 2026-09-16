/**
 * KERNEL TRAIL - scoring. Narrative bible section 15.2 fills `ScoreBreakdown`:
 *
 *   survivors        = 1200 * livingProgramsAtPortal
 *   throughput       = 40 * workloadCompletionsAcrossRun
 *   efficiency       = min(2500, 2 * unspentCycles + 1 * unspentQuota)
 *   correctness      = 150 * good - 100 * costly - 400 * fatal
 *   conceptsMastered = 180 * objectivesMet
 *   total = round(sum * classMultiplier * difficultyFactor)
 *
 * The frozen `ScoreBreakdown` has one multiplier field, so the difficulty
 * factor folds into `classMultiplier` (pre-flight ruling 6.7) and `total` is
 * a pure function of the frozen fields. `privilegeExcess` enters
 * `correctness` with a non-positive weight, so running above the ring a task
 * needed never raises it. A failed run scores what it earned with survivors
 * counted as zero.
 *
 * Every number here is a phase 1 placeholder and the tests assert only
 * monotonicity and purity, never a specific total.
 */

import type { DecisionRecord, DiscClass, DifficultyTier, RunState, ScoreBreakdown } from '@game/types';

// TODO(astra): balance pass in phase 2. Every weight below is a placeholder transcribed from narrative bible 15.2.
export const SCORE_WEIGHTS = {
  perSurvivor: 1200,
  perCompletion: 40,
  perUnspentCycle: 2,
  perUnspentQuota: 1,
  efficiencyCap: 2500,
  perGoodDecision: 150,
  perCostlyDecision: -100,
  perFatalDecision: -400,
  /** Non-positive by construction: privilege excess never raises correctness. */
  perPrivilegeExcess: -50,
  perObjective: 180,
} as const;

// TODO(astra): balance pass in phase 2. Class weights from narrative bible 15.2.
export const CLASS_MULTIPLIER: Readonly<Record<DiscClass, number>> = {
  shell: 1.0,
  daemon: 2.0,
  compiler: 3.5,
};

// TODO(astra): balance pass in phase 2. Difficulty factors from narrative bible 15.2, folded into classMultiplier.
export const DIFFICULTY_FACTOR: Readonly<Record<DifficultyTier, number>> = {
  novice: 0.5,
  operator: 1.0,
  architect: 1.6,
  kernel_space: 2.5,
};

export interface ScoringInput {
  /** Living Programs at the end. Counted as zero when the run failed. */
  readonly survivors: number;
  readonly workloadCompletions: number;
  readonly unspentCycles: number;
  readonly unspentQuota: number;
  readonly goodDecisions: number;
  readonly costlyDecisions: number;
  readonly fatalDecisions: number;
  /** Times the player ran above the protection ring a task needed. */
  readonly privilegeExcess: number;
  readonly objectivesMet: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  readonly status: RunState['status'];
}

/** The multiplier the frozen shape carries: class weight times difficulty factor (15.2). */
export function classMultiplierFor(discClass: DiscClass, difficulty: DifficultyTier): number {
  return CLASS_MULTIPLIER[discClass] * DIFFICULTY_FACTOR[difficulty];
}

/** `total` from the components and the multiplier, and nothing else. */
export function scoreTotal(b: Omit<ScoreBreakdown, 'total'>): number {
  const sum = b.survivors + b.throughput + b.efficiency + b.correctness + b.conceptsMastered;
  return Math.round(sum * b.classMultiplier);
}

const nonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export function computeScore(input: ScoringInput): ScoreBreakdown {
  const w = SCORE_WEIGHTS;
  const survivors = input.status === 'failed' ? 0 : w.perSurvivor * nonNegative(input.survivors);
  const throughput = w.perCompletion * nonNegative(input.workloadCompletions);
  const efficiency = Math.min(
    w.efficiencyCap,
    w.perUnspentCycle * nonNegative(input.unspentCycles) + w.perUnspentQuota * nonNegative(input.unspentQuota),
  );
  const correctness =
    w.perGoodDecision * nonNegative(input.goodDecisions) +
    w.perCostlyDecision * nonNegative(input.costlyDecisions) +
    w.perFatalDecision * nonNegative(input.fatalDecisions) +
    w.perPrivilegeExcess * nonNegative(input.privilegeExcess);
  const conceptsMastered = w.perObjective * nonNegative(input.objectivesMet);
  const classMultiplier = classMultiplierFor(input.discClass, input.difficulty);
  const components = { survivors, throughput, efficiency, correctness, conceptsMastered, classMultiplier };
  return { ...components, total: scoreTotal(components) };
}

export function countDecisions(decisions: readonly DecisionRecord[]): { good: number; costly: number; fatal: number } {
  let good = 0;
  let costly = 0;
  let fatal = 0;
  for (const d of decisions) {
    if (d.outcome === 'good') good += 1;
    else if (d.outcome === 'costly') costly += 1;
    else if (d.outcome === 'fatal') fatal += 1;
  }
  return { good, costly, fatal };
}

/** What the run state alone does not carry; the leg runner supplies it. */
export interface RunScoringExtras {
  readonly workloadCompletions: number;
  readonly privilegeExcess: number;
}

export function scoreFromRun(run: Readonly<RunState>, extras: RunScoringExtras): ScoreBreakdown {
  const counts = countDecisions(run.decisions);
  return computeScore({
    survivors: run.convoy.filter((m) => m.status !== 'derezzed').length,
    workloadCompletions: extras.workloadCompletions,
    unspentCycles: run.resources.cycles,
    unspentQuota: run.resources.quota,
    goodDecisions: counts.good,
    costlyDecisions: counts.costly,
    fatalDecisions: counts.fatal,
    privilegeExcess: extras.privilegeExcess,
    objectivesMet: run.objectivesMet.length,
    discClass: run.discClass,
    difficulty: run.difficulty,
    status: run.status,
  });
}
