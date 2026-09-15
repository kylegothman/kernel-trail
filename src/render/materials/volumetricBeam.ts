import { getMaterial } from './index';
import type { SemanticId } from '@design';
import type { QualityTier } from '@platform';
export const volumetricBeam = (semantic: SemanticId, tier: QualityTier) => getMaterial('volumetric-beam', semantic, tier);
