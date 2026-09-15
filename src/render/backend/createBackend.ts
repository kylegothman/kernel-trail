import type { Capabilities } from '@platform';
import type { BackendInitOptions,ThreeUnifiedBackend } from '../RendererBackend';
export async function createBackend(canvas:HTMLCanvasElement,caps:Capabilities,opts:Omit<BackendInitOptions,'forceWebGL'>,forceWebGL?:boolean):Promise<ThreeUnifiedBackend> {
  const module=await import('../RendererBackend');return module.createBackend(canvas,caps,opts,forceWebGL);
}
