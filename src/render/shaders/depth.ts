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
