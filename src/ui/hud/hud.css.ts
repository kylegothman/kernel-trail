/**
 * The HUD stylesheet, built from the frozen tokens and `layout.ts` so that no
 * colour literal and no layout number lives here. Visual bible 11.3 and 11.4.
 *
 * Rules the scan in tests/ui/hud.test.ts enforces on this text:
 *  - no `transform`, `translate`, `left`, `top` or `right` inside any
 *    `transition` or `animation` declaration (nothing animates position);
 *  - `pointer-events: none` on the container and `auto` on its children;
 *  - the tick counter renders from a custom property through `::after`.
 */

import { AMBER, CYAN, FONT_STACK, SEMANTICS, SLATE, TYPE_SCALE, VOID, cssColor } from '@design';
import {
  HUD_ACTIVE,
  HUD_EASE_BACK_MS,
  HUD_FOCUSED,
  HUD_GUTTER_PX,
  HUD_METER_WIDTH_PX,
  HUD_RADIUS_PX,
  HUD_REGION_BOUNDS,
  HUD_REST,
  HUD_SAFE,
} from './layout';

/**
 * Every token the HUD draws text in. All are `any-size` rows of TEXT_CONTRAST;
 * `tests/ui/hud.test.ts` computes each one against the void at HUD_REST.
 */
export const HUD_TEXT_TOKENS = {
  primary: SLATE.primary,
  label: SLATE.protected,
  nominal: CYAN.core,
  running: CYAN.white,
  warning: AMBER.core,
  fatal: AMBER.white,
} as const;

/** Alert severity to colour and glyph prefix, visual bible 11.4 and 2.5. */
export const ALERT_STYLE = {
  info: { hex: CYAN.core, glyph: SEMANTICS.ready.glyph },
  warning: { hex: AMBER.core, glyph: SEMANTICS.starving.glyph },
  fatal: { hex: AMBER.white, glyph: SEMANTICS.panic.glyph },
} as const;

const data = TYPE_SCALE.data;
const micro = TYPE_SCALE.micro;

export function buildHudCss(): string {
  const bounds = HUD_REGION_BOUNDS;
  return `
@property --kt-tick { syntax: '<integer>'; inherits: true; initial-value: 0; }
:root {
  --hud-safe: ${HUD_SAFE};
  --hud-gutter: ${HUD_GUTTER_PX}px;
  --hud-rest: ${HUD_REST};
  --hud-active: ${HUD_ACTIVE};
  --hud-focused: ${HUD_FOCUSED};
  --hud-radius: ${HUD_RADIUS_PX}px;
  --hud-bg: ${cssColor(VOID.base, 0.72)};
  --hud-rule: ${cssColor(CYAN.dim, 0.35)};
  --font-mono: ${FONT_STACK.mono};
  --slate-primary: ${cssColor(SLATE.primary)};
}
.kt-hud {
  position: absolute;
  inset: var(--hud-safe);
  display: grid;
  grid-template-columns: minmax(220px, 22ch) 1fr minmax(220px, 26ch);
  grid-template-rows: auto 1fr auto;
  gap: var(--hud-gutter);
  pointer-events: none;
  font-family: var(--font-mono);
  font-size: ${data.sizeRem}rem;
  line-height: ${data.lineHeight};
  letter-spacing: ${data.tracking}em;
  color: var(--slate-primary);
  transition: opacity 220ms cubic-bezier(0.33, 1, 0.68, 1);
}
.kt-hud > * { pointer-events: auto; }
.kt-hud[hidden] { display: none; }
.kt-hud > .kt-cell {
  box-sizing: border-box;
  background: var(--hud-bg);
  border-radius: var(--hud-radius);
  border-bottom: 1px solid var(--hud-rule);
  padding: 2px 6px;
  opacity: var(--hud-rest);
  transition: opacity ${HUD_EASE_BACK_MS}ms cubic-bezier(0.33, 1, 0.68, 1);
}
.kt-hud > .kt-cell[data-hud-state="active"] { opacity: var(--hud-active); transition: none; }
.kt-hud[data-focus="locked"] > .kt-cell { opacity: var(--hud-focused); }
.kt-hud[data-focus="locked"] > .kt-cell.kt-alerts { opacity: var(--hud-active); }
.kt-hud > .kt-cell:empty { display: none; }
.kt-tl { grid-area: 1 / 1; max-width: ${bounds.legRail.maxWidthPx}px; max-height: ${bounds.legRail.maxHeightPx}px; align-self: start; }
.kt-tr { grid-area: 1 / 3; max-width: ${bounds.policyChips.maxWidthPx}px; max-height: ${bounds.policyChips.maxHeightPx}px; align-self: start; }
.kt-bl { grid-area: 3 / 1; max-width: ${bounds.convoyPips.maxWidthPx}px; max-height: ${bounds.convoyPips.maxHeightPx}px; align-self: end; }
.kt-br { grid-area: 3 / 3; max-width: ${bounds.resourceLedger.maxWidthPx}px; max-height: ${bounds.resourceLedger.maxHeightPx}px; align-self: end; }
.kt-alerts { grid-area: 2 / 2; width: max-content; max-width: ${bounds.alertStack.maxWidthPx}px; max-height: ${bounds.alertStack.maxHeightPx}px; justify-self: center; align-self: end; }
.kt-hint { grid-area: 3 / 2; width: max-content; max-width: ${bounds.focusHint.maxWidthPx}px; max-height: ${bounds.focusHint.maxHeightPx}px; justify-self: center; align-self: end; }
.kt-row { display: flex; gap: 6px; align-items: baseline; white-space: nowrap; overflow: hidden; }
.kt-label {
  font-size: ${micro.sizeRem}rem;
  line-height: ${micro.lineHeight};
  letter-spacing: ${micro.tracking}em;
  text-transform: uppercase;
  color: ${cssColor(SLATE.protected)};
}
.kt-value { color: ${cssColor(SLATE.primary)}; }
.kt-bar {
  position: relative;
  display: inline-block;
  width: ${HUD_METER_WIDTH_PX}px;
  height: 6px;
  vertical-align: middle;
  border: 1px solid var(--hud-rule);
  border-radius: var(--hud-radius);
  overflow: hidden;
}
.kt-bar::before {
  content: '';
  position: absolute;
  inset: 0;
  transform-origin: left center;
  transform: scaleX(var(--kt-fill, 0));
  background: currentColor;
}
.kt-bar-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: ${cssColor(AMBER.core)};
  margin-left: calc(var(--kt-mark, 0) * ${HUD_METER_WIDTH_PX}px);
}
.kt-pip-bar { width: 72px; }
.kt-tick::after { counter-reset: kt-tick var(--kt-tick, 0); content: 't' counter(kt-tick); }
.kt-chip { color: ${cssColor(CYAN.core)}; }
.kt-glyphs { color: ${cssColor(AMBER.core)}; }
.kt-delta { min-width: 4ch; text-align: right; }
.kt-alert { white-space: nowrap; overflow: hidden; }
.kt-status-nominal { color: ${cssColor(CYAN.core)}; }
.kt-status-degraded { color: ${cssColor(AMBER.core)}; }
.kt-status-critical { color: ${cssColor(AMBER.white)}; }
.kt-status-derezzed { color: ${cssColor(SLATE.protected)}; }
`;
}

export const HUD_CSS = buildHudCss();
