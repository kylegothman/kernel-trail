// @vitest-environment happy-dom
/**
 * The four cards: plain non-modal renderers of the frozen shapes (pre-flight
 * ruling 6.10). No dialog role, no focus trap, no colour literal.
 */
import { describe, expect, it } from 'vitest';
import type { Tick } from '../../src/kernel/types';
import type { DebriefCard, Epitaph } from '../../src/game/types';
import { CARD_CSS } from '../../src/ui/cards/cards.css';
import { citation } from '../../src/ui/cards/card';
import { createDebriefCard } from '../../src/ui/cards/DebriefCard';
import { createTombstoneCard } from '../../src/ui/cards/TombstoneCard';
import { createPanicCard } from '../../src/ui/cards/PanicCard';
import { createLegUnavailableCard } from '../../src/ui/cards/LegUnavailableCard';

const debrief: DebriefCard = {
  headline: 'The Reach took VESPER',
  whatHappened: 'You raised the degree of multiprogramming from 6 to 9 at tick 4980.',
  whyItHappened: 'Working sets no longer fit, and every process faulted on every page it needed.',
  counterfactual: null,
  chapter: { chapter: 10, sections: ['10.6'], title: 'Thrashing' },
};

const epitaph: Epitaph = {
  member: 'vesper',
  tick: 5124 as Tick,
  legId: 'drowned_reach',
  reason: 'thrashing_collapse',
  inscription: 'VESPER, mapped the ground as it vanished.',
  cause: 'A resident set smaller than the working set faults on every step.',
  codexEntry: 'codex.thrashing',
};

describe('cards', () => {
  it('debrief: renders the frozen shape and omits the counterfactual while it is null', () => {
    const card = createDebriefCard(document, debrief);
    document.body.append(card.el);
    expect(card.el.querySelector('h2')?.textContent).toBe(debrief.headline);
    expect(card.el.querySelector('.kt-what')?.textContent).toBe(debrief.whatHappened);
    expect(card.el.querySelector('.kt-why')?.textContent).toBe(debrief.whyItHappened);
    expect(card.el.querySelector('.kt-counterfactual')).toBeNull();
    expect(card.el.querySelector('.kt-cite')?.textContent).toBe('Silberschatz, Operating System Concepts, 10th ed., Ch. 10.6, Thrashing');
    card.dispose();
    expect(card.el.isConnected).toBe(false);
    const withCounterfactual = createDebriefCard(document, { ...debrief, counterfactual: 'Held at 6, VESPER survives at 71 integrity.' });
    expect(withCounterfactual.el.querySelector('.kt-counterfactual')?.textContent).toContain('71 integrity');
    expect(citation({ chapter: 5, sections: [], title: 'CPU Scheduling' })).toBe('Silberschatz, Operating System Concepts, 10th ed., Ch. 5, CPU Scheduling');
  });

  it('tombstone: inscription, cause beneath it always, and one CODEX affordance that opens the entry', () => {
    const opened: string[] = [];
    const card = createTombstoneCard(document, { epitaph, memberName: 'VESPER', onCodex: (id) => opened.push(id) });
    document.body.append(card.el);
    const children = [...card.el.children];
    expect(children[0]?.textContent).toBe(epitaph.inscription);
    expect(children[1]?.textContent).toBe(epitaph.cause);
    expect(card.el.textContent).toContain('thrashing_collapse');
    const button = card.el.querySelector<HTMLButtonElement>('button.kt-affordance');
    expect(button?.textContent).toBe('CODEX');
    expect(button?.getAttribute('type')).toBe('button');
    button?.click();
    expect(opened).toEqual(['codex.thrashing']);
    card.dispose();
    button?.click();
    expect(opened).toHaveLength(1);
  });

  it('panic and leg unavailable: message, tick, leg and reason', () => {
    const panic = createPanicCard(document, { message: 'invariant I-7 violated', tick: 900 as Tick });
    expect(panic.el.textContent).toContain('KERNEL PANIC');
    expect(panic.el.textContent).toContain('invariant I-7 violated');
    expect(panic.el.textContent).toContain('tick 900');
    expect(panic.el.classList.contains('kt-card--panic')).toBe(true);
    const missing = createLegUnavailableCard(document, { legId: 'the_platters', index: 9, reason: 'Phase 2 ships this leg.' });
    expect(missing.el.textContent).toContain('Leg 9, the_platters, is not in this build.');
    expect(missing.el.textContent).toContain('Phase 2 ships this leg.');
  });

  it('no modals: every card is a region, never a dialog, and nothing traps focus', () => {
    const cards = [
      createDebriefCard(document, debrief),
      createTombstoneCard(document, { epitaph, memberName: 'VESPER', onCodex: () => undefined }),
      createPanicCard(document, { message: 'halt', tick: 1 as Tick }),
      createLegUnavailableCard(document, { legId: 'the_bus', index: 10, reason: 'x' }),
    ];
    for (const card of cards) {
      document.body.append(card.el);
      expect(card.el.getAttribute('role')).toBe('region');
      expect(card.el.querySelector('[role="dialog"], [aria-modal], [inert], [tabindex]')).toBeNull();
      expect(card.el.tagName).toBe('SECTION');
    }
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(CARD_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(CARD_CSS).toContain('pointer-events: auto;');
    for (const card of cards) card.dispose();
  });
});
