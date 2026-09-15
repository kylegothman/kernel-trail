import {createBackend} from '../../../src/render/backend/createBackend';
import {DeviceLossPolicy} from '../../../src/render/backend/DeviceLossPolicy';
import {detectCapabilities,PROFILES} from '../../../src/platform';
/** Real context loss, with host-owned canvas/world reconstruction through the policy. */
export async function exerciseDeviceLoss() {
  const {caps}=await detectCapabilities('gpu-loss',true);
  let canvas=document.createElement('canvas');
  let active=await createBackend(canvas,caps,{antialias:false,samples:1,profile:PROFILES.low},true);
  const attempts:boolean[]=[];let outcome='pending';
  const policy=new DeviceLossPolicy(async forceWebGL=>{
    attempts.push(forceWebGL);active.dispose();canvas.remove();canvas=document.createElement('canvas');
    active=await createBackend(canvas,caps,{antialias:false,samples:1,profile:PROFILES.low},forceWebGL);
  },value=>{outcome=value;},()=>{});
  try {
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Device-loss event not received')),10000);
      active.onDeviceLost(info=>{void policy.handle(info.reason,'webgl2').then(()=>{clearTimeout(timeout);resolve();},reject);});
      // Pinned r185 WebGLBackend exposes getContext(); its public type omits it.
      const native=active.deviceRenderer.backend as unknown as {getContext():WebGL2RenderingContext};
      const extension=native.getContext().getExtension('WEBGL_lose_context');
      if(!extension){clearTimeout(timeout);reject(new Error('WEBGL_lose_context is required by this GPU test'));return;}
      extension.loseContext();
    });
    return {attempts,outcome,backend:active.id};
  } finally {active.dispose();canvas.remove();}
}
