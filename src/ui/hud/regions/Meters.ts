/**
 * The two derived meters below the policy chips: CPU utilisation and fault
 * rate, each a 96 px bar with a marked threshold. Visual bible 11.1. Both
 * move every tick, so only a threshold crossing counts as a value change for
 * the opacity flash.
 */
import type { HudTelemetry } from '@game/runStore';
import { HUD_CPU_MARK } from '../layout';
import { el, setFill, type HudRegion } from '../dom';

export interface MetersProps {
  /** 0 to 1. */
  readonly cpuUtilisation: number;
  /** Faults per thousand ticks. */
  readonly faultRate: number;
  /** `KernelConfig.thrashingThreshold`, the fault meter's mark. */
  readonly thrashingThreshold: number;
}

export function metersProps(t: Readonly<HudTelemetry>): MetersProps {
  return { cpuUtilisation: t.cpuUtilisation, faultRate: t.faultRate, thrashingThreshold: t.thrashingThreshold };
}

export const metersEq = (a: MetersProps, b: MetersProps): boolean =>
  a.cpuUtilisation === b.cpuUtilisation &&
  a.faultRate === b.faultRate &&
  a.thrashingThreshold === b.thrashingThreshold;

/** The fault meter spans twice the threshold so the mark sits at its midpoint. */
export function faultFill(faultRate: number, threshold: number): number {
  if (threshold <= 0) return faultRate > 0 ? 1 : 0;
  return Math.min(1, faultRate / (2 * threshold));
}

function meter(doc: Document, label: string, mark: number): { row: HTMLElement; bar: HTMLElement } {
  const row = el(doc, 'div', 'kt-row');
  const bar = el(doc, 'span', 'kt-bar kt-meter');
  const marker = el(doc, 'span', 'kt-bar-mark');
  marker.style.setProperty('--kt-mark', mark.toFixed(4));
  bar.append(marker);
  row.append(el(doc, 'span', 'kt-label', label), bar);
  return { row, bar };
}

export function createMeters(doc: Document): HudRegion<MetersProps> {
  const root = el(doc, 'div', 'kt-meters');
  const cpu = meter(doc, 'cpu', HUD_CPU_MARK);
  const fault = meter(doc, 'faults', 0.5);
  root.append(cpu.row, fault.row);
  let cpuOver: boolean | null = null;
  let faultOver: boolean | null = null;
  return {
    el: root,
    update(p) {
      setFill(cpu.bar, p.cpuUtilisation);
      setFill(fault.bar, faultFill(p.faultRate, p.thrashingThreshold));
      const nextCpu = p.cpuUtilisation >= HUD_CPU_MARK;
      const nextFault = p.faultRate >= p.thrashingThreshold;
      const crossed = (cpuOver !== null && nextCpu !== cpuOver) || (faultOver !== null && nextFault !== faultOver);
      cpuOver = nextCpu;
      faultOver = nextFault;
      cpu.bar.classList.toggle('kt-status-degraded', nextCpu);
      fault.bar.classList.toggle('kt-status-degraded', nextFault);
      return crossed;
    },
    dispose: () => root.remove(),
  };
}
