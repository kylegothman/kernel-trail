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
import type { QualityTier } from './quality';
export type { QualityTier } from './quality';

/** The tier ladder, lowest first. Exported because the governor walks it. */
export const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];

export interface RenderCapabilities {
  readonly backend: BackendId;
  /** WebGPU only. Drives GPU particle integration. */
  readonly compute: boolean;
  readonly storageBuffers: boolean;
  /** Multisample count usable on the HDR target. 1 means no MSAA. */
  readonly maxSamples: 1 | 2 | 4;
  readonly float32Filterable: boolean;
  readonly float16Renderable: boolean;
  readonly hdr: boolean;
  readonly maxTextureSize: number;
  readonly maxInstances: number;
  /** WebGPU timestamp queries, for the in-game GPU frame graph. */
  readonly timestampQuery: boolean;
  /** `navigator.deviceMemory`, in GB, when the browser exposes it. */
  readonly deviceMemoryGb: number | null;
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
async function detectFreshCapabilities(forceWebGL = false): Promise<CapabilityProbeResult> {
  const warnings: string[] = [];

  // Cap DPR at 2. Beyond that the pixel count grows faster than the perceived
  // sharpness on any display this game will run on, and the post chain is
  // resolution-bound.
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  const deviceMemoryGb = readDeviceMemoryGb();

  const gpu = (navigator as NavigatorWithGpu).gpu;
  if (!forceWebGL && gpu !== undefined) {
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
          hdr: true,
          maxTextureSize: adapter.limits.maxTextureDimension2D,
          maxInstances: 1_000_000,
          timestampQuery: adapter.features.has('timestamp-query'),
          deviceMemoryGb,
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
    hardwareConcurrency,
    prefersReducedMotion,
    devicePixelRatio,
  }), warnings };
}

/** Kept under the architecture document's name so section 5.2 is greppable. */
export async function detectCapabilities(buildId = 'v1', forceWebGL = false): Promise<CapabilityProbeResult> {
  const key = `${buildId}|${navigator.userAgent}|${forceWebGL}`;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('kt.caps.v1') ?? 'null');
    if (isCachedProbe(raw, key)) return { ...raw.result, caps: { ...raw.result.caps, devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2), prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches } };
  } catch { /* Blocked storage does not prevent rendering. */ }
  const result = await detectFreshCapabilities(forceWebGL);
  try { localStorage.setItem('kt.caps.v1', JSON.stringify({ key, result })); } catch { /* optional cache */ }
  return result;
}
function isCachedProbe(value: unknown, key: string): value is { key: string; result: CapabilityProbeResult } {
  if (typeof value !== 'object' || value === null || !('key' in value) || value.key !== key || !('result' in value)) return false;
  const result = value.result;
  if (typeof result !== 'object' || result === null || !('caps' in result) || !('warnings' in result)) return false;
  const caps = result.caps;
  if (typeof caps !== 'object' || caps === null) return false;
  const c = caps as Record<string, unknown>;
  return (c['backend'] === 'webgpu' || c['backend'] === 'webgl2') &&
    [1, 2, 4].includes(Number(c['maxSamples'])) &&
    ['compute','storageBuffers','float32Filterable','float16Renderable','hdr','timestampQuery','isIntegrated','prefersReducedMotion'].every(k => typeof c[k] === 'boolean') &&
    ['maxTextureSize','maxInstances','hardwareConcurrency','devicePixelRatio'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k])) &&
    (c['deviceMemoryGb'] === null || typeof c['deviceMemoryGb'] === 'number') && typeof c['adapterLabel'] === 'string' &&
    Array.isArray(result.warnings) && result.warnings.every(w => typeof w === 'string');
}
export const probeCapabilities = detectCapabilities;

interface HostFacts {
  readonly deviceMemoryGb: number | null;
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
    hdr: colorBufferFloat,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxInstances: 65_536,
    timestampQuery: false,
    deviceMemoryGb: host.deviceMemoryGb,
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


export { selectTier, selectQualityTier, setUserTier, clearTierCache } from './tierSelect';
export type { TierDecision } from './tierSelect';
