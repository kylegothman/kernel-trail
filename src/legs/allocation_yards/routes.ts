/**
 * KERNEL TRAIL: the Allocation Yards' translation cache, the two routes and
 * the page size dial.
 *
 * Every hit rate here is measured through WP-05's own `Tlb` at the leg's
 * sixteen entries, against a sequence this file authors. The contiguous
 * route's 0.92 falls out of the arithmetic: eight pages walked in order,
 * a hundred accesses, eight cold misses.
 *
 * The scattered route's 0.41 is the curriculum map's figure and the sequence
 * is authored to it rather than derived from it (pre-flight ruling 9). The
 * map's own table says the scattered route touches eight pages with a stride
 * of forty seven, and its prose says the route "strides across four hundred"
 * pages; those two cannot both be true of a sixteen-entry cache, because
 * eight pages fit in sixteen entries and would hit constantly. The prose is
 * what produces a low hit rate, so the sequence follows the prose: a hundred
 * accesses striding forty seven pages apart across a four hundred page span,
 * of which forty one re-touch the page just used and hit.
 */
import { asFrameId, asPageId, asTick, type AddressSpaceId, type Frame } from '@kernel/types';
import { effectiveAccessTimeNs, Tlb } from '@kernel/memory/Tlb';
import { TLB_ENTRIES } from './config';
import { BERTHS } from './yard';

/** Sim spec 6.5: one memory access, in nanoseconds. */
export const MEMORY_ACCESS_NS = 100;
/** The accesses each route makes. Identical for both, which is what makes them the same distance. */
export const ROUTE_ACCESSES = 100;
/** Pages of the Program's own address space the contiguous route walks. */
export const ROUTE_PAGES = 8;
/** The scattered route's stride, in pages (curriculum map, leg 7). */
export const SCATTERED_STRIDE = 47;
/** The span the scattered route strides across. */
export const SCATTERED_SPAN = 400;
/** Accesses on the scattered route that re-touch the page just used. */
const IMMEDIATE_REPEATS = 41;
/** Fresh pages the scattered walk visits before it doubles back. */
const SCATTERED_FRESH = 47;
/**
 * Re-touches of a page visited long enough ago that sixteen entries have lost
 * it and thirty two still hold it. They are what makes buying entries help a
 * little, and what makes it nowhere near enough.
 */
const DELAYED_REPEATS = 12;
const FIRST_DELAYED = 15;

export type RouteId = 'route.contiguous' | 'route.scattered';

/** Eight pages walked in order, over and over. */
export function contiguousSequence(): readonly number[] {
  return Array.from({ length: ROUTE_ACCESSES }, (_, index) => index % ROUTE_PAGES);
}

/**
 * Fresh pages a stride apart, with `IMMEDIATE_REPEATS` of them re-touched at
 * once and `DELAYED_REPEATS` re-touched far enough back that the cache size
 * decides whether they are still there. The immediate repeats are spread
 * evenly through the walk rather than bunched at its head, so the route reads
 * as one continuous stride.
 */
export function scatteredSequence(): readonly number[] {
  const page = (step: number): number => (step * SCATTERED_STRIDE) % SCATTERED_SPAN;
  const pages: number[] = [];
  for (let step = 0; step < SCATTERED_FRESH; step++) {
    pages.push(page(step));
    const before = Math.floor((step * IMMEDIATE_REPEATS) / SCATTERED_FRESH);
    const after = Math.floor(((step + 1) * IMMEDIATE_REPEATS) / SCATTERED_FRESH);
    if (after > before) pages.push(page(step));
  }
  for (let index = 0; index < DELAYED_REPEATS; index++) pages.push(page(FIRST_DELAYED + index));
  return pages;
}

const SPACE = 1 as AddressSpaceId;

/** Walk a page sequence through a real TLB of `entries` slots and report the hit rate. */
export function measureHitRate(pages: readonly number[], entries: number = TLB_ENTRIES): number {
  const frames = new Map<number, Frame>();
  const tlb = new Tlb(entries, (id) => frames.get(id));
  let hits = 0;
  pages.forEach((page, index) => {
    const frame = asFrameId(page);
    if (!frames.has(page)) {
      frames.set(page, { id: frame, owner: SPACE, page: asPageId(page), pinned: false, loadedAtTick: null, lastAccessTick: null, referenceBit: false });
    }
    const tick = asTick(index + 1);
    if (tlb.lookup(SPACE, asPageId(page), tick) !== null) hits += 1;
    else tlb.install(SPACE, asPageId(page), frame, tick);
  });
  return pages.length === 0 ? 0 : hits / pages.length;
}

export interface RouteReading {
  readonly id: RouteId;
  /** Slabs walked. Identical for both routes, and asserted to be. */
  readonly distance: number;
  readonly accesses: number;
  readonly stride: number;
  readonly hitRate: number;
  readonly effectiveAccessNs: number;
}

export function readRoute(id: RouteId, entries: number = TLB_ENTRIES): RouteReading {
  const pages = id === 'route.contiguous' ? contiguousSequence() : scatteredSequence();
  const hitRate = measureHitRate(pages, entries);
  return {
    id,
    distance: ROUTE_ACCESSES,
    accesses: pages.length,
    stride: id === 'route.contiguous' ? 1 : SCATTERED_STRIDE,
    hitRate,
    effectiveAccessNs: effectiveAccessTimeNs(hitRate, MEMORY_ACCESS_NS, 0),
  };
}

/** The route the player took, or the scattered one by default: nobody is given the good route. */
export const DEFAULT_ROUTE: RouteId = 'route.scattered';

/** The entries a purchase at the console buys. More entries cover more pages, and it costs real money. */
export const PURCHASED_TLB_ENTRIES = 32;

/* ------------------------------------------------------------------ */
/* MEM-TLB-1 and the flush demonstration                               */
/* ------------------------------------------------------------------ */

/** `MEM-TLB-1`: EAT at M = 100 ns and E = 0, posted at the console. */
export const EAT_TABLE: readonly { readonly hitRate: number; readonly ns: number }[] =
  [0.50, 0.80, 0.90, 0.99].map((hitRate) => ({ hitRate, ns: effectiveAccessTimeNs(hitRate, MEMORY_ACCESS_NS, 0) }));

/** `MEM-TLB-1b`: the same at E = 10 ns, which is what a real lookup costs. */
export const EAT_TABLE_WITH_SEARCH: readonly { readonly hitRate: number; readonly ns: number }[] =
  [0.80, 0.99].map((hitRate) => ({ hitRate, ns: effectiveAccessTimeNs(hitRate, MEMORY_ACCESS_NS, 10) }));

/**
 * The `--flush` demonstration: a segment with the cache disabled against the
 * same segment with it warm. Every access became two accesses, so the
 * disabled segment takes twice as long, exactly.
 */
export function flushDemonstration(): { readonly disabledNs: number; readonly warmNs: number; readonly ratio: number } {
  const disabledNs = effectiveAccessTimeNs(0, MEMORY_ACCESS_NS, 0);
  const warmNs = effectiveAccessTimeNs(1, MEMORY_ACCESS_NS, 0);
  return { disabledNs, warmNs, ratio: disabledNs / warmNs };
}

/* ------------------------------------------------------------------ */
/* The page size dial and the index board                              */
/* ------------------------------------------------------------------ */

/** The sizes the dial can reach. Every one is a power of two, as the kernel requires. */
export const PAGE_SIZES: readonly number[] = [512, 1024, 2048, 4096, 8192, 16384, 32768];

/** `obj.allocation_yards.page_size_tradeoff`: page tables under 64 rows. */
export const MAX_INDEX_ROWS = 64;
/** `obj.allocation_yards.page_size_tradeoff`: internal waste under 8 percent of allocated memory. */
export const MAX_INTERNAL_SHARE = 0.08;

export interface PagingReading {
  readonly pageSize: number;
  /** Rows on the index board, summed over the convoy. */
  readonly indexRows: number;
  readonly largestTable: number;
  readonly allocatedBytes: number;
  readonly internalFragmentation: number;
  readonly internalShare: number;
  /** Always exactly zero under paging. `MEM-FRAG-1`. */
  readonly externalFragmentation: number;
  readonly meetsRowBound: boolean;
  readonly meetsInternalBound: boolean;
}

/** What the two meters and the index board read at `pageSize`, for the convoy's own berths. */
export function readPaging(pageSize: number): PagingReading {
  if (!PAGE_SIZES.includes(pageSize)) throw new Error(`allocation_yards: the dial does not reach page size ${pageSize}`);
  let indexRows = 0;
  let largestTable = 0;
  let allocatedBytes = 0;
  let internalFragmentation = 0;
  for (const berth of BERTHS) {
    const rows = Math.ceil(berth.bytes / pageSize);
    indexRows += rows;
    largestTable = Math.max(largestTable, rows);
    allocatedBytes += rows * pageSize;
    internalFragmentation += rows * pageSize - berth.bytes;
  }
  const internalShare = allocatedBytes === 0 ? 0 : internalFragmentation / allocatedBytes;
  return {
    pageSize, indexRows, largestTable, allocatedBytes, internalFragmentation, internalShare,
    externalFragmentation: 0,
    meetsRowBound: largestTable < MAX_INDEX_ROWS,
    meetsInternalBound: internalShare < MAX_INTERNAL_SHARE,
  };
}

/** Page sizes that satisfy both clauses of `page_size_tradeoff`. */
export function admissiblePageSizes(): readonly number[] {
  return PAGE_SIZES.filter((size) => {
    const reading = readPaging(size);
    return reading.meetsRowBound && reading.meetsInternalBound;
  });
}
