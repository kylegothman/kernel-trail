import type { Capabilities } from '@platform';
import type { BackendInitOptions,RendererBackend } from '../RendererBackend';
export async function createBackend(canvas:HTMLCanvasElement,caps:Capabilities,opts:Omit<BackendInitOptions,'forceWebGL'>,forceWebGL?:boolean):Promise<RendererBackend> {
  const module=await import('../RendererBackend');return module.createBackend(canvas,caps,opts,forceWebGL);
}
