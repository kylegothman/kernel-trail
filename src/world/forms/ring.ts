import {TorusGeometry} from 'three/webgpu';
import {FORM} from '@design';
import type {QualityTier} from '@platform';
import {cachedGeometry,withEdges} from './index';
export function makeResourceRing(tier:QualityTier){return cachedGeometry('ring.'+tier,()=>withEdges(new TorusGeometry(FORM.resourceRing.outerRadius,FORM.resourceRing.tube,4,tier==='low'?12:tier==='medium'?24:48)));}
