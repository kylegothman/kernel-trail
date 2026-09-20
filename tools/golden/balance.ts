/**
 * WP-23 section 3: the balance ledger, `tests/golden/balance.json`.
 *
 * One row per shipped leg holding the numbers the game currently runs on:
 * the throughput target and whether it is provisional, one block per golden
 * path (ticks, objectives met, casualties, closing ledger, dividend and
 * throughput factor), the fixture's entering ledger and the comment beside
 * it, verbatim. `golden:record` writes a leg's row alongside its fingerprint
 * and `golden:balance` writes every shipped leg at once. The recorder
 * refuses a row whose fixture declares its entering ledger without a
 * comment immediately above the constant: a number nobody can source is
 * the state this ledger exists to end.
 *
 * `throughputFactor` recomputes `LegRunner.effectiveOutcome`'s clamp from
 * the throughput the harness read before exit; `tests/legs/balance.test.ts`
 * asserts the recomputation against the observed throughput on every row so
 * drift between the two shows up. Exposing the factor on `DebriefView` is
 * the follow-up that removes the duplication.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LEG_ORDER, type LegId, type ResourceLedger } from '@game/types';
import type { LegContent } from '@legs/content';
import { PROVISIONAL_THROUGHPUT_TARGET, throughputTargetFor } from '../../src/app/throughput';
import { checkFixtureRun, fixturePath, isWarning, loadFixtures, runFixture, validateFixture, type LegFixture } from '../../tests/legs/harness/fixtureContract';
import { GOLDEN_DIR, type GoldenPath } from '../../tests/legs/harness/goldenLog';
import type { HarnessResult } from '../../tests/legs/harness/LegHarness';
import { REPO_ROOT, tryLoadLegForTest } from '../../tests/legs/harness/loadLeg';

export const BALANCE_PATH = resolve(REPO_ROOT, 'tests', 'golden', 'balance.json');

export interface BalancePathRow {
  readonly ticks: number;
  readonly objectivesMet: number;
  readonly casualties: readonly string[];
  readonly closingLedger: ResourceLedger;
  readonly dividend: number;
  readonly throughputFactor: number;
}

export interface BalanceRow {
  readonly throughputTarget: { readonly value: number; readonly provisional: boolean };
  readonly good?: BalancePathRow;
  readonly bad?: BalancePathRow;
  readonly enteringLedger: ResourceLedger;
  readonly enteringSource: string;
}

export type BalanceLedger = Partial<Record<LegId, BalanceRow>>;

/** The ledger file beside a golden directory: the checked-in one for GOLDEN_DIR, a sibling file for a test directory. */
export function balanceFileFor(dir: string = GOLDEN_DIR): string {
  return resolve(dir) === resolve(GOLDEN_DIR) ? BALANCE_PATH : join(dir, 'balance.json');
}

export function readBalanceLedger(file: string = BALANCE_PATH): BalanceLedger | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as BalanceLedger;
}

const LEDGER_KEYS = ['cycles', 'quota', 'blocks', 'bandwidth'] as const;

function ledgerOf(partial: Partial<ResourceLedger>, label: string): ResourceLedger {
  const ledger = { cycles: 0, quota: 0, blocks: 0, bandwidth: 0 };
  for (const key of LEDGER_KEYS) {
    const value = partial[key];
    if (value === undefined) throw new Error(`${label}: enteringLedger.${key} is missing`);
    ledger[key] = value;
  }
  return ledger;
}

/** `LegRunner.effectiveOutcome`'s clamp, recomputed; the balance test holds the two together. */
export function throughputFactorOf(throughput: number, target: number): number {
  return Math.max(0.6, Math.min(1.4, throughput / target));
}

export function pathRowOf(result: HarnessResult, target: number): BalancePathRow {
  return {
    ticks: result.ticks,
    objectivesMet: result.outcome.objectivesMet.length,
    casualties: [...result.outcome.casualties],
    closingLedger: { ...result.ledgerAfter },
    dividend: result.dividend,
    throughputFactor: throughputFactorOf(result.throughput, target),
  };
}

const RE_EXPORT = /^\s*export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/m;

/** Follow `export { knownGood, knownBad } from './x'` to the module that declares the fixtures. */
export function fixtureSourcePath(id: LegId): string {
  const path = fixturePath(id);
  const source = readFileSync(path, 'utf8');
  const match = RE_EXPORT.exec(source);
  if (match?.[1] === undefined) return path;
  const target = resolve(dirname(path), match[1]);
  return existsSync(target) ? target : existsSync(`${target}.ts`) ? `${target}.ts` : target;
}

const trimComment = (line: string): string => line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/)\s?/, '').replace(/\s*\*\/\s*$/, '').trim();

/**
 * The comment immediately above the constant the fixtures name as their
 * `enteringLedger`, collapsed to one line. Throws, naming the file and the
 * constant, when the constant is not found or carries no comment: the
 * recorder turns that into a refusal.
 */
export function enteringSourceOf(id: LegId): string {
  const path = fixtureSourcePath(id);
  const lines = readFileSync(path, 'utf8').split('\n');
  const source = lines.join('\n');
  const names = new Set<string>();
  for (const match of source.matchAll(/enteringLedger\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) if (match[1] !== undefined) names.add(match[1]);
  if (names.size === 0) throw new Error(`${path}: no fixture names an identifier as its enteringLedger; the ledger needs one declared constant with a comment above it`);
  if (names.size > 1) throw new Error(`${path}: the fixtures name different enteringLedger constants (${[...names].join(', ')}); the ledger carries one entering ledger per leg`);
  const name = [...names][0] ?? '';
  const declaration = new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\b`);
  const index = lines.findIndex((line) => declaration.test(line));
  if (index === -1) throw new Error(`${path}: const ${name} is not declared in this file`);
  const collected: string[] = [];
  let i = index - 1;
  if (i >= 0 && /\*\/\s*$/.test(lines[i] ?? '')) {
    // A block comment ending on the line above; walk back to its opening.
    for (; i >= 0; i--) {
      collected.unshift(trimComment(lines[i] ?? ''));
      if (/^\s*\/\*/.test(lines[i] ?? '')) break;
    }
  } else {
    for (; i >= 0 && /^\s*\/\//.test(lines[i] ?? ''); i--) collected.unshift(trimComment(lines[i] ?? ''));
  }
  const text = collected.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) throw new Error(`${path}: const ${name} has no comment immediately above it saying where the entering ledger came from; the balance ledger refuses a number nobody can source`);
  return text;
}

export function rowFragmentOf(fixture: LegFixture, content: LegContent, enteringSource: string): Omit<BalanceRow, 'good' | 'bad'> {
  return {
    throughputTarget: { value: throughputTargetFor(content), provisional: content.throughputTarget === undefined },
    enteringLedger: ledgerOf(fixture.enteringLedger, `${fixture.legId} ${fixture.path}`),
    enteringSource,
  };
}

/** Merge one path's block into the leg's row and write the file, legs in LEG_ORDER, paths good then bad. */
export function writeBalanceRow(file: string, legId: LegId, path: GoldenPath, fragment: Omit<BalanceRow, 'good' | 'bad'>, row: BalancePathRow): void {
  const ledger = readBalanceLedger(file) ?? {};
  const previous = ledger[legId];
  const good = path === 'good' ? row : previous?.good;
  const bad = path === 'bad' ? row : previous?.bad;
  ledger[legId] = { ...fragment, ...(good === undefined ? {} : { good }), ...(bad === undefined ? {} : { bad }) };
  const ordered: BalanceLedger = {};
  for (const id of LEG_ORDER) {
    const entry = ledger[id];
    if (entry === undefined) continue;
    ordered[id] = {
      throughputTarget: entry.throughputTarget,
      ...(entry.good === undefined ? {} : { good: entry.good }),
      ...(entry.bad === undefined ? {} : { bad: entry.bad }),
      enteringLedger: entry.enteringLedger,
      enteringSource: entry.enteringSource,
    };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

export { PROVISIONAL_THROUGHPUT_TARGET };

export type BalanceOutcome =
  | { readonly status: 'written'; readonly row: BalanceRow }
  | { readonly status: 'invalid'; readonly problems: readonly string[] }
  | { readonly status: 'unshipped' | 'no_fixture'; readonly reason: string };

/** Run one fixture and write its block; the whole-leg entry point `golden:balance` uses, and the test's reference. */
export async function recordBalance(legId: LegId, path: GoldenPath, file: string = BALANCE_PATH): Promise<BalanceOutcome> {
  const loaded = await tryLoadLegForTest(legId);
  if (!loaded.shipped) return { status: 'unshipped', reason: loaded.reason };
  const fixtures = await loadFixtures(legId);
  if (fixtures === null) return { status: 'no_fixture', reason: `tests/legs/${legId}/fixtures.ts does not exist` };
  const fixture = path === 'good' ? fixtures.knownGood : fixtures.knownBad;
  const problems = validateFixture(fixture, loaded.leg).filter((problem) => !isWarning(problem));
  if (problems.length > 0) return { status: 'invalid', problems };
  let enteringSource: string;
  try {
    enteringSource = enteringSourceOf(legId);
  } catch (error) {
    return { status: 'invalid', problems: [error instanceof Error ? error.message : String(error)] };
  }
  const result = await runFixture(fixture, loaded.leg);
  const runProblems = checkFixtureRun(fixture, result, loaded.leg);
  if (runProblems.length > 0) return { status: 'invalid', problems: runProblems };
  const fragment = rowFragmentOf(fixture, loaded.content, enteringSource);
  const row = pathRowOf(result, fragment.throughputTarget.value);
  writeBalanceRow(file, legId, path, fragment, row);
  const written = readBalanceLedger(file)?.[legId];
  if (written === undefined) throw new Error(`${legId}: the balance row was not written to ${file}`);
  return { status: 'written', row: written };
}

export async function main(argv: readonly string[], log: (line: string) => void = console.log): Promise<number> {
  let file = BALANCE_PATH;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--file' && next !== undefined) { file = resolve(next); i++; } else {
      log(`golden:balance: unknown argument ${String(arg)}; the script takes --file <path> only and writes every shipped leg`);
      return 2;
    }
  }
  let failed = 0;
  for (const legId of LEG_ORDER) {
    for (const path of ['good', 'bad'] as const) {
      const outcome = await recordBalance(legId, path, file);
      switch (outcome.status) {
        case 'written': {
          const block = outcome.row[path];
          log(`golden:balance: ${legId} ${path}: ticks=${block?.ticks} objectivesMet=${block?.objectivesMet} dividend=${block?.dividend} throughputFactor=${block?.throughputFactor} target=${outcome.row.throughputTarget.value}${outcome.row.throughputTarget.provisional ? ' (provisional)' : ''}`);
          break;
        }
        case 'invalid':
          failed += 1;
          log(`golden:balance: ${legId} ${path}: not written:`);
          for (const problem of outcome.problems) log(`  ${problem}`);
          break;
        case 'unshipped':
          if (path === 'good') log(`golden:balance: skipped ${legId} (${outcome.reason})`);
          break;
        case 'no_fixture':
          failed += 1;
          log(`golden:balance: ${legId}: ${outcome.reason}`);
          break;
      }
    }
  }
  log(`golden:balance: wrote ${file}`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
