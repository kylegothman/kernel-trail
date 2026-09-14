import { getMaterial } from './index';
import type { SemanticId } from '@design';
import type { QualityTier } from '@platform';
export const derezzGlass = (semantic: SemanticId, tier: QualityTier) => getMaterial('derezz-glass', semantic, tier);
