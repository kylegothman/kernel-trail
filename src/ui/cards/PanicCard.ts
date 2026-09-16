/**
 * The kernel panic card. The post chain floods the scene amber (visual bible
 * 4.6); this carries the message and the tick, in the panic token.
 */
import type { Tick } from '@kernel/types';
import { el } from '../hud/dom';
import { cardShell, paragraph, type Card } from './card';

export interface PanicCardOptions {
  readonly message: string;
  readonly tick: Tick;
}

export function createPanicCard(doc: Document, options: PanicCardOptions): Card {
  const root = cardShell(doc, 'panic', 'Kernel panic');
  root.append(el(doc, 'h2', '', 'KERNEL PANIC'));
  root.append(paragraph(doc, 'kt-message', options.message));
  root.append(paragraph(doc, 'kt-cite', `tick ${String(options.tick)}`));
  return { el: root, dispose: () => root.remove() };
}
