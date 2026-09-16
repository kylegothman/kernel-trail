/** Top left: leg name, leg index of count, progress rail. Visual bible 11.1. */
import type { HudLeg } from '@game/runStore';
import { el, setFill, setText, type HudRegion } from '../dom';

export interface LegRailProps {
  readonly title: string;
  readonly index: number;
  readonly count: number;
  /** 0 to 1. */
  readonly progress: number;
}

export function legRailProps(leg: HudLeg, progress: number): LegRailProps {
  return { title: leg.title, index: leg.index, count: leg.count, progress };
}

export const legRailEq = (a: LegRailProps, b: LegRailProps): boolean =>
  a.title === b.title && a.index === b.index && a.count === b.count && a.progress === b.progress;

export function createLegRail(doc: Document): HudRegion<LegRailProps> {
  const root = el(doc, 'div', 'kt-cell kt-tl');
  const title = el(doc, 'div', 'kt-row kt-value');
  const meta = el(doc, 'div', 'kt-row');
  const index = el(doc, 'span', 'kt-label');
  const rail = el(doc, 'span', 'kt-bar kt-rail');
  meta.append(index, rail);
  root.append(title, meta);
  return {
    el: root,
    update(p) {
      let changed = setText(title, p.title);
      changed = setText(index, `${p.index} of ${p.count}`) || changed;
      changed = setFill(rail, p.progress) || changed;
      return changed;
    },
    dispose: () => root.remove(),
  };
}
