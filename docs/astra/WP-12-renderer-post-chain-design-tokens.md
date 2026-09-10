# WP-12: Renderer backend, post-processing chain and the design token system

## Objective

When this package is done the repository has a single source of colour, gain,
motion and type in `src/design/`, a capability probe and quality-tier system in
`src/platform/`, a renderer backend that runs WebGPU where available and WebGL2
everywhere else behind one interface, seven cached material archetypes, and the
fourteen-pass post-processing chain that produces the game's look. A throwaway
test scene renders at 60 fps within the documented budget on the target machine.
Everything downstream, the world, the focus camera, the HUD and the terminal,
draws its colours and durations from what you build here.

## Prerequisites

None beyond the scaffold. This is a wave 0 and wave 1 package.

**Some of these files already exist as scaffold and pass tests. Complete and
verify them rather than recreating them.** Read each one first; if it matches the
specification, say so and move on. If it diverges, fix the divergence and report
every line you changed.

Files that may already exist:

- `src/design/tokens.ts`
- `src/render/RendererBackend.ts`
- `src/render/postChain.ts`
- `src/platform/capabilities.ts`
- `src/platform/qualityGovernor.ts`

Where the scaffold's path differs from the path this package names, **keep the
scaffold's path** and note the difference in your report. Do not create a second
file at the other path.

## Required reading

- `03-VISUAL-BIBLE.md` section 2 in full: 2.1 (the void), 2.2 (the two emissive
  families), 2.3 (HDR gains and the amber compensation), 2.4 (semantic tokens),
  2.5 (colour-blind accommodation), 2.6 (contrast ratios for text)
- `03-VISUAL-BIBLE.md` section 3 in full: the seven material archetypes, 3.1
  through 3.7
- `03-VISUAL-BIBLE.md` section 4 in full: 4.1 (the pass order table), 4.2 (cost
  on the target machine), 4.3 (the bright pass), 4.4 (dual-Kawase), 4.5 (the four
  bloom numbers), 4.6 (kernel panic), 4.7 (chromatic aberration, grain,
  vignette), 4.8 (AgX tone mapping and the implementation note), 4.9 (banding and
  dithering)
- `03-VISUAL-BIBLE.md` section 7 (typography) and section 8.1 (motion tokens)
- `03-VISUAL-BIBLE.md` section 12 in full: 12.1 (draw-call budget), 12.2
  (instancing and the per-instance layout), 12.3 (overdraw), 12.4 (dynamic
  lights, the rule that matters most), 12.5 (geometry and memory)
- `03-VISUAL-BIBLE.md` section 13 in full: 13.1 (the tier table), 13.2 (what must
  never degrade)
- `01-ARCHITECTURE.md` section 5.2 (capability detection), 5.3 (the
  `RendererBackend` interface), 5.4 (what degrades on the WebGL2 path), 5.5 (the
  post chain), 5.6 (scene graph organisation)
- `01-ARCHITECTURE.md` section 6.3 (automatic tier selection), 6.4 (runtime
  downgrade), 6.5 (what happens below low)
- `01-ARCHITECTURE.md` section 7.1 (per-frame millisecond budget), 7.2 (memory
  ceiling), 7.3 (instance-count ceilings), 7.4 (allocation policy in the frame)

## Files you will create or complete

```
src/design/tokens.ts              (may exist; complete and verify)
src/design/motion.ts
src/design/typography.ts
src/design/accessibility.ts
src/design/index.ts
src/platform/capabilities.ts      (may exist; complete and verify)
src/platform/quality.ts
src/platform/tierSelect.ts
src/platform/benchmark.ts
src/platform/QualityGovernor.ts   (may exist as qualityGovernor.ts; keep that path)
src/platform/index.ts
src/render/backend/RendererBackend.ts   (may exist at src/render/RendererBackend.ts)
src/render/backend/ThreeUnifiedBackend.ts
src/render/backend/createBackend.ts
src/render/backend/DeviceLossPolicy.ts
src/render/materials/index.ts
src/render/materials/voidSurface.ts
src/render/materials/emissiveLine.ts
src/render/materials/emissivePanel.ts
src/render/materials/volumetricBeam.ts
src/render/materials/derezzGlass.ts
src/render/materials/holoLabel.ts
src/render/materials/reflectiveFloor.ts
src/render/post/chain.ts          (may exist at src/render/postChain.ts)
src/render/post/brightPass.ts
src/render/post/kawase.ts
src/render/post/composite.ts
src/render/post/toneMap.ts
src/render/post/depthOfField.ts
src/render/post/volumetric.ts
src/render/shaders/grid.glsl.ts
src/render/shaders/edge.glsl.ts
src/render/shaders/corruption.glsl.ts
src/render/targets.ts
src/render/DrawCallBudget.ts
src/render/index.ts
tests/design/tokens.test.ts
tests/design/contrast.test.ts
tests/platform/tierSelect.test.ts
tests/render/materials.test.ts
tests/render/postChain.test.ts
tests/render/budget.test.ts
```

## Files you may modify

```
package.json      (add three, @webgpu/types, and the build/typecheck scripts if absent)
tsconfig.json     (add "@webgpu/types" to types; nothing else)
vite.config.ts    (create it if absent; nothing beyond the standard config)
```

Nothing else. `src/kernel/` and `src/game/` are off limits entirely.

## Frozen contracts

`src/design/tokens.ts` becomes a frozen contract at the end of this package.
Nothing else in the repository may contain a colour literal, and every downstream
package reads its colours from here. Design the exports so a consumer never needs
a raw hex.

From `03-VISUAL-BIBLE.md` section 2, the exact values. These are authored as sRGB
hex and converted once, at module load, into linear-space `Color` objects.
`ColorManagement.enabled = true` must be set before this module is imported, or
the conversion silently no-ops.

```ts
export const VOID = {
  base:       0x04060a,
  surface:    0x080b11,
  surfaceLit: 0x0d1219,
  horizon:    0x0a1a24,
  floor:      0x060910,
} as const;

export const CYAN = {
  trace: 0x123844,
  dim:   0x2f8fa8,
  core:  0x5fd7f5,
  hot:   0x9fecff,
  white: 0xd6f7ff,
} as const;

export const AMBER = {
  trace: 0x3b1d04,
  dim:   0x7a3c06,
  core:  0xff9a2e,
  hot:   0xffbe5c,
  white: 0xffe0b0,
} as const;

export const SLATE = {
  dead:      0x1b2026,
  outline:   0x39434d,
  secondary: 0x6b7a88,
  protected: 0x9fb4c4,
  primary:   0xe8f4ff,
} as const;

export const EMISSIVE_GAIN = {
  ambient:  0.45,
  dim:      1.10,
  active:   1.85,
  hot:      3.20,
  critical: 4.60,
} as const;

export const AMBER_GAIN_COMPENSATION = 1.25;

export const gainFor = (family: 'cyan' | 'amber' | 'slate', level: keyof typeof EMISSIVE_GAIN): number =>
  EMISSIVE_GAIN[level] * (family === 'amber' ? AMBER_GAIN_COMPENSATION : 1);
```

From `01-ARCHITECTURE.md` section 5.3, the backend interface. Every field and
method is required:

```ts
export type BackendId = 'webgpu' | 'webgl2';

export interface FrameRequest {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly alpha: number;
  readonly dtSeconds: number;
  readonly elapsedSeconds: number;
}

export interface RenderStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly programs: number;
  readonly textures: number;
  readonly geometries: number;
  readonly gpuMs: number | null;
  readonly targetMemoryBytes: number;
}

export interface InstancedBatchDesc {
  readonly name: string;
  readonly capacity: number;
  readonly geometry: 'slab' | 'chit' | 'sector' | 'beam' | 'mote' | 'ring';
  readonly material: 'structure' | 'queue' | 'sector' | 'beam' | 'particle';
  readonly perInstanceColour: boolean;
  readonly castShadow: boolean;
  readonly layer: number;
}

export interface InstancedBatchHandle {
  readonly name: string;
  readonly capacity: number;
  count: number;
  readonly matrices: Float32Array;   // 16 floats per instance
  readonly colours: Float32Array;    // 3 floats per instance, linear rgb
  readonly state: Float32Array;      // 4 floats: [stateEnum, phase01, intensity, ownerHue]
  touch(from: number, to: number): void;
  dispose(): void;
}

export interface RendererBackend {
  readonly id: BackendId;
  readonly capabilities: RenderCapabilities;
  readonly stats: RenderStats;
  readonly domElement: HTMLCanvasElement;
  init(canvas: HTMLCanvasElement, opts: BackendInitOptions): Promise<void>;
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  setQuality(profile: RenderQualityProfile): void;
  createInstancedBatch(desc: InstancedBatchDesc): InstancedBatchHandle;
  renderFrame(req: FrameRequest): void;
  compileAsync(scene: Scene, camera: Camera): Promise<void>;
  onDeviceLost(cb: (info: { readonly reason: string }) => void): () => void;
  dispose(): void;
}

export interface BackendInitOptions {
  readonly forceWebGL: boolean;
  readonly antialias: boolean;
  readonly samples: 1 | 2 | 4;
  readonly profile: RenderQualityProfile;
}
```

`RenderCapabilities` and `CapabilityProbeResult` are printed in full in
architecture 5.2. Implement them exactly.

## Specification

### 1. Three.js is pinned to 0.185

Add `"three": "0.185.0"` as an exact dependency, plus `@webgpu/types`. **Do not
use a Three API because you remember it.** Node-material and TSL APIs moved
repeatedly across releases, the WebGPU renderer entry point has changed name, and
`EffectComposer` lives under addons. Before writing any Three call you are not
certain of, read `node_modules/three/src/` or `node_modules/three/build/three.d.ts`.

The anti-hallucination rule in the briefing applies hardest in this package.
Report every API you had to check.

### 2. `src/design/tokens.ts`

If the scaffold file exists, verify every value against visual bible 2.1 through
2.4 and report any difference.

Beyond the palette above, export the semantic token table from visual bible 2.4
as data, keyed by semantic name, each carrying hex, family, gain level, and the
shape or pattern channel that duplicates the colour distinction. Every colour
distinction is duplicated in shape or pattern (visual bible 1.4), so a token that
carries only a colour is incomplete.

Corruption is a **failure of colour**, not a third hue: value quantisation,
per-block hue jitter around the base token, and positional displacement.
Implement it as parameters on the existing tokens, per visual bible 2.4.1.

Export the colour-blind accommodation mapping from 2.5, including the monochrome
semantic mapping that `accessibility.ts` consumes.

**This file is the only file in the repository permitted to contain a colour
literal.** Write a test that greps every other file under `src/` for hex colour
patterns and fails on a hit.

### 3. `src/design/motion.ts` and `typography.ts`

`motion.ts` exports `DUR`, `EASE` and `TICK_MS` per visual bible 8.1. Every
duration and easing curve in the game comes from here; a downstream package that
writes `220` inline is a bug.

`typography.ts` exports the font stacks, the type scale and the world-space cap
heights per visual bible 7.1 and 7.2. **Give every face a real fallback stack**,
because the CSP allowlist permits Google Fonts stylesheets and `fonts.gstatic.com`
font files but a network failure must not leave the game unreadable.

`accessibility.ts` exports `VisionSettings` and the monochrome semantic mapping
per visual bible 2.5 and Appendix B.

### 4. `src/platform/`

`capabilities.ts` implements `probeCapabilities()` exactly as architecture 5.2
prints it: device pixel ratio clamped to 2, `prefers-reduced-motion`,
`hardwareConcurrency` defaulting to 4, `deviceMemory` where present, then a
WebGPU adapter request with `powerPreference: 'high-performance'`, falling back
to a WebGL2 probe. Non-fatal problems go into `warnings` and are shown in the
diagnostics panel, never thrown.

`quality.ts` exports `QualityTier = 'low' | 'medium' | 'high'` and `PROFILES`,
one `RenderQualityProfile` per tier, carrying every row of the visual bible 13.1
table: render scale, anti-aliasing, bloom levels and resolution, bloom tint,
depth of field, volumetric scattering, chromatic aberration, film grain, floor
reflection, beam radial segments, beam depth softening, transmissive materials,
derezz cube cap, concurrent derezz, concurrent beams, animated elements, draw
calls, SDF glyph size, distant columns, floor light pools, grid minor lines.

`tierSelect.ts` implements `selectTier` exactly as architecture 6.3 prints it.
The order of evidence is cached choice, then explicit user choice, then
benchmark, then heuristic. The heuristic prior is `webgl2` gives low, integrated
gives medium, otherwise high. A benchmark that throws falls back to the prior and
caches that decision. `CACHE_KEY` is `'kt.tier.v1'` in `localStorage`, which is
one of the only two things `localStorage` is used for.

`QualityGovernor` implements the runtime downgrade of architecture 6.4. The
player can override the detected tier at any time and the change takes effect
**without a reload**.

**Eight things must never degrade** (visual bible 13.2), and each has a test: the
colour tokens, the shape and pattern channels, text legibility at no less than 13
device pixels, the focus camera lock, a convoy Program's derezz beats, bloom
itself with threshold 1.15 and strength 0.055 at every tier, every event's visual
treatment, and determinism.

### 5. `src/render/backend/`

There is **one implementation class**, `ThreeUnifiedBackend`, because both paths
run through `WebGPURenderer`. Its constructor branches on `caps` in exactly four
places: MSAA sample count, the particle integration strategy (compute versus
vertex-shader), the volumetric pass step count ceiling, and whether the GPU timer
is available. Those four branches are the entire cost of supporting two APIs. If
you find yourself adding a fifth branch, stop and report why.

`createBackend` is the only place `three/webgpu` is imported outside
`src/render`, and it imports `ThreeUnifiedBackend` dynamically so the WebGPU
build lands in its own chunk.

Implement the seven degradations of architecture 5.4 for the WebGL2 path:
particle integration, volumetric light, HDR target format with the
`EXT_color_buffer_float` fallback, MSAA with the `MAX_SAMPLES` check and FXAA
fallback, storage-buffer instance state as float vertex attributes, GPU frame
timing reporting `gpuMs: null`, and the depth prepass at high only.

`DeviceLossPolicy` implements architecture 10.3: on device loss, the backend
reports through `onDeviceLost`, the app shows a recoverable card, and a rebuild
is attempted once.

### 6. `src/render/materials/`

**Seven archetypes. This set is closed.** A new material requires a change to the
visual bible and to `materials/index.ts`, which is **the only factory permitted
to construct a `THREE.Material` in the whole codebase**.

```ts
export type MaterialArchetype =
  | 'void-surface' | 'emissive-line' | 'emissive-panel' | 'volumetric-beam'
  | 'derezz-glass' | 'holo-label' | 'reflective-floor';
```

Every archetype caches by `(archetype, semanticId, qualityTier)`, so a leg with
400 page slabs holds three materials rather than four hundred. Write a test that
proves the cache hit rate.

Implement each from visual bible 3.1 through 3.7. `voidSurface` is printed there
in full; keep `roughness` at 0.78 and `metalness` at 0.10 for the stated reasons,
and keep `dithering: true` on every standard and physical material.

**Three light constructors and no more.** Visual bible 12.4:

| Light | Type | Intensity | Purpose |
|---|---|---|---|
| Ambient | `HemisphereLight` | 0.06, sky `VOID.horizon`, ground `VOID.base` | stops matte bodies reading as pure silhouettes |
| Key | `DirectionalLight` | 0.15, from `(0.3, 1.0, 0.4)` normalised, no shadows | gives geometry a top and a side |
| Read light | `SpotLight`, optional | 0.35, penumbra 0.9 | exists only during a focus lock |

**At most 3 real light objects in the entire scene at any moment.**
`renderer.shadowMap.enabled = false` everywhere; there is no shadow map in this
game. Anything that looks like a light source is emissive geometry plus bloom
plus a floor light pool decal. Export only these three constructors from
`materials/index.ts` and write a test that asserts no other light type is
constructible through the module.

### 7. `src/render/post/chain.ts`

The fourteen passes of visual bible 4.1, in that order, over ping-pong render
targets. **All intermediate targets are `HalfFloatType` (RGBA16F).** No 8-bit
intermediate anywhere.

The order and the reason for each position are in the table; three of them are
load-bearing and are the ones most likely to be "optimised" wrongly:

- **Depth of field before bloom**, so a defocused emitter's bloom is also soft.
  After bloom it produces sharp halos around blurred objects, which reads as a
  bug.
- **Grain and vignette before tone mapping**, so grain lives in scene-referred
  values and the curve compresses it in the highlights the way film does, and so
  the vignette reads as a lens rather than as a black overlay.
- **World-space text after tone mapping**, pass 13, using the same camera and
  depth buffer as pass 1, so no glyph is ever bloomed or crushed.

Passes 9 through 12 merge into a single fragment shader in the shipping build and
stay separate in the debug build so any one can be toggled.

**Bright pass**, visual bible 4.3. Copy the shader as printed, including the soft
knee. Threshold **1.15**, knee **0.55**. The threshold sits deliberately between
`dim` (1.10) and `active` (1.85), so idle structure never halos and working
structure always does. **Changing `EMISSIVE_GAIN` without revisiting the
threshold breaks the whole image**; put that sentence in a comment.

**Dual-Kawase**, visual bible 4.4. Copy both shader functions as printed: 5 taps
down, 8 taps in a tent up. A separable Gaussian large enough for a cinematic halo
needs 30-plus taps per level and is roughly 3x slower on integrated graphics.

**Bloom strength 0.055** at every tier.

**Tone mapping is AgX**, visual bible 4.8. **Do not hand-transcribe the AgX
matrices.** Import them from Three's `ToneMappingShaderChunk`, or copy them
verbatim from
`node_modules/three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js`.
The two matrices printed in the visual bible document the operator's structure
and are explicitly labelled as not the shipping values. Exposure is fixed at
1.0; **there is no auto-exposure anywhere in this game**, because a scene that is
mostly black would hunt every time a bright object entered frame, and because
emission carries meaning.

**Dithering is not optional**, visual bible 4.9. Three mitigations, all
mandatory: HalfFloat intermediates, `dithering: true` on every standard and
physical material, and the 8x8 ordered Bayer dither in the output transform after
AgX and before the write. WebGL2 requires the Bayer array as `const int[64]` and
some drivers dislike dynamic indexing into it; if profiling shows a problem,
generate an 8x8 `DataTexture` at startup in TypeScript, which is still procedural
and still ships no asset.

**Kernel panic**, visual bible 4.6: post configuration floods amber for 900 ms,
every emissive object goes to `critical`, all motion stops, the message renders
at display size in world space, and the scene cuts to black over 120 ms. Expose
it as `chain.panic(message)`.

### 8. `src/render/targets.ts` and `DrawCallBudget.ts`

`RenderTargetBudget` implements architecture 7.2's memory ceiling: the sum of all
render target bytes at each tier, asserted at allocation time, throwing in dev
builds when a tier's ceiling is exceeded.

`DrawCallBudget` samples `renderer.info.render.calls` and `.triangles` every 30
frames and asserts against visual bible 12.1:

| Tier | Max draw calls | Max triangles |
|---|---|---|
| low | 220 | 180,000 |
| medium | 450 | 450,000 |
| high | 900 | 1,100,000 |

**A leg that exceeds its budget does not ship.** WP-14 and the leg packages
assert against this module.

### 9. The per-instance attribute layout

Visual bible 12.2. **Any form repeated more than 8 times uses `InstancedMesh`.**
This is not a guideline: the material factory refuses to build a non-instanced
material for a form registered as repeatable, and `LegStage` construction throws
in dev builds if a `Mesh` is added whose geometry uuid already appears more than
8 times in the same scene.

Twelve floats per instance beyond `instanceMatrix`, packed into three `vec4`s so
it costs three attribute slots rather than twelve:

```ts
export interface InstanceData {
  /** vec4 0: semantic colour rgb + emissive gain. */
  colorGain: [number, number, number, number];
  /** vec4 1: state id, phase 0..1, pulse Hz, focus weight. */
  statePhase: [number, number, number, number];
  /** vec4 2: dash on, dash off, hatch id, entity id for picking. */
  patternId: [number, number, number, number];
}
```

Updating one instance writes 12 floats and sets `needsUpdate` on the relevant
`InstancedBufferAttribute`. It never rebuilds the geometry and never touches
`instanceMatrix` unless the instance actually moved.

### 10. A throwaway test scene

Build one under `src/render/index.ts` as an exported `createProbeScene()`: a grid
floor, twelve beams, and 180 instanced slabs at the semantic tokens. It exists to
exercise the budget tests and to give WP-13 and WP-14 something to render
against. It is not a leg and it must not import anything from `src/world/` or
`src/game/`.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `three` is pinned to exactly `0.185.0` in `package.json` with no caret or
   tilde.
5. Every colour value in `src/design/tokens.ts` matches visual bible 2.1 through
   2.4 exactly, asserted value by value.
6. No file under `src/` other than `src/design/tokens.ts` contains a hex colour
   literal. Verified by a source scan in `tests/design/tokens.test.ts` matching
   `/0x[0-9a-fA-F]{6}\b/` and `/#[0-9a-fA-F]{3,8}\b/`.
7. `gainFor('amber', 'active')` returns `2.3125` and `gainFor('cyan', 'active')`
   returns `1.85`.
8. Every text token pair in visual bible 2.6 meets its stated contrast ratio,
   computed in `tests/design/contrast.test.ts` and asserted against the table.
9. Every semantic token in visual bible 2.4 carries a shape or pattern channel in
   addition to its colour. Asserted for all of them.
10. `PROFILES` has one entry per tier and every row of the visual bible 13.1
    table is represented as a typed field, asserted field by field for all three
    tiers.
11. `selectTier` follows the documented evidence order. Asserted with four cases:
    a populated cache, an explicit user choice, a successful benchmark, and a
    throwing benchmark.
12. Bloom threshold is 1.15 and bloom strength is 0.055 at every tier, asserted
    for all three.
13. The post chain builds all fourteen passes in the documented order at high
    tier, and the documented reduced set at medium and low. Asserted by
    inspecting the constructed pass list.
14. Every intermediate render target is `HalfFloatType`. Asserted across the
    whole chain at all three tiers.
15. The AgX matrices are imported from Three rather than typed as literals.
    Verified by a source scan asserting the numeric strings `0.8566271` and
    `1.1271006` appear nowhere under `src/render/`.
16. Exactly three light constructors are exported from
    `src/render/materials/index.ts`, and constructing a `PointLight` through the
    module is impossible. Asserted.
17. `renderer.shadowMap.enabled` is `false` in every code path.
18. The material cache returns the same object for repeated
    `(archetype, semanticId, tier)` requests: 400 requests for the same triple
    produce 1 material.
19. `createProbeScene()` renders within the draw-call and triangle budget for
    each tier, asserted from `renderer.info`.
20. `RenderTargetBudget` throws in a dev build when a tier's memory ceiling is
    exceeded, asserted by requesting an oversized target.
21. Nothing under `src/render/`, `src/design/` or `src/platform/` imports from
    `src/kernel/`, `src/game/` or `src/world/`. Asserted by a boundary test.
22. `src/design/` imports nothing from inside `src/` except `three`.

## Tests you must write

### `tests/design/tokens.test.ts`

| Case | Assertion |
|---|---|
| `void values` | all five `VOID` values match the visual bible |
| `cyan values` | all five `CYAN` values match |
| `amber values` | all five `AMBER` values match |
| `slate values` | all five `SLATE` values match |
| `gains` | all five `EMISSIVE_GAIN` values match, and `AMBER_GAIN_COMPENSATION` is 1.25 |
| `gainFor` | per acceptance criterion 7, plus `gainFor('amber', 'critical') === 5.75` |
| `no literals elsewhere` | per acceptance criterion 6 |
| `semantic completeness` | every semantic token in 2.4 has hex, family, gain and a shape or pattern channel |
| `linear conversion` | `ColorManagement.enabled` is true before tokens are read, and a token's linear value differs from its sRGB value |
| `motion tokens` | `DUR` and `EASE` cover every duration and curve named in visual bible section 8 |
| `typography fallbacks` | every font stack ends in a generic family |

### `tests/design/contrast.test.ts`

| Case | Assertion |
|---|---|
| `text ratios` | every pair in visual bible 2.6 meets its stated ratio, computed with the WCAG relative-luminance formula |
| `hud over void at 0.72` | the primary text token over the void at 0.72 opacity still meets its ratio within 8 percent |
| `monochrome mapping` | under the monochrome vision setting, every semantic pair that is distinguishable by colour is distinguishable by shape or pattern |

### `tests/platform/tierSelect.test.ts`

| Case | Assertion |
|---|---|
| `cache first` | a populated cache short-circuits before the benchmark runs |
| `user override` | an explicit user choice beats the benchmark |
| `benchmark` | a benchmark returning a fast median selects high, a slow one selects low |
| `benchmark throws` | a throwing benchmark falls back to the heuristic prior and caches it with `by: 'heuristic'` |
| `heuristic prior` | webgl2 gives low, integrated gives medium, otherwise high |
| `runtime downgrade` | `QualityGovernor` applies a tier change without a reload and `setQuality` reaches the backend |
| `never degrades` | the eight items in visual bible 13.2 are identical across all three profiles |
| `profiles complete` | per acceptance criterion 10 |

### `tests/render/materials.test.ts`

| Case | Assertion |
|---|---|
| `seven archetypes` | the union has exactly seven members and each constructs |
| `cache` | per acceptance criterion 18 |
| `three lights` | per acceptance criterion 16 |
| `no shadows` | per acceptance criterion 17 |
| `voidSurface values` | roughness 0.78, metalness 0.10, `envMapIntensity` 0, `dithering` true |
| `dithering everywhere` | every standard or physical material the factory builds has `dithering: true` |
| `instanced above 8` | adding a ninth mesh sharing a geometry uuid throws in a dev build |
| `instance layout` | `InstanceData` packs into exactly three `vec4` attribute slots |

### `tests/render/postChain.test.ts`

| Case | Assertion |
|---|---|
| `pass order high` | the fourteen passes appear in the documented order |
| `pass order medium` | DOF, scattering and MSAA are absent and SMAA is present |
| `pass order low` | 4 bloom levels at quarter resolution |
| `halffloat` | per acceptance criterion 14 |
| `bright pass constants` | threshold 1.15 and knee 0.55, and the soft-knee formula matches the printed shader |
| `bloom strength` | 0.055 at every tier |
| `kawase taps` | the down shader has 5 taps and the up shader has 8 |
| `agx imported` | per acceptance criterion 15 |
| `exposure fixed` | exposure is 1.0 and no auto-exposure code path exists |
| `bayer dither` | the output transform applies the 8x8 ordered dither after AgX |
| `panic` | `chain.panic(msg)` floods amber, raises every emissive to critical, and cuts to black over 120 ms |
| `merged in build` | passes 9 to 12 are one shader in the shipping build and four in the debug build |

### `tests/render/budget.test.ts`

| Case | Assertion |
|---|---|
| `draw calls` | `createProbeScene()` is under 220 / 450 / 900 calls at low / medium / high |
| `triangles` | under 180,000 / 450,000 / 1,100,000 |
| `target memory` | per acceptance criterion 20 |
| `boundaries` | per acceptance criteria 21 and 22 |
| `frame allocation` | rendering 300 frames of the probe scene allocates no new `Matrix4`, `Vector3` or `Color`, verified with a counting proxy |

## Out of scope

- `src/world/` entirely. WP-13 and WP-14 own it.
- `src/render/camera/FocusCamera.ts` and `src/render/derezz/`. WP-13 and WP-14
  own them.
- `src/ui/`, `src/terminal/`, `src/audio/`, `src/game/`, `src/kernel/`,
  `src/legs/`.
- Any leg-specific geometry, structure or colour.
- The HUD's CSS. WP-17 owns it and reads its tokens from here.

## Report back

State:

1. Pass or fail for each of the twenty-two acceptance criteria, by number.
2. The three verification command outcomes.
3. Which of the five scaffold files existed, whether each matched the
   specification, and every line you changed in them.
4. Every path where you kept the scaffold's naming instead of this package's
   suggested path.
5. Every Three.js API you checked against `node_modules` before using, with the
   file you checked, and any API you expected to exist in 0.185 and did not.
6. The measured GPU milliseconds per pass for `createProbeScene()` at high tier,
   next to the visual bible 4.2 budget table.
7. Every `// TODO(astra):` left in the tree, with file and line.
