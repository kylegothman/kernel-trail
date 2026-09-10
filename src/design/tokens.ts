/**
 * KERNEL TRAIL: design tokens.
 *
 * This is the ONLY file in the repository permitted to contain a colour literal
 * (03-VISUAL-BIBLE section 1.3). An ESLint `no-restricted-syntax` rule matching
 * /0x[0-9a-fA-F]{6}/ and /#[0-9a-fA-F]{3,8}/ allows this path and no other.
 *
 * ASSEMBLY NOTE. The visual bible scatters this module across roughly a dozen
 * code blocks (sections 2.1, 2.2, 2.3, 2.4, 2.5, 4.5, 5.1, 5.3, 6.4, 7.1, 7.2,
 * 8.1) and Appendix B then names three sibling files, `motion.ts`,
 * `typography.ts` and `accessibility.ts`. Everything the build agent needs at
 * once is gathered here so that a single import cannot drift out of step with
 * itself; the sibling files should re-export from this module rather than
 * redeclaring anything. Every reconciliation is marked RECONCILED.
 *
 * COLOUR SPACE. Base colours are authored as sRGB hex and converted once, at
 * module load, into linear-space `Color` instances. Everything downstream works
 * in linear. `THREE.ColorManagement.enabled = true` must be set before this
 * module is first imported or `Color.setHex(hex, SRGBColorSpace)` silently
 * no-ops and every emissive value in the game ends up roughly 2.2 gamma too
 * bright. The boot sequence in `src/app` owns that assignment.
 *
 * LAYERING. `src/design` may import only `src/design` (01-ARCHITECTURE section
 * 1.3), plus the third-party maths types it needs. That is why `Pace` is
 * redeclared here rather than imported from `@game/types`; see TICK_MS.
 */

import { Color, SRGBColorSpace } from 'three';

/* ------------------------------------------------------------------------- */
/* 1. The void (visual bible 2.1)                                             */
/* ------------------------------------------------------------------------- */

/**
 * The void base is #04060A, luminance 0.00178 linear. It is deliberately not
 * #000000: pure black gives the bloom pass no floor to sit against and makes the
 * tone mapper's toe indistinguishable from clipping, and the slight blue bias is
 * what makes the amber family read as genuinely warm rather than merely brighter.
 */
export const VOID = {
  /** Clear colour. The colour of nothing. */
  base: 0x04060a,
  /** Inert surfaces the player can see but that do nothing. */
  surface: 0x080b11,
  /** Inert surfaces catching the faint directional key light. Upper faces only. */
  surfaceLit: 0x0d1219,
  /** The thin band where the floor meets nothing, drawn as a line, not a gradient. */
  horizon: 0x0a1a24,
  /** Reflection floor tint. Never pure black or reflections read as fog. */
  floor: 0x060910,
} as const;

/* ------------------------------------------------------------------------- */
/* 2. The two emissive families and the achromatic family (visual bible 2.2)  */
/* ------------------------------------------------------------------------- */

/** Protagonist. The convoy, the kernel acting correctly, resident and clean state. */
export const CYAN = {
  /** Barely present. Structure you can see but that is not participating. */
  trace: 0x123844,
  /** Idle or ready. Present, waiting. */
  dim: 0x2f8fa8,
  /** The default working colour of a live line. */
  core: 0x5fd7f5,
  /** Something is happening here, right now. */
  hot: 0x9fecff,
  /** The centre of a running process. Reads as white with a cyan halo after bloom. */
  white: 0xd6f7ff,
} as const;

/**
 * Antagonist. Arbiters, faults, contention, dirt, cost, and anything the kernel
 * is doing under duress.
 */
export const AMBER = {
  trace: 0x3b1d04,
  dim: 0x7a3c06,
  core: 0xff9a2e,
  hot: 0xffbe5c,
  white: 0xffe0b0,
} as const;

/**
 * Achromatic. Structure, protection, text, and dead matter. Never used for a
 * simulation state that has a live counterpart in CYAN or AMBER.
 */
export const SLATE = {
  /** Dead. A terminated process, an unreachable block. Non-emissive. */
  dead: 0x1b2026,
  /** Inert outline. Geometry the player should perceive but not read. */
  outline: 0x39434d,
  /** Secondary HUD text. */
  secondary: 0x6b7a88,
  /** Protected, privileged, ring 0. Emissive but hueless. */
  protected: 0x9fb4c4,
  /** Primary text and the highest-authority structure. */
  primary: 0xe8f4ff,
} as const;

/**
 * There is no third hue. Corruption is expressed as a failure of colour (value
 * quantisation, per-block hue jitter around the base token, positional
 * displacement) rather than as a new colour, which keeps the palette closed.
 * See CORRUPTION below and visual bible 2.4.1.
 */
export type ColourFamily = 'cyan' | 'amber' | 'slate' | 'void';

/* ------------------------------------------------------------------------- */
/* 3. Linear-space colour cache                                               */
/* ------------------------------------------------------------------------- */

const _linearCache = new Map<number, Color>();

/**
 * sRGB hex to a shared linear-space `Color`. The returned instance is cached and
 * shared, so treat it as immutable: copy it (`target.copy(linearColor(hex))`)
 * before mutating. Sharing matters because the material factory builds hundreds
 * of materials from a handful of tokens and a `Color` per material is pure waste.
 */
export function linearColor(hex: number): Color {
  const hit = _linearCache.get(hex);
  if (hit !== undefined) return hit;
  // setHex with an explicit source colour space is the conversion; the second
  // argument is what makes this depend on ColorManagement.enabled.
  const c = new Color().setHex(hex, SRGBColorSpace);
  _linearCache.set(hex, c);
  return c;
}

/**
 * Relative luminance of an sRGB hex in LINEAR space, using Rec. 709 weights.
 * Used by the gain-compensation reasoning below and by
 * `scripts/verify-contrast.ts`, which recomputes the section 2.6 table at build
 * time and fails the build when a text token drops below its stated floor.
 */
export function linearLuminance(hex: number): number {
  const c = linearColor(hex);
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

/* ------------------------------------------------------------------------- */
/* 4. HDR gains (visual bible 2.3)                                            */
/* ------------------------------------------------------------------------- */

/**
 * Multipliers applied to a linear emissive colour before it is written to the
 * RGBA16F target. The bloom bright-pass threshold sits at 1.15, deliberately
 * between `dim` and `active`, so that idle structure never halos and working
 * structure always does. Changing BLOOM.threshold without changing these is a
 * visual regression, and the reverse is equally true.
 *
 * RECONCILED. Section 2.3 lists five levels. The semantic table in section 2.4
 * then assigns a gain of `0` to `terminated` and `page_absent`, which cannot be
 * expressed as a `keyof typeof EMISSIVE_GAIN` against a five-entry table. `off`
 * is added here as a sixth level so `SemanticToken.level` stays a key of this
 * object, which is what section 2.4's own `SemanticToken` interface requires.
 * It does not disturb the threshold argument: 0 is below `ambient`, so the rule
 * in principle 1.1 ("emissiveIntensity > EMISSIVE_GAIN.ambient implies a live
 * entity") is unaffected.
 */
export const EMISSIVE_GAIN = {
  /** Not emitting at all. Matte, wireframe, or an empty socket. */
  off: 0.0,
  /** Visible, never blooms. Structural hairlines, grid, inert edges. */
  ambient: 0.45,
  /** Visible, never blooms. Ready, resident, idle. */
  dim: 1.1,
  /** Blooms with a small halo. The default for anything actively doing work. */
  active: 1.85,
  /** Blooms hard. Running process cores, acquired locks, page seat flashes. */
  hot: 3.2,
  /**
   * Blooms to a white core. Reserved for the derezz spike, kernel panic, and the
   * Portal. Never a steady state, only a transient.
   */
  critical: 4.6,
} as const;

export type GainLevel = keyof typeof EMISSIVE_GAIN;

/**
 * Amber at a given gain reads dimmer than cyan at the same gain because its
 * relative luminance is lower (0.446 against 0.576 for the core tokens).
 * Multiply every amber gain by this so a hot amber and a hot cyan produce halos
 * of equal radius. Without it, hazards look less urgent than routine work,
 * which inverts the meaning of the whole palette.
 */
export const AMBER_GAIN_COMPENSATION = 1.25;

/** Applied gain for a family at a level. Amber is compensated; nothing else is. */
export const gainFor = (family: ColourFamily, level: GainLevel): number =>
  EMISSIVE_GAIN[level] * (family === 'amber' ? AMBER_GAIN_COMPENSATION : 1);

/* ------------------------------------------------------------------------- */
/* 5. Bloom constants (visual bible 4.3, 4.5, 4.6)                            */
/* ------------------------------------------------------------------------- */

/**
 * These live in the token module rather than in the post chain because they are
 * only meaningful against EMISSIVE_GAIN, and a reviewer changing one must see
 * the other. `ambient` (0.45) and `dim` (1.10) sit below the threshold and never
 * bloom; `active` (1.85) sits comfortably above and produces a tight halo;
 * `hot` and `critical` produce the flares. That relationship is the entire
 * reason the grid floor stays crisp while working structure glows.
 */
export const BLOOM = {
  /** Bright-pass threshold, in linear luminance. Tier-independent (13.2 rule 6). */
  threshold: 1.15,
  /** Soft-knee width. Stops a hairline at gain 1.14 flickering as it drifts to 1.16. */
  knee: 0.55,
  /**
   * Global strength. Deliberately low: bloom is an accent on a mostly black
   * frame and the perceived intensity comes from the HDR gains. Above 0.09 the
   * image washes.
   */
  strength: 0.055,
  /**
   * Clamp applied to the bloom buffer before the down chain. Stops a single
   * `critical` flare producing a full-screen white field for one frame during a
   * derezz.
   */
  clamp: 12.0,
  /** Per-level weights, front-loaded, normalised at use. Six levels at high tier. */
  weights: [1.0, 0.62, 0.37, 0.21, 0.12, 0.07],
} as const;

/**
 * Multiplied into each level during the upsample chain. Wider levels are
 * progressively cooler and slightly desaturated, which is what a real lens does
 * to a bright source and what keeps a big amber flare from turning the whole
 * frame orange.
 */
export const BLOOM_TINT: readonly (readonly [number, number, number])[] = [
  [1.0, 1.0, 1.0],
  [0.98, 1.0, 1.02],
  [0.94, 0.99, 1.05],
  [0.9, 0.97, 1.09],
  [0.86, 0.95, 1.13],
  [0.82, 0.93, 1.18],
];

/**
 * The one moment the look is deliberately broken. `kernel.panic` is the only
 * event permitted to change the global post configuration (visual bible 4.6).
 */
export const PANIC_POST = {
  /** Duration of the amber flood before the cut to black. */
  floodMs: 900,
  /** Duration of the cut to black that follows. */
  cutMs: 120,
  /** Bright-pass threshold while flooding. Everything blooms. */
  threshold: 0.35,
  /** Global bloom strength while flooding. */
  strength: 0.22,
  /** Bloom tint forced to this token for the duration. */
  tintHex: AMBER.white,
  /** Vignette contracts by this fraction. */
  vignetteContraction: 0.3,
} as const;

/* ------------------------------------------------------------------------- */
/* 6. Redundancy channels: types (visual bible 2.4, 2.5)                      */
/* ------------------------------------------------------------------------- */

export type SemanticId =
  | 'ready'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'starving'
  | 'terminated'
  | 'zombie'
  | 'page_clean'
  | 'page_dirty'
  | 'page_absent'
  | 'frame_free'
  | 'resource_locked'
  | 'resource_contended'
  | 'resource_free'
  | 'corrupted'
  | 'protected'
  | 'denied'
  | 'panic';

export type DashPattern = 'solid' | 'long' | 'short' | 'dot' | 'gap' | 'none';
export type HatchPattern = 'none' | 'diagonal' | 'cross' | 'scan' | 'lattice' | 'noise';

/**
 * Channel 1 of the four redundancy channels. Every semantic state has a distinct
 * outline shape so that the cyan/amber distinction survives monochromacy and
 * tritanopia. The variants are named for what the generator does to the base
 * form rather than for the state, because several states share a treatment.
 */
export type Silhouette =
  /** Hexagonal prism, full height, flat top. */
  | 'prism'
  /** Prism with a horizontal ring orbiting at 60% height. */
  | 'prism-ringed'
  /** Prism, top face open, hollowed to a shell. */
  | 'prism-hollow'
  /** Prism with a solid bar across the front face at 50% height. */
  | 'prism-barred'
  /** Prism, visibly shortened. See STARVING_HEIGHT_SCALE. */
  | 'prism-shortened'
  /** Wireframe of the prism, no faces. */
  | 'prism-wire'
  /** Prism faces present but normals inverted, so it reads as a hole. */
  | 'prism-inverted'
  /** Flat slab, chamfered edges. */
  | 'slab'
  /** Slab with a raised 2 cm rib across the diagonal. */
  | 'slab-ribbed'
  /** An empty slab socket: the recess with no plate in it. */
  | 'socket-empty'
  /** Socket outline only, no fill. */
  | 'socket-outline'
  /** Closed torus. */
  | 'torus-closed'
  /** Torus split into `waitQueue.length` arcs with visible gaps. */
  | 'torus-split'
  /** Open ring, one gap. */
  | 'torus-gapped'
  /** Any form, wrapped in a 12 cm lattice cage. */
  | 'caged'
  /** Any form, displaced and dropped out by the corruption shader. */
  | 'displaced'
  /** Whatever form the object already had. Used by transient flashes. */
  | 'inherit';

/** Dash geometry in metres of arc length. Fed to `LineMaterial.dashSize`/`gapSize`. */
export interface DashGeometry {
  readonly on: number;
  readonly off: number;
}

/**
 * Channel 2. The fat-line material carries a dash pattern encoded in a
 * per-vertex arc-length attribute. World units, so a dash is the same physical
 * length at 8 m and at 60 m, which is what makes the pattern countable.
 *
 * RECONCILED. Section 2.5 gives lengths for `long`, `short`, `dot` and `gap`
 * only. `solid` and `none` carry no dash geometry; both are given `on: 1, off: 0`
 * so that a consumer can read `DASH[p]` unconditionally, and the material
 * factory switches `dashed` off for those two rather than reading these numbers.
 */
export const DASH: Readonly<Record<DashPattern, DashGeometry>> = {
  solid: { on: 1, off: 0 },
  long: { on: 0.6, off: 0.2 },
  short: { on: 0.2, off: 0.2 },
  dot: { on: 0.05, off: 0.25 },
  gap: { on: 0.1, off: 0.6 },
  none: { on: 1, off: 0 },
};

/**
 * Hatch ids as consumed by the `uHatch` uniform branch in the emissive panel
 * shader (visual bible 3.3).
 *
 * RECONCILED. The panel shader in section 3.3 branches on ids 1 through 4 and
 * has no branch for `noise`, which section 2.4's corrupted row needs. Id 5 is
 * assigned here so the table is total.
 */
// TODO(astra): add the `uHatch == 5.0` branch to the emissive panel fragment
// shader in src/render/materials/index.ts. It must call the same `hash31(cell)`
// used by corrupt.glsl.ts on `floor(vLocalPos / 0.06)` so the panel hatch and the
// corruption shader agree cell-for-cell on the same object, then threshold at
// 0.18 to match the dropout term. Do not introduce a second noise function.
export const HATCH_ID: Readonly<Record<HatchPattern, number>> = {
  none: 0,
  diagonal: 1,
  cross: 2,
  scan: 3,
  lattice: 4,
  noise: 5,
};

/**
 * Channel 3. Emissive gain is modulated by `1 + depth * sin(uTime * pulseHz * TAU)`.
 * Rhythms are chosen to be countable rather than subliminal.
 */
export const PULSE = {
  /** Default modulation depth. Matches the line and panel shaders in 3.2 and 3.3. */
  depth: 0.12,
  /** Depth when `VisionSettings.emphasiseShapeChannel` is on (section 2.5). */
  depthEmphasised: 0.3,
  /**
   * Contention is phase-locked across every contended resource so that
   * contention reads as one system-wide beat rather than as N unrelated blinks.
   * The world layer must feed a single shared phase to every contended ring.
   */
  contendedPhaseLocked: true,
  /** Cap applied to every pulse and flow when `VisionSettings.reducedMotion` is on. */
  reducedMotionMaxHz: 0.5,
} as const;

/**
 * Starvation is the one state whose pulse is a function of simulation data
 * rather than a constant: it accelerates as the fatal threshold approaches, so
 * the player can hear the clock without a UI element.
 */
export const STARVING_PULSE_HZ = { from: 2.6, to: 4.0 } as const;

/**
 * Silhouette scale for `starving`, per section 2.5:
 * `1 - min(0.4, waitedTicks / fatalThreshold * 0.4)`.
 */
export const STARVING_HEIGHT_SCALE = { maxShrink: 0.4 } as const;

export interface SemanticToken {
  readonly id: SemanticId;
  readonly hex: number;
  readonly family: ColourFamily;
  readonly level: GainLevel;
  /** Channel 1. */
  readonly silhouette: Silhouette;
  /** Channel 2. */
  readonly dash: DashPattern;
  /** Surface pattern, carried by the emissive panel shader. */
  readonly hatch: HatchPattern;
  /** Channel 3. 0 means steady. */
  readonly pulseHz: number;
  /** Channel 4. A single-character prefix on every world-space label. */
  readonly glyph: string;
}

/* ------------------------------------------------------------------------- */
/* 7. Semantic tokens (visual bible 2.4 and 2.5, merged)                      */
/* ------------------------------------------------------------------------- */

/**
 * The semantic table is the join of three tables in the visual bible: the
 * colour/gain table in 2.4, the silhouette table in 2.5, and the dash, pulse and
 * glyph assignments in 2.5's prose. They are merged here because a state whose
 * colour and whose shape live in different files will eventually disagree, and
 * `tests/render/monochrome.test.ts` can only check what it can read from one
 * object.
 *
 * RECONCILED, gains. Section 2.4 quotes several gains in already-compensated
 * form (`blocked` 1.375, `page_dirty` 2.3125, `resource_contended` 4.00,
 * `denied` and `panic` 5.75). Each is exactly `EMISSIVE_GAIN[level] * 1.25`, so
 * the table stores the uncompensated `level` and `gainFor` reproduces the quoted
 * number. Nothing was changed; the redundancy was removed.
 *
 * RECONCILED, `corrupted`. Section 2.4 gives its family as "none", which is not
 * a member of ColourFamily. It is recorded as `void` (no amber compensation),
 * because the corruption shader in 2.4.1 overwrites the hue at runtime from
 * whatever the object's own base token was, so the family field here is inert
 * for this row and must not be read as a hue.
 *
 * DERIVED, five glyphs. Section 2.5 assigns 13 glyphs for 18 states. The five
 * missing (`page_absent`, `frame_free`, `resource_free`, `denied`, `panic`) are
 * derived below and marked. They were chosen to be visually distinct from every
 * assigned glyph at 13 px in JetBrains Mono, which is the constraint the
 * assigned set satisfies.
 *
 * DERIVED, twelve dash patterns. Section 2.5 assigns dashes for the six process
 * states only. The remaining twelve are derived from the principle the assigned
 * six follow: `solid` means active and uninterrupted, `long` means present and
 * idle, `short` means impeded, `dot` means absent or waiting, `gap` means
 * failing, `none` means dead.
 */
export const SEMANTICS: Readonly<Record<SemanticId, SemanticToken>> = {
  ready: {
    id: 'ready',
    hex: CYAN.dim,
    family: 'cyan',
    level: 'dim',
    silhouette: 'prism',
    dash: 'long',
    hatch: 'none',
    pulseHz: 0.5,
    glyph: '.',
  },
  running: {
    id: 'running',
    hex: CYAN.white,
    family: 'cyan',
    level: 'hot',
    silhouette: 'prism-ringed',
    dash: 'solid',
    hatch: 'none',
    pulseHz: 0,
    glyph: '>',
  },
  waiting: {
    id: 'waiting',
    hex: CYAN.trace,
    family: 'cyan',
    level: 'ambient',
    silhouette: 'prism-hollow',
    dash: 'dot',
    hatch: 'none',
    pulseHz: 0,
    glyph: '~',
  },
  blocked: {
    id: 'blocked',
    hex: AMBER.core,
    family: 'amber',
    level: 'dim',
    silhouette: 'prism-barred',
    dash: 'short',
    hatch: 'none',
    pulseHz: 1.4,
    glyph: '#',
  },
  starving: {
    id: 'starving',
    hex: AMBER.dim,
    family: 'amber',
    level: 'dim',
    silhouette: 'prism-shortened',
    dash: 'gap',
    // Pulse climbs toward STARVING_PULSE_HZ.to as the fatal threshold nears; the
    // value here is the floor, not a constant.
    pulseHz: STARVING_PULSE_HZ.from,
    hatch: 'none',
    glyph: '!',
  },
  terminated: {
    id: 'terminated',
    hex: SLATE.dead,
    family: 'slate',
    level: 'off',
    silhouette: 'prism-wire',
    dash: 'none',
    hatch: 'none',
    pulseHz: 0,
    glyph: 'x',
  },
  zombie: {
    id: 'zombie',
    hex: SLATE.outline,
    family: 'slate',
    level: 'ambient',
    silhouette: 'prism-inverted',
    // DERIVED: dead, so `none`, matching `terminated`. The silhouette carries the
    // distinction between the two (a hole against a wireframe), which is what
    // channel 1 is for.
    dash: 'none',
    hatch: 'none',
    pulseHz: 0,
    glyph: 'z',
  },
  page_clean: {
    id: 'page_clean',
    hex: CYAN.core,
    family: 'cyan',
    level: 'dim',
    silhouette: 'slab',
    dash: 'solid',
    hatch: 'none',
    pulseHz: 0,
    glyph: '-',
  },
  page_dirty: {
    id: 'page_dirty',
    hex: AMBER.core,
    family: 'amber',
    level: 'active',
    silhouette: 'slab-ribbed',
    dash: 'short',
    hatch: 'diagonal',
    pulseHz: 0,
    glyph: '*',
  },
  page_absent: {
    id: 'page_absent',
    hex: VOID.base,
    family: 'void',
    level: 'off',
    silhouette: 'socket-empty',
    dash: 'none',
    hatch: 'none',
    pulseHz: 0,
    // DERIVED glyph: an underscore reads as a vacant slot and collides with
    // nothing in the assigned set.
    glyph: '_',
  },
  frame_free: {
    id: 'frame_free',
    hex: CYAN.trace,
    family: 'cyan',
    level: 'ambient',
    silhouette: 'socket-outline',
    dash: 'dot',
    hatch: 'none',
    pulseHz: 0,
    // DERIVED glyph: a lowercase o reads as an empty container against the
    // uppercase O used for a free resource ring.
    glyph: 'o',
  },
  resource_locked: {
    id: 'resource_locked',
    hex: SLATE.primary,
    family: 'slate',
    level: 'active',
    silhouette: 'torus-closed',
    dash: 'solid',
    hatch: 'none',
    pulseHz: 0,
    glyph: '@',
  },
  resource_contended: {
    id: 'resource_contended',
    hex: AMBER.hot,
    family: 'amber',
    level: 'hot',
    silhouette: 'torus-split',
    dash: 'gap',
    hatch: 'none',
    // Phase-locked across every contended resource. See PULSE.contendedPhaseLocked.
    pulseHz: 1.4,
    glyph: '%',
  },
  resource_free: {
    id: 'resource_free',
    hex: CYAN.dim,
    family: 'cyan',
    level: 'dim',
    silhouette: 'torus-gapped',
    dash: 'long',
    hatch: 'none',
    pulseHz: 0,
    // DERIVED glyph: uppercase O, an open ring, against the closed @ of a lock.
    glyph: 'O',
  },
  corrupted: {
    id: 'corrupted',
    // The corruption shader replaces this at runtime with a destroyed version of
    // the object's own base token. VOID.base is the value written when uCorrupt
    // reaches a dropped-out cell, so it is the honest neutral to store here.
    hex: VOID.base,
    family: 'void',
    level: 'active',
    silhouette: 'displaced',
    dash: 'dot',
    hatch: 'noise',
    pulseHz: 0,
    glyph: '?',
  },
  protected: {
    id: 'protected',
    hex: SLATE.protected,
    family: 'slate',
    level: 'dim',
    silhouette: 'caged',
    dash: 'short',
    hatch: 'lattice',
    pulseHz: 0,
    glyph: '=',
  },
  denied: {
    id: 'denied',
    hex: AMBER.core,
    family: 'amber',
    level: 'critical',
    // A hard flash, then nothing. The object keeps whatever silhouette it had.
    silhouette: 'inherit',
    dash: 'solid',
    hatch: 'none',
    pulseHz: 0,
    // DERIVED glyph: uppercase X, distinct from the lowercase x of `terminated`
    // at 13 px in a mono face with square terminals.
    glyph: 'X',
  },
  panic: {
    id: 'panic',
    hex: AMBER.white,
    family: 'amber',
    level: 'critical',
    silhouette: 'inherit',
    dash: 'solid',
    hatch: 'none',
    pulseHz: 0,
    // DERIVED glyph: an ampersand, unused elsewhere and visually heavy, which
    // suits the only state that takes over the whole frame.
    glyph: '&',
  },
};

/** Duration of the `denied` flash before the object returns to its prior token. */
export const DENIED_FLASH_MS = 180;

/* ------------------------------------------------------------------------- */
/* 8. Corruption (visual bible 2.4.1)                                         */
/* ------------------------------------------------------------------------- */

/**
 * Corruption has no hue of its own. These are the uniforms the corruption
 * post-transform reads; they are tokens rather than shader constants so the
 * corruption of a page slab and the corruption of an inode spindle are
 * demonstrably the same phenomenon.
 */
export const CORRUPTION = {
  /** Ramp-in when `fs.corruption` fires, milliseconds. */
  rampInMs: 400,
  /** Retreat when `fs.recovered` fires, milliseconds. */
  rampOutMs: 600,
  /** Position quantisation cell, metres. Gives the damage block structure. */
  cellMetres: 0.06,
  /** Value quantisation: collapse the emissive ramp to this many steps. */
  valueSteps: 3,
  /** Hue jitter, plus or minus, in HSV hue units. Never introduces a new family. */
  hueJitter: 0.06,
  /** Fraction of cells that go fully dark. This is what reads as "broken". */
  dropout: 0.18,
  /** Positional displacement amplitude in the vertex stage, metres. */
  displaceMetres: 0.035,
} as const;

/* ------------------------------------------------------------------------- */
/* 9. Accessibility (visual bible 2.5)                                        */
/* ------------------------------------------------------------------------- */

export interface VisionSettings {
  /**
   * Strips hue entirely. Amber becomes SLATE.primary at full gain, cyan becomes
   * SLATE.protected at 0.55 gain. Luminance separation is preserved, so every
   * semantic pair remains distinguishable by brightness alone.
   */
  monochromeSemantics: boolean;
  /** Doubles dash-pattern contrast and raises pulse depth to PULSE.depthEmphasised. */
  emphasiseShapeChannel: boolean;
  /** Adds the glyph prefix to HUD chips as well as world labels. */
  glyphPrefixes: boolean;
  /**
   * Caps bloom strength at 0.5x and raises the threshold to 1.6 for players who
   * find heavy bloom fatiguing. Never disables it entirely, because emission is
   * the semantic system.
   */
  reducedBloom: boolean;
  /**
   * Caps every pulse and flow animation at PULSE.reducedMotionMaxHz and disables
   * the FOV change in leg 8's thrashing state.
   */
  reducedMotion: boolean;
}

export const DEFAULT_VISION_SETTINGS: VisionSettings = {
  monochromeSemantics: false,
  emphasiseShapeChannel: false,
  glyphPrefixes: false,
  reducedBloom: false,
  reducedMotion: false,
};

/**
 * The monochrome mapping from section 2.5. This is the same code path as the
 * Shape Channel test in principle 1.4, which is deliberate: the accessibility
 * mode cannot rot without failing CI.
 */
export const MONOCHROME = {
  /** Amber becomes this at full gain. */
  amberHex: SLATE.primary,
  amberGainScale: 1.0,
  /** Cyan becomes this at 0.55 gain. */
  cyanHex: SLATE.protected,
  cyanGainScale: 0.55,
} as const;

/** Multipliers applied to the bloom tokens when `reducedBloom` is on. */
export const REDUCED_BLOOM = { strengthScale: 0.5, threshold: 1.6 } as const;

/* ------------------------------------------------------------------------- */
/* 10. Typography (visual bible 7.1, 7.2)                                     */
/* ------------------------------------------------------------------------- */

/**
 * Two families. No third family, ever. Both ship through `@fontsource` packages
 * bundled with the app rather than from a CDN, so the game works offline from
 * static hosting. The font files are the only binary assets in the project; the
 * SDF atlases derived from them are generated at runtime.
 */
export const FONT_STACK = {
  /**
   * Simulation data. JetBrains Mono: unambiguous l/1/I at 12 px, slashed zero,
   * square-cut terminals that sit correctly against hard-edged geometry, and
   * tabular figures by construction so columns align without `tabular-nums`.
   * Weights loaded: 400 and 700. Nothing else.
   */
  mono:
    "'JetBrains Mono', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, " +
    "Consolas, 'Liberation Mono', monospace",
  /**
   * Narrative. Jost: geometric, near-circular bowls, single-storey a. Carries leg
   * titles, debrief cards, tombstone inscriptions and codex prose. It is not the
   * reference film's typeface and must not be tracked or condensed to imitate one.
   * Weights loaded: 300, 400 and 600.
   */
  sans: "'Jost', ui-sans-serif, 'Avenir Next', 'Century Gothic', system-ui, sans-serif",
} as const;

export const FONT_WEIGHTS = {
  mono: [400, 700],
  sans: [300, 400, 600],
} as const;

/**
 * Cap-height ratio of JetBrains Mono, used to convert a world-space cap height in
 * metres into `Text.fontSize` for troika: `fontSize = capHeight / MONO_CAP_RATIO`.
 */
export const MONO_CAP_RATIO = 0.72;

export type TypeScaleId =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'data'
  | 'dataEmphasis'
  | 'micro';

export interface TypeStyle {
  /** rem against a 16 px root. */
  readonly sizeRem: number;
  readonly lineHeight: number;
  /** em. */
  readonly tracking: number;
  readonly family: 'mono' | 'sans';
  readonly weight: number;
  /** Uppercase-only tokens are marked so the HUD does not have to remember. */
  readonly uppercase: boolean;
}

/**
 * Positive tracking on the monospace tokens is deliberate: mono at small sizes
 * against black with bloom in the frame closes up, and 0.02em opens the counters
 * enough to hold at 13 px. Negative tracking on the display tokens is equally
 * deliberate, because Jost's default spacing is loose at large sizes.
 */
export const TYPE_SCALE: Readonly<Record<TypeScaleId, TypeStyle>> = {
  display: { sizeRem: 2.75, lineHeight: 1.05, tracking: -0.02, family: 'sans', weight: 300, uppercase: false },
  title: { sizeRem: 1.75, lineHeight: 1.15, tracking: -0.01, family: 'sans', weight: 400, uppercase: false },
  heading: { sizeRem: 1.125, lineHeight: 1.25, tracking: 0.0, family: 'sans', weight: 600, uppercase: false },
  body: { sizeRem: 0.9375, lineHeight: 1.55, tracking: 0.0, family: 'sans', weight: 400, uppercase: false },
  data: { sizeRem: 0.8125, lineHeight: 1.4, tracking: 0.02, family: 'mono', weight: 400, uppercase: false },
  dataEmphasis: { sizeRem: 0.8125, lineHeight: 1.4, tracking: 0.02, family: 'mono', weight: 700, uppercase: false },
  micro: { sizeRem: 0.6875, lineHeight: 1.3, tracking: 0.06, family: 'mono', weight: 400, uppercase: true },
};

export type WorldLabelClass =
  | 'processName'
  | 'frameIndex'
  | 'resourceName'
  | 'structureTitle'
  | 'valueReadout';

/** World-space cap heights in metres, for the free camera. Locked framing uses 6.6. */
export const WORLD_CAP_HEIGHT_M: Readonly<Record<WorldLabelClass, number>> = {
  /** Above the stele's top face. */
  processName: 0.16,
  /** On the slab face, coplanar. */
  frameIndex: 0.09,
  /** Above the ring. */
  resourceName: 0.14,
  /** Above a whole vault, yard, or platter stack. */
  structureTitle: 0.34,
  /** Adjacent to the value it names. */
  valueReadout: 0.11,
};

/**
 * Text never scales below this many device pixels, at any tier (13.2 rule 3).
 * If a structure is dense enough that the locked framing would push a glyph
 * below it, the framing expands to a sub-region and the lock gains a pan
 * affordance rather than shrinking the type.
 */
export const MIN_GLYPH_PX = 13;

/** The label backing plate. Holds local background luminance below 0.012. */
export const LABEL_PLATE = {
  hex: VOID.base,
  opacity: 0.72,
  /** Padding around the measured text bounds, metres. */
  paddingM: 0.06,
  /** Emissive hairline along the plate's bottom edge, metres, at gain `dim`. */
  hairlineM: 0.006,
  hairlineLevel: 'dim',
} as const satisfies { hex: number; opacity: number; paddingM: number; hairlineM: number; hairlineLevel: GainLevel };

/** SDF glyph atlas resolution by tier. Softens edges at low; never changes size. */
export const SDF_GLYPH_SIZE = { low: 48, medium: 64, high: 64 } as const;

/**
 * Contrast floors against VOID.base, WCAG 2.1, recomputed at build time by
 * `scripts/verify-contrast.ts`. `never` means the token may be used as fill or
 * outline but not as text at any size.
 */
export type TextPermission = 'any-size' | 'body-14px-and-above' | 'never';

export const TEXT_CONTRAST: readonly {
  readonly hex: number;
  readonly ratio: number;
  readonly permitted: TextPermission;
}[] = [
  { hex: SLATE.primary, ratio: 17.4, permitted: 'any-size' },
  { hex: CYAN.white, ratio: 18.0, permitted: 'any-size' },
  { hex: AMBER.white, ratio: 16.0, permitted: 'any-size' },
  { hex: CYAN.core, ratio: 12.1, permitted: 'any-size' },
  { hex: AMBER.core, ratio: 9.6, permitted: 'any-size' },
  { hex: SLATE.protected, ratio: 9.5, permitted: 'any-size' },
  { hex: SLATE.secondary, ratio: 4.6, permitted: 'body-14px-and-above' },
  { hex: CYAN.dim, ratio: 5.4, permitted: 'body-14px-and-above' },
  { hex: AMBER.dim, ratio: 1.9, permitted: 'never' },
  { hex: SLATE.outline, ratio: 1.6, permitted: 'never' },
];

/* ------------------------------------------------------------------------- */
/* 11. Motion (visual bible 6.4, 8.1, 8.2)                                    */
/* ------------------------------------------------------------------------- */

/** Durations in milliseconds. */
export const DUR = {
  /** No animation. The value changes between frames. */
  instant: 0,
  /** A discrete simulation fact landing. Barely a transition, just not a jump cut. */
  snap: 90,
  /** A small state change with a visible cause. */
  quick: 160,
  /** The default for anything the player should notice. */
  base: 260,
  /** Something arriving or departing physically. */
  travel: 420,
  /** Focus camera engage. */
  focus: 520,
  /** Focus camera release. */
  release: 380,
  /** Named Program derezz. */
  derezz: 1400,
  /** Anonymous process derezz. */
  derezzMinor: 520,
  /** Ambient loops: pulses, flows, rotations. */
  ambient: 4000,
} as const;

/**
 * Cubic Bezier easing with x1,y1,x2,y2 in the CSS sense, solved by
 * Newton-Raphson. Eight iterations is exact to about 1e-6 for the curves in EASE;
 * the derivative guard handles the flat-slope case that Newton cannot solve, and
 * returning the current estimate there is within tolerance because a near-zero
 * slope means the curve is locally flat.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const A = (a: number, b: number): number => 1 - 3 * b + 3 * a;
  const B = (a: number, b: number): number => 3 * b - 6 * a;
  const C = (a: number): number => 3 * a;
  const calc = (t: number, a: number, b: number): number => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t: number, a: number, b: number): number =>
    3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

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

/**
 * RECONCILED. Section 6.4 defines EASE inside the focus camera file and section
 * 8.1 declares a second `EASE` in motion.ts with the body elided as "see 6.4".
 * There is one definition, here, and both consumers import it. Two identically
 * named easing tables in one codebase is how the engage and release curves end
 * up subtly different in a later refactor.
 */
export const EASE = {
  /**
   * Engage. Leaves quickly, arrives slowly, settles without overshoot. The long
   * tail is what makes the lock feel like the camera has come to rest rather
   * than been snapped into place.
   */
  focusIn: cubicBezier(0.16, 0.84, 0.24, 1.0),
  /**
   * Release. Shorter and flatter. Letting go should not feel as considered as
   * committing.
   */
  focusOut: cubicBezier(0.4, 0.0, 0.2, 1.0),
  snap: cubicBezier(0.2, 0.0, 0.0, 1.0),
  settle: cubicBezier(0.16, 0.84, 0.24, 1.0),
  out: cubicBezier(0.33, 1.0, 0.68, 1.0),
  inOut: cubicBezier(0.65, 0.0, 0.35, 1.0),
} as const;

export type EaseId = keyof typeof EASE;

/**
 * RECONCILED. Section 6.4 exports FOCUS_DURATION_MS = { engage: 520, release: 380 }
 * and section 8.1 exports the same two numbers as DUR.focus and DUR.release.
 * They are derived from DUR here so the pair cannot drift apart.
 */
export const FOCUS_DURATION_MS = { engage: DUR.focus, release: DUR.release } as const;

/**
 * Travel pace. Redeclared rather than imported: `src/design` may import only
 * `src/design` (01-ARCHITECTURE 1.3), and `Pace` is owned by `@game/types`.
 * A contract-freeze test (01-ARCHITECTURE 11.6) must assert the two unions are
 * identical, because a pace added to the game layer with no tick duration here
 * would silently run at whatever `steady` happens to be.
 */
export type Pace = 'conservative' | 'steady' | 'aggressive' | 'reckless';

/**
 * One simulation tick's wall-clock duration at each pace. Continuous
 * interpolation is always exactly one tick long, so motion speed reads as
 * simulation speed and the player can feel the quantum.
 */
export const TICK_MS: Readonly<Record<Pace, number>> = {
  conservative: 420,
  steady: 300,
  aggressive: 190,
  reckless: 120,
};

/**
 * Emissive gain ramps between states run over DUR.snap: short enough to read as
 * instant, long enough to avoid a one-frame flicker. Everything in section 8.2's
 * "snaps" list bypasses this entirely and changes between frames.
 */
export const GAIN_RAMP_MS = DUR.snap;

/* ------------------------------------------------------------------------- */
/* 12. Spatial and scale tokens (visual bible 1.7, 5.1, 5.3, 5.4, 5.6, 6.1)   */
/* ------------------------------------------------------------------------- */

/**
 * The module. Every leg contains at least one structural module repeated on this
 * pitch, at least 64 times, receding toward the horizon. The player counts
 * squares without being told to, which is the only depth cue available in a
 * scene with no atmosphere and no sky.
 */
export const MODULE_PITCH_M = 4.0;

/** Minimum repetition count for the establishing shot (principle 1.7). */
export const MODULE_MIN_COUNT = 64;

/**
 * The ruler. A 2.40 m process stele is visible in every leg at a known distance
 * and its height never varies, so the player calibrates once and it holds for
 * fourteen legs. Changing this number invalidates every screenshot test.
 */
export const STELE_HEIGHT_M = 2.4;

/**
 * Generated form dimensions, in metres, from the geometry vocabulary in 5.1.
 * These are tokens rather than constants inside each generator because several
 * of them appear in framing maths (`FocusTarget.extents`) and in the scale-cue
 * audit, and a generator that quietly grows breaks both.
 */
export const FORM = {
  /** Process. Upright hexagonal prism. Across flats, then height. */
  stele: { acrossFlats: 0.9, height: STELE_HEIGHT_M, chamfer: 0.04 },
  /** Thread. Filament orbiting its parent stele. */
  filament: { radius: 0.012, orbitRadius: 0.62 },
  /** CPU. A single tall column at the head of the ready procession. */
  cpuColumn: { across: 1.6, height: 6.0 },
  /** Resource type. Vertical ring on a plinth, segmented by instance count. */
  resourceRing: { outerRadius: 1.4, tube: 0.09 },
  /** Mutex. One-leaf gate across a walkway. */
  gate: { span: 2.0, perSlot: 0.8 },
  /** Monitor. Enclosed chamber with one gate and a condition alcove. */
  monitor: { diameter: 4.0 },
  /** Memory frame. Floor-embedded slab socket in a vault grid on MODULE_PITCH_M. */
  frameSocket: { x: 2.0, z: 2.0, depth: 0.25 },
  /** Page. Thin plate that seats into a frame socket. */
  pagePlate: { x: 1.84, z: 1.84, thickness: 0.12 },
  /** Page, leg 8 only. Hexagonal tile on the water. */
  hexTile: { circumradius: 1.6 },
  /** Data block. Cube. */
  block: { edge: 0.5 },
  /** Inode. Lathe-turned spindle with radial index arms. */
  spindle: { radius: 0.6, height: 1.8 },
  /** Disk platter. Lathe disc with a concentric cylinder groove pattern. */
  platter: { radius: 6.0, thickness: 0.08 },
  /** Disk head arm. Extruded taper with a lit tip. */
  headArm: { length: 5.2 },
  /** Device. Bollard with a readout face and an interrupt spike. */
  bollard: { across: 0.6, height: 1.8 },
  /** Protection ring. Concentric wall of vertical lattice, radius by ring index. */
  ringWall: { radiusByRing: [96, 64, 36, 16] },
  /** Journal. Ribbon of linked plates running along the floor. */
  journalRibbon: { width: 0.4 },
  /** Portal. Vertical aperture of parallel beams. */
  portal: { width: 8, height: 20 },
} as const;

/**
 * Per-form triangle budgets (12.5). Asserted by the leg smoke tests, because a
 * generator that returns a smooth cylinder where a hexagonal prism was specified
 * costs nothing visible and everything measurable.
 */
export const TRIANGLE_BUDGET = {
  stele: 96,
  pagePlate: 12,
  hexTile: 20,
  block: 12,
  /** Tier-dependent: low to high. */
  resourceRing: { low: 96, medium: 192, high: 384 },
  platter: { low: 128, medium: 256, high: 512 },
  bollard: 64,
} as const;

/** Grid floor shader parameters (5.3). Two scales, both derived from the module. */
export const GRID = {
  minorPitchM: 0.5,
  majorPitchM: MODULE_PITCH_M,
  minorHex: CYAN.trace,
  majorHex: CYAN.dim,
  /** Minor lines fade out between 0.25x and 1x of this distance. */
  fadeStartM: 55,
  /** Major lines fade out between fadeStartM and this. */
  fadeEndM: 420,
  /** Line thickness in screen pixels, so distant lines thin out cleanly. */
  minorWidthPx: 1.0,
  majorWidthPx: 1.6,
  /** Composite weights. Both terms sit at or below `dim` so the floor never blooms. */
  minorWeight: 0.45,
  majorWeight: 1.1,
  /** The plane is 4000 x 4000 and re-centres on the camera snapped to the major pitch. */
  planeSizeM: 4000,
} as const;

/** Horizon construction (5.4). There is no skybox, no HDRI, and no stars. */
export const HORIZON = {
  /** Emissive line ring at y = 0. Its job is to state that the floor ends. */
  ringRadiusM: 900,
  ringWidthM: 0.06,
  ringHex: CYAN.trace,
  ringLevel: 'ambient',
  /** Inward-facing cylinder shell, graded VOID.horizon at the base to VOID.base. */
  bandRadiusM: 880,
  bandHeightM: 60,
  /** Distant light columns, for parallax. One InstancedMesh, one draw call. */
  columnsInnerM: 400,
  columnsOuterM: 1400,
  columnHeightMinM: 20,
  columnHeightMaxM: 240,
  columnLevel: 'ambient',
} as const satisfies Record<string, number | string | GainLevel>;

/**
 * Emission is multiplied by `exp(-distance * DISTANCE_ATTENUATION)` in the line
 * and panel shaders. This is not physically correct for a vacuum; it is the
 * substitute for atmospheric perspective. At 400 m an emitter sits at 53%
 * intensity. Without the term, distant structure reads as small near structure
 * and the scene collapses to a flat image.
 */
export const DISTANCE_ATTENUATION = 0.0016;

/** Line and edge geometry (3.2, 5.5). */
export const LINE = {
  /**
   * World units, not screen units. A screen-space width makes distant structure
   * the same thickness as near structure, which destroys the depth read in a
   * scene with no atmosphere. 1.6 cm reads as a hairline at 8 m and stays visible
   * at 60 m without becoming a rope.
   */
  widthM: 0.016,
  worldUnits: true,
  /** Outward offset along the vertex normal for explicit edge geometry, metres. */
  edgeOffsetM: 0.004,
  /** Barycentric edge term width, screen pixels, for instanced forms. */
  baryEdgeWidthPx: 1.4,
  /** Explicit edge geometry is used below this edge count; barycentric above it. */
  explicitEdgeThreshold: 64,
} as const;

/** Emissive panel shader parameters (3.3). */
export const PANEL = {
  /** Metres of inset edge glow. */
  edgeWidthM: 0.035,
  /**
   * The single most important number in the panel shader. A panel whose whole
   * face sits at full gain reads as a glowing rectangle and washes the frame; a
   * panel whose face is dim and whose border is bright reads as a physical lit
   * slab. Do not raise it.
   */
  bodyTerm: 0.22,
  edgeTerm: 0.95,
  patternTerm: 0.55,
} as const;

/** Camera limits for the free (orbit-and-follow) mode (6.1). */
export const CAMERA = {
  fovDeg: 46,
  near: 0.1,
  far: 2000,
  pitchMinDeg: -8,
  pitchMaxDeg: 62,
  distanceMinM: 6,
  distanceMaxM: 90,
  /** Critically damped spring: never overshoots, never feels loose. */
  springOmega: 9.0,
} as const;

/** Focus camera framing and dimming defaults (6.1, 6.4, 6.5). */
export const FOCUS = {
  /** The framed structure fills this fraction of the smaller viewport axis. */
  fillFraction: 0.78,
  /** Extra framing margin as a fraction of extents. */
  padding: 0.12,
  /** How far everything outside the focus set is pushed down. 1 = fully dark. */
  dimOthers: 0.82,
  /** Matte bodies outside the focus set have their colour multiplied by this. */
  matteDim: 0.35,
  /** Locked-mode zoom range as a multiple of the computed framing. */
  zoomMin: 0.6,
  zoomMax: 1.6,
  /** Rotation completes this far ahead of position, so the frame settles once. */
  rotationLead: 1.12,
  /** Bezier control-point extension as a fraction of the pose separation. */
  arcControlFraction: 0.4,
  /** Minimum arc lift in metres, before the target-height term. */
  arcLiftMinM: 2,
  /** Arc lift scale applied to (targetTopY - min(fromY, toY)). */
  arcLiftScale: 0.35,
  /** Target device pixels for a glyph in the locked orthographic framing. */
  lockedGlyphPx: MIN_GLYPH_PX,
  /** Labels billboard to the camera below this blend, then slerp to the plane. */
  labelPlaneBlend: 0.5,
} as const;

/** Vignette (4.7). Applied pre-tonemap so it darkens exposure, not paints black. */
export const VIGNETTE = {
  strength: 0.34,
  power: 1.8,
  /** During a focus lock these ramp to here over the focus duration. */
  lockedStrength: 0.52,
  lockedPower: 2.1,
} as const;

/** The three permitted scene lights (12.4). There are never more than three. */
export const LIGHTS = {
  /** Stops matte bodies reading as pure silhouettes. Without it, form is lost. */
  ambient: { intensity: 0.06, skyHex: VOID.horizon, groundHex: VOID.base },
  /** Defines floor and upper-face normals. Casts no shadows. */
  key: { intensity: 0.15, direction: [0.3, 1.0, 0.4] },
  /** Exists only while the focus camera is locked. The one light a player notices. */
  read: { intensity: 0.35, penumbra: 0.9 },
} as const;

/**
 * Layer assignments. Text renders after tone mapping (pass 13) so no glyph is
 * ever an input to the bright pass, which removes the whole class of problem
 * where a bright label smears into an unreadable blob.
 *
 * DERIVED. The visual bible references `LAYER.WORLD` and `LAYER.TEXT` in five
 * places (3.6, 3.7, 4.1, 7.4) but never declares the enum. The numbering here is
 * the minimal set those references require, plus REFLECTION for the high-tier
 * planar pass in 3.7, which needs a layer of its own to render emissive geometry
 * and beams without the matte bodies.
 */
export const LAYER = {
  /** Everything that renders before tone mapping. */
  WORLD: 0,
  /** World-space SDF text. Rendered in pass 13, after the output transform. */
  TEXT: 1,
  /** Objects flagged `castsReflection`, drawn into the mirrored target. */
  REFLECTION: 2,
} as const;

/* ------------------------------------------------------------------------- */
/* 13. The frozen aggregate                                                   */
/* ------------------------------------------------------------------------- */

/**
 * A single frozen namespace for consumers that want one import. The named
 * exports above are the preferred surface, because they tree-shake and because
 * `tokens.SEMANTICS.running.hex` reads worse than `SEMANTICS.running.hex`.
 * This exists so that a debug overlay, the diagnostics bundle, and the token
 * documentation generator can enumerate everything without a manual list.
 *
 * `Object.freeze` is shallow, which is enough: every member is already `as const`
 * or a `Readonly<Record<...>>`, so the type system refuses mutation at compile
 * time and the freeze catches the `any`-cast case at runtime in development.
 */
export const tokens = Object.freeze({
  VOID,
  CYAN,
  AMBER,
  SLATE,
  EMISSIVE_GAIN,
  AMBER_GAIN_COMPENSATION,
  BLOOM,
  BLOOM_TINT,
  PANIC_POST,
  SEMANTICS,
  DASH,
  HATCH_ID,
  PULSE,
  STARVING_PULSE_HZ,
  STARVING_HEIGHT_SCALE,
  DENIED_FLASH_MS,
  CORRUPTION,
  MONOCHROME,
  REDUCED_BLOOM,
  DEFAULT_VISION_SETTINGS,
  FONT_STACK,
  FONT_WEIGHTS,
  MONO_CAP_RATIO,
  TYPE_SCALE,
  WORLD_CAP_HEIGHT_M,
  MIN_GLYPH_PX,
  LABEL_PLATE,
  SDF_GLYPH_SIZE,
  TEXT_CONTRAST,
  DUR,
  EASE,
  FOCUS_DURATION_MS,
  TICK_MS,
  GAIN_RAMP_MS,
  MODULE_PITCH_M,
  MODULE_MIN_COUNT,
  STELE_HEIGHT_M,
  FORM,
  TRIANGLE_BUDGET,
  GRID,
  HORIZON,
  DISTANCE_ATTENUATION,
  LINE,
  PANEL,
  CAMERA,
  FOCUS,
  VIGNETTE,
  LIGHTS,
  LAYER,
});

export type Tokens = typeof tokens;
