/**
 * The cards' stylesheet: narrative surfaces in the sans face, visual bible
 * 7.1 and 7.2, colours from the frozen tokens. A card is a plain block with
 * a region role; it is never a dialog and it traps nothing (11.4).
 */
import { AMBER, CYAN, FONT_STACK, SLATE, TYPE_SCALE, VOID, cssColor } from '@design';
import { HUD_RADIUS_PX } from '../hud/layout';

const title = TYPE_SCALE.title;
const heading = TYPE_SCALE.heading;
const body = TYPE_SCALE.body;
const data = TYPE_SCALE.data;

export function buildCardCss(): string {
  return `
.kt-card {
  box-sizing: border-box;
  max-width: 52ch;
  padding: 16px 20px;
  background: ${cssColor(VOID.base, 0.92)};
  border-radius: ${HUD_RADIUS_PX}px;
  border-top: 1px solid ${cssColor(CYAN.dim, 0.35)};
  font-family: ${FONT_STACK.sans};
  font-size: ${body.sizeRem}rem;
  line-height: ${body.lineHeight};
  color: ${cssColor(SLATE.primary)};
  pointer-events: auto;
}
.kt-card h2 {
  margin: 0 0 8px;
  font-size: ${title.sizeRem}rem;
  line-height: ${title.lineHeight};
  letter-spacing: ${title.tracking}em;
  font-weight: ${title.weight};
}
.kt-card h3 {
  margin: 12px 0 4px;
  font-size: ${heading.sizeRem}rem;
  line-height: ${heading.lineHeight};
  font-weight: ${heading.weight};
  color: ${cssColor(CYAN.core)};
}
.kt-card p { margin: 0 0 8px; }
.kt-card .kt-cite {
  font-family: ${FONT_STACK.mono};
  font-size: ${data.sizeRem}rem;
  letter-spacing: ${data.tracking}em;
  color: ${cssColor(SLATE.protected)};
}
.kt-card .kt-inscription { font-weight: ${title.weight}; }
.kt-card .kt-cause { color: ${cssColor(SLATE.protected)}; font-weight: 300; }
.kt-card--panic { border-top-color: ${cssColor(AMBER.white)}; color: ${cssColor(AMBER.white)}; }
.kt-card--panic h2 { color: ${cssColor(AMBER.white)}; }
.kt-card button.kt-affordance {
  font-family: ${FONT_STACK.mono};
  font-size: ${data.sizeRem}rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${cssColor(CYAN.core)};
  background: none;
  border: 1px solid ${cssColor(CYAN.dim)};
  border-radius: ${HUD_RADIUS_PX}px;
  padding: 4px 10px;
  cursor: pointer;
}
`;
}

export const CARD_CSS = buildCardCss();
