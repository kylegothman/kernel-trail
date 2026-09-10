/**
 * KERNEL TRAIL: the focus camera.
 *
 * Implements 03-VISUAL-BIBLE section 6 in full. This is the system that makes a
 * 3D-only game readable, and it is the reference implementation for every other
 * camera behaviour in the build: if a later system needs to move the camera, it
 * moves it the way this file does.
 *
 * THE PROBLEM. Reading a 16 x 16 page table in perspective is genuinely hard.
 * The standard solution is to open a flat 2D panel, which the design brief
 * forbids. This solves it by moving the camera instead of leaving the world.
 *
 * WHY FOUR THINGS HAPPEN AT ONCE, all of which are needed:
 *
 * - Orthographic projection makes every cell of a grid the same size on screen,
 *   so a page table can be scanned by row and column rather than decoded through
 *   foreshortening.
 * - Square-on framing puts every label in the same plane, so no glyph is
 *   rendered at a grazing angle where SDF sampling breaks down.
 * - Dimming removes competing emitters. This matters more here than in a lit
 *   game, because bloom from an out-of-focus emitter bleeds across the read
 *   plane and there is no ambient light to hide it under.
 * - The transition is continuous, so the player keeps the spatial relationship
 *   between the structure they are reading and the world it sits in. That is the
 *   entire argument for not opening a flat panel.
 *
 * The simulation never pauses during a lock. A page table being read while the
 * kernel evicts a page shows the eviction, in place, in the frame the player is
 * already looking at.
 *
 * IMPORT DISCIPLINE. Three imports come from `three/webgpu`. See the note at the
 * top of RendererBackend.ts.
 */

import { Matrix4, Quaternion, Vector2, Vector3 } from 'three/webgpu';
import type { Material, Object3D, PerspectiveCamera, Scene } from 'three/webgpu';

import { CAMERA, EASE, FOCUS, FOCUS_DURATION_MS, MIN_GLYPH_PX } from '@design/tokens';

/* ------------------------------------------------------------------------- */
/* Types (03-VISUAL-BIBLE 6.2)                                                */
/* ------------------------------------------------------------------------- */

export type FocusMode = 'free' | 'engaging' | 'locked' | 'releasing';

/**
 * A diegetic structure the camera can lock onto. Legs register these from
 * `createStage` and address them by the same string that `InteractionDef.anchor`
 * uses, which is what keeps a lock target and an interaction target from drifting
 * apart as a leg is edited.
 */
export interface FocusTarget {
  readonly id: string;
  /** The object whose transform defines the reading plane. */
  readonly anchor: Object3D;
  /** Outward normal of the reading plane, in the anchor's local space. */
  readonly planeNormal: Vector3;
  /** Which way is up on the reading plane, in the anchor's local space. */
  readonly planeUp: Vector3;
  /** World-space size of the region to frame, on the plane's axes. */
  readonly extents: Vector2;
  /** Extra framing margin as a fraction of extents. FOCUS.padding by default. */
  readonly padding: number;
  /**
   * Objects that stay at full brightness during the lock. The anchor's subtree
   * is included automatically; add cross-references such as the beams into a
   * wait-for graph, which are not children of the structure they describe.
   */
  readonly focusSet: readonly Object3D[];
  /** How far everything outside the focus set is pushed down. 0 none, 1 dark. */
  readonly dimOthers: number;
  /** Whether world-space labels inside the focus set snap to the plane. */
  readonly labelPlane: 'billboard-to-focus' | 'billboard-to-camera';
  /**
   * Minimum world height a glyph must subtend, in metres, at the framed
   * distance. If the structure's label density would push text below this, the
   * framing expands to a sub-region and the lock gains a pan affordance rather
   * than shrinking the type. Text never scales below MIN_GLYPH_PX in this game.
   */
  readonly minGlyphHeight: number;
}

export interface CameraPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  /** Perspective vertical FOV in radians. Ignored when the ortho blend is 1. */
  readonly fov: number;
  /** Orthographic frustum height in world units at the focus plane. */
  readonly orthoHeight: number;
}

export interface FocusCameraState {
  readonly mode: FocusMode;
  readonly target: FocusTarget | null;
  /** Raw transition progress, 0..1, linear in time. */
  readonly t: number;
  /** Eased progress. This is what every consumer reads. */
  readonly blend: number;
  readonly from: CameraPose;
  readonly to: CameraPose;
  readonly durationMs: number;
}

/**
 * Where the free camera wants to be. Supplied by the game layer once per frame:
 * a spherical offset from a point, usually the convoy centroid. The rig damps
 * toward it rather than snapping, and it keeps tracking through a lock so that a
 * release lands where the player expects.
 */
export interface FreeCameraTarget {
  /** The point the camera orbits and looks at. */
  readonly focus: Vector3;
  readonly yawRad: number;
  /** Clamped to CAMERA.pitchMinDeg .. CAMERA.pitchMaxDeg. */
  readonly pitchRad: number;
  /** Clamped to CAMERA.distanceMinM .. CAMERA.distanceMaxM. */
  readonly distanceM: number;
}

export interface FocusCameraController {
  readonly camera: PerspectiveCamera;
  readonly state: FocusCameraState;
  register(target: FocusTarget): void;
  unregister(id: string): void;
  engage(id: string): boolean;
  release(): void;
  /** Called once per frame before rendering. */
  update(dtSeconds: number): void;
  /**
   * 1 for objects in the focus set, lerp(1, 1 - dimOthers, blend) otherwise.
   * Every material's `uFocusWeight` uniform is driven from this.
   */
  focusWeight(o: Object3D): number;
}

/** The visual bible's own name for the interface, kept so section 6.2 is greppable. */
export type FocusCamera = FocusCameraController;

/* ------------------------------------------------------------------------- */
/* Projection blending (6.3)                                                  */
/* ------------------------------------------------------------------------- */

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
    cam.coordinateSystem,
  );
  _ortho.makeOrthographic(-halfW, halfW, halfH, -halfH, near, far, cam.coordinateSystem);

  const p = _persp.elements;
  const o = _ortho.elements;
  const e = cam.projectionMatrix.elements;
  for (let i = 0; i < 16; i++) {
    // TypeScript 7 widens typed-array reads to number | undefined. Every index
    // here is 0..15 on three 16-element matrices, so the coalesce never fires.
    e[i] = (p[i] ?? 0) + ((o[i] ?? 0) - (p[i] ?? 0)) * blend;
  }
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

/* ------------------------------------------------------------------------- */
/* Framing and path (6.4)                                                     */
/* ------------------------------------------------------------------------- */

const _centre = new Vector3();
const _normal = new Vector3();
const _up = new Vector3();
const _lookAt = new Matrix4();

/**
 * The locked pose: square-on to the reading plane, framed to fill
 * FOCUS.fillFraction of the smaller viewport axis.
 *
 * The stand-off distance is derived from the ortho height rather than chosen,
 * which is what makes the projection blend exact at the plane (see
 * `blendProjection`). It also guarantees the perspective start pose is outside
 * the structure and that near-plane clipping cannot occur during the arc.
 */
export function computeLockedPose(t: FocusTarget, aspect: number, fov: number): CameraPose {
  const m = t.anchor.matrixWorld;
  const centre = new Vector3().setFromMatrixPosition(m);
  const n = t.planeNormal.clone().transformDirection(m).normalize();
  const up = t.planeUp.clone().transformDirection(m).normalize();

  // Frame the larger of the two constraints: width against aspect, or height.
  const pad = 1 + t.padding;
  const needH = t.extents.y * pad;
  const needW = t.extents.x * pad;
  const orthoHeight = Math.max(needH, needW / aspect) / FOCUS.fillFraction;

  const distance = orthoHeight * 0.5 / Math.tan(fov * 0.5);
  const position = centre.clone().addScaledVector(n, distance);
  const quaternion = new Quaternion().setFromRotationMatrix(
    _lookAt.lookAt(position, centre, up),
  );
  return { position, quaternion, fov, orthoHeight };
}

const _p1 = new Vector3();
const _p2 = new Vector3();
const _fwd = new Vector3();

/**
 * Cubic Bezier arc between two poses.
 *
 * A straight lerp dollies the camera through whatever is between the two poses,
 * which in this game is usually a vault wall. The control points push out along
 * each pose's own forward axis (so the camera leaves and arrives along the
 * direction it is already facing, which is what makes the move read as one
 * gesture) and lift over any intervening geometry.
 *
 * Writes into `out` and returns it. Allocates nothing.
 */
export function focusPath(
  from: CameraPose,
  to: CameraPose,
  lift: number,
  t: number,
  out: Vector3,
): Vector3 {
  const d = from.position.distanceTo(to.position);
  const k = d * FOCUS.arcControlFraction;

  _fwd.set(0, 0, -1).applyQuaternion(from.quaternion);
  _p1.copy(from.position).addScaledVector(_fwd, k).setY(from.position.y + lift);

  _fwd.set(0, 0, -1).applyQuaternion(to.quaternion);
  _p2.copy(to.position).addScaledVector(_fwd, -k).setY(to.position.y + lift);

  const u = 1 - t;
  return out
    .set(0, 0, 0)
    .addScaledVector(from.position, u * u * u)
    .addScaledVector(_p1, 3 * u * u * t)
    .addScaledVector(_p2, 3 * u * t * t)
    .addScaledVector(to.position, t * t * t);
}

/** Arc lift for a target whose top sits at `targetTopY`. See 6.4. */
export function arcLift(from: CameraPose, to: CameraPose, targetTopY: number): number {
  const base = targetTopY - Math.min(from.position.y, to.position.y);
  return Math.max(FOCUS.arcLiftMinM, base) * FOCUS.arcLiftScale;
}

/**
 * World-space cap height that subtends exactly `pxTarget` device pixels in the
 * locked orthographic framing. Label size in a locked frame is computed rather
 * than authored, so a 16 x 16 page table and a 4-entry resource list produce the
 * same on-screen glyph size.
 */
export function lockedCapHeight(
  orthoHeight: number,
  viewportHeightPx: number,
  pxTarget: number = MIN_GLYPH_PX,
): number {
  return (pxTarget / viewportHeightPx) * orthoHeight;
}

/* ------------------------------------------------------------------------- */
/* Focus weight broadcast (6.5)                                               */
/* ------------------------------------------------------------------------- */

/**
 * A material that carries `uFocusWeight`. Three shapes exist in this codebase:
 * a `ShaderMaterial` with a `uniforms` record (the beam), a
 * `MeshStandardMaterial` patched through `onBeforeCompile` which stashes the
 * shader on `userData.shader` (the line and the panel), and a node material with
 * a uniform node registered by hand. All three are updated through
 * `setFocusWeight`, so no caller has to know which it holds.
 */
interface UniformHolder {
  value: number;
}

interface UniformsBearing {
  readonly uniforms?: Record<string, UniformHolder | undefined>;
  readonly userData?: { shader?: { uniforms?: Record<string, UniformHolder | undefined> } };
}

/** A node-material uniform handle registered explicitly. */
export interface FocusUniformHandle {
  value: number;
}

function setFocusWeight(material: Material, weight: number): void {
  const bearing = material as unknown as UniformsBearing;
  const direct = bearing.uniforms?.['uFocusWeight'];
  if (direct !== undefined) {
    direct.value = weight;
    return;
  }
  const patched = bearing.userData?.shader?.uniforms?.['uFocusWeight'];
  if (patched !== undefined) patched.value = weight;
  // A material with no uFocusWeight is not an error: matte bodies outside the
  // focus set are handled by the same uniform where they have one, and inert
  // decorative geometry has none by design.
}

function materialsOf(o: Object3D, into: Set<Material>): void {
  const m = (o as unknown as { material?: Material | Material[] }).material;
  if (m === undefined) return;
  if (Array.isArray(m)) {
    for (const one of m) into.add(one);
  } else {
    into.add(m);
  }
}

/* ------------------------------------------------------------------------- */
/* The rig                                                                    */
/* ------------------------------------------------------------------------- */

const IDENTITY_POSE: CameraPose = {
  position: new Vector3(),
  quaternion: new Quaternion(),
  fov: (CAMERA.fovDeg * Math.PI) / 180,
  orthoHeight: 1,
};

const DEG = Math.PI / 180;

const _scratchPos = new Vector3();
const _scratchQuat = new Quaternion();
const _desired = new Vector3();
const _delta = new Vector3();
const _planeToCam = new Vector3();

export interface FocusCameraOptions {
  readonly camera: PerspectiveCamera;
  /** Root of the world scene graph. Walked once per engage to partition materials. */
  readonly scene: Scene;
  /** Viewport aspect ratio. Updated through `setViewport`. */
  readonly aspect: number;
  readonly viewportHeightPx: number;
}

export class FocusCameraRig implements FocusCameraController {
  readonly camera: PerspectiveCamera;

  private readonly scene: Scene;
  private aspect: number;
  private viewportHeightPx: number;

  private readonly targets = new Map<string, FocusTarget>();

  private mode: FocusMode = 'free';
  private target: FocusTarget | null = null;
  private t = 1;
  private blend = 0;
  // Explicitly number: the token object is `as const`, so an inferred type would
  // narrow to the engage literal and reject the release duration.
  private durationMs: number = FOCUS_DURATION_MS.engage;
  private from: CameraPose = IDENTITY_POSE;
  private to: CameraPose = IDENTITY_POSE;
  private lift = 0;

  /** Ortho blend, 0 perspective, 1 orthographic. Derived, but cached per frame. */
  private orthoBlend = 0;
  /** Distance to the reading plane, metres. Feeds the projection blend. */
  private focusDistance = 1;

  /** Locked-mode pan offset, in the plane's own axes, metres. */
  private readonly panOffset = new Vector2();
  /** Locked-mode zoom as a multiple of the computed framing. */
  private zoomFactor = 1;

  /** Free camera state, tracked continuously including through a lock. */
  private freeTarget: FreeCameraTarget | null = null;
  private readonly freePos = new Vector3();
  private readonly freeVel = new Vector3();
  private readonly freeQuat = new Quaternion();
  private freeInitialised = false;

  /** Focus-set membership, resolved on engage and not per frame. */
  private readonly focusIds = new Set<number>();
  private readonly focusedMaterials = new Set<Material>();
  private readonly otherMaterials = new Set<Material>();
  private readonly extraUniforms = new Set<FocusUniformHandle>();
  private lastBroadcastWeight = Number.NaN;

  constructor(opts: FocusCameraOptions) {
    this.camera = opts.camera;
    this.scene = opts.scene;
    this.aspect = opts.aspect;
    this.viewportHeightPx = opts.viewportHeightPx;

    this.camera.fov = CAMERA.fovDeg;
    this.camera.near = CAMERA.near;
    this.camera.far = CAMERA.far;
    // The projection matrix is written by hand every frame. `updateProjectionMatrix`
    // must not be called after `blendProjection` or it overwrites the blend with a
    // pure perspective matrix, which is the single easiest way to break this
    // system and the hardest to spot: the lock still frames correctly, it just
    // stops being orthographic.
    this.camera.updateProjectionMatrix();
  }

  get state(): FocusCameraState {
    return {
      mode: this.mode,
      target: this.target,
      t: this.t,
      blend: this.blend,
      from: this.from,
      to: this.to,
      durationMs: this.durationMs,
    };
  }

  setViewport(aspect: number, heightPx: number): void {
    this.aspect = aspect;
    this.viewportHeightPx = heightPx;
    this.camera.aspect = aspect;
    // Reframing on resize keeps the 78% fill promise, which a locked read
    // depends on: a window drag that pushed a page table off frame would be a
    // worse bug than a one-frame reframe.
    if (this.target !== null && this.mode !== 'free') {
      this.to = computeLockedPose(this.target, aspect, this.camera.fov * DEG);
    }
  }

  /* --- registration ----------------------------------------------------- */

  register(target: FocusTarget): void {
    this.targets.set(target.id, target);
  }

  unregister(id: string): void {
    this.targets.delete(id);
    if (this.target?.id === id) this.release();
  }

  /**
   * Register a node-material uniform that is not reachable by walking the scene
   * graph's materials (a post-chain uniform, or a material held only by an
   * effect pool). Registered handles always receive the unfocused weight,
   * because anything that needed the focused weight would be reachable from the
   * anchor's subtree.
   */
  registerFocusUniform(handle: FocusUniformHandle): () => void {
    this.extraUniforms.add(handle);
    return () => {
      this.extraUniforms.delete(handle);
    };
  }

  /* --- free camera ------------------------------------------------------ */

  /**
   * Set the free camera's desired pose. Called every frame by the game layer,
   * including while locked: the free target keeps tracking the convoy through
   * the whole lock, so the release lands where the player expects rather than
   * where they left.
   */
  setFreeTarget(t: FreeCameraTarget): void {
    const pitch = clamp(t.pitchRad, CAMERA.pitchMinDeg * DEG, CAMERA.pitchMaxDeg * DEG);
    const distance = clamp(t.distanceM, CAMERA.distanceMinM, CAMERA.distanceMaxM);
    this.freeTarget = { focus: t.focus, yawRad: t.yawRad, pitchRad: pitch, distanceM: distance };
  }

  /* --- transitions ------------------------------------------------------ */

  engage(id: string): boolean {
    const target = this.targets.get(id);
    if (target === undefined) return false;
    if (this.mode === 'engaging' || this.mode === 'locked') {
      // Re-engaging a different target from a lock is a legal move (the deadlock
      // cycle offers a lock, and the player may hop between the rings in it).
      // It is treated as a fresh engage from wherever the camera is now, which
      // keeps the arc continuous instead of snapping back through the free pose.
      if (this.target?.id === id) return true;
    }

    // The anchor's world matrix must be current: a target registered during
    // createStage has never been rendered, so its matrixWorld is identity until
    // something updates it, and the framing would put the camera at the origin.
    target.anchor.updateWorldMatrix(true, false);

    this.target = target;
    this.mode = 'engaging';
    this.t = 0;
    this.blend = 0;
    this.durationMs = FOCUS_DURATION_MS.engage;
    this.from = this.currentPose();
    this.to = computeLockedPose(target, this.aspect, this.camera.fov * DEG);
    this.panOffset.set(0, 0);
    this.zoomFactor = 1;

    const topY = target.anchor.position.y + target.extents.y * 0.5;
    this.lift = arcLift(this.from, this.to, topY);

    this.resolveFocusSet(target);
    return true;
  }

  release(): void {
    if (this.mode === 'free') return;
    this.mode = 'releasing';
    this.t = 0;
    this.durationMs = FOCUS_DURATION_MS.release;
    this.from = this.currentPose();
    this.to = this.freePose();
    this.lift = arcLift(this.from, this.to, this.from.position.y);
  }

  /* --- locked-mode input ------------------------------------------------ */

  /**
   * Pan within the reading plane, in metres. Clamped so the structure never
   * leaves frame: the pan range is whatever the framing does not already show,
   * which is zero for a structure that fits and grows as the player zooms in.
   * Rotation is deliberately absent. That is the point of the lock.
   */
  pan(dxMetres: number, dyMetres: number): void {
    if (this.mode !== 'locked' || this.target === null) return;
    const orthoH = this.to.orthoHeight * this.zoomFactor;
    const orthoW = orthoH * this.aspect;
    const maxX = Math.max(0, (this.target.extents.x - orthoW) * 0.5);
    const maxY = Math.max(0, (this.target.extents.y - orthoH) * 0.5);
    this.panOffset.set(
      clamp(this.panOffset.x + dxMetres, -maxX, maxX),
      clamp(this.panOffset.y + dyMetres, -maxY, maxY),
    );
  }

  /** Zoom between FOCUS.zoomMin and FOCUS.zoomMax of the computed framing. */
  zoom(factorDelta: number): void {
    if (this.mode !== 'locked') return;
    this.zoomFactor = clamp(this.zoomFactor * factorDelta, FOCUS.zoomMin, FOCUS.zoomMax);
    // Re-clamp the pan: zooming out can leave the offset outside the new range.
    this.pan(0, 0);
  }

  /* --- per-frame -------------------------------------------------------- */

  update(dtSeconds: number): void {
    this.integrateFree(dtSeconds);

    switch (this.mode) {
      case 'free':
        this.applyPose(this.freePose(), 0);
        break;

      case 'engaging':
        this.advance(dtSeconds, EASE.focusIn);
        this.applyTransition();
        if (this.t >= 1) {
          this.mode = 'locked';
          this.blend = 1;
        }
        break;

      case 'locked':
        this.blend = 1;
        this.applyLocked();
        break;

      case 'releasing': {
        // The free pose is recomputed every frame during the release, because
        // the convoy is still walking. Retargeting mid-transition would normally
        // produce a visible kink; it does not here because the release is short
        // and the free pose moves slowly relative to the camera's own travel.
        this.to = this.freePose();
        this.advance(dtSeconds, EASE.focusOut);
        this.applyTransition();
        if (this.t >= 1) {
          this.mode = 'free';
          this.target = null;
          this.blend = 0;
          this.clearFocusSet();
        }
        break;
      }
    }

    this.camera.updateMatrixWorld();
    this.broadcastFocusWeights();
  }

  private advance(dtSeconds: number, ease: (x: number) => number): void {
    this.t = Math.min(1, this.t + (dtSeconds * 1000) / this.durationMs);
    this.blend = ease(this.t);
  }

  /**
   * Position on the Bezier arc, rotation on a leading schedule, projection on the
   * eased blend.
   *
   * Rotation completes FOCUS.rotationLead ahead of position (12%), which means
   * the target is centred before the camera stops moving. Without it, the frame
   * appears to settle twice: once when the rotation lands and again when the
   * dolly stops, and the second settle reads as an overshoot even though nothing
   * overshoots.
   */
  private applyTransition(): void {
    focusPath(this.from, this.to, this.lift, this.blend, _scratchPos);

    const rotT = Math.min(1, this.t * FOCUS.rotationLead);
    const rotEase = this.mode === 'releasing' ? EASE.focusOut(rotT) : EASE.focusIn(rotT);
    _scratchQuat.copy(this.from.quaternion).slerp(this.to.quaternion, rotEase);

    this.camera.position.copy(_scratchPos);
    this.camera.quaternion.copy(_scratchQuat);

    // Engaging flattens toward orthographic; releasing unflattens. FOV is held
    // constant at CAMERA.fovDeg through the whole transition: the flattening
    // comes entirely from the projection blend, and animating the FOV as well
    // would produce a dolly-zoom, which is a different and much louder effect.
    this.orthoBlend = this.mode === 'releasing' ? 1 - this.blend : this.blend;
    this.focusDistance = this.measureFocusDistance();
    blendProjection(
      this.camera,
      this.aspect,
      this.camera.fov * DEG,
      this.focusDistance,
      this.camera.near,
      this.camera.far,
      this.orthoBlend,
    );
  }

  private applyLocked(): void {
    const t = this.target;
    if (t === null) return;

    // Pan moves the camera within the plane rather than shifting the projection,
    // so the reading plane stays exactly perpendicular to the view direction and
    // labels stay square-on. Shifting the frustum instead would introduce a
    // shear that SDF text samples badly.
    _scratchPos.copy(this.to.position);
    if (this.panOffset.x !== 0 || this.panOffset.y !== 0) {
      const m = t.anchor.matrixWorld;
      _up.copy(t.planeUp).transformDirection(m).normalize();
      _normal.copy(t.planeNormal).transformDirection(m).normalize();
      // Right-handed basis on the plane: right = up cross normal.
      _delta.copy(_up).cross(_normal).normalize();
      _scratchPos.addScaledVector(_delta, this.panOffset.x).addScaledVector(_up, this.panOffset.y);
    }

    this.camera.position.copy(_scratchPos);
    this.camera.quaternion.copy(this.to.quaternion);
    this.orthoBlend = 1;
    this.focusDistance = this.measureFocusDistance();

    // Zoom scales the ortho height, and the projection blend derives that height
    // from `focusDistance * tan(fov/2)`. Scaling the distance rather than
    // adding a separate zoom term keeps the two projections agreeing at the
    // plane, which is the invariant the whole blend rests on.
    blendProjection(
      this.camera,
      this.aspect,
      this.camera.fov * DEG,
      this.focusDistance * this.zoomFactor,
      this.camera.near,
      this.camera.far,
      1,
    );
  }

  private applyPose(pose: CameraPose, orthoBlend: number): void {
    this.camera.position.copy(pose.position);
    this.camera.quaternion.copy(pose.quaternion);
    this.orthoBlend = orthoBlend;
    if (orthoBlend === 0) {
      // Pure perspective. Let Three build the matrix so that any future change
      // to its projection maths (a different reversed-Z convention, say) reaches
      // the free camera without this file being edited.
      this.camera.updateProjectionMatrix();
      return;
    }
    this.focusDistance = this.measureFocusDistance();
    blendProjection(
      this.camera,
      this.aspect,
      this.camera.fov * DEG,
      this.focusDistance,
      this.camera.near,
      this.camera.far,
      orthoBlend,
    );
  }

  /**
   * Distance from the camera to the reading plane, measured along the plane
   * normal rather than to the anchor's origin. The two differ once the player
   * pans, and using the origin distance would make the projection blend
   * inexact exactly where they are looking.
   */
  private measureFocusDistance(): number {
    const t = this.target;
    if (t === null) return this.to.orthoHeight * 0.5 / Math.tan(this.camera.fov * DEG * 0.5);
    const m = t.anchor.matrixWorld;
    _centre.setFromMatrixPosition(m);
    _normal.copy(t.planeNormal).transformDirection(m).normalize();
    _planeToCam.copy(this.camera.position).sub(_centre);
    const d = Math.abs(_planeToCam.dot(_normal));
    // A degenerate distance (camera exactly on the plane) would make the
    // perspective matrix singular. The floor is the near plane, which is the
    // smallest distance that can produce a valid frustum.
    return Math.max(d, this.camera.near * 2);
  }

  private currentPose(): CameraPose {
    return {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
      fov: this.camera.fov * DEG,
      orthoHeight: this.to.orthoHeight,
    };
  }

  /* --- free camera integration ------------------------------------------ */

  /**
   * Critically damped spring, semi-implicit, so it is stable at any dt and never
   * overshoots. An explicit spring at omega 9 blows up on a 200 ms frame, which
   * is exactly the frame you get coming back from a tab blur, and the camera
   * flying off is a spectacular way to fail a recovery path.
   */
  private integrateFree(dtSeconds: number): void {
    const t = this.freeTarget;
    if (t === null) return;

    const cp = Math.cos(t.pitchRad);
    _desired.set(
      t.focus.x + Math.sin(t.yawRad) * cp * t.distanceM,
      t.focus.y + Math.sin(t.pitchRad) * t.distanceM,
      t.focus.z + Math.cos(t.yawRad) * cp * t.distanceM,
    );

    if (!this.freeInitialised) {
      this.freePos.copy(_desired);
      this.freeVel.set(0, 0, 0);
      this.freeInitialised = true;
    } else {
      const omega = CAMERA.springOmega;
      const dt = dtSeconds;
      const f = 1 + 2 * dt * omega;
      const oo = omega * omega;
      const hoo = dt * oo;
      const hhoo = dt * hoo;
      const detInv = 1 / (f + hhoo);

      _delta.copy(_desired).sub(this.freePos);
      // pos' = (f*pos + dt*vel + hhoo*desired) / (f + hhoo)
      this.freePos.multiplyScalar(f).addScaledVector(this.freeVel, dt).addScaledVector(_desired, hhoo).multiplyScalar(detInv);
      // vel' = (vel + hoo*(desired - pos)) / (f + hhoo), using the pre-step delta
      this.freeVel.addScaledVector(_delta, hoo).multiplyScalar(detInv);
    }

    _lookAt.lookAt(this.freePos, t.focus, UP);
    this.freeQuat.setFromRotationMatrix(_lookAt);
  }

  private freePose(): CameraPose {
    return {
      position: this.freePos,
      quaternion: this.freeQuat,
      fov: this.camera.fov * DEG,
      orthoHeight: this.to.orthoHeight,
    };
  }

  /* --- dimming (6.5) ---------------------------------------------------- */

  /**
   * Depth of field is not the primary mechanism here. Blurring emissive
   * hairlines against black turns them into soft smears, which contradicts
   * principle 1.6 and costs a pass. The primary mechanism is per-object
   * attenuation.
   */
  focusWeight(o: Object3D): number {
    if (this.mode === 'free') return 1;
    if (this.isInFocusSet(o)) return 1;
    const target = 1 - (this.target?.dimOthers ?? FOCUS.dimOthers);
    return 1 + (target - 1) * this.blend;
  }

  private isInFocusSet(o: Object3D): boolean {
    let cursor: Object3D | null = o;
    while (cursor !== null) {
      if (this.focusIds.has(cursor.id)) return true;
      cursor = cursor.parent;
    }
    return false;
  }

  /**
   * Partition the scene's materials once per engage.
   *
   * `uFocusWeight` is updated once per frame per MATERIAL rather than per
   * object, because materials are cached by (archetype, semanticId, tier) and a
   * leg with 400 page slabs holds three materials rather than four hundred.
   * That only works if focus membership is a property of the material, which it
   * is: the world layer groups objects by focus membership when it builds a
   * structure, so a material is either wholly inside the focus set or wholly
   * outside it.
   */
  private resolveFocusSet(target: FocusTarget): void {
    this.clearFocusSet();

    target.anchor.traverse((o) => {
      this.focusIds.add(o.id);
      materialsOf(o, this.focusedMaterials);
    });
    for (const extra of target.focusSet) {
      extra.traverse((o) => {
        this.focusIds.add(o.id);
        materialsOf(o, this.focusedMaterials);
      });
    }

    this.scene.traverse((o) => {
      if (this.focusIds.has(o.id)) return;
      materialsOf(o, this.otherMaterials);
    });
    // A material shared between a focused object and an unfocused one cannot be
    // dimmed correctly. It is resolved in favour of the focus set, and flagged,
    // because the fix is a second cache entry in the material factory rather
    // than anything this file can do.
    for (const m of this.focusedMaterials) {
      if (this.otherMaterials.delete(m) && import.meta.env.DEV) {
        console.warn(
          `[kt] focus target "${target.id}" shares material "${m.name || m.uuid}" with ` +
            'geometry outside the focus set. It will stay lit. Give the focused structure ' +
            'its own material cache key. See 03-VISUAL-BIBLE 6.5.',
        );
      }
    }

    this.lastBroadcastWeight = Number.NaN;
  }

  private clearFocusSet(): void {
    // Restore full brightness before forgetting who was dimmed, or a released
    // lock leaves the world at 18% until something else touches the uniform.
    for (const m of this.otherMaterials) setFocusWeight(m, 1);
    for (const u of this.extraUniforms) u.value = 1;
    this.focusIds.clear();
    this.focusedMaterials.clear();
    this.otherMaterials.clear();
    this.lastBroadcastWeight = Number.NaN;
  }

  /**
   * Unfocused emission drops to 18% of its gain, which puts most of it below the
   * bloom threshold, so the halos outside the focus disappear as well. That
   * disappearance is what actually clears the frame: the dimming alone would
   * leave a field of glow.
   *
   * The write is skipped when the weight has not changed, which is every frame
   * of a settled lock. That turns the common case from "walk every material each
   * frame" into a single float comparison.
   */
  private broadcastFocusWeights(): void {
    const weight = this.mode === 'free' ? 1 : 1 - (this.target?.dimOthers ?? FOCUS.dimOthers) * this.blend;
    if (weight === this.lastBroadcastWeight) return;
    this.lastBroadcastWeight = weight;

    for (const m of this.focusedMaterials) setFocusWeight(m, 1);
    for (const m of this.otherMaterials) setFocusWeight(m, weight);
    for (const u of this.extraUniforms) u.value = weight;
  }

  /* --- labels (6.6) ------------------------------------------------------ */

  /**
   * Orientation for a world-space label during a transition. While `blend < 0.5`
   * labels billboard to the camera; past that, if the target asks for it, they
   * slerp to the plane using `ease(smoothstep(0.5, 1, blend))`. Because the
   * camera arrives square-on to that same plane, labels finish parallel to the
   * screen and unrotated, so the SDF text is sampled at close to its authored
   * size and stays crisp.
   *
   * Writes into `out` and returns it.
   */
  labelQuaternion(out: Quaternion, billboardToCamera: Quaternion): Quaternion {
    const t = this.target;
    if (t === null || t.labelPlane === 'billboard-to-camera' || this.blend < FOCUS.labelPlaneBlend) {
      return out.copy(billboardToCamera);
    }
    const s = smoothstep(FOCUS.labelPlaneBlend, 1, this.blend);
    return out.copy(billboardToCamera).slerp(this.to.quaternion, EASE.settle(s));
  }

  /**
   * Cap height for a label in the current framing. Returns null while free, so
   * the caller keeps its authored world-space size from
   * `WORLD_CAP_HEIGHT_M`.
   */
  lockedCapHeightNow(): number | null {
    if (this.mode === 'free') return null;
    return lockedCapHeight(this.to.orthoHeight * this.zoomFactor, this.viewportHeightPx);
  }

  /**
   * True when the target's label density would push text below its stated
   * minimum. The caller responds by framing a sub-region and offering pan, never
   * by shrinking the type.
   */
  needsSubRegion(target: FocusTarget): boolean {
    const pose = computeLockedPose(target, this.aspect, this.camera.fov * DEG);
    return lockedCapHeight(pose.orthoHeight, this.viewportHeightPx) < target.minGlyphHeight;
  }
}

/* ------------------------------------------------------------------------- */
/* Small maths                                                                */
/* ------------------------------------------------------------------------- */

const UP = new Vector3(0, 1, 0);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
