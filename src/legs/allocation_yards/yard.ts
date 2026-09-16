/**
 * KERNEL TRAIL: the Allocation Yards' contiguous yard, the leg's own model.
 *
 * READ THIS BEFORE TREATING ANY NUMBER HERE AS KERNEL STATE. The leg's kernel
 * runs 21 frames of paged memory, and `free -f`, `frag` and the world's frame
 * vault all report that paged frame table. The 256-slot yard below is the
 * leg's model of contiguous allocation (pre-flight ruling 2). It is built on
 * WP-05's `HoleList`, so every placement decision is the shipped allocator's
 * arithmetic rather than a second implementation of it, and it never touches
 * the live frame table or the live event log.
 *
 * The model is a pure function of `RunState.decisions` and a tick. That is
 * exactly what a replay and a mid-leg restore reproduce, so an interaction
 * handler and `evaluate` derive the same yard from the same run, and
 * `frag --compare` can replay the recorded sequence under all four strategies
 * without a shadow kernel.
 */
import { asPid, type AllocationStrategy } from '@kernel/types';
import { HoleList } from '@kernel/memory/contiguous/HoleList';
import { BuddyAllocator } from '@kernel/memory/contiguous/buddy';
import type { ConvoyMemberId } from '@kernel/types';
import type { DecisionRecord } from '@game/types';

/** The yard, in slabs. A power of two so buddy can restripe it (sim spec 6.2). */
export const YARD_SLOTS = 256;
/** The traffic that fragmented the yard before the convoy arrived. */
export const RESERVED_SLOTS = 159;
/** Slots free at the opening refusal: 97 of 256, which is 38 percent (curriculum map, leg 7). */
export const OPENING_FREE_SLOTS = YARD_SLOTS - RESERVED_SLOTS;

/**
 * The opening free runs: thirty-two of two, eight of three and one of nine.
 * Forty-one runs, ninety-seven slots, largest nine. Those four numbers are the
 * curriculum map's and they are what `free -f` reports at the refusal.
 */
export const OPENING_FREE_RUNS: readonly number[] = buildOpeningRuns();

function buildOpeningRuns(): readonly number[] {
  const runs: number[] = [];
  for (let index = 0; index < 41; index++) {
    // The nine sits in the middle of the yard, so the player has to walk to find it.
    if (index === 20) runs.push(9);
    else if (index % 5 === 2) runs.push(3);
    else runs.push(2);
  }
  return runs;
}

/** The occupied blocks between the free runs, summing to `RESERVED_SLOTS`. */
function openingOccupied(count: number): readonly number[] {
  const base = Math.floor(RESERVED_SLOTS / count);
  const wide = RESERVED_SLOTS % count;
  return Array.from({ length: count }, (_, index) => base + (index < wide ? 1 : 0));
}

export function openingHoles(): readonly { readonly start: number; readonly size: number }[] {
  const free = OPENING_FREE_RUNS;
  const occupied = openingOccupied(free.length);
  const holes: { start: number; size: number }[] = [];
  let cursor = 0;
  for (let index = 0; index < free.length; index++) {
    cursor += occupied[index] ?? 0;
    holes.push({ start: cursor, size: free[index] ?? 0 });
    cursor += free[index] ?? 0;
  }
  return holes;
}

/** A fresh yard at its opening layout under `strategy`. */
export function openYard(strategy: AllocationStrategy): HoleList {
  return new HoleList(YARD_SLOTS, strategy, 1, openingHoles());
}

/* ------------------------------------------------------------------ */
/* The convoy's berths                                                 */
/* ------------------------------------------------------------------ */

export interface BerthRequest {
  readonly member: ConvoyMemberId;
  readonly name: string;
  /** Contiguous slabs the address space needs. */
  readonly slots: number;
  /** Bytes actually requested, which is short of a whole page (sim spec 6.3). */
  readonly bytes: number;
}

/**
 * Five address spaces needing contiguous berths. `slots` is the page count of
 * `populate`'s roster; `bytes` is short of the last page by the authored
 * residue, so converting to paging moves waste inside the last frame rather
 * than inventing it.
 */
export const BERTHS: readonly BerthRequest[] = [
  { member: 'lumen', name: 'LUMEN', slots: 12, bytes: 12 * 4096 - 1024 },
  { member: 'sable', name: 'SABLE', slots: 10, bytes: 10 * 4096 - 2048 },
  { member: 'orrery', name: 'ORRERY', slots: 10, bytes: 10 * 4096 - 1536 },
  { member: 'kestrel', name: 'KESTREL', slots: 8, bytes: 8 * 4096 - 2560 },
  { member: 'vesper', name: 'VESPER', slots: 11, bytes: 11 * 4096 - 1024 },
];

/** The request the opening refusal is about: the largest berth, refused against a nine-slot run. */
export const OPENING_REQUEST_SLOTS = 12;

/* ------------------------------------------------------------------ */
/* The recorded sequence                                               */
/* ------------------------------------------------------------------ */

/** One background movement in the yard, advanced by the clock rather than by a roll. */
type BackgroundOp =
  | { readonly kind: 'request'; readonly slots: number }
  /** Which live background occupant departs, counted from the oldest. */
  | { readonly kind: 'release'; readonly nth: number };

/**
 * The yard's resident traffic. The package's population gives the yard
 * arrivals and departures that "keep fragmenting it during the leg"; this is
 * that traffic as an op script, advanced one entry every `YARD_OP_INTERVAL`
 * ticks so the sequence is a function of the clock and never of a roll.
 *
 * Departures are scattered through the live set rather than taken from the
 * front, because a yard that always empties its oldest bay leaves one hole at
 * a time and every strategy picks the same one. Scattered departures leave
 * holes of several sizes at once, which is the only condition under which
 * first, best and worst fit choose differently.
 */
const BACKGROUND: readonly BackgroundOp[] = [
  // The first half churns: arrivals and scattered departures, which is the
  // only condition under which first, best and worst fit choose differently.
  { kind: 'request', slots: 3 }, { kind: 'request', slots: 2 }, { kind: 'request', slots: 3 },
  { kind: 'release', nth: 1 }, { kind: 'request', slots: 2 }, { kind: 'request', slots: 3 },
  { kind: 'release', nth: 0 }, { kind: 'request', slots: 2 }, { kind: 'release', nth: 2 },
  { kind: 'request', slots: 3 }, { kind: 'release', nth: 1 }, { kind: 'request', slots: 2 },
  // The second half only arrives. Nothing departs, so nothing coalesces, and
  // the shape the first half left is the shape the convoy finishes the leg in.
  { kind: 'request', slots: 3 }, { kind: 'request', slots: 2 }, { kind: 'request', slots: 3 },
  { kind: 'request', slots: 2 }, { kind: 'request', slots: 3 }, { kind: 'request', slots: 2 },
  { kind: 'request', slots: 3 }, { kind: 'request', slots: 2 }, { kind: 'request', slots: 3 },
  { kind: 'request', slots: 2 }, { kind: 'request', slots: 3 }, { kind: 'request', slots: 2 },
];

export const YARD_OP_INTERVAL = 4;

export type YardStep =
  | { readonly at: number; readonly kind: 'berths' }
  | { readonly at: number; readonly kind: 'background'; readonly index: number }
  | { readonly at: number; readonly kind: 'compact' };

/** The recorded sequence up to `atTick`: the berths, the background traffic and every compaction. */
export function recordedSequence(decisions: readonly DecisionRecord[], atTick: number): readonly YardStep[] {
  const steps: YardStep[] = [{ at: 0, kind: 'berths' }];
  for (let index = 0; index * YARD_OP_INTERVAL <= atTick; index++) {
    if (index === 0) continue;
    steps.push({ at: index * YARD_OP_INTERVAL, kind: 'background', index: (index - 1) % BACKGROUND.length });
  }
  for (const tick of interactionTicks(decisions, 'yards.compact', atTick)) steps.push({ at: tick, kind: 'compact' });
  // A compaction at the same tick as a background movement follows it, because
  // the crew slides whatever is in the yard when it arrives.
  return steps.sort((a, b) => a.at - b.at || rank(a) - rank(b));
}

const rank = (step: YardStep): number => (step.kind === 'berths' ? 0 : step.kind === 'background' ? 1 : 2);

/** The ticks at which this leg's `id` interaction was accepted, in order. */
export function interactionTicks(decisions: readonly DecisionRecord[], id: string, atTick = Number.POSITIVE_INFINITY): readonly number[] {
  return decisions
    .filter((record) => record.legId === 'allocation_yards' && record.kind === 'interaction'
      && record.choice.startsWith(`${id} @`) && record.outcome !== 'costly' && record.tick <= atTick)
    .map((record) => record.tick);
}

/** The strategy in force at `tick`: the last accepted `set_allocation`, else the leg's entry value. */
export function strategyAt(decisions: readonly DecisionRecord[], tick: number, entry: AllocationStrategy = 'first_fit'): AllocationStrategy {
  let strategy = entry;
  for (const record of decisions) {
    if (record.legId !== 'allocation_yards' || record.kind !== 'set_allocation' || record.tick > tick) continue;
    if (isStrategy(record.choice)) strategy = record.choice;
  }
  return strategy;
}

function isStrategy(value: string): value is AllocationStrategy {
  return value === 'first_fit' || value === 'best_fit' || value === 'worst_fit' || value === 'buddy';
}

/** Every strategy the player actually ran, in order, for the debrief. */
export function strategyTrail(decisions: readonly DecisionRecord[], entry: AllocationStrategy = 'first_fit'): readonly AllocationStrategy[] {
  const trail: AllocationStrategy[] = [entry];
  for (const record of decisions) {
    if (record.legId !== 'allocation_yards' || record.kind !== 'set_allocation' || !isStrategy(record.choice)) continue;
    if (trail[trail.length - 1] !== record.choice) trail.push(record.choice);
  }
  return trail;
}

/* ------------------------------------------------------------------ */
/* The replay                                                          */
/* ------------------------------------------------------------------ */

export interface YardFailure {
  readonly at: number;
  readonly occupant: string;
  readonly requested: number;
  readonly reason: 'no_space' | 'fragmentation';
  readonly largestRun: number;
  readonly freeSlots: number;
}

export interface YardShape {
  readonly freeSlots: number;
  readonly freeRuns: number;
  readonly largestRun: number;
  /** `1 - largest / totalFree`, the sim spec 6.3 metric, 0 when free space is one run. */
  readonly externalFragmentation: number;
}

export interface YardReplay extends YardShape {
  readonly strategy: AllocationStrategy;
  /** Convoy Programs holding a berth at the end of the sequence. */
  readonly placed: readonly ConvoyMemberId[];
  readonly unplaced: readonly ConvoyMemberId[];
  /** Per Program, the tick it has been continuously without a berth since. */
  readonly unplacedSince: ReadonlyMap<ConvoyMemberId, number>;
  /** Where each placed berth sits, for `frag --compare`'s placement column. */
  readonly berths: ReadonlyMap<ConvoyMemberId, number>;
  readonly failures: readonly YardFailure[];
  readonly compactions: number;
}

const BERTH_PID = new Map<ConvoyMemberId, number>(BERTHS.map((berth, index) => [berth.member, 10 + index]));

export function shapeOf(list: HoleList): YardShape {
  const runs = list.holes;
  const freeSlots = list.totalFreeBytes;
  const largestRun = list.largestFreeHole;
  return {
    freeSlots,
    freeRuns: runs.length,
    largestRun,
    externalFragmentation: freeSlots === 0 ? 0 : 1 - largestRun / freeSlots,
  };
}

interface LiveBackground { readonly pid: number; readonly slots: number }

/**
 * Replay the recorded sequence. `override` pins one strategy for the whole
 * sequence, which is what `frag --compare` does; omitted, the player's own
 * `set_allocation` timeline is followed tick by tick.
 */
export function replayYard(decisions: readonly DecisionRecord[], atTick: number, override?: AllocationStrategy): YardReplay {
  const steps = recordedSequence(decisions, atTick);
  const first = override ?? strategyAt(decisions, 0);
  let list = openYard(first);
  let strategy = first;
  const berths = new Map<ConvoyMemberId, number>();
  const unplacedSince = new Map<ConvoyMemberId, number>();
  const failures: YardFailure[] = [];
  const background: LiveBackground[] = [];
  let nextBackgroundPid = 100;
  let compactions = 0;

  const request = (member: ConvoyMemberId, slots: number, at: number): void => {
    const shape = shapeOf(list);
    const result = list.allocate(asPid(BERTH_PID.get(member) ?? 0), slots);
    if (result.ok) {
      berths.set(member, result.partition.base);
      unplacedSince.delete(member);
      return;
    }
    if (!unplacedSince.has(member)) unplacedSince.set(member, at);
    failures.push({ at, occupant: member, requested: slots, reason: result.reason, largestRun: shape.largestRun, freeSlots: shape.freeSlots });
  };

  for (const step of steps) {
    if (override === undefined) {
      const next = strategyAt(decisions, step.at);
      if (next !== strategy) { list.setStrategy(next); strategy = next; }
    }
    if (step.kind === 'berths') {
      for (const berth of BERTHS) request(berth.member, berth.slots, step.at);
      continue;
    }
    if (step.kind === 'compact') {
      compactions += 1;
      list = compactYard(strategy, berths, background);
      for (const berth of BERTHS) if (!berths.has(berth.member)) request(berth.member, berth.slots, step.at);
      continue;
    }
    const op = BACKGROUND[step.index];
    if (op === undefined) continue;
    if (op.kind === 'release') {
      const index = background.length === 0 ? -1 : Math.min(op.nth, background.length - 1);
      const leaving = index < 0 ? undefined : background.splice(index, 1)[0];
      if (leaving !== undefined) list.free(asPid(leaving.pid));
    } else {
      const pid = nextBackgroundPid++;
      if (list.allocate(asPid(pid), op.slots).ok) background.push({ pid, slots: op.slots });
    }
    // Every berth the yard still owes is retried the moment the shape changes.
    for (const berth of BERTHS) if (!berths.has(berth.member)) request(berth.member, berth.slots, step.at);
  }

  const placed = BERTHS.filter((berth) => berths.has(berth.member)).map((berth) => berth.member);
  return {
    ...shapeOf(list),
    strategy,
    placed,
    unplaced: BERTHS.filter((berth) => !berths.has(berth.member)).map((berth) => berth.member),
    unplacedSince,
    berths,
    failures,
    compactions,
  };
}

/**
 * Slide every occupied run toward the low end and leave one free run behind
 * it. Every base register moves, which is why the crew stops every process
 * that owns memory for the duration (curriculum map, `frag --compact`).
 */
function compactYard(strategy: AllocationStrategy, berths: Map<ConvoyMemberId, number>, background: readonly LiveBackground[]): HoleList {
  const next = new HoleList(YARD_SLOTS, strategy, 1, [{ start: RESERVED_SLOTS, size: YARD_SLOTS - RESERVED_SLOTS }]);
  for (const berth of BERTHS) {
    if (!berths.has(berth.member)) continue;
    const result = next.allocate(asPid(BERTH_PID.get(berth.member) ?? 0), berth.slots);
    if (result.ok) berths.set(berth.member, result.partition.base);
    else berths.delete(berth.member);
  }
  for (const occupant of background) next.allocate(asPid(occupant.pid), occupant.slots);
  return next;
}

/** The four strategies over the same recorded sequence: the leg's arbiter. */
export function compareStrategies(decisions: readonly DecisionRecord[], atTick: number): Readonly<Record<AllocationStrategy, YardReplay>> {
  return {
    first_fit: replayYard(decisions, atTick, 'first_fit'),
    best_fit: replayYard(decisions, atTick, 'best_fit'),
    worst_fit: replayYard(decisions, atTick, 'worst_fit'),
    buddy: replayYard(decisions, atTick, 'buddy'),
  };
}

/**
 * The strategy the recorded sequence ends best under: everyone placed first,
 * then the largest free run, because that is the number that decides whether
 * the next request succeeds. Ranking on the external ratio alone would crown
 * buddy, which reaches a low ratio by having almost no free space left to
 * split.
 */
export function bestStrategy(compared: Readonly<Record<AllocationStrategy, YardReplay>>): AllocationStrategy {
  const order: readonly AllocationStrategy[] = ['best_fit', 'first_fit', 'worst_fit', 'buddy'];
  return order.reduce((best, candidate) => {
    const a = compared[candidate];
    const b = compared[best];
    if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length ? candidate : best;
    if (a.largestRun !== b.largestRun) return a.largestRun > b.largestRun ? candidate : best;
    return a.externalFragmentation < b.externalFragmentation ? candidate : best;
  });
}

/* ------------------------------------------------------------------ */
/* The sim spec's own comparison set (MEM-FIT-1 and MEM-BUDDY-1)       */
/* ------------------------------------------------------------------ */

const KB = 1024;
/** Sim spec 6.3: holes 100, 500, 200, 300, 600 with one occupied kilobyte between each pair. */
export const FIT_HOLES: readonly number[] = [100, 500, 200, 300, 600];
export const FIT_REQUESTS: readonly number[] = [212, 417, 112, 426];

export interface FitOutcome {
  readonly strategy: AllocationStrategy;
  /** The hole each request was placed into, in kilobytes, or null when it failed. */
  readonly placements: readonly (number | null)[];
  readonly freeAfter: number;
  readonly largestAfter: number;
}

/** `MEM-FIT-1a`, `1b` and `1c`, replayed through the shipped allocator. */
export function fitFixture(strategy: AllocationStrategy): FitOutcome {
  let cursor = 0;
  const holes = FIT_HOLES.map((size) => {
    const hole = { start: cursor, size: size * KB };
    cursor += (size + 1) * KB;
    return hole;
  });
  const list = new HoleList(cursor - KB, strategy, KB, holes);
  const placements: (number | null)[] = [];
  FIT_REQUESTS.forEach((request, index) => {
    const before = list.holes.map((hole) => ({ ...hole }));
    const result = list.allocate(asPid(index + 2), request * KB);
    placements.push(result.ok ? (before.find((hole) => hole.start === result.partition.base)?.size ?? 0) / KB : null);
  });
  return { strategy, placements, freeAfter: list.totalFreeBytes / KB, largestAfter: list.largestFreeHole / KB };
}

export interface BuddyOutcome {
  readonly blockSize: number;
  readonly internalFragmentation: number;
  readonly freeLists: readonly number[];
}

/** `MEM-BUDDY-1`: a 256 KB region, a 21 KB request, a 1 KB minimum block. */
export function buddyFixture(): BuddyOutcome {
  const allocator = new BuddyAllocator(256 * KB, KB);
  const block = allocator.allocate(21 * KB);
  if (block === null) throw new Error('MEM-BUDDY-1: the 21 KB request was refused by a 256 KB region');
  return {
    blockSize: block.size / KB,
    internalFragmentation: (block.size - 21 * KB) / KB,
    freeLists: allocator.freeHoles.map((hole) => hole.size / KB).sort((a, b) => a - b),
  };
}
