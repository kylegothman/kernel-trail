import { floor, fract, mix, sin, step, vec3, mx_rgbtohsv, mx_hsvtorgb } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { CORRUPTION } from '@design';
/** Shared cell hash for displacement, dropout and the noise hatch. */
export function hash31(p: Node<'vec3'>) { return fract(sin(p.dot(vec3(12.9898, 78.233, 39.3468))).mul(43758.5453)); }
export function corrupt(base: Node<'vec3'>, world: Node<'vec3'>, amount: Node<'float'>, time: Node<'float'>) {
  const h = hash31(floor(world.div(CORRUPTION.cellMetres)).add(floor(time.mul(12)).mul(0.017)));
  const q = floor(base.mul(CORRUPTION.valueSteps).add(0.5)).div(CORRUPTION.valueSteps);
  const hsv = mx_rgbtohsv(q) as Node<'vec3'>;
  const jittered = vec3(fract(hsv.x.add(h.sub(0.5).mul(0.12))),hsv.y.mul(h.mul(0.6).add(0.4)),hsv.z);
  const damaged = mx_hsvtorgb(jittered) as Node<'vec3'>;
  return mix(base, damaged.mul(step(CORRUPTION.dropout,h)),amount);
}
