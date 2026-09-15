import { Scene,PerspectiveCamera,Mesh,InstancedMesh,BoxGeometry,CylinderGeometry,PlaneGeometry,InstancedBufferAttribute,Matrix4 } from 'three/webgpu';
import { CAMERA,FORM,GRID,LAYER,MODULE_PITCH_M,SEMANTICS,DASH,HATCH_ID,gainFor,linearColor } from '@design';
import { PROFILES,type QualityTier } from '@platform';
import { createAmbientLight,createKeyLight,getMaterial,createFloorPoolMaterial,createReflectionProxyMaterial } from './materials';
export { createBackend } from './backend/createBackend';
export type {RendererBackend,FrameRequest,RenderStats,InstancedBatchDesc,InstancedBatchHandle,BackendInitOptions,BatchChannel} from './RendererBackend';
export {PostChain,stagesForTier} from './postChain';
export {DrawCallBudget,validateScene,assertTransparencyDepth} from './DrawCallBudget';
export {RenderTargetBudget,planTargets} from './targets';
export * from './materials';
export {holoLabel,FONT_URL} from './materials/holoLabel';
/** Isolated geometry only. It has no simulation, world, or game dependency. */
export function createProbeScene(tier:QualityTier='high',slabCount=180,beamCount=12) {
  const profile=PROFILES[tier],scene=new Scene();
  const camera=new PerspectiveCamera(CAMERA.fovDeg,1440/900,CAMERA.near,CAMERA.far);
  const columns=Math.ceil(Math.sqrt(slabCount));
  camera.position.set(0,columns*MODULE_PITCH_M,columns*MODULE_PITCH_M);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const floorGeometry=new PlaneGeometry(GRID.planeSizeM,GRID.planeSizeM);
  const floor=new Mesh(floorGeometry,getMaterial('reflective-floor','frame_free',tier));floor.rotation.x=-Math.PI/2;floor.layers.set(LAYER.TERRAIN);floor.name='kt.terrain.probe.floor';scene.add(floor);
  const geometry=new BoxGeometry(FORM.pagePlate.x,FORM.pagePlate.thickness,FORM.pagePlate.z);
  const slabs=new InstancedMesh(geometry,getMaterial('emissive-panel','page_clean',tier),slabCount);
  slabs.userData['castsReflection']=true;slabs.name='kt.structures.probe.slabs';slabs.layers.set(LAYER.STRUCTURES);slabs.frustumCulled=false;
  const matrix=new Matrix4(),colorGain=new Float32Array(slabCount*4),statePhase=new Float32Array(slabCount*4),patternId=new Float32Array(slabCount*4);
  const tokens=Object.values(SEMANTICS);
  for(let i=0;i<slabCount;i++) {
    matrix.makeTranslation((i%columns-columns/2)*MODULE_PITCH_M,FORM.pagePlate.thickness, (Math.floor(i/columns)-columns/2)*MODULE_PITCH_M);
    slabs.setMatrixAt(i,matrix);const t=tokens[i%tokens.length]??SEMANTICS.page_clean,c=linearColor(t.hex);
    colorGain.set([c.r,c.g,c.b,gainFor(t.family,t.level)],i*4);statePhase.set([i%tokens.length,0,t.pulseHz,1],i*4);patternId.set([DASH[t.dash].on,DASH[t.dash].off,HATCH_ID[t.hatch],i],i*4);
  }
  geometry.setAttribute('aColorGain',new InstancedBufferAttribute(colorGain,4));geometry.setAttribute('aStatePhase',new InstancedBufferAttribute(statePhase,4));geometry.setAttribute('aPatternId',new InstancedBufferAttribute(patternId,4));slabs.instanceMatrix.needsUpdate=true;scene.add(slabs);
  const beamGeometry=new CylinderGeometry(FORM.filament.orbitRadius,FORM.filament.orbitRadius,FORM.cpuColumn.height,profile.beamRadialSegments,1,true);
  const beams=new InstancedMesh(beamGeometry,getMaterial('volumetric-beam','running',tier),beamCount);beams.layers.set(LAYER.BEAMS);beams.frustumCulled=false;beams.name='kt.beams.probe.columns';
  for(let i=0;i<beamCount;i++){matrix.makeTranslation((i-beamCount/2)*MODULE_PITCH_M,FORM.cpuColumn.height/2,0);beams.setMatrixAt(i,matrix);}
  beams.instanceMatrix.needsUpdate=true;beams.userData['castsReflection']=true;scene.add(beams);
  const poolGeometry=new PlaneGeometry(FORM.pagePlate.x*2.5,FORM.pagePlate.z*2.5),poolMaterial=createFloorPoolMaterial('page_clean');
  const poolCount=Math.min(slabCount,profile.floorLightPools);
  const pools=new InstancedMesh(poolGeometry,poolMaterial,poolCount);pools.layers.set(LAYER.TERRAIN);pools.name='kt.terrain.probe.pools';
  for(let i=0;i<poolCount;i++){matrix.makeRotationX(-Math.PI/2);matrix.setPosition((i%columns-columns/2)*MODULE_PITCH_M,0.001,(Math.floor(i/columns)-columns/2)*MODULE_PITCH_M);pools.setMatrixAt(i,matrix);}
  pools.instanceMatrix.needsUpdate=true;scene.add(pools);
  const proxyMaterial=tier==='medium'?createReflectionProxyMaterial('running'):null;
  const proxy=proxyMaterial?new InstancedMesh(beamGeometry,proxyMaterial,beamCount):null;
  if(proxy){proxy.instanceMatrix.copy(beams.instanceMatrix);proxy.scale.y=-1;proxy.layers.set(LAYER.TERRAIN);scene.add(proxy);}
  const ambient=createAmbientLight(),key=createKeyLight();ambient.layers.set(LAYER.LIGHTS);key.layers.set(LAYER.LIGHTS);scene.add(ambient,key);
  scene.traverse(o=>{o.updateMatrix();o.matrixAutoUpdate=false;o.castShadow=false;o.receiveShadow=false;});
  const declared={drawCalls:4+(proxy?1:0),triangles:2+slabCount*12+poolCount*2+beamCount*profile.beamRadialSegments*2*(proxy?2:1)};
  return {scene,camera,slabs,beams,declared,update(){scene.updateMatrixWorld();},
    dispose(){floorGeometry.dispose();geometry.dispose();beamGeometry.dispose();poolGeometry.dispose();poolMaterial.dispose();pools.dispose();proxy?.dispose();proxyMaterial?.dispose();slabs.dispose();beams.dispose();scene.clear();}};
}
export { FocusCameraRig, computeLockedPose, focusPath, arcLift, lockedCapHeight } from './camera/FocusCamera';
export type { FocusCamera, FocusCameraController, FocusCameraOptions, FreeCameraTarget } from './camera/FocusCamera';
export type { FocusMode, FocusTarget, CameraPose, FocusCameraState } from './camera/focusContract';
export { TravelCamera } from './camera/TravelCamera';
export { BlendedPerspectiveCamera, blendProjection, projectionRay } from './camera/projection';
