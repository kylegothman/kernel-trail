/**
 * The shared card shell. A card is a plain region, appended and removed by
 * the host, with no dialog role and nothing that traps focus, because
 * player decisions are made at diegetic anchors or in the terminal (visual
 * bible 11.4). Chapter citations follow the corrected section numbers of
 * 00-BUILD-ORDER.md, which is the caller's job when it builds a ChapterRef.
 */
import type { ChapterRef } from '@game/types';
import { el } from '../hud/dom';

export interface Card {
  readonly el: HTMLElement;
  dispose(): void;
}

export function cardShell(doc: Document, variant: string, label: string): HTMLElement {
  const root = el(doc, 'section', `kt-card kt-card--${variant}`);
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', label);
  return root;
}

/** One line: Silberschatz, Operating System Concepts, 10th ed., Ch. 10.6, Thrashing. */
export function citation(ref: ChapterRef): string {
  const sections = ref.sections.length === 0 ? `Ch. ${ref.chapter}` : `Ch. ${ref.sections.join(', ')}`;
  return `Silberschatz, Operating System Concepts, 10th ed., ${sections}, ${ref.title}`;
}

export function paragraph(doc: Document, className: string, text: string): HTMLElement {
  return el(doc, 'p', className, text);
}
