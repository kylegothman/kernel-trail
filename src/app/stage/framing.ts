/** Overview framing for layout stand-ins, separate from the renderer focus locks. */
import { Box3, Vector3 } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import { CAMERA, MIN_GLYPH_PX, WORLD_CAP_HEIGHT_M } from '@design';
import type { CameraTarget } from '../input';
import type { LayoutStructure } from './LayoutStructure';

export interface LayoutLabelBounds {
  readonly anchor: Object3D;
  readonly offset: Vector3;
  readonly bounds: Box3;
}

/** Keep room for the HUD and panel edges, with modest type even in a small layout. */
const OVERVIEW_FILL = 0.72;
const OVERVIEW_CAP_PX = 20;

function corners(bounds: Box3): Vector3[] {
  return [bounds.min.x, bounds.max.x].flatMap(x =>
    [bounds.min.y, bounds.max.y].flatMap(y =>
      [bounds.min.z, bounds.max.z].map(z => new Vector3(x, y, z))));
}

export function fitLayoutCamera(
  structures: readonly LayoutStructure[], labels: readonly LayoutLabelBounds[],
  target: CameraTarget, aspect: number, viewportHeightPx: number,
): void {
  const forms: Vector3[] = [];
  for (const structure of structures) {
    structure.root.updateWorldMatrix(true, false);
    const source = structure.sourceGeometry.boundingBox;
    // The horizon is an environment-scale ring, not a subject to fit on screen.
    const local = structure.formKind === 'horizon' || source === null
      ? [new Vector3()] : corners(source);
    for (const point of local) forms.push(point.applyMatrix4(structure.root.matrixWorld));
  }
  if (forms.length === 0) return;
  const cp = Math.cos(target.pitchRad), sp = Math.sin(target.pitchRad);
  const cy = Math.cos(target.yawRad), sy = Math.sin(target.yawRad);
  const right = new Vector3(cy, 0, -sy);
  const up = new Vector3(-sy * sp, cp, -cy * sp);
  const back = new Vector3(sy * cp, sp, cy * cp);
  const tangent = Math.tan(CAMERA.fovDeg * Math.PI / 360);
  const horizontal = tangent * Math.max(aspect, 0.01) * OVERVIEW_FILL;
  const vertical = tangent * OVERVIEW_FILL;
  const height = Math.max(1, viewportHeightPx);
  const cap = WORLD_CAP_HEIGHT_M.structureTitle;
  const minimumScalePerDepth = 2 * tangent * MIN_GLYPH_PX / (height * cap);
  const placed = labels.map(label => ({
    position: label.offset.clone().applyMatrix4(label.anchor.matrixWorld), bounds: label.bounds,
  }));
  const bounds = new Box3();
  bounds.setFromPoints(forms).getCenter(target.focus);
  let distance: number = CAMERA.distanceMinM;
  const relative = new Vector3();
  const previousFocus = new Vector3();
  // Labels keep a device-pixel minimum. Include their enlarged billboard bounds,
  // then refit until the distance and placement agree, without changing font art.
  for (let pass = 0; pass < 24; pass++) {
    const previousDistance = distance;
    previousFocus.copy(target.focus);
    const points = [...forms];
    for (const label of placed) {
      const depth = distance - relative.copy(label.position).sub(target.focus).dot(back);
      const scale = Math.max(1, minimumScalePerDepth * depth);
      for (const x of [label.bounds.min.x, label.bounds.max.x]) {
        for (const y of [label.bounds.min.y, label.bounds.max.y]) {
          points.push(label.position.clone().addScaledVector(right, x * scale).addScaledVector(up, y * scale));
        }
      }
    }
    bounds.setFromPoints(points).getCenter(target.focus);
    // A world-space midpoint overweights distant labels. Center the horizontal
    // frustum edges so near stand-ins retain the same margin as distant text.
    let left = Infinity, rightmost = -Infinity;
    for (const point of points) {
      const x = point.dot(right), z = point.dot(back);
      left = Math.min(left, x - horizontal * z);
      rightmost = Math.max(rightmost, x + horizontal * z);
    }
    target.focus.addScaledVector(right, (left + rightmost) / 2 - target.focus.dot(right));
    distance = CAMERA.distanceMinM;
    for (const point of points) {
      relative.copy(point).sub(target.focus);
      distance = Math.max(distance, relative.dot(back) + Math.abs(relative.dot(right)) / horizontal,
        relative.dot(back) + Math.abs(relative.dot(up)) / vertical);
    }
    for (const label of placed) {
      const offset = relative.copy(label.position).sub(target.focus).dot(back);
      distance = Math.max(distance, offset + cap * height / (2 * tangent * OVERVIEW_CAP_PX));
    }
    // The frozen zoom range may leave less overview margin in narrow windows.
    // Recenter using the label scale at the actual reachable camera distance.
    distance = Math.min(CAMERA.distanceMaxM, distance);
    if (Math.abs(distance - previousDistance) < 0.001 && previousFocus.distanceTo(target.focus) < 0.001) break;
  }
  target.distanceM = Math.min(CAMERA.distanceMaxM, distance * 1.02);
}
