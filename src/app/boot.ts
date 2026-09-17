/** Browser resources shared by the title screen and one active run. */
import { Scene, PerspectiveCamera } from 'three/webgpu';
import { detectCapabilities, selectTier, benchmark, PROFILES, UnsupportedBrowserError, type RenderCapabilities, type QualityTier } from '@platform';
import { createBackend, getMaterial } from '@render';
import { createBenchmarkHost } from '@render/backend/benchmarkHost';
import { GeometryLeases, makeSlab } from '@world/forms';
import { Database } from '@game/save';
import type { DiscClass, DifficultyTier, SaveFile } from '@game/types';
import { CARD_CSS } from '@ui/cards/cards.css';

export interface BootContext {
  readonly buildId: string;
  readonly caps: RenderCapabilities;
  readonly tier: QualityTier;
  readonly backend: Awaited<ReturnType<typeof createBackend>>;
  readonly canvas: HTMLCanvasElement;
  readonly db: Database;
  readonly overlay: HTMLElement;
  dispose(): void;
}

export type SessionStart =
  | { readonly kind: 'new'; readonly seed: number; readonly discClass: DiscClass; readonly difficulty: DifficultyTier }
  | { readonly kind: 'resume'; readonly file: SaveFile };

export interface BootOptions {
  readonly detect?: typeof detectCapabilities;
  readonly createBackend?: typeof createBackend;
  readonly forceWebGL?: boolean;
  readonly tier?: QualityTier;
}

export async function bootBrowser(canvas: HTMLCanvasElement, options: BootOptions = {}): Promise<BootContext> {
  const doc = canvas.ownerDocument;
  const view = doc.defaultView;
  if (view === null) throw new Error('The stage needs a browser window.');
  const buildId = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
  let caps: RenderCapabilities;
  try {
    ({ caps } = await (options.detect ?? detectCapabilities)(buildId, options.forceWebGL));
  } catch (error) {
    if (error instanceof UnsupportedBrowserError) doc.body.textContent = 'KERNEL TRAIL needs WebGPU or WebGL2.';
    throw error;
  }
  const { tier } = await selectTier(caps, buildId, c => benchmark(c, createBenchmarkHost), options.tier);
  const leases = new GeometryLeases();
  const slab = leases.take(makeSlab());
  let backend: BootContext['backend'];
  try {
    backend = await (options.createBackend ?? createBackend)(canvas, caps, {
      profile: PROFILES[tier], antialias: false, samples: 4,
      resources: {
        geometryFor: () => slab,
        materialFor: (_id, profile) => getMaterial('emissive-panel', 'page_clean', profile.tier),
        dispose: () => leases.dispose(),
      },
    }, options.forceWebGL);
  } catch (error) {
    leases.dispose();
    throw error;
  }
  const fit = (): void => backend.resize(view.innerWidth, view.innerHeight, view.devicePixelRatio || 1);
  const db = new Database();
  const overlay = doc.createElement('div');
  overlay.id = 'overlay';
  Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
  try {
    fit();
    view.addEventListener('resize', fit);
    const scene = new Scene();
    const camera = new PerspectiveCamera(46, view.innerWidth / Math.max(1, view.innerHeight), 0.1, 2000);
    for (let i = 0; i < 12; i++) backend.renderFrame({ scene, camera, alpha: 0, dtSeconds: 1 / 60, elapsedSeconds: i / 60 });
    await db.open();
    if (doc.getElementById('kt-card-styles') === null) {
      const style = doc.createElement('style');
      style.id = 'kt-card-styles';
      style.textContent = CARD_CSS;
      doc.head.append(style);
    }
    doc.body.append(overlay);
  } catch (error) {
    view.removeEventListener('resize', fit);
    db.close();
    backend.dispose();
    leases.dispose();
    throw error;
  }
  let disposed = false;
  return {
    buildId, caps, tier, backend, canvas, db, overlay,
    dispose() {
      if (disposed) return;
      disposed = true;
      overlay.remove();
      db.close();
      view.removeEventListener('resize', fit);
      backend.dispose();
      leases.dispose();
    },
  };
}
