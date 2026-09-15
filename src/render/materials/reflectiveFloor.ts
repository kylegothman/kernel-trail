import { getMaterial } from './index';
import type { SemanticId } from '@design';
import type { QualityTier } from '@platform';
export const reflectiveFloor = (semantic: SemanticId, tier: QualityTier) => getMaterial('reflective-floor', semantic, tier);
