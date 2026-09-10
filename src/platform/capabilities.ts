/**
 * KERNEL TRAIL: boot capability probe and quality tier selection.
 *
 * Implements 01-ARCHITECTURE sections 5.2 and 6.3. This module runs exactly once
 * per boot, before the renderer exists, and it is the only place in the codebase
 * that touches `navigator.gpu` directly. Everything downstream branches on the
 * `Capabilities` record rather than re-probing, because a second
 * `requestAdapter()` on some drivers returns a different adapter and the game
 * would then be configured for hardware it is not running on.
 *
 * The probe must never throw for a reason other than "this browser cannot run
 * the game at all". A missing extension is a warning and a degraded path; only
 * the absence of both WebGPU and WebGL2 is fatal, and it raises
 * `UnsupportedBrowserError` so `src/app` can show the fallback screen from
 * 01-ARCHITECTURE section 10.6.
 *
 * `@webgpu/types` is in tsconfig `types`, so `GPU`, `GPUAdapter` and friends are
 * ambient here without an import.
 */

/* ------------------------------------------------------------------------- */
/* Public shape                                                               */
/* ------------------------------------------------------------------------- */

export type BackendId = 'webgpu' | 'webgl2';
export type QualityTier = 'low' | 'medium' | 'high';

/** The tier ladder, lowest first. Exported because the governor walks it. */
export const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];

export interface RenderCapabilities {
  readonly backend: BackendId;
  /** WebGPU only. Drives GPU particle integration and the histogram pass. */
  readonly compute: boolean;
  readonly storageBuffers: boolean;
  /** Multisample count usable on the HDR target. 1 means no MSAA. */
  readonly maxSamples: 1 | 2 | 4;
  readonly float32Filterable: boolean;
  readonly float16Renderable: boolean;
  readonly maxTextureSize: number;
  readonly maxInstances: number;
  /** WebGPU timestamp queries, for the in-game GPU frame graph. */
  readonly timestampQuery: boolean;
  /** `navigator.deviceMemory`, in GB, when the browser exposes it. */
  readonly deviceMemoryGb: number | null;
  /**
   * `performance.memory.jsHeapSizeLimit` in bytes, Chromium only. A hint, not a
   * budget: it reports the heap ceiling, not what is available. Used only to
   * warn when the section 7.2 ceiling would not fit.
   */
  readonly jsHeapLimitBytes: number | null;
  readonly hardwareConcurrency: number;
  readonly adapterLabel: string;
  readonly isIntegrated: boolean;
  readonly prefersReducedMotion: boolean;
  readonly devicePixelRatio: number;
}

/** The task-facing alias. Same record; shorter to read at call sites. */
export type Capabilities = RenderCapabilities;

export interface CapabilityProbeResult {
  readonly caps: RenderCapabilities;
  /** Non-fatal problems worth showing in the diagnostics panel. */
  readonly warnings: readonly string[];
}

export class UnsupportedBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedBrowserError';
  }
}

/* ------------------------------------------------------------------------- */
/* Narrowing helpers for the parts of the platform TypeScript does not model   */
/* ------------------------------------------------------------------------- */

interface NavigatorWithGpu {
  readonly gpu?: GPU;
}

interface NavigatorWithDeviceMemory {
  readonly deviceMemory?: number;
}

interface PerformanceWithMemory {
  readonly memory?: { readonly jsHeapSizeLimit?: number };
}

/**
 * The adapter identity surface has moved twice. The original spec had
 * `adapter.requestAdapterInfo(): Promise<GPUAdapterInfo>`; the current spec
 * exposes a synchronous `adapter.info`. Shipping browsers exist for both, so
 * both are probed and neither is assumed.
 */
interface AdapterInfoBearing {
  readonly info?: GPUAdapterInfo;
  readonly requestAdapterInfo?: () => Promise<GPUAdapterInfo> | GPUAdapterInfo;
}

interface AdapterIdentity {
  readonly label: string;
  readonly integrated: boolean;
}

/**
 * Assuming integrated is the safe default for a game that targets a MacBook Air:
 * an integrated GPU misidentified as discrete boots at `high` and stutters,
 * which is worse than a discrete GPU misidentified as integrated and offered an
 * upgrade thirty seconds later.
 */
const UNKNOWN_ADAPTER: AdapterIdentity = { label: 'webgpu', integrated: true };

const INTEGRATED_PATTERN = /intel|apple|adreno|mali|powervr|iris|uhd|llvmpipe|swiftshader|software/i;

async function readAdapterIdentity(adapter: GPUAdapter): Promise<AdapterIdentity> {
  const bearer = adapter as unknown as AdapterInfoBearing;
  let info: GPUAdapterInfo | undefined = bearer.info;
  if (info === undefined && typeof bearer.requestAdapterInfo === 'function') {
    try {
      info = await bearer.requestAdapterInfo();
    } catch {
      info = undefined;
    }
  }
  if (info === undefined) return UNKNOWN_ADAPTER;

  // `description` is the most specific field where it exists; `device` and
  // `vendor` are the fields the current spec guarantees, and they are often
  // empty strings on privacy-conscious builds, which is why the fallback chain
  // ends at the unknown label rather than at an empty one.
  const parts = [info.description, info.device, info.architecture, info.vendor].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const label = parts.length > 0 ? parts.join(' ') : UNKNOWN_ADAPTER.label;
  return { label, integrated: INTEGRATED_PATTERN.test(label) || parts.length === 0 };
}

function clampSamples(n: number): 1 | 2 | 4 {
  return n >= 4 ? 4 : n >= 2 ? 2 : 1;
}

function readDeviceMemoryGb(): number | null {
  const n = navigator as NavigatorWithDeviceMemory;
  return typeof n.deviceMemory === 'number' ? n.deviceMemory : null;
}

function readJsHeapLimit(): number | null {
  const p = performance as PerformanceWithMemory;
  const limit = p.memory?.jsHeapSizeLimit;
  return typeof limit === 'number' ? limit : null;
}

/* ------------------------------------------------------------------------- */
/* The probe                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Probe once at boot. Prefers WebGPU; falls back to WebGL2; throws only when
 * neither exists.
 *
 * The WebGPU branch requests an adapter rather than merely checking that
 * `navigator.gpu` is defined, because Safari and Firefox both ship the property
 * in configurations where no adapter is ever returned. A present-but-useless
 * `navigator.gpu` that is treated as WebGPU support produces a black canvas and
 * no error, which is the worst failure mode available.
 */
export async function detectCapabilities(): Promise<CapabilityProbeResult> {
  const warnings: string[] = [];

  // Cap DPR at 2. Beyond that the pixel count grows faster than the perceived
  // sharpness on any display this game will run on, and the post chain is
  // resolution-bound.
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  const deviceMemoryGb = readDeviceMemoryGb();
  const jsHeapLimitBytes = readJsHeapLimit();

  const gpu = (navigator as NavigatorWithGpu).gpu;
  if (gpu !== undefined) {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter !== null) {
        const identity = await readAdapterIdentity(adapter);
        const caps: RenderCapabilities = {
          backend: 'webgpu',
          compute: true,
          storageBuffers: true,
          // WebGPU guarantees sampleCount 1 and 4 only. There is no 2x path.
          maxSamples: 4,
          float32Filterable: adapter.features.has('float32-filterable'),
          // rgba16float is renderable and blendable in core WebGPU, no feature needed.
          float16Renderable: true,
          maxTextureSize: adapter.limits.maxTextureDimension2D,
          maxInstances: 1_000_000,
          timestampQuery: adapter.features.has('timestamp-query'),
          deviceMemoryGb,
          jsHeapLimitBytes,
          hardwareConcurrency,
          adapterLabel: identity.label,
          isIntegrated: identity.integrated,
          prefersReducedMotion,
          devicePixelRatio,
        };
        if (!caps.timestampQuery) {
          warnings.push('No timestamp-query: the diagnostics frame graph will show CPU time only.');
        }
        return { caps, warnings };
      }
      warnings.push('navigator.gpu present but no adapter was returned. Falling back to WebGL2.');
    } catch (err) {
      warnings.push(`WebGPU adapter request failed: ${String(err)}`);
    }
  }

  return { caps: probeWebGL2(warnings, {
    deviceMemoryGb,
    jsHeapLimitBytes,
    hardwareConcurrency,
    prefersReducedMotion,
    devicePixelRatio,
  }), warnings };
}

/** Kept under the architecture document's name so section 5.2 is greppable. */
export const probeCapabilities = detectCapabilities;

interface HostFacts {
  readonly deviceMemoryGb: number | null;
  readonly jsHeapLimitBytes: number | null;
  readonly hardwareConcurrency: number;
  readonly prefersReducedMotion: boolean;
  readonly devicePixelRatio: number;
}

function probeWebGL2(warnings: string[], host: HostFacts): RenderCapabilities {
  const canvas = document.createElement('canvas');
  // A 1x1 probe context. `antialias: false` because we only read parameters, and
  // requesting MSAA here can pick a different config than the real context will.
  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
  if (gl === null) {
    throw new UnsupportedBrowserError(
      'KERNEL TRAIL needs WebGL2 or WebGPU. Neither is available in this browser.',
    );
  }

  // WEBGL_debug_renderer_info is gated behind a privacy setting in Firefox and
  // removed entirely in some builds. Its absence costs us the tier heuristic's
  // precision, not its correctness, because the benchmark still runs.
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const label =
    dbg !== null ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'webgl2 (renderer masked)';

  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null;
  const floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
  if (!colorBufferFloat) {
    warnings.push(
      'No EXT_color_buffer_float: the HDR target falls back to 8-bit and bloom will band. ' +
        'See 01-ARCHITECTURE section 5.4.',
    );
  }

  const caps: RenderCapabilities = {
    backend: 'webgl2',
    compute: false,
    storageBuffers: false,
    maxSamples: clampSamples(gl.getParameter(gl.MAX_SAMPLES) as number),
    float32Filterable: floatLinear,
    float16Renderable: colorBufferFloat,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxInstances: 65_536,
    timestampQuery: false,
    deviceMemoryGb: host.deviceMemoryGb,
    jsHeapLimitBytes: host.jsHeapLimitBytes,
    hardwareConcurrency: host.hardwareConcurrency,
    adapterLabel: label,
    isIntegrated: dbg !== null ? INTEGRATED_PATTERN.test(label) : true,
    prefersReducedMotion: host.prefersReducedMotion,
    devicePixelRatio: host.devicePixelRatio,
  };

  // Release the probe context promptly. Browsers cap live WebGL contexts (16 on
  // Chrome) and the real renderer needs one of them.
  const loseContext = gl.getExtension('WEBGL_lose_context');
  loseContext?.loseContext();
  canvas.remove();
  return caps;
}

/* ------------------------------------------------------------------------- */
/* The boot benchmark                                                         */
/* ------------------------------------------------------------------------- */

/** A function that returns the median frame time, in milliseconds, of a probe scene. */
export type BenchmarkFn = (caps: RenderCapabilities) => Promise<number>;

const BENCH_WARMUP_FRAMES = 12;
const BENCH_MEASURED_FRAMES = 30;

/**
 * A fill-rate and draw-submission probe, used when the real scene-shaped
 * benchmark is unavailable (the renderer is not built yet at this point in boot,
 * and building one just to measure it costs more than it saves).
 *
 * It measures the thing that actually decides this game's tier: how fast the GPU
 * can run a moderately long fragment shader over a full 960x600 target,
 * repeatedly, which is what the post chain does. It deliberately does NOT
 * measure vertex throughput, because the art is procedural emissive geometry
 * with per-form triangle budgets under 100 and vertex cost is never the limit.
 *
 * Median rather than mean, because a single shader-compile hitch or GC pause
 * should not decide the tier for the life of the device.
 */
export async function defaultBootBenchmark(caps: RenderCapabilities): Promise<number> {
  const W = 960;
  const H = 600;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
  if (gl === null) throw new Error('benchmark: no webgl2 context');

  const vs = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  // The loop count is chosen so that this shader costs a few hundred
  // microseconds on the reference machine. It is arithmetic-heavy and
  // texture-free on purpose: bandwidth varies far more between devices than ALU
  // throughput does, and a bandwidth-bound probe misjudges tile-based GPUs.
  const fs = `#version 300 es
    precision highp float;
    in vec2 vUv;
    uniform float uSeed;
    out vec4 fragColor;
    void main() {
      vec3 acc = vec3(0.0);
      vec2 p = vUv * 8.0 + uSeed;
      for (int i = 0; i < 48; i++) {
        p = abs(p) / dot(p, p) - 0.72;
        acc += vec3(p.x, p.y, p.x * p.y) * 0.02;
      }
      fragColor = vec4(acc, 1.0);
    }`;

  const program = buildProgram(gl, vs, fs);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(program);
  const uSeed = gl.getUniformLocation(program, 'uSeed');
  gl.viewport(0, 0, W, H);

  const samples: number[] = [];
  const total = BENCH_WARMUP_FRAMES + BENCH_MEASURED_FRAMES;
  for (let frame = 0; frame < total; frame++) {
    const t0 = performance.now();
    gl.uniform1f(uSeed, frame * 0.013);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // `finish` is the only synchronisation WebGL2 offers without a fence
    // extension. Some drivers treat it as a hint, which is precisely why the
    // result is a median over 30 frames and why the tier thresholds have wide
    // bands rather than sharp cutoffs.
    gl.finish();
    const ms = performance.now() - t0;
    if (frame >= BENCH_WARMUP_FRAMES) samples.push(ms);
    // Yield to the event loop so the browser can schedule the next frame the way
    // it will during the game, rather than measuring a tight synchronous loop.
    await nextFrame();
  }

  gl.deleteBuffer(quad);
  gl.deleteProgram(program);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  canvas.remove();

  samples.sort((a, b) => a - b);
  const mid = samples[samples.length >> 1];
  if (mid === undefined) throw new Error('benchmark: no samples collected');

  // The probe shader is roughly one third of a real high-tier frame's fragment
  // cost, so the reading is scaled to a whole-frame estimate before it meets the
  // thresholds in `selectQualityTier`. The WebGL2 path additionally carries
  // higher per-frame CPU cost that this probe cannot see, which is why that path
  // is capped at medium separately rather than penalised here.
  void caps;
  return mid * 3;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function buildProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (sh === null) throw new Error('benchmark: createShader returned null');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? 'unknown';
      gl.deleteShader(sh);
      throw new Error(`benchmark: shader compile failed: ${log}`);
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (program === null) throw new Error('benchmark: createProgram returned null');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown';
    gl.deleteProgram(program);
    throw new Error(`benchmark: program link failed: ${log}`);
  }
  return program;
}

/* ------------------------------------------------------------------------- */
/* Tier selection (01-ARCHITECTURE 6.3)                                       */
/* ------------------------------------------------------------------------- */

export interface TierDecision {
  readonly tier: QualityTier;
  readonly by: 'cache' | 'user' | 'benchmark' | 'heuristic' | 'fallback';
  readonly medianFrameMs: number | null;
  readonly notes: string;
}

const TIER_CACHE_KEY = 'kt.tier.v1';

/** Benchmark thresholds, in estimated whole-frame milliseconds. */
const HIGH_MS = 6.0;
const MEDIUM_MS = 11.0;

/**
 * Order of evidence: cached choice, then explicit user choice, then benchmark,
 * then heuristic. The cache is keyed on the adapter label, the user agent and
 * the build id, so a driver update, a machine change or a shipping change all
 * invalidate it and nothing else does.
 */
export async function selectQualityTier(
  caps: RenderCapabilities,
  buildId: string,
  runBenchmark: BenchmarkFn = defaultBootBenchmark,
): Promise<TierDecision> {
  const cached = readTierCache(caps, buildId);
  if (cached !== null) return cached;

  // Heuristic prior. Used directly if the benchmark cannot run, and it is also
  // the honest answer for a device whose adapter we could not identify.
  const prior: QualityTier =
    caps.backend === 'webgl2' ? 'low' : caps.isIntegrated ? 'medium' : 'high';

  let medianMs: number | null = null;
  try {
    medianMs = await runBenchmark(caps);
  } catch (err) {
    const decision: TierDecision = {
      tier: prior,
      by: 'heuristic',
      medianFrameMs: null,
      notes: `Benchmark failed to run (${String(err)}); used adapter heuristic.`,
    };
    writeTierCache(caps, buildId, decision);
    return decision;
  }

  const measured: QualityTier = medianMs <= HIGH_MS ? 'high' : medianMs <= MEDIUM_MS ? 'medium' : 'low';

  // Never promote a WebGL2 device above medium at boot. The fallback path has
  // higher per-frame CPU cost (instance state as vertex attributes rather than
  // storage buffers) that a GPU-bound benchmark under-represents.
  let tier: QualityTier = caps.backend === 'webgl2' && measured === 'high' ? 'medium' : measured;

  // Memory hints are a veto, never a promotion. Section 7.2's ceiling does not
  // fit comfortably under 4 GB of device memory once the browser's own
  // allocations are counted.
  if (caps.deviceMemoryGb !== null && caps.deviceMemoryGb <= 4 && tier === 'high') {
    tier = 'medium';
  }

  const decision: TierDecision = {
    tier,
    by: 'benchmark',
    medianFrameMs: medianMs,
    notes: `${caps.adapterLabel} estimated ${medianMs.toFixed(2)} ms/frame`,
  };
  writeTierCache(caps, buildId, decision);
  return decision;
}

/** Kept under the architecture document's name so section 6.3 is greppable. */
export const selectTier = selectQualityTier;

/**
 * Record a manual choice so the next boot honours it without benchmarking.
 * `prefersReducedMotion` deliberately does not appear anywhere in tier
 * selection: motion settings and quality settings are separate axes and MUST
 * NOT be conflated (01-ARCHITECTURE 6.3).
 */
export function setUserTier(caps: RenderCapabilities, buildId: string, tier: QualityTier): TierDecision {
  const decision: TierDecision = {
    tier,
    by: 'user',
    medianFrameMs: null,
    notes: 'Chosen by the player in settings.',
  };
  writeTierCache(caps, buildId, decision);
  return decision;
}

interface CachedTier {
  readonly key: string;
  readonly tier: QualityTier;
  readonly by: TierDecision['by'];
  readonly medianFrameMs: number | null;
  readonly notes: string;
}

function cacheKey(caps: RenderCapabilities, buildId: string): string {
  return `${buildId}|${caps.backend}|${caps.adapterLabel}|${navigator.userAgent}`;
}

function isQualityTier(v: unknown): v is QualityTier {
  return v === 'low' || v === 'medium' || v === 'high';
}

function readTierCache(caps: RenderCapabilities, buildId: string): TierDecision | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(TIER_CACHE_KEY);
  } catch {
    // Private browsing modes throw on access rather than returning null.
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const c = parsed as Partial<CachedTier>;
  if (c.key !== cacheKey(caps, buildId)) return null;
  if (!isQualityTier(c.tier)) return null;

  // A cached user choice keeps its provenance; anything else reports as 'cache'
  // so the diagnostics panel can tell a remembered benchmark from a fresh one.
  return {
    tier: c.tier,
    by: c.by === 'user' ? 'user' : 'cache',
    medianFrameMs: typeof c.medianFrameMs === 'number' ? c.medianFrameMs : null,
    notes: typeof c.notes === 'string' ? c.notes : 'Restored from cache.',
  };
}

function writeTierCache(caps: RenderCapabilities, buildId: string, d: TierDecision): void {
  const payload: CachedTier = {
    key: cacheKey(caps, buildId),
    tier: d.tier,
    by: d.by,
    medianFrameMs: d.medianFrameMs,
    notes: d.notes,
  };
  try {
    window.localStorage.setItem(TIER_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full or blocked. The benchmark simply runs again next boot, which
    // costs 400 ms of a screen the player is reading anyway.
  }
}

/** Drop the cached decision. Called by the diagnostics panel's "re-detect" action. */
export function clearTierCache(): void {
  try {
    window.localStorage.removeItem(TIER_CACHE_KEY);
  } catch {
    /* nothing to do; see writeTierCache */
  }
}
