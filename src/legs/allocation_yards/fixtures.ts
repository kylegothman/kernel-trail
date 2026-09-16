/**
 * KERNEL TRAIL: the Allocation Yards' frozen figures.
 *
 * Every number here is either the curriculum map's, the sim spec's or the
 * narrative bible's, or is measured once from this leg's own model and pinned
 * so a later change has to be deliberate. Nothing here is invented.
 */

/** Curriculum map, leg 7: the opening refusal, in one row. */
export const OPENING_REFUSAL = {
  /** Free runs `free -f` reports. */
  freeRuns: 41,
  /** The largest of them. */
  largestRun: 9,
  /** What LUMEN asked for. */
  requestSlots: 12,
  /** Slabs free at the refusal. */
  freeSlots: 97,
  /** Of the whole yard, rounded to the map's figure. */
  freePercent: 38,
} as const;

/** Sim spec 16.5, `MEM-TLB-1` and `MEM-TLB-1b`. */
export const EAT_NS = {
  noSearch: { 0.5: 150, 0.8: 120, 0.9: 110, 0.99: 101 },
  withSearch: { 0.8: 130, 0.99: 111 },
} as const;

/** Curriculum map, leg 7: the two routes, on the same hardware and the same distance. */
export const ROUTE_HIT_RATES = { contiguous: 0.92, scattered: 0.41 } as const;

/** Measured through the leg's own model at thirty two entries: buying helps a little and nowhere near enough. */
export const PURCHASED_SCATTERED_HIT_RATE = 0.53;

/** The `--flush` demonstration: every access became two accesses. */
export const FLUSH_RATIO = 2;

/** Page sizes that satisfy both clauses of `page_size_tradeoff`, and the ones that fail exactly one. */
export const PAGE_SIZE_VERDICTS = {
  admissible: [1024, 2048, 4096, 8192],
  failsRowsOnly: [512],
  failsInternalOnly: [16384, 32768],
} as const;

/**
 * External fragmentation at leg end under each strategy, over the golden
 * known-good recorded sequence (best fit at tick 6, one compaction at tick 8,
 * eighty five ticks). Worst fit is the highest of the four, which is the
 * claim `frag --compare` exists to settle.
 */
export const STRATEGY_FRAGMENTATION = {
  first_fit: 0.0769,
  best_fit: 0.0769,
  worst_fit: 0.6154,
  buddy: 0,
} as const;

/**
 * The same four over a sequence with no compaction. Buddy is higher than
 * worst fit here, because buddy's visible holes are power-of-two blocks and
 * the metric is one minus largest over total free. Reported rather than
 * hidden: the "worst fit is worst of the four" claim holds on a sequence that
 * compacts, which every playable run does.
 */
export const STRATEGY_FRAGMENTATION_UNCOMPACTED = {
  first_fit: 0.9464,
  best_fit: 0.9464,
  worst_fit: 0.9692,
  buddy: 0.9747,
} as const;

/**
 * The yard accumulates. Two runs on the same seed and the same sequence, one
 * holding worst fit for the first half and then switching to best fit, the
 * other on best fit throughout. Nothing resets between segments, so the
 * slivers the first half left are still there at the end.
 */
export const ACCUMULATION = {
  worstFirstHalf: { externalFragmentation: 0.9643, freeRuns: 29, largestRun: 2 },
  bestThroughout: { externalFragmentation: 0.9464, freeRuns: 28, largestRun: 3 },
} as const;

/** Sim spec 16.5, `MEM-XLATE-1`: page size 4, page table [5, 6, 1, 2]. */
export const XLATE_1 = {
  pageSize: 4,
  pageTable: [5, 6, 1, 2],
  cases: [
    { logical: 0, page: 0, offset: 0, frame: 5, physical: 20 },
    { logical: 3, page: 0, offset: 3, frame: 5, physical: 23 },
    { logical: 4, page: 1, offset: 0, frame: 6, physical: 24 },
    { logical: 13, page: 3, offset: 1, frame: 2, physical: 9 },
  ],
} as const;

/** Sim spec 16.5, `MEM-XLATE-2`: the realistic one the terminal prints. */
export const XLATE_2 = { pageSize: 4096, logical: 0x0000_3abc, page: 3, offset: 2748, frame: 12, physical: 51900 } as const;

/** The `pagetable` man page's third worked example, at a third page size. */
export const XLATE_MANUAL = { pageSize: 256, logical: 1000, page: 3, offset: 232, frame: 11, physical: 11 * 256 + 232 } as const;

/** Sim spec 16.5, `MEM-BUDDY-1`. */
export const BUDDY_1 = { blockSize: 32, internalFragmentation: 11, freeLists: [32, 64, 128] } as const;
