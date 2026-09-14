import { texture, uv, vec2, min } from 'three/tsl';
import {decodeDepth} from '../shaders/depth';
import type { Texture, Node } from 'three/webgpu';
/** Half-resolution gather, maximum CoC three pixels at twelve metres off-plane. */
export function depthOfField(t: Texture, depth: Texture, focus: Node<'float'>, width: number, height: number) {
  const coc=min(3,decodeDepth(texture(depth,uv())).sub(focus).abs().mul(3/12));
  const offset=vec2(1/width,1/height).mul(coc);
  return texture(t,uv()).rgb.mul(4).add(texture(t,uv().add(offset)).rgb).add(texture(t,uv().sub(offset)).rgb)
    .add(texture(t,uv().add(vec2(offset.x,offset.y.negate()))).rgb)
    .add(texture(t,uv().add(vec2(offset.x.negate(),offset.y))).rgb).mul(0.125);
}
