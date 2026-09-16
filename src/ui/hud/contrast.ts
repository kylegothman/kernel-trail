/**
 * WCAG 2.x contrast for HUD text, scope correction S12. The foreground is
 * composited over the background at the given alpha first, in sRGB channel
 * space, because that is how CSS `opacity` composites; the visual bible's
 * claim that 0.72 changes the section 2.6 ratios by under 8 percent is wrong
 * by that model (pre-flight ruling 6.2), and the HUD therefore uses only the
 * `any-size` tokens for text.
 */

function channel(hex: number, shift: number): number {
  return (hex >> shift) & 0xff;
}

function toLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of an sRGB hex, WCAG 2.x. */
export function relativeLuminance(hex: number): number {
  return (
    0.2126 * toLinear(channel(hex, 16)) +
    0.7152 * toLinear(channel(hex, 8)) +
    0.0722 * toLinear(channel(hex, 0))
  );
}

/** The foreground composited over the background at `alpha`, per 8-bit channel. */
export function compositeOver(fgHex: number, bgHex: number, alpha: number): number {
  const mix = (shift: number): number =>
    Math.round(channel(fgHex, shift) * alpha + channel(bgHex, shift) * (1 - alpha));
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/**
 * Contrast ratio of `fgHex` at `fgAlpha` over an opaque `bgHex`. Always at
 * least 1; the lighter of the two is the numerator.
 */
export function contrastRatio(fgHex: number, bgHex: number, fgAlpha = 1): number {
  const fg = relativeLuminance(compositeOver(fgHex, bgHex, fgAlpha));
  const bg = relativeLuminance(bgHex);
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}
