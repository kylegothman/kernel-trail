import { afterEach, expect, it } from 'vitest';
import { InstancedMesh } from 'three/webgpu';
import { createProbeScene, disposeMaterials } from '../../src/render';
import { GPU_TARGET_BUDGET_BYTES, planTargets } from '../../src/render/targets';
import { BENCHMARK, PROFILES, type RenderCapabilities } from '../../src/platform';

const caps: RenderCapabilities = {
  backend: 'webgpu', compute: true, storageBuffers: true, maxSamples: 4,
  float32Filterable: true, float16Renderable: true, hdr: true,
  maxTextureSize: 16384, maxInstances: 1000000, timestampQuery: true,
  deviceMemoryGb: 8, hardwareConcurrency: 8, adapterLabel: 'Boot regressions',
  isIntegrated: true, prefersReducedMotion: false, devicePixelRatio: 3,
};

const tiers = ['low', 'medium', 'high'] as const;
afterEach(() => disposeMaterials());

it('keeps zero-count instances out of every tier scene including the benchmark arguments', () => {
  const emptyInstances: string[] = [];
  for (const tier of tiers) {
    for (const benchmark of [false, true]) {
      const probe = benchmark ? createProbeScene(tier, BENCHMARK.slabs, 0) : createProbeScene(tier);
      try {
        probe.scene.traverse(object => {
          if (object instanceof InstancedMesh && object.count === 0) {
            emptyInstances.push(`${tier}/${benchmark ? 'benchmark' : 'default'}: ${object.name || object.type}`);
          }
        });
      } finally { probe.dispose(); }
    }
  }
  expect(emptyInstances).toEqual([]);
});

it('keeps target plans within budget across tiers, aspect ratios and pixel ratios', () => {
  const viewports = [[1, 1], [960, 600], [1440, 900], [1920, 1080], [2560, 1600],
    [1200, 1533], [1533, 1200], [1080, 1920], [3440, 1440], [1600, 1600]] as const;
  const overBudget: string[] = [];
  for (const backend of ['webgpu', 'webgl2'] as const) {
    for (const hdr of [false, true]) {
      for (const tier of tiers) {
        for (const [width, height] of viewports) {
          for (const dpr of [1, 1.25, 1.5, 2, 3]) {
            for (const debug of [false, true]) {
              const plan = planTargets(width, height, dpr, PROFILES[tier], { ...caps, backend, hdr }, debug);
              if (plan.totalBytes > GPU_TARGET_BUDGET_BYTES) {
                overBudget.push(`${backend}/${hdr}/${tier}/${width}x${height}@${dpr}/debug=${debug}: ${plan.width}x${plan.height}, ${plan.totalBytes} bytes`);
              }
            }
          }
        }
      }
    }
  }
  expect(overBudget.length, overBudget.slice(0, 10).join('\n')).toBe(0);
});
