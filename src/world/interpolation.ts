import type {Vector3,Quaternion} from 'three/webgpu';
export function interpolate(a:number,b:number,alpha:number):number{return a+(b-a)*Math.max(0,Math.min(1,alpha));}
export function interpolatePosition(a:Vector3,b:Vector3,alpha:number,out:Vector3):Vector3{return out.copy(a).lerp(b,Math.max(0,Math.min(1,alpha)));}
export function interpolateRotation(a:Quaternion,b:Quaternion,alpha:number,out:Quaternion):Quaternion{return out.copy(a).slerp(b,Math.max(0,Math.min(1,alpha)));}
