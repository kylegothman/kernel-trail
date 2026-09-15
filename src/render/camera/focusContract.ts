import type { Object3D, Quaternion, Vector2, Vector3 } from 'three/webgpu';

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
  /** Current focus amount: rises on engage and falls on release. */
  readonly blend: number;
  readonly from: CameraPose;
  readonly to: CameraPose;
  readonly durationMs: number;
}

