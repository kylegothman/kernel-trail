import {it,expect} from 'vitest';
import {HalfFloatType,FloatType} from 'three/webgpu';
import {GPU_STAGE_IDS,stagesForTier,createPostFrameState,resolveBloom,resolveVignette,assertChainOrder} from '../../src/render/postChain';
import {PROFILES,type RenderCapabilities} from '../../src/platform';
import {RenderTargetBudget,planTargets,specsFor} from '../../src/render/targets';
import {BAYER,EXPOSURE} from '../../src/render/post/toneMap';
import {DOWN_TAPS,UP_TAPS} from '../../src/render/post/kawase';
import {REDUCED_BLOOM} from '../../src/design';
const caps:RenderCapabilities={backend:'webgpu',compute:true,storageBuffers:true,maxSamples:4,float32Filterable:true,float16Renderable:true,hdr:true,maxTextureSize:8192,maxInstances:1000000,timestampQuery:true,deviceMemoryGb:8,hardwareConcurrency:8,adapterLabel:'test',isIntegrated:true,prefersReducedMotion:false,devicePixelRatio:2};
it('pass order high: thirteen GPU stages, no DOM draw',()=>{expect(stagesForTier('high').map(s=>s.id)).toEqual(GPU_STAGE_IDS);expect(GPU_STAGE_IDS).toHaveLength(13);expect(()=>assertChainOrder()).not.toThrow();});
it('medium removes DOF and scattering; SMAA after tone mapping before text',()=>{const ids=stagesForTier('medium').map(s=>s.id);expect(ids).not.toContain('depth_of_field');expect(ids).not.toContain('volumetric_scatter');expect(ids.slice(-3)).toEqual(['tonemap_output','smaa','scene_text']);});
it('low: four quarter-resolution bloom levels',()=>expect(PROFILES.low).toMatchObject({bloomLevels:4,bloomScale:0.25,antialiasing:'none'}));
for(const tier of ['low','medium','high'] as const)it(`half-float colour intermediates ${tier}`,()=>{const b=new RenderTargetBudget(),plan=planTargets(1440,900,1,PROFILES[tier],caps);for(const s of specsFor(PROFILES[tier],plan.samples)){const t=b.allocate(s,plan);if(s.format==='hdr')expect(t.texture.type).toBe(HalfFloatType);if(s.format==='depth')expect(t.texture.type).toBe(FloatType);}b.dispose();});
it('normal bloom, panic and accessibility exceptions',()=>{const state=createPostFrameState();for(const p of Object.values(PROFILES)){expect(resolveBloom(p,state,null)).toMatchObject({threshold:1.15,strength:0.055,knee:0.55});expect(resolveBloom(p,state,REDUCED_BLOOM)).toMatchObject({threshold:1.6,strength:0.0275});}state.panic=1;expect(resolveBloom(PROFILES.high,state,null)).toMatchObject({threshold:0.35,strength:0.22});expect(resolveVignette(state).strength).toBeCloseTo(0.34*1.3);});
it('five down taps, eight up taps, ordered Bayer permutation and fixed exposure',()=>{expect([DOWN_TAPS,UP_TAPS]).toEqual([5,8]);expect([...BAYER].sort((a,b)=>a-b)).toEqual(Array.from({length:64},(_,i)=>i));expect(EXPOSURE).toBe(1);});

it('projection-depth reconstruction supports the camera blend instead of assuming perspective',async()=>{
 const {projectionDepthValue}=await import('../../src/render/shaders/depth');
 const {Matrix4,Vector3,WebGPUCoordinateSystem}=await import('three/webgpu');
 const perspective=new Matrix4().makePerspective(-.1,.1,.1,-.1,.1,2000,WebGPUCoordinateSystem);
 const ortho=new Matrix4().makeOrthographic(-10,10,10,-10,.1,2000,WebGPUCoordinateSystem),blend=new Matrix4(),point=new Vector3();
 for(let step=0;step<=100;step++)for(const distance of [.2,5,100,1999]){for(let i=0;i<16;i++)blend.elements[i]=perspective.elements[i]!+(ortho.elements[i]!-perspective.elements[i]!)*step/100;
  point.set(0,0,-distance).applyMatrix4(blend);expect(projectionDepthValue(point.z,blend.elements,false)).toBeCloseTo(distance,5);
 }
});
