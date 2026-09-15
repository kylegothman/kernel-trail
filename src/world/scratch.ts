import {Vector3,Quaternion,Matrix4,Color} from 'three/webgpu';
/** Synchronous scratch only: callers must not retain these across another helper call. */
export const scratch={position:new Vector3(),direction:new Vector3(),scale:new Vector3(),quaternion:new Quaternion(),matrix:new Matrix4(),color:new Color()};
