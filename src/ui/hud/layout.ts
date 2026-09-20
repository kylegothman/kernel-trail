/**
 * HUD layout constants, visual bible 11.3 and 11.4. Scope correction S12: the
 * `--hud-*` values are not in the frozen tokens, so they are declared here and
 * `hud.css.ts` emits the custom properties from them.
 */

export const HUD_SAFE = 'max(24px, 2.5vh)';
export const HUD_GUTTER_PX = 16;
export const HUD_REST = 0.72;
export const HUD_ACTIVE = 1;
export const HUD_FOCUSED = 0.25;
export const HUD_RADIUS_PX = 2;

/** A changed value holds full opacity this long, then eases back over HUD_EASE_BACK_MS. */
export const HUD_ACTIVE_HOLD_MS = 1200;
export const HUD_EASE_BACK_MS = 400;

/** Alerts auto-dismiss after this long. At most HUD_ALERT_MAX are shown at once. */
export const HUD_ALERT_TTL_MS = 6000;
export const HUD_ALERT_MAX = 3;
export const HUD_ALERT_MAX_CHARS = 64;

/** Both derived meters are 96 px wide, visual bible 11.1. */
export const HUD_METER_WIDTH_PX = 96;
/**
 * The marked threshold on the CPU utilisation meter. Utilisation climbing
 * past this while the fault rate climbs is the thrashing signature of
 * Ch. 10.6.1, which is what the pair of meters is there to show.
 */
export const HUD_CPU_MARK = 0.85;

/** The reference viewport the coverage cap is stated against. */
export const HUD_REFERENCE_VIEWPORT = { width: 1440, height: 900 } as const;
export const HUD_COVERAGE_CAP = 0.11;

export type HudRegionId =
  | 'legRail'
  | 'policyChips'
  | 'convoyPips'
  | 'resourceLedger'
  | 'alertStack'
  | 'focusHint';

export const HUD_REGION_IDS: readonly HudRegionId[] = [
  'legRail',
  'policyChips',
  'convoyPips',
  'resourceLedger',
  'alertStack',
  'focusHint',
];

export interface RegionBounds {
  readonly maxWidthPx: number;
  readonly maxHeightPx: number;
}

/**
 * The layout model: each region's declared maximum box at the reference
 * viewport with the worst-case fixture (five Programs alive, four non-zero
 * resources, three alerts, the longest policy names). `hud.css.ts` pins the
 * widths and line heights these numbers assume, and the browser run in
 * `tests/render/gpu/hud.gpu.ts` measures the real boxes against the same cap.
 * Regions never overlap, so the union of their boxes is the sum.
 */
export const HUD_REGION_BOUNDS: Readonly<Record<HudRegionId, RegionBounds>> = {
  /** Two rows. Measured 220 by 40 in Chromium. */
  legRail: { maxWidthPx: 220, maxHeightPx: 48 },
  /** The tick, five chip rows, the pace indicator row (WP-24) and the two meters. Measured 220 by 145 before the pace row. */
  policyChips: { maxWidthPx: 220, maxHeightPx: 170 },
  /** Five pips. Measured 220 by 96. */
  convoyPips: { maxWidthPx: 220, maxHeightPx: 104 },
  /** Four rows. Measured 220 by 78. */
  resourceLedger: { maxWidthPx: 220, maxHeightPx: 84 },
  /** Three lines of 64 characters at 13 px mono plus padding. Measured 512 by 60. */
  alertStack: { maxWidthPx: 520, maxHeightPx: 72 },
  /** One line. Measured 182 by 23 with the longest structure name. */
  focusHint: { maxWidthPx: 320, maxHeightPx: 26 },
};

export function hudCoverageFraction(viewportWidth: number, viewportHeight: number): number {
  let area = 0;
  for (const id of HUD_REGION_IDS) {
    const b = HUD_REGION_BOUNDS[id];
    area += b.maxWidthPx * b.maxHeightPx;
  }
  return area / (viewportWidth * viewportHeight);
}

/** The safe inset in pixels for a viewport, the `max(24px, 2.5vh)` rule evaluated. */
export function hudSafeInsetPx(viewportHeight: number): number {
  return Math.max(24, 0.025 * viewportHeight);
}
