import type { ThreadConfig } from './threads';

export function amdahlSpeedup(serialFraction: number, cores: number): number {
  if (!(serialFraction >= 0 && serialFraction <= 1)) throw new RangeError('S out of range');
  if (!Number.isInteger(cores) || cores < 1) throw new RangeError('cores must be a positive integer');
  if (serialFraction === 1) return 1;
  return 1 / (serialFraction + (1 - serialFraction) / cores);
}

export function usableCores(threadsRunnable: number, cfg: ThreadConfig): number {
  switch (cfg.model) {
    case 'many_to_one': return 1;
    case 'one_to_one': return Math.min(threadsRunnable, cfg.coreCount);
    case 'many_to_many': return Math.min(threadsRunnable, cfg.lwpPoolSize, cfg.coreCount);
  }
}
