import {exerciseDeviceLoss} from './deviceLoss.gpu';
import {createProbeScene,disposeMaterials,holoLabel} from '../../../src/render/index';
import {createBenchmarkHost} from '../../../src/render/backend/benchmarkHost';
import {benchmark} from '../../../src/platform/benchmark';
import {ThreeUnifiedBackend} from '../../../src/render/RendererBackend';
import {detectCapabilities,PROFILES,type QualityTier} from '../../../src/platform/index';
const canvas=document.querySelector<HTMLCanvasElement>('#probe');
if(!canvas)throw new Error('Probe canvas missing');
const force=new URLSearchParams(location.search).has('webgl');
const result=await detectCapabilities('gpu-test',force);
const caps=result.caps;
const backend=new ThreeUnifiedBackend(caps);let probe=createProbeScene('high');
await backend.init(canvas,{forceWebGL:force,antialias:false,samples:4,profile:PROFILES.high});
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
    try{for(let i=0;i<count;i++)frame();}finally{Object.assign(globalThis,{__ktAlloc:undefined});}
    return counts;
  },
  recovery:exerciseDeviceLoss,
  async benchmark(){return benchmark(caps,createBenchmarkHost);},
  async timing(){return backend.postChain?.measureGpu(req.elapsedSeconds);},
  info(){return {stats:{...backend.stats},passes:backend.postChain?.physicalPasses,plan:backend.postChain?.targetPlan};},
  dispose(){label.dispose();probe.dispose();backend.dispose();disposeMaterials();},
};
Object.assign(window,{probe:api});
document.querySelector('#status')!.textContent=`Ready: ${backend.id}`;
