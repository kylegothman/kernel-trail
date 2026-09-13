# WP-05: Main memory, allocation strategies, paging and the TLB

## Objective

When this package is done the kernel holds both memory models of Ch. 9 at once: a
byte-addressed contiguous hole list with four allocation strategies, and a frame
table with per-address-space page tables and an ASID-tagged TLB. Address
translation works by shift and mask. Fragmentation is a computed metric that
shows external fragmentation under contiguous allocation and exactly zero under
paging, which is the Leg 7 lesson on one screen. Frame allocation honours the
rations table. WP-06 builds demand paging and the six replacement policies on top
of the frame table you deliver.

## Prerequisites

WP-02 complete and green.

Files that must already exist:

- `src/kernel/types.ts` (frozen)
- `src/kernel/Kernel.ts` with the `MemoryHooks` interface and its no-op default
- `src/kernel/process/lifecycle.ts` with the `cowRefCount` side table and the
  `allocateFrame` hook call
- `tests/kernel/fixtures/referenceConfig.ts`, `tests/kernel/canonical.ts`

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 6 in full: 6.1 (the two memory models), 6.2
  (contiguous allocation and buddy), 6.3 (fragmentation metrics and the three
  worked fit tables), 6.4 (paging address translation and both worked examples),
  6.5 (the TLB and effective access time), 6.6 (the frame table and the rations
  mapping)
- `02-KERNEL-SIM-SPEC.md` section 7.4, the contract points only, so the frame
  table you build satisfies what `selectVictim` needs
- `02-KERNEL-SIM-SPEC.md` section 3.4, the copy-on-write half, since `fork`
  already calls into your frame table
- `02-KERNEL-SIM-SPEC.md` section 16.5 (the main memory fixture table)
- `02-KERNEL-SIM-SPEC.md` section 15, the "Memory" invariant group, so your data
  structures can satisfy I-9 and I-17 when WP-11 turns them on

## Files you will create

```
src/kernel/memory/FrameTable.ts
src/kernel/memory/PageTable.ts
src/kernel/memory/translate.ts
src/kernel/memory/Tlb.ts
src/kernel/memory/contiguous/HoleList.ts
src/kernel/memory/contiguous/firstFit.ts
src/kernel/memory/contiguous/bestFit.ts
src/kernel/memory/contiguous/worstFit.ts
src/kernel/memory/contiguous/buddy.ts
src/kernel/memory/contiguous/index.ts
src/kernel/memory/fragmentation.ts
src/kernel/memory/rations.ts
src/kernel/memory/MemorySubsystem.ts
tests/kernel/memory/contiguous.test.ts
tests/kernel/memory/translate.test.ts
tests/kernel/memory/tlb.test.ts
tests/kernel/memory/frameTable.test.ts
tests/kernel/memory/fragmentation.test.ts
```

## Files you may modify

```
src/kernel/Kernel.ts   (wire MemoryHooks to MemorySubsystem; implement
                        setAllocationStrategy. Nothing else in this file, and
                        specifically not phase 10, see below.)
src/kernel/index.ts    (add the ALLOCATORS export)
```

Nothing else.

### Scope correction 2, 2026-09-13

Raised by the implementing agent, asking before editing. The grant above excluded
three things this package itself requires, and the request named all three
precisely. Approved as follows.

**Snapshot save and restore for the `memory` and `vm` slots.** Required by the
acceptance criteria and by amendment 3. Do it as a dispatch over installed hooks,
not by adding keys to the object literal WP-03 left in `snapshot()`: give the hook
objects `saveState` and `restoreState`, and have the kernel iterate whatever is
installed. WP-07 and WP-09 need the identical lines next, and a dispatch means they
register rather than edit. Leave WP-03's existing scheduler line exactly as it is;
WP-04 folds it in when it promotes the scheduler slot.

**`ioctl("tlb_flush")`.** Required by sim spec section 14 (the kernel
pseudo-device row) and by the `explicit flush` acceptance test. Add that one
subcommand and nothing else to the ioctl branch. An unknown subcommand returns
`EINVAL`, because WP-11 owns full argument validation for the whole table and will
rebase onto this. Mark the branch `// TODO(astra): WP-11 validates ioctl arguments`.
Report how `exec` reaches the flush: the spec says exec flushes the caller's TLB
entries, exec lives in WP-02's lifecycle code which is not in your grant, so if it
needs a lifecycle edit, escalate rather than widen.

**The access-completion gate.** A TLB miss on a resident page costs
`tlbMissTicks` and is not a fault. That three-way classification (hit, resident
miss, non-resident fault) is the page fault ownership decision this package was
asked to settle, and WP-06 builds directly on it. Approved with two conditions:
the costs come from tuning, never a literal, and all eleven phase bodies stay
unchanged, which you already committed to.

**`src/kernel/config.ts`, additive only.** `tlbHitTicks` and `tlbMissTicks` belong
in `KernelTuning` with the same validation pattern the existing knobs use. Add
those two keys and nothing else. This file is shared with WP-07 and WP-09, who will
add their own knobs, so keep the addition to distinct keys and do not reformat.

### Scope correction, 2026-09-12

This package recomputes `MemoryMetrics.tlbHitRate` in phase 10, and WP-03 is being
built at the same time and also needs phase 10. Rather than have you both edit the
same lines, WP-03 is converting phase 10 into a dispatch point that calls each
subsystem's metrics hook.

So: do not edit phase 10. Register your metrics recomputation through the hook,
the same way you register `MemoryHooks`, and look for the marker
`// TODO(astra): WP-05 registers its metrics hook here`.

If that marker is not in `Kernel.ts` when you get there, WP-03 has not landed yet.
Do not add the dispatch yourself and do not compute `tlbHitRate` inline. Implement
everything else, leave your recomputation behind a
`// TODO(astra): blocked on WP-03 phase 10 dispatch` stub, and say so in your
report. Serialising this one seam is much cheaper than merging two versions of the
same phase.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export type FrameId = Brand<number, 'FrameId'>;
export type PageId = Brand<number, 'PageId'>;
export type AddressSpaceId = Brand<number, 'AddressSpaceId'>;

export const asFrameId = (n: number): FrameId => n as FrameId;
export const asPageId = (n: number): PageId => n as PageId;

export type AllocationStrategy = 'first_fit' | 'best_fit' | 'worst_fit' | 'buddy';

export interface PageTableEntry {
  readonly page: PageId;
  frame: FrameId | null;
  valid: boolean;
  dirty: boolean;
  referenced: boolean;
  /** Protection bits. Ch. 9.3.3. */
  readable: boolean;
  writable: boolean;
  executable: boolean;
  /** True when the page lives in the backing store rather than memory. */
  swapped: boolean;
  lastAccessTick: Tick | null;
  accessCount: number;
}

export interface Frame {
  readonly id: FrameId;
  owner: AddressSpaceId | null;
  page: PageId | null;
  pinned: boolean;
  loadedAtTick: Tick | null;
  lastAccessTick: Tick | null;
  /** Second-chance bit for the clock algorithm. */
  referenceBit: boolean;
}

export interface MemoryMetrics {
  readonly totalFrames: number;
  readonly freeFrames: number;
  readonly pageFaults: number;
  readonly majorFaults: number;
  readonly evictions: number;
  readonly writeBacks: number;
  /** Faults per thousand ticks, smoothed. Above thrashingThreshold you thrash. */
  readonly faultRate: number;
  readonly externalFragmentation: number;
  readonly internalFragmentation: number;
  /** Working set size per process. Ch. 10.6.2. */
  readonly workingSets: ReadonlyMap<Pid, number>;
  readonly tlbHitRate: number;
}

export interface MemoryContext {
  readonly tick: Tick;
  readonly rng: Rng;
  readonly frames: readonly Frame[];
  /** Only populated in scenarios that permit the optimal policy. */
  readonly futureReferences: readonly PageId[] | null;
  pageTable(space: AddressSpaceId): ReadonlyMap<PageId, PageTableEntry>;
  emit(event: KernelEvent): void;
}
```

Events this package emits, from the frozen union. Do not invent a variant:

```ts
| (EventBase & { type: 'memory.access'; pid: Pid; page: PageId; write: boolean; hit: boolean })
| (EventBase & { type: 'memory.allocated'; pid: Pid; frames: readonly FrameId[]; strategy: AllocationStrategy })
| (EventBase & { type: 'memory.allocation_failed'; pid: Pid; requested: number; reason: 'no_space' | 'fragmentation' })
| (EventBase & { type: 'tlb.miss'; pid: Pid; page: PageId })
```

## Specification

### 1. Two models, side by side

Per sim spec 6.1, the simulator maintains both models of Ch. 9 simultaneously.
Contiguous allocation is a parallel model that the Allocation Yards leg drives
directly, not a fallback for paging. Paging is the model the rest of the kernel
actually runs on. `AllocationStrategy` selects the hole policy, and
`memory.allocated` carries the strategy that was used.

### 2. `src/kernel/memory/contiguous/HoleList.ts`

```ts
interface Hole { start: number; size: number; }   // sorted by start, never overlapping
interface Partition { readonly pid: Pid; base: number; limit: number; requested: number; }
```

The hole list is kept sorted by `start` and adjacent free holes are **coalesced
on free**. Coalescing is required for buddy and correct for the others.

`HoleList` owns insertion, removal, splitting and coalescing. The four strategy
modules own only the choice of which hole to take, expressed as
`select(holes: readonly Hole[], request: number): number` returning an index or
`-1`.

### 3. The four strategies

**First fit** (sim spec 6.2). Scan from index 0 and take the first hole with
`size >= request`. Split: the partition takes `[start, start + request)` and the
hole becomes `{ start + request, size - request }`. A hole reduced to size 0 is
removed.

**Best fit.** Take the hole with the smallest `size >= request`. Tie-break on
lower `start`. Implemented as a full scan, because the hole count is bounded by
the process count plus one and a heap would need repair on every coalesce.

**Worst fit.** Take the hole with the largest `size >= request`. Tie-break on
lower `start`.

**Buddy** (sim spec 6.2, Ch. 9.8.1). Power-of-two allocation over a region whose
size is a power of two. The five-step procedure:

1. `order = ceil(log2(max(request, minBlock)))`, `minBlock` 4096 bytes by
   default.
2. Find the smallest free list index `k >= order` that is non-empty. If none, the
   allocation fails with `memory.allocation_failed { reason: 'no_space' }`.
3. While `k > order`: pop a block of order `k`, split it into two buddies of
   order `k - 1` at addresses `b` and `b + 2^(k-1)`, push both onto free list
   `k - 1` **in ascending address order**, decrement `k`.
4. Pop the lowest-address block from free list `order` and return it.
5. On free, compute the buddy address as `addr XOR 2^order`. If the buddy is free
   and of the same order, remove it and coalesce into order `order + 1`, then
   repeat.

Buddy free lists are held as sorted arrays, one per order, so the lowest-address
pop in step 4 is O(1) and the whole structure serialises deterministically.

### 4. `src/kernel/memory/fragmentation.ts`

Per sim spec 6.3:

```
externalFragmentation = 1 - (largestFreeHole / totalFreeBytes)     // 0 when free memory is one hole
internalFragmentation = allocatedBytes - requestedBytes            // summed over live partitions
```

For paging, internal fragmentation is computed differently and is the one the
player sees on Leg 7:

```
internalFragmentation = sum over processes of (framesHeld * pageSize - bytesRequested)
```

**`externalFragmentation` under paging is exactly 0** and the metric must return
literal `0`, not a value that rounds to zero. The HUD shows both models at once
and the contrast is the argument for paging in one glance.

Guard the division: `totalFreeBytes === 0` gives `externalFragmentation = 0`.

### 5. `src/kernel/memory/translate.ts`

Per sim spec 6.4. For a page size of `2^n` bytes:

```
pageNumber p = L >>> n
offset     d = L & ((1 << n) - 1)
physical     = (frameNumber << n) | d
```

```ts
export function splitAddress(logical: number, pageSize: number): { page: PageId; offset: number } {
  const n = Math.log2(pageSize);
  return {
    page: (logical >>> n) as PageId,
    offset: logical & (pageSize - 1),
  };
}
```

`KernelConfig.pageSize` must be a power of two and WP-02 already throws on
construction otherwise, because the shift arithmetic above is the only
translation path. Verify that check exists; report it if it does not.

Provide `physicalAddress(frame, offset, pageSize)` as the inverse.

### 6. `src/kernel/memory/PageTable.ts`

One page table per `AddressSpaceId`, held as `Map<PageId, PageTableEntry>`.
Iteration for anything order-dependent goes through a sorted key array, never the
map's insertion order.

`MemoryContext.pageTable(space)` returns the map as `ReadonlyMap`. Do not copy
per call; return the live map typed read-only.

Entries are created lazily on first touch. A page with no entry is not resident
and not swapped; it simply does not exist yet, which is what makes the Drowned
Reach possible.

### 7. `src/kernel/memory/Tlb.ts`

Per sim spec 6.5:

```ts
interface TlbEntry {
  space: AddressSpaceId;
  page: PageId;
  frame: FrameId;
  valid: boolean;
  lastUsedTick: Tick;
}
```

- Size is `KernelConfig.tlbEntries`, default 16.
- Replacement within the TLB is **LRU by `lastUsedTick`, tie-broken by lowest
  slot index**.
- Lookup on every `access` instruction: scan for a valid entry with matching
  `space` and `page`. On a hit, update `lastUsedTick`, emit
  `memory.access { hit: true }`, cost `tlbHitTicks`. On a miss, emit `tlb.miss`,
  cost `tlbMissTicks`, then consult the page table; on a valid PTE install the
  mapping, evicting the LRU slot if full.
- The TLB is **tagged with an ASID, so a context switch does not flush it.**
  `ioctl` with argument `"tlb_flush"` flushes it explicitly, which is what `exec`
  does and what a page table teardown does.
- Provide `shootdown(frame: FrameId)` which invalidates every entry naming that
  frame. WP-06's eviction path calls it.
- Invariant I-9 asserts that no TLB entry names a frame whose `owner` differs
  from the entry's `space`. Structure the code so that is true by construction
  and note where.

`tlbHitTicks = 1` and `tlbMissTicks = 2`, which is the same 1:2 ratio the EAT
formula produces at `E = 0`. `MemoryMetrics.tlbHitRate` is recomputed in phase 10
as `tlbHits / (tlbHits + tlbMisses)`, guarded against a zero denominator.

Also export the effective-access-time helper, since the HUD and the codex both
use it and it must exist in exactly one place:

```ts
/** EAT = h * (E + M) + (1 - h) * (E + 2M) = E + M + (1 - h) * M */
export function effectiveAccessTimeNs(hitRatio: number, memoryNs: number, tlbNs: number): number;
```

### 8. `src/kernel/memory/FrameTable.ts`

Per sim spec 6.6:

```ts
class FrameTable {
  readonly frames: Frame[];              // dense, index === FrameId
  private freeList: FrameId[];           // ascending, so allocation is deterministic
  allocate(space: AddressSpaceId, page: PageId, pinned: boolean): FrameId | null;
  free(id: FrameId): void;
}
```

`freeList` is kept **ascending by frame id at all times**. On `free`, the id is
inserted at its sorted position rather than pushed. That costs O(n) on a small n
and buys the property that a snapshot restore reproduces allocations exactly
regardless of the free order that produced the list. Do not optimise this into a
stack.

Also provide, for WP-06:

- `freePool`: a bounded retention list of recently freed frames in eviction
  order, capacity `freePoolRetain` (default 4). A frame in the free pool still
  holds its old `owner` and `page`, which is what makes reclaim-from-free-pool a
  minor fault. `allocate` takes from `freeList` first and the free pool only when
  `freeList` is empty; taking from the free pool clears the retained mapping.
- `unpinnedFrames(): readonly FrameId[]` in ascending order, which the random
  replacement policy requires.
- `framesOf(space): readonly FrameId[]` in ascending order, for local
  replacement scope.

### 9. `src/kernel/memory/rations.ts`

The frames-per-process table from sim spec 6.6. `TravelPolicy.rations` is a game
type and `src/kernel` may not import `src/game`, so declare the keys as string
literals and comment that they mirror `Rations` in `@game/types`. WP-18 asserts
the two agree.

| Rations | Frames per process |
|---|---|
| `generous` | `floor(totalFrames / activeProcesses) * 1.5`, capped at `totalFrames` |
| `standard` | `floor(totalFrames / activeProcesses)` |
| `lean` | `max(minFrames, floor(totalFrames / activeProcesses) * 0.6)` |
| `starved` | `minFrames` |

`minFrames` is 3, which is the Ch. 10.5.1 figure: an instruction referencing two
operands plus its own page needs at least three frames or it faults forever on a
single instruction. Allocation below `minFrames` throws in dev builds and is
clamped in production.

Also expose `AllocationScheme = 'equal' | 'proportional'` with proportional
weighting by the process's page count, and
`ReplacementScope = 'local' | 'global'` defaulting to `'local'`. Global
replacement is what lets one process steal frames from another and drive the
system into thrashing, and Leg 8 turns it on deliberately. WP-06 consumes both.

Every arithmetic result must be an integer: apply `Math.floor` after the
multiplications, not before.

### 10. `src/kernel/memory/MemorySubsystem.ts`

The object that satisfies `MemoryHooks` from WP-02. It owns the frame table, the
page tables, the TLB, the hole list and the metrics counters.

Implement now:

- `access(pid, page, write)`: TLB lookup, page table lookup, and on a valid PTE
  update `referenced`, `dirty` (when writing), `lastAccessTick` and
  `accessCount`, and emit `memory.access`. On an invalid PTE, call
  `this.demandPaging.fault(...)` on a hook that this package leaves as a stub
  throwing `not implemented: page fault`, with
  `// TODO(astra): WP-06 implements the fault service path`.
- `allocateFrame()`: what `fork`'s COW path calls.
- `freeAddressSpace(space)`: what `exec` and `exit` call.
- `setAllocationStrategy(s)`: swaps the hole policy. Live partitions keep their
  placement; only future allocations change. Emit nothing.
- `metrics()`: returns `MemoryMetrics` with `pageFaults`, `majorFaults`,
  `evictions`, `writeBacks` and `faultRate` at 0 and `workingSets` empty, marked
  `// TODO(astra): WP-06 fills these`. `totalFrames`, `freeFrames`,
  `externalFragmentation`, `internalFragmentation` and `tlbHitRate` are real now.

`selectVictim` and everything under `src/kernel/memory/replacement/` belong to
WP-06. Do not create that directory.

### 11. The memory snapshot contribution

This package owns the memory subsystem's contribution to `KernelSnapshot`. The
channel is `subsystems.memory`, added by `docs/07-CONTRACT-AMENDMENTS.md`
amendment 1, and it starts as a `SubsystemEnvelope`:

```ts
{ owner: 'memory', version: 1, payload: /* JsonValue */ }
```

`owner` is this subsystem's `SubsystemId`. `version` starts at 1 and this package
bumps it whenever the payload shape changes. The payload carries the state the
shared snapshot tables cannot express: the hole list with its placement order,
the TLB entries with the replacement position, the allocation strategy in force,
and the counters behind `metrics()`. It must be plain `JsonValue`, so no `Map`,
no `Set`, no function and no non-finite number. Validate the payload on restore
and throw on a `version` this package does not understand, because a silently
misread save is worse than a refused one.

**Promote the envelope to a typed interface in the same commit that implements
the subsystem**, additively, the way amendment 1 was made, and record the
promotion in `docs/07-CONTRACT-AMENDMENTS.md`. The envelope is a transition
mechanism. Shipping with an opaque envelope means this package is not finished.

WP-11 carries the envelope through `snapshot()` and hands it back on `restore()`.
It does not interpret the payload, so nothing else will catch a field you leave
out.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. Fixture `MEM-FIT-1a` passes: first fit over holes 100/500/200/300/600 with
   requests 212/417/112/426 places 212 in 500, 417 in 600, 112 in 288, and
   **fails** 426; free bytes 959 K; largest hole 300 K; the failure carries
   `reason: 'fragmentation'` because free memory exceeds the request but no
   single hole does.
5. Fixture `MEM-FIT-1b` passes: best fit places all four (212 in 300, 417 in 500,
   112 in 200, 426 in 600); free bytes 533 K; largest hole 174 K.
6. Fixture `MEM-FIT-1c` passes: worst fit places 212 in 600, 417 in 500, 112 in
   388, and **fails** 426; free bytes 959 K; largest hole 300 K.
7. Fixture `MEM-BUDDY-1` passes: a 256 KB region, 21 KB request, `minBlock` 1 KB
   allocates a 32 KB block; internal fragmentation 11 KB; free lists hold exactly
   one 32 K, one 64 K and one 128 K block.
8. Fixture `MEM-XLATE-1` passes: page size 4, page table `[5, 6, 1, 2]`, logical
   addresses 0, 3, 4, 13 give physical 20, 23, 24, 9.
9. Fixture `MEM-XLATE-2` passes: page size 4096, logical `0x00003ABC` gives
   `p = 3`, `d = 2748`, and with page 3 mapped to frame 12, physical
   `51900 === 0x0000CABC`.
10. Fixture `MEM-TLB-1` passes: EAT with `M = 100`, `E = 0` and
    `h = 0.50 / 0.80 / 0.90 / 0.99` gives 150.00, 120.00, 110.00, 101.00 ns.
11. Fixture `MEM-TLB-1b` passes: `M = 100`, `E = 10`, `h = 0.80 / 0.99` gives
    130.00, 111.00 ns.
12. Fixture `MEM-FRAG-1` passes: `externalFragmentation === 0` for every paging
    configuration, asserted with `toBe(0)` across at least six configurations.
13. `FrameTable.freeList` is ascending after every operation in a 10,000-operation
    randomised sequence driven by a seeded `Rng`.
14. Two `FrameTable` instances driven through the same allocate/free sequence in
    different orders that end at the same free set produce the same next
    allocation.
15. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
16. The forbidden-identifier scan still returns zero matches.
17. `createKernel(REFERENCE_CONFIG).run(5000)` still passes `DET-D1`, `DET-D3`
    and `DET-D4`.
18. Memory state survives a snapshot and restore round trip. Drive the subsystem
    to a non-default state (a fragmented hole list, a populated TLB, a
    non-default allocation strategy), take the envelope, restore it into a fresh
    subsystem, and every observable reading agrees: the same next allocation, the
    same TLB hit or miss for the same lookups, and a canonically identical second
    envelope.

## Tests you must write

### `tests/kernel/memory/contiguous.test.ts`

| Fixture | Assertion |
|---|---|
| `MEM-FIT-1a` | per acceptance criterion 4, including the hole list after each of the four requests: `100,288,200,300,600` then `100,288,200,300,183` then `100,176,200,300,183` then unchanged |
| `MEM-FIT-1b` | per criterion 5, including hole lists `100,500,200,88,600` then `100,83,200,88,600` then `100,83,88,88,600` then `100,83,88,88,174` |
| `MEM-FIT-1c` | per criterion 6, including hole lists `100,500,200,300,388` then `100,83,200,300,388` then `100,83,200,300,276` then unchanged |
| `best fit wins` | best fit places all four requests while first fit and worst fit each strand the last one |
| `external fragmentation` | first fit after the four requests gives `1 - 300/959` to 1e-9; best fit gives `1 - 174/533` |
| `coalesce on free` | freeing two adjacent partitions leaves one hole, not two |
| `coalesce three-way` | freeing a partition between two free holes leaves one hole |
| `hole list sorted` | after 500 randomised allocate and free operations the hole list is strictly ascending by `start` with no overlaps and no zero-size entries |
| `MEM-BUDDY-1` | per criterion 7, plus the split trace: the free lists after allocation contain exactly one block at orders 15, 16 and 17 (32 K, 64 K, 128 K) |
| `buddy coalesce` | allocating two 32 K blocks then freeing both leaves a single 64 K block, and freeing everything returns one 256 K block |
| `buddy XOR` | the buddy of address `b` at order `k` is `b XOR 2^k`, asserted for 64 address/order pairs |
| `no_space vs fragmentation` | a request larger than total free memory gives `reason: 'no_space'`; a request smaller than total free but larger than every hole gives `reason: 'fragmentation'` |

### `tests/kernel/memory/translate.test.ts`

| Fixture | Assertion |
|---|---|
| `MEM-XLATE-1` | the four-row table: logical 0/3/4/13 give p 0/0/1/3, d 0/3/0/1, physical 20/23/24/9 |
| `MEM-XLATE-2` | logical `0x00003ABC` gives p 3, d 2748, physical 51900, and `physical.toString(16)` is `'cabc'` |
| `offset preserved` | for 1000 random logical addresses at page size 4096, `physicalAddress(frame, d, 4096) & 4095 === d` |
| `round trip` | `splitAddress` then `physicalAddress` with the identity mapping returns the original address |
| `non power of two` | constructing a kernel with `pageSize: 3000` throws `KernelConfigError` |

### `tests/kernel/memory/tlb.test.ts`

| Fixture | Assertion |
|---|---|
| `MEM-TLB-1` | EAT at `M=100, E=0` for h = 0.50, 0.80, 0.90, 0.99 gives 150.00, 120.00, 110.00, 101.00 to 1e-9 |
| `MEM-TLB-1b` | EAT at `M=100, E=10` for h = 0.80, 0.99 gives 130.00, 111.00 to 1e-9 |
| `hit updates lru` | a hit on slot 3 makes slot 3 the most recently used, so the next eviction is not slot 3 |
| `lru tie-break` | with two slots sharing the lowest `lastUsedTick`, the lower slot index is evicted |
| `asid tagging` | two address spaces mapping the same `PageId` to different frames both hit correctly, and a context switch between them evicts nothing |
| `no flush on switch` | 100 alternating dispatches between two processes produce zero TLB invalidations |
| `explicit flush` | `ioctl('tlb_flush')` invalidates every entry |
| `shootdown` | `shootdown(f)` invalidates exactly the entries naming frame `f` |
| `miss emits` | a miss emits exactly one `tlb.miss` carrying the pid and page |
| `hit rate` | after 80 hits and 20 misses, `tlbHitRate` is 0.8; with zero accesses it is 0, not `NaN` |

### `tests/kernel/memory/frameTable.test.ts`

| Case | Assertion |
|---|---|
| `free list ascending` | after 10,000 seeded allocate/free operations the free list is strictly ascending |
| `deterministic reuse` | two tables reaching the same free set by different operation orders return the same next `allocate` result |
| `pinned excluded` | `unpinnedFrames()` omits every pinned frame and is ascending |
| `framesOf` | `framesOf(space)` returns exactly the frames whose `owner` is `space`, ascending |
| `free pool retains` | a freed frame retains its `owner` and `page` while in the free pool, and loses them when reallocated |
| `free pool capacity` | with `freePoolRetain` 4, the fifth freed frame pushes the oldest out of the pool and into the free list |
| `free list before pool` | `allocate` takes from the free list while it is non-empty and only then from the free pool |
| `exhaustion` | `allocate` returns `null` when no frame is available, and never throws |

### `tests/kernel/memory/fragmentation.test.ts`

| Fixture | Assertion |
|---|---|
| `MEM-FRAG-1` | `externalFragmentation` is exactly `0` under paging for six configurations varying `totalFrames`, `pageSize` and process count |
| `internal under paging` | four processes requesting 5000, 9000, 1, 4096 bytes at page size 4096 give internal fragmentation 3192 + 3288 + 4095 + 0 = 10575 |
| `external one hole` | with all free memory in one hole, `externalFragmentation` is 0 |
| `external zero free` | with no free memory, `externalFragmentation` is 0 and not `NaN` |
| `rations table` | with `totalFrames` 64 and 8 active processes, generous gives 12, standard 8, lean 4, starved 3, all integers |
| `minFrames floor` | with 64 frames and 40 active processes, every rations setting returns at least 3 |

## Out of scope

- `src/kernel/memory/replacement/**`, `demandPaging.ts`, `workingSet.ts`,
  `thrashing.ts`. WP-06 owns them. Leave the fault path as a throwing stub.
- The six replacement policies and every `VM-*` fixture.
- `MemoryMetrics.pageFaults`, `majorFaults`, `evictions`, `writeBacks`,
  `faultRate` and `workingSets`. Return zeros and an empty map with a
  `// TODO(astra):` naming WP-06.
- `src/kernel/scheduler/**`, `sync/**`, `deadlock/**`, `storage/**`, `io/**`,
  `fs/**`, `security/**`, `syscall/**`, `invariants.ts`.
- Any change to `Kernel.ts` beyond wiring `MemoryHooks` and implementing
  `setAllocationStrategy`. Five other wave-2 packages read this file.
- Anything outside `src/kernel/memory/`, `tests/kernel/memory/` and the two
  permitted edits.

## Report back

State:

1. Pass or fail for each of the seventeen acceptance criteria, by number.
2. The three verification command outcomes.
3. For each of the nine `MEM-*` fixtures, the values your implementation produced
   next to the values in sim spec 16.5.
4. Whether WP-02's kernel construction already throws on a non-power-of-two
   `pageSize`. If it does not, report it; do not patch it.
5. Where invariant I-9 is satisfied by construction in your TLB, in one sentence.
6. The exact interface of the `demandPaging` hook you left stubbed, so WP-06
   implements against it.
7. Every `// TODO(astra):` left in the tree, with file and line.
