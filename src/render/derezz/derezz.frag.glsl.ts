import { attribute, float, vec3, vec4, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** TSL fragment node. Surface cubes are dimmer so interior voxels read through. */
export function derezzFragmentNode(): Node<'vec4'> {
  const surface = attribute<'float'>('aSurface', 'float');
  const base = uniform(vec3(0.2));
  const hot = uniform(vec3(1));
  const alpha = uniform(1).mul(surface.oneMinus().mul(0.25).add(0.75));
  return vec4(base.add(hot.sub(base).mul(float(1).sub(surface.mul(0.35)))), alpha);
}

export const createDerezzFragmentNode = derezzFragmentNode;
