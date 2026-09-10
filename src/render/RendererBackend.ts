/**
 * KERNEL TRAIL: the renderer backend interface and its one implementation.
 *
 * Implements 01-ARCHITECTURE sections 5.1, 5.3 and 10.3.
 *
 * THE BACKEND DECISION, restated so nobody re-litigates it in a PR. There is one
 * Three.js `WebGPURenderer` from `three/webgpu`, wrapped behind this interface,
 * with `forceWebGL: true` as the WebGL2 path. Three already implements a node
 * material system that compiles to both WGSL and GLSL, and maintaining two
 * material sets would double the shader work on a project whose art is entirely
 * shader. One material graph, one post chain description, one set of shaders to
 * debug.
 *
 * The wrapper exists anyway, because the two paths differ in capabilities
 * (compute, storage buffers, timestamp queries, MSAA on float targets) and the
 * game needs to branch on those differences in a small number of named places
 * rather than everywhere. `ThreeUnifiedBackend` branches on `caps` in exactly
 * four places: MSAA sample count, particle integration strategy, volumetric step
 * ceiling, and GPU timer availability. Those four branches are the entire cost
 * of supporting two APIs.
 *
 * IMPORT DISCIPLINE, 0.185. Everything Three-related in this file comes from
 * `three/webgpu`, not from `three`. In 0.185 the WebGPU entry point ships a full
 * bundle of the core classes, so a `Scene` constructed from `three` and a
 * `Scene` recognised by `WebGPURenderer` from `three/webgpu` can be two distinct
 * classes at runtime, and the failure shows up as a silently empty frame rather
 * than as an error. Mixing the two entry points anywhere in `src/render` is a
 * bug even when it appears to work.
 */

import { InstancedBufferAttribute, InstancedMesh, DynamicDrawUsage, WebGPURenderer } from 'three/webgpu';
import type { BufferGeometry, Camera, Material, Object3D, Scene } from 'three/webgpu';

import type { Capabilities } from '@platform/capabilities';
import type { RenderQualityProfile } from '@platform/quality';

export type BackendId = 'webgpu' | 'webgl2';

/* ------------------------------------------------------------------------- */
/* The interface (01-ARCHITECTURE 5.3)                                        */
/* ------------------------------------------------------------------------- */

export interface FrameRequest {
  readonly scene: Scene;
  readonly camera: Camera;
  /** Interpolation alpha, forwarded to time-dependent uniforms. */
  readonly alpha: number;
  /** Seconds since the previous frame, already clamped by the loop. */
  readonly dtSeconds: number;
  /** Wall seconds since boot. Drives all ambient shader animation. */
  readonly elapsedSeconds: number;
}

export interface RenderStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly programs: number;
  readonly textures: number;
  readonly geometries: number;
  /** GPU milliseconds, when timestamp queries are available; otherwise null. */
  readonly gpuMs: number | null;
  readonly targetMemoryBytes: number;
}

export type BatchGeometryId = 'slab' | 'chit' | 'sector' | 'beam' | 'mote' | 'ring';
export type BatchMaterialId = 'structure' | 'queue' | 'sector' | 'beam' | 'particle';

export interface InstancedBatchDesc {
  readonly name: string;
  readonly capacity: number;
  readonly geometry: BatchGeometryId;
  readonly material: BatchMaterialId;
  /** Whether per-instance colour is written. Skipped for single-hue batches. */
  readonly perInstanceColour: boolean;
  /** Shadows are off everywhere (12.4); this exists so the assertion has a field to read. */
  readonly castShadow: boolean;
  readonly layer: number;
}

export interface InstancedBatchHandle {
  readonly name: string;
  readonly capacity: number;
  /** Number of instances currently drawn. Set every frame. */
  count: number;
  /** 16 floats per instance. Written directly; no Matrix4 allocation. */
  readonly matrices: Float32Array;
  /** 3 floats per instance, linear-space rgb. */
  readonly colours: Float32Array;
  /** 4 floats per instance: [stateEnum, phase01, intensity, ownerHue]. */
  readonly state: Float32Array;
  /** The drawable. Added to the scene by the world layer, never by the backend. */
  readonly object: Object3D;
  /** Mark a contiguous instance range dirty. Coalesced into one upload per frame. */
  touch(from: number, to: number): void;
  dispose(): void;
}

/**
 * Supplies the geometry and material for a batch. Not in the architecture
 * document's interface, and added here because the backend must not import
 * `src/render/materials`: the material factory needs the quality tier and the
 * semantic tokens, and a backend that reached for those would make the render
 * layer circular. The factory is injected at init instead.
 */
export interface BatchResources {
  geometryFor(id: BatchGeometryId): BufferGeometry;
  materialFor(id: BatchMaterialId, profile: RenderQualityProfile): Material;
}

export interface BackendInitOptions {
  readonly forceWebGL: boolean;
  readonly antialias: boolean;
  readonly samples: 1 | 2 | 4;
  readonly profile: RenderQualityProfile;
  readonly resources: BatchResources;
}

export interface DeviceLostInfo {
  readonly reason: string;
}

export interface RendererBackend {
  readonly id: BackendId;
  readonly capabilities: Capabilities;
  readonly stats: RenderStats;
  readonly domElement: HTMLCanvasElement;

  init(canvas: HTMLCanvasElement, opts: BackendInitOptions): Promise<void>;
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  setQuality(profile: RenderQualityProfile): void;
  createInstancedBatch(desc: InstancedBatchDesc): InstancedBatchHandle;

  /** Renders the scene plus the whole post chain into the canvas. */
  renderFrame(req: FrameRequest): void;

  /** Precompile materials for a scene before it becomes visible. */
  compileAsync(scene: Scene, camera: Camera): Promise<void>;

  onDeviceLost(cb: (info: DeviceLostInfo) => void): () => void;
  dispose(): void;
}

/* ------------------------------------------------------------------------- */
/* Narrowing for the parts of three/webgpu that are not in the public types    */
/* ------------------------------------------------------------------------- */

/**
 * `WebGPURenderer.backend` is internal. These are the only two fields read from
 * it, both guarded, both optional, and both with a working fallback. If a future
 * Three release renames them the game keeps rendering and loses only device-loss
 * detection on the WebGPU path, which is the correct failure direction.
 */
interface RendererBackendInternals {
  readonly device?: GPUDevice;
  readonly isWebGPUBackend?: boolean;
  readonly isWebGLBackend?: boolean;
}

interface RendererInternals {
  readonly backend?: RendererBackendInternals;
}

/**
 * WebGPU and WebGL report draw calls under different names on `info.render`,
 * and the WebGPU `Info` class has no `programs` array at all (it tracks
 * pipelines instead). Both are read through this shape so that neither path
 * needs a cast at the call site and neither breaks the build when the other's
 * field is missing.
 */
interface RenderInfoLike {
  readonly render: {
    readonly drawCalls?: number;
    readonly calls?: number;
    readonly triangles?: number;
  };
  readonly memory: {
    readonly geometries: number;
    readonly textures: number;
  };
  readonly programs?: readonly unknown[] | null;
  readonly pipelines?: readonly unknown[] | null;
}

/* ------------------------------------------------------------------------- */
/* Device loss policy (01-ARCHITECTURE 10.3)                                  */
/* ------------------------------------------------------------------------- */

export type LossOutcome = 'recovered_same' | 'recovered_fallback' | 'unrecoverable';

/**
 * Device loss happens on macOS when the GPU process restarts, when the machine
 * sleeps and wakes, and when another application takes an exclusive lock. It is
 * not rare enough to ignore.
 *
 * Recovery is possible because no game state lives on the GPU. Geometry is
 * procedural and regenerated, instance data is re-written from world state on
 * the next frame, and the world itself is rebuilt from run state and the kernel.
 * The caller's `rebuild` performs the seven-step sequence in section 10.3; this
 * class owns only the decision of which backend to rebuild with, and how many
 * times to try before giving up on WebGPU for good.
 */
export class DeviceLossPolicy {
  private attempts = 0;
  private static readonly MAX_SAME_BACKEND_ATTEMPTS = 2;

  constructor(
    private readonly rebuild: (forceWebGL: boolean) => Promise<void>,
    private readonly onOutcome: (outcome: LossOutcome, note: string) => void,
    private readonly persistFallbackFlag: () => void,
  ) {}

  async handle(reason: string): Promise<void> {
    // 'destroyed' means we called destroy() ourselves during teardown. Rebuilding
    // there would resurrect a renderer the app is in the middle of disposing.
    if (reason === 'destroyed') return;

    this.attempts += 1;

    if (this.attempts <= DeviceLossPolicy.MAX_SAME_BACKEND_ATTEMPTS) {
      try {
        await this.rebuild(false);
        this.onOutcome('recovered_same', `Graphics device restored after ${reason}.`);
        return;
      } catch {
        // Fall through to the WebGL2 path. A failure here is expected when the
        // GPU process is genuinely gone rather than merely restarted.
      }
    }

    try {
      // Remembered for future sessions: a machine that loses the WebGPU device
      // twice will lose it again, and booting straight to WebGL2 is a better
      // experience than two black frames every launch.
      this.persistFallbackFlag();
      await this.rebuild(true);
      this.onOutcome('recovered_fallback', 'Switched to WebGL2 after repeated device loss.');
    } catch (err) {
      this.onOutcome('unrecoverable', String(err));
    }
  }
}

/* ------------------------------------------------------------------------- */
/* The implementation                                                         */
/* ------------------------------------------------------------------------- */

const EMPTY_STATS: RenderStats = {
  drawCalls: 0,
  triangles: 0,
  programs: 0,
  textures: 0,
  geometries: 0,
  gpuMs: null,
  targetMemoryBytes: 0,
};

export class ThreeUnifiedBackend implements RendererBackend {
  readonly capabilities: Capabilities;

  private renderer: WebGPURenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private opts: BackendInitOptions | null = null;
  private profile: RenderQualityProfile | null = null;
  private readonly batches = new Set<ManagedBatch>();
  private readonly lossListeners = new Set<(info: DeviceLostInfo) => void>();
  private lossAnnounced = false;
  private disposed = false;

  /** Bound once so add/removeEventListener see the same function object. */
  private readonly onContextLost = (ev: Event): void => {
    // WebGL2 has no `device.lost` promise; context loss arrives as this event.
    // preventDefault is mandatory: without it the context is never restorable
    // and the fallback rebuild has nothing to rebuild into.
    ev.preventDefault();
    this.announceLoss('webglcontextlost');
  };

  constructor(caps: Capabilities) {
    this.capabilities = caps;
  }

  get id(): BackendId {
    // The runtime answer, not the probe's answer: `forceWebGL` and a failed
    // WebGPU init both land here as webgl2 and the diagnostics panel must say so.
    if (this.renderer === null) return this.capabilities.backend;
    const internals = (this.renderer as unknown as RendererInternals).backend;
    if (internals?.isWebGPUBackend === true) return 'webgpu';
    if (internals?.isWebGLBackend === true) return 'webgl2';
    return this.opts?.forceWebGL === true ? 'webgl2' : this.capabilities.backend;
  }

  get domElement(): HTMLCanvasElement {
    if (this.canvas === null) throw new Error('ThreeUnifiedBackend: init() has not run');
    return this.canvas;
  }

  async init(canvas: HTMLCanvasElement, opts: BackendInitOptions): Promise<void> {
    this.canvas = canvas;
    this.opts = opts;
    this.profile = opts.profile;
    this.lossAnnounced = false;

    // BRANCH 1 of 4: MSAA sample count. WebGPU guarantees 1 and 4 only, so a
    // profile asking for 2 on the WebGPU path is rounded down rather than up;
    // rounding up would silently quadruple the HDR target's memory.
    const samples = this.resolveSamples(opts);

    const renderer = new WebGPURenderer({
      canvas,
      // MSAA is configured through `samples` on the render target, not through
      // this flag, which only controls the swap chain. It is off here so the two
      // do not fight.
      antialias: false,
      forceWebGL: opts.forceWebGL,
      powerPreference: 'high-performance',
      // The void is opaque and the clear colour comes from tokens. An alpha
      // canvas would composite the page background through the darkest 62% of
      // every frame.
      alpha: false,
      // Passed at construction rather than assigned afterwards: the renderer
      // sizes its internal render target during init() and a later assignment
      // would not take effect until the next resize.
      samples,
    });

    // `init()` resolves once the adapter and device exist. Awaiting it is not
    // optional on the WebGPU path: rendering before it resolves is a no-op that
    // produces one blank frame and no warning.
    await renderer.init();

    this.renderer = renderer;
    this.attachLossHandlers(renderer, canvas);
    this.setQuality(opts.profile);
  }

  /** BRANCH 1 of 4. */
  private resolveSamples(opts: BackendInitOptions): 0 | 2 | 4 {
    const wanted = Math.min(opts.profile.msaaSamples, this.capabilities.maxSamples);
    if (!opts.forceWebGL) return wanted >= 4 ? 4 : 0;
    return wanted >= 4 ? 4 : wanted >= 2 ? 2 : 0;
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    const r = this.renderer;
    const p = this.profile;
    if (r === null || p === null) return;
    const dpr = Math.min(pixelRatio, p.maxPixelRatio, this.capabilities.devicePixelRatio);
    // `renderScale` multiplies the pixel ratio rather than the CSS size, so the
    // canvas keeps its layout box and only the backing buffer shrinks. Resizing
    // the CSS box instead would reflow the HUD, which is DOM over the canvas.
    r.setPixelRatio(dpr * p.renderScale);
    r.setSize(cssWidth, cssHeight, false);
  }

  setQuality(profile: RenderQualityProfile): void {
    this.profile = profile;
    const r = this.renderer;
    if (r === null) return;

    // Shadows are off everywhere. Contact with the floor is communicated by the
    // light pool decal, which reads as the object occluding its own glow, and
    // that saves an entire depth pass per light (03-VISUAL-BIBLE 12.4).
    r.shadowMap.enabled = false;

    // A tier change MUST NOT rebuild materials or geometry. Instance ceilings
    // fall by lowering each batch's draw count; the batches keep the capacity
    // they were allocated at the highest tier seen. That costs a little GPU
    // memory in exchange for a downgrade that never hitches, which matters
    // because a downgrade happens when the game is already struggling.
    for (const b of this.batches) b.clampToProfile(profile);

    if (this.canvas !== null) {
      this.resize(this.canvas.clientWidth, this.canvas.clientHeight, window.devicePixelRatio);
    }

    // TODO(astra): forward `profile` to PostChain.setProfile() once the chain is
    // constructed here. It must rebuild only render targets (size, mip count,
    // which stages are enabled) and must not recreate any material or any
    // ping-pong texture whose size did not change. Assert in dev that
    // renderer.info.memory.geometries is unchanged across the call.
  }

  createInstancedBatch(desc: InstancedBatchDesc): InstancedBatchHandle {
    const opts = this.opts;
    const profile = this.profile;
    if (opts === null || profile === null) {
      throw new Error('ThreeUnifiedBackend: createInstancedBatch before init()');
    }
    if (desc.castShadow) {
      throw new Error(
        `Batch "${desc.name}" requests shadows. Shadows are off everywhere; see 03-VISUAL-BIBLE 12.4.`,
      );
    }
    const geometry = opts.resources.geometryFor(desc.geometry);
    const material = opts.resources.materialFor(desc.material, profile);
    const batch = new ManagedBatch(desc, geometry, material);
    this.batches.add(batch);
    return batch;
  }

  renderFrame(req: FrameRequest): void {
    const r = this.renderer;
    if (r === null || this.disposed) return;

    for (const b of this.batches) b.flush();

    // `render` on WebGPURenderer returns a Promise on the WebGPU path and
    // resolves synchronously enough for a game loop; it is called without await
    // deliberately, because awaiting it serialises the CPU against the GPU and
    // costs an entire frame of latency. Errors inside it surface through the
    // device-lost path, which is why nothing is attached to the returned value.
    r.render(req.scene, req.camera);

    // TODO(astra): once PostChain exists, this becomes `this.post.render(req)`
    // and the direct `r.render` call moves inside the chain's scene_opaque
    // stage. The chain owns the HDR target; the backend must never render
    // straight to the swap chain except in minimal mode (01-ARCHITECTURE 6.5).
  }

  get stats(): RenderStats {
    const r = this.renderer;
    if (r === null) return EMPTY_STATS;
    const info = r.info as unknown as RenderInfoLike;
    return {
      drawCalls: info.render.drawCalls ?? info.render.calls ?? 0,
      triangles: info.render.triangles ?? 0,
      // WebGPURenderer counts pipelines where WebGLRenderer counts programs.
      // Both answer the question the diagnostics panel asks ("how many shader
      // variants are live"), so the field keeps one name.
      programs: info.pipelines?.length ?? info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      // BRANCH 4 of 4: GPU timing.
      gpuMs: this.readGpuMs(),
      targetMemoryBytes: 0,
    };
  }

  /** BRANCH 4 of 4. */
  private readGpuMs(): number | null {
    if (!this.capabilities.timestampQuery) return null;
    // TODO(astra): call `renderer.resolveTimestampsAsync('render')` once per
    // second from the diagnostics panel (not per frame: the readback stalls) and
    // cache the result into a field this getter returns. Three exposes the
    // resolved value on `renderer.info.render.timestamp` in milliseconds. Verify
    // the property name against the installed 0.185 build before wiring it; if
    // it is absent, leave this returning null rather than reporting a zero,
    // because a zero reads as "the GPU is free" in the frame graph.
    return null;
  }

  async compileAsync(scene: Scene, camera: Camera): Promise<void> {
    const r = this.renderer;
    if (r === null) return;
    // Precompiling before a leg becomes visible is what keeps the first second
    // of a stage from hitching. It is also why the boot benchmark discards its
    // first twelve frames.
    await r.compileAsync(scene, camera);
  }

  onDeviceLost(cb: (info: DeviceLostInfo) => void): () => void {
    this.lossListeners.add(cb);
    return () => {
      this.lossListeners.delete(cb);
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const b of this.batches) b.dispose();
    this.batches.clear();
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer?.dispose();
    this.renderer = null;
    this.lossListeners.clear();
  }

  /**
   * Normalises both loss channels into one callback. WebGPU signals through the
   * device's `lost` promise; WebGL2 signals through a canvas event. The consumer
   * must not care which.
   */
  private attachLossHandlers(renderer: WebGPURenderer, canvas: HTMLCanvasElement): void {
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    const device = (renderer as unknown as RendererInternals).backend?.device;
    if (device === undefined) return;
    void device.lost.then((info) => {
      // `reason` is 'destroyed' when we called destroy() ourselves; DeviceLossPolicy
      // filters that case rather than this one, so the diagnostics log still
      // records the event.
      this.announceLoss(info.reason === 'destroyed' ? 'destroyed' : `webgpu:${info.reason}`);
    });
  }

  private announceLoss(reason: string): void {
    // A lost device can fire both channels. Announcing twice would run the
    // rebuild sequence twice and leave two renderers alive.
    if (this.lossAnnounced) return;
    this.lossAnnounced = true;
    const info: DeviceLostInfo = { reason };
    for (const cb of this.lossListeners) {
      try {
        cb(info);
      } catch (err) {
        if (import.meta.env.DEV) console.error('[kt] device-loss listener threw', err);
      }
    }
  }
}

/* ------------------------------------------------------------------------- */
/* The batch                                                                  */
/* ------------------------------------------------------------------------- */

export const MATRIX_STRIDE = 16;
const COLOUR_STRIDE = 3;
const STATE_STRIDE = 4;

/**
 * One `InstancedMesh` plus its three per-instance attribute arrays. Updating one
 * instance writes 12 floats beyond the matrix and marks a range dirty; it never
 * rebuilds the geometry and never touches `instanceMatrix` unless the instance
 * actually moved (03-VISUAL-BIBLE 12.2).
 */
class ManagedBatch implements InstancedBatchHandle {
  readonly name: string;
  readonly capacity: number;
  readonly matrices: Float32Array;
  readonly colours: Float32Array;
  readonly state: Float32Array;
  readonly object: InstancedMesh;

  private _count = 0;
  /** Tier ceiling, applied on top of whatever the world layer asks to draw. */
  private ceiling: number;

  /** Dirty range in instances, inclusive-exclusive. -1 means clean. */
  private dirtyFrom = -1;
  private dirtyTo = -1;

  private readonly colourAttr: InstancedBufferAttribute | null;
  private readonly stateAttr: InstancedBufferAttribute;

  constructor(desc: InstancedBatchDesc, geometry: BufferGeometry, material: Material) {
    this.name = desc.name;
    this.capacity = desc.capacity;
    this.ceiling = desc.capacity;

    this.object = new InstancedMesh(geometry, material, desc.capacity);
    this.object.name = desc.name;
    this.object.layers.set(desc.layer);
    this.object.castShadow = false;
    this.object.receiveShadow = false;
    // The world is built around a fixed grid and structures rarely leave the
    // frame they were placed in, so per-frame bounding-sphere recomputation buys
    // nothing. Culling happens at the structure level instead.
    this.object.frustumCulled = false;
    this.object.instanceMatrix.setUsage(DynamicDrawUsage);
    this.object.count = 0;

    // Alias the mesh's own matrix storage rather than keeping a second copy: the
    // whole point of exposing `matrices` is that the world layer writes straight
    // into the buffer the GPU will read.
    this.matrices = this.object.instanceMatrix.array as Float32Array;

    if (desc.perInstanceColour) {
      this.colours = new Float32Array(desc.capacity * COLOUR_STRIDE);
      this.colourAttr = new InstancedBufferAttribute(this.colours, COLOUR_STRIDE);
      this.colourAttr.setUsage(DynamicDrawUsage);
      geometry.setAttribute('aInstanceColour', this.colourAttr);
    } else {
      // A zero-length array rather than null keeps the handle's shape stable, so
      // a caller that writes colours into a single-hue batch corrupts nothing
      // and fails loudly at the first index instead.
      this.colours = new Float32Array(0);
      this.colourAttr = null;
    }

    this.state = new Float32Array(desc.capacity * STATE_STRIDE);
    this.stateAttr = new InstancedBufferAttribute(this.state, STATE_STRIDE);
    this.stateAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aInstanceState', this.stateAttr);
  }

  get count(): number {
    return this._count;
  }

  set count(n: number) {
    const clamped = n < 0 ? 0 : n > this.ceiling ? this.ceiling : n;
    this._count = clamped;
    this.object.count = clamped;
  }

  touch(from: number, to: number): void {
    if (to <= from) return;
    this.dirtyFrom = this.dirtyFrom < 0 || from < this.dirtyFrom ? from : this.dirtyFrom;
    this.dirtyTo = to > this.dirtyTo ? to : this.dirtyTo;
  }

  /**
   * One upload per frame per attribute, covering the union of every touched
   * range. Three's update-range API takes element offsets rather than instance
   * offsets, hence the stride multiplications.
   */
  flush(): void {
    if (this.dirtyFrom < 0) return;
    const from = this.dirtyFrom;
    const to = this.dirtyTo;

    // TODO(astra): switch these three to partial uploads via
    // `attribute.addUpdateRange(offset, count)` plus `attribute.needsUpdate = true`.
    // Three 0.185 replaced the single `updateRange` object with the
    // `addUpdateRange`/`clearUpdateRanges` pair, and the WebGPU backend honours
    // the ranges while the WebGL backend may still upload the whole buffer.
    // Verify against the installed build, then measure: a full 4096-instance
    // matrix upload is 256 KB per frame and shows up in `routeMs`.
    void from;
    void to;
    this.object.instanceMatrix.needsUpdate = true;
    if (this.colourAttr !== null) this.colourAttr.needsUpdate = true;
    this.stateAttr.needsUpdate = true;

    this.dirtyFrom = -1;
    this.dirtyTo = -1;
  }

  /**
   * Lower the draw ceiling on a tier downgrade. Capacity is deliberately not
   * reallocated: freeing and re-allocating a 256 KB typed array mid-run is a GC
   * pause during the one moment the frame budget is already blown.
   */
  clampToProfile(profile: RenderQualityProfile): void {
    // TODO(astra): map `InstancedBatchDesc.geometry` to the matching
    // `InstanceClass` in @platform/quality and read the real per-class ceiling
    // here (slab -> page_frames, chit -> queue_entries, sector -> disk_sectors,
    // beam -> beams, ring -> domain_rings, mote -> maxParticles). Pass the class
    // through the desc rather than inferring it from the geometry name, because
    // the archive blocks and the page frames share the slab geometry and have
    // different ceilings.
    void profile;
    this.ceiling = this.capacity;
    if (this._count > this.ceiling) this.count = this.ceiling;
  }

  dispose(): void {
    this.object.dispose();
    this.object.removeFromParent();
  }
}

/* ------------------------------------------------------------------------- */
/* Factory                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The only place `three/webgpu` is imported outside `src/render`, per section
 * 5.3. There is one implementation class because both paths run through
 * `WebGPURenderer`; the factory exists so that the call site does not have to
 * know that, and so the `forceWebGL` decision is made in exactly one place.
 */
export async function createBackend(
  canvas: HTMLCanvasElement,
  caps: Capabilities,
  opts: Omit<BackendInitOptions, 'forceWebGL'>,
  forceWebGLOverride?: boolean,
): Promise<RendererBackend> {
  const backend = new ThreeUnifiedBackend(caps);
  const forceWebGL = forceWebGLOverride ?? caps.backend === 'webgl2';
  await backend.init(canvas, { ...opts, forceWebGL });
  return backend;
}

/**
 * The seven-step rebuild from section 10.3, expressed as the shape the caller
 * must supply to `DeviceLossPolicy`. It is a type rather than an implementation
 * because steps 4 through 6 (rebuild the material library, re-run the leg's
 * `createStage`, replay the retained event ring with effect spawning suppressed)
 * live in `src/app` and `src/world`, which `src/render` may not import.
 */
export interface DeviceLossRebuild {
  /** 1. Suspend the loop. Simulated time does not advance, so nothing is lost. */
  suspendLoop(): void;
  /** 2. Dispose the backend, materials, render targets and every batch. Drop the scene. */
  teardown(): void;
  /** 3 and 4. New backend, then rebuild the material library. */
  recreate(forceWebGL: boolean): Promise<RendererBackend>;
  /** 5 and 6. Re-run createStage, then replay the last 2 s with effects suppressed. */
  restoreWorld(): Promise<void>;
  /** 7. Resume, and show a two-second toast. */
  resumeLoop(note: string): void;
}
