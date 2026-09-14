import { texture, uv, vec3, mix } from 'three/tsl';
import type { Texture, Node } from 'three/webgpu';
/** Samples a registered visible source; the host owns occlusion and visibility. */
export function volumetric(t: Texture, source: Node<'vec2'>, enabled: Node<'float'>, steps: number) {
  let sum: Node<'vec3'>=vec3(0);
  for(let i=0;i<steps;i++) sum=sum.add(texture(t,mix(uv(),source,i/steps)).rgb);
  return sum.div(steps).mul(enabled);
}
