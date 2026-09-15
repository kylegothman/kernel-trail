# KERNEL TRAIL: 03 VISUAL BIBLE

**Version 1.0. Subordinate to `docs/00-DESIGN-BRIEF.md`. Where the brief disagrees with this document, the brief wins.**

This document carries the entire look of the game. It is written for an implementing
agent that cannot see reference images, so every description resolves to a number, a
material parameter, a shader, or a rule that can be checked by a test.

---

## 0. The reference, stated once, precisely

The register is the *Tron* films, and specifically the 2010 sequel's photography. What
that means operationally:

| Property | Value in this game |
|---|---|
| Environment luminance | Near zero. The majority of every frame is within 2/255 of the void base colour. |
| Light sources | Hard-edged and self-luminous. Light lines have a defined physical width and crisp boundaries. |
| Beams | Physically thick. A beam is geometry with volume, not a sprite. |
| Floors | Wet and reflective. Emissive geometry appears again, inverted and attenuated, below the horizon line. |
| Palette | Two chromatic families only: cool cyan-white and hot amber-orange. One achromatic family from slate to white. |
| Contrast | Extreme. There is no mid-tone environment. Surfaces are either emitting or nearly black. |
| Bloom | Heavy but tight. Halos are bright and small-radius, never a soft fog over the frame. |
| Scale | Oppressive. Structures run past the point where the eye can resolve them. |

What this is not, and what will be rejected in review: the 1982 arcade game's flat vector
look, generic cyberpunk (magenta and pink accents, rain, wet street signage, Japanese
typography, visual clutter, holographic advertising), and any recreation of a specific
shot, vehicle silhouette, character design, costume, or typeface from the films.

The IP line in section 3 of the design brief is absolute. The forbidden vocabulary list
applies to identifiers in code, to shader uniform names, to asset filenames, to commit
messages, and to comments. Original forms in the same register. A reviewer's test: if a
form could be recognised as a specific thing from a specific film, redesign it.

### 0.1 Everything is procedural

No modelling software output, no texture files, no image assets, no material libraries
ship with this game. The build contains TypeScript, GLSL, and a font file. Every visual
element is one of:

- Three.js primitive geometry (`BoxGeometry`, `CylinderGeometry`, `TorusGeometry`, `PlaneGeometry`, `RingGeometry`).
- `LatheGeometry` from a code-generated profile array.
- `ExtrudeGeometry` from a code-generated `THREE.Shape`.
- Geometry synthesised by writing typed arrays directly into a `BufferGeometry`.
- A pattern produced in a fragment shader from an analytic function or a noise function.
- Text rasterised at runtime from a loaded web font into a signed-distance-field atlas.

Every element specified below states how it is generated. If a spec does not say how,
that spec is incomplete and should be escalated rather than solved with an asset.

---

## 1. Design principles

Seven principles. Each has a rule stated so that a reviewer or an automated check can
decide pass or fail without judgement.

### 1.1 Light is the only material property that carries meaning

An object that emits is doing something. An object that only reflects is inert scenery.
The player learns this in the first thirty seconds of leg 0 and it holds for the rest of
the game, so a change in emission is always readable as a change in simulation state.

**Rule.** A mesh may have `emissiveIntensity > EMISSIVE_GAIN.ambient` only if it is
registered in the world layer against a live kernel entity id (a `Pid`, `FrameId`,
`ResourceId`, `InodeId`, `DeviceId`, or `BlockId`). Decorative emission is forbidden.

**Check.** `tests/world/emission-audit.test.ts` walks the scene graph after each leg's
`createStage`, collects every material whose emissive gain exceeds the ambient token, and
asserts each one's owning object has a non-null `userData.entityRef`.

### 1.2 The void is the majority of the frame

The dark is the subject. If the frame is busy, the image stops reading as vast and starts
reading as a menu.

**Rule.** At every leg's establishing camera pose, at least 62% of pixels must have a
luminance below 0.012 in linear space after tone mapping.

**Check.** The screenshot rig renders each leg's establishing pose at 1440x900,
histograms the output, and fails the build below 62%.

### 1.3 Two hues, and brightness is the urgency axis

Hue answers "whose side is this on". Brightness answers "how much does this matter right
now". Nothing else is allowed to carry meaning through colour.

**Rule.** No hex literal may appear anywhere under `src/world`, `src/render`, `src/legs`,
or `src/ui`. All colour comes from `src/design/tokens.ts`. Urgency is expressed by
selecting a different gain from `EMISSIVE_GAIN`, never by hand-tuning a colour.

**Check.** An ESLint rule (`no-restricted-syntax` matching `/0x[0-9a-fA-F]{6}/` and
`/#[0-9a-fA-F]{3,8}/`) with a single allowed file.

### 1.4 Every colour distinction is duplicated in shape or pattern

Cyan against amber is the whole semantic system, which makes the game unplayable for a
player who cannot separate those two hues unless the information is carried twice.

**Rule.** Any two simulation states that differ in colour must also differ in at least one
of: silhouette, outline dash pattern, surface hatch, or pulse rhythm. The table in
section 2.5 assigns all four channels for every semantic token.

**Check.** `tests/render/monochrome.test.ts` renders a fixture scene containing one
instance of every semantic state through a desaturating debug pass and asserts that a
per-state perceptual hash differs from every other state's hash by more than a threshold.
The same pass ships to players as the **Shape Channel** accessibility setting.

### 1.5 Simulation data lives in the world, status lives on the glass

Page tables, ready queues, wait-for graphs, frame tables, Banker's matrices, and disk
queues are physical objects in 3D space. The HUD carries counters and warnings.

**Rule.** `src/ui` may import only `SchedulingMetrics`, `MemoryMetrics`, `ResourceLedger`,
`ConvoyMember`, `TravelPolicy`, and `RunState` scalars. It may not import
`ProcessControlBlock`, `PageTableEntry`, `Frame`, `SyncPrimitive`, `BankersState`,
`DiskRequest`, or `Inode`.

**Check.** A dependency-cruiser rule on the import graph, run in CI.

### 1.6 Hard edges, never soft blobs

The light in this game has a boundary you could cut yourself on. Softness comes from the
bloom pass acting on a hard source, and from nothing else.

**Rule.** No additively-blended camera-facing sprite may be used to represent light,
anywhere, with one exception: the mote particles inside a volumetric beam, capped at 64
per beam. Every glow is a hard-edged emissive surface that the bloom pass then halos.
Radial gradient textures generated in code are forbidden as a light substitute.

**Check.** Code review plus a runtime assertion in the material factory: constructing a
`SpriteMaterial` outside `src/render/materials/BeamMotes.ts` throws in development builds.

### 1.7 Scale is asserted by repetition at a known module

There is no atmosphere, no sky, and no familiar object in this world, so the usual depth
cues are gone. Size is established by counting.

**Rule.** Every leg contains at least one structural module repeated on a 4.00 m pitch,
at least 64 times, receding toward the horizon, and at least one instance of the standard
2.40 m process stele visible in the establishing shot. The stele is the game's ruler and
its height never varies between legs.

**Check.** `LegStage` exposes `scaleReference(): { pitch: number; count: number }` and a
test asserts `pitch === 4.0 && count >= 64` for all fourteen legs.

---

## 2. Colour system

The whole palette lives in `src/design/tokens.ts`. It is the only file in the repository
permitted to contain a colour literal.

### 2.1 The void

```ts
// src/design/tokens.ts
import { Color } from 'three';

/**
 * Base colours are authored as sRGB hex and converted once, at module load, into
 * linear-space Colors. Everything downstream works in linear. Three's colour
 * management must be enabled (ColorManagement.enabled = true) before this module
 * is imported, or the conversion silently no-ops.
 */
export const VOID = {
  /** Clear colour. The colour of nothing. Slightly blue so it is not dead grey-black. */
  base:      0x04060a,
  /** Inert surfaces that the player can see but that do nothing. */
  surface:   0x080b11,
  /** Inert surfaces catching the faint directional light. Upper faces only. */
  surfaceLit: 0x0d1219,
  /** The thin band where the floor meets nothing, drawn as a line, not a gradient. */
  horizon:   0x0a1a24,
  /** Reflection floor tint. The floor is never pure black or reflections read as fog. */
  floor:     0x060910,
} as const;
```

The void base is `#04060A`, luminance 0.00178 in linear space. It is not `#000000` for two
reasons. Pure black gives the bloom pass no floor to sit against and makes the tone
mapper's toe indistinguishable from clipping, and a slight blue bias makes the amber
family read as genuinely warm rather than merely brighter.

### 2.2 The two emissive families

```ts
/** Protagonist. The convoy, the kernel acting correctly, resident and clean state. */
export const CYAN = {
  /** Barely present. Structure you can see but that is not participating. */
  trace: 0x123844,
  /** Idle or ready. Present, waiting. */
  dim:   0x2f8fa8,
  /** The default working colour of a live line. */
  core:  0x5fd7f5,
  /** Something is happening here, right now. */
  hot:   0x9fecff,
  /** The centre of a running process. Reads as white with a cyan halo after bloom. */
  white: 0xd6f7ff,
} as const;

/** Antagonist. Arbiters, faults, contention, dirt, cost, and anything the kernel
 *  is doing under duress. */
export const AMBER = {
  trace: 0x3b1d04,
  dim:   0x7a3c06,
  core:  0xff9a2e,
  hot:   0xffbe5c,
  white: 0xffe0b0,
} as const;

/** Achromatic. Structure, protection, text, and dead matter. Never used for a
 *  simulation state that has a live counterpart in CYAN or AMBER. */
export const SLATE = {
  /** Dead. A terminated process, an unreachable block. Non-emissive. */
  dead:      0x1b2026,
  /** Inert outline. Geometry the player should perceive but not read. */
  outline:   0x39434d,
  /** Secondary HUD text. */
  secondary: 0x6b7a88,
  /** Protected, privileged, ring 0. Emissive but hueless. */
  protected: 0x9fb4c4,
  /** Primary text and the highest-authority structure. */
  primary:   0xe8f4ff,
} as const;
```

There is no third hue. Corruption, which needs to feel wrong, is expressed as a **failure
of colour** rather than as a new colour: value quantisation, per-block hue jitter around
whatever the base token was, and positional displacement. Section 2.4 specifies it.

### 2.3 HDR gains

Bloom needs scene values above 1.0. Emissive colour and emissive strength are separated so
that a state change is a change of gain against a fixed hue.

```ts
/**
 * Multipliers applied to a linear emissive colour before it is written to the
 * RGBA16F target. The bloom bright-pass threshold sits at 1.15, deliberately
 * between `dim` and `active`, so that idle structure never halos and working
 * structure always does. Changing BLOOM_THRESHOLD without changing these is a
 * visual regression.
 */
export const EMISSIVE_GAIN = {
  /** Visible, never blooms. Structural hairlines, grid, inert edges. */
  ambient:  0.45,
  /** Visible, never blooms. Ready, resident, idle. */
  dim:      1.10,
  /** Blooms with a small halo. The default for anything actively doing work. */
  active:   1.85,
  /** Blooms hard. Running process cores, acquired locks, page seat flashes. */
  hot:      3.20,
  /** Blooms to a white core. Reserved for the derezz spike, kernel panic, and
   *  the Portal. Never used as a steady state, only as a transient. */
  critical: 4.60,
} as const;

/**
 * Amber at a given gain reads dimmer than cyan at the same gain because its
 * relative luminance is lower (0.446 against 0.576 for the core tokens). Multiply
 * every amber gain by this so a hot amber and a hot cyan produce halos of equal
 * radius. Without it, hazards look less urgent than routine work.
 */
export const AMBER_GAIN_COMPENSATION = 1.25;

export const gainFor = (family: 'cyan' | 'amber' | 'slate', level: keyof typeof EMISSIVE_GAIN): number =>
  EMISSIVE_GAIN[level] * (family === 'amber' ? AMBER_GAIN_COMPENSATION : 1);
```

Protagonist emissive, stated flatly: `CYAN.core = #5FD7F5`, working gain `1.85`, running
gain `3.20`, so the value written to the HDR target for a running process core is
`linear(#D6F7FF) * 3.20`.

Antagonist emissive: `AMBER.core = #FF9A2E`, working gain `1.85 * 1.25 = 2.3125`, critical
gain `4.60 * 1.25 = 5.75`.

### 2.4 Semantic tokens

Every one of these maps to a state the kernel actually reports. The `event` column names
the `KernelEvent` variant or the `ProcessState`/field that drives it.

| Semantic | Driven by | Hex | Family | Gain | Reads as |
|---|---|---|---|---|---|
| `ready` | `ProcessState = 'ready'` | `#2F8FA8` | cyan | `dim` 1.10 | present, not working |
| `running` | `ProcessState = 'running'` | `#D6F7FF` | cyan | `hot` 3.20 | white-hot core with a cyan halo |
| `waiting` | `ProcessState = 'waiting'`, `BlockReason.kind = 'io' \| 'sleep' \| 'child_wait'` | `#123844` | cyan | `ambient` 0.45 | hollow, barely lit |
| `blocked` | `BlockReason.kind = 'semaphore' \| 'mutex' \| 'condition' \| 'page_fault'` | `#FF9A2E` | amber | `dim` 1.375 | held back by something |
| `starving` | `process.starving`, `fatal = false` | `#7A3C06` | amber | `dim` 1.375, pulsing | draining |
| `terminated` | `ProcessState = 'terminated'` | `#1B2026` | slate | `0` | matte, wireframe only |
| `zombie` | `ProcessState = 'zombie'` | `#39434D` | slate | `ambient` 0.45 | a silhouette that will not clear |
| `page_clean` | `PageTableEntry.dirty = false`, `valid = true` | `#5FD7F5` | cyan | `dim` 1.10 | flat lit face, one centre line |
| `page_dirty` | `PageTableEntry.dirty = true` | `#FF9A2E` | amber | `active` 2.3125 | diagonal hatch across the face |
| `page_absent` | `valid = false`, `swapped = true` | `#04060A` | void | `0` | an empty slab socket |
| `frame_free` | `Frame.owner = null` | `#123844` | cyan | `ambient` 0.45 | outline only, no fill |
| `resource_locked` | `SyncPrimitive.value = 0`, `holders.length > 0` | `#E8F4FF` | slate | `active` 1.85 | an unbroken closed ring |
| `resource_contended` | `waitQueue.length > 0` | `#FFBE5C` | amber | `hot` 4.00 | ring broken into N arcs |
| `resource_free` | `value = capacity` | `#2F8FA8` | cyan | `dim` 1.10 | open ring, one gap |
| `corrupted` | `fs.corruption` | see 2.4.1 | none | `active` | quantised, displaced, hue-jittered |
| `protected` | `ProtectionDomain.ring <= 1` | `#9FB4C4` | slate | `dim` 1.10 | a lattice, never a solid face |
| `denied` | `security.access_denied`, `resource.denied` | `#FF9A2E` | amber | `critical` 5.75 for 180 ms | a hard flash, then nothing |
| `panic` | `kernel.panic` | `#FFE0B0` | amber | `critical` 5.75 | the whole scene tinted, see 4.6 |

```ts
export interface SemanticToken {
  readonly id: SemanticId;
  readonly hex: number;
  readonly family: 'cyan' | 'amber' | 'slate' | 'void';
  readonly level: keyof typeof EMISSIVE_GAIN;
  /** Redundant channels. See 2.5. */
  readonly dash: DashPattern;
  readonly hatch: HatchPattern;
  readonly pulseHz: number;
  readonly glyph: string;
}

export type SemanticId =
  | 'ready' | 'running' | 'waiting' | 'blocked' | 'starving'
  | 'terminated' | 'zombie'
  | 'page_clean' | 'page_dirty' | 'page_absent' | 'frame_free'
  | 'resource_locked' | 'resource_contended' | 'resource_free'
  | 'corrupted' | 'protected' | 'denied' | 'panic';

export type DashPattern = 'solid' | 'long' | 'short' | 'dot' | 'gap' | 'none';
export type HatchPattern = 'none' | 'diagonal' | 'cross' | 'scan' | 'lattice' | 'noise';
```

#### 2.4.1 Corruption

Corruption has no hue of its own. The corruption shader takes whatever the object's base
token is and destroys it:

```glsl
// src/render/shaders/corrupt.glsl.ts
// Applied as a post-transform on any material's final emissive value.
// uCorrupt in [0,1] ramps in over 400 ms when fs.corruption fires.

vec3 corrupt(vec3 base, vec3 worldPos, float uCorrupt, float uTime) {
  if (uCorrupt <= 0.0) return base;

  // Quantise position into 6 cm cells so the damage has block structure.
  vec3 cell = floor(worldPos / 0.06);
  float h = hash31(cell + floor(uTime * 12.0) * 0.017);

  // Value quantisation: collapse the ramp to 3 steps.
  vec3 q = floor(base * 3.0 + 0.5) / 3.0;

  // Hue jitter around the base hue, +/- 0.06 in HSV, never introducing a new family.
  vec3 hsv = rgb2hsv(q);
  hsv.x = fract(hsv.x + (h - 0.5) * 0.12);
  hsv.y *= 0.4 + 0.6 * h;                 // desaturate unevenly
  vec3 j = hsv2rgb(hsv);

  // Dropout: 18% of cells go fully dark, which is what reads as "broken".
  float alive = step(0.18, h);

  return mix(base, j * alive, uCorrupt);
}
```

Positional displacement is applied in the vertex stage of the same material:
`position.xz += (hash31(cell) - 0.5) * 0.035 * uCorrupt`. The combination reads
unambiguously as damaged data and introduces no new hue, which keeps the palette closed.

### 2.5 Colour-blind accommodation

Cyan against amber separates well under deuteranopia and protanopia because the pair
differs strongly in the blue channel and in luminance. It separates poorly under
tritanopia and under monochromacy. Because the entire semantic system rests on that pair,
the information is carried four times over, and three of the four channels survive any
form of colour vision deficiency.

**Channel 1, silhouette.** Every semantic state has a distinct outline shape:

| Semantic | Silhouette |
|---|---|
| `ready` | hexagonal prism, full height, flat top |
| `running` | same prism with a horizontal ring orbiting at 60% height |
| `waiting` | same prism, top face open, hollowed to a shell |
| `blocked` | same prism with a solid bar across the front face at 50% height |
| `starving` | same prism, visibly shortened, height scaled to `1 - min(0.4, waitedTicks / fatalThreshold * 0.4)` |
| `terminated` | wireframe of the prism, no faces |
| `zombie` | prism faces present but inverted normals, so it reads as a hole |
| `page_clean` | flat slab, chamfered edges |
| `page_dirty` | slab with a raised 2 cm rib across the diagonal |
| `resource_locked` | closed torus |
| `resource_contended` | torus split into `waitQueue.length` arcs with visible gaps |
| `protected` | any form, wrapped in a 12 cm lattice cage |

**Channel 2, outline dash.** The fat-line material carries a dash pattern encoded in a
per-vertex arc-length attribute. `solid` for running, `long` (0.6/0.2 m) for ready,
`short` (0.2/0.2 m) for blocked, `dot` (0.05/0.25 m) for waiting, `gap` (0.1/0.6 m) for
starving, `none` for terminated.

**Channel 3, pulse rhythm.** Emissive gain is modulated by
`1 + 0.12 * sin(uTime * pulseHz * TAU)`. Rhythms are chosen to be countable rather than
subliminal: `running` 0 Hz (steady), `ready` 0.5 Hz, `blocked` 1.4 Hz, `starving` 2.6 Hz
accelerating to 4.0 Hz as the fatal threshold approaches, `contended` 1.4 Hz phase-locked
across every contended resource so contention reads as one system-wide beat.

**Channel 4, glyph.** Every world-space label carries a single-character prefix glyph from
the monospace font: `>` running, `.` ready, `~` waiting, `#` blocked, `!` starving, `x`
terminated, `z` zombie, `*` dirty, `-` clean, `@` locked, `%` contended, `?` corrupted,
`=` protected.

**Accessibility settings** in `src/design/accessibility.ts`:

```ts
export interface VisionSettings {
  /** Strips hue entirely. Amber becomes SLATE.primary at full gain, cyan becomes
   *  SLATE.protected at 0.55 gain. Luminance separation is preserved, so every
   *  semantic pair remains distinguishable by brightness alone. */
  monochromeSemantics: boolean;
  /** Doubles dash-pattern contrast and raises pulse depth from 0.12 to 0.30. */
  emphasiseShapeChannel: boolean;
  /** Adds the glyph prefix to HUD chips as well as world labels. */
  glyphPrefixes: boolean;
  /** Caps bloom strength at 0.5x and raises the threshold to 1.6 for players who
   *  find heavy bloom fatiguing. Never disables it entirely, because emission is
   *  the semantic system. */
  reducedBloom: boolean;
  /** Caps every pulse and flow animation at 0.5 Hz and disables the FOV change in
   *  leg 8's thrashing state. */
  reducedMotion: boolean;
}
```

The Shape Channel test in 1.4 is the same code path as `monochromeSemantics`, so the
accessibility mode cannot rot without failing CI.

### 2.6 Contrast ratios for text

All ratios are against `VOID.base` (`#04060A`, relative luminance 0.00178). WCAG 2.1
contrast ratio, computed and asserted by `tests/design/contrast.test.ts`, which fails
`npm test` if any text token drops below its stated floor. The floors below are the
computed values truncated to one decimal (corrected 2026-09-14; the earlier figures
were approximations and two of them were wrong in the other direction).

| Token | Hex | Ratio vs void | Permitted use |
|---|---|---|---|
| `SLATE.primary` | `#E8F4FF` | 18.1:1 | any text at any size |
| `CYAN.white` | `#D6F7FF` | 17.9:1 | any text at any size |
| `AMBER.white` | `#FFE0B0` | 15.9:1 | any text at any size |
| `CYAN.core` | `#5FD7F5` | 12.0:1 | any text at any size |
| `AMBER.core` | `#FF9A2E` | 9.5:1 | any text at any size |
| `SLATE.protected` | `#9FB4C4` | 9.4:1 | any text at any size |
| `SLATE.secondary` | `#6B7A88` | 4.6:1 | body text 14 px and above only |
| `CYAN.dim` | `#2F8FA8` | 5.4:1 | body text 14 px and above only |
| `AMBER.dim` | `#7A3C06` | 2.3:1 | **never text.** Fill and outline only. |
| `SLATE.outline` | `#39434D` | 2.0:1 | **never text.** |

Three additional rules keep those ratios true in practice:

1. Text is never drawn over an emissive panel whose gain exceeds `EMISSIVE_GAIN.dim`. If
   a label must sit over a bright surface, the backing plate in section 7.5 goes under it.
2. The backing plate is `rgba(4, 6, 10, 0.92)`. No plate can bound the background
   independently of what lies behind it (the old 0.72 plate over linear white left
   `SLATE.primary` at about 2.8:1), so the guarantee is stated with its precondition:
   rule 1 caps whatever is under a label at the `dim` gain, which after tone mapping is a
   display luminance of at most 0.15, and over any background at or below 0.15 the 0.92
   plate holds the local luminance at or below 0.014. Under that bound every "any text"
   token in the table stays above 7:1 (AAA), and `tests/design/contrast.test.ts` asserts
   the worst case for each of them.
3. Text is rendered after tone mapping and after bloom (section 4.7), so bloom never lifts
   the background behind a glyph.
---

## 3. Materials

Seven archetypes. This set is closed. A new material requires a change to this document
and to `src/render/materials/index.ts`, which is the only factory permitted to construct a
`THREE.Material` in the whole codebase.

```ts
// src/render/materials/index.ts
export type MaterialArchetype =
  | 'void-surface'
  | 'emissive-line'
  | 'emissive-panel'
  | 'volumetric-beam'
  | 'derezz-glass'
  | 'holo-label'
  | 'reflective-floor';
```

Every archetype caches by `(archetype, semanticId, qualityTier)` so that a leg with 400
page slabs holds three materials rather than four hundred.

### 3.1 Void surface

The matte body of every hard-surface object. It receives the two scene lights and nothing
else, and it exists so that emissive edges have something to be edges of.

```ts
export const voidSurface = (variant: 'base' | 'lit' | 'floor' = 'base') =>
  new MeshStandardMaterial({
    color: new Color(VOID[variant === 'lit' ? 'surfaceLit' : variant === 'floor' ? 'floor' : 'surface']),
    roughness: 0.78,
    metalness: 0.10,
    emissive: new Color(0x000000),
    envMapIntensity: 0.0,     // there is no environment map; the void has no sky
    dithering: true,          // mandatory, see 4.9
    flatShading: false,
  });
```

`roughness` deliberately sits below 0.85 so that grazing angles pick up a faint specular
from the single directional light, which is what stops the geometry reading as flat black
cut-outs. `metalness` at 0.10 rather than 0 keeps that specular slightly tinted by the
surface colour.

**Use for:** structural bodies, plinths, walls, stele bodies, catwalks, machine housings.
**Never use for:** anything representing a live kernel entity's state. That gets an
emissive line or panel on top of it.

### 3.2 Emissive line

The core of the look. A line in this game has physical width, so it is geometry rather than
`THREE.Line`. Use `Line2` / `LineSegments2` from the Three.js examples (`LineMaterial`),
which builds screen-space-width quads, with a custom shader injected for dash patterns and
HDR gain.

```ts
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

export const emissiveLine = (token: SemanticToken, tier: QualityTier) => {
  const m = new LineMaterial({
    color: new Color(token.hex),
    // Width is in world units when worldUnits = true. 1.6 cm reads as a hairline
    // at 8 m and stays visible at 60 m without becoming a rope.
    linewidth: 0.016,
    worldUnits: true,
    dashed: token.dash !== 'solid' && token.dash !== 'none',
    dashScale: 1,
    dashSize: DASH[token.dash].on,
    gapSize: DASH[token.dash].off,
    transparent: false,
    toneMapped: false,   // we tone map ourselves in the composite pass
  });

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGain = { value: gainFor(token.family, token.level) };
    shader.uniforms.uPulseHz = { value: token.pulseHz };
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uFocusWeight = { value: 1 };   // see section 6.5
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uGain, uPulseHz, uTime, uFocusWeight;
      `)
      .replace('#include <colorspace_fragment>', /* glsl */`
        float pulse = uPulseHz > 0.0
          ? 1.0 + 0.12 * sin(uTime * uPulseHz * 6.28318530718)
          : 1.0;
        gl_FragColor.rgb *= uGain * pulse * uFocusWeight;
        // No colorspace conversion here. This writes scene-referred HDR into the
        // RGBA16F target and the composite pass owns the output transform.
      `);
    m.userData.shader = shader;
  };

  return m;
};
```

Two hard constraints. `worldUnits: true` matters because a screen-space line width makes
distant structure the same thickness as near structure, which destroys the depth read in a
scene with no atmosphere. `toneMapped: false` matters because Three would otherwise apply
its own tone mapping per material and clip our HDR values before bloom ever sees them.

**Use for:** every edge, every outline, the grid floor's overlay lines, wait-for graph
edges when they are static, dash-coded state outlines.

### 3.3 Emissive panel

A flat lit face: the top of a page slab, the front of a frame socket, the readout face of a
device bollard.

```ts
export const emissivePanel = (token: SemanticToken) => {
  const m = new MeshStandardMaterial({
    color: new Color(VOID.surface),
    emissive: new Color(token.hex),
    emissiveIntensity: gainFor(token.family, token.level),
    roughness: 0.55,
    metalness: 0.0,
    toneMapped: false,
    dithering: true,
  });

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uHatch = { value: HATCH_ID[token.hatch] };
    shader.uniforms.uEdgeWidth = { value: 0.035 };  // metres of inset edge glow
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uFocusWeight = { value: 1 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPanelUv;\nvarying vec3 vLocalPos;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPanelUv = uv;\nvLocalPos = position;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec2 vPanelUv;
        varying vec3 vLocalPos;
        uniform float uHatch, uEdgeWidth, uTime, uFocusWeight;

        // Analytic, anti-aliased stripe. period and duty in UV space.
        float stripe(vec2 uv, vec2 dir, float period, float duty) {
          float t = dot(uv, normalize(dir)) / period;
          float f = fract(t);
          float w = fwidth(t) * 1.5;
          return smoothstep(duty + w, duty - w, f);
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>

        // Inset edge: the panel is brighter within uEdgeWidth of its border,
        // which is the "lit slab" read without any texture.
        vec2 d = min(vPanelUv, 1.0 - vPanelUv);
        float edge = 1.0 - smoothstep(0.0, uEdgeWidth, min(d.x, d.y));
        float body = 0.22;   // the face itself is much dimmer than its border

        float pattern = 0.0;
        if (uHatch == 1.0) pattern = stripe(vPanelUv, vec2(1.0, 1.0), 0.11, 0.42); // diagonal
        if (uHatch == 2.0) pattern = max(stripe(vPanelUv, vec2(1.0, 1.0), 0.11, 0.42),
                                         stripe(vPanelUv, vec2(1.0, -1.0), 0.11, 0.42)); // cross
        if (uHatch == 3.0) pattern = stripe(vPanelUv + vec2(0.0, uTime * 0.06), vec2(0.0, 1.0), 0.25, 0.06); // scan
        if (uHatch == 4.0) pattern = max(stripe(vPanelUv, vec2(1.0, 0.0), 0.08, 0.10),
                                         stripe(vPanelUv, vec2(0.0, 1.0), 0.08, 0.10)); // lattice

        totalEmissiveRadiance *= (body + edge * 0.95 + pattern * 0.55) * uFocusWeight;
      `);
    m.userData.shader = shader;
  };
  return m;
};
```

The body term at 0.22 is the single most important number here. A panel whose whole face
sits at full gain reads as a glowing rectangle and washes the frame. A panel whose face is
dim and whose border is bright reads as a physical lit slab. Do not raise it.

### 3.4 Volumetric beam

A beam is a solid: an extruded prism or a cylinder with radial falloff, rendered from the
inside as well as the outside, additively blended, depth-tested but not depth-writing, and
soft-clipped against scene depth so it does not cut a hard line where it meets geometry.

```ts
export const volumetricBeam = (token: SemanticToken, tier: QualityTier) =>
  new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(token.hex) },
      uGain: { value: gainFor(token.family, token.level) },
      uTime: { value: 0 },
      /** Sawtooth pulses travelling along the beam. 0 disables flow. */
      uFlowSpeed: { value: 0 },
      uFlowCount: { value: 3 },
      /** Scene depth for soft clipping. Half-res on medium, full on high. */
      uDepth: { value: null as Texture | null },
      uResolution: { value: new Vector2() },
      uCameraNear: { value: 0.1 },
      uCameraFar: { value: 2000 },
      uSoftness: { value: 0.35 },     // metres of depth fade at intersections
      uFocusWeight: { value: 1 },
    },
    vertexShader: /* glsl */`
      // Beam geometry is a CylinderGeometry(1, 1, 1, tier.beamRadial, 1, true)
      // scaled per-instance. uv.y runs 0..1 along the beam. aArc carries the
      // beam's world length so flow speed is length-independent.
      attribute float aArc;
      varying vec2 vUv;
      varying float vArc;
      varying vec4 vClip;
      void main() {
        vUv = uv;
        vArc = aArc;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vClip = projectionMatrix * mv;
        gl_Position = vClip;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uColor;
      uniform float uGain, uTime, uFlowSpeed, uFlowCount, uSoftness, uFocusWeight;
      uniform float uCameraNear, uCameraFar;
      uniform sampler2D uDepth;
      uniform vec2 uResolution;
      varying vec2 vUv;
      varying float vArc;
      varying vec4 vClip;

      float linearDepth(float d) {
        float z = d * 2.0 - 1.0;
        return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
      }

      void main() {
        // Radial falloff across the beam's cross-section. uv.x wraps the cylinder,
        // so radial distance comes from the angle of the surface normal is not
        // available on a cylinder shell; instead we use the view-facing term.
        // A cylinder shell seen from outside has maximum thickness at its centre,
        // which is exactly a sin() of the wrap coordinate.
        float wrap = vUv.x * 6.28318530718;
        float thickness = abs(sin(wrap));      // 0 at silhouette, 1 through the axis
        float radial = pow(thickness, 1.6);

        // Longitudinal fade so a beam does not end in a flat disc.
        float ends = smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.96, vUv.y);

        // Travelling pulses. One draw call, zero CPU animation.
        float flow = 1.0;
        if (uFlowSpeed > 0.0) {
          float p = fract(vUv.y * uFlowCount - uTime * uFlowSpeed);
          flow = 0.35 + 0.65 * pow(1.0 - p, 3.0);
        }

        // Soft depth clip so the beam does not hard-edge into the floor.
        vec2 suv = gl_FragCoord.xy / uResolution;
        float sceneZ = linearDepth(texture2D(uDepth, suv).r);
        float fragZ = linearDepth(gl_FragCoord.z);
        float soft = clamp((sceneZ - fragZ) / uSoftness, 0.0, 1.0);

        float a = radial * ends * flow * soft;
        gl_FragColor = vec4(uColor * uGain * a * uFocusWeight, a);
      }
    `,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    toneMapped: false,
  });
```

Beam radial segment counts: low 6, medium 10, high 16. On low tier `uSoftness` reads from a
quarter-resolution depth copy and the flow term is disabled on any beam beyond 40 m.

**Use for:** wait-for graph edges under contention, IPC channels, DMA transfers, the
scheduler's dispatch beam, the write-back path to the platter, the Portal aperture.

### 3.5 Derezz glass

The material an object wears while it is dissolving, and the material of anything the
simulation considers in transition (a page in flight, a block being journalled).

High tier uses real transmission. Medium and low use a fresnel rim on an opaque body,
which reads nearly identically at the sizes involved and costs a tenth as much.

```ts
export const derezzGlass = (token: SemanticToken, tier: QualityTier) => {
  if (tier === 'high') {
    return new MeshPhysicalMaterial({
      color: new Color(VOID.surface),
      emissive: new Color(token.hex),
      emissiveIntensity: gainFor(token.family, 'active'),
      transmission: 0.92,
      thickness: 0.35,
      ior: 1.34,
      roughness: 0.08,
      metalness: 0.0,
      attenuationColor: new Color(token.hex),
      attenuationDistance: 0.8,
      transparent: true,
      toneMapped: false,
    });
  }
  // Medium / low: opaque body, fresnel rim, no refraction, no extra render pass.
  const m = new MeshStandardMaterial({
    color: new Color(VOID.surface),
    emissive: new Color(token.hex),
    emissiveIntensity: gainFor(token.family, 'active'),
    roughness: 0.15,
    metalness: 0.0,
    transparent: true,
    opacity: 0.55,
    toneMapped: false,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
        totalEmissiveRadiance *= 0.18 + 1.6 * f;
      `);
  };
  return m;
};
```

`transmission` on high tier forces Three to render a transmission sample of the scene, so
the count of transmissive objects on screen is capped at 8. Beyond that the factory
silently returns the medium-tier material. That cap is enforced in code rather than left to
discipline.

### 3.6 Holographic label

Text in world space. Rendered by `troika-three-text`, which rasterises SDF glyphs from the
loaded web font at runtime, so no atlas image ships.

```ts
import { Text } from 'troika-three-text';

export const holoLabel = (opts: {
  text: string;
  token: SemanticToken;
  /** World-space height of a capital letter, in metres. */
  capHeight: number;
  anchor: Object3D;
  offset: Vector3;
}) => {
  const t = new Text();
  t.text = `${opts.token.glyph} ${opts.text}`;
  t.font = FONT_URL.mono;
  t.fontSize = opts.capHeight / 0.72;   // JetBrains Mono cap height ratio
  t.letterSpacing = 0.04;
  t.color = new Color(opts.token.hex);
  t.outlineWidth = 0;                    // outlines fight the bloom; use the plate
  t.material.toneMapped = false;
  t.sdfGlyphSize = 64;                   // 48 on low tier
  t.anchorX = 'left';
  t.anchorY = 'middle';
  t.layers.set(LAYER.TEXT);              // rendered after tone mapping, see 4.7
  t.renderOrder = 3000;
  t.depthOffset = -1;                    // avoids z-fighting with its backing plate
  return t;
};
```

Every holographic label is accompanied by a backing plate: a `PlaneGeometry` sized to the
text's measured bounds plus 0.06 m padding, `MeshBasicMaterial` with
`color: VOID.base, transparent: true, opacity: 0.92`, composed after tone mapping with the
text (section 2.6 rule 2 needs the plate in display space to hold its contrast bound), so
the plate itself receives no bloom. The separation from the void comes from the hairline:
a 0.006 m emissive hairline in the world stage runs along the plate's
bottom edge in the label's token colour.

### 3.7 Reflective floor

Wet floor is half the film look and it is the single largest performance decision in the
renderer. Three implementations, one per tier.

**High tier: planar reflection.** A `WebGLRenderTarget` at half viewport resolution, camera
mirrored through the floor plane, rendering only `LAYER.WORLD` and only objects flagged
`castsReflection` (emissive geometry and beams, never the matte bodies, which contribute
almost nothing and cost everything). Roughness is faked by sampling the reflection texture
with an offset proportional to distance below the horizon.

```glsl
// Fragment shader for the floor, high tier.
uniform sampler2D uReflection;
uniform vec2 uResolution;
uniform float uRoughness;       // 0.14 default: a polished but not mirror floor
uniform vec3 uFloorTint;

void main() {
  vec2 suv = gl_FragCoord.xy / uResolution;

  // Grazing-angle fresnel. At normal incidence the floor is nearly black; at
  // grazing it approaches a mirror. This is the whole trick.
  float ndv = clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // Distance-scaled blur: sample further from the exact reflection point the
  // further the reflected object is, which mimics a rough surface for free.
  float blur = uRoughness * (1.0 - ndv) * 0.06;
  vec3 refl = vec3(0.0);
  refl += texture2D(uReflection, suv + vec2( blur,  0.0)).rgb;
  refl += texture2D(uReflection, suv + vec2(-blur,  0.0)).rgb;
  refl += texture2D(uReflection, suv + vec2( 0.0,  blur)).rgb;
  refl += texture2D(uReflection, suv + vec2( 0.0, -blur)).rgb;
  refl *= 0.25;

  // Reflections are always dimmer than their source. 0.42 is the ceiling.
  gl_FragColor = vec4(uFloorTint + refl * fres * 0.42, 1.0);
}
```

**Medium tier: mirrored emissive proxy.** No render target. The world layer keeps a second
scene graph containing only the emissive line geometry, transformed by
`scale(1, -1, 1)` about the floor plane, rendered with `depthWrite: false`, `opacity` fading
by `exp(-height * 0.22)`, and the grazing fresnel evaluated on the floor's own material as a
multiplier. Cost is one extra draw call per reflective object with no target switch.

**Low tier: floor pools only.** No reflection at all. Each emitter drops an additive decal
quad on the floor beneath it, sized `2.5 x` the emitter's footprint, coloured by its token
at `EMISSIVE_GAIN.ambient`, with a radial falloff of `pow(1 - r, 2.2)`. This is also present
on medium and high, underneath the reflection, because it is what communicates contact with
the ground.

---

## 4. The post-processing chain

Implemented in `src/render/PostChain.ts` as an explicit ordered list of passes over
ping-pong `WebGLRenderTarget`s. Three's `EffectComposer` is used as the plumbing, with
custom passes throughout. All intermediate targets are `HalfFloatType` (`RGBA16F`).

### 4.1 Pass order

| # | Pass | Target format | Resolution | Rationale for this position |
|---|---|---|---|---|
| 1 | Scene render, `LAYER.WORLD` | RGBA16F, MSAA 4x (high) | full | Everything downstream needs scene-referred HDR. MSAA on the HDR target rather than post-AA because emissive hairlines against black alias catastrophically and post-AA cannot recover a sub-pixel line. |
| 2 | Depth resolve | R32F | full | Beams and DOF need linear depth. Resolved once and shared. |
| 3 | Depth of field (high only) | RGBA16F | half | Before bloom, so that a defocused emitter's bloom is also soft. Applying it after bloom produces sharp halos around blurred objects, which reads as a bug. |
| 4 | Bright pass | RGBA16F | half | Threshold above the `dim` gain. Half resolution because bloom is low-frequency by definition. |
| 5 | Dual-Kawase downsample chain | RGBA16F | 1/2 to 1/64 | 6 levels. See 4.4. |
| 6 | Dual-Kawase upsample chain with per-level tint | RGBA16F | back to 1/2 | Tinting on the way up is what makes bloom look photographic. See 4.5. |
| 7 | Volumetric light scattering (high only, conditional) | RGBA16F | quarter | Radial blur from a screen-space source, only when a registered beam source is on screen and unoccluded. Runs after bloom so the god-ray source is already bright. |
| 8 | Composite | RGBA16F | full | Adds bloom and scattering to the scene colour. Everything after this is a look operation on a single buffer. |
| 9 | Chromatic aberration | RGBA16F | full | Before grain, so grain is not smeared by the channel offset. |
| 10 | Film grain | RGBA16F | full | Before tone mapping, so grain lives in scene-referred values and the tone curve compresses it in the highlights the way film does. |
| 11 | Vignette | RGBA16F | full | Before tone mapping for the same reason: a vignette applied after the curve looks like a black overlay, applied before it looks like a lens. |
| 12 | Tone map + output transform + dither | RGBA8 (sRGB) | full | AgX. See 4.8. |
| 13 | Scene render, `LAYER.TEXT` | same RGBA8 | full | World-space text drawn after tone mapping so no glyph is ever bloomed or crushed. Uses the same camera and depth buffer as pass 1. |
| 14 | HUD (DOM) | n/a | full | The HUD is DOM over the canvas. It is not a render pass and it costs nothing on the GPU. |

Passes 9 through 12 are merged into a single fragment shader in the shipping build. They
are listed separately because they are conceptually separate and because each has its own
uniform block, and they are separate passes in the debug build so any one can be toggled.

### 4.2 Cost, measured on the target machine

Apple M2 MacBook Air, 1440x900, integrated GPU, high tier, a leg-8 scene with 180 hex tiles
and 12 beams. Times are GPU milliseconds per frame from a timer query.

| Pass | Cost (ms) | Notes |
|---|---|---|
| Scene render | 3.9 | MSAA 4x resolve included |
| Depth resolve | 0.2 | |
| DOF | 1.1 | only while the focus camera is locked |
| Bright pass | 0.3 | |
| Down chain (6 levels) | 0.9 | |
| Up chain (6 levels) | 1.1 | |
| Volumetric scattering | 1.4 | conditional, and off in most legs |
| Composite + CA + grain + vignette + tonemap | 0.7 | merged |
| Text pass | 0.4 | |
| **Total** | **~10.0** | against a 16.6 ms budget |

Medium tier removes DOF, scattering, and MSAA (SMAA instead at 0.5 ms), reaching about
5.8 ms. Low tier drops to 4 bloom levels at quarter resolution and reaches about 3.1 ms.

### 4.3 Bright pass

```glsl
uniform sampler2D tDiffuse;
uniform float uThreshold;   // 1.15
uniform float uKnee;        // 0.55
varying vec2 vUv;

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // Soft knee, so a value crossing the threshold does not pop on and off as the
  // camera moves. Without this, a hairline at gain 1.14 flickers when it drifts
  // to 1.16 across a frame.
  float soft = lum - uThreshold + uKnee;
  soft = clamp(soft, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contribution = max(soft, lum - uThreshold) / max(lum, 1e-5);

  gl_FragColor = vec4(c * contribution, 1.0);
}
```

The threshold at 1.15 is chosen against `EMISSIVE_GAIN`, but the bright pass compares
scene-referred luminance, not gain, and the soft knee (0.55) starts contributing at
1.15 - 0.55 = 0.60. So `ambient` (0.45) never blooms; `dim` (1.10) on the brightest core
colours barely reaches the knee's foot; `active` (1.85) on `CYAN.core` has luminance about
1.07, inside the knee, and produces a soft, partial halo; `hot` (3.20) and `critical`
(4.60) clear the threshold outright and produce the flares. (Corrected 2026-09-14: the
earlier text equated gain with luminance.) This is why the grid floor and
idle structure stay crisp while working structure glows, and it is why changing the gain
table without revisiting the threshold breaks the whole image.

### 4.4 Dual-Kawase, and why not separable Gaussian

A separable Gaussian large enough to produce a cinematic halo needs a kernel radius in the
tens of pixels, which means two passes of 30-plus taps per bloom level. Dual-Kawase reaches
the same effective radius with 5 taps down and 8 taps up per level, exploiting bilinear
filtering to do the weighting. On integrated graphics the difference is roughly 3x.

```glsl
// Downsample: 5 taps, one at centre and four at half-texel diagonal offsets.
vec3 kawaseDown(sampler2D t, vec2 uv, vec2 halfTexel) {
  vec3 sum = texture2D(t, uv).rgb * 4.0;
  sum += texture2D(t, uv - halfTexel).rgb;
  sum += texture2D(t, uv + halfTexel).rgb;
  sum += texture2D(t, uv + vec2(halfTexel.x, -halfTexel.y)).rgb;
  sum += texture2D(t, uv - vec2(halfTexel.x, -halfTexel.y)).rgb;
  return sum * 0.125;
}

// Upsample: 8 taps in a tent, which is what removes the boxy artefacts you get
// from a naive bilinear upscale of a heavily downsampled buffer.
vec3 kawaseUp(sampler2D t, vec2 uv, vec2 halfTexel) {
  vec3 sum = vec3(0.0);
  sum += texture2D(t, uv + vec2(-halfTexel.x * 2.0, 0.0)).rgb;
  sum += texture2D(t, uv + vec2(-halfTexel.x, halfTexel.y)).rgb * 2.0;
  sum += texture2D(t, uv + vec2(0.0, halfTexel.y * 2.0)).rgb;
  sum += texture2D(t, uv + vec2(halfTexel.x, halfTexel.y)).rgb * 2.0;
  sum += texture2D(t, uv + vec2(halfTexel.x * 2.0, 0.0)).rgb;
  sum += texture2D(t, uv + vec2(halfTexel.x, -halfTexel.y)).rgb * 2.0;
  sum += texture2D(t, uv + vec2(0.0, -halfTexel.y * 2.0)).rgb;
  sum += texture2D(t, uv + vec2(-halfTexel.x, -halfTexel.y)).rgb * 2.0;
  return sum * 0.0833333;
}
```

### 4.5 Bloom that reads cinematic rather than washed out

Four numbers control this, and all four matter.

**Threshold, 1.15.** High enough that no inert geometry contributes. If the threshold drops
to 0.8, the grid floor starts blooming, and a bloomed grid floor is the single fastest way
to turn this look into mush.

**Level count, 6 on high, 5 on medium, 4 on low.** Level 0 at half resolution gives the
tight core halo that sells "hard-edged light". Levels 4 and 5, at 1/32 and 1/64, give the
wide, faint field glow that sells "vast dark space". Cutting the top levels loses the
crispness. Cutting the bottom levels loses the scale.

**Per-level weights, front-loaded.** The composite is
`bloom = Σ level[i] * weight[i]` with weights
`[1.00, 0.62, 0.37, 0.21, 0.12, 0.07]`, normalised, then multiplied by a global strength of
`0.055`. That global strength is low. Bloom in this game is an accent on a mostly black
frame, and the perceived intensity comes from the HDR gains rather than from the bloom
strength. A strength above 0.09 washes.

**Tint, per level, cooling on the way up.**

```ts
/** Multiplied into each level during the upsample chain. Wider levels are
 *  progressively cooler and slightly desaturated, which is what a real lens does
 *  to a bright source and what keeps a big amber flare from turning the whole
 *  frame orange. */
export const BLOOM_TINT: readonly [number, number, number][] = [
  [1.00, 1.00, 1.00],
  [0.98, 1.00, 1.02],
  [0.94, 0.99, 1.05],
  [0.90, 0.97, 1.09],
  [0.86, 0.95, 1.13],
  [0.82, 0.93, 1.18],
];
```

Two further rules. Bloom never samples the text layer, because text is drawn after tone
mapping. And the bloom buffer is clamped to 12.0 before the down chain, which stops a
single `critical` flare from producing a full-screen white field for one frame during a
derezz.

### 4.6 Kernel panic

`kernel.panic` is the only event permitted to change the global post configuration. For
900 ms the bright-pass threshold drops to 0.35, the bloom tint is forced to
`AMBER.white`, the global strength ramps to 0.22, and the vignette contracts by 30%. The
frame floods amber and everything reads as blown out, which is the intent, and it is the
only moment in the game where the look is deliberately broken. It then cuts to black over
120 ms.

### 4.7 Chromatic aberration, grain, vignette, text

```glsl
// Chromatic aberration: extreme edges only.
vec3 chromatic(sampler2D t, vec2 uv, vec2 texel, float uMaxPx) {
  vec2 c = uv - 0.5;
  float r = length(c) * 1.41421356;              // 0 at centre, 1 at corner
  float mask = smoothstep(0.62, 1.0, r);         // nothing at all inside r=0.62
  vec2 dir = normalize(c + 1e-6) * texel * uMaxPx * mask;
  return vec3(
    texture2D(t, uv + dir).r,
    texture2D(t, uv).g,
    texture2D(t, uv - dir).b
  );
}
// uMaxPx = 1.6 on high, 1.0 on medium, 0 on low.
```

```glsl
// Film grain. Triangular-distributed, weighted toward the shadows the way film
// grain actually behaves, and doubling as a dither that hides banding in the
// near-black void, which is the real reason it is here.
float triNoise(vec2 uv, float t) {
  float a = fract(sin(dot(uv + t, vec2(12.9898, 78.233))) * 43758.5453);
  float b = fract(sin(dot(uv - t, vec2(39.3468, 11.1357))) * 24634.6345);
  return a + b - 1.0;                            // triangular in [-1, 1]
}

vec3 grain(vec3 c, vec2 uv, float t, float uAmp) {
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float shadowWeight = 0.4 + 0.6 * (1.0 - clamp(lum, 0.0, 1.0));
  return c + triNoise(uv * 1024.0, t) * uAmp * shadowWeight;
}
// uAmp = 0.012 on high and medium, 0.008 on low. Above 0.02 it reads as noise
// rather than as film, and it destroys the crispness of the hairlines.
```

```glsl
// Vignette. Applied pre-tonemap so it darkens exposure rather than painting black.
float vignette(vec2 uv, float uStrength, float uPower) {
  vec2 c = (uv - 0.5) * 2.0;
  float v = 1.0 - dot(c, c) * uStrength;
  return pow(clamp(v, 0.0, 1.0), uPower);
}
// uStrength = 0.34, uPower = 1.8 default. During a focus lock these ramp to
// 0.52 and 2.1 over the focus duration, which tunnels attention onto the read
// plane without a single UI element appearing.
```

### 4.8 Tone mapping: AgX

Use **AgX**. `THREE.AgXToneMapping` exists in Three r166 and later; the composite shader
implements it directly so the operator is under our control and applies at a known point in
the chain.

Why AgX and not the alternatives:

- **Reinhard** desaturates uniformly and never reaches a true white, so a `critical` flare
  looks grey and weak. It also lifts the blacks, which is fatal in a game that is 62% black.
- **ACES Filmic** skews hue as values climb. Saturated cyan pushes toward blue-white and
  saturated amber pushes toward yellow, so the two semantic families converge in exactly
  the region where the player most needs them separated (a bright running process against a
  bright fault).
- **AgX** rolls highlights off toward white while holding hue far longer, and its long toe
  keeps near-black values separated instead of crushing them to zero. Both properties are
  what this specific image needs.

```glsl
// AgX, compact form. Matches Three's implementation closely enough to swap.
// IMPORTANT: these two matrices are shown to document the operator's structure.
// Take the shipping values from Three.js (see the implementation note below).
const mat3 AGX_IN  = mat3(
  0.8566271, 0.1373401, 0.1118120,
  0.0951212, 0.7612377, 0.0767936,
  0.0482516, 0.1014706, 0.8113083
);
const mat3 AGX_OUT = mat3(
   1.1271006, -0.1413297, -0.1413720,
  -0.1106066,  1.1578237, -0.1010000,
  -0.0164848, -0.0164666,  1.1244000
);

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return  15.5     * x4 * x2
        - 40.14    * x4 * x
        + 31.96    * x4
        -  6.868   * x2 * x
        +  0.4298  * x2
        +  0.1191  * x
        -  0.00232;
}

vec3 agx(vec3 color) {
  const float MIN_EV = -12.47393;
  const float MAX_EV =   4.026069;
  color = AGX_IN * max(color, vec3(0.0));
  color = clamp(log2(color + 1e-10), MIN_EV, MAX_EV);
  color = (color - MIN_EV) / (MAX_EV - MIN_EV);
  color = agxContrast(color);
  color = AGX_OUT * color;
  // Punchy look: a small saturation lift after the curve restores the chroma
  // AgX intentionally removes, without reintroducing the ACES hue skew.
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(lum), color, 1.18);
  return clamp(color, 0.0, 1.0);
}
```

**Implementation note.** Do not hand-transcribe the AgX matrices. Import them from Three's
`ToneMappingShaderChunk` or copy them verbatim from `three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js`.
The two constants above are shown to document the structure of the operator, and the
correct values must come from the library.

Exposure is fixed at `1.0`. There is no auto-exposure anywhere in this game. Auto-exposure
in a scene that is mostly black will hunt every time a bright object enters frame, and
because emission carries meaning, an adaptive exposure would make identical states look
different depending on what else is on screen.

### 4.9 Banding, and why dithering is not optional

An 8-bit output of a scene whose luminance range sits mostly between 0.0 and 0.02 will band
visibly, and the bands will appear as concentric rings around every bloom halo. Three
mitigations, all mandatory:

1. Every intermediate target is `HalfFloatType`. No 8-bit intermediates anywhere.
2. `dithering: true` on every `MeshStandardMaterial` and `MeshPhysicalMaterial`.
3. A final ordered-dither in the output transform, applied after AgX and before the write:

```glsl
float bayer8(vec2 p) {
  // 8x8 ordered dither, computed rather than sampled from a texture.
  ivec2 i = ivec2(mod(p, 8.0));
  int idx = i.y * 8 + i.x;
  // Standard 8x8 Bayer matrix flattened, values 0..63.
  int m[64] = int[64](
     0,32, 8,40, 2,34,10,42,  48,16,56,24,50,18,58,26,
    12,44, 4,36,14,46, 6,38,  60,28,52,20,62,30,54,22,
     3,35,11,43, 1,33, 9,41,  51,19,59,27,49,17,57,25,
    15,47, 7,39,13,45, 5,37,  63,31,55,23,61,29,53,21
  );
  return float(m[idx]) / 64.0 - 0.5;
}
// out = agx(c) + bayer8(gl_FragCoord.xy) / 255.0;
```

WebGL2 requires the array to be a `const int[64]`, and some drivers dislike dynamic
indexing into it. If profiling shows a problem, generate a 8x8 `DataTexture` at startup in
TypeScript, which is still procedural and still ships no asset.

---

## 5. Geometry language

Every form below is generated in code. The generator function is named for each one, and
all of them live under `src/world/forms/`.

### 5.1 The vocabulary

| Concept | Form | Generator | Dimensions |
|---|---|---|---|
| Process | Upright hexagonal prism, a stele | `makeStele()` | 0.90 m across flats, 2.40 m tall |
| Thread | Filament orbiting its parent stele | `makeFilament()` | 0.012 m radius, orbit radius 0.62 m |
| CPU | A single tall column at the head of the ready procession | `makeCpuColumn()` | 1.6 m across, 6.0 m tall |
| Resource type | Vertical ring on a plinth, segmented by instance count | `makeResourceRing()` | 1.4 m outer radius, 0.09 m tube |
| Mutex | One-leaf gate across a walkway | `makeGate(1)` | 2.0 m span |
| Semaphore | Gate with `capacity` slots, each slot a lit bay | `makeGate(n)` | 0.8 m per slot |
| Monitor | Enclosed chamber with one gate and a condition alcove | `makeMonitor()` | 4.0 m diameter |
| Memory frame | Floor-embedded slab socket in a vault grid | `makeFrameSocket()` | 2.00 x 2.00 x 0.25 m, 4.00 m pitch |
| Page | Thin plate that seats into a frame socket | `makePagePlate()` | 1.84 x 1.84 x 0.12 m |
| Page (leg 8) | Hexagonal tile on the water | `makeHexTile()` | 1.60 m circumradius |
| Data block | Cube | `makeBlock()` | 0.50 m |
| Inode | Lathe-turned spindle with radial index arms | `makeSpindle()` | 0.6 m radius, 1.8 m tall |
| Disk platter | Lathe disc with a concentric cylinder groove pattern | `makePlatter()` | 6.0 m radius, 0.08 m thick |
| Disk head arm | Extruded taper with a lit tip | `makeHeadArm()` | 5.2 m long |
| Device | Bollard with a readout face and an interrupt spike | `makeBollard()` | 0.6 m across, 1.8 m tall |
| Protection ring | Concentric wall of vertical lattice | `makeRingWall()` | radius by ring: 96, 64, 36, 16 m |
| Journal | Ribbon of linked plates running along the floor | `makeJournalRibbon()` | 0.4 m wide |
| Portal | Vertical aperture of parallel beams | `makePortal()` | 8 m wide, 20 m tall |

The design logic behind the shape choices: anything that **executes** is vertical and
hexagonal, anything that **stores** is horizontal and rectangular, anything that
**guards** is a ring or a gate, and anything that **moves data** is a beam. A player who
learns those four families in leg 0 can read an unfamiliar structure in leg 11.

### 5.2 The process stele

```ts
// src/world/forms/stele.ts
export function makeStele(): BufferGeometry {
  // A hexagonal prism with a 4 cm chamfer at both ends, so the emissive edge
  // geometry has a face to sit against instead of a knife edge that aliases.
  const R = 0.90 / 2 / Math.cos(Math.PI / 6);   // circumradius from across-flats
  const H = 2.40;
  const CHAMFER = 0.04;

  const profile: Vector2[] = [
    new Vector2(0, 0),
    new Vector2(R - CHAMFER, 0),
    new Vector2(R, CHAMFER),
    new Vector2(R, H - CHAMFER),
    new Vector2(R - CHAMFER, H),
    new Vector2(0, H),
  ];
  // Lathe with 6 radial segments gives a hexagonal prism with chamfered ends
  // and correct normals, from six points of code and no modelling.
  const g = new LatheGeometry(profile, 6, Math.PI / 6, Math.PI * 2);
  g.computeVertexNormals();
  return g;
}
```

State is expressed on the stele by, in order of visual weight: the emissive edge set (all
18 edges, dash-coded), the height scale (starvation shortens it), the front-face bar
(blocked), the orbiting quantum ring (running), and the filaments (threads). Its label
floats 0.35 m above the top face.

`serviceRemaining` is shown as a fill line: a horizontal emissive band whose height is
`H * (serviceRemaining / initialService)`, so a process visibly empties as it runs. This is
the single most useful readout in the game and it is legible at 40 m.

### 5.3 Grid floor construction

The floor is two triangles and a shader. There is no grid texture and no grid geometry.

```ts
// src/world/forms/gridFloor.ts
// A single PlaneGeometry(1, 1) scaled to 4000 x 4000, positioned at y = 0, and
// re-centred every frame on the camera's XZ position snapped to the major pitch.
// Snapping is what stops the grid crawling when the camera moves.
plane.position.set(
  Math.round(camera.position.x / 4) * 4,
  0,
  Math.round(camera.position.z / 4) * 4
);
```

```glsl
// Analytic anti-aliased grid. Two scales, both derived from the same 4.00 m
// module that section 1.7 requires every leg to use.
uniform float uMinor;      // 0.50 m
uniform float uMajor;      // 4.00 m
uniform vec3  uMinorColor; // CYAN.trace
uniform vec3  uMajorColor; // CYAN.dim
uniform float uFadeStart;  // 55 m
uniform float uFadeEnd;    // 420 m
varying vec3 vWorld;

float gridLine(vec2 p, float pitch, float widthPx) {
  vec2 c = p / pitch;
  vec2 d = abs(fract(c - 0.5) - 0.5) / fwidth(c);
  float line = min(d.x, d.y);
  // widthPx controls thickness in screen pixels, so a distant line thins out
  // and disappears cleanly instead of shimmering.
  return 1.0 - smoothstep(0.0, widthPx, line);
}

void main() {
  float dist = length(vWorld.xz - cameraPosition.xz);

  // Fade the minor grid out first, then the major, so density stays constant in
  // screen space as the floor recedes. This is the depth cue that replaces fog.
  float fadeMinor = 1.0 - smoothstep(uFadeStart * 0.25, uFadeStart, dist);
  float fadeMajor = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);

  float minor = gridLine(vWorld.xz, uMinor, 1.0) * fadeMinor;
  float major = gridLine(vWorld.xz, uMajor, 1.6) * fadeMajor;

  vec3 c = uMinorColor * minor * 0.45 + uMajorColor * major * 1.10;

  // Both terms sit at or below EMISSIVE_GAIN.dim so the floor never blooms.
  gl_FragColor = vec4(c, 1.0);
}
```

The major grid at 4.00 m is the module from principle 1.7. Every structure in every leg
snaps to it, so the player counts squares without being told to.

### 5.4 Horizon and skybox in a black void

There is no skybox texture, no HDRI, no procedural sky, and no stars. Stars would place the
scene outdoors, and this scene is inside a machine. The clear colour is `VOID.base` and the
sense of a horizon is built from three constructed elements:

**The horizon line.** A single emissive line ring at radius 900 m, at `y = 0`, in
`CYAN.trace` at `EMISSIVE_GAIN.ambient`, 0.06 m world width. It is a hairline in screen
space at that distance, and its whole job is to state that the floor ends and to give the
reflection pass a top boundary. Per-leg it may be amber (leg 6, leg 12) or absent (leg 8,
where the ocean has no far edge).

**Distant columns.** 120 to 400 vertical light columns placed by the leg's `Rng` between
400 m and 1400 m, on an annulus, drawn as a single `InstancedMesh` of a 2-triangle billboard
quad with an emissive gradient shader. Height varies from 20 m to 240 m, gain fixed at
`ambient`, so they never bloom. They exist for parallax. They are the only thing in the
scene that tells the eye the camera is moving through space rather than orbiting a diorama,
and they cost one draw call.

**The gradient band.** A 60 m tall cylinder shell at radius 880 m, inward-facing,
vertically graded from `VOID.horizon` at the base to `VOID.base` at the top with the
dithered gradient from 4.9. It lifts the bottom of the frame by roughly 0.008 in luminance,
which is enough for the eye to read depth and low enough to keep the 62% dark budget.

Nothing else is above the horizon, ever. Legs that need overhead structure hang it from
geometry, and the geometry is visibly supported.

### 5.5 Edge lighting on hard-surface geometry

Two techniques, used together.

**Technique A, explicit edge geometry.** For any object with fewer than 64 edges, build a
`LineSegments2` from `new EdgesGeometry(bodyGeometry, 1)`, offset outward along the vertex
normal by 0.004 m so it does not z-fight, and give it the emissive line material from 3.2.
This is the primary technique because it gives exact control over dash patterns per edge,
which the shape channel in 2.5 depends on.

**Technique B, barycentric edge term in the body shader.** For instanced geometry where a
separate line object per instance is unaffordable (page slabs, blocks, hex tiles), bake a
barycentric attribute at generation time and brighten the body shader near edges.

```ts
// Bake once, at generation. Requires non-indexed geometry.
export function addBarycentric(g: BufferGeometry): BufferGeometry {
  const nonIndexed = g.index ? g.toNonIndexed() : g;
  const count = nonIndexed.attributes.position.count;
  const bary = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 3) {
    bary.set([1, 0, 0,  0, 1, 0,  0, 0, 1], i * 3);
  }
  nonIndexed.setAttribute('aBary', new BufferAttribute(bary, 3));
  return nonIndexed;
}
```

```glsl
varying vec3 vBary;
uniform float uEdgeWidthPx;   // 1.4
uniform vec3  uEdgeColor;
uniform float uEdgeGain;

float edgeFactor() {
  vec3 d = fwidth(vBary);
  vec3 a = smoothstep(vec3(0.0), d * uEdgeWidthPx, vBary);
  return 1.0 - min(min(a.x, a.y), a.z);
}
// totalEmissiveRadiance += uEdgeColor * uEdgeGain * edgeFactor();
```

Technique B lights every triangle edge including internal ones, which is wrong for most
shapes. Two fixes: generate the geometry so that its triangulation matches its intended
edges (true for boxes, hexagonal prisms, and the hex tiles), or add a per-vertex
`aEdgeMask` that zeroes the term on internal edges. `makeHexTile` and `makeBlock` do the
former, and the shape vocabulary was chosen partly so that this works.

### 5.6 Communicating scale without atmosphere

Six cues, all of which must be present in an establishing shot:

1. **The module.** 4.00 m grid, every structure snapped to it, receding at least 64 squares.
2. **The ruler.** A 2.40 m process stele visible in every leg at a known distance. The stele
   never changes size, so the player calibrates once and it holds for fourteen legs.
3. **Repetition count.** Structures repeat rather than scale. A vault holding 256 frames is
   a 16 x 16 grid of identical 2 m slabs on a 4 m pitch, so it is 64 m across and reads as
   64 m across because it can be counted.
4. **Emissive distance attenuation.** Emission is multiplied by
   `exp(-distance * 0.0016)` in the line and panel shaders, which is not physically correct
   for a vacuum and is the substitute for atmospheric perspective. At 400 m an emitter is at
   53% intensity. Without this term, distant structure reads as small near structure and the
   scene collapses to a flat image.
5. **Parallax field.** The distant columns from 5.4.
6. **Vertical extent.** Every leg has at least one structure whose top is above 40 m, so the
   camera has something to look up at. In a black void, "up" is the only free axis and the
   only way to make a space feel oppressive.
---

## 6. The focus camera

This is the system that makes a 3D-only game readable. Reading a 16 x 16 page table in
perspective is genuinely hard, and the standard solution is to open a flat 2D panel, which
the design brief forbids. The focus camera solves it by moving the camera instead of
leaving the world.

### 6.1 Behaviour, in order

**Free.** An orbit-and-follow camera trailing the convoy. Perspective, `fov` 46 degrees,
`near` 0.1, `far` 2000. Pitch clamped to `[-8, 62]` degrees, distance `[6, 90]` m. It
damps toward its target with a critically damped spring at `omega = 9.0`, so it never
overshoots and never feels loose.

**Engaging.** The player targets a diegetic anchor (defined by
`InteractionDef.anchor`, exposed by `LegStage.anchor(id)`) and presses the focus key, or
clicks it. Over 520 ms the camera arcs to a pose square-on to the anchor's reading plane,
its projection blends from perspective to orthographic, everything outside the focus set
dims, labels rotate to the plane, and the vignette tightens.

**Locked.** Orthographic, square-on, with the structure framed to fill 78% of the smaller
viewport axis. The simulation keeps running. Beams still flow, states still change, and the
player can act. Limited input is allowed: pan within the plane (clamped so the structure
never leaves frame), zoom between 0.6x and 1.6x of the framing, and a cursor for selecting
sub-elements. Rotation is disabled, which is the point.

**Releasing.** 380 ms back to the free camera's current target pose, which has been
tracking the convoy the whole time, so the release lands where the player expects.

### 6.2 The interface

```ts
// src/render/FocusCamera.ts
import { Camera, Matrix4, Object3D, PerspectiveCamera, Quaternion, Vector2, Vector3 } from 'three';

export type FocusMode = 'free' | 'engaging' | 'locked' | 'releasing';

/** A diegetic structure the camera can lock onto. Legs register these from
 *  createStage and address them by the same string that InteractionDef.anchor uses. */
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
  /** Objects that stay at full brightness during the lock. The anchor's subtree
   *  is included automatically; add cross-references such as the beams into a
   *  wait-for graph. */
  readonly focusSet: readonly Object3D[];
  /** How far everything outside the focus set is pushed down. 0 = no dimming,
   *  1 = fully dark. 0.82 default. */
  readonly dimOthers: number;
  /** Whether world-space labels inside the focus set snap to the plane. */
  readonly labelPlane: 'billboard-to-focus' | 'billboard-to-camera';
  /** Minimum world height a glyph must subtend, in metres, at the framed
   *  distance. The framing is expanded if the structure's label density would
   *  push text below this. */
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
  readonly camera: PerspectiveCamera;   // one camera, always; see 6.3
  readonly state: FocusCameraState;
  register(target: FocusTarget): void;
  unregister(id: string): void;
  engage(id: string): boolean;
  release(): void;
  /** Called once per frame before rendering. */
  update(dtSeconds: number): void;
  /** 1 for objects in the focus set, lerp(1, 1 - dimOthers, blend) otherwise.
   *  Every material's uFocusWeight uniform is driven from this. */
  focusWeight(o: Object3D): number;
}
```

### 6.3 One camera, blended projection

There is exactly one `PerspectiveCamera` in the scene. Swapping to an
`OrthographicCamera` at the end of the transition produces a visible pop, because the two
projections disagree everywhere except at one depth. Instead, both projection matrices are
built each frame and blended element-wise into the single camera's `projectionMatrix`.

The blend is artefact-free at the focus plane because the orthographic frustum height is
chosen so the two projections agree exactly there.

```ts
const _persp = new Matrix4();
const _ortho = new Matrix4();

/**
 * Blend perspective into orthographic. `focusDistance` is the distance from the
 * camera to the reading plane. Choosing orthoHeight = 2 * d * tan(fov/2) makes
 * both matrices map the focus plane to identical screen coordinates, so the
 * element-wise lerp introduces no distortion where the player is looking. Off the
 * plane, the lerp is a smooth (if not projectively exact) morph, which is what
 * reads as the world flattening out.
 */
export function blendProjection(
  cam: PerspectiveCamera,
  aspect: number,
  fov: number,
  focusDistance: number,
  near: number,
  far: number,
  blend: number
): void {
  const halfH = Math.tan(fov * 0.5) * focusDistance;
  const halfW = halfH * aspect;

  _persp.makePerspective(
    -halfW * near / focusDistance,
     halfW * near / focusDistance,
     halfH * near / focusDistance,
    -halfH * near / focusDistance,
    near, far, cam.coordinateSystem
  );
  _ortho.makeOrthographic(-halfW, halfW, halfH, -halfH, near, far, cam.coordinateSystem);

  const p = _persp.elements;
  const o = _ortho.elements;
  const e = cam.projectionMatrix.elements;
  for (let i = 0; i < 16; i++) e[i] = p[i] + (o[i] - p[i]) * blend;
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}
```

`Frustum.setFromProjectionMatrix` still works on the blended matrix, so culling behaves
throughout the transition.

### 6.4 The transition maths

**Framing.** Given a target, compute the locked pose:

```ts
export function computeLockedPose(t: FocusTarget, aspect: number, fov: number): CameraPose {
  const m = t.anchor.matrixWorld;
  const centre = new Vector3().setFromMatrixPosition(m);
  const n = t.planeNormal.clone().transformDirection(m).normalize();
  const up = t.planeUp.clone().transformDirection(m).normalize();

  // Frame the larger of the two constraints: width against aspect, or height.
  const pad = 1 + t.padding;
  const needH = t.extents.y * pad;
  const needW = t.extents.x * pad;
  const orthoHeight = Math.max(needH, needW / aspect) / 0.78;   // fill 78% of the frame

  // Stand off far enough that the perspective start pose is not inside the
  // structure, and so that near-plane clipping cannot occur during the arc.
  const distance = (orthoHeight * 0.5) / Math.tan(fov * 0.5);

  const position = centre.clone().addScaledVector(n, distance);
  const quaternion = new Quaternion().setFromRotationMatrix(
    new Matrix4().lookAt(position, centre, up)
  );
  return { position, quaternion, fov, orthoHeight };
}
```

**Easing.** Two curves, deliberately asymmetric.

```ts
/** Cubic Bezier easing with x1,y1,x2,y2 in the CSS sense, solved by
 *  Newton-Raphson with a bisection fallback. 8 iterations is exact to ~1e-6. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const A = (a: number, b: number) => 1 - 3 * b + 3 * a;
  const B = (a: number, b: number) => 3 * b - 6 * a;
  const C = (a: number) => 3 * a;
  const calc = (t: number, a: number, b: number) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t: number, a: number, b: number) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t -= (calc(t, x1, x2) - x) / d;
    }
    return calc(t, y1, y2);
  };
}

export const EASE = {
  /** Engage. Leaves quickly, arrives slowly, settles without overshoot. The long
   *  tail is what makes the lock feel like the camera has come to rest rather
   *  than been snapped into place. */
  focusIn:  cubicBezier(0.16, 0.84, 0.24, 1.00),
  /** Release. Shorter and flatter. Letting go should not feel as considered as
   *  committing. */
  focusOut: cubicBezier(0.40, 0.00, 0.20, 1.00),
  snap:     cubicBezier(0.20, 0.00, 0.00, 1.00),
  settle:   cubicBezier(0.16, 0.84, 0.24, 1.00),
  out:      cubicBezier(0.33, 1.00, 0.68, 1.00),
  inOut:    cubicBezier(0.65, 0.00, 0.35, 1.00),
} as const;

export const FOCUS_DURATION_MS = { engage: 520, release: 380 } as const;
```

**Position path.** A straight lerp dollies the camera through whatever is between the two
poses. Use a cubic Bezier arc whose control points push out along each pose's own forward
axis and lift over any intervening geometry.

```ts
const _p1 = new Vector3(), _p2 = new Vector3(), _fwd = new Vector3();

export function focusPath(from: CameraPose, to: CameraPose, lift: number, t: number, out: Vector3): Vector3 {
  const d = from.position.distanceTo(to.position);
  const k = d * 0.40;

  _fwd.set(0, 0, -1).applyQuaternion(from.quaternion);
  _p1.copy(from.position).addScaledVector(_fwd, k).setY(from.position.y + lift);

  _fwd.set(0, 0, -1).applyQuaternion(to.quaternion);
  _p2.copy(to.position).addScaledVector(_fwd, -k).setY(to.position.y + lift);

  const u = 1 - t;
  return out.set(0, 0, 0)
    .addScaledVector(from.position, u * u * u)
    .addScaledVector(_p1,          3 * u * u * t)
    .addScaledVector(_p2,          3 * u * t * t)
    .addScaledVector(to.position,  t * t * t);
}
// lift = max(2, targetTopY - min(from.y, to.y)) * 0.35
```

**Rotation.** Quaternion slerp on a slightly leading schedule:
`slerp(from.q, to.q, ease(min(1, t * 1.12)))`. Rotation completing 12% ahead of position
means the target is centred before the camera stops moving, which removes the sensation of
the frame settling twice.

**Projection.** `blendProjection(camera, aspect, fov, distanceToPlane, near, far, blend)`
with the same eased `blend`. FOV is held constant at 46 degrees through the whole
transition; the flattening comes entirely from the projection blend.

### 6.5 Dimming outside the focus

Depth of field is not the primary mechanism here. Blurring emissive hairlines against black
turns them into soft smears, which contradicts principle 1.6 and costs a pass. The primary
mechanism is per-object attenuation.

```ts
focusWeight(o: Object3D): number {
  if (this.state.mode === 'free') return 1;
  const inSet = this.focusSetIds.has(o.id) || this.isDescendantOfFocus(o);
  if (inSet) return 1;
  const target = 1 - (this.state.target?.dimOthers ?? 0.82);   // 0.18
  return 1 + (target - 1) * this.state.blend;
}
```

`uFocusWeight` is a uniform on the line, panel, beam, and glass materials, updated once per
frame per material rather than per object, because materials are shared and objects are
grouped by focus membership. Unfocused emission drops to 18% of its gain, which puts most
of it below the bloom threshold, so the halos outside the focus disappear too. That
disappearance is what actually clears the frame; the dimming alone would leave a field of
glow.

Matte bodies outside the focus set have their `color` multiplied by 0.35 through the same
uniform, so unfocused structure recedes toward the void without going fully black, which
would be disorienting.

**Depth of field, high tier only, as a supporting cue.** Focus distance locked to the
reading plane, aperture producing a maximum circle of confusion of 3.0 px at 12 m off-plane,
applied at half resolution before the bright pass. It is a garnish. If the tier drops or the
frame budget is exceeded, DOF is the first thing removed and the lock still works.

### 6.6 Labels and the focus plane

While `blend < 0.5`, world-space labels billboard to the camera. While `blend >= 0.5` and
`labelPlane === 'billboard-to-focus'`, they slerp to the plane's quaternion using
`ease(smoothstep(0.5, 1.0, blend))`. Because the camera arrives square-on to that same
plane, labels finish parallel to the screen and unrotated, so the SDF text is sampled at
close to its authored size and stays crisp.

Label size in a locked frame is computed rather than authored, so a 16 x 16 page table and a
4-entry resource list produce the same on-screen glyph size:

```ts
/** World-space cap height that subtends exactly `pxTarget` device pixels in the
 *  locked orthographic framing. */
export function lockedCapHeight(orthoHeight: number, viewportHeightPx: number, pxTarget = 13): number {
  return (pxTarget / viewportHeightPx) * orthoHeight;
}
```

If a structure is dense enough that `lockedCapHeight` would fall below
`FocusTarget.minGlyphHeight`, the framing expands to a sub-region and the lock gains a pan
affordance rather than shrinking the type. Text never scales below 13 device pixels in this
game.

### 6.7 Why this keeps dense information readable

Four things happen at once, and all four are needed.

Orthographic projection makes every cell of a grid the same size on screen, so a page table
can be scanned by row and column rather than decoded through foreshortening. Square-on
framing puts every label in the same plane, so no glyph is rendered at a grazing angle where
SDF sampling breaks down. Dimming removes competing emitters, which matters more here than
in a lit game because bloom from an out-of-focus emitter bleeds across the read plane and
there is no ambient light to hide it under. And the transition is continuous, so the player
retains the spatial relationship between the structure they are reading and the world it
sits in, which is the entire argument for not opening a flat panel.

The simulation never pauses during a lock. A page table being read while the kernel evicts a
page shows the eviction, in place, in the frame the player is already looking at.

---

## 7. Typography

Two families. No third family, ever.

### 7.1 The faces

**Monospace, for simulation data.** JetBrains Mono, from Google Fonts. Chosen over the
alternatives because its lowercase `l`, digit `1`, and uppercase `I` are unambiguous at 12
px, its zero is slashed, and its terminals are cut square, which sits correctly against
hard-edged geometry. It has tabular figures by construction, so columns of numbers align
without tabular-nums.

```css
--font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', SFMono-Regular, Menlo,
             Consolas, 'Liberation Mono', monospace;
```

Weights loaded: 400 and 700. Nothing else.

**Geometric sans, for narrative.** Jost, from Google Fonts. Geometric, near-circular bowls,
single-storey `a`, with a wide weight range. It carries the register the game needs for leg
titles, debrief cards, tombstone inscriptions, and codex prose. It is not the film's
typeface and it must not be tracked or condensed in a way that imitates one.

```css
--font-sans: 'Jost', ui-sans-serif, 'Avenir Next', 'Century Gothic',
             system-ui, sans-serif;
```

Weights loaded: 300, 400, and 600.

Both are loaded through `@fontsource` packages bundled with the app rather than from
Google's CDN, so the game works offline from static hosting, which the design brief
requires. That is a font file in the bundle, and it is the only binary asset in the
project. Everything derived from it (the SDF atlases) is generated at runtime.

### 7.2 Scale

Screen-space, in rem against a 16 px root.

| Token | Size | Line height | Tracking | Family | Use |
|---|---|---|---|---|---|
| `display` | 2.75rem | 1.05 | -0.02em | Jost 300 | Leg title card |
| `title` | 1.75rem | 1.15 | -0.01em | Jost 400 | Debrief headline, tombstone name |
| `heading` | 1.125rem | 1.25 | 0.0em | Jost 600 | Codex section, panel heading |
| `body` | 0.9375rem | 1.55 | 0.0em | Jost 400 | Narrative prose, man pages' prose sections |
| `data` | 0.8125rem | 1.40 | 0.02em | JetBrains Mono 400 | HUD values, terminal output, all numbers |
| `dataEmphasis` | 0.8125rem | 1.40 | 0.02em | JetBrains Mono 700 | Values that changed this tick |
| `micro` | 0.8125rem | 1.30 | 0.06em | JetBrains Mono 400 | Chip labels, axis ticks. Uppercase only. (Raised from 0.6875rem on 2026-09-14: 11 px violated the 13-device-pixel floor in 13.2 at DPR 1.) |

Positive tracking on the monospace tokens is deliberate. Monospace at small sizes against a
black background with bloom in the frame tends to close up, and 0.02em opens the counters
enough to hold at 13 px. Negative tracking on the display tokens is equally deliberate:
Jost's default spacing is loose at large sizes.

World-space label sizes are given in metres of cap height, and follow section 6.6 while
locked. Free-camera defaults:

| Label class | Cap height | Notes |
|---|---|---|
| Process name | 0.16 m | Above the stele's top face |
| Frame / page index | 0.09 m | On the slab face, coplanar |
| Resource name | 0.14 m | Above the ring |
| Structure title | 0.34 m | Above a whole vault, yard, or platter stack |
| Value readout | 0.11 m | Adjacent to the value it names |

### 7.3 Screen space against world space

The rule is a single sentence: **if it describes a thing that exists at a place, it is a
world-space holographic label; if it describes the run, it is screen-space HUD.**

Applied:

| Content | Where |
|---|---|
| A process's name, pid, state, priority, remaining service | world, on the stele |
| A frame's index and its resident page | world, on the slab |
| A resource's name, available instances, wait queue length | world, on the ring |
| A wait-for graph's edge labels | world, on the beams |
| Banker's matrix cells | world, on the matrix structure's face |
| Disk queue cylinder numbers | world, on the platter's rim |
| Convoy integrity | HUD |
| Resource ledger totals | HUD |
| Current scheduler, quantum, replacement policy | HUD chips |
| Leg name and progress | HUD |
| Alerts and warnings | HUD |
| Terminal | screen-space overlay, which is a distinct surface from the HUD |
| Codex | screen-space overlay |

The terminal and the codex are full-screen surfaces the player deliberately opens, and they
are exempt from the "no flat panels" rule because they are not simulation visualisations.
The terminal renders text over a `rgba(4,6,10,0.92)` field with the world still visible and
running behind it at 8% brightness.

### 7.4 Text and bloom

Three mechanisms, all active:

1. **Text renders after tone mapping.** World-space labels live on `LAYER.TEXT` and are
   drawn in pass 13, after the output transform, sharing pass 1's depth buffer so they
   occlude correctly. No glyph is ever an input to the bright pass. This is the main
   mechanism and it removes the whole class of problem where a bright label smears into an
   unreadable blob.
2. **The backing plate.** A `VOID.base` plane at 0.92 opacity behind every world-space
   label, composed after tone mapping with the text so the display-space contrast bound of
   2.6 holds (corrected 2026-09-15 from 0.72 on `LAYER.WORLD`). The plate has a 0.006 m
   emissive hairline on its bottom edge in the label's token colour, at
   `EMISSIVE_GAIN.dim`, which stays in the world stage, sits below the bloom threshold and
   reads as an underline that anchors the label to the object.
3. **The contrast floor.** Section 2.6's table, enforced at build time. Combined with the
   plate holding local background luminance below 0.012, the stated ratios hold no matter
   what the label is floating in front of.

HUD text is DOM, composited by the browser over the canvas, so it is untouched by any pass.
It gets a `text-shadow: 0 0 12px rgba(4,6,10,0.9)` which is a dark halo rather than a light
one, pushing the canvas away from the glyph edges without adding glow.

---

## 8. Motion language

### 8.1 Tokens

```ts
// src/design/motion.ts
export const DUR = {
  /** No animation. The value changes between frames. */
  instant: 0,
  /** A discrete simulation fact landing. Barely a transition, just not a jump cut. */
  snap:     90,
  /** A small state change with a visible cause. */
  quick:   160,
  /** The default for anything the player should notice. */
  base:    260,
  /** Something arriving or departing physically. */
  travel:  420,
  /** Focus camera engage. */
  focus:   520,
  /** Focus camera release. */
  release: 380,
  /** Named Program derezz. */
  derezz: 1400,
  /** Anonymous process derezz. */
  derezzMinor: 520,
  /** Ambient loops: pulses, flows, rotations. */
  ambient: 4000,
} as const;

export const EASE = { /* see 6.4 */ } as const;

/** One simulation tick's wall-clock duration at each pace. Continuous
 *  interpolation is always exactly one tick long, so motion speed reads as
 *  simulation speed and the player can feel the quantum. */
export const TICK_MS: Record<Pace, number> = {
  conservative: 420,
  steady:       300,
  aggressive:   190,
  reckless:     120,
};
```

### 8.2 What animates and what snaps

The kernel is discrete. Pretending otherwise teaches the wrong thing.

**Snaps, at the tick boundary, with no interpolation:**
- Process state changes. A process goes from ready to running in one frame, because it does.
- Lock acquisition and release, at the instant of the event.
- Queue membership. A pid entering or leaving a queue appears or disappears.
- Any count the player might need to read. A wait queue of five must read as five
  immediately and must never be caught mid-transition showing four and a half.
- Policy changes. The visual reconfiguration of a structure when the player switches
  scheduler is instant, so cause and effect are unambiguous.

**Interpolates, over exactly one tick:**
- Positions along a path (a page travelling to its frame, the disk head arm moving).
- Continuous scalar readouts (integrity, fault rate, the stele's service fill line).
- Camera motion.
- Emissive gain ramps between states, over `DUR.snap` (90 ms), which is short enough to read
  as instant and long enough to avoid a one-frame flicker.

**Loops continuously, unsynchronised to ticks:**
- Pulse rhythms from the shape channel.
- Beam flow.
- Platter rotation.
- Distant column shimmer.

### 8.3 Context switch

Driven by `context.switch { from, to, rationale }` and `quantum.expired`.

| Time | What |
|---|---|
| 0 ms | The outgoing stele's quantum ring stops rotating and breaks into a dashed outline. Its edge dash pattern changes from `solid` to `long`. |
| 0 to 90 ms | Its edge gain ramps `hot` (3.20) down to `dim` (1.10). Its service fill line freezes at its current height. |
| 20 ms | A beam snaps into existence from the outgoing stele to the CPU column and from the CPU column to the incoming stele. It does not sweep. A context switch is instantaneous to the simulator and the visual says so. The beam exists for 110 ms and vanishes. |
| 20 to 130 ms | The CPU column's core flares from `active` to `hot` at 1.35x for 110 ms then settles to `hot`. |
| 90 to 180 ms | The incoming stele ramps `dim` to `hot`, its dash goes `solid`, and its quantum ring spawns at 0 rotation and spins up to full speed over 160 ms with `EASE.out`. |
| 130 ms | A 0.05 m amber tick mark is appended to a horizontal tally on the CPU column's base. |

That tally is the teaching device. Context switch overhead is invisible in most
visualisations and it is the reason a tiny quantum is a bad idea. Here it accumulates
physically, the tally wraps every 50 switches into a taller mark, and by the middle of leg 3
a player running a 1-tick quantum can see the base of the CPU column encrusted in amber.

`quantum.expired` adds one extra beat: the quantum ring completes its final rotation and
flashes `AMBER.core` at `active` for 60 ms before the switch sequence begins, so preemption
is visibly different from a voluntary yield.

### 8.4 Page load and page eviction

Driven by `memory.page_fault`, `memory.page_loaded`, and `memory.page_evicted`.

**Fault.** `memory.page_fault { major }`. The faulting process's stele goes to `blocked`
(amber bar across the front face). A hollow ring appears on the target frame socket and
contracts from 1.4x to 1.0x of the socket size over the fault's service time, which gives
the player a progress readout with no UI. Major faults route a beam to the disk platter
first and take the socket ring's full contraction; minor faults pull from the frame-cache
shelf beside the vault and contract in `DUR.quick`.

**Load.** `memory.page_loaded { page, frame }`. The page plate rises out of the backing
store trench, travels the vault aisle at 6 m/s (so travel time is legible as distance), and
seats into the socket. The seat is a snap with a 4% overshoot resolved over 60 ms using
`EASE.out`. On seating, the socket's edge flashes `hot` for 80 ms then settles to
`page_clean`. The plate's index label fades in over `DUR.quick`.

**Access.** `memory.access { hit }`. A hit brightens the plate's centre line to `active` for
90 ms. A `tlb.miss` draws a short amber beam from the plate to the TLB structure before the
brightening, so a miss is visibly a longer path than a hit. This is the whole TLB lesson in
one animation.

**Write.** `memory.access { write: true }` sets the plate's hatch to `diagonal` and its
token to `page_dirty`, over `DUR.snap`. Dirt is permanent until eviction, which is exactly
the invariant.

**Eviction.** `memory.page_evicted { dirty, policy }`:

| Time | Clean page | Dirty page |
|---|---|---|
| 0 ms | Plate edge gain ramps to 0 over 140 ms | An amber ribbon beam opens from the plate to the platter and flows for 200 ms |
| 140 ms | Plate dissolves via the derezz shader at 0.12 m cube size, 220 ms | Plate holds, still lit, while the write-back runs |
| 200 ms | | Ribbon closes, plate edge ramps to 0 over 140 ms |
| 360 ms | Socket returns to `frame_free` | Plate dissolves, 220 ms |
| 580 ms | | Socket returns to `frame_free` |

The dirty page taking 220 ms longer than the clean page is the write-back cost, made
physical and made countable. Under a policy that evicts dirty pages preferentially, the
player will feel the vault get slower before they can articulate why.

The replacement policy's own state is drawn on the vault: FIFO gets an arrow along the
socket order, LRU gets a lit stack ranked by `lastAccessTick`, and clock gets a rotating
hand over the socket ring with each socket's reference bit as a small lamp. The hand's
position comes from `PageReplacementSnapshot.handIndex` and its motion is a snap per socket
rather than a smooth sweep, because the algorithm advances discretely.

### 8.5 Lock acquisition and release

Driven by `sync.acquired`, `sync.blocked`, `sync.released`, `sync.busy_wait`.

**Acquire.** The resource ring has one gap when free. On `sync.acquired`, an arc sweeps from
one end of the gap to the other over 120 ms with `EASE.snap`, the seam flashes
`SLATE.primary` at `critical` for 40 ms, and the ring settles to `resource_locked`. A thin
beam connects the ring to the holding process's stele for as long as it holds, which makes
"who holds what" answerable at a glance and is the foundation of the wait-for graph.

**Block.** On `sync.blocked { queueLength }`, the blocked stele gets its amber front bar, a
beam runs from the stele to the ring in `blocked` amber, and the ring breaks into
`queueLength` arcs with visible gaps. Counting the arcs counts the queue.

**Busy-wait.** `sync.busy_wait { spunTicks }` is drawn differently on purpose, because the
whole lesson is that spinning burns CPU while blocking does not. The spinning process stays
`running` (white-hot), its service fill line keeps draining, and a tight amber ring orbits
it at `2 + spunTicks * 0.1` Hz. The player sees a process at full power accomplishing
nothing.

**Release.** On `sync.released { woke }`, the seam splits, the ring opens by 8 degrees over
100 ms, and the holder's beam detaches and retracts into the ring. If `woke` is non-null, a
beam fires from the seam to the woken process over 60 ms and that stele goes `ready`. If
`SyncPrimitive.ordered` is false, the ring's remaining arcs visibly shuffle on each release,
which is how unbounded waiting is shown before it is named.

### 8.6 Data flowing along a beam

Flow is a shader uniform, never a CPU-animated object. One `uTime` uniform, shared, and one
`uFlowSpeed` per material instance.

```ts
// Flow speed is derived from the event so the visual carries the magnitude.
export const flowSpeedFor = (e: KernelEvent): number => {
  switch (e.type) {
    case 'io.dma_transfer': return Math.min(4.0, 0.4 + e.bytes / 4096);
    case 'memory.page_loaded': return 1.8;
    case 'disk.served': return 2.4;
    case 'sync.released': return 3.2;
    default: return 1.2;
  }
};
```

A beam carrying no data has `uFlowSpeed = 0` and renders as a steady bar. A beam under load
pulses. A beam that is saturated (its `uFlowSpeed` clamped at maximum) also raises
`uFlowCount` from 3 to 7, so saturation reads as density rather than as speed, which the eye
cannot judge above a few Hz.

### 8.7 Animation budget

| Tier | Max simultaneous animated elements | Max concurrent derezz | Max beams |
|---|---|---|---|
| low | 48 | 2 (batched into 1 instanced draw) | 16 |
| medium | 160 | 6 (batched) | 32 |
| high | 400 | 16 (batched) | 64 |

"Animated element" counts anything with a per-frame CPU-side update: a tweened transform, a
material uniform driven by a timeline, or an active particle system. Shader-driven loops
(pulse, flow, rotation) do not count, because they cost nothing per frame on the CPU.

When the budget is exceeded, `src/world/AnimationBudget.ts` applies three rules in order:
the oldest animation of the same class is completed instantly and removed; if the class is
already at zero, the new event is **aggregated** onto its target object as a counter badge
rather than animated; and events aggregated more than 8 times in one tick raise a single
combined effect on the parent structure instead of on each child. A vault taking 200 page
faults in a tick shows one vault-wide amber wash and a count, never 200 rings.
---

## 9. The derezz effect

The signature death animation. It fires on every `process.exited` event without exception,
and its scale, duration, and staging depend on whether the exiting process is a named convoy
Program (`ProcessControlBlock.convoyMemberId !== null`).

### 9.1 Geometry preparation

Done once, at stage build, per distinct form. The result is cached and shared.

```ts
// src/render/derezz/fracture.ts
export interface FractureResult {
  readonly geometry: BufferGeometry;   // non-indexed, cube soup
  readonly cubeCount: number;
}

/**
 * Voxelise a source mesh into cubes of edge `cell`, deterministically. Each cube
 * contributes 36 vertices (12 triangles, non-indexed) carrying:
 *   position   vec3  cube-local vertex position, centred on the origin
 *   aCentroid  vec3  the cube's centre in object space
 *   aRandom    vec3  a stable per-cube unit vector, used for scatter direction
 *   aSeed      float a stable per-cube scalar in [0,1), used for delay and spin
 *   aSurface   float 1 if this cube touched the source surface, 0 if interior
 *
 * Interior cubes get a different treatment (they emerge lit, which is what makes
 * the fracture read as revealing an interior rather than shedding a skin).
 *
 * Determinism matters: this runs at stage build using the leg's Rng fork, so a
 * replayed run produces an identical derezz, which is a hard requirement of the
 * determinism contract in the design brief.
 */
export function fracture(source: BufferGeometry, cell: number, rng: Rng): FractureResult;
```

Cell sizes: 0.06 m for a convoy Program stele (roughly 3,600 cubes for a 0.9 x 0.9 x 2.4 m
prism at surface-only voxelisation), 0.12 m for an anonymous process (roughly 900), 0.12 m
for a leg-8 hex tile, 0.20 m for anything larger than 4 m in any dimension.

Cube counts are capped by tier: low 600, medium 1,800, high 4,096. Above the cap, `cell` is
scaled up until the count fits. The effect reads correctly at 600 cubes; it just reads
coarser, which is an acceptable degradation.

### 9.2 Vertex shader

```glsl
// src/render/derezz/derezz.vert.glsl
precision highp float;

attribute vec3  aCentroid;
attribute vec3  aRandom;
attribute float aSeed;
attribute float aSurface;

uniform float uTime;          // seconds since the effect started
uniform float uDuration;      // 1.4 for a Program, 0.52 for anonymous
uniform float uDispersion;    // metres of scatter at t = 1
uniform float uGravity;       // m/s^2, downward, applied to the scatter
uniform float uNoiseScale;    // 1.7 default
uniform float uSpread;        // fraction of duration used up by per-cube delay
uniform vec3  uOrigin;        // object-space point the fracture front starts from
uniform float uCollapse;      // 1 = scatter outward, -1 = collapse inward

varying float vT;             // this cube's local progress, 0..1
varying float vSurface;
varying float vSeed;

// 3D value noise. Deterministic, cheap, and identical on every device because it
// uses only fract/sin on values that stay in a well-conditioned range.
float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

mat3 axisAngle(vec3 axis, float a) {
  float s = sin(a), c = cos(a), t = 1.0 - c;
  vec3 n = normalize(axis);
  return mat3(
    t*n.x*n.x + c,      t*n.x*n.y - s*n.z,  t*n.x*n.z + s*n.y,
    t*n.x*n.y + s*n.z,  t*n.y*n.y + c,      t*n.y*n.z - s*n.x,
    t*n.x*n.z - s*n.y,  t*n.y*n.z + s*n.x,  t*n.z*n.z + c
  );
}

void main() {
  // The fracture front is a noise field biased by distance from uOrigin, so the
  // break propagates through the body rather than starting everywhere at once.
  float radial = length(aCentroid - uOrigin);
  float field  = vnoise(aCentroid * uNoiseScale + aSeed * 3.7);
  float delay  = clamp(mix(radial * 0.28, field, 0.55), 0.0, 1.0) * uSpread;

  float global = clamp(uTime / uDuration, 0.0, 1.0);
  float t = clamp((global - delay) / max(1e-4, 1.0 - delay), 0.0, 1.0);
  vT = t;
  vSurface = aSurface;
  vSeed = aSeed;

  vec3 p = position;   // cube-local vertex, centred on origin

  // Phase A, 0 .. 0.18: the cube separates by a hair. The body is still readable
  // as itself and the emissive is spiking. This is the beat that says "about to".
  float sep = smoothstep(0.0, 0.18, t) * 0.006;

  // Phase B, 0.18 .. 1: scatter, spin, shrink.
  float b = smoothstep(0.18, 1.0, t);
  vec3 dir = normalize(aRandom + normalize(aCentroid - uOrigin) * 0.6) * uCollapse;
  vec3 offset = dir * (uDispersion * b * b);
  offset.y -= 0.5 * uGravity * pow(b * uDuration, 2.0);

  // Spin about the cube's own centre so it tumbles rather than orbits.
  p = axisAngle(aRandom, b * 2.4 * (0.5 + aSeed)) * p;

  // Shrink to nothing over the last half.
  p *= 1.0 - smoothstep(0.5, 1.0, t);

  vec3 world = aCentroid + normalize(aCentroid - uOrigin + 1e-5) * sep + offset + p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
```

### 9.3 Fragment shader

```glsl
// src/render/derezz/derezz.frag.glsl
precision highp float;

uniform vec3  uBase;      // the process's own semantic colour before death
uniform vec3  uHot;       // CYAN.white or AMBER.white by termination reason
uniform float uBaseGain;  // EMISSIVE_GAIN.active
uniform float uHotGain;   // EMISSIVE_GAIN.critical
uniform float uFocusWeight;

varying float vT;
varying float vSurface;
varying float vSeed;

void main() {
  float t = vT;

  // The spike. A narrow Gaussian centred just after the cube separates. This is
  // the flash that makes a derezz feel like a discharge instead of a crumble.
  float spike = exp(-pow((t - 0.12) / 0.07, 2.0));

  // Interior cubes are hotter than surface cubes for the first third, which is
  // what makes the fracture read as opening something up.
  float interiorBoost = (1.0 - vSurface) * (1.0 - smoothstep(0.0, 0.34, t)) * 0.8;

  vec3  colour = mix(uBase, uHot, clamp(spike + interiorBoost, 0.0, 1.0));
  float gain   = mix(uBaseGain, uHotGain, spike) * (1.0 + interiorBoost);

  // Fade. Starts late, so the cubes stay bright while they are still moving fast
  // and only dim once they have spread. Fading early kills the effect.
  float alpha = 1.0 - smoothstep(0.55, 1.0, t);

  // Per-cube stagger on the fade, so the field thins out unevenly.
  alpha *= 1.0 - smoothstep(0.75 - vSeed * 0.2, 1.0, t);

  if (alpha <= 0.001) discard;

  gl_FragColor = vec4(colour * gain * alpha * uFocusWeight, alpha);
}
```

Material configuration: `transparent: true`, `blending: AdditiveBlending`,
`depthWrite: false`, `depthTest: true`, `side: FrontSide`, `toneMapped: false`.

### 9.4 Timing curve

For a named convoy Program, total 1400 ms plus staging:

| Window | What |
|---|---|
| -400 to 0 ms | **Pre-roll.** The focus camera engages the dying stele automatically (mode `engaging`, 400 ms rather than 520). Simulation time scale drops to 0.35. Everything outside the focus set dims to 0.12. Audio drops to the low bed. |
| 0 to 170 ms | Fracture front propagates from `uOrigin` (the stele's base for starvation, its centre for everything else). Cubes separate by 6 mm. Emissive climbs from `active` toward `critical`. |
| 120 to 250 ms | The spike. Peak emission at `critical` gain. The bloom flare is clamped at 12.0 by the bright pass so it does not white out the frame. |
| 170 to 900 ms | Scatter. Dispersion 1.8 m, gravity 2.4 m/s² (deliberately low, so the cubes hang), spin 2.4 rad. |
| 500 to 1400 ms | Fade. Cubes shrink and alpha ramps out with the per-cube stagger. |
| 1400 to 3400 ms | **The mote.** A single 0.08 m cube remains, at the stele's centre height, at `hot` gain, absolutely still. This is the Program's identity, and it is the beat that makes the death land. |
| 3400 to 3900 ms | The mote falls, hits the floor, and goes out. The floor's light pool under it fades over 500 ms. |
| 3900 ms | The tombstone rises: a 1.2 m slab, `SLATE.outline` body, carrying `Epitaph.inscription` in Jost 400 and `Epitaph.cause` in JetBrains Mono beneath it, with a link glyph to `Epitaph.codexEntry`. Focus camera releases 800 ms later. |

For an anonymous process, total 520 ms: no pre-roll, no camera change, no time-scale change,
no mote, no tombstone. Dispersion 0.6 m, gravity 6.0 m/s², spread 0.35.

### 9.5 Termination reason drives the character of the death

`TerminationReason` selects a variant. Same shader, different uniforms and one extra beat.
This is the "died of dysentery" moment, and the player should be able to name the cause from
the animation before reading the tombstone.

| Reason | Colour | Dispersion | Gravity | Origin | Extra beat |
|---|---|---|---|---|---|
| `normal_exit` | cyan base, cyan hot | 0.9 | 1.2 | centre | None. Gentle, symmetric, complete. This is what a good death looks like. |
| `killed_by_user` | cyan base, white hot | 1.6 | 2.4 | top | A single white plane sweeps down the body over 120 ms before the fracture. |
| `killed_by_parent` | cyan base, white hot | 1.4 | 2.4 | base | A beam from the parent stele strikes first, 90 ms. |
| `starvation` | colour drains to `SLATE.dead` over 600 ms **before** the fracture | 0.2 | 9.8 | base | The stele's height has already been shrinking (shape channel, 2.5). Cubes fall rather than scatter. There is no spike. Emission has already gone. |
| `deadlock_victim` | amber base, amber hot | 1.6 | 2.4 | centre | The cubes freeze mid-flight for 200 ms at t=0.45, holding perfectly still, then drop. The freeze is the visual of "nothing can proceed". |
| `out_of_memory` | amber base, white hot | 1.2 with `uCollapse = -1` | 0 | centre | Cubes collapse inward, compress to a point over 300 ms, and vanish with no scatter. |
| `thrashing_collapse` | amber base, amber hot | 1.0 | 9.8 | base | The ground beneath the stele fails first (leg 8's tile dissolve, 200 ms), and the stele falls into it. |
| `protection_fault` | amber base, white hot | 2.2 | 1.0 | the plane of violation | The fracture front is a **plane**, not a noise field: `delay = clamp(dot(aCentroid - uOrigin, uPlaneNormal) * 1.6, 0, 1) * uSpread`. Clean, surgical, along one axis. |
| `io_timeout` | cyan base, cyan hot at `active` only | 0.8 | 0.4 | centre | No spike at all. `uSpread` raised to 0.8 so it takes twice as long to finish. Slow, undramatic, and the cubes drift. |
| `storage_corruption` | corrupted (2.4.1) | 1.4 | 3.0 | centre | The corruption shader runs at `uCorrupt = 1` for 400 ms before the fracture, so the body quantises and hue-jitters, and then breaks. |

### 9.6 Batching

Anonymous derezzes are batched. `DerezzPool` holds one `InstancedMesh` per cell size, with
per-instance `uOrigin`, `uTime`, `uBase`, `uHot`, and `uDispersion` supplied as instanced
attributes rather than uniforms. Up to 16 simultaneous anonymous derezzes cost one draw call.
A convoy Program's derezz always gets its own mesh, because its cube count and its staging
justify it.

---

## 10. Per-leg visual identity

Each leg gets a dominant form, a colour accent drawn from the closed palette, an
environmental idea, and one hero visual that the leg is remembered for. All fourteen share
the same materials, the same post chain, and the same 4.00 m module.

### Leg 0, The Boot Sector

**Form.** Concentric rings, stacked vertically, of decreasing radius as they rise.
**Accent.** `SLATE.primary` at `dim`, with cyan arriving as subsystems come up.
**Environment.** You are inside the machine before it has finished drawing itself. There is
no floor at the start. There is a single ring of light under the convoy and blackness beyond
it in every direction, including down.
**Hero visual.** The grid floor writing itself outward from beneath the convoy's feet, ring
by ring on the 4.00 m module, at a rate tied to the boot sequence, until it reaches the
horizon. This is where the player learns the scale of the module, and it is the only time in
the game they see the floor being created.

### Leg 1, The Fork Fields

**Form.** Stele, many of them, in rows on the module grid.
**Accent.** `CYAN.core`.
**Environment.** A flat plain of parent stele, each budding smaller child stele that grow to
full height over their arrival window. Address spaces are drawn as faint lattice cages that
are shared (thin, cyan) or copied (solid, brighter) depending on whether the fork copied or
shared, which is the whole `fork` lesson in one visual difference.
**Hero visual.** An unreaped zombie: a stele whose emission has gone entirely, whose faces
have inverted normals so it reads as a hole punched in the world, standing in a field of lit
processes that flow around it. The grid floor beneath it does not draw. It will not clear
until the parent calls `wait`.

### Leg 2, The Weave

**Form.** Filaments, and a deck woven from them.
**Accent.** `CYAN.core` for parallel filaments, `SLATE.primary` for the serial section.
**Environment.** A bridge over nothing whose deck is literally woven from thread filaments.
More threads means a wider deck and a faster crossing. The deck is wide where the workload
parallelises and narrows to a single strand where it cannot.
**Hero visual.** The Amdahl moment. The player adds threads, the deck widens, and then it
stops widening. Adding the twelfth filament produces a deck visibly no wider than the
eighth, because the serial section is a single strand that no number of filaments can widen,
and the convoy has to walk across it one at a time regardless.

### Leg 3, Quantum Pass

**Form.** A procession of stele on switchback tiers, and a rotating quantum drum at the CPU
column.
**Accent.** `CYAN.core`, with `AMBER.dim` accumulating on aging processes.
**Environment.** A mountain pass climbing through switchbacks. Each switchback tier is one
MLFQ queue level, with the highest-priority level at the top and the longest quanta at the
bottom. Demotion is a process physically dropping to the tier below.
**Hero visual.** A starving process on the bottom tier, its stele shortened and drained to
slate, holding still while the top tier cycles through six processes in the same time. The
whole starvation lesson is one wide shot, and the remedy (priority aging) is visible as the
starved stele climbing back up a tier.

### Leg 4, The Narrows

**Form.** A single-file span with a turnstile at its mouth.
**Accent.** `SLATE.primary` for the lock, `AMBER.core` for a violation.
**Environment.** A canyon of black glass with one lit span across it, one entity wide. The
walls are close enough that the convoy is visibly funnelled.
**Hero visual.** A race condition drawn as two ghost images of the same crossing, overlapping
and both partly transparent, resolving into a single wrong value at the far side. The
`RaceCondition.interleaving` strings are drawn as world-space labels along the span in the
order they executed, so the player can read the interleaving that produced the corruption.

### Leg 5, The Cistern

**Form.** A vertical column of slots, filling and draining.
**Accent.** `CYAN.core` when the buffer has room, `AMBER.core` at full or empty.
**Environment.** A flooded cylindrical chamber. The bounded buffer is a column of lit slots
in its centre; producers stand on a gantry above, consumers below.
**Hero visual.** The dining philosophers' ring: five stele in a circle, five resource rings
between them, and every stele holding the ring on its left while a beam reaches for the ring
on its right. The ring of amber beams closes and the whole structure stops. It is the same
picture as leg 6's deadlock, seen for the first time and without the name.

### Leg 6, The Gridlock

**Form.** The wait-for graph, as a ring of beams between stele.
**Accent.** `AMBER.core`, the most amber-dominant leg in the game.
**Environment.** An interchange: multiple lanes of convoy traffic crossing at a junction of
resource rings, everything stalled, everything still lit.
**Hero visual.** The cycle closing. Beams accumulate one at a time as processes block, and
the instant `deadlock.detected` fires and the last edge completes the ring, every beam in the
cycle goes from `blocked` amber to `denied` amber at `critical` gain simultaneously, and the
ring holds, motionless and bright. The four Coffman conditions are labelled on the four edges
that demonstrate them, from `DeadlockReport.conditions`.

### Leg 7, The Allocation Yards

**Form.** Slabs of varying length in numbered bays.
**Accent.** `CYAN.core` for allocated, `CYAN.trace` outline for holes.
**Environment.** A rail yard. Long parallel bays hold allocations as slabs, and the gaps
between them are the holes. Buddy allocation reconfigures the bays into powers of two, which
is visible as the yard physically re-striping.
**Hero visual.** The fragmentation readout. On `memory.allocation_failed { reason: 'fragmentation' }`
every free hole in the yard lights at once in `frame_free` cyan, each labelled with its size,
and a single amber bar the length of the failed request floats above the yard, visibly
shorter than the sum of the lit holes and longer than any one of them.

### Leg 8, The Drowned Reach

Specified in full in section 10.1 below.

### Leg 9, The Platters

**Form.** Rotating discs and a head arm.
**Accent.** `CYAN.core` for served requests, `AMBER.core` for the seek path.
**Environment.** A stack of platters seen from a catwalk above and to one side. The catwalk
is where the convoy walks, so the player is always looking down at the mechanism.
**Hero visual.** The projected head path. `DiskSchedulingPolicy.snapshot().projectedPath` is
drawn as a lit polyline across the platter, connecting pending requests in service order.
Switching policy redraws the polyline instantly (a snap, per 8.2), and the difference between
FCFS's scribble and C-SCAN's sweep is a single glance.

### Leg 10, The Bus

**Form.** A long trench with device bollards on both sides.
**Accent.** `AMBER.core` for interrupts, `CYAN.core` for DMA.
**Environment.** A trench the convoy travels along, several hundred metres of it, with
bollards at 4.00 m intervals. Polling is drawn as the convoy stopping at each bollard to
check it. Interrupts are drawn as the bollard firing a spike upward when it has something.
DMA is a beam that bypasses the convoy entirely and goes straight to the memory vault at the
far end.
**Hero visual.** The interrupt storm. Bollards begin firing faster than the convoy can
advance, the trench strobes amber at a rate that climbs with the interrupt rate, and the
convoy's forward motion visibly stalls because every stele is switching to the handler
instead of running. Coalescing interrupts is visible as the bollards batching their spikes.

### Leg 11, The Archive

**Form.** Spindles and block cubes on shelves.
**Accent.** `CYAN.core`, with corruption drawn per 2.4.1.
**Environment.** A vault of stacked shelving. Each inode is a spindle with radial arms
reaching to the blocks it owns. Contiguous allocation has short straight arms, linked
allocation has a chain of beams hopping shelf to shelf, and indexed allocation has one arm to
an index block and a fan from there.
**Hero visual.** Journal replay. A corrupted spindle, quantised and hue-jittered and visibly
wrong, is rebuilt block by block from a lit ribbon of journal entries running along the
floor. Each `JournalEntry` in the ribbon lights as it is applied and the corruption retreats
from the spindle in the order the transactions committed. Without journaling enabled, the
ribbon is absent and the spindle stays broken, which is the entire argument for journaling.

### Leg 12, The Arbiter Wall

**Form.** Concentric ring walls, four of them, one per protection ring.
**Accent.** `AMBER.core` for arbiters, `SLATE.protected` for ring boundaries, `CYAN.core` for
the convoy.
**Environment.** A fortification. Ring 3 is the outer wall at 96 m radius, ring 0 is the
innermost at 16 m. Each wall is a vertical lattice, and the gates through it are the access
matrix: each gate is labelled with the `AccessRight` set it permits, drawn from
`ProtectionDomain.rights`.
**Hero visual.** An escalation attempt. A stele pushes at a ring boundary, the lattice
hardens from `SLATE.protected` to `SLATE.primary` at `critical` gain, and the stele is thrown
back with a `denied` amber flash. When `security.escalation_attempt { blocked: false }` fires
instead, the lattice does not harden. It simply opens, silently, and that silence is the most
alarming thing in the game.

### Leg 13, The Portal

**Form.** Nested duplicates of every earlier form, at quarter scale, inside a containing
shell.
**Accent.** `SLATE.primary`, with cyan and amber both present at full range.
**Environment.** A machine inside the machine. The guest VM is a complete, running,
quarter-scale copy of an earlier leg's environment, suspended inside a shell, with the host's
trap-and-emulate boundary drawn as the shell's surface. A trap is a beam from the guest,
through the shell, to the host's kernel structure, and back.
**Hero visual.** The Portal: a vertical aperture 8 m wide and 20 m tall, made of parallel
beams at `critical` gain, that the surviving convoy walks into. It is the only structure in
the game that is brighter than a derezz spike, and it is the last thing the player sees.

### 10.1 Leg 8, The Drowned Reach, in full

This is the showpiece. Demand paging rendered as an ocean that becomes solid only where the
convoy steps.

#### The ocean

A single plane, 3000 x 3000 m, at `y = 0`, two triangles, one shader. There is no fluid
simulation and no wave mesh.

```glsl
// src/legs/drowned_reach/ocean.frag.glsl
uniform float uTime;
uniform float uAgitation;     // 0 calm, 1 thrashing critical
uniform vec3  uFloorTint;     // VOID.floor
uniform sampler2D uReflection;

varying vec3 vWorld;

void main() {
  // Surface perturbation exists only to break up the reflection. Amplitude is
  // 6 cm at rest, doubling under thrashing. Two octaves, scrolling in opposite
  // directions so no repeating pattern is visible.
  vec2 p = vWorld.xz * 0.09;
  float n = vnoise(vec3(p + vec2(uTime * 0.03, 0.0), uTime * 0.02)) * 0.7
          + vnoise(vec3(p * 2.7 - vec2(0.0, uTime * 0.021), uTime * 0.03)) * 0.3;
  float amp = 0.06 * (1.0 + uAgitation);
  vec3 nrm = normalize(vec3(dFdx(n) * amp * 40.0, 1.0, dFdy(n) * amp * 40.0));

  float ndv = clamp(dot(nrm, normalize(cameraPosition - vWorld)), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec2 suv = gl_FragCoord.xy / uResolution;
  vec2 distort = nrm.xz * 0.035;
  vec3 refl = texture2D(uReflection, suv + distort).rgb;

  // The water is black. Everything you can see in it is the convoy's own light.
  gl_FragColor = vec4(uFloorTint + refl * fres * 0.55, 1.0);
}
```

The water has no colour of its own and no specular highlight from a light source, because
there is no light source. Everything visible in it is a reflection of the convoy's own
emission and of the resident tiles. When the convoy's light goes out, the water is
indistinguishable from the void, and that is the point.

Vertex displacement is not applied. The plane stays flat and the perturbation exists only in
the normal used for the fresnel and the reflection offset. A flat plane reflecting distorted
light reads as a still, deep, black liquid, and it costs nothing.

#### Pages as ground

Each virtual page maps to one hexagonal tile of 1.60 m circumradius. Hexagons rather than
squares for two reasons: the tiled region's boundary reads as an organic island rather than
as a chart, and a hex has six neighbours, so locality of reference produces a compact blob
instead of a cross. The mapping from `PageId` to tile position is a deterministic spiral
from the origin, computed in `src/legs/drowned_reach/hexmap.ts`, so a page's location is
stable across a replay and a page's neighbours in the tiling are its neighbours in the
address space.

Tiles are one `InstancedMesh`. Per-instance attributes: `aState` (0 absent, 1 materialising,
2 resident clean, 3 resident dirty, 4 dissolving), `aPhase` (0..1 within the current state),
`aFrame` (the `FrameId`, drawn as a hairline etched into the surface), `aHeight` (current
`y`). One draw call for the whole ground, at any tile count.

#### Materialising

| Event | What happens |
|---|---|
| `memory.page_fault { page, major }` | A caustic ring appears on the water at the tile's centre, radius 3.2 m, contracting to 1.6 m over the fault's service time. It is a thin `CYAN.dim` ring drawn into the ocean shader as an extra term, so it appears to be under the surface rather than on it. Major faults also open a beam from the tile to the platter structure at the horizon. |
| `memory.page_loaded { page, frame }` | The tile rises from `y = -0.9` to `y = 0.0` over 260 ms with `EASE.out` and a 6% overshoot, water displacing off its top face as a brief radial ripple in the ocean's `uAgitation` field. Its six edges light `CYAN.core` at `active` for 80 ms, then settle to `dim`. The frame index etches in as a `SLATE.protected` hairline at 0.09 m cap height. |
| `memory.access { write: true }` | The tile's state goes to dirty: its surface gains the diagonal hatch and its edges go `AMBER.core` at `dim`. |
| `memory.access { hit: true }` | The tile's centre pulses to `active` for 90 ms. Watching the convoy walk, the player sees a trail of pulses behind them, which is the working set made visible. |

The convoy can only stand on resident tiles. Movement is constrained to the tiled region, and
the game does not prevent the player from walking toward the edge. Walking off a tile is a
page fault, which materialises the tile ahead, which is exactly how demand paging works and
which the player discovers in the first thirty seconds of the leg.

#### Eviction

`memory.page_evicted { frame, page, dirty, policy }`:

1. If dirty, an `AMBER.core` ribbon beam opens from the tile to the platter at the horizon
   and flows for 200 ms. The tile stays lit and solid throughout. This delay is the
   write-back cost and the player will learn to feel it.
2. The tile's edges ramp to zero over 120 ms.
3. The tile dissolves using the derezz shader at `cell = 0.12`, `uDispersion = 0.35`,
   `uGravity = 9.8`, `uOrigin` at the tile's centre, over 340 ms. The cubes fall into the
   water. Each cube that hits `y = 0` adds a ripple to the ocean's agitation field.
4. The water closes over the tile's footprint. There is no marker left behind. The page is
   gone and there is no way to tell from the surface that it was ever there.

If the convoy is standing on a tile that gets evicted, the convoy falls, and falling costs
integrity on every member. Nothing prevents this. The replacement policy chose that victim,
and the player chose the replacement policy.

#### Thrashing

Driven by `memory.thrashing { faultRate, severity }` and by `MemoryMetrics.faultRate`.

The core relationship the leg teaches: **tiles ahead of the convoy is a function of the fault
rate, and the fault rate is a function of the degree of multiprogramming.**

```ts
/** Number of resident tiles ahead of the convoy's lead Program along its heading.
 *  This is the number the player is actually managing, and it is what the whole
 *  leg's difficulty rests on. */
export function tilesAhead(m: MemoryMetrics, cfg: KernelConfig): number {
  const ratio = m.faultRate / cfg.thrashingThreshold;   // 1.0 = at the threshold
  // At ratio 0 the ground extends comfortably. At ratio 1 it is marginal. Above
  // 1.6 the convoy cannot maintain a step.
  return Math.max(0, Math.round(9 * Math.pow(Math.max(0, 1 - ratio * 0.62), 1.4)));
}
```

At `ratio = 0` there are 9 tiles ahead, which is a comfortable path. At `ratio = 1` there are
3, which requires attention. At `ratio = 1.6` there are 0, and the convoy is stepping onto
tiles that have not finished rising.

**Warning severity.** The horizon band dims by 40%. Tile rise time increases from 260 ms to
365 ms. Ocean agitation goes from 0.0 to 0.45. The HUD fault-rate meter enters its amber
band. The convoy's stride shortens by 15%, which the player feels before they read anything.

**Critical severity.** Everything from warning, plus:

- Tiles begin dissolving while the convoy is standing on them. Eviction no longer respects
  occupancy, because the kernel does not know or care where the convoy is standing.
- Camera FOV widens from 46 to 52 degrees over 900 ms with `EASE.inOut`. This is the only
  FOV change in the game. Widening the FOV while the ground shrinks makes the tiles appear to
  fall away from the camera, and it produces a physical sensation of the floor going out from
  under the player without moving the camera at all. It reverses over 900 ms when the fault
  rate drops below the threshold. Disabled under `reducedMotion`.
- Ocean agitation reaches 1.0. The reflections break up, which means the convoy's own light
  stops being readable in the water, which removes the last depth cue.
- Global ambient drops from 0.06 to 0.024, so the matte bodies of the convoy's own stele go
  nearly black and only their emissive edges remain.
- Tile rise time increases to 520 ms while eviction stays at 340 ms. This is the mechanical
  heart of the whole leg: **the ground now fails faster than it forms**, and no amount of
  player skill at moving can fix it, because the problem is not where the convoy is standing.

**What it feels like, and why the picture contains the answer.** The number of convoy stele
standing on the water is the degree of multiprogramming. Every Program the player has running
is one more working set competing for the same frames. When the player finally suspends one,
`degreeOfMultiprogramming` drops, the fault rate falls, `tilesAhead` climbs, and the ground
comes back, visibly, in about two seconds. The remedy is on screen the entire time and the
game never says it. That is the design thesis from section 1 of the brief, executed.

**Hero visual.** The convoy standing on a single hexagonal tile, black water on all six
sides, no other ground in view to the horizon, watching the tile they are standing on begin
to fracture.

---

## 11. HUD design

The HUD is DOM, positioned over the canvas. It is the only screen-space layer in the game
apart from the terminal and the codex, which are surfaces the player deliberately opens.

### 11.1 What it carries

| Region | Content | Source |
|---|---|---|
| Top left | Leg name, leg index of 13, progress rail | `RunState.legIndex`, `legProgress`, `Leg.title` |
| Top right | Tick counter, current policy chips (scheduler, quantum, replacement, disk, allocation), pace and rations | `Kernel.tick`, `KernelConfig`, `TravelPolicy` |
| Bottom left | Convoy integrity: five pips, one per Program, each carrying name, integrity bar, status, and affliction glyphs | `ConvoyMember[]` |
| Bottom right | Resource ledger: cycles, quota, blocks, bandwidth, each with a delta indicator | `ResourceLedger` |
| Lower centre band | Alert stack, maximum 3 concurrent, auto-dismissing | derived from `KernelEvent` |
| Bottom centre, transient | Focus hint: the name of the anchor under the cursor and the key to engage | `FocusTarget.id` |

Two derived meters live in the top right below the policy chips, because they are the
numbers the player steers by: CPU utilisation from `SchedulingMetrics.cpuUtilisation` and
fault rate from `MemoryMetrics.faultRate`, each as a 96 px horizontal bar with a marked
threshold.

### 11.2 What it must never carry

Page tables. Frame tables. Ready queues. Wait-for graphs. Banker's matrices. Disk queues.
Resource allocation tables. Any list of pids. Any per-process detail beyond the five convoy
Programs. Any structure that has a physical representation in the world.

If a player wants to know which frames are free, they look at the vault. If they want to know
who is waiting on a mutex, they count the arcs on the ring. The import restriction in
principle 1.5 makes this structurally impossible to violate rather than a matter of
discipline.

### 11.3 Layout and safe areas

```css
:root {
  --hud-safe:      max(24px, 2.5vh);
  --hud-gutter:    16px;
  --hud-rest:      0.72;   /* opacity at rest */
  --hud-active:    1.00;   /* opacity for 1.2s after a value changes */
  --hud-focused:   0.25;   /* opacity during a focus lock */
  --hud-radius:    2px;    /* almost square. Rounded corners fight the geometry. */
  --hud-bg:        rgba(4, 6, 10, 0.72);
  --hud-rule:      rgba(47, 143, 168, 0.35);
}

.hud {
  position: absolute;
  inset: var(--hud-safe);
  display: grid;
  grid-template-columns: minmax(220px, 22ch) 1fr minmax(220px, 26ch);
  grid-template-rows: auto 1fr auto;
  gap: var(--hud-gutter);
  pointer-events: none;         /* the world is always clickable through it */
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  letter-spacing: 0.02em;
  color: var(--slate-primary);
  transition: opacity 220ms cubic-bezier(0.33, 1, 0.68, 1);
}
.hud > * { pointer-events: auto; }
```

Every HUD element sits within `--hud-safe` of the viewport edge, which is at least 24 px and
scales with viewport height, so nothing is lost on a display with rounded corners or a
notch. The centre grid cell is empty at all times except for the alert band and the focus
hint, both of which occupy the lower third and both of which auto-clear.

**Coverage cap.** The union of all HUD element bounding boxes must not exceed 11% of viewport
area at 1440x900. Measured by `tests/ui/hud-coverage.test.ts` against a fixture run state
with all five Programs alive, all four resources non-zero, three alerts showing, and the
longest policy names selected.

### 11.4 Staying out of the way

- Resting opacity 0.72. This is low enough that the HUD sits behind the world visually and
  high enough to satisfy the contrast table in 2.6 (the ratios there are computed against the
  void, and 0.72 opacity over a near-black canvas changes them by under 8%).
- Any element whose value changes goes to opacity 1.0 for 1.2 s, then eases back over 400 ms.
  Attention is drawn by change rather than by permanent brightness.
- During a focus lock, the whole HUD drops to 0.25 except the alert stack, which stays at
  1.0. The player is reading a structure and the HUD is not what they are reading.
- During a convoy Program's derezz, the HUD hides entirely from the pre-roll until the
  tombstone rises.
- No HUD element ever animates position. They appear, change value, and disappear. Sliding
  panels pull the eye away from the world.
- No modal dialogs. Player decisions are made at diegetic anchors in the world or in the
  terminal.

Alerts use a fixed vocabulary, and severity maps to the palette: informational alerts are
`CYAN.core`, warnings are `AMBER.core`, and fatal alerts are `AMBER.white` with the glyph
prefix from 2.5. An alert carries at most 64 characters and always names the structure it
refers to, so the player knows where in the world to look.

---

## 12. Performance rules for artists

The target is 60 fps on an Apple silicon MacBook Air at 1440x900 on the integrated GPU. That
is a 16.6 ms frame, of which the post chain takes about 10 ms on high tier, leaving roughly
6 ms for the scene render. Every rule below exists to protect that 6 ms.

### 12.1 Draw-call budget

| Tier | Max draw calls per frame | Max triangles per frame |
|---|---|---|
| low | 220 | 180,000 |
| medium | 450 | 450,000 |
| high | 900 | 1,100,000 |

Counted from `renderer.info.render.calls` and `.triangles`, sampled every 30 frames and
asserted in the leg smoke tests. A leg that exceeds its budget does not ship.

### 12.2 Instancing

Any form repeated more than 8 times uses `InstancedMesh`. This is not a guideline. The
material factory refuses to build a non-instanced material for a form registered as
repeatable, and `LegStage` construction throws in development builds if a `Mesh` is added
whose geometry uuid already appears more than 8 times in the same scene.

Standard per-instance attribute layout, shared by every instanced form in the game:

```ts
/** 12 floats per instance beyond the instanceMatrix, packed into three vec4s so
 *  it costs three attribute slots rather than twelve. */
export interface InstanceData {
  /** vec4 0: semantic colour rgb + emissive gain. */
  colorGain: [number, number, number, number];
  /** vec4 1: state id, phase 0..1, pulse Hz, focus weight. */
  statePhase: [number, number, number, number];
  /** vec4 2: dash on, dash off, hatch id, entity id (for picking). */
  patternId: [number, number, number, number];
}
```

Updating one instance writes 12 floats and sets `needsUpdate` on the relevant
`InstancedBufferAttribute`. It never rebuilds the geometry and it never touches
`instanceMatrix` unless the instance actually moved.

### 12.3 Overdraw

- Maximum 3 layers of transparency at any pixel. Enforced by the beam cap in 8.7 and by
  never nesting transparent geometry.
- Beams have `depthWrite: false` and are sorted back to front by `renderOrder`, which is
  assigned from the beam's midpoint distance to the camera once per frame rather than per
  beam per frame.
- The derezz effect is transparent and additive, and a large derezz is the single worst
  overdraw case in the game. The cube-count caps in 9.1 are chosen so that a full-screen
  convoy derezz at high tier fills roughly 2.2 screens of additive fragments, which the
  target GPU absorbs.
- Floor light pool decals are additive and are capped at 24 on screen, chosen by nearest
  distance. They are drawn into the floor's own pass, before the reflection composite, so
  they do not contribute to the transparency layer count.
- No full-screen transparent overlays in the world layer, ever. Screen-wide effects belong in
  the post chain where they cost one pass.

### 12.4 Dynamic lights

This is a game about light, so this is the rule that matters most.

**There are at most 3 real light objects in the entire scene at any moment.**

| Light | Type | Intensity | Purpose |
|---|---|---|---|
| Ambient | `HemisphereLight` | 0.06 (sky `VOID.horizon`, ground `VOID.base`) | Stops matte bodies reading as pure silhouettes. Without it, hard-surface geometry loses all form. |
| Key | `DirectionalLight` | 0.15, from (0.3, 1.0, 0.4) normalised | Defines floor and upper-face normals so the geometry has a top and a side. Casts no shadows. |
| Read light | `SpotLight`, optional | 0.35, penumbra 0.9 | Exists only while the focus camera is locked, aimed at the reading plane. It is the one light the player will ever consciously notice. |

Everything else that looks like a light is emissive material plus bloom plus a floor decal.
That combination is what produces the appearance of a light source, and it costs a fragment
shader term rather than a shadow map and a forward lighting loop.

**The rule an artist can check:** if you want an object to appear to illuminate its
surroundings, you author three things. The emissive geometry itself. A volumetric beam if the
light has direction. A floor light pool decal beneath it in the same token colour at
`EMISSIVE_GAIN.ambient`. You do not add a `PointLight`. `src/render/materials/index.ts`
exports the only permitted light constructors and there are three of them.

**Shadows are off everywhere.** `renderer.shadowMap.enabled = false`. There is no shadow map
in this game. Contact between an object and the floor is communicated entirely by the light
pool decal, whose inner radius is the object's footprint, so the pool reads as the object
occluding its own glow. This is the correct look for the reference and it saves an entire
depth pass per light.

### 12.5 Geometry and memory

- Zero image files ship other than the two web font files. There are no textures.
- The only GPU textures allocated at runtime are the render targets, the SDF glyph atlases
  generated by troika from the loaded fonts, (optionally) the 8x8 Bayer `DataTexture`
  from 4.9, and the two small area and search lookup textures that Three's SMAA pass
  embeds as data URIs for the medium tier. Those two are lookup tables, not art, and they
  ship inside Three's JavaScript rather than as image files.
- Every geometry generator returns a shared, cached `BufferGeometry`. Two stele in the same
  leg reference the same geometry object.
- Geometry is disposed in `LegStage.dispose()` and a leak test asserts that
  `renderer.info.memory.geometries` returns to its baseline after a leg is torn down.
- Per-form triangle budgets: stele 96, page plate 12, hex tile 20, block 12, resource ring
  (tier-dependent) 96 to 384, platter 128 to 512, bollard 64.

---

## 13. Quality tiers

Detected in `src/platform/capability.ts` from renderer string, maximum texture size, WebGPU
availability, `deviceMemory`, and the startup benchmark of architecture 6.3 (12 warm-up
frames discarded, 30 measured, median taken). The player can override the
detected tier at any time and the change takes effect without a reload.

### 13.1 The table

| System | low | medium | high |
|---|---|---|---|
| Backend | WebGL2 | WebGL2 or WebGPU | WebGPU preferred |
| Render scale | 0.75x | 1.0x | 1.0x |
| Anti-aliasing | none | SMAA (post) | MSAA 4x on the HDR target |
| HDR target | RGBA16F | RGBA16F | RGBA16F |
| Bloom levels | 4, quarter res | 5, half res | 6, half res |
| Bloom tint | flat, level 0 only | full per-level | full per-level |
| Depth of field | off | off | half res, focus lock only |
| Volumetric scattering | off | off | conditional, quarter res |
| Chromatic aberration | off | 1.0 px max | 1.6 px max |
| Film grain | 0.008 | 0.012 | 0.012 |
| Floor reflection | light pools only | mirrored emissive proxy | planar RT at half res |
| Beam radial segments | 6 | 10 | 16 |
| Beam depth softening | quarter-res depth | half-res depth | full-res depth |
| Transmissive materials | fresnel fallback | fresnel fallback | up to 8 real, then fallback |
| Derezz cube cap | 600 | 1,800 | 4,096 |
| Concurrent derezz | 2 | 6 | 16 |
| Concurrent beams | 16 | 32 | 64 |
| Animated elements | 48 | 160 | 400 |
| Draw calls | 220 | 450 | 900 |
| SDF glyph size | 48 | 64 | 64 |
| Distant columns | 120 | 260 | 400 |
| Floor light pools | 8 | 16 | 24 |
| Grid minor lines | off beyond 30 m | full | full |

### 13.2 What must never degrade

These hold identically at every tier, and each has a test.

1. **The colour tokens.** Every hex and every gain is tier-independent. A running process is
   the same colour on a phone and on a workstation.
2. **The shape and pattern channels.** Silhouette, dash, hatch, pulse, and glyph are all
   present at low tier. They are the accessibility guarantee and they are also how the game
   is read.
3. **Text legibility.** No glyph below 13 device pixels at any tier. SDF glyph size drops to
   48 on low, which softens the edges slightly and does not change the size or the layout.
4. **The focus camera lock.** The orthographic blend, the framing, the label plane, and the
   dimming all work at low tier. Only the depth-of-field garnish is removed.
5. **The derezz on a convoy Program.** Every beat of section 9.4 fires at every tier,
   including the pre-roll, the spike, the mote, and the tombstone. It runs with 600 cubes
   instead of 4,096 and it reads correctly.
6. **Bloom itself.** The threshold stays at 1.15 and the strength stays at 0.055 at every
   tier. Emission is the semantic system, so bloom is a mechanic rather than an effect. It
   gets fewer levels at low tier and it never gets switched off.
7. **Every event's visual treatment.** Appendix A applies at every tier. An event may be
   aggregated under the budget rules in 8.7, and it is never silently dropped.
8. **Determinism.** Nothing in the render layer feeds back into the simulation, so the same
   seed produces the same run at every tier. `Math.random` is permitted in `src/render` only
   for grain and mote jitter, neither of which is ever read by the game layer.

---

## Appendix A. Event to visual treatment

`KernelEvent` is exhaustively switched in `src/world/WorldEventRouter.ts`. A new variant
produces a compile error until it appears here and there. Every row is mandatory at every
quality tier.

| Event | Visual treatment |
|---|---|
| `process.created` | A stele grows from the floor at its grid position over `DUR.travel`, edges lighting from base to top. A beam connects it to its parent stele for 200 ms. |
| `process.state_changed` | Edge token, dash pattern, silhouette variant, and pulse rate all change over `DUR.snap`. See the semantic table in 2.4 and the silhouette table in 2.5. |
| `process.exited` | The derezz effect, section 9, with variant chosen by `TerminationReason`. |
| `process.reaped` | The zombie stele's inverted-normal shell collapses inward over 260 ms and the grid floor draws back in beneath it. A short beam from the reaping parent precedes it. |
| `process.starving` | Stele height scales down per 2.5, colour drains toward `SLATE.dead`, pulse climbs from 2.6 Hz toward 4.0 Hz. `fatal: true` adds a HUD alert and a 400 ms `denied` flash. |
| `context.switch` | Section 8.3 in full, including the amber tally mark on the CPU column. |
| `quantum.expired` | The quantum ring completes its rotation and flashes `AMBER.core` at `active` for 60 ms before the switch sequence. |
| `thread.created` | A filament spawns at the parent stele's base and spirals up to its orbit over `DUR.base`. |
| `thread.joined` | The filament retracts into the stele over `DUR.quick` and the stele's core brightens by 8% for 90 ms. |
| `memory.access` | Hit: the page plate's centre line goes `active` for 90 ms. Miss is reported separately as a fault. Write sets the dirty hatch. |
| `memory.page_fault` | The faulting stele goes `blocked`. A contracting caustic ring appears at the target socket or hex tile. Major faults route a beam to the platter first. |
| `memory.page_loaded` | Section 8.4. Plate rises, travels, seats with a 4% overshoot, socket edge flashes `hot`. |
| `memory.page_evicted` | Section 8.4's table. Dirty pages send an amber write-back ribbon first and take 220 ms longer. |
| `memory.allocated` | The allocated slabs light in sequence along the yard at 40 ms intervals, so the allocation's contiguity or scatter is visible in the order they light. |
| `memory.allocation_failed` | Every free hole lights in `frame_free` cyan with its size labelled, and an amber bar the length of the request floats above. `reason: 'fragmentation'` additionally draws a summed length bar so the player can compare. |
| `memory.thrashing` | Warning and critical states per 10.1. In legs other than 8: horizon dims, ocean-equivalent ambient drops, HUD fault meter enters its amber band, and the vault's sockets begin cycling visibly faster than they can be read. |
| `tlb.miss` | A short amber beam from the accessing stele to the TLB structure, then to the page table, then to the frame, drawn in sequence over 180 ms. A hit skips straight to the frame in 40 ms. The difference in path length is the lesson. |
| `sync.acquired` | The ring's gap closes with a sweeping arc, seam flashes `SLATE.primary` at `critical` for 40 ms, and a holder beam connects to the stele. |
| `sync.blocked` | Amber bar across the stele's front face, a `blocked` beam to the ring, and the ring breaks into `queueLength` arcs. |
| `sync.released` | Seam splits, ring opens 8 degrees, holder beam retracts. If `woke` is non-null, a beam fires to that stele and it goes `ready`. |
| `sync.race_detected` | Two overlapping ghost copies of the participating stele, each at 45% opacity, executing the `interleaving` steps as world-space labels along the span, converging on a single value readout showing `corruptedValue` in amber beside `expectedValue` in cyan. |
| `sync.busy_wait` | The stele stays `running` and its service line keeps draining while a tight amber ring orbits it at `2 + spunTicks * 0.1` Hz. Work being burned, visibly. |
| `resource.requested` | A dashed `blocked`-amber beam opens from the stele to the resource ring, dashed rather than solid because the request is not yet granted. |
| `resource.granted` | The dashed beam goes solid, the ring's instance count decrements by removing one lit segment, and the segment travels to the stele and docks. |
| `resource.denied` | The dashed beam snaps back to the stele and the ring flashes `denied` amber at `critical` for 180 ms. `reason: 'unsafe'` additionally lights the Banker's structure. |
| `bankers.evaluated` | The Banker's matrix structure lights row by row following `SafetyCheckResult.trace`, one step per 220 ms, with each `SafetyTraceStep.explanation` as a world-space label. Safe sequences finish with the whole matrix at `active` cyan; unsafe evaluations end with the work vector held and the remaining rows flashing amber. |
| `deadlock.detected` | Every edge in `report.cycle` goes `denied` amber at `critical` simultaneously and holds. The four `CoffmanCondition` labels attach to the edges that demonstrate them. The focus camera offers a lock on the cycle. |
| `deadlock.resolved` | `terminate`: the victims derezz with the `deadlock_victim` variant. `preempt`: the resource segment is torn from the holder and flies to the waiter, holder flashes amber. `rollback`: the holder's stele visibly refills its service line to an earlier value and the ring's arcs rewind. |
| `disk.queued` | A lit marker appears on the platter's rim at the request's cylinder, cyan for read and amber for write, and the projected path polyline redraws. |
| `disk.seek` | The head arm sweeps from `from` to `to` at a rate proportional to `distance`, leaving a fading amber trail on the platter surface. Seek cost is the length of the trail. |
| `disk.served` | The rim marker flashes `hot` and a beam carries the block to the requesting stele. `waitTicks` drives the length of a small amber tick on the platter's wait tally. |
| `raid.rebuild` | The failed disk in the platter stack is drawn dark with a lattice cage. A cyan reconstruction band sweeps across it at `progress`, and parity beams run from the surviving platters into the band. |
| `io.request` | `polling`: the convoy visibly stops at the bollard and a cyan check pulse runs stele to bollard and back, repeatedly. `interrupt`: nothing until the interrupt. `dma`: a beam opens from the bollard straight to the memory vault, bypassing every stele. |
| `io.interrupt` | The bollard fires an amber spike 3 m upward over 120 ms, and the currently running stele's edges flash amber for 90 ms as it switches to the handler. |
| `io.dma_transfer` | Beam flow speed from `flowSpeedFor`, with `uFlowCount` raised to 7 when saturated. The transfer bypasses every stele, which is the whole point of DMA and is visible as the convoy continuing to walk. |
| `io.poll_wasted` | An amber tick accumulates on the polling stele's base, one per wasted tick, and the stele's service line drains while nothing arrives. The tally is directly comparable to the context-switch tally on the CPU column. |
| `fs.block_allocated` | A block cube lights on its shelf and an arm or beam extends from the owning spindle to reach it. `contiguous` gives a short straight arm, `linked` adds one hop to the chain, `indexed` fans from the index block, `extent` extends an existing arm's length. |
| `fs.fragmented` | The spindle's arms redraw showing `extents` separate reaches, each labelled, and a `denied`-amber halo pulses on the spindle at 1.4 Hz until defragmented. |
| `fs.journal` | A plate is appended to the journal ribbon on the floor. `begin` lights it dim, `write` fills it, `commit` flashes it `hot` for 80 ms, `checkpoint` collapses all plates behind it into a single brighter plate. |
| `fs.corruption` | The corruption shader from 2.4.1 ramps to `uCorrupt = 1` on the affected spindle and its blocks over 400 ms. `recoverable: false` additionally drains the spindle's emission to zero, so unrecoverable damage is dark as well as broken. |
| `fs.recovered` | Corruption retreats from `uCorrupt = 1` to 0 over 600 ms. If `fromJournal`, the retreat is driven block by block by the journal ribbon lighting in commit order rather than as a uniform fade. |
| `security.access_denied` | The gate in the ring wall corresponding to `right` hardens to `SLATE.primary` at `critical` for 180 ms and the requesting stele is pushed back 0.4 m with `EASE.snap`. |
| `security.escalation_attempt` | `blocked: true`: the ring wall's lattice hardens and throws the stele back, with the ring numbers labelled. `blocked: false`: the lattice opens silently over 400 ms with no flash and no sound, and the HUD raises a fatal alert. |
| `syscall.invoked` | A 0.3 m glyph rises from the calling stele carrying the `SyscallName`, travels to the kernel structure over 200 ms, and returns as cyan on `ok: true` or amber carrying the `Errno` on failure. Under the animation budget these aggregate into a rate counter on the kernel structure. |
| `kernel.panic` | Section 4.6. Post configuration floods amber for 900 ms, every emissive object in the scene goes to `critical`, all motion stops, the message renders at `display` size in world space at the centre of the frame, and the scene cuts to black over 120 ms. |

---

## Appendix B. File map

| File | Owns |
|---|---|
| `src/design/tokens.ts` | Every colour, gain, and semantic token. The only file with colour literals. |
| `src/design/motion.ts` | `DUR`, `EASE`, `TICK_MS`. |
| `src/design/typography.ts` | Font stacks, the type scale, world-space cap heights. |
| `src/design/accessibility.ts` | `VisionSettings` and the monochrome semantic mapping. |
| `src/render/PostChain.ts` | The fourteen passes, the tier configuration, the timer queries. |
| `src/render/materials/index.ts` | The seven archetypes, the material cache, the three light constructors. |
| `src/render/shaders/` | Grid, ocean, corruption, bloom, tone map, dither, edge terms. |
| `src/render/FocusCamera.ts` | Sections 6.2 through 6.6. |
| `src/render/derezz/` | `fracture.ts`, the two shaders, `DerezzPool`. |
| `src/world/forms/` | Every geometry generator in 5.1. |
| `src/world/WorldEventRouter.ts` | The exhaustive switch over `KernelEvent`, implementing Appendix A. |
| `src/world/AnimationBudget.ts` | Section 8.7's three rules. |
| `src/ui/hud/` | Section 11. Restricted imports per principle 1.5. |
| `src/platform/capability.ts` | Tier detection and the override. |
| `tests/render/` | Emission audit, monochrome pass, contrast verification, HUD coverage, draw-call budgets. |
