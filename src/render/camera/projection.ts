import { Matrix4, PerspectiveCamera, Vector3, WebGLCoordinateSystem } from 'three/webgpu';
import type { Ray } from 'three/webgpu';

const _persp = new Matrix4();
const _ortho = new Matrix4();

/**
 * Blend perspective into orthographic on a single camera.
 *
 * There is exactly one `PerspectiveCamera` in the scene. Swapping to an
 * `OrthographicCamera` at the end of the transition produces a visible pop,
 * because the two projections disagree everywhere except at one depth. Instead
 * both matrices are built each frame and blended element-wise.
 *
 * The blend is artefact-free at the focus plane because the orthographic frustum
 * height is chosen so the two projections agree exactly there: with
 * `orthoHeight = 2 * d * tan(fov/2)` both matrices map the focus plane to
 * identical screen coordinates, so the element-wise lerp introduces no
 * distortion where the player is looking. Off the plane the lerp is a smooth (if
 * not projectively exact) morph, which is what reads as the world flattening out.
 *
 * `Frustum.setFromProjectionMatrix` still works on the blended matrix, so culling
 * behaves throughout the transition. That is not an accident of the maths; it is
 * why the blend is done on the matrix rather than by interpolating a projection
 * parameter.
 */
export function blendProjection(
  cam: PerspectiveCamera,
  aspect: number,
  fov: number,
  focusDistance: number,
  near: number,
  far: number,
  blend: number,
): void {
  const halfH = Math.tan(fov * 0.5) * focusDistance;
  const halfW = halfH * aspect;
  const k = near / focusDistance;

  _persp.makePerspective(
    -halfW * k,
    halfW * k,
    halfH * k,
    -halfH * k,
    near,
    far,
    cam.coordinateSystem, cam.reversedDepth,
  );
  _ortho.makeOrthographic(-halfW, halfW, halfH, -halfH, near, far, cam.coordinateSystem, cam.reversedDepth);

  const p = _persp.elements;
  const o = _ortho.elements;
  const e = cam.projectionMatrix.elements;
  for (let i = 0; i < 16; i++) {
    // TypeScript 7 widens typed-array reads to number | undefined. Every index
    // here is 0..15 on three 16-element matrices, so the coalesce never fires.
    e[i] = (p[i] ?? 0) + ((o[i] ?? 0) - (p[i] ?? 0)) * blend;
  }
  commitProjection(cam);
}


/** Preserve the authored matrix when Three refreshes its depth convention. */
export class BlendedPerspectiveCamera extends PerspectiveCamera {
  private readonly saved = new Matrix4();
  private custom = false;
  private savedCoordinate = this.coordinateSystem;
  private savedReverse = this.reversedDepth;
  rememberProjection(): void {
    this.custom = true;
    this.saved.copy(this.projectionMatrix);
    this.savedCoordinate = this.coordinateSystem;
    this.savedReverse = this.reversedDepth;
  }
  usePerspective(): void { this.custom = false; super.updateProjectionMatrix(); }
  override updateProjectionMatrix(): void {
    if (!this.custom || !this.saved) { super.updateProjectionMatrix(); return; }
    convertDepthConvention(this.saved, this.savedCoordinate, this.savedReverse, this.coordinateSystem, this.reversedDepth);
    this.projectionMatrix.copy(this.saved);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    this.savedCoordinate = this.coordinateSystem; this.savedReverse = this.reversedDepth;
  }
}
export function commitProjection(camera: PerspectiveCamera): void {
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  if (camera instanceof BlendedPerspectiveCamera) camera.rememberProjection();
}
/** Convert clip-space Z without disturbing X/Y/W, including reversed depth. */
export function convertDepthConvention(matrix: Matrix4, from: number, fromReverse: boolean, to: number, toReverse: boolean): void {
  if (from === to && fromReverse === toReverse) return;
  const fromGL = from === WebGLCoordinateSystem && !fromReverse;
  const toGL = to === WebGLCoordinateSystem && !toReverse;
  for (let col = 0; col < 16; col += 4) {
    let z = matrix.elements[col + 2]!; const w = matrix.elements[col + 3]!;
    if (fromGL) z = (z + w) * 0.5;
    if (fromReverse) z = w - z;
    if (toReverse) z = w - z;
    if (toGL) z = 2 * z - w;
    matrix.elements[col + 2] = z;
  }
}
const rayNear = new Vector3(), rayFar = new Vector3();
/** Both endpoints are unprojected, so locked rays are parallel without another camera. */
export function projectionRay(camera: PerspectiveCamera, x: number, y: number, out: Ray): Ray {
  const nearZ = camera.reversedDepth ? 1 : camera.coordinateSystem === WebGLCoordinateSystem ? -1 : 0;
  const farZ = camera.reversedDepth ? 0 : 1;
  rayNear.set(x,y,nearZ).unproject(camera); rayFar.set(x,y,farZ).unproject(camera);
  out.origin.copy(rayNear); out.direction.copy(rayFar).sub(rayNear).normalize(); return out;
}
