import { fwidth, min, smoothstep, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { LINE } from '@design';
export function edgeFactor(bary: Node<'vec3'>, mask: Node<'vec3'>) {
  const edge = vec3(1).sub(smoothstep(vec3(0), fwidth(bary).mul(LINE.baryEdgeWidthPx), bary)).mul(mask);
  return min(1, edge.x.max(edge.y).max(edge.z));
}
