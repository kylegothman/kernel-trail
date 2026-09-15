import { BENCHMARK,PROFILES,type BenchmarkHost,type RenderCapabilities } from '@platform';
import { createProbeScene } from '../index';
import { createBackend } from './createBackend';
import { createParticleIntegration } from './particles';
/** Wall-clock render completion cost for tier selection, never labelled GPU timing. */
export async function createBenchmarkHost(caps:RenderCapabilities):Promise<BenchmarkHost> {
  const canvas=document.createElement('canvas');
  const backend=await createBackend(canvas,caps,{antialias:false,samples:1,profile:PROFILES.medium});
  backend.resize(BENCHMARK.width,BENCHMARK.height,1);
  const probe=createProbeScene('medium',BENCHMARK.slabs,0),particles=createParticleIntegration(BENCHMARK.particles,caps);
  probe.scene.add(particles.object);probe.camera.aspect=BENCHMARK.width/BENCHMARK.height;probe.camera.updateProjectionMatrix();
  const frame={scene:probe.scene,camera:probe.camera,alpha:0,dtSeconds:1/60,elapsedSeconds:0};
  return {async frame(){
    const start=performance.now();frame.elapsedSeconds+=frame.dtSeconds;
    particles.update(backend.deviceRenderer,frame.dtSeconds);backend.renderFrame(frame);
    const output=backend.postChain?.budget.targets.get('tonemap_output');if(!output)throw new Error('Missing benchmark output');
    await backend.deviceRenderer.readRenderTargetPixelsAsync(output,0,0,1,1);
    return performance.now()-start;
  },dispose(){particles.dispose();probe.dispose();backend.dispose();canvas.remove();}};
}
