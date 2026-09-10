# WP-14: World event router, effect pooling and the derezz effect

## Objective

When this package is done every one of the 48 `KernelEvent` variants has a visual
treatment, routed through one exhaustive switch that fails to compile if a variant
is added without a case. Events are batched and coalesced per frame so five
hundred page faults in one tick read as one surge rather than five hundred
flashes. Effects outlive the tick that spawned them, live in a bounded pool that
never grows, and capture values rather than references. The derezz effect fires on
every `process.exited` with ten reason-specific variants, and a convoy Program's
death runs its full staged sequence from pre-roll through the mote to the
tombstone.

## Prerequisites

WP-13 complete and green. WP-01 for the `KernelEvent` union, which is already in
the frozen `src/kernel/types.ts`.

Files that must already exist:

- `src/world/contracts.ts` with `WorldContext`, `AnchorId` and `StructureHandle`
- `src/world/structures/base/`, `src/world/instancing/`, `src/world/forms/`
- `src/render/camera/FocusCamera.ts`
- `src/render/materials/index.ts` and `src/render/post/chain.ts` with `panic()`
- `src/design/tokens.ts` and `motion.ts`

**`src/world/WorldEventRouter.ts` already exists as an exhaustive compile-time
checklist with `// TODO(astra):` bodies.** Read it first. Your job is to fill
those bodies, not to restructure the switch. If the switch is missing a case for
a variant in the frozen union, that is a bug to fix and to report.

## Required reading

- `01-ARCHITECTURE.md` section 3 in full: 3.1 (the only channel), 3.2
  (`WorldEventRouter` and the three implementer notes), 3.3 (audio, HUD and codex
  subscribe separately, in a fixed order), 3.4 (per-frame batching and
  coalescing), 3.5 (effects outlive the tick that spawned them), 3.6 (the bounded
  effect pool), 3.7 (the 500-page-fault worked example), 3.8 (what the world reads
  that is not an event)
- `03-VISUAL-BIBLE.md` Appendix A in full. **Every row is mandatory at every
  quality tier.** This is the specification for what each event looks like.
- `03-VISUAL-BIBLE.md` section 9 in full: 9.1 (geometry preparation and
  `fracture`), 9.2 (vertex shader), 9.3 (fragment shader), 9.4 (the timing curve),
  9.5 (termination reason drives the character of the death), 9.6 (batching)
- `03-VISUAL-BIBLE.md` section 8 in full: 8.1 (motion tokens), 8.2 (what animates
  and what snaps), 8.3 (context switch), 8.4 (page load and page eviction), 8.5
  (lock acquisition and release), 8.6 (data flowing along a beam), 8.7 (the
  animation budget)
- `03-VISUAL-BIBLE.md` section 4.6 (kernel panic)
- `01-ARCHITECTURE.md` section 7.1 (the per-frame millisecond budget; routing gets
  0.4 ms) and 13.3 (adding a new kernel event)

## Files you will create or complete

```
src/world/WorldEventRouter.ts       (exists with TODO bodies; fill them)
src/world/FrameEventQueue.ts
src/world/AnimationBudget.ts
src/world/domains/ProcessVisuals.ts
src/world/domains/SchedulerVisuals.ts
src/world/domains/MemoryVisuals.ts
src/world/domains/SyncVisuals.ts
src/world/domains/DeadlockVisuals.ts
src/world/domains/StorageVisuals.ts
src/world/domains/IoVisuals.ts
src/world/domains/FsVisuals.ts
src/world/domains/SecurityVisuals.ts
src/world/domains/SystemVisuals.ts
src/world/effects/types.ts
src/world/effects/EffectPool.ts
src/world/effects/EffectRegistry.ts
src/render/derezz/fracture.ts
src/render/derezz/derezz.vert.glsl.ts
src/render/derezz/derezz.frag.glsl.ts
src/render/derezz/DerezzPool.ts
src/render/derezz/variants.ts
tests/world/router.test.ts
tests/world/frameEventQueue.test.ts
tests/world/effectPool.test.ts
tests/world/domains.test.ts
tests/render/derezz.test.ts
```

## Files you may modify

```
src/world/index.ts     (export WorldEventRouter and EffectRegistry per the barrel
                        in architecture 1.6; nothing else)
```

Nothing else.

## Frozen contracts

The whole `KernelEvent` union in `src/kernel/types.ts` is the input to this
package and it may not be edited. Its own comment states the rule this package
implements:

```ts
/**
 * Every observable thing the kernel does. The 3D world, the HUD, the audio
 * engine and the codex all subscribe to this stream and NOTHING else. Adding a
 * visual feature must never require reaching into kernel internals.
 *
 * This union is exhaustively switched in src/world/WorldEventRouter.ts, so a new
 * variant produces a compile error until it is given a visual treatment. That is
 * deliberate.
 */
export type KernelEvent = /* 48 variants */;

export type KernelEventType = KernelEvent['type'];
export type KernelEventOf<T extends KernelEventType> = Extract<KernelEvent, { type: T }>;
```

The router shape, from architecture 3.2. `assertNever` takes a `never` parameter,
so a missing case is a compile error:

```ts
function assertNever(x: never): never {
  throw new Error(`Unhandled KernelEvent variant: ${JSON.stringify(x)}`);
}

export interface WorldDomains {
  readonly process: ProcessVisuals;
  readonly scheduler: SchedulerVisuals;
  readonly memory: MemoryVisuals;
  readonly sync: SyncVisuals;
  readonly deadlock: DeadlockVisuals;
  readonly storage: StorageVisuals;
  readonly io: IoVisuals;
  readonly fs: FsVisuals;
  readonly security: SecurityVisuals;
  readonly system: SystemVisuals;
}
```

The effect types, from architecture 3.5, which are frozen from the moment this
package lands because leg packages spawn against them:

```ts
export type EffectKind =
  | 'derezz' | 'page_flare' | 'page_dissolve' | 'fault_mote' | 'fault_surge'
  | 'seek_arc' | 'interrupt_spike' | 'lock_pulse' | 'race_shear'
  | 'deadlock_ring' | 'journal_stamp' | 'denial_ward' | 'trap_arc';

export interface EffectSpawn {
  readonly kind: EffectKind;
  /** World position, copied. Effects never hold a reference to a live object. */
  readonly at: Vector3;
  readonly to?: Vector3;
  /** Optional moving anchor. Resolved each frame; null is tolerated. */
  readonly follow?: AnchorId;
  readonly lifetimeSeconds: number;
  /** 0..1, drives brightness, scale and particle count. */
  readonly intensity: number;
  /** Packed rgb. Comes from @design tokens via the domain handler. */
  readonly colour: number;
  /** Free-form numeric payload, at most four values, no objects. */
  readonly a?: number;
  readonly b?: number;
  readonly c?: number;
  readonly d?: number;
}

export interface LiveEffect extends EffectSpawn {
  age: number;
  slot: number;
  readonly id: number;
  alive: boolean;
}

export type OverflowPolicy = 'recycle_oldest' | 'aggregate' | 'drop';
```

## Specification

### 1. The only channel

Architecture 3.1. Three rules the code must make structurally true:

- **No visual module holds a reference to a `ProcessControlBlock`.** It holds a
  `Pid` and asks `kernel.process(pid)` when it needs current values. PCBs are
  mutable and reused; a held reference silently observes future mutations.
- **No visual module calls a kernel mutator.** `setScheduler` and friends are
  called by `@game`, in response to a player command that has been recorded in
  `RunState.decisions`.
- `Kernel.events.lastFrame` is the kernel's own convenience view. **The loop does
  not use it**, because a frame may contain up to five steps. The loop accumulates
  into a `FrameEventQueue` instead.

### 2. `src/world/WorldEventRouter.ts`

Fill the existing switch. Three implementer notes from architecture 3.2, all
binding:

- Each `on*` handler receives the **narrowed** event type. Write the domain
  classes so the parameter types come from `KernelEventOf<'memory.page_fault'>`
  and so on, which keeps them in step with the frozen union automatically.
- **Handlers must not throw.** A domain handler that fails takes down the frame.
  Wrap the drain loop in a guard that catches, records, and disables the offending
  handler for the remainder of the leg rather than letting an exception escape.
- **Handlers must be cheap and allocation-free in the common path.** The whole
  routing stage has 0.4 ms.

`route(e)` is called **only by `FrameEventQueue.drain`, never directly**, so that
coalescing always applies. Enforce it with a private constructor token or a
runtime guard in dev builds.

### 3. `src/world/FrameEventQueue.ts`

Architecture 3.4. A frame may contain up to five ticks, and a single tick on the
Drowned Reach can emit several hundred `memory.access` events. Delivering all of
them individually is both slow and visually useless, because five hundred
simultaneous flashes read as one flash.

The queue accumulates during the fixed-step loop and applies a **per-type
coalescing rule** when drained. Implement the rule table from architecture 3.4 in
full. The three shapes it uses:

- **Pass through.** Rare, meaningful events. `process.exited`,
  `deadlock.detected`, `kernel.panic`.
- **Coalesce by key.** Repeated events on the same subject collapse to the last
  one, or to a count. `memory.access` on the same page, `disk.seek` on the same
  head.
- **Aggregate to a rate.** High-frequency events become one summary spawn whose
  `intensity` encodes the count. `memory.page_fault`, `syscall.invoked`.

The 500-page-fault worked example in architecture 3.7 is the acceptance case:
work through it and make your implementation produce the numbers it gives.

`drain` runs the consumers in a **fixed order: world, then audio, then codex,
then HUD counters**. Order matters because the world computes 3D positions that
audio uses for panning, and the codex asks the world whether the pathology is
currently on screen before it offers an entry. This package implements the world
consumer; WP-16 and WP-17 register theirs against the same queue.

### 4. `src/world/effects/EffectPool.ts`

Architecture 3.6. **Five hundred page faults in one tick must not allocate five
hundred objects.** The pool is preallocated at stage build time, sized by quality
tier, and **never grows**.

Copy the `EffectPool` structure printed in architecture 3.6: a fixed `items`
array, a `free` index stack, a `nextId` counter, a `liveCount`, and a ring of
live indices in spawn order so `recycle_oldest` is O(1).

Three overflow policies, and each effect kind declares which one it uses:

- `recycle_oldest`: recycle the oldest live effect. Correct for continuous
  phenomena.
- `aggregate`: drop the new spawn and raise the intensity of the newest live one.
- `drop`: drop silently. Correct for purely decorative effects.

**Effects capture values, never references** (architecture 3.5). An effect stores
a world-space `Vector3` **copied**, a colour, a numeric pid for the label, and
nothing that can be mutated or freed underneath it. An effect that needs to
follow a moving object stores an `AnchorId` and resolves it every frame,
tolerating `null`.

An effect must survive the end of the tick, the end of the frame, **the death of
the process that caused it**, and a policy change that removes the structure it
was attached to. Write a test for each of those four.

**Effects age on wall time inside `variableUpdate`, so `timeScale` does not
compress them.** At `timeScale = 3` more effects are alive at once, which is
precisely why the pool has to be bounded.

`EffectRegistry` maps each `EffectKind` to its instanced batch, its capacity per
tier, and its overflow policy, and is exported from the world barrel.

### 5. `src/world/AnimationBudget.ts`

Visual bible 8.7's three rules, plus the per-tier ceilings from 13.1: concurrent
derezz (2 / 6 / 16), concurrent beams (16 / 32 / 64), animated elements
(48 / 160 / 400).

**An event's visual treatment is never silently dropped** (visual bible 13.2 item
7). Over budget, treatments **aggregate** rather than disappear: ten
`syscall.invoked` glyphs become one rate counter on the kernel structure, which is
exactly what Appendix A's `syscall.invoked` row already specifies. Make the
aggregation visible in the budget's own diagnostics so a leg author can see what
was collapsed.

### 6. The ten domain classes

One per kernel subsystem, each implementing the rows of visual bible Appendix A
that belong to it. **Every row is mandatory at every quality tier.**

| Domain | Events it handles |
|---|---|
| `ProcessVisuals` | `process.created`, `process.state_changed`, `process.exited`, `process.reaped`, `process.starving`, `thread.created`, `thread.joined` |
| `SchedulerVisuals` | `context.switch`, `quantum.expired` |
| `MemoryVisuals` | `memory.access`, `memory.page_fault`, `memory.page_loaded`, `memory.page_evicted`, `memory.allocated`, `memory.allocation_failed`, `memory.thrashing`, `tlb.miss` |
| `SyncVisuals` | `sync.acquired`, `sync.blocked`, `sync.released`, `sync.race_detected`, `sync.busy_wait` |
| `DeadlockVisuals` | `resource.requested`, `resource.granted`, `resource.denied`, `bankers.evaluated`, `deadlock.detected`, `deadlock.resolved` |
| `StorageVisuals` | `disk.queued`, `disk.seek`, `disk.served`, `raid.rebuild` |
| `IoVisuals` | `io.request`, `io.interrupt`, `io.dma_transfer`, `io.poll_wasted` |
| `FsVisuals` | `fs.block_allocated`, `fs.fragmented`, `fs.journal`, `fs.corruption`, `fs.recovered` |
| `SecurityVisuals` | `security.access_denied`, `security.escalation_attempt` |
| `SystemVisuals` | `syscall.invoked`, `kernel.panic` |

A handler's job is to translate a semantic event into an `EffectSpawn` plus at
most a few instance-attribute writes. **It does not build geometry.** Named
structures do not exist yet; a handler that needs one resolves it through
`StructureRegistry` and tolerates `null`, so this package's tests can run against
the probe scene.

Four rows deserve extra care because they encode a teaching point in the visuals:

- **`tlb.miss`.** The amber beam runs stele to TLB to page table to frame over
  180 ms; a hit skips straight to the frame in 40 ms. **The difference in path
  length is the lesson.** Draw the full path, not a flash.
- **`memory.allocation_failed`.** Every free hole lights in `frame_free` cyan with
  its size labelled, and an amber bar the length of the request floats above.
  `reason: 'fragmentation'` **additionally draws a summed length bar** so the
  player can compare total free space against the request.
- **`sync.race_detected`.** Two overlapping ghost copies of the participating
  stele at 45 percent opacity, executing the `RaceCondition.interleaving` steps as
  world-space labels along the span, converging on a readout showing
  `corruptedValue` in amber beside `expectedValue` in cyan.
- **`bankers.evaluated`.** The matrix structure lights row by row following
  `SafetyCheckResult.trace`, one step per 220 ms, with each
  `SafetyTraceStep.explanation` as a world-space label. Safe finishes with the
  whole matrix at `active` cyan; unsafe ends with the work vector held and the
  remaining rows flashing amber.

`kernel.panic` calls `chain.panic(message)` from WP-12, per visual bible 4.6.

Colours come from `@design/tokens` only. A handler that writes a hex literal
fails WP-12's source scan.

### 7. The derezz effect

Visual bible section 9. **It fires on every `process.exited` without exception**,
and its scale, duration and staging depend on whether the exiting process is a
named convoy Program (`convoyMemberId !== null`).

**`fracture(source, cell, rng)`**, visual bible 9.1. Voxelise a source mesh into
cubes of edge `cell`, deterministically. Each cube contributes 36 vertices
carrying `position`, `aCentroid`, `aRandom`, `aSeed` and `aSurface`. Interior
cubes emerge lit, which is what makes the fracture read as revealing an interior
rather than shedding a skin.

**Determinism matters**: this runs at stage build using the leg's `Rng` fork, so
a replayed run produces an identical derezz, which is a hard requirement of the
determinism contract.

Cell sizes: 0.06 m for a convoy Program stele (about 3,600 cubes), 0.12 m for an
anonymous process (about 900), 0.12 m for a leg-8 hex tile, 0.20 m for anything
larger than 4 m in any dimension. Cube counts are capped by tier at 600 / 1,800 /
4,096; above the cap, `cell` scales up until the count fits. **The effect reads
correctly at 600 cubes**, just coarser.

**The timing curve**, visual bible 9.4. For a named convoy Program, total 1400 ms
plus staging, in seven windows:

| Window | What |
|---|---|
| -400 to 0 ms | Pre-roll. The focus camera engages the dying stele automatically (`engaging`, 400 ms rather than 520). Time scale drops to 0.35. Everything outside the focus set dims to 0.12. Audio drops to the low bed. |
| 0 to 170 ms | Fracture front propagates from `uOrigin`. Cubes separate by 6 mm. Emissive climbs from `active` toward `critical`. |
| 120 to 250 ms | The spike. Peak emission at `critical`. The bloom flare is clamped at 12.0 by the bright pass so it does not white out the frame. |
| 170 to 900 ms | Scatter. Dispersion 1.8 m, gravity 2.4 m/s² (deliberately low, so the cubes hang), spin 2.4 rad. |
| 500 to 1400 ms | Fade. Cubes shrink and alpha ramps out with the per-cube stagger. |
| 1400 to 3400 ms | **The mote.** A single 0.08 m cube remains, at the stele's centre height, at `hot` gain, absolutely still. This is the Program's identity, and it is the beat that makes the death land. |
| 3400 to 3900 ms | The mote falls, hits the floor, and goes out. The floor's light pool under it fades over 500 ms. |
| 3900 ms | The tombstone rises: a 1.2 m slab, `SLATE.outline` body, carrying `Epitaph.inscription` in the display face and `Epitaph.cause` in the mono face beneath it, with a link glyph to `Epitaph.codexEntry`. The focus camera releases 800 ms later. |

For an **anonymous** process, total 520 ms: no pre-roll, no camera change, no
time-scale change, no mote, no tombstone. Dispersion 0.6 m, gravity 6.0 m/s²,
spread 0.35.

**The ten reason variants**, visual bible 9.5. Same shader, different uniforms and
one extra beat each. The player should be able to name the cause from the
animation before reading the tombstone. Implement all ten from the table:
`normal_exit`, `killed_by_user`, `killed_by_parent`, `starvation`,
`deadlock_victim`, `out_of_memory`, `thrashing_collapse`, `protection_fault`,
`io_timeout`, `storage_corruption`. Four are worth naming here because they are
easy to get wrong:

- `starvation`: colour drains to `SLATE.dead` over 600 ms **before** the fracture,
  dispersion 0.2, gravity 9.8, origin base, **no spike**, because emission has
  already gone. Cubes fall rather than scatter.
- `deadlock_victim`: the cubes **freeze mid-flight for 200 ms at t = 0.45**,
  holding perfectly still, then drop. The freeze is the visual of "nothing can
  proceed".
- `out_of_memory`: `uCollapse = -1`, gravity 0. Cubes collapse inward, compress to
  a point over 300 ms, and vanish with no scatter.
- `protection_fault`: the fracture front is a **plane**, not a noise field:
  `delay = clamp(dot(aCentroid - uOrigin, uPlaneNormal) * 1.6, 0, 1) * uSpread`.
  Clean, surgical, along one axis.

**Batching**, visual bible 9.6. `DerezzPool` holds one `InstancedMesh` per cell
size, with per-instance `uOrigin`, `uTime`, `uBase`, `uHot` and `uDispersion` as
instanced attributes rather than uniforms. **Up to 16 simultaneous anonymous
derezzes cost one draw call.** A convoy Program's derezz always gets its own mesh,
because its cube count and its staging justify it.

The vertex and fragment shaders are printed in visual bible 9.2 and 9.3. Copy
them; do not paraphrase.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `WorldEventRouter.route` has one case per member of `KernelEvent['type']` and
   the `default` arm calls `assertNever`. Verified by a test that enumerates the
   union at runtime and asserts every type routes to a domain method.
5. Deleting any case from the switch produces a compile error. Verified by a
   `// @ts-expect-error` fixture in the test file that omits one case.
6. Every row of visual bible Appendix A has a corresponding domain handler that
   produces at least one observable change: an `EffectSpawn`, an instance write,
   or a post-chain call. Asserted row by row, 48 cases.
7. Handlers never throw: a domain method injected to throw disables that consumer
   for the leg and the frame still completes.
8. Routing 500 `memory.access` events costs under 0.4 ms, measured in the test.
9. Routing allocates zero objects in the common path over 10,000 events, verified
   with a counting proxy.
10. The 500-page-fault worked example of architecture 3.7 produces exactly the
    spawn counts and intensities that section states.
11. `FrameEventQueue` coalesces per the architecture 3.4 rule table: one case per
    rule, asserted against the documented output.
12. `route` called directly rather than through `drain` throws in a dev build.
13. `EffectPool` never allocates after construction: 100,000 spawns at capacity
    1,000 allocate zero new objects.
14. Each of the three overflow policies behaves as documented, asserted
    separately.
15. An effect survives the death of the process that caused it, the end of its
    tick, the end of its frame, and the removal of the structure it was attached
    to. Four separate cases.
16. An effect with a `follow` anchor that resolves to `null` continues to age and
    does not throw.
17. Effects age on wall time: at `timeScale = 3`, an effect with
    `lifetimeSeconds: 1` still lives 1 wall second, and the live count rises.
18. `fracture` is deterministic: the same source, cell and seeded `Rng` produce a
    byte-identical `BufferGeometry` across 10 runs.
19. Cube counts respect the tier caps 600 / 1,800 / 4,096, and `cell` scales up
    rather than the count being truncated.
20. All ten `TerminationReason` variants produce distinct uniform sets, asserted
    field by field against the visual bible 9.5 table.
21. A convoy Program's derezz fires every beat of visual bible 9.4 at every
    quality tier, including the pre-roll, the spike, the mote and the tombstone.
    Asserted at low, medium and high.
22. An anonymous derezz totals 520 ms with no pre-roll, no mote and no tombstone.
23. 16 simultaneous anonymous derezzes cost exactly 1 draw call; a convoy derezz
    adds exactly 1 more.
24. The animation budget aggregates rather than drops: over the concurrent-beam
    ceiling, the count of visible treatments stops rising but no event type
    disappears from the diagnostics.
25. No file under `src/world/` or `src/render/derezz/` contains a hex colour
    literal.
26. Nothing under `src/world/` imports a value from `src/kernel/` or `src/game/`.
27. `kernel.panic` reaches `chain.panic` and produces the visual bible 4.6
    sequence.

## Tests you must write

### `tests/world/router.test.ts`

| Case | Assertion |
|---|---|
| `exhaustive` | per acceptance criterion 4 |
| `missing case fails compile` | per acceptance criterion 5 |
| `narrowed types` | each handler's parameter type is `KernelEventOf<'...'>`, asserted by a type-level test |
| `no throw` | per acceptance criterion 7 |
| `consumer disabled` | the failing consumer is named in the recorded failures and is skipped on subsequent frames |
| `routing cost` | per acceptance criterion 8 |
| `no allocation` | per acceptance criterion 9 |
| `direct call guarded` | per acceptance criterion 12 |
| `appendix a coverage` | per acceptance criterion 6, one case per row |

### `tests/world/frameEventQueue.test.ts`

| Case | Assertion |
|---|---|
| `pass through` | `process.exited`, `deadlock.detected` and `kernel.panic` are never coalesced |
| `coalesce by key` | 40 `memory.access` events on the same page produce one treatment carrying the count |
| `aggregate to rate` | 200 `syscall.invoked` events produce one rate spawn whose intensity encodes 200 |
| `worked example` | per acceptance criterion 10 |
| `five ticks per frame` | a frame accumulating five steps drains all of them in one pass |
| `consumer order` | the drain calls world, then audio, then codex, then HUD counters, asserted with probes |
| `lastFrame unused` | the queue never reads `Kernel.events.lastFrame` |

### `tests/world/effectPool.test.ts`

| Case | Assertion |
|---|---|
| `no allocation` | per acceptance criterion 13 |
| `recycle_oldest` | at capacity, the oldest live effect's slot is reused and its id changes |
| `aggregate` | at capacity, the newest live effect's intensity rises and no slot changes |
| `drop` | at capacity, the spawn returns null and nothing changes |
| `survives process death` | per acceptance criterion 15 |
| `survives structure removal` | per acceptance criterion 15 |
| `null anchor` | per acceptance criterion 16 |
| `values not references` | mutating the `Vector3` passed to `spawn` does not change the live effect |
| `wall time ageing` | per acceptance criterion 17 |
| `capacity by tier` | the pool is sized from the quality profile and never grows |

### `tests/world/domains.test.ts`

| Case | Assertion |
|---|---|
| `tlb path length` | a miss draws a four-node path over 180 ms and a hit a two-node path over 40 ms |
| `allocation_failed bars` | `reason: 'fragmentation'` draws the summed length bar and `'no_space'` does not |
| `race ghosts` | `sync.race_detected` produces two ghost copies at 45 percent opacity and renders every line of `interleaving` |
| `race readout` | `corruptedValue` renders in amber and `expectedValue` in cyan |
| `bankers rows` | `bankers.evaluated` lights one row per `SafetyTraceStep` at 220 ms intervals and renders each `explanation` |
| `bankers unsafe` | an unsafe result holds the work vector and flashes the remaining rows amber |
| `deadlock edges` | every edge in `report.cycle` goes `denied` amber at `critical` simultaneously, and the four Coffman labels attach to the edges that demonstrate them |
| `escalation blocked false` | `blocked: false` opens the lattice silently over 400 ms with no flash and raises a fatal HUD alert |
| `panic` | per acceptance criterion 27 |
| `no colour literals` | per acceptance criterion 25 |
| `boundaries` | per acceptance criterion 26 |
| `structure null tolerated` | every handler runs against the probe scene where no named structure exists, and none throws |

### `tests/render/derezz.test.ts`

| Case | Assertion |
|---|---|
| `deterministic fracture` | per acceptance criterion 18 |
| `attributes` | each cube contributes 36 vertices carrying `position`, `aCentroid`, `aRandom`, `aSeed`, `aSurface` |
| `interior lit` | interior cubes carry `aSurface === 0` and emerge lit |
| `cell sizes` | 0.06 for a convoy stele, 0.12 for an anonymous process and a hex tile, 0.20 above 4 m |
| `tier caps` | per acceptance criterion 19 |
| `convoy timing` | per acceptance criterion 21, asserting each of the seven windows' start and end |
| `anonymous timing` | per acceptance criterion 22 |
| `ten variants` | per acceptance criterion 20 |
| `starvation no spike` | the `starvation` variant emits no emission spike and the colour drain completes before the fracture starts |
| `deadlock freeze` | the `deadlock_victim` variant holds every cube position constant for 200 ms starting at `t = 0.45` |
| `oom collapse` | the `out_of_memory` variant moves cubes inward and reaches zero extent at 300 ms |
| `protection plane` | the `protection_fault` variant's delay is a linear function of the dot product with the plane normal, asserted over 200 cubes |
| `batching` | per acceptance criterion 23 |
| `fires on every exit` | 200 `process.exited` events produce 200 derezzes with none dropped |

## Out of scope

- Every named diegetic structure. WP-13 registered them as throwing factories and
  they stay that way until phase 2. Handlers resolve them and tolerate `null`.
- `src/render/materials/`, `src/render/post/`, `src/design/`, `src/platform/`.
  WP-12 owns them.
- `src/render/camera/`, `src/world/contracts.ts`, `src/world/forms/`,
  `src/world/instancing/`, `src/world/structures/base/`. WP-13 owns them.
- The audio, codex and HUD consumers. WP-16 and WP-17 register them against the
  same `FrameEventQueue`; this package defines the fixed order and implements the
  world consumer only.
- `src/kernel/`, `src/game/`, `src/ui/`, `src/terminal/`, `src/audio/`,
  `src/legs/`.

## Report back

State:

1. Pass or fail for each of the twenty-seven acceptance criteria, by number.
2. The three verification command outcomes.
3. Whether the existing `WorldEventRouter.ts` switch was complete against the
   frozen union, and any variant it was missing.
4. The measured routing cost in milliseconds for 500 events, against the 0.4 ms
   budget.
5. The spawn counts and intensities your implementation produced for the
   500-page-fault worked example, next to the architecture 3.7 figures.
6. The per-tier cube counts your `fracture` produced for a convoy stele at cell
   0.06, and the cell size it scaled to at low tier.
7. Every Three.js API you checked against `node_modules` before using.
8. Every `// TODO(astra):` left in the tree, with file and line.
