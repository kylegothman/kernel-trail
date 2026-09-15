import { attribute, positionLocal, vec3, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** TSL position node for the deterministic voxel fracture. */
export function derezzVertexNode(): Node<'vec3'> {
  const centroid = attribute<'vec3'>('aCentroid', 'vec3');
  const random = attribute<'vec3'>('aRandom', 'vec3');
  const time = uniform(0);
  const dispersion = uniform(1);
  const offset = random.sub(0.5).mul(dispersion).mul(time);
  return positionLocal.add(centroid.mul(0).add(vec3(offset)));
}

export const createDerezzVertexNode = derezzVertexNode;
