/**
 * KERNEL TRAIL: the post-processing chain.
 *
 * Implements 03-VISUAL-BIBLE section 4 (the fourteen passes and their order) with
 * the per-tier configuration from section 13.1 applied.
 *
 * RECONCILIATION, and this one matters. 01-ARCHITECTURE section 5.5 declares a
 * thirteen-stage chain with ACES tone mapping, a `derez_glitch` stage and a
 * `grade` LUT; 03-VISUAL-BIBLE section 4.1 declares a fourteen-pass chain with
 * AgX, no LUT, and a separate text pass after the output transform. The visual
 * bible wins on look questions (its section 4.8 argues AgX against ACES on the
 * grounds that ACES converges cyan and amber in exactly the region where the
 * player most needs them separated, which is a gameplay argument, not a taste
 * one). The architecture's stages that the bible omits are kept as optional
 * stages that no tier enables by default, because they are real features the
 * game wants later and dropping them from the enum would lose the ordering
 * argument recorded in 5.5. Every ordering constraint from both documents is
 * encoded in `POST_CHAIN` and checked by `assertChainOrder`.
 *
 * WHY THE ORDER IS NOT NEGOTIABLE, in one place:
 *
 * - **DOF before bloom.** A defocused emitter's bloom must also be soft. After
 *   bloom you get sharp halos around blurred objects, which reads as a bug.
 * - **Volumetric scattering after bloom.** The bible runs scattering on an
 *   already-bright source (4.1 row 7); the architecture runs it before bloom so
 *   the shafts themselves glow (5.5). Both are defensible; the bible's ordering
 *   ships, because the scattering source in this game is always a beam that is
 *   already above the bright-pass threshold.
 * - **Grain and vignette before tone mapping.** Grain in scene-referred values
 *   lets the tone curve compress it in the highlights the way film does. A
 *   vignette applied after the curve looks like a black overlay; applied before,
 *   it looks like a lens.
 * - **Text after tone mapping.** No glyph is ever an input to the bright pass.
 *   This is the main mechanism that keeps labels readable and it removes the
 *   whole class of problem where a bright label smears into a blob.
 *
 * IMPORT DISCIPLINE. Three imports come from `three/webgpu` and `three/tsl`
 * only. See the note at the top of RendererBackend.ts.
 */

import { AgXToneMapping, NoToneMapping, PostProcessing } from 'three/webgpu';
import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import { pass } from 'three/tsl';

import type { QualityTier } from '@platform/capabilities';
import type { RenderQualityProfile } from '@platform/quality';
import { BLOOM, BLOOM_TINT, PANIC_POST, VIGNETTE } from '@design/tokens';

/* ------------------------------------------------------------------------- */
/* Stage declaration                                                          */
/* ------------------------------------------------------------------------- */

export type PostStageId =
  | 'scene_world'
  | 'depth_resolve'
  | 'depth_of_field'
  | 'bright_pass'
  | 'bloom_down'
  | 'bloom_up'
  | 'volumetric_scatter'
  | 'composite'
  | 'chromatic_aberration'
  | 'film_grain'
  | 'vignette'
  | 'tonemap_output'
  | 'scene_text'
  /* Carried from 01-ARCHITECTURE 5.5. Not enabled by any shipping tier. */
  | 'depth_prepass'
  | 'derez_glitch'
  | 'grade_lut';

export type TargetFormat = 'rgba16f' | 'r32f' | 'rgba8-srgb';

export interface PostStage {
  readonly id: PostStageId;
  /** Lower runs first. Gaps are left deliberately so a stage can be inserted. */
  readonly order: number;
  /** Which tiers run this stage at all. Empty means "declared, never enabled". */
  readonly tiers: readonly QualityTier[];
  /** Resolution multiplier relative to the main target. */
  readonly scale: number;
  readonly format: TargetFormat;
  /**
   * True when the stage is merged into the shipping build's single composite
   * fragment shader. They stay separate entries because each has its own uniform
   * block and because the debug build toggles them individually.
   */
  readonly mergedIntoComposite: boolean;
  readonly rationale: string;
}

/**
 * All intermediate targets are `HalfFloatType` (RGBA16F). No 8-bit
 * intermediates anywhere: a scene whose luminance sits mostly between 0.0 and
 * 0.02 will band at 8 bits, and the bands appear as concentric rings around
 * every bloom halo (4.9).
 */
export const POST_CHAIN: readonly PostStage[] = [
  {
    id: 'depth_prepass',
    order: 5,
    tiers: [],
    scale: 1,
    format: 'r32f',
    mergedIntoComposite: false,
    rationale:
      'Z-only pass from 01-ARCHITECTURE 5.5. Declared but disabled: the visual bible chain ' +
      'has no prepass, and with shadows off and overdraw capped at three transparency layers ' +
      'it has nothing to pay for yet. Enable it if the frame vault ever profiles as fill-bound.',
  },
  {
    id: 'scene_world',
    order: 10,
    tiers: ['low', 'medium', 'high'],
    scale: 1,
    format: 'rgba16f',
    mergedIntoComposite: false,
    rationale:
      'LAYER.WORLD into the HDR target, MSAA 4x at high. MSAA on the HDR target rather than ' +
      'post-AA because emissive hairlines against black alias catastrophically and no post-AA ' +
      'filter can recover a sub-pixel line.',
  },
  {
    id: 'depth_resolve',
    order: 20,
    tiers: ['low', 'medium', 'high'],
    scale: 1,
    format: 'r32f',
    mergedIntoComposite: false,
    rationale: 'Beams and DOF both need linear depth. Resolved once and shared.',
  },
  {
    id: 'depth_of_field',
    order: 30,
    tiers: ['high'],
    scale: 0.5,
    format: 'rgba16f',
    mergedIntoComposite: false,
    rationale:
      'Before bloom, so a defocused emitter blooms softly. A garnish: it is the first thing ' +
      'removed under budget pressure and the focus lock still works without it (13.2 rule 4).',
  },
  {
    id: 'bright_pass',
    order: 40,
    tiers: ['low', 'medium', 'high'],
    scale: 0.5,
    format: 'rgba16f',
    mergedIntoComposite: false,
    rationale:
      'Soft-knee threshold at BLOOM.threshold, which sits between the dim and active gains. ' +
      'Half resolution because bloom is low-frequency by definition.',
  },
  {
    id: 'bloom_down',
    order: 50,
    tiers: ['low', 'medium', 'high'],
    scale: 0.5,
    format: 'rgba16f',
    mergedIntoComposite: false,
    rationale: 'Dual-Kawase downsample, 5 taps per level. Level count by tier.',
  },
  {
    id: 'bloom_up',
    order: 60,
    tiers: ['low', 'medium', 'high'],
    scale: 0.5,
    format: 'rgba16f',
    mergedIntoComposite: false,
    rationale:
      'Dual-Kawase upsample, 8 taps in a tent, with the per-level tint applied on the way up. ' +
      'Tinting during the upsample is what makes bloom look photographic rather than smeared.',
  },
  {
    id: 'volumetric_scatter',
    order: 70,
    tiers: ['high'],
    scale: 0.25,
    format: 'rgba16f',
    mergedIntoComposite: false,
    rationale:
      'Radial blur from a screen-space source, only when a registered beam source is on screen ' +
      'and unoccluded. Runs after bloom so the source is already bright.',
  },
  {
    id: 'composite',
    order: 80,
    tiers: ['low', 'medium', 'high'],
    scale: 1,
    format: 'rgba16f',
    mergedIntoComposite: true,
    rationale:
      'Adds bloom and scattering to the scene colour. Everything after this is a look operation ' +
      'on a single buffer.',
  },
  {
    id: 'derez_glitch',
    order: 85,
    tiers: [],
    scale: 1,
    format: 'rgba16f',
    mergedIntoComposite: false,
    rationale:
      'Block displacement and channel shear from 01-ARCHITECTURE 5.5. Declared but disabled: ' +
      'the visual bible puts the derezz entirely in object space (section 9), so a screen-space ' +
      'glitch would double the effect. Kept because sync.race_detected may want it later, and ' +
      'if it is added it goes here, before tonemap, so a displaced highlight stays a highlight.',
  },
  {
    id: 'chromatic_aberration',
    order: 90,
    tiers: ['medium', 'high'],
    scale: 1,
    format: 'rgba16f',
    mergedIntoComposite: true,
    rationale: 'Before grain, so grain is not smeared by the channel offset. Extreme edges only.',
  },
  {
    id: 'film_grain',
    order: 100,
    tiers: ['low', 'medium', 'high'],
    scale: 1,
    format: 'rgba16f',
    mergedIntoComposite: true,
    rationale:
      'Before tone mapping, so grain lives in scene-referred values and the curve compresses it ' +
      'in the highlights the way film does. It doubles as the dither that hides banding in the ' +
      'near-black void, which is the real reason it is here.',
  },
  {
    id: 'vignette',
    order: 110,
    tiers: ['low', 'medium', 'high'],
    scale: 1,
    format: 'rgba16f',
    mergedIntoComposite: true,
    rationale: 'Before tone mapping: it darkens exposure rather than painting black over the frame.',
  },
  {
    id: 'grade_lut',
    order: 115,
    tiers: [],
    scale: 1,
    format: 'rgba16f',
    mergedIntoComposite: false,
    rationale:
      'Procedural 32^3 LUT from 01-ARCHITECTURE 5.5. Declared but disabled: the palette is ' +
      'already closed to two hues and a grade would move colours the semantic system depends on. ' +
      'If it is ever enabled it must run AFTER tonemap, because a LUT authored in display space ' +
      'must be applied in display space.',
  },
  {
    id: 'tonemap_output',
    order: 120,
    tiers: ['low', 'medium', 'high'],
    scale: 1,
    format: 'rgba8-srgb',
    mergedIntoComposite: true,
    rationale:
      'AgX, plus the output transform and the ordered dither. AgX rolls highlights toward white ' +
      'while holding hue far longer than ACES, and its long toe keeps near-black values ' +
      'separated instead of crushing them.',
  },
  {
    id: 'scene_text',
    order: 130,
    tiers: ['low', 'medium', 'high'],
    scale: 1,
    format: 'rgba8-srgb',
    mergedIntoComposite: false,
    rationale:
      'LAYER.TEXT, drawn after the output transform, sharing the world pass depth buffer so ' +
      'glyphs occlude correctly. No glyph is ever an input to the bright pass.',
  },
];

/** Stages, sorted, that the given tier actually runs. */
export function stagesForTier(tier: QualityTier): readonly PostStage[] {
  return POST_CHAIN.filter((s) => s.tiers.includes(tier)).sort((a, b) => a.order - b.order);
}

/**
 * Ordering invariants that must hold no matter which stages a tier enables.
 * Called from `tests/render/post-order.test.ts` and, in development, from the
 * chain's constructor: an ordering mistake here is invisible in a screenshot
 * until someone notices the bloom looks grey, which is a bad way to find it.
 */
export function assertChainOrder(): void {
  const orderOf = (id: PostStageId): number => {
    const stage = POST_CHAIN.find((s) => s.id === id);
    if (stage === undefined) throw new Error(`post chain: unknown stage ${id}`);
    return stage.order;
  };
  const before = (a: PostStageId, b: PostStageId, why: string): void => {
    if (orderOf(a) >= orderOf(b)) throw new Error(`post chain: ${a} must precede ${b}. ${why}`);
  };

  before('depth_resolve', 'depth_of_field', 'DOF needs linear depth.');
  before('depth_of_field', 'bright_pass', 'A defocused emitter must bloom softly.');
  before('bright_pass', 'bloom_down', 'The pyramid base is the thresholded image.');
  before('bloom_down', 'bloom_up', 'The tent filter reads the downsampled levels.');
  before('bloom_up', 'volumetric_scatter', 'The god-ray source must already be bright.');
  before('volumetric_scatter', 'composite', 'Scattering is added to scene colour, not to itself.');
  before('composite', 'chromatic_aberration', 'Lens effects act on the composited image.');
  before('chromatic_aberration', 'film_grain', 'Grain must not be smeared by the channel offset.');
  before('film_grain', 'tonemap_output', 'Grain lives in scene-referred values.');
  before('vignette', 'tonemap_output', 'A vignette after the curve is a black overlay.');
  before('tonemap_output', 'scene_text', 'No glyph is ever bloomed or crushed.');
  before('derez_glitch', 'tonemap_output', 'A displaced highlight must stay a highlight.');
  before('tonemap_output', 'grade_lut', 'A display-space LUT is applied in display space.');
}

/* ------------------------------------------------------------------------- */
/* Per-tier configuration (03-VISUAL-BIBLE 13.1)                              */
/* ------------------------------------------------------------------------- */

export type FloorReflectionMode = 'light-pools' | 'mirrored-proxy' | 'planar-rt';

export interface PostTierConfig {
  readonly tier: QualityTier;

  /* framebuffer */
  readonly renderScale: number;
  readonly antialiasing: 'none' | 'smaa' | 'msaa4';

  /* bloom */
  readonly bloomLevels: number;
  /** Resolution of the pyramid base relative to the main target. */
  readonly bloomScale: number;
  /** Low tier tints only level 0; the wide levels take the flat white tint. */
  readonly bloomTintPerLevel: boolean;

  /* optional stages */
  readonly depthOfField: boolean;
  readonly volumetricScattering: boolean;
  /** Maximum channel offset at the frame corner, in device pixels. 0 disables. */
  readonly aberrationMaxPx: number;
  /** Grain amplitude. Above 0.02 it reads as noise and destroys the hairlines. */
  readonly grainAmplitude: number;

  /* world-side settings the chain must agree with */
  readonly floorReflection: FloorReflectionMode;
  readonly beamRadialSegments: number;
  /** Resolution of the depth copy the beam soft-clip samples. */
  readonly beamDepthScale: number;
  /** Real transmission is capped; beyond this the factory returns the fresnel fallback. */
  readonly transmissiveCap: number;
  readonly derezzCubeCap: number;
  readonly concurrentDerezz: number;
  readonly concurrentBeams: number;
  readonly animatedElements: number;
  readonly sdfGlyphSize: number;
  readonly distantColumns: number;
  readonly floorLightPools: number;
  /** Metres beyond which the minor grid is not drawn. Infinity means always. */
  readonly gridMinorRangeM: number;
}

/**
 * Transcribed from the tier table in 13.1. The values NOT in this table are as
 * important as the ones that are: the colour tokens, the shape and pattern
 * channels, text legibility, the focus camera lock, the convoy derezz, the bloom
 * threshold and strength, every event's visual treatment, and determinism are
 * all tier-independent (13.2). A running process is the same colour on a phone
 * and on a workstation.
 */
export const POST_TIER_CONFIG: Readonly<Record<QualityTier, PostTierConfig>> = {
  low: {
    tier: 'low',
    renderScale: 0.75,
    antialiasing: 'none',
    bloomLevels: 4,
    bloomScale: 0.25,
    bloomTintPerLevel: false,
    depthOfField: false,
    volumetricScattering: false,
    aberrationMaxPx: 0,
    grainAmplitude: 0.008,
    floorReflection: 'light-pools',
    beamRadialSegments: 6,
    beamDepthScale: 0.25,
    transmissiveCap: 0,
    derezzCubeCap: 600,
    concurrentDerezz: 2,
    concurrentBeams: 16,
    animatedElements: 48,
    sdfGlyphSize: 48,
    distantColumns: 120,
    floorLightPools: 8,
    gridMinorRangeM: 30,
  },
  medium: {
    tier: 'medium',
    renderScale: 1,
    antialiasing: 'smaa',
    bloomLevels: 5,
    bloomScale: 0.5,
    bloomTintPerLevel: true,
    depthOfField: false,
    volumetricScattering: false,
    aberrationMaxPx: 1.0,
    grainAmplitude: 0.012,
    floorReflection: 'mirrored-proxy',
    beamRadialSegments: 10,
    beamDepthScale: 0.5,
    transmissiveCap: 0,
    derezzCubeCap: 1800,
    concurrentDerezz: 6,
    concurrentBeams: 32,
    animatedElements: 160,
    sdfGlyphSize: 64,
    distantColumns: 260,
    floorLightPools: 16,
    gridMinorRangeM: Number.POSITIVE_INFINITY,
  },
  high: {
    tier: 'high',
    renderScale: 1,
    antialiasing: 'msaa4',
    bloomLevels: 6,
    bloomScale: 0.5,
    bloomTintPerLevel: true,
    depthOfField: true,
    volumetricScattering: true,
    aberrationMaxPx: 1.6,
    grainAmplitude: 0.012,
    floorReflection: 'planar-rt',
    beamRadialSegments: 16,
    beamDepthScale: 1,
    transmissiveCap: 8,
    derezzCubeCap: 4096,
    concurrentDerezz: 16,
    concurrentBeams: 64,
    animatedElements: 400,
    sdfGlyphSize: 64,
    distantColumns: 400,
    floorLightPools: 24,
    gridMinorRangeM: Number.POSITIVE_INFINITY,
  },
};

/* ------------------------------------------------------------------------- */
/* Live uniform state                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Everything the chain reads per frame that is not fixed by the tier. Held as a
 * mutable record rather than as constructor arguments because the focus camera
 * and the panic handler both write into it every frame, and passing five
 * arguments through `render()` would allocate.
 */
export interface PostFrameState {
  /** Wall seconds since boot. Drives grain and any animated stage. */
  elapsedSeconds: number;
  /** Focus camera blend, 0..1. Ramps the vignette and the aberration strength. */
  focusBlend: number;
  /** Distance from the camera to the focus reading plane, metres. Drives DOF. */
  focusDistanceM: number;
  /**
   * 0 normally. Ramps to 1 over PANIC_POST.floodMs during `kernel.panic`, then
   * the scene cuts to black. This is the only event permitted to change the
   * global post configuration, and it is the only moment in the game where the
   * look is deliberately broken.
   */
  panic: number;
  /** 1 normally, ramping to 0 during the panic cut to black. */
  exposure: number;
}

export function createPostFrameState(): PostFrameState {
  return { elapsedSeconds: 0, focusBlend: 0, focusDistanceM: 0, panic: 0, exposure: 1 };
}

/** Bloom parameters after the tier, the panic state and the accessibility settings. */
export interface ResolvedBloom {
  readonly threshold: number;
  readonly knee: number;
  readonly strength: number;
  readonly levels: number;
  readonly tint: readonly (readonly [number, number, number])[];
}

/**
 * Pure, so a test can assert the panic ramp without a GPU. Deliberately does not
 * clamp `strength` to the tier: the bloom threshold and strength are
 * tier-independent by rule (13.2 rule 6), and the only things allowed to move
 * them are the panic state and the player's own reduced-bloom setting.
 */
export function resolveBloom(
  cfg: PostTierConfig,
  state: PostFrameState,
  reducedBloom: { readonly strengthScale: number; readonly threshold: number } | null,
): ResolvedBloom {
  const p = state.panic;
  const baseThreshold = reducedBloom !== null ? reducedBloom.threshold : BLOOM.threshold;
  const baseStrength = reducedBloom !== null ? BLOOM.strength * reducedBloom.strengthScale : BLOOM.strength;

  const flatTint: readonly (readonly [number, number, number])[] = BLOOM_TINT.map((t, i) =>
    i === 0 ? t : ([1, 1, 1] as const),
  );

  return {
    threshold: baseThreshold + (PANIC_POST.threshold - baseThreshold) * p,
    knee: BLOOM.knee,
    strength: baseStrength + (PANIC_POST.strength - baseStrength) * p,
    levels: cfg.bloomLevels,
    tint: cfg.bloomTintPerLevel ? BLOOM_TINT : flatTint,
  };
}

/** Vignette after the focus lock ramp and the panic contraction. */
export function resolveVignette(state: PostFrameState): { readonly strength: number; readonly power: number } {
  const b = state.focusBlend;
  const strength = VIGNETTE.strength + (VIGNETTE.lockedStrength - VIGNETTE.strength) * b;
  const power = VIGNETTE.power + (VIGNETTE.lockedPower - VIGNETTE.power) * b;
  // The panic contraction is multiplicative on strength so it composes with a
  // lock that is already tightened rather than overriding it.
  const contracted = strength * (1 + PANIC_POST.vignetteContraction * state.panic);
  return { strength: contracted, power };
}

/* ------------------------------------------------------------------------- */
/* The chain                                                                  */
/* ------------------------------------------------------------------------- */

export interface PostChainOptions {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly tier: QualityTier;
  readonly profile: RenderQualityProfile;
}

/**
 * Owns the ordered list of passes, the tier configuration, and the per-frame
 * uniform state. It does NOT own the scene or the camera; it holds references so
 * that a leg change can swap them without rebuilding the chain, which is what
 * keeps a leg transition from recompiling every shader.
 */
export class PostChain {
  readonly state: PostFrameState = createPostFrameState();

  private readonly renderer: WebGPURenderer;
  private readonly post: PostProcessing;
  private scene: Scene;
  private camera: Camera;
  private config: PostTierConfig;
  private profile: RenderQualityProfile;
  private disposed = false;

  constructor(opts: PostChainOptions) {
    if (import.meta.env.DEV) assertChainOrder();

    this.renderer = opts.renderer;
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.config = POST_TIER_CONFIG[opts.tier];
    this.profile = opts.profile;

    // Exposure is fixed at 1.0 and there is no auto-exposure anywhere in this
    // game. Auto-exposure in a scene that is mostly black would hunt every time
    // a bright object entered frame, and because emission carries meaning, an
    // adaptive exposure would make identical simulation states look different
    // depending on what else is on screen.
    this.renderer.toneMappingExposure = 1.0;

    // The renderer's own tone mapping is disabled: the chain owns the output
    // transform and applies it at a known point, after grain and vignette have
    // acted on scene-referred values. Setting it here rather than per-material is
    // what makes `toneMapped: false` on every emissive material unnecessary at
    // the renderer level while still being required at the material level for
    // the WebGL fallback path.
    this.renderer.toneMapping = NoToneMapping;

    this.post = new PostProcessing(this.renderer);
    this.post.outputNode = this.buildGraph();
  }

  /**
   * Builds the node graph. Only the stages Three implements natively are wired
   * here; every custom stage is a numbered TODO below with the exact shader and
   * the exact constants it must use, because the constants are the design and
   * approximating them changes what the player can read.
   */
  private buildGraph(): ReturnType<typeof pass> {
    // `pass()` renders the scene into an HDR target and gives node handles onto
    // its colour and depth outputs. This is stage `scene_world` plus stage
    // `depth_resolve`; Three resolves the depth attachment on demand, so there
    // is no separate resolve to author.
    const scenePass = pass(this.scene, this.camera);

    // TODO(astra): stage `bright_pass`. Author src/render/shaders/brightPass.ts
    // as a TSL Fn taking (colour: vec4, threshold: float, knee: float) and
    // returning vec4. Transcribe the soft-knee exactly from 03-VISUAL-BIBLE 4.3:
    //   lum  = dot(c, vec3(0.2126, 0.7152, 0.0722))
    //   soft = clamp(lum - threshold + knee, 0.0, 2.0 * knee)
    //   soft = soft * soft / (4.0 * knee + 1e-5)
    //   contribution = max(soft, lum - threshold) / max(lum, 1e-5)
    // The soft knee is not decoration: without it a hairline sitting at gain
    // 1.14 flickers on and off as it drifts to 1.16 across a frame. Feed it
    // `resolveBloom(...).threshold` and `.knee`, not the token constants, so the
    // panic ramp reaches it.

    // TODO(astra): stages `bloom_down` and `bloom_up`. Author
    // src/render/shaders/dualKawase.ts with the two kernels transcribed from
    // 03-VISUAL-BIBLE 4.4: 5 taps down (centre weighted 4, four half-texel
    // diagonals, sum * 0.125) and 8 taps up in a tent (corners weighted 1, edges
    // weighted 2, sum * 0.0833333). Do NOT substitute Three's BloomNode: it is a
    // Gaussian mip chain and reaching this halo radius that way costs roughly 3x
    // on integrated graphics, which is the entire reason 4.4 specifies
    // dual-Kawase. Clamp the pyramid base to BLOOM.clamp (12.0) BEFORE the down
    // chain, or one `critical` flare produces a full-screen white field for a
    // frame during a derezz. Multiply each level by its BLOOM_TINT entry on the
    // way up, and by `resolveBloom(...).strength` at the composite.

    // TODO(astra): stage `depth_of_field`, high tier only. Half resolution,
    // before the bright pass. Focus distance is `state.focusDistanceM`, locked to
    // the reading plane; the aperture must produce a maximum circle of confusion
    // of 3.0 px at 12 m off-plane. It is a garnish: gate it on
    // `this.config.depthOfField` and make sure the focus lock still reads
    // correctly with it off, because that is the documented degradation path.

    // TODO(astra): stage `volumetric_scatter`, high tier only, quarter
    // resolution, conditional. Radial blur from a screen-space source, run only
    // when a registered beam source is on screen and unoccluded. The occlusion
    // test belongs in the world layer, which sets a uniform; do not raycast here.

    // TODO(astra): stages `composite`, `chromatic_aberration`, `film_grain`,
    // `vignette` and `tonemap_output`, authored as ONE merged TSL Fn in
    // src/render/shaders/composite.ts (they are separate entries in POST_CHAIN
    // because each has its own uniform block and the debug build toggles them
    // individually, but they are one pass in the shipping build). Transcribe
    // from 03-VISUAL-BIBLE 4.7, 4.8 and 4.9 in this order:
    //   1. add bloom and scattering to scene colour,
    //   2. chromatic aberration, mask = smoothstep(0.62, 1.0, r), offset
    //      `config.aberrationMaxPx` at the corner and exactly zero inside r=0.62,
    //   3. triangular film grain weighted toward the shadows, amplitude
    //      `config.grainAmplitude`,
    //   4. vignette from `resolveVignette(state)`, pre-tonemap,
    //   5. AgX, then a small saturation lift of 1.18 after the curve,
    //   6. an 8x8 ordered Bayer dither, `+ bayer8(fragCoord) / 255.0`.
    // Do NOT hand-transcribe the AgX matrices. Import them from Three's
    // tonemapping shader chunk, or use AgXToneMapping through Three's own node
    // (imported above so the symbol is present when you wire it) and apply the
    // saturation lift and the dither after it. The two matrices printed in 4.8
    // are there to document the operator's structure, and the doc says
    // explicitly that the correct values must come from the library.

    // TODO(astra): stage `scene_text`. A second `pass()` over LAYER.TEXT that
    // shares the world pass's depth buffer, composited over the tonemapped
    // RGBA8 result. Three's `pass()` allocates its own depth attachment, so this
    // needs either a manual render target pair or a direct
    // `renderer.render(scene, camera)` with the camera's layer mask switched to
    // LAYER.TEXT and `autoClear` off, after `post.render()`. Prefer the second:
    // it is one draw and it cannot get the depth sharing wrong.

    return scenePass;
  }

  /** Swap the scene and camera on a leg change without rebuilding the graph. */
  setScene(scene: Scene, camera: Camera): void {
    this.scene = scene;
    this.camera = camera;
    this.post.outputNode = this.buildGraph();
    this.post.needsUpdate = true;
  }

  /**
   * Apply a tier change. Rebuilds render targets only. It MUST NOT rebuild
   * materials or geometry: a tier change happens precisely when the game is
   * already struggling, and a downgrade that hitches is worse than the frames it
   * was trying to save.
   */
  setTier(tier: QualityTier, profile: RenderQualityProfile): void {
    this.config = POST_TIER_CONFIG[tier];
    this.profile = profile;
    // TODO(astra): resize the bloom pyramid to `config.bloomLevels` at
    // `config.bloomScale`, and enable or disable the DOF and scattering targets.
    // Reuse the existing target objects where the size is unchanged. Assert in
    // dev that renderer.info.memory.geometries is unchanged across this call.
    this.post.needsUpdate = true;
  }

  /** The active tier configuration. The world layer reads it for beam segments and caps. */
  get tierConfig(): PostTierConfig {
    return this.config;
  }

  get qualityProfile(): RenderQualityProfile {
    return this.profile;
  }

  /**
   * Run the chain. `elapsedSeconds` drives grain; it is wall time rather than
   * simulated time so that grain does not freeze when the player pauses, which
   * would make the pause read as a dropped frame.
   */
  render(elapsedSeconds: number): void {
    if (this.disposed) return;
    this.state.elapsedSeconds = elapsedSeconds;
    // `render()` on PostProcessing is synchronous on the WebGL path and returns
    // a promise on the WebGPU path. It is called without await for the same
    // reason as the backend's render call: awaiting serialises the CPU against
    // the GPU and costs a frame of latency.
    this.post.render();
  }

  /**
   * Drive the panic ramp. Called by SystemVisuals on `kernel.panic` and then once
   * per frame with the elapsed time. Returns true while the effect is still
   * running, so the caller knows when to hand control back.
   */
  updatePanic(msSincePanic: number): boolean {
    const flood = PANIC_POST.floodMs;
    const total = flood + PANIC_POST.cutMs;
    if (msSincePanic >= total) {
      this.state.panic = 0;
      this.state.exposure = 0;
      return false;
    }
    if (msSincePanic <= flood) {
      this.state.panic = 1;
      this.state.exposure = 1;
      return true;
    }
    // The cut to black. Panic holds at full while exposure falls, so the frame
    // stays blown out on its way out rather than fading through a normal-looking
    // image, which would read as a recovery rather than as a death.
    this.state.panic = 1;
    this.state.exposure = 1 - (msSincePanic - flood) / PANIC_POST.cutMs;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.post.dispose();
  }
}

/**
 * Exported so the composite shader author has the symbol in scope and does not
 * reach for `ACESFilmicToneMapping` out of habit. Section 4.8 rejects ACES on the
 * grounds that it skews hue as values climb: saturated cyan pushes toward
 * blue-white and saturated amber toward yellow, so the two semantic families
 * converge in exactly the region where the player most needs them separated (a
 * bright running process against a bright fault).
 */
export const CHAIN_TONE_MAPPING = AgXToneMapping;
