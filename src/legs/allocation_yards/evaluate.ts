/**
 * KERNEL TRAIL: the Allocation Yards' judgement.
 *
 * `evaluate` reads the kernel log through `asKernelEvents` (scope correction
 * section 14) and the player's own decisions through the yard model, and
 * writes nothing: a leg's write channel is an interaction handler, never this.
 */
import { asKernelEvents } from '@legs/events';
import type { ConvoyMemberId } from '@kernel/types';
import type { DebriefCard, LegEvaluationContext, LegOutcome, RunState } from '@game/types';
import { section } from './chapters';
import { ENTRY_PAGE_SIZE, TLB_ENTRIES } from './config';
import { CONVOY } from './populate';
import { executableBitChoice, LEG_ID } from './protection';
import { DEFAULT_ROUTE, PAGE_SIZES, PURCHASED_TLB_ENTRIES, readPaging, readRoute, type RouteId } from './routes';
import { bestStrategy, compareStrategies, interactionTicks, replayYard, strategyTrail, type YardReplay } from './yard';

const TERMINAL_PREFIX = '[terminal] ';

/** Every terminal line this leg saw, in order, with the bus's provenance prefix stripped. */
export function terminalLines(run: Readonly<RunState>): readonly { readonly tick: number; readonly line: string }[] {
  return run.decisions
    .filter((record) => record.legId === LEG_ID && record.kind === 'terminal')
    .map((record) => ({
      tick: record.tick,
      line: record.choice.startsWith(TERMINAL_PREFIX) ? record.choice.slice(TERMINAL_PREFIX.length) : record.choice,
    }));
}

const ranLine = (run: Readonly<RunState>, name: string, flag?: string): boolean =>
  terminalLines(run).some((entry) => matches(entry.line, name, flag));

const matches = (line: string, name: string, flag?: string): boolean => {
  const argv = line.trim().split(/\s+/);
  return argv[0] === name && (flag === undefined || argv.includes(flag));
};

function firstLineTick(run: Readonly<RunState>, name: string, flag?: string): number | null {
  const entry = terminalLines(run).find((candidate) => matches(candidate.line, name, flag));
  return entry?.tick ?? null;
}

/** The ticks at which `id` was accepted this leg; the yard model owns the parsing. */
const interactionTicksOf = (run: Readonly<RunState>, id: string): readonly number[] => interactionTicks(run.decisions, id);

export interface LegReading {
  readonly yard: YardReplay;
  readonly converted: boolean;
  readonly pageSize: number;
  readonly route: RouteId;
  readonly tlbEntries: number;
  readonly hitRate: number;
  readonly externalFragmentation: number;
  readonly internalFragmentation: number;
  readonly internalShare: number;
  readonly gateAttempts: number;
  readonly readPageTableBeforeGate: boolean;
  readonly compactionTicks: readonly number[];
  readonly kernelExhaustionTicks: readonly number[];
  readonly firstFragmentationTick: number | null;
}

/** Everything the leg judges itself on, from the decision log and the kernel log. */
export function readLeg(ctx: LegEvaluationContext): LegReading {
  const run = ctx.run;
  const events = asKernelEvents(ctx.events);
  const yard = replayYard(run.decisions, ctx.ticksElapsed);

  const converted = interactionTicksOf(run, 'yards.convert_to_paging').length > 0;
  const ups = interactionTicksOf(run, 'yards.page_size_up').length;
  const downs = interactionTicksOf(run, 'yards.page_size_down').length;
  const entryIndex = PAGE_SIZES.indexOf(ENTRY_PAGE_SIZE);
  const index = Math.max(0, Math.min(PAGE_SIZES.length - 1, entryIndex + ups - downs));
  const pageSize = PAGE_SIZES[index] ?? ENTRY_PAGE_SIZE;

  const contiguousTicks = interactionTicksOf(run, 'yards.route_contiguous');
  const scatteredTicks = interactionTicksOf(run, 'yards.route_scattered');
  const lastContiguous = contiguousTicks.at(-1);
  const lastScattered = scatteredTicks.at(-1);
  const route: RouteId = lastContiguous === undefined ? (lastScattered === undefined ? DEFAULT_ROUTE : 'route.scattered')
    : lastScattered === undefined || lastContiguous > lastScattered ? 'route.contiguous' : 'route.scattered';

  const bought = interactionTicksOf(run, 'yards.buy_tlb_entries').length > 0;
  const tlbEntries = bought ? PURCHASED_TLB_ENTRIES : TLB_ENTRIES;
  const paging = readPaging(pageSize);
  const gateTicks = interactionTicksOf(run, 'yards.answer_translation');
  const firstGate = gateTicks[0];
  const pagetableTick = firstLineTick(run, 'pagetable');

  return {
    yard,
    converted,
    pageSize,
    route,
    tlbEntries,
    hitRate: readRoute(route, tlbEntries).hitRate,
    externalFragmentation: converted ? 0 : yard.externalFragmentation,
    internalFragmentation: converted ? paging.internalFragmentation : 0,
    internalShare: converted ? paging.internalShare : 0,
    gateAttempts: gateTicks.length,
    readPageTableBeforeGate: firstGate !== undefined && pagetableTick !== null && pagetableTick <= firstGate,
    compactionTicks: interactionTicksOf(run, 'yards.compact'),
    kernelExhaustionTicks: events
      .filter((event) => event.type === 'memory.allocation_failed' && event.reason === 'no_space')
      .map((event) => event.tick),
    firstFragmentationTick: yard.failures.find((failure) => failure.reason === 'fragmentation')?.at ?? null,
  };
}

/** Half a frame per Program is the average waste paging produces (sim spec 6.3). */
export const internalBound = (pageSize: number): number => 0.5 * pageSize * CONVOY.length;

export function objectivesMet(ctx: LegEvaluationContext, reading: LegReading): readonly string[] {
  const run = ctx.run;
  const met: string[] = [];

  if (reading.externalFragmentation < 0.12 && reading.yard.unplaced.length === 0) {
    met.push('obj.allocation_yards.strategy_choice');
  }

  // Both clauses. The second is what makes it a diagnosis rather than a habit:
  // compaction after a genuine exhaustion is money spent on the wrong shape.
  const freeF = firstLineTick(run, 'free', '-f');
  const firstCompaction = reading.compactionTicks[0];
  const diagnosed = freeF !== null && reading.firstFragmentationTick !== null && freeF >= reading.firstFragmentationTick
    && (firstCompaction === undefined || freeF <= firstCompaction);
  // A compaction is the wrong cure when the yard cannot benefit from it: free
  // space already in one run, or nobody left waiting for a berth. That is what
  // `no_space` means in the yard's own terms, and the man page says compaction
  // will not help there. Keying this to the most recent failure's `reason`
  // instead would be unfalsifiable, because a berth the yard has refused is
  // retried on every movement and so the latest refusal is always one of shape.
  const compactedOnExhaustion = reading.compactionTicks.some((tick) => {
    const before = replayYard(run.decisions, Math.max(0, tick - 1));
    return before.freeRuns <= 1 || before.unplaced.length === 0;
  });
  if (diagnosed && !compactedOnExhaustion) met.push('obj.allocation_yards.diagnose_fragmentation');

  if (reading.converted && reading.externalFragmentation === 0
    && reading.internalFragmentation <= internalBound(reading.pageSize)) {
    met.push('obj.allocation_yards.paging_trade');
  }

  // The gate accepts one attempt. A second is refused rather than scored.
  if (reading.gateAttempts === 1 && reading.readPageTableBeforeGate) {
    met.push('obj.allocation_yards.translate_address');
  }

  if (reading.hitRate > 0.85 && reading.tlbEntries === TLB_ENTRIES) {
    met.push('obj.allocation_yards.locality_over_hardware');
  }

  if (executableBitChoice(run) === 'cleared') met.push('obj.allocation_yards.protection_bits');

  const paging = readPaging(reading.pageSize);
  if (reading.converted && paging.meetsRowBound && paging.meetsInternalBound) {
    met.push('obj.allocation_yards.page_size_tradeoff');
  }

  return met;
}

export function codexUnlocked(ctx: LegEvaluationContext, reading: LegReading, met: readonly string[]): readonly string[] {
  const run = ctx.run;
  const events = asKernelEvents(ctx.events);
  const unlocked: string[] = [];
  if (events.some((event) => event.type === 'memory.allocated')) unlocked.push('codex.address_binding');
  if (ranLine(run, 'pagetable', '--translate')) unlocked.push('codex.logical_vs_physical');
  if (ranLine(run, 'frag')) unlocked.push('codex.contiguous_allocation');
  if (events.some((event) => event.type === 'memory.allocation_failed') || reading.firstFragmentationTick !== null) {
    unlocked.push('codex.fragmentation');
  }
  if (met.includes('obj.allocation_yards.paging_trade')) unlocked.push('codex.paging');
  if (ranLine(run, 'tlb', '--stats')) unlocked.push('codex.tlb');
  if (ranLine(run, 'pagetable', '--bits')) unlocked.push('codex.page_protection');
  if (met.includes('obj.allocation_yards.page_size_tradeoff')) unlocked.push('codex.page_table_structure');
  return unlocked;
}

const percent = (value: number): string => (value * 100).toFixed(1);

export function debrief(ctx: LegEvaluationContext, reading: LegReading): DebriefCard {
  const run = ctx.run;
  const trail = strategyTrail(run.decisions);
  const compared = compareStrategies(run.decisions, ctx.ticksElapsed);
  const best = bestStrategy(compared);
  const routeName = reading.route === 'route.contiguous' ? 'the contiguous route' : 'the scattered route';
  const placed = reading.yard.unplaced.length === 0;

  let whatHappened =
    `You ran ${trail.join(', then ')}. External fragmentation ended at ${percent(reading.externalFragmentation)} percent `
    + `across ${reading.yard.freeRuns} free runs, largest ${reading.yard.largestRun} slabs. `
    + `Internal fragmentation ended at ${percent(reading.internalShare)} percent at page size ${reading.pageSize}. `
    + `Translation cache hit rate ${(reading.hitRate * 100).toFixed(0)} percent on ${routeName}.`;
  // One line, no warning, no badge. The fuse is forty minutes long and its
  // payoff is leg 12's, not this leg's.
  if (executableBitChoice(run) === 'left_set') whatHappened += '\nThe data pages are still executable.';

  return {
    headline: placed ? 'Placed.' : 'There was room and nowhere to put it.',
    whatHappened,
    whyItHappened: why(ctx, reading),
    counterfactual:
      `Your recorded sequence under ${best} ends at ${percent(compared[best].externalFragmentation)} percent external `
      + `fragmentation against your ${percent(reading.yard.externalFragmentation)}. Under worst fit the same sequence `
      + `ends at ${percent(compared.worst_fit.externalFragmentation)}.`,
    chapter: section('9.2.3'),
  };
}

function why(ctx: LegEvaluationContext, reading: LegReading): string {
  const run = ctx.run;
  const bought = run.decisions.find((record) => record.legId === LEG_ID && record.kind === 'buy_quota_on_fragmentation');
  if (bought !== undefined) {
    return `At the moment you bought 25 frames, ${bought.choice} slabs were already free. What you were short of was a run, not a total.`;
  }
  const failure = reading.yard.failures.find((candidate) => candidate.reason === 'fragmentation');
  if (strategyTrail(run.decisions).includes('worst_fit')) {
    const compared = compareStrategies(run.decisions, ctx.ticksElapsed);
    return `Leaving the largest remaining hole leaves the most holes. Across your recorded sequence it produced `
      + `${percent(compared.worst_fit.externalFragmentation)} percent external fragmentation against best fit's `
      + `${percent(compared.best_fit.externalFragmentation)}.`;
  }
  if (reading.converted) {
    const paging = readPaging(reading.pageSize);
    return `Any free frame fits any page, so external fragmentation is gone. The waste moved inside the last frame of `
      + `each Program, where it is ${percent(paging.internalShare)} percent and where a smaller page would shrink it at `
      + `the cost of ${readPaging(Math.max(512, reading.pageSize / 2)).indexRows - paging.indexRows} more index rows across the convoy.`;
  }
  if (failure !== undefined) {
    return `The slabs existed and they were in the wrong shape. A request for ${failure.requested} contiguous slabs fails `
      + `when the largest free run is ${failure.largestRun}, whatever the total says.`;
  }
  return 'Every Program was placed and the yard is in a shape the next request can use.';
}

export function evaluate(ctx: LegEvaluationContext): LegOutcome {
  const reading = readLeg(ctx);
  const met = objectivesMet(ctx, reading);
  const casualties: readonly ConvoyMemberId[] = ctx.run.convoy
    .filter((member) => member.status === 'derezzed' && member.epitaph?.legId === LEG_ID)
    .map((member) => member.id);
  return {
    survived: ctx.run.convoy.some((member) => member.status !== 'derezzed'),
    objectivesMet: met,
    casualties,
    // The leg awards nothing of its own: the closing ledger is the travel
    // arithmetic plus the runner's dividend, which is what leg 8 lives on.
    resourceDelta: {},
    codexUnlocked: codexUnlocked(ctx, reading, met),
    debrief: debrief(ctx, reading),
  };
}
