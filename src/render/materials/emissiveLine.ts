import { getMaterial } from './index';
import type { SemanticId } from '@design';
import type { QualityTier } from '@platform';
export const emissiveLine = (semantic: SemanticId, tier: QualityTier) => getMaterial('emissive-line', semantic, tier);
