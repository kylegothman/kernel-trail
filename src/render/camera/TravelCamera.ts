import { Vector3 } from 'three/webgpu';
import type { Scene } from 'three/webgpu';
import { CAMERA } from '@design';
import { FocusCameraRig } from './FocusCamera';
import { BlendedPerspectiveCamera } from './projection';

/** Owns the one scene camera. The rig integrates its tracker even while locked. */
export class TravelCamera {
  readonly camera = new BlendedPerspectiveCamera(CAMERA.fovDeg, 1, CAMERA.near, CAMERA.far);
  readonly focus: FocusCameraRig;
  private readonly target = { focus: new Vector3(), yawRad: 0, pitchRad: Math.PI / 6, distanceM: CAMERA.distanceMinM as number };
  constructor(scene: Scene, aspect: number, viewportHeightPx: number) {
    this.focus = new FocusCameraRig({camera:this.camera,scene,aspect,viewportHeightPx});
    this.camera.matrixAutoUpdate=false;
  }
  track(position: Vector3): void { this.target.focus.copy(position); }
  orbit(yawDelta: number, pitchDelta: number): boolean {
    if(this.focus.state.mode!=='free')return false;
    this.target.yawRad+=yawDelta;
    this.target.pitchRad=Math.max(CAMERA.pitchMinDeg*Math.PI/180,Math.min(CAMERA.pitchMaxDeg*Math.PI/180,this.target.pitchRad+pitchDelta));
    return true;
  }
  dolly(factor: number): void {
    if(this.focus.state.mode!=='free')return;
    this.target.distanceM=Math.max(CAMERA.distanceMinM,Math.min(CAMERA.distanceMaxM,this.target.distanceM*factor));
  }
  update(dtSeconds: number): void { this.focus.setFreeTarget(this.target);this.focus.update(dtSeconds); }
  dispose(): void { this.focus.dispose(); }
}
