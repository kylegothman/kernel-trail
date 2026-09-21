// @vitest-environment happy-dom
/**
 * WP-24 section 2: the Boot Sector driver and the allowance it turns off.
 * The first case is the runner's side: a zero-segment leg entered with a null
 * allowance runs past ZERO_SEGMENT_TICK_ALLOWANCE and ends on its leg_done
 * record and on nothing else, in front of a person as in a replay.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTick, createKernel } from '../../src/kernel/index';
import { CommandBus, type KernelMutators } from '../../src/game/CommandBus';
import { LegRunner } from '../../src/game/LegRunner';
import { ZERO_SEGMENT_TICK_ALLOWANCE } from '../../src/game/RunDirector';
import { createRunStore } from '../../src/game/runStore';
import { initialRunState } from '../../src/game/replay/runReplay';
import { createRunStreams } from '../../src/game/replay/types';
import type { EpitaphCopySource } from '../../src/game/convoy/derezz';
import { createSyntheticLeg } from '../game/fixtures/syntheticLeg';

const copy: EpitaphCopySource = { templates: reason => [{ id: reason, reason, inscription: '{NAME} stopped.', cause: 'Synthetic fixture.', codexEntry: `test.${reason}` }] };

function rig(seed = 21) {
  const store = createRunStore(initialRunState(seed, 'shell', 'operator'));
  let runner: LegRunner;
  const kernel: KernelMutators = {
    setScheduler: (id, params) => runner.kernel!.setScheduler(id, params),
    setReplacementPolicy: id => runner.kernel!.setReplacementPolicy(id),
    setDiskPolicy: id => runner.kernel!.setDiskPolicy(id),
    setAllocationStrategy: id => runner.kernel!.setAllocationStrategy(id),
    setDeadlockStrategy: id => runner.kernel!.setDeadlockStrategy(id),
    syscall: request => runner.kernel!.syscall(request),
  };
  const bus = new CommandBus({ store, kernel, admit: (cmd, origin, at) => runner.director!.admit(cmd, origin, at), handlers: {
    useAbility: (id, target, at) => runner.director!.useAbility(id, target, at),
    interaction: (id, anchor, at) => { runner.director!.interaction(id, anchor, at); },
    terminal: (line, at) => runner.director!.terminal(line, at),
  } });
  const failure = vi.fn();
  runner = new LegRunner({ runStore: store, commandBus: bus, createKernel, streams: createRunStreams(seed), onEvent: () => undefined, replay: null, epitaphs: copy,
    persist: () => undefined, buildId: 'wp24-test', savedAtIso: () => '2026-09-20T00:00:00.000Z', throughputTarget: () => 0.1,
    onLegEvent: () => undefined, codexSignal: vi.fn(), onDerezz: vi.fn(), onFailure: failure, onRunnerFailure: failure });
  const tick = (): void => {
    const k = runner.kernel!;
    runner.observeCommands(bus.drain(k.tick));
    runner.preTick(k.tick);
    if (runner.director!.tickLimitReached) return;
    runner.postTick(k.tick, k.step());
  };
  return { store, runner, tick, failure };
}

describe('the zero-segment allowance as an option', () => {
  it('null runs past the allowance and ends on the leg_done record alone; the omitted option is the constant', () => {
    const r = rig();
    r.runner.enter(createSyntheticLeg(), { maxTicks: 1000, stageContext: null, zeroSegmentAllowance: null });
    for (let i = 0; i < ZERO_SEGMENT_TICK_ALLOWANCE + 50; i++) r.tick();
    expect(r.runner.finished).toBe(false);
    expect(r.runner.ticksElapsed).toBe(ZERO_SEGMENT_TICK_ALLOWANCE + 50);
    expect(r.failure).not.toHaveBeenCalled();
    r.store.mutate(run => { run.decisions.push({ tick: asTick(r.runner.ticksElapsed), legId: 'boot_sector', kind: 'leg_done', choice: 'gate', outcome: 'pending', relatedObjective: null }); });
    expect(r.runner.finished).toBe(true);
    r.runner.exit();
    expect(r.store.get().decisions.filter(record => record.kind === 'leg_done').map(record => record.choice)).toEqual(['gate']);
    const omitted = rig();
    omitted.runner.enter(createSyntheticLeg(), { maxTicks: 1000, stageContext: null });
    for (let i = 0; i < ZERO_SEGMENT_TICK_ALLOWANCE + 5 && !omitted.runner.finished; i++) omitted.tick();
    expect(omitted.runner.ticksElapsed).toBe(ZERO_SEGMENT_TICK_ALLOWANCE);
  });
});

/* ------------------------------------------------------------------ */
/* The driver against a stub session, beat by beat                     */
/* ------------------------------------------------------------------ */

import { Group, PerspectiveCamera } from 'three/webgpu';
import { BootSectorDriver, BEAT_ANCHORS, EXITS, RING_STEP_MS, TERMINAL_HINT, layoutCarriesBeats, type DriverHost, type DriverStructure } from '../../src/app/onboarding/BootSectorDriver';
import { hintFor, hintProblems } from '../../src/app/onboarding/hints';
import { createPacing } from '../../src/app/pacing';
import { ObservedBus } from '../../src/app/panels/RefusalLine';
import { RequisitionPanel } from '../../src/app/panels/RequisitionPanel';
import { GatePanel } from '../../src/app/panels/GatePanel';
import type { FocusCameraState } from '../../src/render';
import { MODULE_METRES, ONBOARDING, STELE_LIGHT_MS } from '../../src/legs/boot_sector/onboarding';
import { layout as bootLayout } from '../../src/legs/boot_sector/stage';
import bootLeg, { content as bootContent } from '../../src/legs/boot_sector/index';

// The happy-dom transform resolves the registry's dynamic imports eagerly; the unshipped legs are replaced at their imported boundary.
vi.mock('../../src/legs/registry', () => ({ LEG_LOADERS: {} }));

function realRig() {
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
  runner = new LegRunner({ runStore: store, commandBus: bus, createKernel, streams: createRunStreams(seed), onEvent: () => undefined, replay: null, epitaphs: copy,
    persist: () => undefined, buildId: 'wp24-test', savedAtIso: () => '2026-09-20T00:00:00.000Z', throughputTarget: () => 0.1,
    onLegEvent: () => undefined, codexSignal: vi.fn(), onDerezz: vi.fn(), onFailure: vi.fn(), onRunnerFailure: vi.fn() });
  runner.enter(bootLeg, { maxTicks: 1000, stageContext: null, zeroSegmentAllowance: null }, r => r.applyContent(bootContent));
  const tick = (): void => { const k = runner.kernel!; runner.observeCommands(bus.drain(k.tick)); runner.preTick(k.tick); if (!runner.director!.tickLimitReached) runner.postTick(k.tick, k.step()); };
  return { store, runner, bus, tick };
}

function stubHost() {
  const doc = document;
  const canvas = doc.createElement('canvas'); doc.body.append(canvas);
  const overlay = doc.createElement('div'); doc.body.append(overlay);
  const structures: DriverStructure[] = bootLayout.anchors.map(anchor => { const root = new Group(); root.position.set(...anchor.position); root.updateMatrix(); return { id: anchor.id, root }; });
  const scene = new Map<string, Group>();
  for (const name of ['kt.env.ground.grid', 'kt.env.horizon.line', 'kt.labels']) scene.set(name, new Group());
  const state = { mode: 'free', target: null } as { mode: FocusCameraState['mode']; target: { id: string } | null };
  const focus = { get state() { return state as unknown as FocusCameraState; }, camera: new PerspectiveCamera(), engage: vi.fn((id: string) => { state.mode = 'locked'; state.target = { id }; return true; }) };
  const notes: string[] = [];
  const hudElement = doc.createElement('div');
  const pips = doc.createElement('div');
  for (const name of ['KESTREL', 'LUMEN', 'ORRERY', 'SABLE', 'VESPER']) { const pip = doc.createElement('div'); pip.className = 'kt-pip'; const value = doc.createElement('span'); value.className = 'kt-value'; value.textContent = name; pip.append(value); pips.append(pip); }
  const hint = doc.createElement('div');
  const hovers: (string | null)[] = [];
  const hud = { element: hudElement, note: (text: string) => { notes.push(text); }, cell: (region: 'convoyPips' | 'focusHint') => (region === 'convoyPips' ? pips : hint), setHover: (id: string | null) => { hovers.push(id); } };
  const scales: number[] = [];
  const pacing = createPacing({ setTimeScale: scale => { scales.push(scale); } });
  const listeners = new Set<(name: string, argv: readonly string[], result: { ok: boolean }) => void>();
  const terminal = { shell: { onCommand: (l: (name: string, argv: readonly string[], result: { ok: boolean }) => void) => { listeners.add(l); return () => { listeners.delete(l); }; } } };
  const restricted: (readonly string[] | null)[] = [];
  const enabled: (readonly string[] | null)[] = [];
  const rig = realRig();
  let now = 10_000;
  const requisition = new RequisitionPanel({ document: doc, overlay, bus: rig.bus, run: () => rig.store.get(), tick: () => rig.runner.kernel!.tick, clock: () => now });
  const gate = new GatePanel({ document: doc, overlay, bus: rig.bus, run: () => rig.store.get(), tick: () => rig.runner.kernel!.tick });
  const host: DriverHost = {
    document: doc, overlay, canvas, run: () => rig.store.get(), structures: () => structures, sceneObject: name => scene.get(name) ?? null,
    focus, hud, pacing, terminal: () => terminal, interactions: { restrict: ids => { restricted.push(ids); }, enableOnly: ids => { enabled.push(ids); } }, requisition, gate, clock: () => now,
  };
  const advance = (ms: number): void => { now += ms; };
  const flush = (): void => { requisition.flush(); gate.flush(); };
  const button = (label: string): HTMLButtonElement => {
    const found = [...overlay.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label);
    if (found === undefined) throw new Error(`Missing button ${label}`);
    return found;
  };
  const visible = (id: string): boolean => { const s = structures.find(candidate => candidate.id === id)!; return s.root.visible && s.root.scale.x > 0; };
  const runCommand = (name: string, argv: string[], ok = true): void => { for (const l of listeners) l(name, argv, { ok }); };
  const card = (): { beat: string | null; text: string | null } => { const el = overlay.querySelector('.kt-card--beat'); return { beat: el?.getAttribute('data-beat') ?? null, text: el?.querySelector('.kt-beat-hint')?.textContent ?? null }; };
  return { ...rig, host, structures, scene, state, focus, notes, hovers, hudElement, pips, hint, pacing, scales, restricted, enabled, requisition, gate, overlay, advance, flush, button, visible, runCommand, clock: () => now, listeners, card };
}

describe('the Boot Sector driver', () => {
  it('the layout guard, the hint lines and the exit table cover exactly the eight beats', () => {
    // The ruling before the replay: every beat says what the player must do next, in one sentence, naming the input.
    for (const beat of ONBOARDING) {
      expect(beat.hint.trim(), beat.id).not.toBe('');
      expect(/click|press|drag|nothing to press|verb/i.test(beat.hint), `${beat.id}: ${beat.hint} names its input`).toBe(true);
    }
    expect(ONBOARDING.find(beat => beat.id === 'beat.convoy')?.hintAfterMs).toBe(6000);
    expect(layoutCarriesBeats(bootLayout.anchors.map(anchor => anchor.id))).toBe(true);
    expect(layoutCarriesBeats(['vault', 'console'])).toBe(false);
    expect(BEAT_ANCHORS).toHaveLength(1 + 1 + 1 + 5 + 6);
    expect(hintProblems()).toEqual([]);
    expect(Object.keys(EXITS)).toEqual(ONBOARDING.map(beat => beat.id));
    for (const beat of ONBOARDING) expect(EXITS[beat.id]?.text).toBe(beat.exit);
  });

  it('runs the eight beats in order on their exit conditions and nothing else', () => {
    const s = stubHost();
    const driver = new BootSectorDriver(s.host);
    const beats: string[] = [];
    driver.onBeat(beat => beats.push(beat.id));
    // 1. Nothing exists: only the module ring; the HUD hidden; the clock held; orbit blocked.
    expect(driver.beatId).toBe('beat.void');
    // The card says what to do, from the beat's own hint, while the beat is active.
    expect(s.card()).toEqual({ beat: 'beat.void', text: hintFor(ONBOARDING[0]!) });
    expect(s.visible('anchor.plate')).toBe(true);
    expect(s.visible('anchor.convoy.lumen')).toBe(false);
    expect(s.visible('anchor.win.quota')).toBe(false);
    expect(s.scene.get('kt.env.ground.grid')?.visible).toBe(false);
    expect(s.hudElement.hidden).toBe(true);
    expect([...s.pips.children].every(pip => (pip as HTMLElement).hidden)).toBe(true);
    expect(s.pacing.held()).toEqual(['beat.void']);
    // The seven verbs are listed from entry and none is enabled before the reach, so the beats cannot be skipped from the anchors panel.
    expect(s.restricted).toEqual([]);
    expect(s.enabled).toEqual([[]]);
    const blocked = new PointerEvent('pointerdown', { bubbles: true, cancelable: true }); const reached = vi.fn();
    s.host.canvas.addEventListener('pointerdown', reached); s.host.canvas.dispatchEvent(blocked);
    expect(reached).not.toHaveBeenCalled();
    s.advance(2999); driver.update(s.clock());
    expect(driver.beatId).toBe('beat.void');
    // 2. The floor writes itself: the hold lifts, orbit is added, the sweep runs one ring per RING_STEP_MS to the horizon.
    s.advance(1); driver.update(s.clock());
    expect(driver.beatId).toBe('beat.floor');
    expect(s.card()).toEqual({ beat: 'beat.floor', text: 'Drag on the floor to orbit the camera.' });
    expect(s.pacing.held()).toEqual([]);
    expect(s.hudElement.hidden).toBe(false);
    expect(s.scene.get('kt.env.ground.grid')?.visible).toBe(true);
    s.host.canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(reached).toHaveBeenCalledTimes(1);
    expect(s.visible('anchor.block_stack')).toBe(false);
    expect(s.visible('anchor.cpu_pillar')).toBe(false);
    s.advance(RING_STEP_MS * 2); driver.update(s.clock());
    expect(s.visible('anchor.cpu_pillar')).toBe(true);
    expect(s.visible('anchor.win.quota')).toBe(false);
    expect(s.scene.get('kt.labels')?.visible).toBe(false);
    const furthest = Math.max(...bootLayout.anchors.filter(a => !a.id.startsWith('anchor.convoy.') && a.id !== 'anchor.block_stack').map(a => Math.hypot(a.position[0], a.position[2])));
    // Three rings are down (the first with the beat, two with the last advance); the rest land one per step.
    for (let ring = 4; (ring - 1) * MODULE_METRES < furthest; ring++) { s.advance(RING_STEP_MS); driver.update(s.clock()); }
    expect(s.visible('anchor.win.quota')).toBe(true);
    expect(s.scene.get('kt.labels')?.visible).toBe(true);
    expect(s.scene.get('kt.env.horizon.line')?.visible).toBe(true);
    // 3. The convoy lights in roster order at STELE_LIGHT_MS; the row lights with it; a click on a stele engages the rig.
    expect(driver.beatId).toBe('beat.convoy');
    expect(s.card().text).toBe('Click a stele to inspect a convoy member.');
    expect(s.visible('anchor.convoy.lumen')).toBe(true);
    expect(s.visible('anchor.convoy.sable')).toBe(false);
    const pipOf = (name: string): HTMLElement => [...s.pips.children].find(pip => pip.textContent === name) as HTMLElement;
    expect(pipOf('LUMEN').hidden).toBe(false); expect(pipOf('SABLE').hidden).toBe(true);
    s.advance(STELE_LIGHT_MS * 4); driver.update(s.clock());
    expect(['sable', 'orrery', 'kestrel', 'vesper'].every(member => s.visible(`anchor.convoy.${member}`))).toBe(true);
    expect([...s.pips.children].every(pip => !(pip as HTMLElement).hidden)).toBe(true);
    expect(s.visible('anchor.block_stack')).toBe(false);
    // Beat three now hints after six seconds of unheld time, as the floor does: the line is the card's sentence. The stele took 1600 ms.
    s.advance(6_000 - STELE_LIGHT_MS * 4 - 1); driver.update(s.clock());
    expect(s.notes).toEqual([]);
    s.advance(20_000); driver.update(s.clock());
    expect(driver.beatId).toBe('beat.convoy');
    expect(s.notes).toEqual(['Click a stele to inspect a convoy member.']);
    s.focus.engage('anchor.convoy.orrery'); driver.update(s.clock());
    // 4. The reach: on focus release the stack appears, the panel shows the one verb, and the hint follows 20 s later.
    expect(driver.beatId).toBe('beat.reach');
    expect(s.card().beat).toBe('beat.reach');
    expect(s.visible('anchor.block_stack')).toBe(false);
    s.state.mode = 'releasing'; driver.update(s.clock());
    expect(s.visible('anchor.block_stack')).toBe(true);
    expect(s.restricted.at(-1)).toEqual(['boot.direct_reach']);
    expect(s.enabled.at(-1)).toBeNull();
    s.state.mode = 'free';
    s.advance(19_999); driver.update(s.clock()); expect(s.notes).toHaveLength(1);
    s.advance(1); driver.update(s.clock()); expect(s.notes.at(-1)).toBe(hintFor(ONBOARDING[3]!));
    s.advance(60_000); driver.update(s.clock()); expect(s.notes).toHaveLength(2);
    s.bus.dispatch({ kind: 'interaction', id: 'boot.direct_reach', anchor: 'anchor.block_stack' }, { source: 'world', legId: 'boot_sector' });
    s.tick(); driver.update(s.clock());
    expect(s.store.get().decisions.at(-1)?.outcome).toBe('costly');
    // 5. The terminal: the focus hint names the key; the beat ends on man EPERM through the shell and on nothing else.
    expect(driver.beatId).toBe('beat.terminal');
    expect(s.restricted.at(-1)).toBeNull();
    expect(s.hint.textContent).toBe(TERMINAL_HINT);
    driver.update(s.clock());
    expect(s.listeners.size).toBe(1);
    s.runCommand('man', ['syscall']); driver.update(s.clock()); expect(driver.beatId).toBe('beat.terminal');
    s.runCommand('man', ['EPERM'], false); driver.update(s.clock()); expect(driver.beatId).toBe('beat.terminal');
    s.runCommand('man', ['EPERM']); driver.update(s.clock());
    // 6. The trap: the requisition opens; a refused submission does not end the beat; a successful one does.
    expect(driver.beatId).toBe('beat.trap');
    expect(s.hint.textContent).toBe('');
    expect(s.listeners.size).toBe(0);
    expect(s.requisition.isOpen).toBe(true);
    s.flush();
    s.button('Submit').click(); s.tick(); s.flush(); driver.update(s.clock());
    expect(driver.beatId).toBe('beat.trap');
    expect(s.overlay.querySelector('.kt-refusal')?.textContent).toBe('EPERM. man EPERM.');
    s.button('Request memory quota mode').click(); s.tick(); s.flush();
    s.button('Submit').click(); s.tick(); s.flush(); driver.update(s.clock());
    // 7. The batching lesson: the signage in the heading, until the player closes the requisition.
    expect(driver.beatId).toBe('beat.batching');
    s.flush();
    expect(s.overlay.querySelector('.kt-panel--requisition h2')?.textContent).toContain('4 cycles');
    s.button('Close').click(); s.flush(); driver.update(s.clock());
    // 8. The gate: the leg ends on leg_done, and the driver is done.
    expect(driver.beatId).toBe('beat.gate');
    s.flush();
    s.button('blocks').click(); s.tick(); driver.update(s.clock());
    expect(driver.done).toBe(true);
    expect(s.runner.finished).toBe(true);
    expect(s.card()).toEqual({ beat: null, text: null });
    expect(beats).toEqual(ONBOARDING.slice(1).map(beat => beat.id));
    expect(s.restricted.at(-1)).toBeNull();
    expect(s.enabled.at(-1)).toBeNull();
    driver.dispose();
    expect(s.pacing.held()).toEqual([]);
  });

  it('a hint counts only unheld time, and dispose restores every hidden thing', () => {
    const s = stubHost();
    const driver = new BootSectorDriver(s.host);
    s.advance(3000); driver.update(s.clock());
    expect(driver.beatId).toBe('beat.floor');
    // The stand-in's five rings land in two seconds, so the floor's six-second hint is never reached here; the reach's is.
    s.advance(RING_STEP_MS * 6); driver.update(s.clock());
    expect(driver.beatId).toBe('beat.convoy');
    s.focus.engage('anchor.convoy.lumen'); driver.update(s.clock());
    s.state.mode = 'free'; driver.update(s.clock());
    expect(driver.beatId).toBe('beat.reach');
    const release = s.pacing.hold('player');
    s.advance(60_000); driver.update(s.clock());
    expect(s.notes).toEqual([]);
    release();
    s.advance(19_000); driver.update(s.clock());
    expect(s.notes).toEqual([]);
    s.advance(1000); driver.update(s.clock());
    expect(s.notes).toEqual([hintFor(ONBOARDING[3]!)]);
    driver.dispose();
    expect(s.structures.every(structure => structure.root.visible && structure.root.scale.x === 1)).toBe(true);
    expect(s.hudElement.hidden).toBe(false);
    expect([...s.pips.children].every(pip => !(pip as HTMLElement).hidden)).toBe(true);
    expect(s.scene.get('kt.labels')?.visible).toBe(true);
    expect(s.restricted.at(-1)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The title screen (section 5): the bible's words, nothing new         */
/* ------------------------------------------------------------------ */

import { readFileSync } from 'node:fs';
import { difficultyText, discClassText } from '../../src/app/screens/TitleScreen';

describe('the title screen', () => {
  it('describes each class and tier in sentences the narrative bible carries, with the 5.2 ledger at the chosen tier', () => {
    const bible = readFileSync('docs/04-NARRATIVE-BIBLE.md', 'utf8').replaceAll(/\s+/g, ' ').replaceAll('`', '').toLowerCase();
    const sentences = (text: string): string[] => text.split(/(?<=\.)\s+/).map(sentence => sentence.trim()).filter(Boolean);
    // A sentence may begin where the bible's runs on ("Who should pick it: first run, always."), so the match is case-blind.
    const carried = (sentence: string): boolean => bible.includes(sentence.toLowerCase());
    for (const disc of ['shell', 'daemon', 'compiler'] as const) {
      const [first, second] = sentences(discClassText(disc, 'operator'));
      expect(carried(first ?? ''), first).toBe(true);
      expect(carried(second ?? ''), second).toBe(true);
    }
    for (const tier of ['novice', 'operator', 'architect', 'kernel_space'] as const) {
      for (const sentence of sentences(difficultyText(tier))) expect(carried(sentence), sentence).toBe(true);
    }
    expect(discClassText('shell', 'operator')).toContain('Starts with 1600 cycles, 900 quota, 120 blocks, 60 bandwidth.');
    expect(discClassText('compiler', 'architect')).toContain('Starts with 560 cycles, 336 quota, 72 blocks, 24 bandwidth.');
  });
});
