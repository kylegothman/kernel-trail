import { agxToneMapping, float, mix, vec3, texture, screenCoordinate, sRGBTransferOETF } from 'three/tsl';
import { DataTexture, RedFormat, UnsignedByteType, NearestFilter, RepeatWrapping } from 'three/webgpu';
import type { Node } from 'three/webgpu';
export const EXPOSURE=1;
export const BAYER=[0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21] as const;
export function createBayerTexture(): DataTexture {
  const t=new DataTexture(new Uint8Array(BAYER),8,8,RedFormat,UnsignedByteType);
  t.minFilter=t.magFilter=NearestFilter;t.wrapS=t.wrapT=RepeatWrapping;t.needsUpdate=true;return t;
}
export function toneMap(c: Node<'vec3'>, bayer: DataTexture) {
  // The operator imports Three's matrices and colour-space conversions without transcribing either.
  const agx=agxToneMapping(c.max(0),float(EXPOSURE)) as Node<'vec3'>;
  const lum=agx.dot(vec3(0.2126,0.7152,0.0722));
  const lifted=mix(vec3(lum),agx,1.18).clamp(0,1);
  const dither=texture(bayer,screenCoordinate.add(0.5).div(8)).r.mul(255/64).sub(0.5).div(255);
  return (sRGBTransferOETF(lifted) as Node<'vec3'>).add(dither).clamp(0,1);
}
