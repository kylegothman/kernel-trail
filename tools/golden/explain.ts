/**
 * WP-20 scope correction W3: `npm run golden:explain -- <legId> <path>`.
 *
 * Reruns the fixture, compares tiers 1 and 2 against the checked-in golden,
 * and on a mismatch prints the tier 2 differences, then the current run's
 * events around the earliest tick tier 2 localises, 50 events of context on
 * each side, with the tick and seq stated plainly, and exits non-zero.
 *
 * The golden holds no full log by design, so the recorded run cannot be
 * materialised under today's code; the window is the current run's, and
 * tier 2 is what says where to look. What can be materialised twice is the
 * current run: the fixture is run a second time, and if the two runs
 * disagree the first divergent event by seq is printed with its context,
 * which is the only case where two logs exist to compare event by event.
 */
import { pathToFileURL } from 'node:url';
import type { KernelEvent } from '@kernel/types';
import { LEG_ORDER, type Leg, type LegId } from '@game/types';
import { loadFixtures, runFixture, type LegFixtureModule } from '../../tests/legs/harness/fixtureContract';
import { compareTiers, earliestSummaryDivergence, firstDivergence, GOLDEN_DIR, goldenFiles, readGolden, tiersOf, type Divergence, type GoldenPath, type GoldenTiers } from '../../tests/legs/harness/goldenLog';
import { tryLoadLegForTest } from '../../tests/legs/harness/loadLeg';
import { renderEventLog } from './renderEventLog';

export const CONTEXT_EVENTS = 50;

export interface ExplainRequest {
  readonly legId: LegId;
  readonly path: GoldenPath;
  readonly dir?: string;
  readonly leg?: Leg;
  readonly fixtures?: LegFixtureModule;
}

export interface DivergenceWindow {
  readonly tick: number;
  readonly seq: number;
  readonly type: string;
  readonly events: readonly KernelEvent[];
}

export type ExplainOutcome =
  | { readonly status: 'match'; readonly tiers: GoldenTiers }
  | { readonly status: 'missing'; readonly reason: string }
  | { readonly status: 'nondeterministic'; readonly divergence: Divergence; readonly report: string }
  | { readonly status: 'mismatch'; readonly problems: readonly string[]; readonly window: DivergenceWindow; readonly report: string }
  | { readonly status: 'unshipped' | 'no_fixture'; readonly reason: string };

function windowAround(events: readonly KernelEvent[], tick: number, type: string): DivergenceWindow {
  let index = events.findIndex((event) => event.tick >= tick && event.type === type);
  if (index < 0) index = events.findIndex((event) => event.tick >= tick);
  if (index < 0) index = Math.max(0, events.length - 1);
  const anchor = events[index];
  return { tick: anchor?.tick ?? tick, seq: anchor?.seq ?? 0, type: anchor?.type ?? type, events: events.slice(Math.max(0, index - CONTEXT_EVENTS), index + CONTEXT_EVENTS + 1) };
}

export async function explainGolden(request: ExplainRequest): Promise<ExplainOutcome> {
  const dir = request.dir ?? GOLDEN_DIR;
  let leg = request.leg;
  if (leg === undefined) {
    const loaded = await tryLoadLegForTest(request.legId);
    if (!loaded.shipped) return { status: 'unshipped', reason: loaded.reason };
    leg = loaded.leg;
  }
  const fixtures = request.fixtures ?? (await loadFixtures(request.legId));
  if (fixtures === null) return { status: 'no_fixture', reason: `tests/legs/${request.legId}/fixtures.ts does not exist` };
  const fixture = request.path === 'good' ? fixtures.knownGood : fixtures.knownBad;
  const expected = readGolden(request.legId, request.path, dir);
  const files = goldenFiles(request.legId, request.path, dir);
  if (expected === null) return { status: 'missing', reason: `${files.fingerprint} or ${files.summary} is missing; record it with golden:record` };
  const first = await runFixture(fixture, leg);
  const second = await runFixture(fixture, leg);
  const divergence = firstDivergence(first.events, second.events, CONTEXT_EVENTS);
  if (divergence !== null || first.logHash !== second.logHash) {
    const found = divergence ?? { index: 0, tick: 0, seq: 0, expectedEvent: null, actualEvent: null, expected: first.events.slice(0, CONTEXT_EVENTS), actual: second.events.slice(0, CONTEXT_EVENTS) };
    const report = [
      `${request.legId} ${request.path}: two runs of the fixture in one process disagree; the run is not deterministic`,
      `first divergent event at tick ${found.tick} seq ${found.seq} (index ${found.index})`,
      'first run:', renderEventLog(found.expected), 'second run:', renderEventLog(found.actual),
    ].join('\n');
    return { status: 'nondeterministic', divergence: found, report };
  }
  const actual = tiersOf(first);
  const problems = compareTiers(actual, expected);
  if (problems.length === 0) return { status: 'match', tiers: actual };
  const localised = earliestSummaryDivergence(actual.summary, expected.summary);
  const window = localised === null ? windowAround(first.events, 0, first.events[0]?.type ?? '') : windowAround(first.events, localised.tick, localised.type);
  const report = [
    `${request.legId} ${request.path}: the run no longer matches ${files.fingerprint}`,
    ...problems.map((problem) => `  ${problem}`),
    localised === null
      ? 'tier 2 agrees, so the divergence is inside an event payload; the window starts at the first event'
      : `tier 2 localises the divergence to ${localised.type} at tick ${localised.tick}`,
    `first divergent event: tick ${window.tick} seq ${window.seq} (${window.type}); ${CONTEXT_EVENTS} events of context on each side follow`,
    renderEventLog(window.events),
  ].join('\n');
  return { status: 'mismatch', problems, window, report };
}

export async function main(argv: readonly string[], log: (line: string) => void = console.log): Promise<number> {
  const [legId, path, ...rest] = argv;
  let dir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir' && rest[i + 1] !== undefined) { dir = rest[i + 1]; i++; }
    else { log(`golden:explain: unknown argument ${String(rest[i])}`); return 2; }
  }
  if (legId === undefined || path === undefined || !LEG_ORDER.includes(legId as LegId) || (path !== 'good' && path !== 'bad')) {
    log('golden:explain: usage: golden:explain <legId> <good|bad> [--dir <dir>]');
    return 2;
  }
  const outcome = await explainGolden({ legId: legId as LegId, path, ...(dir === undefined ? {} : { dir }) });
  switch (outcome.status) {
    case 'match':
      log(`${legId} ${path}: matches the checked-in golden (hash ${outcome.tiers.fingerprint.hash}, ticks=${outcome.tiers.fingerprint.ticks}, events=${outcome.tiers.fingerprint.events})`);
      return 0;
    case 'missing':
    case 'unshipped':
    case 'no_fixture':
      log(`${legId} ${path}: ${outcome.reason}`);
      return 1;
    case 'nondeterministic':
    case 'mismatch':
      log(outcome.report);
      return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
