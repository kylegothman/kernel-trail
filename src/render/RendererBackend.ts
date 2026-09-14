import { InstancedBufferAttribute, StorageInstancedBufferAttribute, InstancedMesh, DynamicDrawUsage, WebGPURenderer, BoxGeometry, CylinderGeometry, PlaneGeometry, TorusGeometry, NoToneMapping } from 'three/webgpu';
import type { BufferGeometry, Camera, Material, Object3D, Scene } from 'three/webgpu';
import { type Capabilities, type RenderQualityProfile } from '@platform';
import { FORM, SEMANTICS, DASH, HATCH_ID, linearColor, gainFor } from '@design';
import { getMaterial,createInstanceMaterial,type TrailMaterial } from './materials';
import { PostChain } from './postChain';
import { DrawCallBudget } from './DrawCallBudget';
export type BatchChannel='matrix'|'colour'|'state'|'colorGain'|'statePhase'|'patternId'|'all';
export type BackendId = 'webgpu' | 'webgl2';

/* ------------------------------------------------------------------------- */
/* The interface (01-ARCHITECTURE 5.3)                                        */
/* ------------------------------------------------------------------------- */

export interface FrameRequest {
  readonly scene: Scene;
  readonly camera: Camera;
  /** Interpolation alpha, forwarded to time-dependent uniforms. */
  readonly alpha: number;
  /** Seconds since the previous frame, already clamped by the loop. */
  readonly dtSeconds: number;
  /** Wall seconds since boot. Drives all ambient shader animation. */
  readonly elapsedSeconds: number;
}

export interface RenderStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly programs: number;
  readonly textures: number;
  readonly geometries: number;
  /** GPU milliseconds, when timestamp queries are available; otherwise null. */
  readonly gpuMs: number | null;
  readonly targetMemoryBytes: number;
}

export type BatchGeometryId = 'slab' | 'chit' | 'sector' | 'beam' | 'mote' | 'ring';
export type BatchMaterialId = 'structure' | 'queue' | 'sector' | 'beam' | 'particle';

export interface InstancedBatchDesc {
  readonly name: string;
  readonly capacity: number;
  readonly geometry: BatchGeometryId;
  readonly material: BatchMaterialId;
  /** Whether per-instance colour is written. Skipped for single-hue batches. */
  readonly perInstanceColour: boolean;
  /** Shadows are off everywhere (12.4); this exists so the assertion has a field to read. */
  readonly castShadow: boolean;
  readonly layer: number;
}

export interface InstancedBatchHandle {
  readonly name: string;
  readonly capacity: number;
  /** Number of instances currently drawn. Set every frame. */
  count: number;
  /** 16 floats per instance. Written directly; no Matrix4 allocation. */
  readonly matrices: Float32Array;
  /** 3 floats per instance, linear-space rgb. */
  readonly colours: Float32Array;
  /** 4 floats per instance: [stateEnum, phase01, intensity, ownerHue]. */
  readonly state: Float32Array;
  /** The drawable. Added to the scene by the world layer, never by the backend. */
  readonly object: Object3D;
  /** Mark a contiguous instance range dirty. Coalesced into one upload per frame. */
  readonly colorGain: Float32Array;
  readonly statePhase: Float32Array;
  readonly patternId: Float32Array;
  touch(from: number, to: number, channel?: BatchChannel): void;
  dispose(): void;
}

/** Optional geometry/material injection for downstream stage-owned resources. */
export interface BatchResources {
  geometryFor(id: BatchGeometryId): BufferGeometry;
  materialFor(id: BatchMaterialId, profile: RenderQualityProfile): Material;
  dispose?():void;
}

export interface BackendInitOptions {
  readonly forceWebGL: boolean;
  readonly antialias: boolean;
  readonly samples: 1 | 2 | 4;
  readonly profile: RenderQualityProfile;
  readonly resources?: BatchResources;
}

export interface DeviceLostInfo {
  readonly reason: string;
}

export interface RendererBackend {
  readonly id: BackendId;
  readonly capabilities: Capabilities;
  readonly stats: RenderStats;
  readonly domElement: HTMLCanvasElement;

  init(canvas: HTMLCanvasElement, opts: BackendInitOptions): Promise<void>;
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  setQuality(profile: RenderQualityProfile): void;
  createInstancedBatch(desc: InstancedBatchDesc): InstancedBatchHandle;

  /** Renders the scene plus the whole post chain into the canvas. */
  renderFrame(req: FrameRequest): void;

  /** Precompile materials for a scene before it becomes visible. */
  compileAsync(scene: Scene, camera: Camera): Promise<void>;

  onDeviceLost(cb: (info: DeviceLostInfo) => void): () => void;
  dispose(): void;
}

export const STRATEGY_GROUPS=['msaa','particleIntegration','volumetricCeiling','gpuTimer','hdrFormat','instanceStorage','depthPrepass'] as const;
export function strategies(c:Capabilities,p:RenderQualityProfile) {
  return { msaa:c.backend==='webgpu'?(p.msaaSamples>0?4:0):Math.min(p.msaaSamples,c.maxSamples),
    particleIntegration:c.compute?'compute':'vertex-ping-pong',volumetricCeiling:c.backend==='webgpu'?48:24,
    gpuTimer:c.timestampQuery,hdrFormat:c.hdr?'rgba16float':'rgba8unorm',
    instanceStorage:c.storageBuffers?'storage':'attributes',depthPrepass:c.backend==='webgpu'?p.tier!=='low':p.tier==='high' } as const;
}
export class ThreeUnifiedBackend implements RendererBackend {
  private renderer:WebGPURenderer|null=null;
  private profile:RenderQualityProfile|null=null;
  private resources:BatchResources|null=null;
  private readonly batches=new Set<ManagedBatch>();
  private readonly listeners=new Set<(info:DeviceLostInfo)=>void>();
  private readonly budget:DrawCallBudget;
  private lossReported=false;
  private canvas:HTMLCanvasElement|null=null;
  private width=1;private height=1;private pixelRatio=1;
  private gpuMs:number|null=null;
  private post:PostChain|null=null;
  private runtimeId:BackendId;
  private readonly mutableStats={drawCalls:0,triangles:0,programs:0,textures:0,geometries:0,gpuMs:null as number|null,targetMemoryBytes:0};
  private readonly contextLost=(event:Event):void=>{event.preventDefault();this.announceLoss('webglcontextlost');};
  constructor(readonly capabilities:Capabilities){this.runtimeId=capabilities.backend;this.budget=new DrawCallBudget('high');}
  get id():BackendId{return this.runtimeId;}
  get domElement():HTMLCanvasElement {if(!this.canvas)throw new Error('Backend not initialized');return this.canvas;}
  get postChain():PostChain|null{return this.post;}
  get deviceRenderer():WebGPURenderer {if(!this.renderer)throw new Error('Backend not initialized');return this.renderer;}
  async init(canvas:HTMLCanvasElement,opts:BackendInitOptions):Promise<void> {
    this.canvas=canvas;this.profile=opts.profile;this.resources=opts.resources??createDefaultResources();this.lossReported=false;
    const r=new WebGPURenderer({canvas,forceWebGL:opts.forceWebGL,antialias:false,alpha:false,powerPreference:'high-performance',trackTimestamp:this.capabilities.timestampQuery});
    r.shadowMap.enabled=false;r.toneMapping=NoToneMapping;r.toneMappingExposure=1;
    r.onDeviceLost=info=>this.announceLoss(info.reason??info.message);
    await r.init();this.renderer=r;r.info.autoReset=false;
    this.runtimeId='isWebGPUBackend' in r.backend && r.backend.isWebGPUBackend===true?'webgpu':'webgl2';
    canvas.addEventListener('webglcontextlost',this.contextLost);
    this.budget.setTier(opts.profile.tier);
  }
  resize(width:number,height:number,pixelRatio:number):void {
    this.width=width;this.height=height;this.pixelRatio=pixelRatio;
    this.post?.resize(width,height,pixelRatio);
  }
  setQuality(profile:RenderQualityProfile):void {
    this.profile=profile;this.budget.setTier(profile.tier);for(const b of this.batches)b.clamp(profile);
    this.post?.setTier(profile.tier,profile);
  }
  createInstancedBatch(desc:InstancedBatchDesc):InstancedBatchHandle {
    if(!this.resources||!this.profile)throw new Error('Backend not initialized');
    if(desc.castShadow)throw new Error('Shadows are forbidden');
    const b=new ManagedBatch(desc,this.resources.geometryFor(desc.geometry),this.resources.materialFor(desc.material,this.profile),()=>this.batches.delete(b),this.capabilities.storageBuffers);
    b.clamp(this.profile);this.batches.add(b);return b;
  }
  renderFrame(req:FrameRequest):void {
    const r=this.renderer,p=this.profile;if(!r||!p)return;
    if(!this.post) {
      const effective={...this.capabilities,backend:this.id};
      this.post=new PostChain({renderer:r,scene:req.scene,camera:req.camera,tier:p.tier,profile:p,capabilities:effective});
      this.post.resize(this.width,this.height,this.pixelRatio);
    }
    this.post.setScene(req.scene,req.camera);
    for(const b of this.batches)b.flush();
    r.info.reset();this.post.render(req.elapsedSeconds);
    this.budget.sample(r.info.render.drawCalls,r.info.render.triangles);
  }
  get stats():RenderStats {
    const r=this.renderer,s=this.mutableStats;if(!r)return s;
    s.programs=r.info.memory.programs;s.drawCalls=r.info.render.drawCalls;s.triangles=r.info.render.triangles;s.geometries=r.info.memory.geometries;s.textures=r.info.memory.textures;
    s.gpuMs=this.id==='webgpu'?this.gpuMs:null;s.targetMemoryBytes=this.post?.budget.totalBytes??0;return s;
  }
  async sampleGpuTime():Promise<number|null> {
    if(!this.renderer||this.id!=='webgpu'||!this.capabilities.timestampQuery)return null;
    await this.renderer.resolveTimestampsAsync('render');this.gpuMs=this.renderer.info.render.timestamp;return this.gpuMs;
  }
  async compileAsync(scene:Scene,camera:Camera):Promise<void>{await this.renderer?.compileAsync(scene,camera);}
  onDeviceLost(cb:(info:DeviceLostInfo)=>void):()=>void {this.listeners.add(cb);return ()=>this.listeners.delete(cb);}
  private announceLoss(reason:string):void {if(this.lossReported||reason==='destroyed')return;this.lossReported=true;for(const cb of this.listeners)cb({reason});}
  dispose():void {
    for(const b of this.batches)b.dispose();this.batches.clear();this.post?.dispose();this.post=null;
    this.canvas?.removeEventListener('webglcontextlost',this.contextLost);this.renderer?.dispose();this.renderer=null;this.listeners.clear();this.resources?.dispose?.();this.resources=null;
  }
}
export const MATRIX_STRIDE=16;
const BATCH_CHANNELS:readonly BatchChannel[]=['matrix','colour','state','colorGain','statePhase','patternId'];
export class ManagedBatch implements InstancedBatchHandle {
  readonly name:string;readonly capacity:number;readonly object:InstancedMesh;
  readonly matrices:Float32Array;readonly colours:Float32Array;readonly state:Float32Array;
  readonly colorGain:Float32Array;readonly statePhase:Float32Array;readonly patternId:Float32Array;
  private readonly attrs:readonly InstancedBufferAttribute[];
  private readonly dirty=new Int32Array(12).fill(-1);
  private requested=0;private ceiling:number;
  private ownsMaterial=false;
  constructor(private readonly desc:InstancedBatchDesc,geometry:BufferGeometry,material:Material,private readonly release:()=>void,storageBuffers=false) {
    this.name=desc.name;this.capacity=desc.capacity;this.ceiling=desc.capacity;
    // Each batch owns attribute storage; cached base geometry never receives per-batch attributes.
    this.object=new InstancedMesh(geometry.clone(),material,desc.capacity);this.object.name=desc.name;
    this.object.layers.set(desc.layer);this.object.castShadow=false;this.object.receiveShadow=false;this.object.frustumCulled=false;this.object.matrixAutoUpdate=false;
    this.object.count=0;this.object.instanceMatrix.setUsage(DynamicDrawUsage);
    this.matrices=this.object.instanceMatrix.array as Float32Array;
    this.colours=new Float32Array(desc.capacity*3);this.state=new Float32Array(desc.capacity*4);
    this.colorGain=new Float32Array(desc.capacity*4);this.statePhase=new Float32Array(desc.capacity*4);this.patternId=new Float32Array(desc.capacity*4);
    const t=SEMANTICS.page_clean,c=linearColor(t.hex);
    for(let i=0;i<desc.capacity;i++) {this.colours.set([c.r,c.g,c.b],i*3);this.colorGain.set([c.r,c.g,c.b,gainFor(t.family,t.level)],i*4);this.state.set([0,0,gainFor(t.family,t.level),0],i*4);this.statePhase.set([0,0,0,1],i*4);this.patternId.set([DASH[t.dash].on,DASH[t.dash].off,HATCH_ID[t.hatch],i],i*4);}
    if(storageBuffers&&'isNodeMaterial' in material&&material.isNodeMaterial===true){
      const attrs=[new StorageInstancedBufferAttribute(this.colorGain,4),new StorageInstancedBufferAttribute(this.statePhase,4),new StorageInstancedBufferAttribute(this.patternId,4)];
      this.attrs=attrs;this.object.material=createInstanceMaterial(material as TrailMaterial,attrs);this.ownsMaterial=true;
    } else this.attrs=[new InstancedBufferAttribute(this.colorGain,4),new InstancedBufferAttribute(this.statePhase,4),new InstancedBufferAttribute(this.patternId,4)];
    ['aColorGain','aStatePhase','aPatternId'].forEach((name,i)=>{const attr=this.attrs[i];if(attr){attr.setUsage(DynamicDrawUsage);this.object.geometry.setAttribute(name,attr);}});
  }
  get count():number{return this.object.count;}
  set count(n:number){if(!Number.isInteger(n)||n<0)throw new Error('Invalid instance count');this.requested=n;this.object.count=Math.min(n,this.ceiling,this.capacity);}
  touch(from:number,to:number,channel:BatchChannel='all'):void {
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to>this.capacity||to<from)throw new Error('Invalid dirty range');
    for(let i=0;i<BATCH_CHANNELS.length;i++)if(channel==='all'||channel===BATCH_CHANNELS[i]) {
      const a=this.dirty[i*2]??-1;this.dirty[i*2]=a<0?from:Math.min(a,from);this.dirty[i*2+1]=Math.max(this.dirty[i*2+1]??-1,to);
    }
  }
  flush():void {
    this.object.instanceMatrix.clearUpdateRanges();
    for(const attr of this.attrs)attr.clearUpdateRanges();
    for(let channel=0;channel<6;channel++) {
      const from=this.dirty[channel*2]??-1,to=this.dirty[channel*2+1]??-1;if(from<0)continue;
      if(channel===1)for(let i=from;i<to;i++)for(let j=0;j<3;j++)this.colorGain[i*4+j]=this.colours[i*3+j]??0;
      if(channel===2)for(let i=from;i<to;i++){this.statePhase[i*4]=this.state[i*4]??0;this.statePhase[i*4+1]=this.state[i*4+1]??0;this.colorGain[i*4+3]=this.state[i*4+2]??0;}
      const attr=channel===0?this.object.instanceMatrix:channel===1||channel===3?this.attrs[0]:channel===2||channel===4?this.attrs[1]:this.attrs[2];
      if(attr){attr.addUpdateRange(from*attr.itemSize,(to-from)*attr.itemSize);attr.needsUpdate=true;}
      if(channel===2){const color=this.attrs[0];if(color){color.addUpdateRange(from*4,(to-from)*4);color.needsUpdate=true;}}
      this.dirty[channel*2]=-1;this.dirty[channel*2+1]=-1;
    }
  }
  clamp(p:RenderQualityProfile):void {
    const g=this.desc.geometry;
    this.ceiling=g==='slab'?p.maxInstances.page_frames:g==='chit'?p.maxInstances.queue_entries:g==='sector'?p.maxInstances.disk_sectors:g==='beam'?p.concurrentBeams:g==='ring'?p.maxInstances.domain_rings:p.maxParticles;
    this.object.count=Math.min(this.requested,this.ceiling,this.capacity);
  }
  dispose():void{if(this.ownsMaterial){const m=this.object.material;if(!Array.isArray(m))m.dispose();}this.object.dispose();this.object.geometry.dispose();this.object.removeFromParent();this.release();}
}
function createDefaultResources():BatchResources {
const geometries=new Map<BatchGeometryId,BufferGeometry>();
return {
  geometryFor(id){
    const hit=geometries.get(id);if(hit)return hit;
    const g=id==='slab'?new BoxGeometry(FORM.pagePlate.x,FORM.pagePlate.thickness,FORM.pagePlate.z):id==='beam'?new CylinderGeometry(1,1,1,6,1,true):id==='ring'?new TorusGeometry(FORM.resourceRing.outerRadius,FORM.resourceRing.tube,6,16):new PlaneGeometry(1,1);
    geometries.set(id,g);return g;
  },
  materialFor(id,p){return getMaterial(id==='beam'||id==='particle'?'volumetric-beam':'emissive-panel','page_clean',p.tier);},
  dispose(){for(const geometry of geometries.values())geometry.dispose();geometries.clear();},
};
}
export async function createBackend(canvas:HTMLCanvasElement,caps:Capabilities,opts:Omit<BackendInitOptions,'forceWebGL'>,forceWebGLOverride?:boolean):Promise<RendererBackend> {
  const backend=new ThreeUnifiedBackend(caps);await backend.init(canvas,{...opts,forceWebGL:forceWebGLOverride??caps.backend==='webgl2'});return backend;
}
export { DeviceLossPolicy } from './backend/DeviceLossPolicy';
