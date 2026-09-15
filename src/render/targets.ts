import { RenderTarget, HalfFloatType, UnsignedByteType, FloatType, RGBAFormat, RedFormat, LinearFilter, NearestFilter } from 'three/webgpu';
import type { RenderCapabilities, RenderQualityProfile } from '@platform';
export const GPU_TARGET_BUDGET_BYTES = 210 * 1024 * 1024;
export const MAIN_TARGET_MAX_PIXELS = 2560 * 1600;
export interface TargetSpec { readonly name: string; readonly scale: number; readonly format: 'hdr' | 'depth' | 'output'; readonly samples?: number; readonly depth?: boolean }
export interface TargetPlan { readonly width: number; readonly height: number; readonly samples: 0 | 2 | 4; readonly hdrFormat: 'rgba16float' | 'rgba8unorm'; readonly totalBytes: number; readonly clamped: readonly string[] }
export function specsFor(profile: RenderQualityProfile, samples: number, debug = false): readonly TargetSpec[] {
  const specs: TargetSpec[] = [
    {name:'scene_world',scale:1,format:'hdr',samples,depth:true},
    {name:'depth_resolve',scale:1,format:'depth'},
    {name:'beam_depth',scale:profile.beamDepthScale,format:'depth'},
    {name:'composite',scale:1,format:'hdr'},
    {name:'tonemap_output',scale:1,format:'output'},
  ];
  if (profile.depthOfField) specs.push({name:'depth_of_field',scale:0.5,format:'hdr'});
  if (profile.volumetricScattering) specs.push({name:'volumetric_scatter',scale:0.25,format:'hdr'});
  if (profile.floorReflection === 'planar-rt') specs.push({name:'reflection',scale:0.5,format:'hdr',depth:true});
  specs.push({name:'bright_pass',scale:profile.bloomScale,format:'hdr'});
  for (let i=0;i<profile.bloomLevels;i++) {
    const scale = profile.bloomScale / 2 ** i;
    specs.push({name:`down${i}`,scale,format:'hdr'},{name:`up${i}`,scale,format:'hdr'});
  }
  if (debug) for (const name of ['chromatic_aberration','film_grain','vignette']) specs.push({name,scale:1,format:'hdr'});
  // SMAANode owns three half-float render targets. Reserve their memory before constructing it.
  if (profile.antialiasing === 'smaa') for (const name of ['smaa_edges','smaa_weights','smaa_output']) specs.push({name,scale:1,format:'hdr'});
  return specs;
}
export function bytesFor(spec: TargetSpec, width: number, height: number, hdr: boolean): number {
  const pixels = Math.max(1,Math.floor(width*spec.scale))*Math.max(1,Math.floor(height*spec.scale));
  const color = spec.format === 'hdr' && hdr ? 8 : 4;
  const samples = spec.samples ?? 0;
  return pixels * (color * (1 + samples) + (spec.depth ? 4 * (1 + samples) : 0));
}
export function planTargets(cssWidth: number, cssHeight: number, pixelRatio: number, profile: RenderQualityProfile, caps: RenderCapabilities, debug = false): TargetPlan {
  if (![cssWidth,cssHeight,pixelRatio].every(x => Number.isFinite(x) && x > 0)) throw new Error('Invalid target dimensions');
  const wanted = profile.msaaSamples;
  const samples = caps.backend === 'webgpu' ? (wanted > 0 ? 4 : 0) : Math.min(wanted,caps.maxSamples) >= 4 ? 4 : Math.min(wanted,caps.maxSamples) >= 2 ? 2 : 0;
  const dpr = Math.min(pixelRatio,profile.maxPixelRatio,caps.devicePixelRatio);
  const rawW = cssWidth*dpr*profile.renderScale, rawH = cssHeight*dpr*profile.renderScale;
  let factor = Math.min(1,Math.sqrt(MAIN_TARGET_MAX_PIXELS/(rawW*rawH)),caps.maxTextureSize/rawW,caps.maxTextureSize/rawH);
  const specs=specsFor(profile,samples,debug);
  let width=Math.max(1,Math.floor(rawW*factor)),height=Math.max(1,Math.floor(rawH*factor));
  let total=specs.reduce((sum,s)=>sum+bytesFor(s,width,height,caps.hdr),0);
  if (total > GPU_TARGET_BUDGET_BYTES) {
    factor*=Math.sqrt(GPU_TARGET_BUDGET_BYTES/total);
    width=Math.max(1,Math.floor(rawW*factor));height=Math.max(1,Math.floor(rawH*factor));
    total=specs.reduce((sum,s)=>sum+bytesFor(s,width,height,caps.hdr),0);
  }
  return {width,height,samples,hdrFormat:caps.hdr?'rgba16float':'rgba8unorm',totalBytes:total,clamped:factor<1?['Resolution reduced to respect target limits']:[]};
}
export class RenderTargetBudget {
  private bytes = 0;
  readonly targets = new Map<string,RenderTarget>();
  constructor(readonly ceiling = GPU_TARGET_BUDGET_BYTES, private readonly dev = import.meta.env.DEV) {}
  get totalBytes(): number { return this.bytes; }
  reserve(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0 || this.bytes + bytes > this.ceiling) {
      if (this.dev) throw new Error('Render target memory ceiling exceeded');
      throw new RangeError('Unsafe render target allocation');
    }
    this.bytes += bytes;
  }
  allocate(spec: TargetSpec, plan: TargetPlan): RenderTarget {
    this.reserve(bytesFor(spec,plan.width,plan.height,plan.hdrFormat==='rgba16float'));
    const target = new RenderTarget(Math.max(1,Math.floor(plan.width*spec.scale)),Math.max(1,Math.floor(plan.height*spec.scale)),{
      type:spec.format==='depth'&&plan.hdrFormat==='rgba16float'?FloatType:spec.format==='hdr'&&plan.hdrFormat==='rgba16float'?HalfFloatType:UnsignedByteType,
      format:spec.format==='depth'&&plan.hdrFormat==='rgba16float'?RedFormat:RGBAFormat, samples:spec.samples??0, depthBuffer:spec.depth??false,
      minFilter:spec.format==='depth'?NearestFilter:LinearFilter,magFilter:spec.format==='depth'?NearestFilter:LinearFilter,
    });
    target.texture.name=spec.name;this.targets.set(spec.name,target);return target;
  }
  dispose(): void { for (const t of this.targets.values()) t.dispose();this.targets.clear();this.bytes=0; }
}
