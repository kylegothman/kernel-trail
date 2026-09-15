import { VOID, CYAN, SLATE, cssColor } from '@design';
/**
 * KERNEL TRAIL - the bootstrap.
 *
 * Detect capabilities, pick a quality tier, create the renderer, create the
 * stores, start the loop, render a placeholder scene. This file runs today: it
 * has no dependency on Three.js or on any module that does not yet exist.
 *
 * Two things here are deliberately provisional and marked as such:
 *
 *  1. Capability detection and the quality profiles are inlined. They belong in
 *     @platform/capabilities (architecture 5.2) and @platform/quality
 *     (architecture 6.1); the shapes below match those specifications so the
 *     move is a cut and paste plus an import.
 *  2. The renderer is a canvas-2D placeholder that satisfies a narrow slice of
 *     `RendererBackend` (architecture 5.3). It exists so the loop has something
 *     real to drive and so the frame pipeline can be verified end to end before
 *     the WebGPU path lands.
 */

import { createStore, type Store } from '@game/store';
import {
  GameLoop,
  installVisibilityGovernor,
  TICK_MS,
  type FrameMetrics,
  type SimHost,
} from '@app/loop';

/* ------------------------------------------------------------------ */
/* Capabilities. Architecture section 5.2.                             */
/* ------------------------------------------------------------------ */

export type BackendId = 'webgpu' | 'webgl2';

export interface RenderCapabilities {
  readonly backend: BackendId;
  readonly compute: boolean;
  readonly storageBuffers: boolean;
  readonly maxSamples: 1 | 2 | 4;
  readonly maxTextureSize: number;
  readonly maxInstances: number;
  readonly deviceMemoryGb: number | null;
  readonly hardwareConcurrency: number;
  readonly adapterLabel: string;
  readonly isIntegrated: boolean;
  readonly prefersReducedMotion: boolean;
  readonly devicePixelRatio: number;
}

export class UnsupportedBrowserError extends Error {}

export interface CapabilityProbeResult {
  readonly caps: RenderCapabilities;
  /** Non-fatal problems worth showing in the diagnostics panel. */
  readonly warnings: readonly string[];
}

// TODO(astra): move this into src/platform/capabilities.ts per architecture 5.2
// and add the fields this cut-down copy omits (float32Filterable,
// float16Renderable, timestampQuery) plus the localStorage probe cache keyed on
// adapterLabel + userAgent + build id.
export async function probeCapabilities(): Promise<CapabilityProbeResult> {
  const warnings: string[] = [];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const mem =
    'deviceMemory' in navigator
      ? ((navigator as { deviceMemory?: number }).deviceMemory ?? null)
      : null;

  const gpu = (navigator as { gpu?: { requestAdapter(o: unknown): Promise<unknown> } }).gpu;
  if (gpu !== undefined) {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter !== null && adapter !== undefined) {
        return {
          caps: {
            backend: 'webgpu',
            compute: true,
            storageBuffers: true,
            // WebGPU guarantees sampleCount 1 and 4 only.
            maxSamples: 4,
            maxTextureSize: 8192,
            maxInstances: 1_000_000,
            deviceMemoryGb: mem,
            hardwareConcurrency: cores,
            adapterLabel: 'webgpu',
            // Assuming integrated is the safe default for a game that targets
            // a MacBook Air.
            isIntegrated: true,
            prefersReducedMotion: reduced,
            devicePixelRatio: dpr,
          },
          warnings,
        };
      }
      warnings.push('navigator.gpu present but no adapter was returned.');
    } catch (err) {
      warnings.push(`WebGPU adapter request failed: ${String(err)}`);
    }
  }

  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
  if (gl === null) {
    throw new UnsupportedBrowserError('KERNEL TRAIL needs WebGL2.');
  }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const label =
    dbg === null ? 'webgl2' : String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL as number));
  if (gl.getExtension('EXT_color_buffer_float') === null) {
    warnings.push('No EXT_color_buffer_float: HDR runs at 8-bit, bloom will band.');
  }
  const samples = gl.getParameter(gl.MAX_SAMPLES) as number;

  const caps: RenderCapabilities = {
    backend: 'webgl2',
    compute: false,
    storageBuffers: false,
    maxSamples: samples >= 4 ? 4 : samples >= 2 ? 2 : 1,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxInstances: 65_536,
    deviceMemoryGb: mem,
    hardwareConcurrency: cores,
    adapterLabel: label,
    isIntegrated: /intel|apple|adreno|mali|powervr|iris|uhd/i.test(label),
    prefersReducedMotion: reduced,
    devicePixelRatio: dpr,
  };
  probe.remove();
  return { caps, warnings };
}

/* ------------------------------------------------------------------ */
/* Quality tier. Architecture sections 6.1 and 6.3.                    */
/* ------------------------------------------------------------------ */

export type QualityTier = 'low' | 'medium' | 'high';

export interface TierDecision {
  readonly tier: QualityTier;
  readonly by: 'cache' | 'user' | 'benchmark' | 'heuristic' | 'fallback';
  readonly medianFrameMs: number | null;
  readonly notes: string;
}

// TODO(astra): move this into src/platform/tierSelect.ts per architecture 6.3
// and add the benchmark scene of that section (3000 slabs, 6000 particle quads,
// the medium post chain at 960x600, 12 warm-up frames then 30 measured, median)
// plus the kt.tier.v1 localStorage cache.
export function selectTierHeuristically(caps: RenderCapabilities): TierDecision {
  // The heuristic prior of architecture 6.3, used directly until the benchmark
  // exists. A WebGL2 device is never promoted above medium at boot, because the
  // fallback path has higher per-frame CPU cost than a benchmark shows.
  const tier: QualityTier =
    caps.backend === 'webgl2' ? 'low' : caps.isIntegrated ? 'medium' : 'high';
  return {
    tier,
    by: 'heuristic',
    medianFrameMs: null,
    notes: `${caps.adapterLabel}: no benchmark yet, using the adapter heuristic.`,
  };
}

/* ------------------------------------------------------------------ */
/* Session state. Architecture section 4.4.                            */
/* ------------------------------------------------------------------ */

export interface SessionState {
  tier: QualityTier;
  tierChosenBy: TierDecision['by'];
  backend: BackendId;
  dpr: number;
  cameraMode: 'travel' | 'focus' | 'debrief';
  openPanel: 'none' | 'codex' | 'terminal' | 'policy' | 'convoy' | 'map';
  reducedMotion: boolean;
  showFrameGraph: boolean;
  lastFrameMs: number;
  droppedTickCount: number;
  timeScale: number;
  paused: boolean;
  /** Placeholder-scene readout until the real sim is wired in. */
  simTick: number;
}

export type SessionStore = Store<SessionState>;

/* ------------------------------------------------------------------ */
/* Placeholder renderer                                                */
/* ------------------------------------------------------------------ */

export interface PlaceholderScene {
  readonly title: string;
  readonly subtitle: string;
}

/**
 * A canvas-2D stand-in for `RendererBackend` (architecture 5.3). It draws the
 * grid, the title and a live frame readout so that the loop, the clamp, the
 * accumulator and the interpolation alpha can all be watched working before any
 * shader exists.
 *
 * TODO(astra): replace with `createBackend(canvas, caps, opts)` from
 * @render/backend/createBackend per architecture 5.3, and move the placeholder
 * drawing into a real LegStage.
 */
export class PlaceholderRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cssWidth = 0;
  private cssHeight = 0;
  private pixelRatio = 1;
  private elapsedSeconds = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly caps: RenderCapabilities,
    readonly tier: QualityTier,
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new UnsupportedBrowserError('canvas 2d context unavailable');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.pixelRatio = pixelRatio;
    this.canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
    this.canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  advance(dtSeconds: number): void {
    this.elapsedSeconds += dtSeconds;
  }

  renderFrame(scene: PlaceholderScene, alpha: number, tick: number): void {
    const { ctx } = this;
    const w = this.cssWidth;
    const h = this.cssHeight;

    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.fillStyle = cssColor(VOID.base);
    ctx.fillRect(0, 0, w, h);

    // A drifting grid, so the alpha and the wall-clock advance are both visible.
    const spacing = 48;
    const drift = (this.elapsedSeconds * 18) % spacing;
    ctx.strokeStyle = cssColor(CYAN.core, 0.14);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -spacing + drift; x < w + spacing; x += spacing) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = 0; y < h + spacing; y += spacing) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();

    // A slice bar that fills across one tick, driven entirely by alpha. If the
    // accumulator or the clamp is wrong this stutters visibly.
    const barW = Math.min(420, w - 96);
    const barX = (w - barW) / 2;
    const barY = h / 2 + 56;
    ctx.strokeStyle = cssColor(CYAN.core, 0.55);
    ctx.strokeRect(barX + 0.5, barY + 0.5, barW, 10);
    ctx.fillStyle = cssColor(CYAN.core, 0.85);
    ctx.fillRect(barX + 1, barY + 1, Math.max(0, (barW - 1) * alpha), 9);

    ctx.fillStyle = cssColor(SLATE.primary);
    ctx.textAlign = 'center';
    ctx.font = '600 34px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(scene.title, w / 2, h / 2 - 18);
    ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = cssColor(SLATE.primary, 0.62);
    ctx.fillText(scene.subtitle, w / 2, h / 2 + 12);
    ctx.fillText(
      `tick ${tick}   alpha ${alpha.toFixed(3)}   ${this.caps.backend}   tier ${this.tier}`,
      w / 2,
      barY + 34,
    );
  }

  dispose(): void {
    this.canvas.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

export interface BootResult {
  readonly loop: GameLoop;
  readonly session: SessionStore;
  readonly renderer: PlaceholderRenderer;
  readonly caps: RenderCapabilities;
  readonly tier: TierDecision;
  readonly dispose: () => void;
}

export async function boot(mount: HTMLElement): Promise<BootResult> {
  const { caps, warnings } = await probeCapabilities();
  for (const warning of warnings) console.warn(`[kernel-trail] ${warning}`);

  const tier = selectTierHeuristically(caps);

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  mount.appendChild(canvas);
  const renderer = new PlaceholderRenderer(canvas, caps, tier.tier);

  const session: SessionStore = createStore<SessionState>({
    tier: tier.tier,
    tierChosenBy: tier.by,
    backend: caps.backend,
    dpr: caps.devicePixelRatio,
    cameraMode: 'travel',
    openPanel: 'none',
    // Motion settings and quality settings are separate axes and must not be
    // conflated. Architecture 6.3.
    reducedMotion: caps.prefersReducedMotion,
    showFrameGraph: false,
    lastFrameMs: 0,
    droppedTickCount: 0,
    timeScale: 1,
    paused: false,
    simTick: 0,
  });

  const scene: PlaceholderScene = {
    title: 'KERNEL TRAIL',
    subtitle: 'Placeholder stage. The kernel is headless and the world is not built yet.',
  };

  const fit = (): void => {
    renderer.resize(mount.clientWidth, mount.clientHeight, caps.devicePixelRatio);
  };
  fit();
  window.addEventListener('resize', fit);

  const host: SimHost = {
    applyPendingCommands: () => {
      // TODO(astra): drain CommandBus here per architecture 4.7. Player commands
      // apply at tick boundaries only; if input could land between ticks the
      // decision log would need sub-tick timestamps and replay would stop being
      // exact.
    },
    fixedUpdate: (tick) => {
      // TODO(astra): RunDirector.preTick, then Kernel.step, then
      // RunDirector.postTick, per architecture 2.2.
      session.mutate((s) => {
        s.simTick = tick + 1;
      });
    },
    flushState: () => {
      // Once, after ticking, before anything reads, so the HUD and the world
      // see the same state within a frame.
      session.flush();
    },
    routeEvents: () => {
      // TODO(astra): WorldEventRouter.drain per architecture 3.2. Routing runs
      // after the store flush because it reads run state.
    },
    variableUpdate: (dtSeconds) => {
      renderer.advance(dtSeconds);
    },
    render: (alpha) => {
      renderer.renderFrame(scene, alpha, session.get().simTick);
    },
    onFrameMetrics: (m: FrameMetrics) => {
      if (m.droppedTicks > 0 || m.frameIndex % 30 === 0) {
        session.mutate((s) => {
          s.lastFrameMs = m.frameMs;
          s.droppedTickCount += m.droppedTicks;
        });
      }
    },
    onRunStateChanged: (running) => {
      session.mutate((s) => {
        s.paused = !running;
      });
    },
  };

  const loop = new GameLoop({ host });

  const removeVisibility = installVisibilityGovernor(loop, {
    onHide: () => {
      // TODO(astra): write the provisional save here per architecture 8.5 and
      // duck the audio bus over 120 ms. IndexedDB writes cannot be relied on
      // during pagehide, which is why the write happens on this signal.
    },
    onShow: () => {
      // TODO(astra): unmute and play the 400 ms resuming wipe.
    },
    onBlur: () => {
      // TODO(astra): reduce audio gain by 6 dB. The loop keeps running: the
      // player may be reading the codex in another window.
    },
    onFocus: () => {
      // TODO(astra): restore audio gain.
    },
  });

  loop.start();

  console.info(
    `[kernel-trail] booted on ${caps.backend}, tier ${tier.tier} (${tier.by}), ` +
      `sim at ${(1000 / TICK_MS).toFixed(0)} Hz`,
  );

  return {
    loop,
    session,
    renderer,
    caps,
    tier,
    dispose: () => {
      loop.stop();
      removeVisibility();
      window.removeEventListener('resize', fit);
      renderer.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const mount = typeof document === 'undefined' ? null : document.getElementById('app');
if (mount !== null) {
  void boot(mount).catch((error: unknown) => {
    console.error('[kernel-trail] boot failed', error);
    mount.textContent =
      error instanceof UnsupportedBrowserError
        ? error.message
        : 'KERNEL TRAIL failed to start. See the console for details.';
  });
}
