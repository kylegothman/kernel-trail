/**
 * The load model: smoothed inputs to layer gains. Pre-flight ruling C10.
 *
 * Fault smoothing mirrors WP-06 exactly: per tick, `acc = acc - (acc >> 3)
 * + faultsThisTick` and the rate is `acc * 1000 / 8`, faults per thousand
 * ticks (src/kernel/memory/thrashing.ts, nextFaultAccumulator). The HUD meter
 * reads the kernel's number and the strain layer reads this one, and they
 * rise in the same window because they are the same arithmetic.
 */
import { CONTENTION_FULL_DEPTH, PULSE_CPU_THRESHOLD, PULSE_GATE } from '../synth/constants';
import type { LayerTargets } from './layers';

export interface LoadThresholds {
  /** Faults per thousand ticks above which thrashing begins. From `KernelConfig`. */
  readonly thrashingThreshold: number;
}

/** WP-06's accumulator step, copied so the two never drift. */
export function nextFaultAccumulator(accumulator: number, faultsThisTick: number): number {
  const next = accumulator - (accumulator >> 3) + faultsThisTick;
  return faultsThisTick === 0 && next < 8 ? 0 : next;
}

export class LoadModel {
  private faultAcc = 0;
  private cpu = 0;
  private switchesPerTick = 0;
  private ticksPerSecond = 0;
  private contention = 0;
  private thrashingThreshold = 200;

  setThresholds(t: LoadThresholds): void {
    if (Number.isFinite(t.thrashingThreshold) && t.thrashingThreshold > 0) {
      this.thrashingThreshold = t.thrashingThreshold;
    }
  }

  /** One simulated tick. Called by the consumer as it sees tick boundaries. */
  observeTick(faults: number, running: boolean, switches: number): void {
    this.faultAcc = nextFaultAccumulator(this.faultAcc, Math.max(0, Math.floor(faults)));
    this.cpu += ((running ? 1 : 0) - this.cpu) / 8;
    this.switchesPerTick += (switches - this.switchesPerTick) / 8;
  }

  /** Once per frame: wall time elapsed and the ticks it carried. */
  observeFrame(ticks: number, wallSeconds: number, queueDepth: number): void {
    if (wallSeconds > 0 && ticks > 0) {
      this.ticksPerSecond += (ticks / wallSeconds - this.ticksPerSecond) / 8;
    }
    const depth = Math.min(1, Math.max(0, queueDepth / CONTENTION_FULL_DEPTH));
    this.contention += (depth - this.contention) / 4;
  }

  /** `memory.thrashing` carries the kernel's own rate; adopt it outright. */
  adoptFaultRate(faultRate: number): void {
    if (Number.isFinite(faultRate) && faultRate >= 0) {
      this.faultAcc = Math.max(this.faultAcc, Math.round((faultRate * 8) / 1000));
    }
  }

  get faultRate(): number {
    return (this.faultAcc * 1000) / 8;
  }

  get cpuUtilisation(): number {
    return this.cpu;
  }

  /** Gate rate for the pulse layer, hertz, within the gate window. */
  get pulseRateHz(): number {
    const switchesPerSecond = this.switchesPerTick * this.ticksPerSecond;
    const x = Math.min(1, switchesPerSecond / PULSE_GATE.switchesPerSecondAtMax);
    return PULSE_GATE.minHz + (PULSE_GATE.maxHz - PULSE_GATE.minHz) * x;
  }

  /** Fill the layer targets in place. `alarm` is event-driven and stays 0 here. */
  targets(out: LayerTargets): LayerTargets {
    out.bed = 1;
    out.pulse = this.cpu > PULSE_CPU_THRESHOLD ? Math.min(1, (this.cpu - PULSE_CPU_THRESHOLD) / (1 - PULSE_CPU_THRESHOLD)) : 0;
    out.strain = Math.min(1, this.faultRate / this.thrashingThreshold);
    out.contention = this.contention;
    out.alarm = 0;
    return out;
  }
}
