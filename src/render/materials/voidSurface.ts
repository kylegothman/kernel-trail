import { getMaterial } from './index';
import type { SemanticId } from '@design';
import type { QualityTier } from '@platform';
export const voidSurface = (semantic: SemanticId, tier: QualityTier) => getMaterial('void-surface', semantic, tier);
