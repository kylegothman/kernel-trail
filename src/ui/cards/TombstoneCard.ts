/**
 * The tombstone, narrative bible 9 and 14.4: the inscription large and flat,
 * the cause beneath it always, and one affordance reading CODEX that opens
 * `Epitaph.codexEntry`. The world places the stone; this is its face.
 */
import type { Epitaph } from '@game/types';
import { el } from '../hud/dom';
import { cardShell, paragraph, type Card } from './card';

export interface TombstoneCardOptions {
  readonly epitaph: Epitaph;
  /** The Program's display name, since the epitaph carries only its id. */
  readonly memberName: string;
  /** Opens the codex at `epitaph.codexEntry`. */
  readonly onCodex: (entryId: string) => void;
}

export function createTombstoneCard(doc: Document, options: TombstoneCardOptions): Card {
  const { epitaph } = options;
  const root = cardShell(doc, 'tombstone', `Tombstone of ${options.memberName}`);
  root.append(el(doc, 'h2', 'kt-inscription', epitaph.inscription));
  root.append(paragraph(doc, 'kt-cause', epitaph.cause));
  root.append(paragraph(doc, 'kt-cite', `${options.memberName}, ${epitaph.legId}, tick ${String(epitaph.tick)}, ${epitaph.reason}`));
  const affordance = el(doc, 'button', 'kt-affordance', 'CODEX');
  affordance.setAttribute('type', 'button');
  const open = (): void => options.onCodex(epitaph.codexEntry);
  affordance.addEventListener('click', open);
  root.append(affordance);
  return {
    el: root,
    dispose: () => {
      affordance.removeEventListener('click', open);
      root.remove();
    },
  };
}
