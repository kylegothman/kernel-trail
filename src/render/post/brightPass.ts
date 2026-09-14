import { dot, max, clamp, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
/** Changing EMISSIVE_GAIN without revisiting the threshold breaks the whole image. */
export function brightPass(c: Node<'vec3'>, threshold: Node<'float'>, knee: number) {
  const lum=dot(c,vec3(0.2126,0.7152,0.0722));
  const soft=clamp(lum.sub(threshold).add(knee),0,2*knee);
  const contribution=max(soft.mul(soft).div(4*knee+1e-5),lum.sub(threshold)).div(max(lum,1e-5));
  return c.mul(contribution);
}
