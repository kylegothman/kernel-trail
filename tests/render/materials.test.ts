import {it,expect,afterEach} from 'vitest';
import {BoxGeometry,Mesh,Scene} from 'three/webgpu';
import * as materials from '../../src/render/materials';
import {validateScene} from '../../src/render/DrawCallBudget';
import {LAYER} from '../../src/design';
afterEach(()=>materials.disposeMaterials());
it('seven archetypes each construct at every tier',()=>{expect(materials.ARCHETYPES).toHaveLength(7);for(const a of materials.ARCHETYPES)for(const tier of ['low','medium','high'] as const)expect(materials.getMaterial(a,'running',tier)).toBeTruthy();});
it('cache: four hundred requests produce one material',()=>{const first=materials.getMaterial('emissive-panel','page_clean','high');for(let i=0;i<400;i++)expect(materials.getMaterial('emissive-panel','page_clean','high')).toBe(first);expect(materials.materialCacheSize()).toBe(1);});
it('exactly three exported light constructors, no point light',()=>{const keys=Object.keys(materials).filter(k=>k.endsWith('Light'));expect(keys.sort()).toEqual(['createAmbientLight','createKeyLight','createReadLight']);expect('PointLight' in materials).toBe(false);const lights=[materials.createAmbientLight(),materials.createKeyLight(),materials.createReadLight()];expect(lights.map(l=>l.intensity)).toEqual([0.06,0.15,0.35]);expect(lights.every(l=>!l.castShadow)).toBe(true);});
it('void surface and standard/physical dithering',()=>{expect(materials.getMaterial('void-surface','ready','high')).toMatchObject({roughness:0.78,metalness:0.1,envMapIntensity:0,dithering:true});for(const a of materials.ARCHETYPES)for(const tier of ['low','medium','high'] as const){const m=materials.getMaterial(a,'running',tier);if('roughness' in m)expect(m.dithering).toBe(true);}});
it('transmission counts owners, not cache keys',()=>{const owners=Array.from({length:9},()=>({}));const result=owners.map(o=>materials.acquireGlass(o,'running','high'));expect(result[0]).toBe(result[7]);expect(result[8]).not.toBe(result[0]);materials.releaseGlass(owners[0]!);expect(materials.acquireGlass(owners[8]!,'running','high')).toBe(result[0]);});
it('ninth repeated mesh rejected at stage validation',()=>{const scene=new Scene(),g=new BoxGeometry(),m=materials.getMaterial('void-surface','ready','low');for(let i=0;i<9;i++){const mesh=new Mesh(g,m);mesh.layers.set(LAYER.STRUCTURES);scene.add(mesh);}expect(()=>validateScene(scene)).toThrow('instancing');g.dispose();});

it('compatibility and packed buffers merge dirty ranges without matrix uploads',async()=>{
 const {ManagedBatch}=await import('../../src/render/RendererBackend');
 const g=new BoxGeometry(),m=materials.getMaterial('emissive-panel','page_clean','high');
 const batch=new ManagedBatch({name:'test',capacity:8,geometry:'slab',material:'structure',perInstanceColour:true,castShadow:false,layer:LAYER.STRUCTURES},g,m,()=>{});
 batch.colours.set([0.1,0.2,0.3],0);batch.touch(0,1,'colour');batch.touch(6,8,'colorGain');
 batch.flush();expect(batch.colorGain.slice(0,3)).toEqual(new Float32Array([0.1,0.2,0.3]));
 expect(batch.object.instanceMatrix.version).toBe(0);
 expect(batch.object.geometry.getAttribute('aColorGain')).toHaveProperty('updateRanges',[{start:0,count:4},{start:24,count:8}]);
 batch.touch(0,1);batch.flush();expect(batch.colorGain[3]).toBeCloseTo(1.1);
 expect(batch.colorGain.length+batch.statePhase.length+batch.patternId.length).toBe(8*12);
 batch.dispose();g.dispose();
});
it('storage specialization remains per batch while archetype stays cached',async()=>{
 const {ManagedBatch}=await import('../../src/render/RendererBackend');
 const g=new BoxGeometry(),m=materials.getMaterial('emissive-panel','page_clean','high');
 const batch=new ManagedBatch({name:'storage',capacity:4,geometry:'slab',material:'structure',perInstanceColour:true,castShadow:false,layer:LAYER.STRUCTURES},g,m,()=>{},true);
 expect(batch.object.geometry.getAttribute('aColorGain')).toHaveProperty('isStorageInstancedBufferAttribute',true);
 expect(materials.getMaterial('emissive-panel','page_clean','high')).toBe(m);batch.dispose();g.dispose();
});

it('factory focus groups preserve cache identity and independent uniforms for every archetype',()=>{
 const inside={},outside={};
 for(const archetype of materials.ARCHETYPES){const base=materials.getMaterial(archetype,'running','high');const a=materials.acquireFocusMaterial(inside,base),b=materials.acquireFocusMaterial(outside,base);
  expect(a).not.toBe(b);expect(materials.acquireFocusMaterial(inside,base)).toBe(a);expect(materials.getMaterial(archetype,'running','high')).toBe(base);
  materials.materialFocusUniform(b)!.value=.18;expect(materials.materialFocusUniform(a)!.value).toBe(1);expect(materials.materialFocusUniform(b)!.value).toBe(.18);
 }
 materials.releaseFocusMaterials(inside);materials.releaseFocusMaterials(outside);
});
