import type {Object3D,PerspectiveCamera} from 'three/webgpu';
import type {FocusCameraRig} from '@render';
import {scratch} from '../scratch';
/** Convert the requested world orientation into the label parent's local space. */
export function orientLabel(label:Object3D,anchor:Object3D,camera:PerspectiveCamera,focus:FocusCameraRig):void {
  camera.getWorldQuaternion(scratch.quaternion);
  if(focus.state.mode!=='free'&&focus.focusWeight(anchor)===1)focus.labelQuaternion(scratch.quaternion,scratch.quaternion);
  // A quaternion alone cannot cancel a rotated, non-uniformly scaled parent.
  // Author the full local matrix from a world-space reading plane instead.
  scratch.position.copy(label.position);
  if(label.parent)scratch.position.applyMatrix4(label.parent.matrixWorld);
  label.matrix.compose(scratch.position,scratch.quaternion,label.scale);
  if(label.parent){scratch.matrix.copy(label.parent.matrixWorld).invert();label.matrix.premultiply(scratch.matrix);}
  label.matrixAutoUpdate=false;label.matrixWorldNeedsUpdate=true;

}
/** Device pixels per world unit for a camera-parallel label at positive view depth. */
export function pixelsPerWorldUnit(camera:PerspectiveCamera,viewDepth:number,viewportHeightPx:number):number {
  const e=camera.projectionMatrix.elements;
  return Math.abs(e[5]!/(e[15]!-e[11]!*viewDepth))*viewportHeightPx*0.5;
}
