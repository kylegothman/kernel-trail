/**
 * The leg-complete card, from the frozen `DebriefCard`: headline, what
 * happened, why it happened, the counterfactual when one exists (left null
 * by this package and filled by WP-18), and the chapter it teaches.
 */
import type { DebriefCard } from '@game/types';
import { el } from '../hud/dom';
import { cardShell, citation, paragraph, type Card } from './card';

export function createDebriefCard(doc: Document, card: DebriefCard): Card {
  const root = cardShell(doc, 'debrief', 'Leg debrief');
  root.append(el(doc, 'h2', 'kt-headline', card.headline));
  root.append(el(doc, 'h3', '', 'What happened'));
  root.append(paragraph(doc, 'kt-what', card.whatHappened));
  root.append(el(doc, 'h3', '', 'Why it happened'));
  root.append(paragraph(doc, 'kt-why', card.whyItHappened));
  if (card.counterfactual !== null) {
    root.append(el(doc, 'h3', '', 'If you had done it'));
    root.append(paragraph(doc, 'kt-counterfactual', card.counterfactual));
  }
  root.append(paragraph(doc, 'kt-cite', citation(card.chapter)));
  return { el: root, dispose: () => root.remove() };
}
