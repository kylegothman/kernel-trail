/**
 * Bottom centre, transient: the anchor under the cursor and the key to
 * engage. Visual bible 11.1. Empty (and therefore not rendered) when nothing
 * is under the cursor.
 */
import { el, setText, type HudRegion } from '../dom';

export interface FocusHintProps {
  /** `FocusTarget.id` of the anchor under the cursor, or null. */
  readonly anchorId: string | null;
  readonly engageKey: string;
}

export const focusHintEq = (a: FocusHintProps, b: FocusHintProps): boolean =>
  a.anchorId === b.anchorId && a.engageKey === b.engageKey;

export function createFocusHint(doc: Document): HudRegion<FocusHintProps> {
  const root = el(doc, 'div', 'kt-cell kt-hint');
  const line = el(doc, 'span', 'kt-row');
  return {
    el: root,
    update(p) {
      if (p.anchorId === null) {
        const had = line.parentNode !== null;
        line.remove();
        return had;
      }
      if (line.parentNode === null) root.append(line);
      return setText(line, `${p.anchorId}  [${p.engageKey}] engage`);
    },
    dispose: () => root.remove(),
  };
}
