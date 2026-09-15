import { InstancedMesh, PlaneGeometry, StorageInstancedBufferAttribute } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { Fn, instanceIndex, storage, uniform } from 'three/tsl';
import { LAYER } from '@design';
import type { RenderCapabilities } from '@platform';
import { createParticleMaterial } from '../materials';
/** Three lowers the same node to WebGPU compute or WebGL2 transform-feedback ping-pong. */
export function createParticleIntegration(count:number,caps:RenderCapabilities) {
  if(!Number.isInteger(count)||count<1)throw new Error('Invalid particle count');
  const positions=new Float32Array(count*3),velocities=new Float32Array(count*3);
  for(let i=0;i<count;i++){
    positions[i*3]=(i%100-50)*0.4;positions[i*3+1]=(i%31)*0.1;
    positions[i*3+2]=(Math.floor(i/100)-30)*0.4;velocities[i*3+1]=0.1+(i%7)*0.03;
  }
  const position=storage(new StorageInstancedBufferAttribute(positions,3),'vec3',count);
  const velocity=storage(new StorageInstancedBufferAttribute(velocities,3),'vec3',count).toReadOnly();
  const delta=uniform(0);
  const integration=Fn(()=>{
    const p=position.element(instanceIndex);p.addAssign(velocity.element(instanceIndex).mul(delta));
    p.y.assign(p.y.mod(4));
  })().compute(count);
  const geometry=new PlaneGeometry(1,1),material=createParticleMaterial(position.element(instanceIndex),'running');
  const object=new InstancedMesh(geometry,material,count);object.layers.set(LAYER.EFFECTS);object.frustumCulled=false;
  object.name='kt.effects.benchmark.particles';object.matrixAutoUpdate=false;
  return {object,strategy:caps.compute?'compute':'vertex-ping-pong',
    update(renderer:WebGPURenderer,dt:number){delta.value=Math.max(0,Math.min(dt,0.1));renderer.compute(integration);},
    dispose(){integration.dispose();object.dispose();geometry.dispose();material.dispose();object.removeFromParent();}};
}
