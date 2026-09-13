# WP-06: Virtual memory, demand paging and the six replacement policies

## Objective

When this package is done the kernel demand-pages: nothing is loaded before it is
touched, faults follow the nine-step service path, minor and major faults are
distinguished and counted separately, and all six page replacement policies
reproduce their textbook fault counts and eviction orders on the standard
reference string. Belady's anomaly is demonstrable on demand. Working sets are
measured over a sliding window, thrashing is detected by two independent signals
with three severity bands, and a convoy can die of `thrashing_collapse`. This is
the simulation half of Leg 8, the showpiece leg.

## Prerequisites

WP-05 complete and green.

Files that must already exist:

- `src/kernel/memory/FrameTable.ts` with `freePool`, `unpinnedFrames` and
  `framesOf`
- `src/kernel/memory/PageTable.ts`, `Tlb.ts` with `shootdown`, `translate.ts`
- `src/kernel/memory/rations.ts` with `AllocationScheme` and `ReplacementScope`
- `src/kernel/memory/MemorySubsystem.ts` with the stubbed `demandPaging` hook
- `src/kernel/process/Program.ts` with the placeholder locality model and
  `allProgramsScripted()`

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 7 in full: 7.1 (demand paging), 7.2 (the page
  fault service path and the EAT table), 7.3 (minor versus major faults and
  copy-on-write), 7.4 (the page replacement interface contract points), 7.5 (all
  six policies with their traces), 7.6 (Belady's anomaly), 7.7 (the working set
  model and the reference generator), 7.8 (thrashing)
- `02-KERNEL-SIM-SPEC.md` section 3.4, the copy-on-write half, since fixture
  `VM-COW-1` lives partly in WP-02's code
- `02-KERNEL-SIM-SPEC.md` section 2.3, the paragraph on `futureReferences` and
  why `optimal` is only offered in scripted scenarios
- `02-KERNEL-SIM-SPEC.md` section 16.6 (the virtual memory fixture table,
  including the Belady table)
- `02-KERNEL-SIM-SPEC.md` section 15, the "Memory" invariant group

## Files you will create

```
src/kernel/memory/demandPaging.ts
src/kernel/memory/workingSet.ts
src/kernel/memory/thrashing.ts
src/kernel/memory/replacement/registry.ts
src/kernel/memory/replacement/fifo.ts
src/kernel/memory/replacement/lru.ts
src/kernel/memory/replacement/clock.ts
src/kernel/memory/replacement/optimal.ts
src/kernel/memory/replacement/lfu.ts
src/kernel/memory/replacement/random.ts
src/kernel/memory/locality.ts
tests/kernel/memory/replacement.test.ts
tests/kernel/memory/belady.test.ts
tests/kernel/memory/demandPaging.test.ts
tests/kernel/memory/workingSet.test.ts
tests/kernel/memory/thrashing.test.ts
```

## Files you may modify

```
src/kernel/memory/MemorySubsystem.ts  (replace the stubbed fault hook; fill the
                                       six zeroed MemoryMetrics fields)
src/kernel/process/Program.ts         (replace the placeholder locality model with
                                       the sim spec 7.7 model. Nothing else.)
src/kernel/Kernel.ts                  (implement setReplacementPolicy only)
src/kernel/index.ts                   (add the REPLACEMENT_POLICIES export)
```

Nothing else.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export type PageReplacementId = 'fifo' | 'lru' | 'clock' | 'optimal' | 'lfu' | 'random';

/**
 * Pluggable page replacement policy. Ch. 10.4. `optimal` requires a reference
 * string lookahead, which the sim provides only in scripted teaching scenarios;
 * it exists so the player can compare their policy against the theoretical floor
 * and so Belady's anomaly can be demonstrated on demand.
 */
export interface PageReplacementPolicy {
  readonly id: PageReplacementId;
  readonly displayName: string;
  reset(frames: readonly Frame[]): void;
  onAccess(space: AddressSpaceId, page: PageId, frame: FrameId, ctx: MemoryContext): void;
  onLoad(space: AddressSpaceId, page: PageId, frame: FrameId, ctx: MemoryContext): void;
  selectVictim(ctx: MemoryContext): FrameId;
  snapshot(): PageReplacementSnapshot;
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

export interface PageReplacementSnapshot {
  readonly policy: PageReplacementId;
  /** Policy-specific ordering, for the world to draw the victim queue. */
  readonly order: readonly FrameId[];
  /** Clock hand position, for the clock policy only. */
  readonly handIndex: number | null;
}

export interface PageTableEntry {
  readonly page: PageId;
  frame: FrameId | null;
  valid: boolean;
  dirty: boolean;
  referenced: boolean;
  readable: boolean;
  writable: boolean;
  executable: boolean;
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
```

Events this package emits, from the frozen union:

```ts
| (EventBase & { type: 'memory.page_fault'; pid: Pid; page: PageId; major: boolean })
| (EventBase & { type: 'memory.page_loaded'; pid: Pid; page: PageId; frame: FrameId })
| (EventBase & { type: 'memory.page_evicted'; frame: FrameId; page: PageId; dirty: boolean; policy: PageReplacementId })
| (EventBase & { type: 'memory.thrashing'; faultRate: number; severity: 'warning' | 'critical' })
| (EventBase & { type: 'security.access_denied'; domain: DomainId; object: string; right: AccessRight })
```

## Inherited from WP-05

Everything below comes from WP-05's completion report or from the source it left in
`src/kernel/memory/`. Signatures are quoted, not paraphrased.

### The demand paging hook

The exact hook exported by `MemorySubsystem.ts` is:

```ts
export interface DemandPagingHooks {
  /** Pending major faults return false; synchronous minor faults return true. */
  fault(pid: Pid, page: PageId, write: boolean): { readonly hit: boolean };
  expireTimers?(tick: Tick): void;
}
```

Install with `memorySubsystem.setDemandPaging(hooks)`. The default `fault` throws
`not implemented: page fault` and names WP-06 in its TODO. `expireTimers` is
reached through the existing memory phase dispatch. A successful fault callback must
leave a valid resident PTE.

### Loading, reclaiming and choosing candidates

- `loadPage(space, page, pinned?)` installs the mapping and refreshes shared
  mappings. Load through it rather than writing a PTE by hand.
- `reclaim(space, page)` retrieves an exact retained page from the free pool.
- `shootdown(frame)` on the TLB invalidates every entry naming that frame. Use it
  alongside the PTE transition on every replacement.
- `unpinnedFrames()` excludes free, retained and pinned entries.
- `context(rng, futureReferences, space?)` supplies the live tables and the
  replacement candidates under the selected scope. The default scope is local.
  **Supply the faulting address space to enforce local replacement; omitting
  `space` exposes all eligible frames.** That argument is the whole local/global
  switch, so a global-replacement leg omits it and a local one does not.

Use the live `frameTable`, `pageTables` and `tlb`. The page tables adapt the
kernel's existing `Map<AddressSpaceId, PageTableEntry[]>`, so lifecycle and IPC
direct edits stay visible through held views. Lifecycle owns `cowRefCount`; no
field was added to the PCB or to `Frame`. `copyFrame` copies a deterministic content
tag. Shared frames remain pinned, and `loadPage` invokes the supplied IPC refresh
callback.

### Retained free-pool semantics

`FrameTable.free(frame, true)` retains evicted contents in the free pool, which is
what makes reclaim-from-pool a minor fault. The lifecycle-facing
`MemoryHooks.freeFrame` discards during teardown instead. Allocation consumes the
ascending free list before it touches retained frames. Retained mappings are ordered
by eviction, default capacity four. Newer retained copies supersede obsolete copies
of the same logical page, and active COW frames sharing owner and page remain valid.
Coordinate PTE invalidation and TLB shootdown around retained eviction and reclaim.

### The ordering trap

The kernel publishes the major-fault event **after** the fault callback returns.
Defer the associated eviction and load events to later service so that
fault-before-eviction and fault-before-load ordering is preserved, or integrate that
ordering explicitly when you implement demand paging. Emitting an eviction from
inside `fault` puts it in front of the fault that caused it.

### Fault ownership, in full

- The `MemoryHooks.access` result answers whether the page is available. It does
  not report whether the TLB lookup hit. The access event's `hit` field records the
  TLB result, and `MemorySubsystem` owns both `tlb.miss` and `memory.access`.
- A resident TLB miss therefore returns `{ hit: true }` and never becomes a page
  fault. It costs `tlbMissTicks` and nothing else.
- The kernel remains the sole emitter of a pending major fault when `access`
  returns `{ hit: false }`, and it blocks the process.
- The existing COW lifecycle remains the sole emitter of its minor fault and its
  load. It runs before memory access and does not route through
  `DemandPagingHooks`.
- A future synchronous minor-fault service returns `{ hit: true }` and owns its own
  minor and load events. A pending major service returns false and leaves the major
  event to the kernel.

That is the existing return-value boundary and it exists to stop two layers
reporting the same fault. Two tests enforce it: `emits one major fault while a page
is pending and gates the successful resident retry`, and `COW with the real frame
table emits exactly one minor fault and one load before the write retires`.

I-9 is satisfied by construction because install and lookup require the cached
owner and page to agree with the live frame, and the subsystem removes entries
inconsistent with the live PTE. A COW or shared alias whose frame has a different
owner or page remains a valid PTE access but is not cached. Context switches do not
flush.

### What `metrics()` leaves for you

`metrics()` computes resident paging fragmentation, frame use and TLB hit rate.
These `MemoryMetrics` fields are zero or empty with a WP-06 TODO and are yours to
populate: `pageFaults`, `majorFaults`, `evictions`, `writeBacks`, `faultRate`, and
`workingSets`, which is an empty map. `contiguousMetrics()` exposes the parallel
contiguous model and is not yours. `setRequestedBytes(space, bytes)` supports
byte-granular internal fragmentation; default admission uses declared pages.

### Frame policy without replacement

`setFramePolicy` carries the rations setting, the equal or proportional allocation
scheme, and the local or global replacement scope, without implementing replacement
policy. WP-05 recorded the selected allocation parameters and stopped there, so
`replacementScope` and `allocationScheme` are pre-declared territory that you
implement. Suggested quotas clamp to the three-frame minimum when capacity allows;
explicit budget validation throws in development and clamps in production; for
physical capacity below three the quota is capped at actual capacity.

### Persistence you extend

`subsystems.memory` and `subsystems.vm` are now typed as `MemorySnapshotState` and
`VmSnapshotState`, both version 1, per amendment 4. The vm payload holds the
ASID-tagged TLB slots in replacement order, the lookup counters, the TLB timing and
the pending instruction access costs. Extend it with demand-fault service state,
replacement ordering, fault counters and working-set state, and version the shape
when you change it. The mapped types over `Frame` and `PageTableEntry` couple that
save format to frozen interfaces, so review the persisted shape whenever either
moves.

## Specification

### 1. `src/kernel/memory/demandPaging.ts`

The nine-step service path from sim spec 7.2, **in exactly this order**:

1. The access instruction executes in phase 8. The TLB misses.
2. The page table entry is examined. `valid === false` means a fault. Emit
   `memory.page_fault { pid, page, major }` where `major` comes from step 4.
3. **Protection check first.** If the access is a write and `writable === false`
   and the frame is not COW-shared, this is a protection fault: emit
   `security.access_denied` and terminate the process with
   `terminationReason: 'protection_fault'`. A protection violation is never
   serviced as a fault.
4. **Classify.** Minor when the page's frame is still resident and merely
   unmapped: in the free pool, a COW copy, or shared and already loaded by
   another process. No backing-store I/O, `major = false`, cost
   `minorFaultTicks` (default 1). Major when the page must be read from the
   backing store: `major = true`, cost is a disk request, and the process
   transitions T5 with `blockedOn = { kind: 'page_fault', page }`.
5. **Find a frame.** Free list head if non-empty, otherwise
   `PageReplacementPolicy.selectVictim(ctx)`.
6. **Evict the victim.** If `victim.dirty`, enqueue a write-back disk request and
   emit `memory.page_evicted { dirty: true }`; the fault is not complete until
   the write-back completes, which doubles the service time. If clean, discard
   and emit `memory.page_evicted { dirty: false }`. Invalidate the victim's PTE,
   set `swapped = true` on it, and call `tlb.shootdown(frame)`.
7. **Read in.** For a major fault, enqueue a read disk request for the page's
   backing block and block the process. For a minor fault, complete immediately.
8. **Install.** Set `frame`, `valid = true`, `dirty = false`,
   `referenced = true`, `lastAccessTick = tick`, `accessCount += 1`. Set the
   frame's `owner`, `page`, `loadedAtTick`, `referenceBit = true`. Call
   `PageReplacementPolicy.onLoad`. Emit `memory.page_loaded`.
9. **Restart the instruction.** The faulting access is re-executed from the
   beginning on the next tick the process runs. It does not consume a second unit
   of service; **`programCounter` is not advanced by a fault.** Invariant I-8
   checks this.

WP-09 owns the disk. Until it lands, model a major fault's cost as a fixed
`majorFaultTicks` (default 20) sleep rather than a real disk request, behind
`// TODO(astra): route through the disk queue once WP-09 lands`. Keep the
interface `this.storage.enqueue(...)` so WP-09 substitutes without touching this
file.

Export the effective-access-time helper, since the debrief card prints it:

```ts
/** EAT = (1 - p) * ma + p * faultServiceNs. ma = 200, faultServiceNs = 8e6. */
export function demandPagingEat(p: number, ma?: number, faultServiceNs?: number): number;
```

### 2. Minor faults have three sources

Per sim spec 7.3, and all three must work:

1. **COW write fault.** WP-02 built this; verify it routes through your fault
   path and produces `major: false`.
2. **Shared-region first touch.** A process attaches a `SharedRegion` whose pages
   are already resident for another process; the PTE is installed pointing at the
   existing frame.
3. **Reclaim from the free pool.** WP-05 built the pool. A frame freed but not
   yet reused still holds its old page; if the owner touches it again before
   reuse, the mapping is restored without I/O.

`MemoryMetrics.pageFaults` counts all faults; `majorFaults` counts only those
that touched the backing store. A high total with a low major count is healthy,
and the HUD shows both because a player who reads only the total makes the wrong
decision.

### 3. The replacement interface contract

Per sim spec 7.4:

- `selectVictim` is called **only when no free frame exists**. It must return a
  frame that is in use and not `pinned`. If every candidate is pinned, it throws,
  and the kernel converts that into
  `memory.allocation_failed { reason: 'no_space' }` and terminates the requesting
  process with `out_of_memory`.
- Under **local** replacement, `ctx.frames` is filtered to the faulting process's
  own frames before the call. Under **global** it is every unpinned frame. The
  policies do not know which mode they are in, which is why the same six serve
  both. Build the filtered array in `MemorySubsystem`, in ascending `FrameId`
  order, reusing one array so it does not allocate per fault.
- `snapshot().order` is the policy's own victim ordering, **most-likely-victim
  first**, which the world layer draws as a queue of slabs.
- `onAccess` is called on every hit **and after every load**.

### 4. The six policies

The standard reference string throughout is
`7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2, 1, 2, 0, 1, 7, 0, 1` with **three
frames**, all initially free.

**FIFO** (sim spec 7.5, Ch. 10.4.2). Victim is the frame with the smallest
`loadedAtTick`, tie-broken on lowest `FrameId`. Structure is a queue of `FrameId`
in load order plus a `nextIndex` cursor. **15 faults** on the standard string.
Eviction order `7, 0, 1, 2, 3, 0, 4, 2, 3, 0, 1, 2`.

**LRU** (Ch. 10.4.4). Victim is the frame whose page has the smallest
`lastAccessTick`, tie-broken on lowest `FrameId`. Frames never accessed since
load use their `loadedAtTick`. Use the counter implementation: `lastAccessTick`
on the PTE and on the `Frame`, updated in `onAccess`; `selectVictim` is an O(n)
scan, which is honest about what LRU costs in hardware. Expose the recency stack
as `snapshot().order`. **12 faults.** Eviction order
`7, 1, 2, 3, 0, 4, 0, 3, 2`.

**Clock / second chance** (Ch. 10.4.5.2). The victim rule, exactly:

```
1. while frames[hand].referenceBit is true:
2.     frames[hand].referenceBit = false
3.     hand = (hand + 1) mod frameCount
4. victim = hand
5. after installing the new page at victim:
6.     frames[victim].referenceBit = true
7.     hand = (victim + 1) mod frameCount
```

The loop terminates because each iteration clears one bit. **Step 6 is
required**: a freshly loaded page has just been referenced, and setting it is
what makes clock differ from FIFO. State is the frame array plus one integer
`hand`, exposed as `snapshot().handIndex`. **14 faults.** Eviction order
`7, 1, 2, 0, 3, 4, 2, 0, 3, 1, 2`. The three hand-sweep rows in sim spec 7.5 are
worth stepping through in a debugger before you trust your implementation.

**Optimal** (Ch. 10.4.3). Victim is the frame whose page has the largest distance
to its next use in `ctx.futureReferences`. A page never referenced again has
distance `+Infinity`. Tie-break among equal distances on **lowest frame index**.
`ctx.futureReferences` is non-null only when every runnable process has a
scripted reference string; outside that, `selectVictim` throws and the kernel
refuses the policy. `setReplacementPolicy('optimal')` when
`allProgramsScripted()` is false returns without effect and logs a
`kernel.panic` in dev builds. **9 faults.** Eviction order `7, 1, 0, 4, 3, 2`.
This is the floor and it is the denominator of the player's efficiency score.

**LFU** (Ch. 10.4.7). Victim is the frame whose page has the smallest
`accessCount`, tie-broken on smallest `loadedAtTick`, then lowest `FrameId`.
Counter policy: `accessCount` starts at **1** when the page is loaded (the load
is itself a reference) and increments on every access. **When a page is evicted
its count is discarded, not retained.** Retaining counts is a defensible variant
producing different numbers, so the discard rule is normative. **13 faults.**
Eviction order `7, 1, 2, 3, 4, 2, 1, 2, 1, 7`. Implement `lfuAging: number`
(right-shift every N ticks, default 0 = off), which is the codex's remedy for the
known pathology where page 0 accumulates a count of 6 and becomes unevictable.

**Random.** Victim is `ctx.rng.pick(eligibleFrames)` where `eligibleFrames` is
the unpinned subset of `ctx.frames` **in ascending `FrameId` order**. The array
must be built in ascending order every time, because `pick` draws an index and
the index means nothing unless the order is fixed. Draws from `root/vm`, exactly
one `next()` per victim selection. The fault count for the standard string with
that stream is fixture `VM-RANDOM-1`, **recorded at implementation** and then
frozen: print it, pin it in the test, and report the value.

### 5. Belady's anomaly

Per sim spec 7.6, reference string `1,2,3,4,1,2,5,1,2,3,4,5`:

| Policy | 3 frames | 4 frames |
|---|---|---|
| fifo | **9** | **10** |
| lru | 10 | 8 |
| optimal | 7 | 6 |

`VM-BELADY-1` asserts `faults(4) > faults(3)`, which is the anomaly.
`VM-BELADY-2` and `VM-BELADY-3` assert `faults(4) <= faults(3)`, which is the
stack-algorithm property. Assert both the exact counts and the inequalities, so a
future implementation that gets the counts wrong but keeps the relation still
fails.

### 6. `src/kernel/memory/workingSet.ts`

Per sim spec 7.7:

```
WS(t, Δ) = the set of distinct pages referenced in the Δ most recent references
WSS_i    = |WS(t, Δ)|
D        = Σ WSS_i
```

`Δ` is `workingSetWindow`, default 10 references.

Implementation: each process keeps a fixed-capacity ring buffer of its last `Δ`
referenced `PageId`s plus a `Map<PageId, number>` of counts, so `WSS` is
`map.size` in O(1). Push evicts the oldest and decrements its count, deleting the
key at zero. The ring buffer is part of the snapshot.

`MemoryMetrics.workingSets` is rebuilt in phase 10 as
`pid -> ringBuffer.distinctCount`.

**VESPER's passive.** Without VESPER, the sim reports
`WSS_reported = WSS_true + noise` where `noise` is `rng.int(-2, 3)` on
`root/vm`, drawn once per 10 ticks per process. With VESPER alive the range
narrows to `rng.int(-1, 2)`. **The reported value is what the HUD and `vmstat`
show; the true value is what the thrashing test uses.** VESPER makes the player's
information better without changing the physics. Keep the two values in separate
fields and never let the reported one reach the thrashing detector.

Report the noise draw count in your report, since it consumes `root/vm` draws
that also feed the random replacement policy, and the two must not be interleaved
differently across a restore.

### 7. `src/kernel/memory/locality.ts`

The reference generator from sim spec 7.7, replacing WP-02's placeholder in
`Program.ts`:

1. A process has a current locality: a contiguous run of `localitySize` pages
   (default 4) starting at `localityBase`.
2. With probability `1 - localityShiftChance` (default 0.98) the next reference is
   `localityBase + rng.int(0, localitySize)`.
3. Otherwise the locality shifts:
   `localityBase = rng.int(0, pageCount - localitySize)`.
4. Writes occur with probability `writeRatio` (default 0.3).

All draws come from `root/vm`. This gives phase behaviour the working set window
can detect, which is what Ch. 10.6.1's locality argument requires.

Changing the generator changes every determinism hash, so make this change in one
commit and re-run `DET-D1`, `DET-D3` and `DET-D4` immediately.

### 8. `src/kernel/memory/thrashing.ts`

Per sim spec 7.8. Thrashing is `D > m`: the sum of the working set sizes exceeds
the number of available frames.

**Two independent signals**, both computed in phase 10, because each catches a
case the other misses.

*Signal A, the fault rate.* An integer-friendly EWMA with alpha 1/8:

```ts
faultAccumulator = faultAccumulator - (faultAccumulator >> 3) + faultsThisTick;
faultRate = (faultAccumulator * 1000) / (8 * 1);
```

The shift-based form is used rather than a float multiply so the value is
bit-identical after a snapshot restore. Do not "clean this up" into a float EWMA.

*Signal B, the demand ratio.* `D / m` where `D = Σ WSS_true` and
`m = totalFrames`.

**Three severity bands:**

| Band | Condition | Event | Kernel response |
|---|---|---|---|
| healthy | `faultRate < thrashingThreshold` and `D <= m` | none | none |
| warning | `faultRate >= thrashingThreshold` or `D > m` | `memory.thrashing { severity: 'warning' }` | phase 5 admits nothing |
| critical | `faultRate >= 2 * thrashingThreshold` or `D > 1.5 * m` | `memory.thrashing { severity: 'critical' }` | suspend the process with the largest `WSS`, swap out its whole working set, reduce the effective degree of multiprogramming by 1 |

**Escalation.** While critical persists, suspend one more process every
`thrashingSuspendInterval` ticks (default 50), always the largest working set
first, tie-broken by **highest pid**. A suspended process moves to `waiting` with
`blockedOn = { kind: 'sleep', untilTick: tick + thrashingSuspendDuration }`. If
the suspension queue reaches every process except one and the fault rate is still
critical, terminate the remaining process with
`terminationReason: 'thrashing_collapse'` and emit `kernel.panic`. That is the
total collapse and it is how a convoy dies on Leg 8.

**De-escalation.** When `faultRate` falls below `thrashingThreshold` and
`D <= m` for `thrashingRecoveryTicks` consecutive ticks (default 100), resume
suspended processes one per interval, **lowest pid first**.

**Page-fault-frequency control** (Ch. 10.6.3), offered as
`thrashingControl: 'working_set' | 'pff'`. Under PFF each process has upper and
lower fault-rate bounds (default 300 and 50 per thousand ticks); exceeding the
upper bound grants it another frame, falling below the lower bound takes one
away, and a grant with no free frame available suspends a process.

The kernel must not know about convoy abilities. LUMEN's recompile, KESTREL's
prefetch and VESPER's remap are game-layer verbs that arrive as syscalls or as
direct kernel mutator calls from `@game`. Expose the three primitives the game
layer will need and nothing more: `halveRemainingBurst(pid)`,
`prefetchNextFaults(pid, count)` and `remapOptimalLocality(pid)`. Do not mention
Program names anywhere in `src/kernel`.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. Fixtures `VM-FIFO-1`, `VM-LRU-1`, `VM-CLOCK-1`, `VM-OPT-1` and `VM-LFU-1` all
   pass with both the exact fault count and the exact eviction order from sim
   spec 16.6.
5. Fixture `VM-RANDOM-1` runs, prints its fault count and eviction order, and the
   test pins both. The pinned values appear in your report.
6. Fixtures `VM-BELADY-1`, `VM-BELADY-2` and `VM-BELADY-3` pass with the exact
   counts and the two inequalities.
7. Fixture `VM-EAT-1` passes: `(1-p)*200 + p*8e6` for p = 0, 1e-6, 2.5000625e-6,
   1e-5, 1e-4, 1e-3 gives 200.0000, 207.9998, 219.9995, 279.9980, 999.9800,
   8199.8000 ns to four decimal places.
8. Fixture `VM-EAT-2` passes: the p for 10 percent degradation is 2.5000625e-6,
   which is one fault per 399,990 accesses.
9. Fixtures `VM-WS-1` and `VM-WS-2` pass: window 10 over `2 6 1 5 7 7 7 7 5 1`
   gives `{1,2,5,6,7}` and WSS 5; over `3 4 3 4 4 4 3 4 4 4` gives `{3,4}` and
   WSS 2.
10. Fixtures `VM-THRASH-1` and `VM-THRASH-2` pass: D = 70 with m = 64 emits
    `memory.thrashing { severity: 'warning' }` and admission stops; D = 100 with
    m = 64 emits `severity: 'critical'` and the largest working set is suspended.
11. Fixture `VM-COW-1` passes: fork then a child write to one shared page gives
    exactly one `memory.page_fault { major: false }`, one `memory.page_loaded`,
    zero `memory.page_evicted`, and `cowRefCount` drops from 2 to 1.
12. `selectVictim` never returns a pinned frame, asserted across 10,000 faults in
    a randomised run.
13. `selectVictim` with every candidate pinned throws, and the kernel converts it
    into `memory.allocation_failed { reason: 'no_space' }` plus a termination with
    `out_of_memory`.
14. A page fault never advances `programCounter`. Asserted directly.
15. `setReplacementPolicy('optimal')` with an unscripted workload is a no-op and
    emits `kernel.panic` in a dev build.
16. `faultRate` is bit-identical across `snapshot()` and `restore()`. Since WP-11
    owns `snapshot`, assert the weaker property here: the EWMA uses only integer
    arithmetic and shifts, verified by a test that runs 5000 ticks and asserts
    `Number.isInteger(faultAccumulator)` on every tick.
17. `DET-D1`, `DET-D3` and `DET-D4` still pass after the locality model change.
18. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
19. The forbidden-identifier scan still returns zero matches.

## Tests you must write

### `tests/kernel/memory/replacement.test.ts`

Drive each policy through the standard reference string with three frames, using
a helper that returns `{ faults, evictionOrder, finalFrames }`.

| Fixture | Policy | Faults | Eviction order |
|---|---|---|---|
| `VM-FIFO-1` | fifo | 15 | `7, 0, 1, 2, 3, 0, 4, 2, 3, 0, 1, 2` |
| `VM-LRU-1` | lru | 12 | `7, 1, 2, 3, 0, 4, 0, 3, 2` |
| `VM-CLOCK-1` | clock | 14 | `7, 1, 2, 0, 3, 4, 2, 0, 3, 1, 2` |
| `VM-OPT-1` | optimal | 9 | `7, 1, 0, 4, 3, 2` |
| `VM-LFU-1` | lfu | 13 | `7, 1, 2, 3, 4, 2, 1, 2, 1, 7` |
| `VM-RANDOM-1` | random, `root/vm` from seed 1234 | pinned at implementation | pinned |

Plus:

| Case | Assertion |
|---|---|
| `fifo full trace` | the 20-row table in sim spec 7.5 is reproduced: after each reference, the frame contents match the "Frames after" column |
| `clock hand sweeps` | at reference 4 (the 8th), the hand starts at 0 with bits 1,1,1, clears all three, wraps to 0 and evicts frame 0 holding page 2, leaving the hand at 1; the two other rows in that table also match |
| `clock sets bit on load` | after installing a page, that frame's `referenceBit` is true |
| `lru tie-break` | with two frames sharing the lowest `lastAccessTick`, the lower `FrameId` is evicted |
| `lfu starts at 1` | a freshly loaded page has `accessCount === 1` |
| `lfu discards on evict` | a page evicted with count 6 and reloaded has count 1 |
| `lfu aging` | with `lfuAging: 8`, page 0's count is right-shifted every 8 ticks and it becomes evictable |
| `optimal ordering` | `snapshot().order` is most-likely-victim first, so index 0 is the page with the largest next-use distance |
| `optimal throws unscripted` | with `futureReferences === null`, `selectVictim` throws |
| `random uses one draw` | 50 victim selections consume exactly 50 `next()` calls from `root/vm` |
| `random ascending eligible` | the eligible array passed to `pick` is ascending by `FrameId` on every call |
| `ordering is most-likely-first` | for all six policies, `snapshot().order[0]` equals the frame the next `selectVictim` returns |

### `tests/kernel/memory/belady.test.ts`

| Fixture | Assertion |
|---|---|
| `VM-BELADY-1` | fifo on `1,2,3,4,1,2,5,1,2,3,4,5` gives 9 faults at 3 frames and 10 at 4; `faults(4) > faults(3)` |
| `VM-BELADY-2` | lru gives 10 and 8; `faults(4) <= faults(3)` |
| `VM-BELADY-3` | optimal gives 7 and 6; `faults(4) <= faults(3)` |
| `stack property sweep` | lru and optimal satisfy `faults(n+1) <= faults(n)` for n from 1 to 6 on the same string |

### `tests/kernel/memory/demandPaging.test.ts`

| Case | Assertion |
|---|---|
| `nothing preloaded` | a process admitted with 40 pages holds zero frames until its first access |
| `service path order` | the emitted event sequence for one major fault is exactly `memory.page_fault`, `memory.page_evicted`, `memory.page_loaded` |
| `protection first` | a write to a read-only non-COW page emits `security.access_denied` and terminates with `protection_fault`, and emits **no** `memory.page_loaded` |
| `dirty write-back` | evicting a dirty frame emits `memory.page_evicted { dirty: true }` and takes twice the service time of a clean eviction |
| `clean discard` | evicting a clean frame emits `dirty: false` and enqueues no write |
| `tlb shootdown` | eviction invalidates every TLB entry naming the victim frame |
| `restart does not advance pc` | after a fault, the process's `programCounter` is unchanged and the same access re-executes |
| `minor from free pool` | touching a page whose frame is still in the free pool gives `major: false` and zero disk requests |
| `minor from shared region` | attaching a shared region whose pages are resident gives `major: false` |
| `VM-COW-1` | per acceptance criterion 11 |
| `major vs total` | after a mixed run, `majorFaults <= pageFaults` and `majorFaults < pageFaults` strictly for a workload with COW and free-pool reclaims |
| `VM-EAT-1` | the six-row EAT table to four decimal places |
| `VM-EAT-2` | `demandPagingEat(2.5000625e-6)` is within 1e-9 of `200 * 1.1` |
| `pinned exhaustion` | with every frame pinned, a fault produces `memory.allocation_failed { reason: 'no_space' }` and a termination with `out_of_memory` |

### `tests/kernel/memory/workingSet.test.ts`

| Fixture | Assertion |
|---|---|
| `VM-WS-1` | window 10 over `2 6 1 5 7 7 7 7 5 1` gives the set `{1,2,5,6,7}` and WSS 5 |
| `VM-WS-2` | window 10 over `3 4 3 4 4 4 3 4 4 4` gives `{3,4}` and WSS 2 |
| `ring eviction` | pushing an 11th reference removes the 1st and decrements its count |
| `count reaches zero` | a page whose last occurrence leaves the window is deleted from the map, so `map.size` equals the distinct count |
| `O(1) wss` | `wss()` does not iterate the ring; verified by asserting the map size equals a separately computed distinct count over 1000 pushes |
| `vesper noise range` | without VESPER, reported WSS differs from true WSS by a value in `[-2, 2]`; with VESPER, in `[-1, 1]` |
| `vesper noise cadence` | the noise is redrawn once per 10 ticks per process, not per reference |
| `true value drives detection` | the thrashing detector reads the true WSS; injecting a large reported-only offset does not change the emitted severity |
| `locality model` | over 10,000 generated references with `localitySize` 4 and `localityShiftChance` 0.02, the measured shift count is within 15% of 200 |

### `tests/kernel/memory/thrashing.test.ts`

| Fixture | Assertion |
|---|---|
| `VM-THRASH-1` | D = 70 with m = 64 emits `memory.thrashing { severity: 'warning' }` and phase 5 admits no new process while it holds |
| `VM-THRASH-2` | D = 100 with m = 64 emits `severity: 'critical'` and the process with the largest WSS is suspended |
| `ewma integer` | `faultAccumulator` is an integer on every one of 5000 ticks |
| `ewma alpha` | feeding 8 faults per tick for 200 ticks converges `faultRate` to within 1% of its analytic limit |
| `escalation cadence` | under sustained critical, one more process is suspended every 50 ticks |
| `escalation tie-break` | two processes with equal WSS suspend highest pid first |
| `total collapse` | with all but one process suspended and the rate still critical, the last process terminates with `thrashing_collapse` and `kernel.panic` is emitted |
| `de-escalation` | after 100 consecutive healthy ticks, suspended processes resume one per interval, lowest pid first |
| `pff mode` | under `thrashingControl: 'pff'`, a process above 300 faults per thousand ticks gains a frame and one below 50 loses one |
| `player controls` | lowering the degree of multiprogramming by 2 reduces D by the two removed working sets and clears the warning band |

## Out of scope

- `src/kernel/memory/FrameTable.ts`, `PageTable.ts`, `Tlb.ts`, `translate.ts`,
  `contiguous/**`, `fragmentation.ts`, `rations.ts`. WP-05 owns them. If one has
  a bug, report it rather than fixing it, unless the bug makes an acceptance
  criterion here unreachable, in which case fix the minimum and say what you
  changed.
- The real disk request path. WP-09 owns `src/kernel/storage/`. Model a major
  fault's cost as a fixed sleep behind the named hook.
- `src/kernel/scheduler/**`, `sync/**`, `deadlock/**`, `io/**`, `fs/**`,
  `security/**`, `syscall/**`, `invariants.ts`.
- Convoy abilities and Program names. Expose the three primitives and nothing
  more.
- Any change to `Kernel.ts` beyond implementing `setReplacementPolicy`.
- Anything outside `src/kernel/memory/`, `tests/kernel/memory/` and the four
  permitted edits.

## Report back

State:

1. Pass or fail for each of the nineteen acceptance criteria, by number.
2. The three verification command outcomes.
3. For each of the five deterministic replacement fixtures, the fault count and
   eviction order your implementation produced, next to the sim spec values.
4. The recorded `VM-RANDOM-1` fault count and eviction order, stated as the
   values now frozen.
5. How many `root/vm` draws the VESPER noise consumes per 1000 ticks, and
   confirmation that the random replacement policy and the noise draw from the
   same stream without interleaving differently across a restore.
6. Whether the locality model change shifted any determinism hash, and
   confirmation that `DET-D1`, `DET-D3` and `DET-D4` were re-run afterwards.
7. Every `// TODO(astra):` left in the tree, with file and line.
