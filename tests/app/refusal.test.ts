// @vitest-environment happy-dom
/**
 * WP-24 sections 3 and 4: the interactions panel. The select a verb with
 * declared arguments renders, the restriction the Boot Sector driver uses,
 * the companion's validation of `arguments`, and (section 4) the refusal line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionPanel } from '@app/panels/InteractionPanel';
import { initialRunState } from '@game/replay/runReplay';
import type { Leg } from '@game/types';
import { validateContent, type LegContent } from '@legs/content';
import { createSyntheticLeg } from '../game/fixtures/syntheticLeg';

let overlay: HTMLElement;
const cleanups: (() => void)[] = [];
beforeEach(() => { document.body.replaceChildren(); overlay = document.createElement('div'); document.body.append(overlay); });
afterEach(() => { for (const dispose of cleanups.splice(0).reverse()) dispose(); document.body.replaceChildren(); });

const button = (label: string): HTMLButtonElement => {
  const found = [...overlay.querySelectorAll('button')].find(candidate => candidate.textContent === label);
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

function legWithGate(): { readonly leg: Leg; readonly content: LegContent } {
  const leg: Leg = { ...createSyntheticLeg({ id: 'boot_sector', index: 0 }), interactions: [
    { id: 'boot.choose_disc', anchor: 'anchor.disc_plinth', label: 'Choose a disc class', description: 'Name the resource.', cost: {}, enabledWhen: () => true },
    { id: 'boot.direct_reach', anchor: 'anchor.block_stack', label: 'Take the blocks', description: 'Reach for the stack directly.', cost: {}, enabledWhen: () => true },
  ] };
  const content: LegContent = { legId: leg.id, crossings: [], interactions: { 'boot.choose_disc': { run: () => undefined, target: null }, 'boot.direct_reach': { run: () => undefined, target: null } },
    epitaphs: [], codex: [], terminalHandlers: {}, layout: { anchors: [{ id: 'anchor.disc_plinth', kind: 'slab', position: [0, 0, 0] }, { id: 'anchor.block_stack', kind: 'slab', position: [1, 0, 0] }], extras: [], cameraTargets: [] },
    arguments: { 'boot.choose_disc': [{ anchor: 'anchor.disc_plinth:cycles', label: 'cycles' }, { anchor: 'anchor.disc_plinth:blocks', label: 'blocks' }] } };
  return { leg, content };
}

function panelFor(leg: Leg, content: LegContent) {
  const run = initialRunState(30, 'shell', 'operator');
  const bus = { dispatch: vi.fn(() => true) };
  const runner = { phase: 'travelling' as const, openCrossing: vi.fn(), openDepot: vi.fn(), openReclamation: vi.fn() };
  const panel = new InteractionPanel({ document, overlay, runner: runner as never, bus, run: () => run, crossing: vi.fn(), depot: vi.fn(), reclamation: vi.fn() });
  cleanups.push(() => panel.dispose());
  panel.open(leg, content); panel.flush();
  return { panel, bus, run };
}

describe('LegContent.arguments', () => {
  it('validateContent accepts a declared verb with options and refuses an unknown verb or an empty list', () => {
    const { leg, content } = legWithGate();
    expect(validateContent(leg, content)).toEqual([]);
    expect(validateContent(leg, { ...content, arguments: { 'boot.nothing': [{ anchor: 'a', label: 'a' }] } })).toEqual(['arguments boot.nothing: the leg declares no InteractionDef with that id']);
    expect(validateContent(leg, { ...content, arguments: { 'boot.choose_disc': [] } })).toEqual(['arguments boot.choose_disc: an empty option list would render a select with nothing to choose']);
  });

  it('the interactions panel renders a select for a verb that declares options and dispatches the chosen anchor', () => {
    const { leg, content } = legWithGate();
    const { panel, bus } = panelFor(leg, content);
    const select = overlay.querySelector<HTMLSelectElement>('select[aria-label="Choose a disc class argument"]');
    if (select === null) throw new Error('Missing the argument select');
    expect([...select.options].map(option => [option.value, option.textContent])).toEqual([['anchor.disc_plinth:cycles', 'cycles'], ['anchor.disc_plinth:blocks', 'blocks']]);
    expect(overlay.querySelector('[data-interaction="boot.direct_reach"] select')).toBeNull();
    button('Choose a disc class').click();
    expect(bus.dispatch).toHaveBeenLastCalledWith({ kind: 'interaction', id: 'boot.choose_disc', anchor: 'anchor.disc_plinth:cycles' }, { source: 'world', legId: 'boot_sector' });
    select.value = 'anchor.disc_plinth:blocks'; select.dispatchEvent(new Event('change'));
    panel.flush();
    button('Choose a disc class').click();
    expect(bus.dispatch).toHaveBeenLastCalledWith({ kind: 'interaction', id: 'boot.choose_disc', anchor: 'anchor.disc_plinth:blocks' }, { source: 'world', legId: 'boot_sector' });
    // The choice survives a re-render.
    panel.flush();
    expect(overlay.querySelector<HTMLSelectElement>('select[aria-label="Choose a disc class argument"]')?.value).toBe('anchor.disc_plinth:blocks');
    button('Take the blocks').click();
    expect(bus.dispatch).toHaveBeenLastCalledWith({ kind: 'interaction', id: 'boot.direct_reach', anchor: 'anchor.block_stack' }, { source: 'world', legId: 'boot_sector' });
  });

  it('restrict shows only the named verbs and withholds the launchers until cleared', () => {
    const { leg, content } = legWithGate();
    const { panel } = panelFor(leg, content);
    expect(overlay.textContent).toContain('Open depot');
    panel.restrict(['boot.direct_reach']); panel.flush();
    expect(overlay.querySelectorAll('[data-interaction]')).toHaveLength(1);
    expect(overlay.querySelector('[data-interaction="boot.direct_reach"]')).not.toBeNull();
    expect(overlay.textContent).not.toContain('Open depot');
    expect(overlay.textContent).not.toContain('Crossings');
    panel.restrict(null); panel.flush();
    expect(overlay.querySelectorAll('[data-interaction]')).toHaveLength(2);
    expect(overlay.textContent).toContain('Open depot');
  });
});
