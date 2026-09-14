import { texture, uv, vec2, vec3, sin, fract, dot, smoothstep } from 'three/tsl';
import type { Node, Texture } from 'three/webgpu';
export function chromatic(t: Texture, maxPx: number, width: number, height: number) {
  const c=uv().sub(0.5),r=c.length().mul(Math.SQRT2);
  const offset=c.add(1e-6).normalize().mul(vec2(1/width,1/height)).mul(maxPx).mul(smoothstep(0.62,1,r));
  return vec3(texture(t,uv().add(offset)).r,texture(t,uv()).g,texture(t,uv().sub(offset)).b);
}
export function grain(c: Node<'vec3'>, time: Node<'float'>, amp: number) {
  const p=uv().mul(1024);
  const a=fract(sin(dot(p.add(time),vec2(12.9898,78.233))).mul(43758.5453));
  const b=fract(sin(dot(p.sub(time),vec2(39.3468,11.1357))).mul(24634.6345));
  const weight=c.dot(vec3(0.2126,0.7152,0.0722)).clamp(0,1).oneMinus().mul(0.6).add(0.4);
  return c.add(a.add(b).sub(1).mul(amp).mul(weight));
}
export function vignette(c: Node<'vec3'>, strength: Node<'float'>, power: Node<'float'>) {
  const v=uv().sub(0.5).mul(2);
  return c.mul(dot(v,v).mul(strength).oneMinus().clamp(0,1).pow(power));
}
