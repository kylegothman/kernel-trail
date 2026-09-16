/**
 * The leg-complete card, from the frozen `DebriefCard`: headline, what
 * happened, why it happened, the counterfactual when one exists, and the
 * chapter it teaches.
 *
 * The counterfactual arrives later than the rest (architecture 8.7, steps 3
 * to 5): the card renders at once, and when a `pending` promise is supplied
 * the slot shows a computing state until the replay resolves. A string fills
 * the slot; null or a rejection removes it, and the card is complete without
 * it. The debrief never blocks on the replay. WP-18 scope correction U7.
 */
import type { DebriefCard } from '@game/types';
import { el } from '../hud/dom';
import { cardShell, citation, paragraph, type Card } from './card';

export const COUNTERFACTUAL_HEADING = 'If you had done it';
export const COUNTERFACTUAL_PENDING_TEXT = 'Replaying the leg under another policy';

export function createDebriefCard(doc: Document, card: DebriefCard, pending?: Promise<string | null>): Card {
  const root = cardShell(doc, 'debrief', 'Leg debrief');
  root.append(el(doc, 'h2', 'kt-headline', card.headline));
  root.append(el(doc, 'h3', '', 'What happened'));
  root.append(paragraph(doc, 'kt-what', card.whatHappened));
  root.append(el(doc, 'h3', '', 'Why it happened'));
  root.append(paragraph(doc, 'kt-why', card.whyItHappened));
  let disposed = false;
  if (card.counterfactual !== null) {
    root.append(el(doc, 'h3', '', COUNTERFACTUAL_HEADING));
    root.append(paragraph(doc, 'kt-counterfactual', card.counterfactual));
  } else if (pending !== undefined) {
    const heading = el(doc, 'h3', '', COUNTERFACTUAL_HEADING);
    const slot = paragraph(doc, 'kt-counterfactual-pending', COUNTERFACTUAL_PENDING_TEXT);
    root.append(heading, slot);
    const remove = (): void => {
      heading.remove();
      slot.remove();
    };
    pending.then(
      (text) => {
        if (disposed) return;
        if (text === null) {
          remove();
          return;
        }
        slot.className = 'kt-counterfactual kt-counterfactual--arrived';
        slot.textContent = text;
      },
      () => {
        if (!disposed) remove();
      },
    );
  }
  root.append(paragraph(doc, 'kt-cite', citation(card.chapter)));
  return {
    el: root,
    dispose: () => {
      disposed = true;
      root.remove();
    },
  };
}
