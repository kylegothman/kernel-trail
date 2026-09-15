import {exerciseDeviceLoss} from './deviceLoss.gpu';
import {createProbeScene,disposeMaterials,holoLabel} from '../../../src/render/index';
import {createBenchmarkHost} from '../../../src/render/backend/benchmarkHost';
import {benchmark} from '../../../src/platform/benchmark';
import {createBackend} from '../../../src/render/backend/createBackend';
import {Matrix4,Vector3,Color} from 'three/webgpu';
import {detectCapabilities,PROFILES,type QualityTier} from '../../../src/platform/index';
async function initializeProbe() {
const canvas=document.querySelector<HTMLCanvasElement>('#probe');
if(!canvas)throw new Error('Probe canvas missing');
const force=new URLSearchParams(location.search).has('webgl');
const result=await detectCapabilities('gpu-test',force);
const caps=result.caps;
const backend=await createBackend(canvas,caps,{antialias:false,samples:4,profile:PROFILES.high},force);
let probe=createProbeScene('high');
backend.resize(1440,900,1);
const req={scene:probe.scene,camera:probe.camera,alpha:0,dtSeconds:1/60,elapsedSeconds:0};
function frame(){probe.update();req.elapsedSeconds+=req.dtSeconds;backend.renderFrame(req);}
for(let i=0;i<12;i++)frame();
const label=await holoLabel('KERNEL TRAIL','running','high',2);probe.scene.add(label.object);label.object.position.set(-10,5,0);label.object.lookAt(probe.camera.position);label.object.updateMatrixWorld();
frame();
const api={
  id:backend.id,caps,
  async tier(tier:QualityTier){label.dispose();probe.dispose();probe=createProbeScene(tier);req.scene=probe.scene;req.camera=probe.camera;backend.setQuality(PROFILES[tier]);for(let i=0;i<12;i++)frame();return {...backend.stats};},
  frames(count:number){for(let i=0;i<count;i++)frame();return {...backend.stats};},
  allocations(count:number){
    const counts:Record<string,number>={Matrix4:0,Vector3:0,Color:0};
    Object.assign(globalThis,{__ktAlloc:(name:string)=>{counts[name]=(counts[name]??0)+1;}});
    try{
      // A zero count is meaningless if bundling bypassed instrumentation.
      new Matrix4();new Vector3();new Color();
      for(const name of ['Matrix4','Vector3','Color'])if(counts[name]!==1)throw new Error(`Allocation instrumentation missing or duplicated: ${name}=${counts[name]}`);
      counts['Matrix4']=0;counts['Vector3']=0;counts['Color']=0;
      for(let i=0;i<count;i++)frame();
    }finally{Object.assign(globalThis,{__ktAlloc:undefined});}
    return counts;
  },
  recovery:exerciseDeviceLoss,
  async benchmark(){return benchmark(caps,createBenchmarkHost);},
  async timing(){return backend.postChain?.measureGpu(req.elapsedSeconds);},
  info(){return {backend:backend.id,adapter:caps.adapterLabel,capabilities:backend.capabilities,stats:{...backend.stats},passes:backend.postChain?.physicalPasses,plan:backend.postChain?.targetPlan};},
  dispose(){label.dispose();probe.dispose();backend.dispose();disposeMaterials();},
};
Object.assign(globalThis,{__kernelTrailProbe:{status:'ready',api}});
document.querySelector('#status')!.textContent=`Ready: ${backend.id}`;
}
Object.assign(globalThis,{__kernelTrailProbe:{status:'booting'}});
void initializeProbe().catch((cause:unknown)=>{
  const error=cause instanceof Error?cause:new Error(String(cause));
  Object.assign(globalThis,{__kernelTrailProbe:{status:'failed',error:{message:error.message,stack:error.stack??error.message}}});
  const status=document.querySelector('#status');if(status)status.textContent=`Failed: ${error.message}`;
  // The runner captures this diagnostic and the original error event with its stack.
  console.error('Probe initialization failed:',error.stack??error.message);
  throw error;
});
