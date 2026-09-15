import { texture, vec2 } from 'three/tsl';
import type { Node, Texture } from 'three/webgpu';
export const DOWN_TAPS=5, UP_TAPS=8;
export function kawaseDown(t: Texture, at: Node<'vec2'>, half: Node<'vec2'>) {
  return texture(t,at).rgb.mul(4).add(texture(t,at.sub(half)).rgb).add(texture(t,at.add(half)).rgb)
    .add(texture(t,at.add(vec2(half.x,half.y.negate()))).rgb).add(texture(t,at.sub(vec2(half.x,half.y.negate()))).rgb).mul(0.125);
}
export function kawaseUp(t: Texture, at: Node<'vec2'>, half: Node<'vec2'>) {
  return texture(t,at.add(vec2(half.x.mul(-2),0))).rgb
    .add(texture(t,at.add(vec2(half.x.negate(),half.y))).rgb.mul(2))
    .add(texture(t,at.add(vec2(0,half.y.mul(2)))).rgb)
    .add(texture(t,at.add(half)).rgb.mul(2))
    .add(texture(t,at.add(vec2(half.x.mul(2),0))).rgb)
    .add(texture(t,at.add(vec2(half.x,half.y.negate()))).rgb.mul(2))
    .add(texture(t,at.add(vec2(0,half.y.mul(-2)))).rgb)
    .add(texture(t,at.sub(half)).rgb.mul(2)).mul(0.0833333);
}
