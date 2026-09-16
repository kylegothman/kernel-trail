/**
 * Bottom left: five pips, one per Program, each with name, integrity bar,
 * status and affliction glyphs. Visual bible 11.1. The props carry no pid:
 * the HUD shows the five convoy Programs and nothing about any other process.
 */
import type { AfflictionId, ConvoyMember, ConvoyStatus } from '@game/types';
import { el, setFill, setText, type HudRegion } from '../dom';

export interface ConvoyPipProps {
  readonly name: string;
  /** 0 to 100. */
  readonly integrity: number;
  readonly status: ConvoyStatus;
  readonly afflictions: readonly AfflictionId[];
}

export interface ConvoyPipsProps {
  readonly pips: readonly ConvoyPipProps[];
}

/**
 * Two-letter glyphs, uppercase in the micro face, one per affliction. Distinct
 * at 13 px; the silhouette and colour channels carry the rest in the world.
 */
export const AFFLICTION_GLYPH: Readonly<Record<AfflictionId, string>> = {
  priority_inversion: 'PI',
  memory_leak: 'ML',
  starvation: 'ST',
  thrashing: 'TH',
  lock_convoy: 'LC',
  livelock: 'LL',
  orphaned: 'OR',
  fragmented: 'FR',
  cache_thrash: 'CT',
  bit_rot: 'BR',
  stack_overflow: 'SO',
  false_sharing: 'FS',
  interrupt_storm: 'IS',
};

export function convoyPipsProps(convoy: readonly ConvoyMember[]): ConvoyPipsProps {
  return {
    pips: convoy.map((m) => ({
      name: m.name,
      integrity: m.integrity,
      status: m.status,
      afflictions: m.afflictions.map((a) => a.id),
    })),
  };
}

const pipEq = (a: ConvoyPipProps, b: ConvoyPipProps): boolean =>
  a.name === b.name &&
  a.integrity === b.integrity &&
  a.status === b.status &&
  a.afflictions.length === b.afflictions.length &&
  a.afflictions.every((id, i) => id === b.afflictions[i]);

export const convoyPipsEq = (a: ConvoyPipsProps, b: ConvoyPipsProps): boolean =>
  a.pips.length === b.pips.length && a.pips.every((p, i) => pipEq(p, b.pips[i] ?? p));

interface Pip {
  readonly row: HTMLElement;
  readonly name: HTMLElement;
  readonly bar: HTMLElement;
  readonly status: HTMLElement;
  readonly glyphs: HTMLElement;
}

const STATUS_CLASSES: readonly ConvoyStatus[] = ['nominal', 'degraded', 'critical', 'derezzed'];

export function createConvoyPips(doc: Document): HudRegion<ConvoyPipsProps> {
  const root = el(doc, 'div', 'kt-cell kt-bl');
  const pips: Pip[] = [];
  const ensure = (n: number): void => {
    while (pips.length < n) {
      const row = el(doc, 'div', 'kt-row kt-pip');
      const name = el(doc, 'span', 'kt-value');
      const bar = el(doc, 'span', 'kt-bar kt-pip-bar');
      const status = el(doc, 'span', 'kt-label');
      const glyphs = el(doc, 'span', 'kt-glyphs kt-label');
      row.append(name, bar, status, glyphs);
      root.append(row);
      pips.push({ row, name, bar, status, glyphs });
    }
    while (pips.length > n) pips.pop()?.row.remove();
  };
  return {
    el: root,
    update(p) {
      let changed = pips.length !== p.pips.length;
      ensure(p.pips.length);
      p.pips.forEach((props, i) => {
        const pip = pips[i];
        if (pip === undefined) return;
        changed = setText(pip.name, props.name) || changed;
        changed = setFill(pip.bar, props.integrity / 100) || changed;
        changed = setText(pip.status, props.status) || changed;
        for (const s of STATUS_CLASSES) pip.row.classList.toggle(`kt-status-${s}`, s === props.status);
        changed = setText(pip.glyphs, props.afflictions.map((id) => AFFLICTION_GLYPH[id]).join(' ')) || changed;
      });
      return changed;
    },
    dispose: () => root.remove(),
  };
}
