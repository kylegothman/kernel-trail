import { getMaterial } from './index';
import type { SemanticId } from '@design';
import type { QualityTier } from '@platform';
export const emissivePanel = (semantic: SemanticId, tier: QualityTier) => getMaterial('emissive-panel', semantic, tier);
