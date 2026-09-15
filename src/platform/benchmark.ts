import type { RenderCapabilities } from './capabilities';
export const BENCHMARK = { width: 960, height: 600, slabs: 3000, particles: 6000, warmup: 12, measured: 30 } as const;
export interface BenchmarkHost { frame(): Promise<number>; dispose(): void }
export type BenchmarkFactory = (caps: RenderCapabilities) => Promise<BenchmarkHost>;
/** Rendering is injected; platform never imports the renderer. Times are frame costs, not GPU claims. */
export async function benchmark(caps: RenderCapabilities, create: BenchmarkFactory): Promise<number> {
  const host = await create(caps);
  try {
    const samples: number[] = [];
    for (let i = 0; i < BENCHMARK.warmup + BENCHMARK.measured; i++) {
      const value = await host.frame();
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid benchmark frame time');
      if (i >= BENCHMARK.warmup) samples.push(value);
    }
    samples.sort((a, b) => a - b);
    return ((samples[14] ?? 0) + (samples[15] ?? 0)) / 2;
  } finally { host.dispose(); }
}
