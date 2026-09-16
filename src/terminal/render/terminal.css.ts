/**
 * KERNEL TRAIL: the terminal stylesheet, built from the design tokens (WP-15 spec 6, scope correction T11).
 *
 * The terminal is a screen-space surface the player opens deliberately: text
 * over a near-opaque void field with the world still visible behind it (visual
 * bible 7.3). Type is the mono face at the `data` scale, the prompt at
 * `dataEmphasis`, status lines at `micro`. Every colour is a token that
 * TEXT_CONTRAST marks any-size (visual bible 2.6); there is no colour literal
 * in this file. Layout follows the safe-area variables of visual bible 11.3.
 */
import { AMBER, CYAN, FONT_STACK, SLATE, TYPE_SCALE, VOID, cssColor } from '@design';

export const TERMINAL_CLASS = 'kt-terminal';

/** Opacity of the field behind the text, visual bible 7.3. */
export const FIELD_OPACITY = 0.92;

export function terminalStyles(): string {
  const data = TYPE_SCALE.data;
  const emphasis = TYPE_SCALE.dataEmphasis;
  const micro = TYPE_SCALE.micro;
  const text = cssColor(SLATE.primary);
  const prompt = cssColor(CYAN.core);
  const echo = cssColor(CYAN.white);
  const error = cssColor(AMBER.core);
  const status = cssColor(SLATE.protected);
  const field = cssColor(VOID.base, FIELD_OPACITY);
  const rule = cssColor(CYAN.dim, 0.35);
  const halo = cssColor(VOID.base, 0.9);
  return [
    `.${TERMINAL_CLASS} { --hud-safe: max(24px, 2.5vh); --hud-gutter: 16px; position: absolute; inset: var(--hud-safe); display: flex; flex-direction: column;`,
    `  background: ${field}; color: ${text}; font-family: ${FONT_STACK.mono}; font-size: ${data.sizeRem}rem; line-height: ${data.lineHeight};`,
    `  letter-spacing: ${data.tracking}em; font-weight: ${data.weight}; border: 1px solid ${rule}; border-radius: 2px; padding: var(--hud-gutter);`,
    `  text-shadow: 0 0 12px ${halo}; box-sizing: border-box; overflow: hidden; }`,
    `.${TERMINAL_CLASS}[hidden] { display: none; }`,
    `.${TERMINAL_CLASS} .${TERMINAL_CLASS}-output { flex: 1 1 auto; overflow-y: auto; white-space: pre; margin: 0; }`,
    `.${TERMINAL_CLASS} .${TERMINAL_CLASS}-line { margin: 0; min-height: ${data.lineHeight}em; }`,
    `.${TERMINAL_CLASS} .${TERMINAL_CLASS}-line-error { color: ${error}; }`,
    `.${TERMINAL_CLASS} .${TERMINAL_CLASS}-line-echo { color: ${echo}; }`,
    `.${TERMINAL_CLASS} .${TERMINAL_CLASS}-row { display: flex; gap: 0.5ch; align-items: baseline; border-top: 1px solid ${rule}; padding-top: calc(var(--hud-gutter) / 2); margin-top: calc(var(--hud-gutter) / 2); }`,
    `.${TERMINAL_CLASS} .${TERMINAL_CLASS}-prompt { color: ${prompt}; font-weight: ${emphasis.weight}; letter-spacing: ${emphasis.tracking}em; white-space: pre; }`,
    `.${TERMINAL_CLASS} .${TERMINAL_CLASS}-input { flex: 1 1 auto; background: transparent; border: 0; outline: 0; color: ${text}; font: inherit; letter-spacing: inherit; padding: 0; }`,
    `.${TERMINAL_CLASS} .${TERMINAL_CLASS}-status { color: ${status}; font-size: ${micro.sizeRem}rem; line-height: ${micro.lineHeight}; letter-spacing: ${micro.tracking}em; text-transform: uppercase; margin-top: calc(var(--hud-gutter) / 2); }`,
  ].join('\n');
}
