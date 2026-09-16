// @vitest-environment happy-dom
/** Browser stand-ins preserve the public decision models and commit DOM once per frame. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossingPanel } from '@app/panels/CrossingPanel';
import { DepotPanel, type DepotPanelModel } from '@app/panels/DepotPanel';
import { ReclamationPanel } from '@app/panels/ReclamationPanel';
import { CodexPanel } from '@app/panels/CodexPanel';
import { InteractionPanel } from '@app/panels/InteractionPanel';
import type { CrossingDef, CrossingResult } from '@game/crossing/Crossing';
import { quote, type CrossingContext, type CrossingOption } from '@game/crossing/options';
import { Depot, type DepotOffer } from '@game/depot/Depot';
import type { LegPhase } from '@game/LegRunner';
import type { ReclamationResult, ReclamationTrace } from '@game/reclamation/Reclamation';
import type { VergeLayout } from '@game/reclamation/verge';
import type { CodexEntry } from '@game/codexTypes';
import { initialRunState } from '@game/replay/runReplay';
import { createRunStore } from '@game/runStore';
import type { Leg } from '@game/types';
import type { LegContent } from '@legs/content';
import { Codex } from '@ui/codex/Codex';
import { CodexRegistry } from '@ui/codex/entries';
import { createSyntheticLeg } from '../game/fixtures/syntheticLeg';

const crossing: CrossingDef = { id: 'gate', legId: 'the_narrows', lockId: 'vault', kind: 'mutex', ordered: true, anchor: 'gate.anchor', crosser: null };
const context: CrossingContext = { contention: 0.64, ordered: true, rations: 'standard', aliveCount: 5, crosserHoldsResource: false };
const verge: VergeLayout = { f: 0.4, fragments: [{ id: 0, frames: 4, position: 0.2, adjacent: [] }], leaked: [{ id: 1, frames: 3, position: 0.5 }], live: [], markDecaySeconds: 7, rotationDegPerSec: 10, adjacency: 0.5, seconds: 75 };
const reclaimed: ReclamationResult = { yield: { quota: 0, blocks: 0, cycles: 0, coalesceMultiplier: 1, cleanSweepBonus: 1.2, classMultiplier: 1, returnsMultiplier: 1 }, liveHits: [], lightingBlankedUntil: 0 };
let overlay: HTMLElement;
const cleanups: (() => void)[] = [];

beforeEach(() => { document.body.replaceChildren(); overlay = document.createElement('div'); document.body.append(overlay); });
afterEach(() => { for (const dispose of cleanups.splice(0).reverse()) dispose(); document.body.replaceChildren(); });

function button(label: string): HTMLButtonElement {
  const found = [...overlay.querySelectorAll('button')].find(candidate => candidate.textContent === label || candidate.getAttribute('aria-label') === label);
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
}

function select(label: string): HTMLSelectElement {
  const found = [...overlay.querySelectorAll('select')].find(candidate => candidate.getAttribute('aria-label') === label);
  if (found === undefined) throw new Error(`Missing select ${label}`);
  return found;
}

function crossingResult(def: CrossingDef, option: CrossingOption, refused: string | null = null): CrossingResult {
  return { def, option, contentionAtChoice: context.contention, quote: quote(option, context), succeeded: refused === null, attempts: refused === null ? 1 : 0,
    afflicted: [], casualties: [], eventsDrawn: [], spent: refused === null ? { cycles: 70 } : {}, refused };
}

describe('crossing panel', () => {
  it('shows numeric contention and four model quotes, committing only during flush', () => {
    const runner = { resolveCrossing: vi.fn((def: CrossingDef, option: CrossingOption) => crossingResult(def, option)), continueTravel: vi.fn() };
    const panel = new CrossingPanel({ document, overlay, runner }); cleanups.push(() => panel.dispose());
    panel.open(crossing, context);
    expect(overlay.childElementCount).toBe(0);
    panel.flush();
    expect(overlay.textContent).toContain('C = 0.64');
    expect(overlay.textContent).not.toMatch(/(?:low|medium|high) contention/i);
    expect(overlay.querySelectorAll('tbody tr')).toHaveLength(4);
    const spin = overlay.querySelector('tbody tr');
    expect([...spin?.querySelectorAll('td') ?? []].map(cell => cell.textContent)).toEqual(['spin', '70', '23', '0', '0', '0', '65.18%', '0', 'Choose spin']);
    expect(overlay.querySelector('[role="dialog"]')).toBeNull();
    const before = overlay.innerHTML; button('Choose spin').click();
    expect(runner.resolveCrossing).toHaveBeenCalledWith(crossing, 'spin');
    expect(overlay.innerHTML).toBe(before);
    panel.flush(); expect(overlay.textContent).toContain('Spent: cycles: 70');
    button('Continue').click(); expect(runner.continueTravel).toHaveBeenCalledOnce();
    expect(panel.isOpen).toBe(false); expect(overlay.childElementCount).toBe(1);
    panel.flush(); expect(overlay.childElementCount).toBe(0);
  });

  it('keeps a refused crossing open and offers another choice', () => {
    const runner = { resolveCrossing: vi.fn((def: CrossingDef, option: CrossingOption) => crossingResult(def, option, 'Insufficient resources.')), continueTravel: vi.fn() };
    const panel = new CrossingPanel({ document, overlay, runner }); cleanups.push(() => panel.dispose());
    panel.open(crossing, context); panel.flush(); button('Choose monitor').click(); panel.flush();
    expect(panel.isOpen).toBe(true); expect(overlay.textContent).toContain('Refused: Insufficient resources.');
    expect(button('Choose wait').disabled).toBe(false); expect(runner.continueTravel).not.toHaveBeenCalled();
  });

  it('preserves a result when the same crossing opens twice and resets when another leg opens it', () => {
    const runner = { resolveCrossing: vi.fn((def: CrossingDef, option: CrossingOption) => crossingResult(def, option)), continueTravel: vi.fn() };
    const panel = new CrossingPanel({ document, overlay, runner }); cleanups.push(() => panel.dispose());
    panel.open(crossing, context); panel.flush(); button('Choose spin').click(); panel.flush();
    const completed = overlay.innerHTML;
    panel.open({ ...crossing }, { ...context }); panel.flush();
    expect(overlay.innerHTML).toBe(completed); expect(button('Continue')).toBeTruthy();
    expect(overlay.querySelector('table')).toBeNull(); expect(runner.resolveCrossing).toHaveBeenCalledOnce();
    panel.open({ ...crossing, legId: 'the_cistern' }, context); panel.flush();
    expect(button('Choose spin')).toBeTruthy(); expect(overlay.textContent).not.toContain('Spent:');
  });
});

describe('depot and reclamation panels', () => {
  it('offers living repair targets and derezzed recruit targets, then refreshes the catalogue', () => {
    const run = initialRunState(10, 'shell', 'operator');
    const dead = run.convoy[0]; if (dead === undefined) throw new Error('Missing convoy fixture');
    dead.status = 'derezzed'; dead.integrity = 0;
    const living = run.convoy[1]; if (living === undefined) throw new Error('Missing living fixture');
    let bought = false;
    const depot: DepotPanelModel = {
      hint: null, recruitNotice: () => null,
      catalogue: vi.fn((): readonly DepotOffer[] => [
        { item: 'repair', cycles: 15, blocks: 8, available: true, unavailableReason: null },
        { item: 'recruit', cycles: 220, blocks: 40, available: !bought, unavailableReason: bought ? 'Already recruited.' : null },
      ]),
      buy: vi.fn((item, target) => { if (item === 'recruit' && target === dead.id) bought = true; return { ok: true, reason: null, spent: {}, gained: {} }; }),
    };
    const runner = { continueTravel: vi.fn() };
    const panel = new DepotPanel({ document, overlay, runner, run: () => run }); cleanups.push(() => panel.dispose());
    panel.open(depot); panel.flush();
    expect([...select('repair target').options].map(option => option.value)).toEqual(run.convoy.filter(member => member.status !== 'derezzed').map(member => member.id));
    expect([...select('recruit target').options].map(option => option.value)).toEqual([dead.id]);
    button('Buy repair').click(); expect(depot.buy).toHaveBeenCalledWith('repair', living.id); panel.flush();
    const before = overlay.innerHTML; button('Buy recruit').click(); expect(overlay.innerHTML).toBe(before);
    expect(depot.buy).toHaveBeenCalledWith('recruit', dead.id); panel.flush();
    expect(overlay.textContent).toContain('Already recruited.'); expect(depot.catalogue).toHaveBeenCalledTimes(3);
    button('Leave').click(); panel.flush(); expect(runner.continueTravel).toHaveBeenCalledOnce(); expect(panel.isOpen).toBe(false);
  });

  it.each(['Sweep', 'Skip'])('%s submits only an empty trace and resumes travel while leaving the yield readable', label => {
    const runner = { submitReclamation: vi.fn((_trace: ReclamationTrace) => reclaimed), continueTravel: vi.fn() };
    const panel = new ReclamationPanel({ document, overlay, runner }); cleanups.push(() => panel.dispose());
    panel.open(verge); expect(overlay.childElementCount).toBe(0); panel.flush();
    expect(overlay.textContent).toContain('F = 0.40; fragments: 1; leaked: 1; seconds: 75');
    button(label).click(); expect(runner.submitReclamation).toHaveBeenCalledWith([]); expect(runner.continueTravel).toHaveBeenCalledOnce();
    expect(overlay.textContent).not.toContain('Yield:'); panel.flush();
    expect(overlay.textContent).toContain('Yield: 0 quota, 0 blocks, 0 cycles.');
    button('Close').click(); panel.flush(); expect(panel.isOpen).toBe(false);
  });
});

function entry(id: string, title: string, concept: string): CodexEntry {
  return { id, title, concept, chapter: { chapter: 6, sections: ['6.5'], title: 'Semaphores' }, unlock: { kind: 'objective', id },
    workedExample: null, counterfactual: null, remedy: { kind: 'terminal', command: 'ps' }, remedyVisibility: 'immediate', related: [], commands: ['ps'], epitaphs: [] };
}

describe('codex panel', () => {
  it('leaves the codex open when another input surface already handled Escape', () => {
    const registry = new CodexRegistry();
    const codex = new Codex({ registry, runStore: createRunStore(initialRunState(21, 'shell', 'operator')), currentLeg: () => 'the_narrows' });
    const panel = new CodexPanel({ document, overlay, codex, registry }); cleanups.push(() => codex.dispose(), () => panel.dispose());
    panel.open(); panel.flush();
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }); handled.preventDefault();
    document.dispatchEvent(handled); panel.flush(); expect(panel.isOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); panel.flush(); expect(panel.isOpen).toBe(false);
  });

  it('withholds locked prose and titles, searches readable entries, and repaints on unlock without a new open', () => {
    const registry = new CodexRegistry(); registry.register(entry('known', 'Semaphore queue', 'A queued wait releases the processor.'));
    registry.register(entry('hidden', 'Secret future concept', 'UNREADABLE CONCEPT'));
    const run = initialRunState(20, 'shell', 'operator'); run.codexUnlocked.push('known');
    const codex = new Codex({ registry, runStore: createRunStore(run), currentLeg: () => 'the_narrows' });
    const panel = new CodexPanel({ document, overlay, codex, registry }); cleanups.push(() => codex.dispose(), () => panel.dispose());
    panel.open('hidden'); panel.flush(); expect(overlay.textContent).toContain('hidden: Locked');
    expect(overlay.textContent).not.toContain('Secret future concept'); expect(overlay.textContent).not.toContain('UNREADABLE CONCEPT');
    button('Semaphore queue').click(); panel.flush();
    expect(overlay.textContent).toContain('A queued wait releases the processor.'); expect(overlay.textContent).toContain('Remedy: ps');
    expect(overlay.textContent).toContain('Ch. 6.5, Semaphores');
    const input = overlay.querySelector<HTMLInputElement>('input[type="search"]'); if (input === null) throw new Error('Missing search');
    input.value = 'processor'; input.dispatchEvent(new Event('input')); panel.flush(); expect(button('Semaphore queue')).toBeTruthy();
    input.value = 'UNREADABLE'; input.dispatchEvent(new Event('input')); panel.flush(); expect(overlay.textContent).toContain('No matching entries.');
    input.value = ''; input.dispatchEvent(new Event('input')); panel.flush();
    codex.signal({ kind: 'objective', id: 'hidden' }); expect(overlay.textContent).not.toContain('Secret future concept');
    panel.flush(); button('Secret future concept').click(); panel.flush(); expect(overlay.textContent).toContain('UNREADABLE CONCEPT');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(panel.isOpen).toBe(false); panel.flush(); expect(overlay.childElementCount).toBe(0);
  });
});

describe('interaction panel', () => {
  it('records the world anchor and enables decision launchers only during travel', () => {
    const run = initialRunState(30, 'shell', 'operator');
    const leg: Leg = { ...createSyntheticLeg({ id: 'quantum_pass', index: 3 }), interactions: [
      { id: 'tune', anchor: 'scheduler', label: 'Tune', description: 'Adjust the queue.', cost: { cycles: 5 }, enabledWhen: state => state.resources.cycles > 0 },
    ] };
    const def: CrossingDef = { ...crossing, legId: leg.id };
    const content: LegContent = { legId: leg.id, crossings: [def], interactions: {}, epitaphs: [], codex: [], terminalHandlers: {}, layout: { anchors: [], extras: [], cameraTargets: [] } };
    const depot = new Depot(3, 'operator', 'shell', {
      getRun: () => run, mutate: recipe => recipe(run), hasRecruited: () => false,
      view: () => { throw new Error('A policy hint is outside this launcher test.'); },
      recruit: () => undefined, checkpoint: () => undefined, record: () => undefined,
    });
    let phase: LegPhase = 'travelling';
    const runner = {
      get phase(): LegPhase { return phase; },
      openCrossing: vi.fn((_def: CrossingDef) => context),
      openDepot: vi.fn(() => depot),
      openReclamation: vi.fn(() => verge),
    };
    const bus = { dispatch: vi.fn(() => true) }; const onCrossing = vi.fn(); const onDepot = vi.fn(); const onReclamation = vi.fn();
    const panel = new InteractionPanel({ document, overlay, runner, bus, run: () => run, crossing: onCrossing, depot: onDepot, reclamation: onReclamation }); cleanups.push(() => panel.dispose());
    panel.open(leg, content); panel.flush();
    expect(overlay.querySelector('[data-anchor="scheduler"]')?.textContent).toContain('Cost: cycles: 5');
    button('Tune').click(); expect(bus.dispatch).toHaveBeenCalledWith({ kind: 'interaction', id: 'tune', anchor: 'scheduler' }, { source: 'world', legId: 'quantum_pass' }); panel.flush();
    button('Approach gate').click(); expect(onCrossing).toHaveBeenCalledWith(def, context); panel.flush();
    button('Open reclamation').click(); expect(onReclamation).toHaveBeenCalledWith(verge); panel.flush();
    button('Open depot').click(); expect(runner.openDepot).toHaveBeenCalledOnce(); expect(onDepot).toHaveBeenCalledWith(depot); panel.flush();
    run.resources.cycles = 0; panel.flush(); expect(button('Tune').disabled).toBe(true);
    phase = 'crossing'; panel.flush();
    for (const label of ['Approach gate', 'Open depot', 'Open reclamation']) expect(button(label).disabled).toBe(true);
    phase = 'travelling'; panel.open({ ...leg, id: 'drowned_reach', index: 8 }, { ...content, legId: 'drowned_reach' }); panel.flush();
    expect(button('Open depot').disabled).toBe(true); expect(button('Open reclamation').disabled).toBe(false);
  });
});
