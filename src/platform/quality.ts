/**
 * KERNEL TRAIL: the three quality profiles.
 *
 * Transcribed from 01-ARCHITECTURE sections 6.1 and 6.2.
 *
 * SCAFFOLD NOTE. This file was not on the scaffold list, but `RendererBackend`,
 * `postChain` and any consumer of `QualityGovernor` all need `RenderQualityProfile`
 * and none of them may own it. Three private copies of a table this specific
 * would disagree within a week, so it lives here, which is where 01-ARCHITECTURE
 * 6.1 puts it.
 *
 * A profile is data, not behaviour. Nothing in this module reads the DOM, the
 * renderer or the clock, so it is importable from a test with no browser.
 */

import type { QualityTier } from './capabilities';

export type { QualityTier } from './capabilities';

export type InstanceClass =
  | 'page_frames'
  | 'queue_entries'
  | 'disk_sectors'
  | 'beams'
  | 'archive_blocks'
  | 'domain_rings'
  | 'labels';

export interface RenderQualityProfile {
  readonly tier: QualityTier;

  /* framebuffer */
  /** Backing buffer size as a multiple of the CSS size. */
  readonly renderScale: number;
  readonly maxPixelRatio: number;
  /** 0 means no MSAA. Distinct from `Capabilities.maxSamples`, which is a ceiling. */
  readonly msaaSamples: 0 | 2 | 4;
  readonly antialiasMode: 'none' | 'fxaa' | 'taa';

  /* bloom */
  readonly bloomEnabled: boolean;
  /** Resolution of the bloom pyramid base relative to the main target. */
  readonly bloomScale: number;
  readonly bloomMips: number;

  /* volumetrics */
  readonly volumetricEnabled: boolean;
  readonly volumetricSteps: number;
  readonly volumetricScale: number;

  /* shadows */
  readonly shadowPolicy: 'none' | 'blob' | 'shadowmap';
  readonly shadowMapSize: number;

  /* geometry and instances */
  readonly maxInstances: Readonly<Record<InstanceClass, number>>;
  readonly maxParticles: number;
  readonly maxLiveEffects: number;
  readonly labelBudget: number;

  /* misc */
  readonly depthPrepass: boolean;
  readonly gradeLut: boolean;
  readonly aberration: boolean;
  readonly softParticles: boolean;
  readonly anisotropy: number;
}

/**
 * Notes on the choices that look wrong until you know why:
 *
 * - **Bloom is never disabled, at any tier.** The art direction is emissive
 *   geometry in a black void; without bloom the game does not read at all. It
 *   degrades in resolution and mip count, never in existence.
 * - **Volumetrics are off at low.** The single most expensive stage and the most
 *   optional. Their absence changes the mood, not the readability.
 * - **`renderScale` 0.75 with `maxPixelRatio` 1 at low.** On a Retina display
 *   that is a large win, and with FXAA plus the grain pass it holds up because
 *   the art has few high-frequency details.
 * - **TAA only at high.** TAA needs motion vectors, and motion vectors on
 *   instanced geometry require a second matrix buffer per batch. That memory is
 *   only paid at high.
 */
export const PROFILES: Readonly<Record<QualityTier, RenderQualityProfile>> = {
  low: {
    tier: 'low',
    renderScale: 0.75,
    maxPixelRatio: 1,
    msaaSamples: 0,
    antialiasMode: 'fxaa',
    bloomEnabled: true,
    bloomScale: 0.25,
    bloomMips: 3,
    volumetricEnabled: false,
    volumetricSteps: 0,
    volumetricScale: 0,
    shadowPolicy: 'none',
    shadowMapSize: 0,
    maxInstances: {
      page_frames: 1024,
      queue_entries: 128,
      disk_sectors: 2048,
      beams: 128,
      archive_blocks: 1024,
      domain_rings: 32,
      labels: 48,
    },
    maxParticles: 2000,
    maxLiveEffects: 96,
    labelBudget: 48,
    depthPrepass: false,
    gradeLut: false,
    aberration: false,
    softParticles: false,
    anisotropy: 1,
  },
  medium: {
    tier: 'medium',
    renderScale: 1,
    maxPixelRatio: 1.5,
    msaaSamples: 2,
    antialiasMode: 'fxaa',
    bloomEnabled: true,
    bloomScale: 0.5,
    bloomMips: 5,
    volumetricEnabled: true,
    volumetricSteps: 24,
    volumetricScale: 0.25,
    shadowPolicy: 'blob',
    shadowMapSize: 0,
    maxInstances: {
      page_frames: 2048,
      queue_entries: 256,
      disk_sectors: 4096,
      beams: 256,
      archive_blocks: 2048,
      domain_rings: 64,
      labels: 96,
    },
    maxParticles: 8000,
    maxLiveEffects: 256,
    labelBudget: 96,
    depthPrepass: true,
    gradeLut: true,
    aberration: false,
    softParticles: true,
    anisotropy: 4,
  },
  high: {
    tier: 'high',
    renderScale: 1,
    maxPixelRatio: 2,
    msaaSamples: 4,
    antialiasMode: 'taa',
    bloomEnabled: true,
    bloomScale: 0.5,
    bloomMips: 6,
    volumetricEnabled: true,
    volumetricSteps: 48,
    volumetricScale: 0.5,
    shadowPolicy: 'shadowmap',
    shadowMapSize: 1024,
    maxInstances: {
      page_frames: 4096,
      queue_entries: 512,
      disk_sectors: 8192,
      beams: 512,
      archive_blocks: 4096,
      domain_rings: 128,
      labels: 192,
    },
    maxParticles: 20000,
    maxLiveEffects: 512,
    labelBudget: 192,
    depthPrepass: true,
    gradeLut: true,
    aberration: true,
    softParticles: true,
    anisotropy: 8,
  },
};

/**
 * Draw-call and triangle ceilings (03-VISUAL-BIBLE 12.1). Sampled from the
 * renderer's own counters every 30 frames and asserted in the leg smoke tests.
 * A leg that exceeds its budget does not ship, which is why these are here and
 * not a comment in a test file.
 */
export const DRAW_BUDGET: Readonly<Record<QualityTier, { readonly calls: number; readonly triangles: number }>> = {
  low: { calls: 220, triangles: 180_000 },
  medium: { calls: 450, triangles: 450_000 },
  high: { calls: 900, triangles: 1_100_000 },
};

/**
 * Clamp a requested instance count to the tier ceiling. Above the ceiling the
 * world layer aggregates (8 frames per instance, contiguous sectors per arc, and
 * so on, per 01-ARCHITECTURE 7.3); it never silently draws fewer entities than
 * the simulation contains without saying so.
 */
export function assertCeiling(
  cls: InstanceClass,
  requested: number,
  profile: RenderQualityProfile,
): number {
  const max = profile.maxInstances[cls];
  if (requested <= max) return requested;
  if (import.meta.env.DEV) {
    console.warn(
      `[kt] ${cls} requested ${requested} > tier ${profile.tier} ceiling ${max}. ` +
        'Aggregation will apply. See 01-ARCHITECTURE section 7.3.',
    );
  }
  return max;
}
