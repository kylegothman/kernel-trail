/**
 * Scoring, WP-17 acceptance 32: monotonic and pure, never a specific total.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiscClass, DifficultyTier } from '../../src/game/types';
import {
  CLASS_MULTIPLIER,
  DIFFICULTY_FACTOR,
  SCORE_WEIGHTS,
  classMultiplierFor,
  computeScore,
  scoreFromRun,
  scoreTotal,
  type ScoringInput,
} from '../../src/game/scoring';
import { worstCaseRun } from '../ui/fixtures';

const base: ScoringInput = {
  survivors: 3,
  workloadCompletions: 40,
  unspentCycles: 300,
  unspentQuota: 20,
  goodDecisions: 5,
  costlyDecisions: 2,
  fatalDecisions: 1,
  privilegeExcess: 0,
  objectivesMet: 9,
  discClass: 'daemon',
  difficulty: 'operator',
  status: 'complete',
};

const CLASSES: readonly DiscClass[] = ['shell', 'daemon', 'compiler'];
const TIERS: readonly DifficultyTier[] = ['novice', 'operator', 'architect', 'kernel_space'];

describe('scoring', () => {
  it('monotonic survivors: more survivors never lowers total', () => {
    for (const discClass of CLASSES) {
      for (const difficulty of TIERS) {
        let previous = Number.NEGATIVE_INFINITY;
        for (let survivors = 0; survivors <= 5; survivors++) {
          const total = computeScore({ ...base, survivors, discClass, difficulty }).total;
          expect(total, `${discClass}/${difficulty} survivors ${survivors}`).toBeGreaterThanOrEqual(previous);
          previous = total;
        }
      }
    }
    // A failed run counts survivors as zero and still scores the rest.
    const failed = computeScore({ ...base, status: 'failed' });
    expect(failed.survivors).toBe(0);
    expect(failed.throughput).toBeGreaterThan(0);
  });

  it('monotonic correctness: higher privilege excess never raises correctness', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let excess = 0; excess <= 20; excess++) {
      const c = computeScore({ ...base, privilegeExcess: excess }).correctness;
      expect(c, `excess ${excess}`).toBeLessThanOrEqual(previous);
      previous = c;
    }
    expect(SCORE_WEIGHTS.perPrivilegeExcess).toBeLessThanOrEqual(0);
    expect(SCORE_WEIGHTS.perCostlyDecision).toBeLessThanOrEqual(0);
    expect(SCORE_WEIGHTS.perFatalDecision).toBeLessThanOrEqual(0);
    expect(computeScore({ ...base, goodDecisions: 6 }).correctness).toBeGreaterThanOrEqual(computeScore(base).correctness);
  });

  it('pure: total is a function of the six components and the multiplier alone', () => {
    const a = computeScore(base);
    const b = computeScore({ ...base });
    expect(a).toEqual(b);
    const { total, ...components } = a;
    expect(scoreTotal(components)).toBe(total);
    expect(scoreTotal({ ...components, classMultiplier: components.classMultiplier * 2 })).toBe(
      Math.round((components.survivors + components.throughput + components.efficiency + components.correctness + components.conceptsMastered) * components.classMultiplier * 2),
    );
    // The same components under different inputs give the same total: nothing else leaks in.
    const other = { ...a, total: 0 };
    expect(scoreTotal(other)).toBe(total);
    expect(a.classMultiplier).toBe(classMultiplierFor('daemon', 'operator'));
    expect(classMultiplierFor('compiler', 'kernel_space')).toBe(CLASS_MULTIPLIER.compiler * DIFFICULTY_FACTOR.kernel_space);
    const fromRun = scoreFromRun(worstCaseRun(), { workloadCompletions: 12, privilegeExcess: 1 });
    expect(fromRun.survivors).toBe(SCORE_WEIGHTS.perSurvivor * 5);
    expect(fromRun.classMultiplier).toBe(classMultiplierFor('compiler', 'operator'));
    expect(fromRun.total).toBe(scoreTotal(fromRun));
  });

  it('placeholder marked: the weights carry a TODO(astra) naming the phase 2 balance pass', () => {
    const source = readFileSync(resolve(__dirname, '..', '..', 'src', 'game', 'scoring.ts'), 'utf8');
    const markers = source.match(/\/\/ TODO\(astra\): balance pass in phase 2/g) ?? [];
    expect(markers.length).toBeGreaterThanOrEqual(3);
    expect(source).toMatch(/TODO\(astra\): balance pass in phase 2[^\n]*\n\s*export const SCORE_WEIGHTS/);
    expect(source).toMatch(/TODO\(astra\): balance pass in phase 2[^\n]*\n\s*export const CLASS_MULTIPLIER/);
    expect(source).toMatch(/TODO\(astra\): balance pass in phase 2[^\n]*\n\s*export const DIFFICULTY_FACTOR/);
    expect(source).toMatch(/15\.2/);
  });
});
