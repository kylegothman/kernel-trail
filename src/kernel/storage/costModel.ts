import { DEFAULT_DISK_GEOMETRY, type DiskGeometry } from './geometry';
export const MS_PER_TICK = 0.5;
export function positiveFactor(factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('cost multiplier must be positive and finite');
}
export function ticksFor(ms: number, msPerTick = MS_PER_TICK): number {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('invalid service time');
  positiveFactor(msPerTick);
  const ticks = Math.max(1, Math.round(ms / msPerTick));
  if (!Number.isSafeInteger(ticks)) throw new RangeError('unsafe service ticks'); return ticks;
}
export function seekTimeMs(distance: number, g: DiskGeometry = DEFAULT_DISK_GEOMETRY, factor = 1): number {
  if (!Number.isFinite(distance) || distance < 0) throw new RangeError('invalid seek distance');
  positiveFactor(factor); return factor * (g.seekOverheadMs + g.seekPerCylinderMs * distance);
}
export const rotationMs = (g: DiskGeometry = DEFAULT_DISK_GEOMETRY): number => 30000 / g.rpm;
export function transferMs(bytes: number, g: DiskGeometry = DEFAULT_DISK_GEOMETRY): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('invalid transfer size');
  return bytes / (g.transferMbPerSec * 1e6) * 1000;
}
export function serviceCost(distance: number, bytes: number, g: DiskGeometry = DEFAULT_DISK_GEOMETRY, factor = 1, msPerTick = MS_PER_TICK) {
  const seek = seekTimeMs(distance, g, factor), rotation = rotationMs(g), transfer = transferMs(bytes, g);
  const serviceMs = seek + rotation + transfer;
  return { seekTimeMs: seek, rotationMs: rotation, transferMs: transfer, serviceMs, ticks: ticksFor(serviceMs, msPerTick) };
}
export class DiskCostModel {
  private factor = 1;
  constructor(readonly geometry: DiskGeometry = DEFAULT_DISK_GEOMETRY, readonly msPerTick = MS_PER_TICK) {}
  setCostMultiplier(factor: number): void { positiveFactor(factor); this.factor = factor; }
  get multiplier(): number { return this.factor; }
  evaluate(distance: number, bytes: number) { return serviceCost(distance, bytes, this.geometry, this.factor, this.msPerTick); }
  deviceLatency(latency: number): number { return Math.max(1, Math.round(latency * this.factor)); }
}
