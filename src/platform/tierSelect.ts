import type { RenderCapabilities } from './capabilities';
import type { QualityTier } from './quality';
export interface TierDecision {
  readonly tier: QualityTier;
  readonly by: 'cache' | 'user' | 'benchmark' | 'heuristic' | 'fallback';
  readonly medianFrameMs: number | null;
  readonly notes: string;
}
export const CACHE_KEY = 'kt.tier.v1';
export type BenchmarkFn = (caps: RenderCapabilities) => Promise<number>;
function key(c: RenderCapabilities, build: string): string { return `${build}|${c.backend}|${c.adapterLabel}|${navigator.userAgent}`; }
function write(c: RenderCapabilities, build: string, d: TierDecision): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ key: key(c, build), ...d })); } catch { /* optional cache */ }
}
export async function selectTier(c: RenderCapabilities, build: string, run: BenchmarkFn, explicit?: QualityTier): Promise<TierDecision> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (typeof raw === 'object' && raw !== null && 'key' in raw && raw.key === key(c, build) && 'tier' in raw &&
      (raw.tier === 'low' || raw.tier === 'medium' || raw.tier === 'high')) {
      return { tier: raw.tier, by: 'cache', medianFrameMs: null, notes: 'Cached choice' };
    }
  } catch { /* blocked or invalid storage */ }
  if (explicit !== undefined) return setUserTier(c, build, explicit);
  let d: TierDecision;
  try {
    const ms = await run(c);
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid benchmark');
    const measured = ms <= 6 ? 'high' : ms <= 11 ? 'medium' : 'low';
    d = { tier: c.backend === 'webgl2' && measured === 'high' ? 'medium' : measured,
      by: 'benchmark', medianFrameMs: ms, notes: 'Representative scene median' };
  } catch {
    d = { tier: 'medium', by: 'fallback', medianFrameMs: null, notes: 'Benchmark unavailable; approved medium fallback' };
  }
  write(c, build, d);
  return d;
}
export const selectQualityTier = selectTier;
export function setUserTier(c: RenderCapabilities, build: string, tier: QualityTier): TierDecision {
  const d: TierDecision = { tier, by: 'user', medianFrameMs: null, notes: 'Chosen by player' };
  write(c, build, d); return d;
}
export function clearTierCache(): void { try { localStorage.removeItem(CACHE_KEY); } catch { /* optional cache */ } }
