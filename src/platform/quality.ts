import { BLOOM } from '@design';
export type QualityTier = 'low' | 'medium' | 'high';
export type InstanceClass =
  | 'page_frames'
  | 'queue_entries'
  | 'disk_sectors'
  | 'beams'
  | 'archive_blocks'
  | 'domain_rings'
  | 'labels';

export type FloorReflectionMode = 'light-pools' | 'mirrored-proxy' | 'planar-rt';

export interface VisualQualityProfile {
  readonly tier: QualityTier;

  /* framebuffer */
  readonly renderScale: number;
  readonly antialiasing: 'none' | 'smaa' | 'msaa4';

  /* bloom */
  readonly bloomLevels: number;
  /** Resolution of the pyramid base relative to the main target. */
  readonly bloomScale: number;
  /** Low tier tints only level 0; the wide levels take the flat white tint. */
  readonly bloomTintPerLevel: boolean;

  /* optional stages */
  readonly depthOfField: boolean;
  readonly volumetricScattering: boolean;
  /** Maximum channel offset at the frame corner, in device pixels. 0 disables. */
  readonly aberrationMaxPx: number;
  /** Grain amplitude. Above 0.02 it reads as noise and destroys the hairlines. */
  readonly grainAmplitude: number;

  /* world-side settings the chain must agree with */
  readonly floorReflection: FloorReflectionMode;
  readonly beamRadialSegments: number;
  /** Resolution of the depth copy the beam soft-clip samples. */
  readonly beamDepthScale: number;
  /** Real transmission is capped; beyond this the factory returns the fresnel fallback. */
  readonly transmissiveCap: number;
  readonly derezzCubeCap: number;
  readonly concurrentDerezz: number;
  readonly concurrentBeams: number;
  readonly animatedElements: number;
  readonly sdfGlyphSize: number;
  readonly distantColumns: number;
  readonly floorLightPools: number;
  /** Metres beyond which the minor grid is not drawn. Infinity means always. */
  readonly gridMinorRangeM: number;
}

const LOOK: Readonly<Record<QualityTier, VisualQualityProfile>> = {
  low: {
    tier: 'low',
    renderScale: 0.75,
    antialiasing: 'none',
    bloomLevels: 4,
    bloomScale: 0.25,
    bloomTintPerLevel: false,
    depthOfField: false,
    volumetricScattering: false,
    aberrationMaxPx: 0,
    grainAmplitude: 0.008,
    floorReflection: 'light-pools',
    beamRadialSegments: 6,
    beamDepthScale: 0.25,
    transmissiveCap: 0,
    derezzCubeCap: 600,
    concurrentDerezz: 2,
    concurrentBeams: 16,
    animatedElements: 48,
    sdfGlyphSize: 48,
    distantColumns: 120,
    floorLightPools: 8,
    gridMinorRangeM: 30,
  },
  medium: {
    tier: 'medium',
    renderScale: 1,
    antialiasing: 'smaa',
    bloomLevels: 5,
    bloomScale: 0.5,
    bloomTintPerLevel: true,
    depthOfField: false,
    volumetricScattering: false,
    aberrationMaxPx: 1.0,
    grainAmplitude: 0.012,
    floorReflection: 'mirrored-proxy',
    beamRadialSegments: 10,
    beamDepthScale: 0.5,
    transmissiveCap: 0,
    derezzCubeCap: 1800,
    concurrentDerezz: 6,
    concurrentBeams: 32,
    animatedElements: 160,
    sdfGlyphSize: 64,
    distantColumns: 260,
    floorLightPools: 16,
    gridMinorRangeM: Number.POSITIVE_INFINITY,
  },
  high: {
    tier: 'high',
    renderScale: 1,
    antialiasing: 'msaa4',
    bloomLevels: 6,
    bloomScale: 0.5,
    bloomTintPerLevel: true,
    depthOfField: true,
    volumetricScattering: true,
    aberrationMaxPx: 1.6,
    grainAmplitude: 0.012,
    floorReflection: 'planar-rt',
    beamRadialSegments: 16,
    beamDepthScale: 1,
    transmissiveCap: 8,
    derezzCubeCap: 4096,
    concurrentDerezz: 16,
    concurrentBeams: 64,
    animatedElements: 400,
    sdfGlyphSize: 64,
    distantColumns: 400,
    floorLightPools: 24,
    gridMinorRangeM: Number.POSITIVE_INFINITY,
  },
};
export interface RenderQualityProfile extends VisualQualityProfile {
  readonly maxPixelRatio: number;
  readonly msaaSamples: 0 | 2 | 4;
  readonly bloomEnabled: true;
  readonly bloomMips: number;
  readonly bloomThreshold: number;
  readonly bloomStrength: number;
  readonly hdr: true;
  readonly shadowPolicy: 'none';
  readonly shadowMapSize: 0;
  readonly volumetricEnabled: boolean;
  readonly volumetricSteps: number;
  readonly volumetricScale: number;
  readonly maxInstances: Readonly<Record<InstanceClass, number>>;
  readonly maxParticles: number;
  readonly maxLiveEffects: number;
  readonly labelBudget: number;
  readonly depthPrepass: boolean;
  readonly drawCalls: number;
  readonly triangles: number;
}
export const DRAW_BUDGET = {
  low: { calls: 220, triangles: 180_000 },
  medium: { calls: 450, triangles: 450_000 },
  high: { calls: 900, triangles: 1_100_000 },
} as const;
function profile(tier: QualityTier, multiplier: number, maxPixelRatio: number, maxParticles: number, maxLiveEffects: number): RenderQualityProfile {
  const look = LOOK[tier];
  return Object.freeze({ ...look, maxPixelRatio, msaaSamples: tier === 'high' ? 4 : 0,
    bloomEnabled: true, bloomMips: look.bloomLevels, bloomThreshold: BLOOM.threshold,
    bloomStrength: BLOOM.strength, hdr: true, shadowPolicy: 'none', shadowMapSize: 0,
    volumetricEnabled: look.volumetricScattering, volumetricSteps: tier === 'high' ? 48 : 0,
    volumetricScale: look.volumetricScattering ? 0.25 : 0,
    maxInstances: Object.freeze({ page_frames: 1024 * multiplier, queue_entries: 128 * multiplier,
      disk_sectors: 2048 * multiplier, beams: 128 * multiplier, archive_blocks: 1024 * multiplier,
      domain_rings: 32 * multiplier, labels: 48 * multiplier }),
    maxParticles, maxLiveEffects, labelBudget: 48 * multiplier, depthPrepass: tier !== 'low',
    drawCalls: DRAW_BUDGET[tier].calls, triangles: DRAW_BUDGET[tier].triangles,
  });
}
export const PROFILES: Readonly<Record<QualityTier, RenderQualityProfile>> = {
  low: profile('low', 1, 1, 2000, 96), medium: profile('medium', 2, 1.5, 8000, 256),
  high: profile('high', 4, 2, 20000, 512),
};
export function assertCeiling(cls: InstanceClass, requested: number, p: RenderQualityProfile): number {
  return Math.min(requested, p.maxInstances[cls]);
}
