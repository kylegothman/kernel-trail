// @vitest-environment happy-dom
/**
 * The coverage cap, visual bible 11.3, as the Node layout model: the sum of
 * every region's declared maximum box at 1440 by 900 is under 11 percent.
 * happy-dom does not lay out, so the real boxes are measured by
 * tests/render/gpu/hud.gpu.ts in the browser run against the same cap.
 */
import { describe, expect, it } from 'vitest';
import {
  HUD_COVERAGE_CAP,
  HUD_REFERENCE_VIEWPORT,
  HUD_REGION_BOUNDS,
  HUD_REGION_IDS,
  hudCoverageFraction,
} from '../../src/ui/hud/layout';
import { HUD_CSS } from '../../src/ui/hud/hud.css';

describe('HUD coverage', () => {
  it('worst-case layout model stays under 11 percent of 1440x900', () => {
    const { width, height } = HUD_REFERENCE_VIEWPORT;
    const fraction = hudCoverageFraction(width, height);
    const percent = (fraction * 100).toFixed(2);
    console.log(`HUD layout model coverage at ${width}x${height}: ${percent}%`);
    expect(fraction, `HUD layout model covers ${percent}% of ${width}x${height}, cap is ${HUD_COVERAGE_CAP * 100}%`).toBeLessThan(HUD_COVERAGE_CAP);
  });

  it('pins every declared maximum into the stylesheet so the model and the CSS cannot drift', () => {
    for (const id of HUD_REGION_IDS) {
      const b = HUD_REGION_BOUNDS[id];
      expect(HUD_CSS, id).toContain(`max-width: ${b.maxWidthPx}px; max-height: ${b.maxHeightPx}px`);
    }
  });
});
