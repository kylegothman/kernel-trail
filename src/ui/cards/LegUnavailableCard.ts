/**
 * Shown when `LEG_ORDER[run.legIndex]` names a leg with no module in the
 * registry, which is every leg until phase 2 lands them. Says which leg and
 * why, and nothing else: no decision is made here.
 */
import type { LegId } from '@game/types';
import { el } from '../hud/dom';
import { cardShell, paragraph, type Card } from './card';

export interface LegUnavailableOptions {
  readonly legId: LegId;
  readonly index: number;
  readonly reason: string;
}

export function createLegUnavailableCard(doc: Document, options: LegUnavailableOptions): Card {
  const root = cardShell(doc, 'unavailable', 'Leg unavailable');
  root.append(el(doc, 'h2', '', 'Leg unavailable'));
  root.append(paragraph(doc, 'kt-leg', `Leg ${options.index}, ${options.legId}, is not in this build.`));
  root.append(paragraph(doc, 'kt-reason', options.reason));
  return { el: root, dispose: () => root.remove() };
}
