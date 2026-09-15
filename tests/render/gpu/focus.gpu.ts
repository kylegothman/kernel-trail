import {exerciseOverlap} from './overlap.gpu';
import {Scene,Vector2,Vector3,Matrix4,Quaternion,Color,Mesh,PlaneGeometry} from 'three/webgpu';
import {createBackend,FocusCameraRig,BlendedPerspectiveCamera,holoLabel,getMaterial,disposeMaterials,createLabelPlateMaterial,acquireGlass,releaseGlass} from '../../../src/render';
import {detectCapabilities} from '../../../src/platform/capabilities';
import {PROFILES,type QualityTier} from '../../../src/platform';
import {LAYER} from '../../../src/design';
import {StageBuilder} from '../../../src/world/StageBuilder';
import {SdfAtlas} from '../../../src/world/labels/SdfAtlas';
import {InstancedStructure} from '../../../src/world/structures/base/InstancedStructure';
import {makeSlab,cachedGeometry,GeometryLeases} from '../../../src/world/forms';
import type {WorldContext,StageServices} from '../../../src/world/contracts';
import type {FocusTarget} from '../../../src/render';
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function initialize(){
 const canvas=document.querySelector<HTMLCanvasElement>('#probe')!,force=location.search.includes('webgl');
 const tier=(new URLSearchParams(location.search).get('tier')??'high') as QualityTier;
 assert(tier==='low'||tier==='medium'||tier==='high','Unknown tier');
 const {caps}=await detectCapabilities('wp13-focus',force);
 const sourceLeases=new GeometryLeases(),source=sourceLeases.take(makeSlab());
 const backend=await createBackend(canvas,caps,{profile:PROFILES[tier],antialias:false,samples:4,resources:{geometryFor:()=>source,materialFor:()=>getMaterial('emissive-panel','page_clean',tier)}},force);
 backend.resize(1440,900,1);
 const scene=new Scene(),camera=new BlendedPerspectiveCamera(46,1440/900,.1,2000);camera.position.set(0,0,15);camera.updateMatrixWorld();
 const focus=new FocusCameraRig({scene,camera,aspect:1440/900,viewportHeightPx:900});
 const request={scene,camera,alpha:0,dtSeconds:1/60,elapsedSeconds:0};
 for(let i=0;i<12;i++)backend.renderFrame(request);
 const baseline=backend.stats.geometries;
 const labels=new SdfAtlas(tier,focus,900);
 const context:WorldContext={scene,quality:tier,focus,materials:{holoLabel,getMaterial,createLabelPlateMaterial,acquireGlass,releaseGlass},labels,time:{elapsedSeconds:0,alpha:0},elapsedSeconds:0,tick:0,suppressEffects:false,kernel:{process:()=>undefined,tick:0 as WorldContext['kernel']['tick']}};
 const services:StageServices={createBatch:desc=>backend.createInstancedBatch(desc),postFocus:backend.postChain!.state};
 const target:Omit<FocusTarget,'id'|'anchor'>={planeNormal:new Vector3(0,0,1),planeUp:new Vector3(0,1,0),extents:new Vector2(8,8),padding:.12,focusSet:[],dimOthers:.82,labelPlane:'billboard-to-focus',minGlyphHeight:.1};
 class ProbeStructure extends InstancedStructure {
   private readonly data={colorGain:[.1,.3,.4,1.85] as const,statePhase:[0,0,0,1] as const,patternId:[1,0,0,0] as const};
   constructor(){super('focus-probe',context,target,services,'page_frames',{name:'kt.structures.focus-probe.batch',capacity:400,geometry:'slab',material:'structure',perInstanceColour:true,castShadow:false,layer:LAYER.STRUCTURES});const matrix=new Matrix4();
     for(let i=0;i<400;i++){const slot=this.batch.allocate();matrix.makeScale(.08,.08,.08);matrix.setPosition((i%20-10)*.2,(Math.floor(i/20)-10)*.2,.01);this.batch.move(slot,matrix);this.batch.write(slot,this.data);}
     const geometry=this.shared(cachedGeometry('focus-probe-board',()=>new PlaneGeometry(20,20)));
     const board=new Mesh(geometry,getMaterial('void-surface','ready',tier));board.layers.set(LAYER.STRUCTURES);this.root.add(board);
   }
   update():void{for(let i=0;i<400;i++)this.batch.write(i,this.data);}
 }
 const builder=new StageBuilder(context,services,focus),structure=new ProbeStructure();builder.add(structure);const stage=builder.build();
 const label=await labels.place('FOCUS 012345','running','valueReadout',structure.root,builder.groups.labels,new Vector3(-1,0,1));
 focus.engage('focus-probe');stage.update(.52,0);
 for(let i=0;i<12;i++){stage.update(0,0);backend.renderFrame(request);}
 const read=async()=>{const target=backend.postChain!.budget.targets.get('tonemap_output')!;return new Uint8Array(await backend.deviceRenderer!.readRenderTargetPixelsAsync(target,0,0,target.width,target.height));};
 const difference=(a:Uint8Array,b:Uint8Array)=>{let count=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]!-b[i]!) + Math.abs(a[i+1]!-b[i+1]!) + Math.abs(a[i+2]!-b[i+2]!)>3)count++;return count;};
 const api={
   info(){return {backend:backend.id,baselineGeometries:baseline};},
   async run(){
     const counts:Record<string,number>={Matrix4:0,Vector3:0,Color:0,Quaternion:0};
     Object.assign(globalThis,{__ktAlloc:(name:string)=>{counts[name]=(counts[name]??0)+1;}});
     try{new Matrix4();new Vector3();new Color();new Quaternion();for(const name of Object.keys(counts)){assert(counts[name]===1,'Missing constructor instrumentation '+name);counts[name]=0;}
       for(let i=0;i<300;i++){stage.update(0,0);backend.renderFrame(request);}
     }finally{Object.assign(globalThis,{__ktAlloc:undefined});}
     for(const count of Object.values(counts))assert(count===0,'Per-frame math constructor allocation');
     const capture=(globalThis as {__wp13Capture?:(phase:string)=>Promise<void>}).__wp13Capture;
     const front=await read();await capture?.('front');label.object.visible=false;backend.renderFrame(request);const absent=await read();
     label.object.visible=true;label.object.position.z=-1;label.object.updateMatrix();backend.renderFrame(request);const behind=await read();await capture?.('occluded');
     const frontPixels=difference(front,absent),occludedPixels=difference(behind,absent);
     assert(frontPixels>0,'Front label must contribute visible pixels');assert(occludedPixels===0,'Opaque board must occlude the label after tone mapping');
     label.object.position.z=1;label.object.updateMatrix();backend.renderFrame(request);
     focus.release();const weights:number[]=[];for(let i=0;i<38;i++){stage.update(.01,0);weights.push(focus.state.blend);backend.renderFrame(request);}
     assert(focus.state.mode==='free','Release must finish');for(let i=1;i<weights.length;i++)assert(weights[i]!<=weights[i-1]!,'Release focus strength must never increase');
     await capture?.('released');
     const overlap=await exerciseOverlap(backend.deviceRenderer,camera);
     const beforeDispose=backend.stats.geometries;stage.dispose();sourceLeases.dispose();
     for(let i=0;i<12;i++)backend.renderFrame(request);
     const afterDispose=backend.stats.geometries;assert(afterDispose===baseline,`Geometry leak: baseline ${baseline}, after ${afterDispose}`);
     return {tier,overlap,backend:backend.id,frames:300,instances:400,allocations:counts,frontPixels,occludedPixels,releaseWeights:weights,geometry:{baseline,beforeDispose,afterDispose}};
   },
   dispose(){stage.dispose();sourceLeases.dispose();backend.dispose();disposeMaterials();},
 };
 Object.assign(globalThis,{__kernelTrailProbe:{status:'ready',api}});
}
Object.assign(globalThis,{__kernelTrailProbe:{status:'booting'}});
void initialize().catch((cause:unknown)=>{const error=cause instanceof Error?cause:new Error(String(cause));Object.assign(globalThis,{__kernelTrailProbe:{status:'failed',error:{message:error.message,stack:error.stack||error.message}}});console.error(error.stack||error.message);throw error;});
