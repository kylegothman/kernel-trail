import {Scene,Mesh,PlaneGeometry,RenderTarget} from 'three/webgpu';
import type {WebGPURenderer,PerspectiveCamera} from 'three/webgpu';
import {createFloorPoolMaterial,assertTransparencyDepth} from '../../../src/render';
/** Direct GPU overlap check: three coincident additive surfaces produce three contributions. */
export async function exerciseOverlap(renderer:WebGPURenderer,camera:PerspectiveCamera){
  const scene=new Scene(),geometry=new PlaneGeometry(20,20),material=createFloorPoolMaterial('page_clean');
  const meshes=[new Mesh(geometry,material),new Mesh(geometry,material),new Mesh(geometry,material)];
  const target=new RenderTarget(16,16),previous=renderer.getRenderTarget(),mask=camera.layers.mask,auto=renderer.autoClear;
  const values:number[]=[];
  try{
    camera.layers.set(0);renderer.setRenderTarget(target);renderer.autoClear=true;
    for(let i=0;i<3;i++){
      assertTransparencyDepth(i+1);meshes[i]!.renderOrder=i;scene.add(meshes[i]!);renderer.render(scene,camera);
      const pixel=await renderer.readRenderTargetPixelsAsync(target,8,8,1,1);values.push(Number(pixel[0])+Number(pixel[1])+Number(pixel[2]));
    }
    if(!(values[1]!>values[0]!&&values[2]!>values[1]!))throw new Error(`Three overlap contributions not observed: ${values}`);
    let rejected=false;try{assertTransparencyDepth(4);}catch{rejected=true;}
    if(!rejected)throw new Error('Fourth transparency layer not rejected');
    return {layers:3,channelSums:values,fourthRejected:rejected};
  }finally{renderer.setRenderTarget(previous);renderer.autoClear=auto;camera.layers.mask=mask;geometry.dispose();material.dispose();target.dispose();scene.clear();}
}
