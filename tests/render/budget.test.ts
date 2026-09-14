import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createProbeScene,disposeMaterials} from '../../src/render';
import {RenderTargetBudget,planTargets,GPU_TARGET_BUDGET_BYTES} from '../../src/render/targets';
import {DrawCallBudget,assertTransparencyDepth} from '../../src/render/DrawCallBudget';
import {PROFILES,type RenderCapabilities} from '../../src/platform';
import {stripComments} from '../kernel/sourceScan';
import {DeviceLossPolicy} from '../../src/render/backend/DeviceLossPolicy';
const caps:RenderCapabilities={backend:'webgpu',compute:true,storageBuffers:true,maxSamples:4,float32Filterable:true,float16Renderable:true,hdr:true,maxTextureSize:8192,maxInstances:1000000,timestampQuery:true,deviceMemoryGb:8,hardwareConcurrency:8,adapterLabel:'test',isIntegrated:true,prefersReducedMotion:false,devicePixelRatio:2};
for(const tier of ['low','medium','high'] as const)it(`declared probe budgets ${tier}`,()=>{const probe=createProbeScene(tier);expect(()=>new DrawCallBudget(tier).assert(probe.declared.drawCalls,probe.declared.triangles)).not.toThrow();const plan=planTargets(1440,900,2,PROFILES[tier],caps);expect(plan.totalBytes).toBeLessThanOrEqual(GPU_TARGET_BUDGET_BYTES);probe.dispose();disposeMaterials();});
it('oversized target throws before allocation',()=>{const budget=new RenderTargetBudget(210*1024*1024,true);expect(()=>budget.reserve(211*1024*1024)).toThrow('ceiling');expect(budget.totalBytes).toBe(0);});
it('WebGPU two samples round up to four',()=>expect(planTargets(1440,900,1,{...PROFILES.high,msaaSamples:2},caps).samples).toBe(4));
it('unsupported HDR fallback is explicit',()=>expect(planTargets(1440,900,1,PROFILES.low,{...caps,backend:'webgl2',hdr:false,float16Renderable:false}).hdrFormat).toBe('rgba8unorm'));
it('transparency depth rejects a fourth layer',()=>expect(()=>assertTransparencyDepth(4)).toThrow('three'));
it('boundaries and imported AgX',()=>{
 const visit=(dir:string):void=>{for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())visit(p);else if(p.endsWith('.ts')){const code=stripComments(readFileSync(p,'utf8'),false);expect(code,p).not.toMatch(/(?:from\s*|import\s*\()['"](?:@(?:kernel|game|world)|[^'"]*\/(?:kernel|game|world)\/)/);if(p.startsWith('src/design'))expect(code,p).not.toMatch(/(?:from\s*)['"]@(?:render|platform|app|ui|audio|terminal)/);if(p.startsWith('src/render'))expect(code,p).not.toMatch(/0\.8566271|1\.1271006/);}}};for(const dir of ['src/design','src/render','src/platform'])visit(dir);
});
it('device recovery: same backend, one fallback, then card',async()=>{const attempts:boolean[]=[],outcomes:string[]=[];const policy=new DeviceLossPolicy(async force=>{attempts.push(force);throw new Error('lost');},o=>outcomes.push(o),()=>{});await policy.handle('lost','webgpu');expect(attempts).toEqual([false,true]);expect(outcomes).toEqual(['unrecoverable']);attempts.length=0;await policy.handle('lost','webgl2');expect(attempts).toEqual([true]);});
