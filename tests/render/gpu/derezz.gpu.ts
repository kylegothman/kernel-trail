import { BoxGeometry, PerspectiveCamera, Scene } from 'three/webgpu';
import { createBackend, type RendererBackend } from '../../../src/render';
import { detectCapabilities, PROFILES, type QualityTier } from '../../../src/platform';
import { DerezzPool } from '../../../src/render/derezz/DerezzPool';

const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
const rng = (seed = 1) => ({ next: () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; } });

async function initialize(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#probe');
  if (!canvas) throw new Error('Derezz probe canvas missing');
  const force = new URLSearchParams(location.search).has('webgl');
  const tier = (new URLSearchParams(location.search).get('tier') ?? 'high') as QualityTier;
  const { caps } = await detectCapabilities('wp14-derezz', force);
  const backend: RendererBackend = await createBackend(canvas, caps, { profile: PROFILES[tier], antialias: false, samples: 4 }, force);
  backend.resize(1440, 900, 1);
  const scene = new Scene();
  const camera = new PerspectiveCamera(46, 1440 / 900, 0.1, 2000);
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const source = new BoxGeometry(1, 1, 1);
  const pool = new DerezzPool(tier);
  const request = { scene, camera, alpha: 0, dtSeconds: 1 / 60, elapsedSeconds: 0 };
  const api = {
    info: () => ({ backend: backend.id, tier, drawCalls: pool.drawCalls }),
    run: () => {
      const anonymous = pool.spawn({ source, reason: 'normal_exit', namedConvoy: false, rng: rng(4) });
      assert(anonymous, 'Anonymous derezz did not spawn');
      const convoy = pool.spawn({ source, reason: 'deadlock_victim', namedConvoy: true, rng: rng(5) });
      assert(convoy, 'Convoy derezz did not spawn');
      backend.renderFrame(request);
      return { backend: backend.id, drawCalls: pool.drawCalls, active: pool.activeCount, cells: [anonymous.fracture.cell, convoy.fracture.cell] };
    },
    dispose: () => { pool.dispose(); source.dispose(); backend.dispose(); },
  };
  Object.assign(globalThis, { __kernelTrailProbe: { status: 'ready', api } });
}

Object.assign(globalThis, { __kernelTrailProbe: { status: 'booting' } });
void initialize().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  Object.assign(globalThis, { __kernelTrailProbe: { status: 'failed', error: { message: error.message, stack: error.stack ?? error.message } } });
  console.error('Derezz probe initialization failed:', error.stack ?? error.message);
});
