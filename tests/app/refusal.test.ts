// @vitest-environment happy-dom
/**
 * WP-24 sections 3 and 4: the interactions panel. The select a verb with
 * declared arguments renders, the restriction the Boot Sector driver uses,
 * the companion's validation of `arguments`, and (section 4) the refusal line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionPanel } from '@app/panels/InteractionPanel';
import { DECLINED_LINE, ObservedBus, REFUSAL_LINE_MS, refusalFor, type OutcomeSource } from '@app/panels/RefusalLine';
import { asTick } from '@kernel/types';
import type { CommandOutcome } from '@game/CommandBus';
import { DIRECT_REACH_LINE } from '@legs/boot_sector/copy';
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

  it('enableOnly keeps every verb listed and readable, enables only the named ones, and disables the launchers until cleared', () => {
    const { leg, content } = legWithGate();
    const { panel } = panelFor(leg, content);
    panel.enableOnly([]); panel.flush();
    expect(overlay.querySelectorAll('[data-interaction]')).toHaveLength(2);
    expect(overlay.textContent).toContain('Reach for the stack directly.');
    for (const label of ['Choose a disc class', 'Take the blocks', 'Open depot', 'Open reclamation']) expect(button(label).disabled, label).toBe(true);
    panel.enableOnly(['boot.direct_reach']); panel.flush();
    expect(button('Take the blocks').disabled).toBe(false);
    expect(button('Choose a disc class').disabled).toBe(true);
    panel.enableOnly(null); panel.flush();
    for (const label of ['Choose a disc class', 'Take the blocks', 'Open reclamation']) expect(button(label).disabled, label).toBe(false);
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

describe('the refusal line (section 4)', () => {
  it('ObservedBus publishes each non-empty drain after applying it', () => {
    const run = initialRunState(30, 'shell', 'operator');
    const store = { get: () => run, mutate: (recipe: (draft: typeof run) => void) => recipe(run) };
    const bus = new ObservedBus({ store: store as never, kernel: {} as never, handlers: { useAbility: vi.fn(), interaction: vi.fn(), terminal: vi.fn() },
      admit: cmd => cmd.kind === 'interaction' && cmd.id === 'no' ? { ok: false, reason: 'This interaction is unavailable.' } : { ok: true } });
    const seen: CommandOutcome[][] = [];
    const unwatch = bus.onOutcomes(outcomes => seen.push([...outcomes]));
    expect(bus.drain(asTick(0))).toEqual([]);
    expect(seen).toEqual([]);
    bus.dispatch({ kind: 'interaction', id: 'no', anchor: 'a' }, { source: 'world', legId: 'boot_sector' });
    bus.dispatch({ kind: 'interaction', id: 'yes', anchor: 'a' }, { source: 'world', legId: 'boot_sector' });
    const outcomes = bus.drain(asTick(3));
    expect(seen).toEqual([outcomes]);
    expect(outcomes.map(outcome => outcome.refused)).toEqual(['This interaction is unavailable.', null]);
    expect(run.decisions.map(record => record.outcome)).toEqual(['costly', 'pending']);
    unwatch();
    bus.dispatch({ kind: 'interaction', id: 'yes', anchor: 'a' }, { source: 'world', legId: 'boot_sector' });
    bus.drain(asTick(4));
    expect(seen).toHaveLength(1);
  });

  it("resolves the director's reason, the Boot Sector's two lines from the leg's data, and Declined. for the rest", () => {
    const run = initialRunState(30, 'shell', 'operator');
    const outcome = (id: string, refused: string | null, index: number, legId: 'boot_sector' | 'quantum_pass' = 'boot_sector'): CommandOutcome =>
      ({ command: { kind: 'interaction', id, anchor: 'a' }, origin: { source: 'world', legId }, at: asTick(0), decisionIndex: index, syscall: null, refused });
    expect(refusalFor(outcome('x', 'Insufficient resources for this interaction.', 0), run)).toEqual({ id: 'x', text: 'Insufficient resources for this interaction.' });
    run.decisions.push(
      { tick: asTick(0), legId: 'boot_sector', kind: 'interaction', choice: 'boot.direct_reach @ anchor.block_stack', outcome: 'costly', relatedObjective: null },
      { tick: asTick(0), legId: 'boot_sector', kind: 'interaction', choice: 'boot.trap_purchase @ anchor.win.quota', outcome: 'costly', relatedObjective: null },
      { tick: asTick(0), legId: 'quantum_pass', kind: 'interaction', choice: 'pass.tune @ anchor.scheduler', outcome: 'costly', relatedObjective: null },
      { tick: asTick(0), legId: 'boot_sector', kind: 'interaction', choice: 'boot.inspect_program @ anchor.plate', outcome: 'good', relatedObjective: null },
    );
    expect(refusalFor(outcome('boot.direct_reach', null, 0), run)).toEqual({ id: 'boot.direct_reach', text: DIRECT_REACH_LINE });
    expect(DIRECT_REACH_LINE).toBe('EPERM. man EPERM.');
    // A bare submission at the quota window in user mode is EPERM by the leg's own reducer.
    expect(refusalFor(outcome('boot.trap_purchase', null, 1), run)).toEqual({ id: 'boot.trap_purchase', text: 'EPERM. man EPERM.' });
    expect(refusalFor(outcome('pass.tune', null, 2, 'quantum_pass'), run)).toEqual({ id: 'pass.tune', text: DECLINED_LINE });
    expect(refusalFor(outcome('boot.inspect_program', null, 3), run)).toBeNull();
    expect(refusalFor({ ...outcome('x', null, 0), command: { kind: 'set_pace', to: 'steady' } }, run)).toBeNull();
  });

  it('the panel shows the line under the verb for two seconds of wall time, then it is gone', () => {
    const { leg, content } = legWithGate();
    const run = initialRunState(30, 'shell', 'operator');
    let listener: ((outcomes: readonly CommandOutcome[]) => void) | null = null;
    const outcomes: OutcomeSource = { onOutcomes: l => { listener = l; return () => { listener = null; }; } };
    let now = 1000;
    const runner = { phase: 'travelling' as const, openCrossing: vi.fn(), openDepot: vi.fn(), openReclamation: vi.fn() };
    const panel = new InteractionPanel({ document, overlay, runner: runner as never, bus: { dispatch: vi.fn(() => true) }, run: () => run, outcomes, clock: () => now,
      crossing: vi.fn(), depot: vi.fn(), reclamation: vi.fn() });
    cleanups.push(() => panel.dispose());
    panel.open(leg, content); panel.flush();
    run.decisions.push({ tick: asTick(0), legId: 'boot_sector', kind: 'interaction', choice: 'boot.direct_reach @ anchor.block_stack', outcome: 'costly', relatedObjective: null });
    listener!([{ command: { kind: 'interaction', id: 'boot.direct_reach', anchor: 'anchor.block_stack' }, origin: { source: 'world', legId: 'boot_sector' }, at: asTick(0), decisionIndex: 0, syscall: null, refused: null }]);
    expect(overlay.querySelector('.kt-refusal')).toBeNull();
    panel.flush();
    const row = overlay.querySelector('[data-interaction="boot.direct_reach"]');
    expect(row?.querySelector('.kt-refusal')?.textContent).toBe('EPERM. man EPERM.');
    expect(overlay.querySelectorAll('.kt-refusal')).toHaveLength(1);
    now += REFUSAL_LINE_MS - 1; panel.flush();
    expect(overlay.querySelector('.kt-refusal')).not.toBeNull();
    now += 1; panel.flush();
    expect(overlay.querySelector('.kt-refusal')).toBeNull();
    panel.dispose();
    expect(listener).toBeNull();
  });
});
