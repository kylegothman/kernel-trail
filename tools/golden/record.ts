/**
 * WP-20 section 7.4 and scope correction W3: `npm run golden:record`.
 *
 *   golden:record -- --leg the_cistern --path good
 *   golden:record -- --all
 *   golden:record -- --leg the_cistern --path good --force
 *
 * Runs the fixture and writes tiers 1 and 2. It refuses to overwrite an
 * existing golden unless `--force` is passed, and prints the old and new
 * hashes side by side when it does. A regenerated golden is a behaviour
 * change and is reviewed as one. `golden:update` is `golden:record --force`.
 * `UPDATE_GOLDEN` is never read: recording is a human action. Each leg's
 * closing ledger is printed for the next leg's fixture to copy.
 *
 * WP-23 section 3: the balance row is written in the same call as the
 * fingerprint, so a golden never lands without its ledger row. A fixture
 * loaded from disk must carry a comment immediately above its entering
 * ledger constant or the record is refused; injected fixtures (the harness
 * test's synthetic leg) have no source file and write no row.
 */
import { pathToFileURL } from 'node:url';
import { LEG_ORDER, type Leg, type LegId, type ResourceLedger } from '@game/types';
import type { LegContent } from '@legs/content';
import { checkFixtureRun, isWarning, loadFixtures, runFixture, validateFixture, type LegFixtureModule } from '../../tests/legs/harness/fixtureContract';
import { GOLDEN_DIR, goldenFiles, readGolden, tiersOf, writeGolden, type GoldenPath, type GoldenTiers } from '../../tests/legs/harness/goldenLog';
import { tryLoadLegForTest } from '../../tests/legs/harness/loadLeg';
import { balanceFileFor, enteringSourceOf, pathRowOf, rowFragmentOf, writeBalanceRow } from './balance';

export interface RecordRequest {
  readonly legId: LegId;
  readonly path: GoldenPath;
  readonly force?: boolean;
  readonly dir?: string;
  /** Test injection: the leg and fixtures in place of the loaders. */
  readonly leg?: Leg;
  readonly fixtures?: LegFixtureModule;
}

export type RecordOutcome =
  | { readonly status: 'written'; readonly previous: GoldenTiers | null; readonly next: GoldenTiers; readonly ledger: ResourceLedger; readonly warnings: readonly string[] }
  | { readonly status: 'refused'; readonly previous: GoldenTiers; readonly next: GoldenTiers; readonly warnings: readonly string[] }
  | { readonly status: 'invalid'; readonly problems: readonly string[] }
  | { readonly status: 'unshipped' | 'no_fixture'; readonly reason: string };

export async function recordGolden(request: RecordRequest): Promise<RecordOutcome> {
  const dir = request.dir ?? GOLDEN_DIR;
  let leg = request.leg;
  let loaded: { readonly content: LegContent } | null = null;
  if (leg === undefined) {
    const result = await tryLoadLegForTest(request.legId);
    if (!result.shipped) return { status: 'unshipped', reason: result.reason };
    leg = result.leg;
    loaded = result;
  }
  const fixtures = request.fixtures ?? (await loadFixtures(request.legId));
  if (fixtures === null) return { status: 'no_fixture', reason: `tests/legs/${request.legId}/fixtures.ts does not exist` };
  const fixture = request.path === 'good' ? fixtures.knownGood : fixtures.knownBad;
  const findings = validateFixture(fixture, leg);
  const errors = findings.filter((problem) => !isWarning(problem));
  if (errors.length > 0) return { status: 'invalid', problems: errors };
  let enteringSource: string | null = null;
  if (request.fixtures === undefined) {
    try {
      enteringSource = enteringSourceOf(request.legId);
    } catch (error) {
      return { status: 'invalid', problems: [error instanceof Error ? error.message : String(error)] };
    }
  }
  const result = await runFixture(fixture, leg);
  const runProblems = checkFixtureRun(fixture, result, leg);
  if (runProblems.length > 0) return { status: 'invalid', problems: runProblems };
  const next = tiersOf(result);
  const previous = readGolden(request.legId, request.path, dir);
  const warnings = findings.filter(isWarning);
  if (previous !== null && request.force !== true) return { status: 'refused', previous, next, warnings };
  writeGolden(request.legId, request.path, next, dir);
  if (enteringSource !== null && loaded !== null) {
    const fragment = rowFragmentOf(fixture, loaded.content, enteringSource);
    writeBalanceRow(balanceFileFor(dir), request.legId, request.path, fragment, pathRowOf(result, fragment.throughputTarget.value));
  } else warnings.push('balance row not written: the fixtures were injected rather than loaded from tests/legs');
  return { status: 'written', previous, next, ledger: result.ledgerAfter, warnings };
}

const ledgerLine = (ledger: ResourceLedger): string => `cycles=${ledger.cycles} quota=${ledger.quota} blocks=${ledger.blocks} bandwidth=${ledger.bandwidth}`;

export function describeRecord(request: RecordRequest, outcome: RecordOutcome): readonly string[] {
  const label = `${request.legId} ${request.path}`;
  const files = goldenFiles(request.legId, request.path, request.dir ?? GOLDEN_DIR);
  switch (outcome.status) {
    case 'written': {
      const lines = [`${label}: recorded ${files.fingerprint} and ${files.summary}`];
      if (outcome.previous !== null) lines.push(`${label}: old hash ${outcome.previous.fingerprint.hash}  new hash ${outcome.next.fingerprint.hash} (forced; review this as a behaviour change)`);
      else lines.push(`${label}: hash ${outcome.next.fingerprint.hash} ticks=${outcome.next.fingerprint.ticks} events=${outcome.next.fingerprint.events}`);
      lines.push(`${label}: closing ledger ${ledgerLine(outcome.ledger)} (the next leg's enteringLedger)`);
      if (request.fixtures === undefined) lines.push(`${label}: balance row written to ${balanceFileFor(request.dir ?? GOLDEN_DIR)}`);
      lines.push(...outcome.warnings.map((warning) => `${label}: ${warning}`));
      return lines;
    }
    case 'refused':
      return [
        `${label}: refusing to overwrite ${files.fingerprint}; pass --force to regenerate`,
        `${label}: old hash ${outcome.previous.fingerprint.hash}  new hash ${outcome.next.fingerprint.hash}${outcome.previous.fingerprint.hash === outcome.next.fingerprint.hash ? ' (unchanged)' : ' (differs)'}`,
        ...outcome.warnings.map((warning) => `${label}: ${warning}`),
      ];
    case 'invalid':
      return [`${label}: not recorded; the fixture does not hold:`, ...outcome.problems.map((problem) => `  ${problem}`)];
    case 'unshipped':
      return [`${label}: not recorded; the leg has not shipped (${outcome.reason})`];
    case 'no_fixture':
      return [`${label}: not recorded; ${outcome.reason}`];
  }
}

export interface RecordArgs {
  readonly legId: LegId | null;
  readonly path: GoldenPath | null;
  readonly all: boolean;
  readonly force: boolean;
  readonly dir: string | null;
}

export function parseArgs(argv: readonly string[]): RecordArgs {
  const args: { legId: LegId | null; path: GoldenPath | null; all: boolean; force: boolean; dir: string | null } = { legId: null, path: null, all: false, force: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--all') args.all = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--leg' && next !== undefined) { args.legId = next as LegId; i++; }
    else if (arg === '--path' && next !== undefined) { args.path = next as GoldenPath; i++; }
    else if (arg === '--dir' && next !== undefined) { args.dir = next; i++; }
    else throw new Error(`unknown argument ${String(arg)}`);
  }
  if (args.legId !== null && !LEG_ORDER.includes(args.legId)) throw new Error(`unknown leg ${args.legId}`);
  if (args.path !== null && args.path !== 'good' && args.path !== 'bad') throw new Error(`path must be good or bad, not ${String(args.path)}`);
  if (!args.all && (args.legId === null || args.path === null)) throw new Error('pass --leg <id> --path <good|bad>, or --all');
  return args;
}

export async function main(argv: readonly string[], log: (line: string) => void = console.log): Promise<number> {
  let args: RecordArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log(`golden:record: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const requests: RecordRequest[] = [];
  const ids = args.all ? LEG_ORDER : [args.legId as LegId];
  const paths: GoldenPath[] = args.all ? ['good', 'bad'] : [args.path as GoldenPath];
  for (const legId of ids) for (const path of paths) requests.push({ legId, path, force: args.force, ...(args.dir === null ? {} : { dir: args.dir }) });
  let failed = 0;
  for (const request of requests) {
    const outcome = await recordGolden(request);
    for (const line of describeRecord(request, outcome)) log(line);
    if (outcome.status === 'refused' || outcome.status === 'invalid') failed += 1;
    if (!args.all && (outcome.status === 'unshipped' || outcome.status === 'no_fixture')) failed += 1;
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
