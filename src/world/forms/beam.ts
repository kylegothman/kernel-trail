import {CylinderGeometry} from 'three/webgpu';
import {PROFILES,type QualityTier} from '@platform';
import {cachedGeometry} from './index';
/** Unit-length beam; endpoints and width belong to instance transforms. */
export function makeBeam(tier:QualityTier){return cachedGeometry('beam.'+tier,()=>new CylinderGeometry(1,1,1,PROFILES[tier].beamRadialSegments,1,true));}
