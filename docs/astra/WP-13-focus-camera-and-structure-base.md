# WP-13: The focus camera and the diegetic structure base classes

## Objective

When this package is done the game has the system that makes a 3D-only interface
readable: one perspective camera whose projection blends smoothly into
orthographic, arcing to a head-on framing of any registered structure, dimming
everything outside the focus set, and rotating labels to the reading plane. It
also has the base classes every diegetic structure inherits, the shared geometry
generators, and the instanced-batch and slot-allocation machinery those structures
use. Leg packages build named structures on top of this; none of the named
structures ship here.

## Prerequisites

WP-12 complete and green.

Files that must already exist:

- `src/design/tokens.ts`, `motion.ts`, `typography.ts`
- `src/platform/quality.ts` with `QualityTier` and `PROFILES`
- `src/render/backend/RendererBackend.ts` with `InstancedBatchDesc` and
  `InstancedBatchHandle`
- `src/render/materials/index.ts` with the seven archetypes and the three light
  constructors
- `src/render/index.ts` with `createProbeScene()`

**`src/render/camera/FocusCamera.ts` already exists as a substantially complete
reference implementation.** Read it in full before writing anything. Your job is
to verify it against visual bible section 6, complete what is missing, and report
every difference. Do not rewrite it from scratch; a rewrite loses the parts that
are already correct and gives the reviewer nothing to compare.

## Required reading

- `03-VISUAL-BIBLE.md` section 6 in full: 6.1 (the four modes in order), 6.2 (the
  interface), 6.3 (one camera, blended projection), 6.4 (the transition maths:
  framing, easing, position path, rotation, projection), 6.5 (dimming outside the
  focus), 6.6 (labels and the focus plane), 6.7 (why this keeps dense information
  readable)
- `03-VISUAL-BIBLE.md` section 5 in full: 5.1 (the geometry vocabulary), 5.2 (the
  process stele), 5.3 (grid floor construction), 5.4 (horizon and skybox in a
  black void), 5.5 (edge lighting on hard-surface geometry), 5.6 (communicating
  scale without atmosphere)
- `03-VISUAL-BIBLE.md` section 7.3 (screen space against world space) and 7.4
  (text and bloom)
- `03-VISUAL-BIBLE.md` section 12.2 (instancing and the per-instance layout) and
  12.5 (geometry and memory)
- `01-ARCHITECTURE.md` section 5.6 (scene graph organisation) and 7.3
  (instance-count ceilings)
- `01-ARCHITECTURE.md` section 3.8 (what the world reads that is not an event)
- `01-ARCHITECTURE.md` section 13.4 (adding a new world structure)

## Files you will create or complete

```
src/render/camera/FocusCamera.ts     (exists; verify and complete)
src/render/camera/TravelCamera.ts
src/render/camera/projection.ts
src/render/camera/easing.ts
src/world/contracts.ts
src/world/StageBuilder.ts
src/world/interpolation.ts
src/world/scratch.ts
src/world/structures/base/Structure.ts
src/world/structures/base/InstancedStructure.ts
src/world/structures/base/StructureRegistry.ts
src/world/instancing/InstancedBatch.ts
src/world/instancing/SlotAllocator.ts
src/world/instancing/assertCeiling.ts
src/world/forms/stele.ts
src/world/forms/slab.ts
src/world/forms/ring.ts
src/world/forms/beam.ts
src/world/forms/hexTile.ts
src/world/forms/gridFloor.ts
src/world/forms/index.ts
src/world/labels/SdfAtlas.ts
src/world/labels/Billboard.ts
src/world/index.ts
tests/render/focusCamera.test.ts
tests/render/projection.test.ts
tests/world/structures.test.ts
tests/world/instancing.test.ts
tests/world/forms.test.ts
```

## Files you may modify

```
src/render/index.ts     (export the camera types; nothing else)
```

Nothing else. `src/kernel/`, `src/game/`, `src/design/` and `src/platform/` are
off limits.

## Frozen contracts

From `03-VISUAL-BIBLE.md` section 6.2. This interface is the contract every leg's
`createStage` and every interaction anchor depends on, so treat it as frozen from
the moment this package lands.

```ts
export type FocusMode = 'free' | 'engaging' | 'locked' | 'releasing';

export interface FocusTarget {
  readonly id: string;
  /** The object whose transform defines the reading plane. */
  readonly anchor: Object3D;
  /** Outward normal of the reading plane, in the anchor's local space. */
  readonly planeNormal: Vector3;
  /** Which way is up on the reading plane, in the anchor's local space. */
  readonly planeUp: Vector3;
  /** World-space size of the region to frame, on the plane's axes. */
  readonly extents: Vector2;
  /** Extra framing margin as a fraction of extents. 0.12 default. */
  readonly padding: number;
  /** Objects that stay at full brightness during the lock. */
  readonly focusSet: readonly Object3D[];
  /** How far everything outside the focus set is pushed down. 0.82 default. */
  readonly dimOthers: number;
  readonly labelPlane: 'billboard-to-focus' | 'billboard-to-camera';
  /** Minimum world height a glyph must subtend, in metres, at the framed distance. */
  readonly minGlyphHeight: number;
}

export interface CameraPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  /** Perspective vertical FOV in radians. Ignored when orthoBlend is 1. */
  readonly fov: number;
  /** Orthographic frustum height in world units at the focus plane. */
  readonly orthoHeight: number;
}

export interface FocusCameraState {
  readonly mode: FocusMode;
  readonly target: FocusTarget | null;
  /** Raw transition progress, 0..1, linear in time. */
  readonly t: number;
  /** Eased progress. This is what every consumer reads. */
  readonly blend: number;
  readonly from: CameraPose;
  readonly to: CameraPose;
  readonly durationMs: number;
}

export interface FocusCamera {
  readonly camera: PerspectiveCamera;   // one camera, always
  readonly state: FocusCameraState;
  register(target: FocusTarget): void;
  unregister(id: string): void;
  engage(id: string): boolean;
  release(): void;
  /** Called once per frame before rendering. */
  update(dtSeconds: number): void;
  /** 1 for objects in the focus set, lerp(1, 1 - dimOthers, blend) otherwise. */
  focusWeight(o: Object3D): number;
}
```

From `src/game/types.ts`, frozen, and the reason `src/world` exists:

```ts
export interface StageContext {
  readonly quality: 'low' | 'medium' | 'high';
  readonly run: RunState;
}

export interface LegStage {
  /** Called once per rendered frame with interpolated sim time. */
  update(dtSeconds: number, alpha: number): void;
  /** Named anchors interactions and the focus camera can target. */
  anchor(id: string): unknown | null;
  dispose(): void;
}

export interface InteractionDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Which diegetic object in the 3D world exposes this verb. */
  readonly anchor: string;
  readonly cost: Partial<Record<ResourceKind, number>>;
  readonly enabledWhen: (run: RunState) => boolean;
}
```

`InteractionDef.anchor` and `FocusTarget.id` are the same string, and
`LegStage.anchor(id)` returns the object. Wire the three together so a leg author
names an anchor once.

## Specification

### 1. The four modes, in order

Visual bible 6.1.

**Free.** An orbit-and-follow camera trailing the convoy. Perspective, `fov` 46
degrees, `near` 0.1, `far` 2000. Pitch clamped to `[-8, 62]` degrees, distance
`[6, 90]` metres. It damps toward its target with a **critically damped spring at
`omega = 9.0`**, so it never overshoots and never feels loose.

**Engaging.** The player targets a diegetic anchor and presses the focus key, or
clicks it. Over **520 ms** the camera arcs to a pose square-on to the anchor's
reading plane, its projection blends from perspective to orthographic, everything
outside the focus set dims, labels rotate to the plane, and the vignette tightens.

**Locked.** Orthographic, square-on, with the structure framed to fill **78
percent** of the smaller viewport axis. **The simulation keeps running.** Beams
still flow, states still change, and the player can act. Limited input is
allowed: pan within the plane (clamped so the structure never leaves frame), zoom
between 0.6x and 1.6x of the framing, and a cursor for selecting sub-elements.
**Rotation is disabled, which is the point.**

**Releasing.** **380 ms** back to the free camera's current target pose, which has
been tracking the convoy the whole time, so the release lands where the player
expects.

### 2. One camera, blended projection

Visual bible 6.3. **There is exactly one `PerspectiveCamera` in the scene.**
Swapping to an `OrthographicCamera` at the end of the transition produces a
visible pop, because the two projections disagree everywhere except at one depth.
Instead, both projection matrices are built each frame and blended element-wise
into the single camera's `projectionMatrix`.

The blend is artefact-free at the focus plane because the orthographic frustum
height is chosen so the two projections agree exactly there: `orthoHeight = 2 * d
* tan(fov / 2)` where `d` is the distance from the camera to the reading plane.
Off the plane the lerp is a smooth morph, which is what reads as the world
flattening out.

Implement `blendProjection(cam, aspect, fov, focusDistance, near, far, blend)` in
`projection.ts`. It must not allocate: keep the two `Matrix4` scratch objects at
module scope, as the visual bible does.

### 3. The transition maths

Visual bible 6.4. Four parts, each printed there in full. Copy them.

**Framing.** `computeLockedPose(t, aspect, fov)`. Frame the larger of the two
constraints, width against aspect or height, with `pad = 1 + t.padding`, and
divide by 0.78 so the structure fills 78 percent of the frame. Stand off far
enough that the perspective start pose is not inside the structure and near-plane
clipping cannot occur during the arc.

**Easing.** `cubicBezier(x1, y1, x2, y2)` solved by Newton-Raphson with a
bisection fallback; 8 iterations is exact to about 1e-6. Two curves, deliberately
asymmetric: `focusIn` is `cubicBezier(0.16, 0.84, 0.24, 1.00)`, leaving quickly
and arriving slowly, and `focusOut` is `cubicBezier(0.40, 0.00, 0.20, 1.00)`,
shorter and flatter, because letting go should not feel as considered as
committing. `FOCUS_DURATION_MS` is `{ engage: 520, release: 380 }`.

If `src/design/motion.ts` from WP-12 already exports `EASE`, **import it rather
than redeclaring it**, and report the duplication if both exist.

**Position path.** A straight lerp dollies the camera through whatever is between
the two poses. Use the cubic Bezier arc printed in 6.4, whose control points push
out along each pose's own forward axis at `k = distance * 0.40` and lift over
intervening geometry, with
`lift = max(2, targetTopY - min(from.y, to.y)) * 0.35`.

**Rotation.** Quaternion slerp on a leading schedule:
`slerp(from.q, to.q, ease(min(1, t * 1.12)))`. **Rotation completing 12 percent
ahead of position** means the target is centred before the camera stops moving,
which removes the sensation of the frame settling twice.

**Projection.** FOV is held constant at 46 degrees through the whole transition;
the flattening comes entirely from the projection blend.

### 4. Dimming outside the focus

Visual bible 6.5. **Depth of field is not the primary mechanism.** Blurring
emissive hairlines against black turns them into soft smears, which contradicts
the hard-edge principle and costs a pass. The primary mechanism is per-object
attenuation:

```ts
focusWeight(o: Object3D): number {
  if (this.state.mode === 'free') return 1;
  const inSet = this.focusSetIds.has(o.id) || this.isDescendantOfFocus(o);
  if (inSet) return 1;
  const target = 1 - (this.state.target?.dimOthers ?? 0.82);   // 0.18
  return 1 + (target - 1) * this.state.blend;
}
```

`uFocusWeight` is a uniform on the line, panel, beam and glass materials, updated
**once per frame per material** rather than per object, because materials are
shared and objects are grouped by focus membership.

Unfocused emission drops to 18 percent of its gain, which puts most of it below
the bloom threshold, **so the halos outside the focus disappear too. That
disappearance is what actually clears the frame**; the dimming alone would leave
a field of glow. Matte bodies outside the focus set have their `color` multiplied
by 0.35 through the same uniform, so unfocused structure recedes toward the void
without going fully black.

The anchor's subtree is included in the focus set automatically; cross-references
such as the beams into a wait-for graph are added by the leg through
`FocusTarget.focusSet`.

### 5. Labels and the focus plane

Visual bible 6.6 and 7.3. Labels inside the focus set snap to the reading plane
when `labelPlane` is `'billboard-to-focus'` and to the camera otherwise.

`minGlyphHeight` is the minimum world height a glyph must subtend at the framed
distance. **The framing is expanded if the structure's label density would push
text below it.** That expansion is what keeps a dense page table readable rather
than technically visible.

`SdfAtlas` builds the signed-distance glyph atlas from the loaded fonts. SDF
glyph size is 48 at low tier and 64 at medium and high, and **no glyph is ever
below 13 device pixels at any tier**. World-space text is drawn in the post
chain's pass 13, after tone mapping, so no glyph is bloomed or crushed; this
package supplies the geometry and the layer assignment and WP-12's chain already
renders that layer.

### 6. `src/world/contracts.ts`

The world layer's public shape. Declare, and keep small:

```ts
export interface WorldContext {
  readonly scene: Scene;
  readonly quality: QualityTier;
  readonly focus: FocusCamera;
  readonly materials: MaterialLibrary;
  readonly labels: SdfAtlas;
  readonly time: { readonly elapsedSeconds: number; readonly alpha: number };
  /** Read-only kernel access. The world holds a Pid, never a PCB. */
  readonly kernel: {
    process(pid: Pid): Readonly<ProcessControlBlock> | undefined;
    readonly tick: Tick;
  };
}

export type AnchorId = string;

export interface StructureHandle {
  readonly id: string;
  readonly root: Object3D;
  readonly focusTarget: FocusTarget;
  update(dtSeconds: number, alpha: number): void;
  dispose(): void;
}
```

Two rules from architecture 3.1 that this file enforces by shape:

- **No visual module holds a reference to a `ProcessControlBlock` object.** It
  holds a `Pid` and asks `kernel.process(pid)` when it needs current values. PCBs
  are mutable and reused; a held reference would silently observe future
  mutations.
- **No visual module calls a kernel mutator.** `WorldContext.kernel` exposes two
  read accessors and nothing else.

Import kernel types with `import type` only; the permission matrix allows
`world -> kernel` as type-only.

### 7. The structure base classes

`Structure` is the abstract base every diegetic representation extends. It owns
its root `Object3D`, its `FocusTarget`, its disposal, and the contract that
`update` is called once per rendered frame with the interpolated alpha.

`InstancedStructure` extends it for the common case of a form repeated more than
8 times. It owns an `InstancedBatch`, a `SlotAllocator`, and the per-instance
writes.

`StructureRegistry` maps a structure id to a factory, so `StageBuilder` reads
like a shopping list. **No named structure ships in this package.** Register the
eight names the world barrel will eventually export (`FrameVault`,
`ReadyQueueProcession`, `WaitForRing`, `PlatterStack`, `PageOcean`, `BusSpine`,
`ArchiveShelves`, `DomainRings`) as throwing factories with
`// TODO(astra): phase 2 leg packages implement this structure`, so a leg author
gets a clear error rather than a missing key.

### 8. `src/world/instancing/`

`InstancedBatch` wraps `InstancedBatchHandle` from WP-12 with the per-instance
attribute layout of visual bible 12.2: `colorGain`, `statePhase`, `patternId`,
packed into three `vec4`s. Updating one instance writes 12 floats and sets
`needsUpdate` on the relevant attribute. **It never rebuilds the geometry and
never touches `instanceMatrix` unless the instance actually moved.**

`SlotAllocator` hands out and reclaims instance slots. Reclaimed slots are reused
lowest-index-first, so a batch's occupied range stays compact and `count` can be
set to the high-water mark rather than the capacity.

`assertCeiling` checks the instance-count ceilings of architecture 7.3 per tier
and throws in dev builds.

### 9. `src/world/forms/`

The shared geometry generators from visual bible 5.1. **Every generator returns a
shared, cached `BufferGeometry`**; two stele in the same leg reference the same
geometry object.

Per-form triangle budgets, visual bible 12.5, asserted by test:

| Form | Triangles |
|---|---|
| stele | 96 |
| page plate (slab) | 12 |
| hex tile | 20 |
| block | 12 |
| resource ring | 96 to 384, tier-dependent |
| platter | 128 to 512 |
| bollard | 64 |

`gridFloor` implements visual bible 5.3 exactly, including the module. **Scale is
asserted by repetition at a known module**, and that module is 4.00 metres. Minor
grid lines are off beyond 30 metres at low tier.

The horizon is **drawn as a line, not a gradient** (visual bible 5.4), in
`VOID.horizon`.

Edge lighting on hard-surface geometry follows visual bible 5.5; the emissive
line material carries it and this package supplies the edge geometry.

Geometry is disposed in `dispose()` and a leak test asserts that
`renderer.info.memory.geometries` returns to its baseline after a structure is
torn down.

### 10. `src/world/interpolation.ts` and `scratch.ts`

`interpolation.ts` provides the alpha-lerp helpers structures use in `update`.
Alpha is the fraction between the last simulation step and the next, per
architecture 2.5; it is never used to advance simulation state.

`scratch.ts` holds module-scope reusable `Vector3`, `Quaternion`, `Matrix4` and
`Color` objects. **The frame allocation policy of architecture 7.4 is zero
allocations in the per-frame path.** Every structure imports its scratch from
here rather than declaring its own, so the count is auditable.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. There is exactly one `PerspectiveCamera` construction in `src/render/camera/`
   and zero `OrthographicCamera` constructions anywhere under `src/`.
5. At `blend === 1`, a point on the focus plane projects to the same screen
   coordinate under the blended matrix as under a true orthographic matrix built
   with the same `orthoHeight`, to within 1e-6.
6. At `blend === 0`, the blended matrix equals the pure perspective matrix
   element-wise to within 1e-9.
7. Across `blend` from 0 to 1 in 100 steps, a point on the focus plane never
   moves more than 0.5 device pixels at 1440x900.
8. `computeLockedPose` frames the structure to 78 percent of the smaller viewport
   axis, asserted for 20 combinations of extents and aspect ratio.
9. `EASE.focusIn(0) === 0`, `EASE.focusIn(1) === 1`, and the curve is monotonic
   across 1000 samples. The same for `focusOut`.
10. `cubicBezier` matches a reference CSS cubic-bezier implementation to within
    1e-6 across 1000 samples of four different curves.
11. Engage takes 520 ms and release takes 380 ms, asserted by stepping `update`
    with a fixed dt.
12. Rotation completes at `t === 1 / 1.12`, which is 12 percent ahead of position,
    asserted by comparing the quaternion against the target before position
    arrives.
13. `focusWeight` returns 1 in `free` mode for every object, 1 for objects in the
    focus set at any blend, and `1 + (0.18 - 1) * blend` for objects outside it.
14. The anchor's subtree is in the focus set automatically, asserted three levels
    deep.
15. `uFocusWeight` is written once per frame per material, not once per object.
    Asserted with a counting proxy over a scene of 400 objects sharing 3
    materials.
16. Rotation input is rejected in `locked` mode; pan is clamped so the structure's
    bounding box never leaves the frame; zoom is clamped to `[0.6, 1.6]`.
17. The simulation is not paused during a lock: `update` is called and the
    kernel's tick advances normally in an integration test.
18. `minGlyphHeight` expansion works: a target whose label density would push text
    below the minimum gets a larger `orthoHeight`, asserted with two densities.
19. No glyph renders below 13 device pixels at any tier, asserted for the probe
    scene at 1440x900.
20. Every form generator returns a cached geometry: 100 calls give 1 object.
21. Every form is within its triangle budget from visual bible 12.5.
22. `renderer.info.memory.geometries` returns to baseline after every structure in
    a test scene is disposed.
23. Rendering 300 frames of a 400-instance test structure allocates zero new
    `Vector3`, `Quaternion`, `Matrix4` or `Color`, verified with a counting proxy.
24. `SlotAllocator` reuses reclaimed slots lowest-index-first, asserted over 1000
    allocate and free operations.
25. `assertCeiling` throws in a dev build when a tier's instance ceiling is
    exceeded.
26. Nothing under `src/world/` imports a value from `src/kernel/` or `src/game/`.
    Type-only imports are permitted. Asserted by a boundary test.
27. `src/render/` does not import from `src/world/` in any direction. Asserted.
28. The eight named structure factories throw with a message naming phase 2.

## Tests you must write

### `tests/render/projection.test.ts`

| Case | Assertion |
|---|---|
| `blend 0` | per acceptance criterion 6 |
| `blend 1` | per acceptance criterion 5 |
| `focus plane stability` | per acceptance criterion 7 |
| `orthoHeight agreement` | `orthoHeight === 2 * d * tan(fov / 2)` for 50 distance and fov pairs |
| `no allocation` | 10,000 `blendProjection` calls allocate zero `Matrix4` |
| `one camera` | per acceptance criterion 4 |

### `tests/render/focusCamera.test.ts`

| Case | Assertion |
|---|---|
| `mode sequence` | `free` to `engaging` to `locked` on engage, and `locked` to `releasing` to `free` on release |
| `durations` | per acceptance criterion 11 |
| `framing` | per acceptance criterion 8 |
| `easing endpoints` | per acceptance criterion 9 |
| `cubicBezier accuracy` | per acceptance criterion 10 |
| `leading rotation` | per acceptance criterion 12 |
| `arc path` | the position path's midpoint is off the straight line between poses by at least `distance * 0.1` |
| `lift` | `lift = max(2, targetTopY - min(from.y, to.y)) * 0.35` for five geometries |
| `focusWeight` | per acceptance criterion 13 |
| `subtree` | per acceptance criterion 14 |
| `uniform writes` | per acceptance criterion 15 |
| `locked input` | per acceptance criterion 16 |
| `sim runs` | per acceptance criterion 17 |
| `fov constant` | fov is 46 degrees at every point of the transition |
| `release lands on tracker` | the free camera keeps tracking during a lock, and release ends at the tracked pose rather than the pose at engage time |
| `engage unknown id` | `engage('nope')` returns false and does not change mode |
| `unregister during lock` | unregistering the locked target releases cleanly rather than throwing |
| `spring` | the free camera's damping is critically damped at `omega = 9.0`: no overshoot across 500 steps of a step input |
| `clamps` | pitch stays within `[-8, 62]` degrees and distance within `[6, 90]` metres under adversarial input |

### `tests/world/structures.test.ts`

| Case | Assertion |
|---|---|
| `handle shape` | every `StructureHandle` exposes `id`, `root`, `focusTarget`, `update`, `dispose` |
| `anchor wiring` | `LegStage.anchor(id)` returns the object whose `FocusTarget.id` is that string, and `InteractionDef.anchor` uses the same string |
| `dispose` | per acceptance criterion 22 |
| `no pcb held` | a source scan finds no field typed `ProcessControlBlock` under `src/world/` |
| `no mutators` | `WorldContext.kernel` exposes exactly `process` and `tick` |
| `registry stubs` | per acceptance criterion 28 |
| `boundaries` | per acceptance criteria 26 and 27 |

### `tests/world/instancing.test.ts`

| Case | Assertion |
|---|---|
| `layout` | the three `vec4` attributes carry the documented twelve floats in the documented order |
| `write cost` | updating one instance writes exactly 12 floats and touches one attribute range |
| `matrix untouched` | a colour-only update does not write `instanceMatrix` |
| `slot reuse` | per acceptance criterion 24 |
| `high water` | `count` tracks the high-water mark rather than the capacity |
| `ceiling` | per acceptance criterion 25 |
| `no per-frame allocation` | per acceptance criterion 23 |

### `tests/world/forms.test.ts`

| Case | Assertion |
|---|---|
| `cached` | per acceptance criterion 20 |
| `triangle budgets` | per acceptance criterion 21, one case per form |
| `grid module` | the grid floor's repetition module is exactly 4.00 metres |
| `grid minor lines` | minor lines are absent beyond 30 metres at low tier and present at medium and high |
| `horizon is a line` | the horizon geometry is a line, not a gradient plane |
| `glyph size` | per acceptance criterion 19 |
| `sdf size by tier` | 48 at low, 64 at medium and high |
| `label plane` | `'billboard-to-focus'` rotates labels to the reading plane and `'billboard-to-camera'` to the camera |
| `minGlyphHeight expansion` | per acceptance criterion 18 |

## Out of scope

- Every named diegetic structure: `FrameVault`, `ReadyQueueProcession`,
  `WaitForRing`, `PlatterStack`, `PageOcean`, `BusSpine`, `ArchiveShelves`,
  `DomainRings`. Register them as throwing factories and stop. Phase 2 leg
  packages implement them.
- `src/world/WorldEventRouter.ts`, `FrameEventQueue.ts`, `domains/` and
  `effects/`. WP-14 owns them.
- The derezz effect and `src/render/derezz/`. WP-14 owns them.
- `src/design/`, `src/platform/`, `src/render/materials/`, `src/render/post/`.
  WP-12 owns them. If one has a bug, report it rather than fixing it, unless the
  bug makes an acceptance criterion here unreachable.
- `src/kernel/`, `src/game/`, `src/ui/`, `src/terminal/`, `src/audio/`,
  `src/legs/`.

## Report back

State:

1. Pass or fail for each of the twenty-eight acceptance criteria, by number.
2. The four verification command outcomes, including the contract guard.
3. What the existing `FocusCamera.ts` already implemented correctly, what was
   missing, and every line you changed. Be specific: this is the main input a
   reviewer has for judging whether the reference implementation was sound.
4. Whether `EASE` was duplicated between `src/design/motion.ts` and the camera
   module, and which one you kept.
5. The measured maximum screen-space drift of a focus-plane point across the
   blend, in device pixels.
6. The per-frame allocation count for the 400-instance test structure.
7. Every Three.js API you checked against `node_modules` before using.
8. Every `// TODO(astra):` left in the tree, with file and line, including the
   eight structure stubs.

## Scope correction 2026-09-15

Written before WP-13 starts, after WP-12 merged as 470b511 (main 8ff60fd).
The package above was written against the scaffold; where this section
disagrees with the text above, this section wins.

- **Verification is four gates.** `npm run check:contracts` precedes
  typecheck, test and build. Three files are frozen now: `src/kernel/types.ts`,
  `src/game/types.ts` and `src/design/tokens.ts`. The guard also enforces a
  zero skip budget, zero em dashes and the IP-term scan; nothing under `src/`
  is on the IP allowlist. Baseline at 8ff60fd: 1229 passed, 0 skipped, 57
  files.
- **Paths are the scaffold's.** The backend interface is
  `src/render/RendererBackend.ts` (not `backend/RendererBackend.ts`); the
  post chain is `src/render/postChain.ts`; the governor is
  `src/platform/qualityGovernor.ts`. `src/render/camera/FocusCamera.ts`
  exists (960 lines) and is verified and completed in place, as the package
  says. `src/world/WorldEventRouter.ts` and `EffectPool.ts` exist as WP-14's
  scaffold and are not yours; the interface the router's line 42 TODO asks to
  move into `src/world/contracts.ts` is yours to define there, and WP-14
  imports it.
- **The instance contract WP-12 shipped.** `InstancedBatchHandle` keeps the
  original `matrices`, `colours` and `state` arrays and adds the three packed
  vec4 attributes `colorGain`, `statePhase` and `patternId` (four floats per
  instance: colour rgb plus gain; state id, phase 0..1, pulse Hz, focus
  weight; dash on, dash off, hatch id, entity id). `touch(from, to, channel?)`
  takes an exclusive end and a `BatchChannel` of `'matrix' | 'colour' |
  'state' | 'colorGain' | 'statePhase' | 'patternId' | 'all'`; touch the
  matrix channel only when an instance moved. Your `InstancedBatch` and
  `SlotAllocator` wrap that handle; they do not reimplement it.
- **Validators are WP-12's, invoking them is yours.** `validateScene(root)`
  (layer membership and the ninth-repeated-mesh rule) and
  `assertTransparencyDepth(layersAtPixel)` live in
  `src/render/DrawCallBudget.ts`; `StageBuilder` calls them at stage
  construction, and the transparency ceiling is a placement discipline your
  forms enforce, not a beam count.
- **Layers** are the architecture 5.6 semantic layers 1 to 8, exported from
  the frozen tokens; the scaffold's 0/1/2 assignment is gone. Read the
  export, do not redefine it.
- **Glass ownership.** High-transmission (derezz-glass) materials are taken
  through `acquireGlass(owner, semantic, tier)` and returned through
  `releaseGlass(owner)` so the eight-object ceiling counts scene owners;
  `getMaterial` alone cannot. Structures that use glass own that lifecycle.
- **Text.** WP-12 owns the `holoLabel` material, the SDF glyph atlas loading
  through troika and `createLabelPlateMaterial()`; the plate is composed
  after tone mapping at 0.92 opacity and the hairline stays in the world
  stage. So `src/world/labels/SdfAtlas.ts` does not build an atlas: it is
  the world-side label placement layer (billboard-to-focus versus
  billboard-to-camera, the 13-device-pixel floor enforced through framing
  expansion, `WorldLabelClass` cap heights). Keep the filename the package
  lists, but its contents are placement, and it imports the atlas from
  `@render`. Report this in item 4 of the report alongside the `EASE`
  question.
- **Motion tokens.** `EASE`, `DUR` and `cubicBezier` are in the frozen
  `src/design/tokens.ts` and re-exported by `src/design/motion.ts`. The
  camera module imports them; it defines no easing table of its own.
  `src/render/camera/easing.ts` may hold camera-specific composition
  (blend curves over `EASE`), never a second table of the same values.
- **Tests run in Node.** `npm test` has no GPU context and the skip budget
  is zero. Projection maths, blend continuity, the screen-space drift bound
  (computed from the projection matrices at device-pixel scale), slot
  allocation, form geometry counts and the 400-instance allocation count
  are all Node assertions. Anything that needs a real context goes in the
  existing `tests/render/gpu/` runner as a `.gpu.ts` file and is reported
  with Kyle's log, as WP-12 did; propose the split in the pre-flight.
- **Shared files.** `src/render/index.ts` for the camera exports only, as the
  package says. `vitest.config.ts` may gain the `tests/world` alias if one is
  needed. `package.json` does not change: no new dependency without a
  pre-flight amendment.
- **Off limits**, unchanged: `src/kernel`, `src/game`, `src/design`,
  `src/platform`, `src/render/materials`, `src/render/post`,
  `src/render/RendererBackend.ts`, `src/render/postChain.ts`, `tests/kernel`,
  `tests/design`, `tests/render/gpu/harness.ts` and `run.mjs`. A WP-12 bug
  that blocks an acceptance criterion is reported, with the line, and
  waits for a grant.

