/**
 * WP-20 section 5: assert an expected `LegOutcome` without asserting the
 * whole of it. An omitted field is not checked. Set comparisons are
 * order-insensitive and report the symmetric difference in both directions,
 * named. Every failure message starts with the leg id, the seed, the tick
 * count and the log hash, so a failing CI run reproduces from its own output.
 */
import type { ConvoyMemberId } from '@kernel/types';
import type { DecisionRecord, ResourceLedger } from '@game/types';
import type { HarnessResult } from './LegHarness';

export interface OutcomeExpectation {
  readonly survived?: boolean;
  /** Exact set, order-insensitive. */
  readonly objectivesMet?: readonly string[];
  /** Subset. */
  readonly objectivesAtLeast?: readonly string[];
  /** Exact set. */
  readonly casualties?: readonly ConvoyMemberId[];
  readonly casualtyCount?: number;
  readonly codexUnlocked?: readonly string[];
  readonly resourceDelta?: Partial<Record<keyof ResourceLedger, { readonly min?: number; readonly max?: number }>>;
  readonly debrief?: {
    readonly headlineMatches?: RegExp;
    readonly counterfactualPresent?: boolean;
    /** Chapter and sections; the title is copy and is ignored. */
    readonly chapter?: { readonly chapter: number; readonly sections: readonly string[] };
  };
  /** Inclusive. */
  readonly ticksBetween?: readonly [number, number];
  readonly eventTypesPresent?: readonly string[];
  readonly eventTypesAbsent?: readonly string[];
  readonly decisionOutcomes?: readonly { readonly kind: string; readonly outcome: DecisionRecord['outcome'] }[];
}

export function resultPrefix(result: HarnessResult): string {
  return `[${result.legId} seed=${result.seed} ticks=${result.ticks} hash=${result.logHash}]`;
}

const show = (items: readonly string[]): string => `[${items.join(', ')}]`;

/** Both directions of a set mismatch, named, or null when the sets agree. */
export function setMismatch(name: string, expected: readonly string[], actual: readonly string[]): string | null {
  const want = new Set(expected);
  const got = new Set(actual);
  const missing = [...want].filter((item) => !got.has(item));
  const unexpected = [...got].filter((item) => !want.has(item));
  if (missing.length === 0 && unexpected.length === 0) return null;
  return `${name}: missing (expected, not present) ${show(missing)}; unexpected (present, not expected) ${show(unexpected)}`;
}

/** The problems an expectation finds in a result, empty when it holds. */
export function outcomeProblems(result: HarnessResult, expected: OutcomeExpectation): readonly string[] {
  const problems: string[] = [];
  const outcome = result.outcome;
  if (expected.survived !== undefined && outcome.survived !== expected.survived) problems.push(`survived: expected ${expected.survived}, got ${outcome.survived}`);
  if (expected.objectivesMet !== undefined) {
    const mismatch = setMismatch('objectivesMet', expected.objectivesMet, outcome.objectivesMet);
    if (mismatch !== null) problems.push(mismatch);
  }
  if (expected.objectivesAtLeast !== undefined) {
    const missing = expected.objectivesAtLeast.filter((id) => !outcome.objectivesMet.includes(id));
    if (missing.length > 0) problems.push(`objectivesAtLeast: missing (expected, not met) ${show(missing)}; met ${show([...outcome.objectivesMet])}`);
  }
  if (expected.casualties !== undefined) {
    const mismatch = setMismatch('casualties', expected.casualties, outcome.casualties);
    if (mismatch !== null) problems.push(mismatch);
  }
  if (expected.casualtyCount !== undefined && outcome.casualties.length !== expected.casualtyCount) {
    problems.push(`casualtyCount: expected ${expected.casualtyCount}, got ${outcome.casualties.length} ${show([...outcome.casualties])}`);
  }
  if (expected.codexUnlocked !== undefined) {
    const mismatch = setMismatch('codexUnlocked', expected.codexUnlocked, outcome.codexUnlocked);
    if (mismatch !== null) problems.push(mismatch);
  }
  if (expected.resourceDelta !== undefined) {
    for (const key of ['cycles', 'quota', 'blocks', 'bandwidth'] as const) {
      const bounds = expected.resourceDelta[key];
      if (bounds === undefined) continue;
      const value = outcome.resourceDelta[key] ?? 0;
      if (bounds.min !== undefined && value < bounds.min) problems.push(`resourceDelta.${key}: ${value} is below the minimum ${bounds.min}`);
      if (bounds.max !== undefined && value > bounds.max) problems.push(`resourceDelta.${key}: ${value} is above the maximum ${bounds.max}`);
    }
  }
  if (expected.debrief !== undefined) {
    const card = outcome.debrief;
    if (expected.debrief.headlineMatches !== undefined && !expected.debrief.headlineMatches.test(card.headline)) {
      problems.push(`debrief.headline: ${JSON.stringify(card.headline)} does not match ${String(expected.debrief.headlineMatches)}`);
    }
    if (expected.debrief.counterfactualPresent !== undefined && (card.counterfactual !== null) !== expected.debrief.counterfactualPresent) {
      problems.push(`debrief.counterfactual: expected ${expected.debrief.counterfactualPresent ? 'present' : 'absent'}, got ${card.counterfactual === null ? 'null' : JSON.stringify(card.counterfactual)}`);
    }
    if (expected.debrief.chapter !== undefined) {
      if (card.chapter.chapter !== expected.debrief.chapter.chapter) problems.push(`debrief.chapter: expected chapter ${expected.debrief.chapter.chapter}, got ${card.chapter.chapter}`);
      const mismatch = setMismatch('debrief.chapter.sections', expected.debrief.chapter.sections, card.chapter.sections);
      if (mismatch !== null) problems.push(mismatch);
    }
  }
  if (expected.ticksBetween !== undefined) {
    const [low, high] = expected.ticksBetween;
    if (result.ticks < low || result.ticks > high) problems.push(`ticks: ${result.ticks} is outside [${low}, ${high}]`);
  }
  if (expected.eventTypesPresent !== undefined) {
    const missing = expected.eventTypesPresent.filter((type) => !result.eventTypes.has(type));
    if (missing.length > 0) problems.push(`eventTypesPresent: never fired ${show(missing)}`);
  }
  if (expected.eventTypesAbsent !== undefined) {
    const fired = expected.eventTypesAbsent.filter((type) => result.eventTypes.has(type));
    if (fired.length > 0) problems.push(`eventTypesAbsent: fired ${show(fired)}`);
  }
  if (expected.decisionOutcomes !== undefined) {
    for (const want of expected.decisionOutcomes) {
      if (!result.decisions.some((record) => record.kind === want.kind && record.outcome === want.outcome)) {
        const seen = result.decisions.filter((record) => record.kind === want.kind).map((record) => record.outcome);
        problems.push(`decisionOutcomes: no ${want.kind} decision with outcome ${want.outcome}; ${want.kind} outcomes seen ${show(seen)}`);
      }
    }
  }
  return problems;
}

export function expectOutcome(result: HarnessResult, expected: OutcomeExpectation): void {
  const problems = outcomeProblems(result, expected);
  if (problems.length > 0) throw new Error(`${resultPrefix(result)} outcome expectation failed:\n  ${problems.join('\n  ')}`);
}
