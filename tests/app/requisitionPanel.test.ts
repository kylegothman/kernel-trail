// @vitest-environment happy-dom
/**
 * WP-24 section 3: the requisition and the gate, driven through their DOM
 * against the real Boot Sector on a real runner. Acceptance 3: the panel
 * dispatches exactly the anchor strings scripts.ts uses, and a full
 * requisition through the panel produces the same decision kinds and
 * outcomes as the known-good script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatePanel, GATE_LINES } from '@app/panels/GatePanel';
import { RequisitionPanel } from '@app/panels/RequisitionPanel';
import { ObservedBus } from '@app/panels/RefusalLine';
import { createKernel } from '@kernel/index';
import type { KernelMutators } from '@game/CommandBus';
import { LegRunner } from '@game/LegRunner';
import { ZERO_SEGMENT_TICK_ALLOWANCE, legDone } from '@game/RunDirector';
import { createRunStore } from '@game/runStore';
import { initialRunState } from '@game/replay/runReplay';
import { createRunStreams } from '@game/replay/types';
import type { EpitaphCopySource } from '@game/convoy/derezz';
import { TRAP_SIGNAGE, DEPOT_AMBIENT, GATE_QUESTION } from '@legs/boot_sector/copy';
import { parseInteractionChoice } from '@legs/boot_sector/windows';
import bootLeg, { content as bootContent } from '@legs/boot_sector';
import { readFileSync } from 'node:fs';

// The happy-dom transform resolves the registry's dynamic imports eagerly, so the unshipped legs are replaced at their imported boundary, as BrowserSession.test.ts does.
vi.mock('@legs/registry', () => ({ LEG_LOADERS: {} }));

const copy: EpitaphCopySource = { templates: reason => [{ id: reason, reason, inscription: '{NAME} stopped.', cause: 'Fixture.', codexEntry: `test.${reason}` }] };
let overlay: HTMLElement;
const cleanups: (() => void)[] = [];
beforeEach(() => { document.body.replaceChildren(); overlay = document.createElement('div'); document.body.append(overlay); });
afterEach(() => { for (const dispose of cleanups.splice(0).reverse()) dispose(); document.body.replaceChildren(); });

async function bootSector() {
  const loaded = { leg: bootLeg, content: bootContent };
  const seed = 0x4b54524c;
  const store = createRunStore(initialRunState(seed, 'shell', 'operator'));
  let runner: LegRunner;
  const kernel: KernelMutators = {
    setScheduler: (id, params) => runner.kernel!.setScheduler(id, params), setReplacementPolicy: id => runner.kernel!.setReplacementPolicy(id),
    setDiskPolicy: id => runner.kernel!.setDiskPolicy(id), setAllocationStrategy: id => runner.kernel!.setAllocationStrategy(id),
    setDeadlockStrategy: id => runner.kernel!.setDeadlockStrategy(id), syscall: request => runner.kernel!.syscall(request),
  };
  const bus = new ObservedBus({ store, kernel, admit: (cmd, origin, at) => runner.director!.admit(cmd, origin, at), handlers: {
    useAbility: vi.fn(), interaction: (id, anchor, at) => { runner.director!.interaction(id, anchor, at); }, terminal: vi.fn(),
  } });
  const failure = vi.fn();
  runner = new LegRunner({ runStore: store, commandBus: bus, createKernel, streams: createRunStreams(seed), onEvent: () => undefined, replay: null, epitaphs: copy,
    persist: () => undefined, buildId: 'wp24-test', savedAtIso: () => '2026-09-20T00:00:00.000Z', throughputTarget: () => 0.1,
    onLegEvent: () => undefined, codexSignal: vi.fn(), onDerezz: vi.fn(), onFailure: failure, onRunnerFailure: failure });
  runner.enter(loaded.leg, { maxTicks: 1000, stageContext: null, zeroSegmentAllowance: null }, r => r.applyContent(loaded.content));
  let now = 0;
  const tick = (): void => {
    const k = runner.kernel!;
    runner.observeCommands(bus.drain(k.tick));
    runner.preTick(k.tick);
    if (runner.director!.tickLimitReached) return;
    runner.postTick(k.tick, k.step());
    now += 500;
  };
  const requisition = new RequisitionPanel({ document, overlay, bus, run: () => store.get(), outcomes: bus, clock: () => now });
  const gate = new GatePanel({ document, overlay, bus, run: () => store.get() });
  cleanups.push(() => { requisition.dispose(); gate.dispose(); });
  const flush = (): void => { requisition.flush(); gate.flush(); };
  const button = (label: string): HTMLButtonElement => {
    const found = [...overlay.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label);
    if (found === undefined) throw new Error(`Missing button ${label}`);
    return found;
  };
  const field = (label: string): HTMLInputElement | HTMLSelectElement => {
    const found = overlay.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
    if (found === null) throw new Error(`Missing field ${label}`);
    return found;
  };
  const setAmount = (service: string, amount: number): void => { const f = field(`${service} amount`); f.value = String(amount); f.dispatchEvent(new Event('change')); };
  const interactions = (): [string, string][] => store.get().decisions.filter(record => record.kind === 'interaction').map(record => [record.choice, record.outcome]);
  return { store, runner, bus, requisition, gate, tick, flush, button, field, setAmount, interactions, failure, clock: () => now };
}

/**
 * The known-good script's requisition steps in order, as the bus records
 * them, with the outcome the leg's handlers leave on each: a submission and
 * the gate are judged, a mode or a batch line is marked only when it fails
 * to parse and otherwise stays pending, which is what the harness records.
 * Mirrored from tests/legs/boot_sector/scripts.ts, which the harness pulls
 * through loadLeg and its file-URL root that happy-dom cannot resolve; the
 * first case pins every string below to that file's text.
 */
const SCRIPTED: readonly [string, string][] = [
  ['boot.set_mode @ anchor.win.quota:kernel', 'pending'],
  ['boot.batch_request @ anchor.win.quota:40', 'pending'],
  ['boot.batch_request @ anchor.win.blocks:40', 'pending'],
  ['boot.trap_purchase @ anchor.win.quota', 'good'],
  ['boot.set_mode @ anchor.win.bandwidth:kernel', 'pending'],
  ['boot.batch_request @ anchor.win.bandwidth:50', 'pending'],
  ['boot.batch_request @ anchor.win.manifest', 'pending'],
  ['boot.trap_purchase @ anchor.win.bandwidth', 'good'],
  ['boot.set_mode @ anchor.win.identity:user', 'pending'],
  ['boot.trap_purchase @ anchor.win.identity', 'good'],
  ['boot.set_mode @ anchor.win.priority:user', 'pending'],
  ['boot.trap_purchase @ anchor.win.priority', 'good'],
  ['boot.choose_disc @ anchor.disc_plinth:blocks', 'good'],
];

describe('the requisition panel', () => {
  it('the mirrored script is the script', () => {
    const source = readFileSync('tests/legs/boot_sector/scripts.ts', 'utf8');
    for (const [choice] of SCRIPTED) {
      const [id = "", anchor = ""] = choice.split(' @ ');
      expect(source, choice).toContain(`'${id}', '${anchor}'`);
    }
  });

  it('renders the six windows from the leg data with the depot ambient line and the run tier price', async () => {
    const r = await bootSector();
    r.requisition.open(); r.flush();
    expect(overlay.querySelectorAll('[data-window]')).toHaveLength(6);
    expect(overlay.textContent).toContain(DEPOT_AMBIENT);
    expect(overlay.querySelector('[data-window="quota"]')?.textContent).toContain('2 cycles per quota, lots of 25');
    expect(overlay.querySelector('[data-window="identity"]')?.textContent).toContain('No goods');
    expect(overlay.querySelector('h2')?.textContent).toBe('Requisition');
    r.requisition.showSignage(); r.flush();
    expect(overlay.querySelector('h2')?.textContent).toBe(TRAP_SIGNAGE);
    for (const def of ['quota', 'blocks', 'bandwidth', 'manifest', 'identity', 'priority']) {
      expect(r.button(`${overlay.querySelector(`[data-window="${def}"] h3`)?.textContent} mode`).textContent).toBe('Mode: user');
    }
  });

  it('a full requisition through the panel records exactly the script\'s anchor strings, kinds and outcomes, then the gate ends the leg', async () => {
    const r = await bootSector();
    r.requisition.open(); r.flush();
    // The script, minus its inspect, terminal and syscall steps, which are not the panel's.
    r.button('Request memory quota mode').click(); r.tick(); r.flush();
    r.setAmount('Request memory quota', 40); r.button('Add Request memory quota').click(); r.tick(); r.flush();
    r.setAmount('Requisition storage blocks', 40); r.button('Add Requisition storage blocks').click(); r.tick(); r.flush();
    expect(overlay.querySelector('[aria-label="Pending submission"]')?.textContent).toContain('quota: 40');
    expect((r.field('Submit at window') as HTMLSelectElement).disabled).toBe(true);
    r.button('Submit').click(); r.tick(); r.flush();
    r.button('Widen the I/O grant mode').click(); r.tick(); r.flush();
    r.setAmount('Widen the I/O grant', 50); r.button('Add Widen the I/O grant').click(); r.tick(); r.flush();
    r.button('Add Open the convoy manifest').click(); r.tick(); r.flush();
    r.button('Submit').click(); r.tick(); r.flush();
    // Bare submissions choose their window; identity and priority are correct in user mode, so the toggle is left where it starts.
    (r.field('Submit at window') as HTMLSelectElement).value = 'identity'; r.field('Submit at window').dispatchEvent(new Event('change'));
    r.button('Submit').click(); r.tick(); r.flush();
    (r.field('Submit at window') as HTMLSelectElement).value = 'priority'; r.field('Submit at window').dispatchEvent(new Event('change'));
    r.button('Submit').click(); r.tick(); r.flush();
    // The two set_mode steps that leave identity and priority on user are the toggle's starting state, so the panel has nothing to send for them.
    const expected = SCRIPTED.filter(([choice]) => !choice.startsWith('boot.choose_disc') && !choice.includes('identity:user') && !choice.includes('priority:user'));
    expect(r.interactions()).toEqual(expected);
    const ledger = r.store.get().resources;
    // Four traps, the goods at the operator prices, and entry refilled bandwidth to 0.6 of the cap (refillBandwidth: the Boot Sector is not a depot leg).
    expect(ledger).toEqual({ cycles: 1600 - 4 * 4 - 40 * 2 - 40 * 3 - 50 * 4, quota: 940, blocks: 160, bandwidth: 36 + 50 });
    expect(overlay.querySelector('[aria-label="Submissions"]')?.textContent).toContain('kernel at quota; quota: 40, blocks: 40; ok');
    expect(overlay.querySelector('.kt-refusal')).toBeNull();
    r.button('Close').click(); r.flush();
    expect(r.requisition.isOpen).toBe(false);
    r.gate.open(); r.flush();
    expect(overlay.querySelector('h2')?.textContent).toBe(GATE_QUESTION);
    expect(overlay.querySelector('[data-disc="shell"]')?.textContent).toContain('(issued)');
    expect(overlay.querySelector('[data-disc="compiler"]')?.textContent).toContain('cycles: 700');
    r.button('blocks').click(); r.tick(); r.flush();
    expect(r.interactions().at(-1)).toEqual(['boot.choose_disc @ anchor.disc_plinth:blocks', 'good']);
    expect(overlay.querySelector('[data-outcome="good"]')?.textContent).toBe(`blocks: good. ${GATE_LINES.good}`);
    expect(legDone(r.store.get(), 'boot_sector')).toBe(true);
    expect(r.runner.finished).toBe(true);
    expect(r.runner.ticksElapsed).toBeLessThan(ZERO_SEGMENT_TICK_ALLOWANCE);
    expect(r.failure).not.toHaveBeenCalled();
    const outcome = r.runner.exit();
    expect(outcome.objectivesMet).toContain('obj.boot_sector.disc_class_tradeoff');
    expect(outcome.objectivesMet).toContain('obj.boot_sector.acquire_via_trap');
  });

  it('an errno comes back as a refusal line with the man page beside it, and a wrong gate answer is costly', async () => {
    const r = await bootSector();
    r.requisition.open(); r.flush();
    // User mode at a kernel window: EPERM, still charged the trap.
    r.button('Submit').click(); r.tick(); r.flush();
    expect(r.interactions()).toEqual([['boot.trap_purchase @ anchor.win.quota', 'costly']]);
    expect(overlay.querySelector('.kt-refusal')?.textContent).toBe('EPERM. man EPERM.');
    expect(r.store.get().resources.cycles).toBe(1596);
    for (let i = 0; i < 4; i++) r.tick();
    r.flush();
    expect(overlay.querySelector('.kt-refusal')).toBeNull();
    // A zero amount at a stocked window: EINVAL before any mode is consulted.
    r.button('Request memory quota mode').click(); r.tick(); r.flush();
    r.setAmount('Request memory quota', 0); r.button('Add Request memory quota').click(); r.tick(); r.flush();
    r.button('Submit').click(); r.tick(); r.flush();
    expect(overlay.querySelector('.kt-refusal')?.textContent).toBe('EINVAL. man EINVAL.');
    // More blocks than the ledger can pay for: ENOMEM from the handler.
    r.button('Requisition storage blocks mode').click(); r.tick(); r.flush();
    r.setAmount('Requisition storage blocks', 10000); r.button('Add Requisition storage blocks').click(); r.tick(); r.flush();
    r.button('Submit').click(); r.tick(); r.flush();
    expect(overlay.querySelector('.kt-refusal')?.textContent).toBe('ENOMEM. man ENOMEM.');
    expect(r.interactions().filter(([choice]) => choice.startsWith('boot.trap_purchase')).map(([, outcome]) => outcome)).toEqual(['costly', 'costly', 'costly']);
    r.gate.open(); r.flush();
    r.button('cycles').click(); r.tick(); r.flush();
    expect(overlay.querySelector('[data-outcome="costly"]')?.textContent).toBe(`cycles: costly. ${GATE_LINES.costly}`);
    expect(r.runner.finished).toBe(true);
  });

  it('every string the panel dispatches parses as the leg parses it', async () => {
    const r = await bootSector();
    r.requisition.open(); r.flush();
    r.button('Add Open the convoy manifest').click(); r.tick(); r.flush();
    r.setAmount('Lower a Program starting priority', 1); r.button('Add Lower a Program starting priority').click(); r.tick(); r.flush();
    const parsed = r.store.get().decisions.filter(record => record.kind === 'interaction').map(record => parseInteractionChoice(record.choice));
    expect(parsed).toEqual([
      { id: 'boot.batch_request', anchor: 'anchor.win.manifest', argument: null },
      { id: 'boot.batch_request', anchor: 'anchor.win.priority', argument: '1' },
    ]);
  });
});
