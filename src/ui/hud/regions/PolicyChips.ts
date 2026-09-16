/**
 * Top right: the tick counter and the policy chips (scheduler, quantum,
 * replacement, disk, allocation), pace and rations. Visual bible 11.1.
 *
 * The tick changes every simulation tick, so it renders from a CSS custom
 * property through `::after` and it does not take part in the value-change
 * flash: a counter that moved every 50 ms would hold the cell at full
 * opacity forever, which is the opposite of what 11.4 wants.
 */
import type { HudTelemetry } from '@game/runStore';
import type { Pace, Rations, TravelPolicy } from '@game/types';
import type { AllocationStrategy, DiskSchedulingId, PageReplacementId, SchedulerId } from '@kernel/types';
import { el, setText, type HudRegion } from '../dom';

export interface PolicyChipsProps {
  readonly scheduler: SchedulerId;
  readonly quantum: number;
  readonly replacement: PageReplacementId;
  readonly disk: DiskSchedulingId;
  readonly allocation: AllocationStrategy;
  readonly pace: Pace;
  readonly rations: Rations;
}

export function policyChipsProps(t: Readonly<HudTelemetry>, policy: Readonly<TravelPolicy>): PolicyChipsProps {
  return {
    scheduler: t.scheduler,
    quantum: t.quantum,
    replacement: t.replacement,
    disk: t.disk,
    allocation: t.allocation,
    pace: policy.pace,
    rations: policy.rations,
  };
}

export const policyChipsEq = (a: PolicyChipsProps, b: PolicyChipsProps): boolean =>
  a.scheduler === b.scheduler &&
  a.quantum === b.quantum &&
  a.replacement === b.replacement &&
  a.disk === b.disk &&
  a.allocation === b.allocation &&
  a.pace === b.pace &&
  a.rations === b.rations;

export interface PolicyChipsRegion extends HudRegion<PolicyChipsProps> {
  /** One style write per tick, no text node replacement. */
  setTick(tick: number): void;
  readonly tickEl: HTMLElement;
}

function chip(doc: Document, label: string): { row: HTMLElement; value: HTMLElement } {
  const row = el(doc, 'span', 'kt-row');
  const value = el(doc, 'span', 'kt-chip');
  row.append(el(doc, 'span', 'kt-label', label), value);
  return { row, value };
}

export function createPolicyChips(doc: Document): PolicyChipsRegion {
  const root = el(doc, 'div', 'kt-policy');
  const tickRow = el(doc, 'div', 'kt-row');
  const tickEl = el(doc, 'span', 'kt-tick kt-value');
  tickRow.append(el(doc, 'span', 'kt-label', 'tick'), tickEl);
  const scheduler = chip(doc, 'sched');
  const quantum = chip(doc, 'q');
  const replacement = chip(doc, 'repl');
  const disk = chip(doc, 'disk');
  const allocation = chip(doc, 'alloc');
  const pace = chip(doc, 'pace');
  const rations = chip(doc, 'rations');
  // Two chips per row only where the longest values fit in 22ch: pace and
  // rations ('conservative', 'generous') each take a row of their own.
  const rows = [
    [scheduler, quantum],
    [replacement, disk],
    [allocation],
    [pace],
    [rations],
  ];
  root.append(tickRow);
  for (const group of rows) {
    const line = el(doc, 'div', 'kt-row');
    for (const c of group) line.append(c.row);
    root.append(line);
  }
  let lastTick = '';
  return {
    el: root,
    tickEl,
    setTick(tick) {
      const value = String(Math.trunc(tick));
      if (value === lastTick) return;
      lastTick = value;
      tickEl.style.setProperty('--kt-tick', value);
    },
    update(p) {
      let changed = setText(scheduler.value, p.scheduler);
      changed = setText(quantum.value, String(p.quantum)) || changed;
      changed = setText(replacement.value, p.replacement) || changed;
      changed = setText(disk.value, p.disk) || changed;
      changed = setText(allocation.value, p.allocation) || changed;
      changed = setText(pace.value, p.pace) || changed;
      changed = setText(rations.value, p.rations) || changed;
      return changed;
    },
    dispose: () => root.remove(),
  };
}
