import { RenderPipeline, DepthTexture, NoToneMapping, SRGBColorSpace, Vector2, Vector3, UnsignedByteType } from 'three/webgpu';
import type { Camera, Scene, WebGPURenderer, RenderTarget, Node } from 'three/webgpu';
import { texture, uniform, uv, vec3, vec4, mix, float, reinhardToneMapping } from 'three/tsl';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { BLOOM, BLOOM_TINT, PANIC_POST, VIGNETTE, REDUCED_BLOOM, LAYER, AMBER, VOID, linearColor } from '@design';
import { PROFILES, type QualityTier, type RenderQualityProfile, type RenderCapabilities } from '@platform';
import { RenderTargetBudget, planTargets, specsFor, bytesFor, type TargetPlan } from './targets';
import { materialPanic, materialTime, beamSceneDepth, textSceneDepth, floorReflection, reflectionView, textFade, createDepthPrepassMaterial } from './materials';
import { brightPass } from './post/brightPass';
import { kawaseDown, kawaseUp } from './post/kawase';
import { toneMap, createBayerTexture } from './post/toneMap';
import { chromatic, grain, vignette } from './post/composite';
import {encodeDepth,depthPacked,depthFar} from './shaders/depth';
import { depthOfField } from './post/depthOfField';
import { volumetric } from './post/volumetric';
export const GPU_STAGE_IDS=['scene_world','depth_resolve','depth_of_field','bright_pass','bloom_down','bloom_up','volumetric_scatter','composite','chromatic_aberration','film_grain','vignette','tonemap_output','scene_text'] as const;
export type PostStageId=typeof GPU_STAGE_IDS[number] | 'smaa';
export const POST_CHAIN=GPU_STAGE_IDS.map((id,index)=>({id,order:index+1,tiers: id==='depth_of_field'||id==='volumetric_scatter'?['high']:id==='chromatic_aberration'?['medium','high']:['low','medium','high']}));
export function stagesForTier(tier: QualityTier): readonly {id: PostStageId; order: number}[] {
  const result: {id: PostStageId;order:number}[]=POST_CHAIN.filter(s=>s.tiers.includes(tier));
  if(tier==='medium') result.splice(result.length-1,0,{id:'smaa',order:12.5});return result;
}
export function assertChainOrder(): void {
  for(const tier of ['low','medium','high'] as const) {
    const ids=stagesForTier(tier).map(s=>s.id);
    if(ids.indexOf('bright_pass')>ids.indexOf('tonemap_output')||ids.indexOf('tonemap_output')>ids.indexOf('scene_text')) throw new Error('Invalid post order');
  }
}
export const POST_TIER_CONFIG=PROFILES;
export interface PostFrameState { elapsedSeconds:number;focusBlend:number;focusDistanceM:number;panic:number;fade:number;readonly exposure:1 }
export function createPostFrameState(): PostFrameState {return {elapsedSeconds:0,focusBlend:0,focusDistanceM:0,panic:0,fade:1,exposure:1};}
export function resolveBloom(profile: RenderQualityProfile,state:PostFrameState,reduced: typeof REDUCED_BLOOM|null) {
  return {threshold:state.panic?PANIC_POST.threshold:reduced?.threshold??BLOOM.threshold,
    strength:state.panic?PANIC_POST.strength:BLOOM.strength*(reduced?.strengthScale??1),knee:BLOOM.knee,levels:profile.bloomLevels};
}
export function resolveVignette(state:PostFrameState) {
  return {strength:(VIGNETTE.strength+(VIGNETTE.lockedStrength-VIGNETTE.strength)*state.focusBlend)*(1+state.panic*PANIC_POST.vignetteContraction),
    power:VIGNETTE.power+(VIGNETTE.lockedPower-VIGNETTE.power)*state.focusBlend};
}
export interface PostChainOptions { readonly renderer:WebGPURenderer;readonly scene:Scene;readonly camera:Camera;readonly tier:QualityTier;readonly profile:RenderQualityProfile;readonly capabilities:RenderCapabilities;readonly debug?:boolean;readonly onPanic?:(message:string)=>void }
interface Operation { readonly name:string;readonly execute:()=>void;readonly pipeline?:RenderPipeline }
export class PostChain {
  readonly state=createPostFrameState();
  readonly budget=new RenderTargetBudget();
  private readonly bayer=createBayerTexture();
  private readonly clock=uniform(0);
  private readonly threshold=uniform(BLOOM.threshold as number);
  private readonly strength=uniform(BLOOM.strength as number);
  private readonly focus=uniform(0);
  private readonly focusBlend=uniform(0);
  private readonly vignetteStrength=uniform(VIGNETTE.strength as number);
  private readonly vignettePower=uniform(VIGNETTE.power as number);
  private readonly fade=uniform(1);
  private readonly panicAmount=uniform(0);
  private readonly near=uniform(0.1);
  private readonly far=uniform(2000);
  readonly source=uniform(new Vector2(0.5,0.5));
  readonly sourceVisible=uniform(0);
  private operations:Operation[]=[];
  private readonly ownedNodes: {dispose():void}[]=[];
  private plan:TargetPlan|null=null;
  private scene:Scene;
  private camera:Camera;
  private profile:RenderQualityProfile;
  private panicStart:number|null=null;
  private reduced=false;
  private disposed=false;
  private width=1;private height=1;private dpr=1;
  constructor(private readonly options:PostChainOptions) {
    this.scene=options.scene;this.camera=options.camera;this.profile=options.profile;
    options.renderer.toneMapping=NoToneMapping;options.renderer.toneMappingExposure=1;options.renderer.shadowMap.enabled=false;
  }
  get tierConfig():RenderQualityProfile{return this.profile;}
  get qualityProfile():RenderQualityProfile{return this.profile;}
  get targetPlan():TargetPlan|null{return this.plan;}
  get passList(){return stagesForTier(this.profile.tier);}
  get physicalPasses():readonly string[]{return this.operations.map(op=>op.name);}
  setScene(scene:Scene,camera:Camera):void{this.scene=scene;this.camera=camera;}
  setTier(tier:QualityTier,profile=PROFILES[tier]):void{if(this.profile===profile)return;this.profile=profile;this.resize(this.width,this.height,this.dpr);}
  setReducedBloom(value:boolean):void{this.reduced=value;}
  panic(message:string):void{this.panicStart=this.state.elapsedSeconds;this.options.onPanic?.(message);this.updatePanic(0);}
  updatePanic(ms:number):boolean {
    this.state.panic=1;this.state.fade=ms<=PANIC_POST.floodMs?1:Math.max(0,1-(ms-PANIC_POST.floodMs)/PANIC_POST.cutMs);
    return ms<PANIC_POST.floodMs+PANIC_POST.cutMs;
  }
  resize(width:number,height:number,dpr:number):void {
    this.width=width;this.height=height;this.dpr=dpr;
    const plan=planTargets(width,height,dpr,this.profile,this.options.capabilities,this.options.debug??false);
    this.clearGraph();this.plan=plan;
    const r=this.options.renderer;r.setPixelRatio(1);r.setSize(plan.width,plan.height,false);
    const specs=specsFor(this.profile,plan.samples,this.options.debug??false);
    for(const spec of specs) {
      if(spec.name.startsWith('smaa_')) this.budget.reserve(bytesFor(spec,plan.width,plan.height,this.options.capabilities.hdr));
      else this.budget.allocate(spec,plan);
    }
    this.buildGraph(plan);
  }
  private target(name:string):RenderTarget {const t=this.budget.targets.get(name);if(!t)throw new Error(`Missing target ${name}`);return t;}
  private add(name:string,target:RenderTarget|null,node:Node):void {
    const pipeline=new RenderPipeline(this.options.renderer,node);pipeline.outputColorTransform=false;
    this.operations.push({name,pipeline,execute:()=>{this.options.renderer.setRenderTarget(target);pipeline.render();}});
  }
  private buildGraph(plan:TargetPlan):void {
    const r=this.options.renderer,p=this.profile,world=this.target('scene_world');
    world.depthTexture=new DepthTexture(plan.width,plan.height);
    if(p.floorReflection==='planar-rt'){
      const reflected=this.camera.clone(),direction=new Vector3(),position=new Vector3(),up=new Vector3();
      const target=this.target('reflection');floorReflection.value=target.texture;
      const reflectionFilter:Parameters<WebGPURenderer['setRenderObjectFunction']>[0]=(object,scene,camera,geometry,material,group,lights,clipping)=>{
        if(object.userData['castsReflection']===true)r.renderObject(object,scene,camera,geometry,material,group,lights,clipping);
      };
      this.operations.push({name:'scene_world.reflection',execute:()=>{
        this.camera.getWorldPosition(position);this.camera.getWorldDirection(direction);
        direction.add(position);direction.y=-direction.y;position.y=-position.y;
        reflected.position.copy(position);up.copy(this.camera.up);up.y=-up.y;reflected.up.copy(up);
        reflected.lookAt(direction);reflected.updateMatrixWorld();reflected.projectionMatrix.copy(this.camera.projectionMatrix);
        reflected.coordinateSystem=this.camera.coordinateSystem;reflected.layers.mask=LAYER.WORLD;
        const previous=r.getRenderObjectFunction();
        r.setRenderObjectFunction(reflectionFilter);
        reflectionView.value=1;r.setRenderTarget(target);r.autoClear=true;r.setClearColor(linearColor(VOID.base),1);
        try{r.render(this.scene,reflected);}finally{reflectionView.value=0;r.setRenderObjectFunction(previous);}
      }});
    }
    const usePrepass=this.options.capabilities.backend==='webgpu'?p.tier!=='low':p.tier==='high';
    const depthMaterial=usePrepass?createDepthPrepassMaterial():null;
    if(depthMaterial)this.ownedNodes.push(depthMaterial);
    const depthFilter:Parameters<WebGPURenderer['setRenderObjectFunction']>[0]=(object,scene,camera,geometry,material,group,lights,clipping)=>{
      if(depthMaterial&&!material.transparent)r.renderObject(object,scene,camera,geometry,depthMaterial,group,lights,clipping);
    };
    this.operations.push({name:'scene_world',execute:()=>{
      const mask=this.camera.layers.mask;this.camera.layers.mask=(LAYER.WORLD & ~(1<<LAYER.BEAMS) & ~(1<<LAYER.EFFECTS))|(1<<LAYER.LIGHTS);
      r.setRenderTarget(world);r.setClearColor(linearColor(VOID.base),1);r.autoClear=true;
      if(depthMaterial){
        const previous=r.getRenderObjectFunction();
        r.setRenderObjectFunction(depthFilter);
        try{r.render(this.scene,this.camera);}finally{r.setRenderObjectFunction(previous);}
        r.autoClear=false;
      }
      r.render(this.scene,this.camera);r.autoClear=true;this.camera.layers.mask=mask;
    }});
    const depth=this.target('depth_resolve');
    const d=texture(world.depthTexture,uv()).r;
    const z=this.near.mul(this.far).div(this.far.sub(d.mul(this.far.sub(this.near))));
    const beamDepth=this.target('beam_depth');
    beamSceneDepth.value=beamDepth.texture;textSceneDepth.value=depth.texture;
    this.add('scene_world.beam_depth',beamDepth,encodeDepth(z,this.far,this.options.capabilities.hdr));
    this.operations.push({name:'scene_world.effects',execute:()=>{
      const mask=this.camera.layers.mask;this.camera.layers.mask=(1<<LAYER.BEAMS)|(1<<LAYER.EFFECTS)|(1<<LAYER.LIGHTS);
      r.setRenderTarget(world);r.autoClear=false;r.render(this.scene,this.camera);r.autoClear=true;this.camera.layers.mask=mask;
    }});
    this.add('depth_resolve',depth,encodeDepth(z,this.far,this.options.capabilities.hdr));
    let scene=world;
    if(p.depthOfField) {const target=this.target('depth_of_field');this.add('depth_of_field',target,vec4(mix(texture(world.texture,uv()).rgb,depthOfField(world.texture,depth.texture,this.focus,plan.width,plan.height),this.focusBlend),1));scene=target;}
    const bright=this.target('bright_pass');
    let base=texture(scene.texture,uv()).rgb;
    if(!this.options.capabilities.hdr)base=reinhardToneMapping(base,float(1)) as Node<'vec3'>;
    this.add('bright_pass',bright,vec4(brightPass(base,this.threshold,BLOOM.knee).min(BLOOM.clamp),1));
    let previous=bright;
    for(let i=0;i<p.bloomLevels;i++) {
      const target=this.target(`down${i}`);
      this.add(`bloom_down.${i}`,target,vec4(kawaseDown(previous.texture,uv(),uniform(new Vector2(0.5/previous.width,0.5/previous.height))),1));previous=target;
    }
    const totalWeight=BLOOM.weights.slice(0,p.bloomLevels).reduce((a,b)=>a+b,0);
    let wider:RenderTarget|null=null;
    for(let i=p.bloomLevels-1;i>=0;i--) {
      const down=this.target(`down${i}`),target=this.target(`up${i}`);
      const tint=p.bloomTintPerLevel?BLOOM_TINT[i]??[1,1,1]:[1,1,1];
      let c=texture(down.texture,uv()).rgb.mul(vec3(tint[0]??1,tint[1]??1,tint[2]??1)).mul((BLOOM.weights[i]??0)/totalWeight);
      if(wider)c=c.add(kawaseUp(wider.texture,uv(),uniform(new Vector2(0.5/wider.width,0.5/wider.height))));
      this.add(`bloom_up.${i}`,target,vec4(c,1));wider=target;
    }
    let scatter:Node<'vec3'>=vec3(0);
    if(p.volumetricScattering){const target=this.target('volumetric_scatter');this.add('volumetric_scatter',target,vec4(volumetric(bright.texture,this.source,this.sourceVisible,this.options.capabilities.backend==='webgpu'?48:24),1));scatter=texture(target.texture,uv()).rgb;}
    const composite=this.target('composite');
    const bloom=texture(this.target('up0').texture,uv()).rgb;
    const tinted=mix(bloom,uniform(linearColor(AMBER.white)).mul(bloom.dot(vec3(0.2126,0.7152,0.0722))),this.panicAmount);
    this.add('composite',composite,vec4(texture(scene.texture,uv()).rgb.add(tinted.mul(this.strength)).add(scatter),1));
    let c:Node<'vec3'>=chromatic(composite.texture,p.aberrationMaxPx,plan.width,plan.height);
    if(this.options.debug){const t=this.target('chromatic_aberration');this.add('chromatic_aberration',t,vec4(c,1));c=texture(t.texture,uv()).rgb;}
    c=grain(c,this.clock,p.grainAmplitude);
    if(this.options.debug){const t=this.target('film_grain');this.add('film_grain',t,vec4(c,1));c=texture(t.texture,uv()).rgb;}
    c=vignette(c,this.vignetteStrength,this.vignettePower);
    if(this.options.debug){const t=this.target('vignette');this.add('vignette',t,vec4(c,1));c=texture(t.texture,uv()).rgb;}
    const output=this.target('tonemap_output');
    this.add(this.options.debug?'tonemap_output':'lens_output',output,vec4(toneMap(c,this.bayer).mul(this.fade),1));
    if(p.antialiasing==='smaa') {
      const aa=smaa(texture(output.texture));this.ownedNodes.push(aa);
      if(!this.options.capabilities.hdr){
        // r185 SMAANode owns these three private targets (audited in the pinned source).
        const targets=aa as unknown as {_renderTargetEdges:RenderTarget;_renderTargetWeights:RenderTarget;_renderTargetBlend:RenderTarget};
        for(const target of [targets._renderTargetEdges,targets._renderTargetWeights,targets._renderTargetBlend])target.texture.type=UnsignedByteType;
      }
      // The SMAA node keeps its own output; copy into the final target before text.
      this.add('smaa',composite,aa);
      this.add('smaa_output',output,texture(composite.texture));
    }
    // Text tests the resolved world depth in its fragment node. Sharing an MSAA
    // depth attachment with a single-sample output target is invalid on WebGPU.
    this.operations.push({name:'scene_text',execute:()=>{
      const mask=this.camera.layers.mask;this.camera.layers.set(LAYER.TEXT);
      r.setRenderTarget(output);r.autoClear=false;r.outputColorSpace=SRGBColorSpace;r.render(this.scene,this.camera);r.autoClear=true;this.camera.layers.mask=mask;
    }});
    this.add('present',null,texture(output.texture));
  }
  private update(elapsed:number):void {
    depthPacked.value=this.options.capabilities.hdr?0:1;depthFar.value=this.far.value;
    this.state.elapsedSeconds=elapsed;if(this.panicStart!==null)this.updatePanic((elapsed-this.panicStart)*1000);
    const p=this.state.panic;
    this.clock.value=elapsed;this.focus.value=this.state.focusDistanceM;this.focusBlend.value=this.state.focusBlend;this.panicAmount.value=p;this.fade.value=this.state.fade;textFade.value=this.state.fade;
    this.threshold.value=p?PANIC_POST.threshold:this.reduced?REDUCED_BLOOM.threshold:BLOOM.threshold;
    this.strength.value=p?PANIC_POST.strength:BLOOM.strength*(this.reduced?REDUCED_BLOOM.strengthScale:1);
    this.vignetteStrength.value=(VIGNETTE.strength+(VIGNETTE.lockedStrength-VIGNETTE.strength)*this.state.focusBlend)*(1+p*PANIC_POST.vignetteContraction);
    this.vignettePower.value=VIGNETTE.power+(VIGNETTE.lockedPower-VIGNETTE.power)*this.state.focusBlend;
    materialTime.value=p&&this.panicStart!==null?this.panicStart:elapsed;materialPanic.value=p;
    if('near' in this.camera&&typeof this.camera.near==='number')this.near.value=this.camera.near;
    if('far' in this.camera&&typeof this.camera.far==='number')this.far.value=this.camera.far;
  }
  render(elapsed:number):void {if(this.disposed)return;this.update(elapsed);for(const op of this.operations)op.execute();}
  async measureGpu(elapsed:number):Promise<Readonly<Record<string,number>>> {
    if(!this.options.capabilities.timestampQuery)throw new Error('GPU timestamp queries unavailable');
    const result:Record<string,number>={};this.update(elapsed);
    await this.options.renderer.resolveTimestampsAsync('render');
    for(const op of this.operations){op.execute();await this.options.renderer.resolveTimestampsAsync('render');result[op.name]=this.options.renderer.info.render.timestamp;}
    return result;
  }
  private clearGraph():void {
    for(const op of this.operations)op.pipeline?.dispose();this.operations=[];
    for(const node of this.ownedNodes)node.dispose();this.ownedNodes.length=0;
    this.budget.dispose();
  }
  dispose():void {this.disposed=true;this.clearGraph();this.bayer.dispose();}
}
