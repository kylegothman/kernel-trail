/**
 * Bottom right: cycles, quota, blocks, bandwidth, each with a delta indicator
 * showing the change since the previous value. Visual bible 11.1.
 */
import type { ResourceLedger } from '@game/types';
import { el, setText, type HudRegion } from '../dom';

export type LedgerKind = keyof ResourceLedger;
export const LEDGER_KINDS: readonly LedgerKind[] = ['cycles', 'quota', 'blocks', 'bandwidth'];

export interface ResourceLedgerProps {
  readonly cycles: number;
  readonly quota: number;
  readonly blocks: number;
  readonly bandwidth: number;
}

export function resourceLedgerProps(ledger: Readonly<ResourceLedger>): ResourceLedgerProps {
  return { cycles: ledger.cycles, quota: ledger.quota, blocks: ledger.blocks, bandwidth: ledger.bandwidth };
}

export const resourceLedgerEq = (a: ResourceLedgerProps, b: ResourceLedgerProps): boolean =>
  LEDGER_KINDS.every((k) => a[k] === b[k]);

export function formatDelta(delta: number): string {
  if (delta === 0) return '';
  const rounded = Math.round(delta);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

export function createResourceLedgerView(doc: Document): HudRegion<ResourceLedgerProps> {
  const root = el(doc, 'div', 'kt-cell kt-br');
  const rows = new Map<LedgerKind, { value: HTMLElement; delta: HTMLElement }>();
  for (const kind of LEDGER_KINDS) {
    const row = el(doc, 'div', 'kt-row');
    const value = el(doc, 'span', 'kt-value');
    const delta = el(doc, 'span', 'kt-delta kt-label');
    row.append(el(doc, 'span', 'kt-label', kind), value, delta);
    root.append(row);
    rows.set(kind, { value, delta });
  }
  let last: ResourceLedgerProps | null = null;
  return {
    el: root,
    update(p) {
      let changed = false;
      for (const kind of LEDGER_KINDS) {
        const row = rows.get(kind);
        if (row === undefined) continue;
        changed = setText(row.value, String(Math.round(p[kind]))) || changed;
        const delta = last === null ? 0 : p[kind] - last[kind];
        setText(row.delta, formatDelta(delta));
      }
      last = p;
      return changed;
    },
    dispose: () => root.remove(),
  };
}
