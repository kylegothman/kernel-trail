import { floor, mix, uniform, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
export const depthPacked=uniform(0);
export const depthFar=uniform(2000);
/** Float colour attachments require EXT_color_buffer_float, including R32F. */
export function encodeDepth(z:Node<'float'>,far:Node<'float'>,hdr:boolean):Node<'vec4'> {
  if(hdr)return vec4(z,0,0,1);
  const n=floor(z.div(far).clamp(0,1).mul(16777215));
  return vec4(vec3(floor(n.div(65536)),floor(n.div(256)).mod(256),n.mod(256)).div(255),1);
}
export function decodeDepth(sample:Node<'vec4'>):Node<'float'> {
  return mix(sample.r,sample.rgb.dot(vec3(65536,256,1)).mul(255/16777215).mul(depthFar),depthPacked);
}

/** Reconstruct positive view depth from an arbitrary projection's Z/W rows. */
export function projectionDepth(depth:Node<'float'>, coefficients:Node<'vec4'>, depthScale:Node<'float'>, depthBias:Node<'float'>):Node<'float'> {
  const ndc=depth.mul(depthScale).add(depthBias);
  return coefficients.y.sub(ndc.mul(coefficients.w)).div(coefficients.x.sub(ndc.mul(coefficients.z)));
}
export function projectionDepthValue(depth:number, elements:readonly number[], webGL:boolean, reversed=false):number {
  const ndc=webGL&&!reversed?depth*2-1:depth;
  return (elements[14]!-ndc*elements[15]!)/(elements[10]!-ndc*elements[11]!);
}
