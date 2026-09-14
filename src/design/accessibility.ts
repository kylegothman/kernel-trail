import { SEMANTICS, MONOCHROME, PULSE, DEFAULT_VISION_SETTINGS, gainFor } from './tokens';
import type { SemanticId, VisionSettings } from './tokens';
export { MONOCHROME, DEFAULT_VISION_SETTINGS, REDUCED_BLOOM } from './tokens';
export type { VisionSettings } from './tokens';
export function resolveSemantic(id: SemanticId, vision: Readonly<VisionSettings> = DEFAULT_VISION_SETTINGS) {
  const token = SEMANTICS[id];
  const mono = vision.monochromeSemantics;
  const amber = token.family === 'amber';
  const cyan = token.family === 'cyan';
  return {
    ...token,
    hex: mono && amber ? MONOCHROME.amberHex : mono && cyan ? MONOCHROME.cyanHex : token.hex,
    gain: gainFor(token.family, token.level) * (mono && cyan ? MONOCHROME.cyanGainScale : 1),
    pulseHz: vision.reducedMotion ? Math.min(token.pulseHz, PULSE.reducedMotionMaxHz) : token.pulseHz,
    pulseDepth: vision.emphasiseShapeChannel ? PULSE.depthEmphasised : PULSE.depth,
    dashContrast: vision.emphasiseShapeChannel ? 2 : 1,
  };
}
