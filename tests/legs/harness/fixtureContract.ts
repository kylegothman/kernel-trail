/**
 * WP-20 section 7.3 and ruling F4: the fixture contract every leg package
 * supplies at `tests/legs/<leg_id>/fixtures.ts`, exporting exactly
 * `knownGood` and `knownBad`. This package defines the type, the loader and
 * the checks; it writes no fixture.
 *
 * `validateFixture(f, leg?)` is static: the rules a fixture can break before
 * it runs. `checkFixtureRun(f, result, leg)` holds the rules that need a
 * run: the known-good path meets every declared objective, the known-bad
 * path produces a casualty and a decision marked fatal, neither panics, and
 * neither leaves a step unfired.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startingLedger } from '@game/travel/ledger';
import { LEG_ORDER, type DecisionRecord, type DifficultyTier, type DiscClass, type Leg, type LegId, type Pace, type Rations, type ResourceLedger, type RunState } from '@game/types';
import { validateScript, type DecisionScript } from './decisionScript';
import { outcomeProblems, type OutcomeExpectation } from './expectOutcome';
import { runLeg, type HarnessResult } from './LegHarness';
import { REPO_ROOT } from './loadLeg';
import { makeRunState } from './makeRunState';

/** Every shipped leg package names this seed in its golden fixture; `validateFixture` warns on another. */
export const FIXTURE_SEED = 0x4b54524c;

export interface LegFixture {
  readonly legId: LegId;
  readonly path: 'good' | 'bad';
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  readonly pace: Pace;
  readonly rations: Rations;
  /** The previous leg's golden closing ledger, or the starting ledger for leg 0. */
  readonly enteringLedger: Partial<ResourceLedger>;
  /** DecisionRecords a previous leg wrote that this leg reads. Empty for most legs. */
  readonly enteringDecisions: readonly DecisionRecord[];
  readonly script: DecisionScript;
  readonly expect: OutcomeExpectation;
}

export interface LegFixtureModule {
  readonly knownGood: LegFixture;
  readonly knownBad: LegFixture;
}

export function fixturePath(id: LegId): string {
  return resolve(REPO_ROOT, 'tests', 'legs', id, 'fixtures.ts');
}

function isFixture(value: unknown): value is LegFixture {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return typeof f.legId === 'string' && (f.path === 'good' || f.path === 'bad') && typeof f.seed === 'number'
    && typeof f.script === 'object' && f.script !== null && typeof f.expect === 'object' && f.expect !== null
    && typeof f.enteringLedger === 'object' && f.enteringLedger !== null && Array.isArray(f.enteringDecisions);
}

/** Null when the leg has no fixture module; throws when the module exists but does not export exactly `knownGood` and `knownBad`. */
export async function loadFixtures(id: LegId): Promise<LegFixtureModule | null> {
  const path = fixturePath(id);
  if (!existsSync(path)) return null;
  const module: unknown = await import(/* @vite-ignore */ pathToFileURL(path).href);
  if (typeof module !== 'object' || module === null) throw new Error(`fixtures for ${id}: the module is not an object`);
  const names = Object.keys(module).sort();
  if (names.join(',') !== 'knownBad,knownGood') throw new Error(`fixtures for ${id}: expected exactly the exports knownGood and knownBad, found ${JSON.stringify(names)}`);
  const { knownGood, knownBad } = module as Record<string, unknown>;
  if (!isFixture(knownGood) || !isFixture(knownBad)) throw new Error(`fixtures for ${id}: knownGood and knownBad must be LegFixture objects`);
  return { knownGood, knownBad };
}

const LEDGER_KEYS = ['cycles', 'quota', 'blocks', 'bandwidth'] as const;

/**
 * Static problems, with warnings prefixed `warning:`. Rule 1 (the known-good
 * path meets every declared objective) is checked against the expectation
 * when `leg` is given, and against the run in `checkFixtureRun`.
 */
export function validateFixture(f: LegFixture, leg?: Leg): readonly string[] {
  const problems: string[] = [];
  const label = `${f.legId} ${f.path}`;
  if (!LEG_ORDER.includes(f.legId)) problems.push(`${label}: unknown leg id`);
  if (f.script.legId !== f.legId) problems.push(`${label}: the script belongs to ${f.script.legId}`);
  if (leg !== undefined && leg.id !== f.legId) problems.push(`${label}: the leg given is ${leg.id}`);
  if (f.seed !== FIXTURE_SEED) problems.push(`warning: ${label}: seed ${f.seed} is not the shared fixture seed ${FIXTURE_SEED}; document the reason in the fixture`);
  for (const problem of validateScript(f.script)) problems.push(`${label}: script: ${problem}`);
  for (const key of LEDGER_KEYS) {
    const value = f.enteringLedger[key];
    if (value === undefined) problems.push(`${label}: enteringLedger.${key} is missing`);
    else if (!Number.isFinite(value) || value < 0) problems.push(`${label}: enteringLedger.${key} is ${String(value)}`);
  }
  const index = LEG_ORDER.indexOf(f.legId);
  if (index === 0) {
    const starting = startingLedger(f.discClass, f.difficulty);
    for (const key of LEDGER_KEYS) {
      if (f.enteringLedger[key] !== undefined && f.enteringLedger[key] !== starting[key]) {
        problems.push(`${label}: enteringLedger.${key} is ${String(f.enteringLedger[key])}; leg 0 enters with the starting ledger, ${starting[key]}`);
      }
    }
  }
  f.enteringDecisions.forEach((record, i) => {
    if (typeof record.kind !== 'string' || typeof record.choice !== 'string' || !LEG_ORDER.includes(record.legId) || !Number.isFinite(record.tick)) {
      problems.push(`${label}: enteringDecisions[${i}] is not a DecisionRecord`);
    }
  });
  const expected = f.expect;
  if (f.path === 'good') {
    if (expected.objectivesMet === undefined && expected.objectivesAtLeast === undefined) problems.push(`${label}: the known-good expectation must name the objectives it meets (objectivesMet or objectivesAtLeast)`);
    if (expected.survived === false) problems.push(`${label}: the known-good expectation says the convoy does not survive`);
    if (leg !== undefined && (expected.objectivesMet !== undefined || expected.objectivesAtLeast !== undefined)) {
      const declared = leg.objectives.map((objective) => objective.id);
      const named = expected.objectivesMet ?? expected.objectivesAtLeast ?? [];
      const missing = declared.filter((id) => !named.includes(id));
      if (missing.length > 0) problems.push(`${label}: the known-good expectation does not claim every declared objective; missing [${missing.join(', ')}]`);
      const unknown = named.filter((id) => !declared.includes(id));
      if (unknown.length > 0) problems.push(`${label}: the known-good expectation names objectives the leg does not declare [${unknown.join(', ')}]`);
    }
  } else {
    const namesCasualty = (expected.casualties !== undefined && expected.casualties.length > 0) || (expected.casualtyCount !== undefined && expected.casualtyCount > 0) || expected.survived === false;
    if (!namesCasualty) problems.push(`${label}: the known-bad expectation must say which Program dies (casualties, casualtyCount or survived false)`);
    if (!(expected.decisionOutcomes ?? []).some((entry) => entry.outcome === 'fatal')) problems.push(`${label}: the known-bad expectation must name the decision marked fatal (decisionOutcomes)`);
    if (expected.ticksBetween === undefined) problems.push(`${label}: the known-bad expectation must say roughly when (ticksBetween)`);
  }
  return problems;
}

export const isWarning = (problem: string): boolean => problem.startsWith('warning:');

export function fixtureRunState(f: LegFixture): RunState {
  return makeRunState({
    seed: f.seed, legIndex: LEG_ORDER.indexOf(f.legId), discClass: f.discClass, difficulty: f.difficulty,
    pace: f.pace, rations: f.rations, ledger: f.enteringLedger, decisions: f.enteringDecisions,
  });
}

export interface FixtureRunOptions {
  readonly restoreAt?: number;
  readonly maxTicks?: number;
}

export async function runFixture(f: LegFixture, leg: Leg, options: FixtureRunOptions = {}): Promise<HarnessResult> {
  return runLeg(leg, {
    seed: f.seed, script: f.script, run: fixtureRunState(f),
    ...(options.restoreAt === undefined ? {} : { restoreAt: options.restoreAt }),
    ...(options.maxTicks === undefined ? {} : { maxTicks: options.maxTicks }),
  });
}

/** The run-dependent rules of section 7.3, empty when the run honours the fixture. */
export function checkFixtureRun(f: LegFixture, result: HarnessResult, leg: Leg): readonly string[] {
  const problems: string[] = [];
  const label = `${f.legId} ${f.path}`;
  if (result.panics.length > 0) problems.push(`${label}: the run panicked: ${result.panics.join('; ')}`);
  if (result.legFailures.length > 0) problems.push(`${label}: leg failures: ${result.legFailures.map((failure) => failure.phase).join(', ')}`);
  if (result.runnerFailures.length > 0) problems.push(`${label}: runner failures: ${result.runnerFailures.join('; ')}`);
  if (result.unfiredSteps.length > 0) problems.push(`${label}: ${result.unfiredSteps.length} script step(s) never fired`);
  if (f.path === 'good') {
    const declared = leg.objectives.map((objective) => objective.id);
    const missed = declared.filter((id) => !result.outcome.objectivesMet.includes(id));
    if (missed.length > 0) problems.push(`${label}: the known-good run missed declared objectives [${missed.join(', ')}]`);
  } else {
    if (result.outcome.casualties.length === 0) problems.push(`${label}: the known-bad run produced no casualty`);
    if (!result.decisions.some((record) => record.outcome === 'fatal')) problems.push(`${label}: the known-bad run marked no decision fatal`);
  }
  for (const problem of outcomeProblems(result, f.expect)) problems.push(`${label}: ${problem}`);
  return problems;
}
