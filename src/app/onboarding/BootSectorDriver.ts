/**
 * WP-24 section 2: the Boot Sector driver.
 *
 * Runs the eight beats of `ONBOARDING` in order, as data, on top of the
 * session. For each beat it does what the beat's `world` says, waits for
 * exactly what the beat's `exit` says, and after `hintAfterMs` of unheld wall
 * time without the expected action shows the beat's line through the HUD
 * alert stack. The beats are not modal: the clock runs at the player's rate,
 * a hint is a line and not a dialog, and nothing traps focus. Beat one is the
 * only beat with a duration; it holds the clock for its 3000 ms because the
 * world is still black. The driver contains no exit condition of its own;
 * `EXITS` below is each beat's `exit` as the shipped session exposes it.
 *
 * The stand-in stage has no rings to write and no lit state on a stele, so
 * beat two is a per-ring visibility sweep at MODULE_METRES a step and beat
 * three shows each stele as it lights; the structures package replaces both.
 * A slab the stage instances ignores `visible`, so a hidden slab is scaled to
 * nothing until its ring lands (pre-flight item 3).
 */
import { Raycaster, Vector2, type Camera, type Object3D } from 'three/webgpu';
import type { FocusCameraState } from '@render';
import type { RunState } from '@game/types';
import { legDone } from '@game/RunDirector';
import { ANCHORS } from '@legs/boot_sector/interactions';
import { MODULE_METRES, ONBOARDING, STELE_LIGHT_MS, type OnboardingBeat } from '@legs/boot_sector/onboarding';
import { ROSTER } from '@legs/boot_sector/populate';
import { WINDOWS, parseInteractionChoice, reduceRequisition } from '@legs/boot_sector/windows';
import type { Pacing } from '../pacing';
import { HINTS } from './hints';

/** The sweep's step, which the data file does not fix (pre-flight ruling 9.12); one ring per STELE_LIGHT_MS. */
export const RING_STEP_MS = 400;
/** The focus hint's line for beat 5, in the hint's own format: the key that opens the terminal. */
export const TERMINAL_HINT = 'terminal  [`] open';

const STELE_PREFIX = 'anchor.convoy.';
const STELE_IDS: readonly string[] = ROSTER.map(({ member }) => `${STELE_PREFIX}${member}`);
/** What the beats reach for; a layout without all of them is not the Boot Sector's (pre-flight ruling 9.5). */
export const BEAT_ANCHORS: readonly string[] = [ANCHORS.plate, ANCHORS.blockStack, ANCHORS.discPlinth, ...STELE_IDS, ...WINDOWS.map(def => def.anchor)];

export function layoutCarriesBeats(anchorIds: readonly string[]): boolean {
  const present = new Set(anchorIds);
  return BEAT_ANCHORS.every(id => present.has(id));
}

/** A stage structure as the driver sees it: an anchor id and the object it moves. */
export interface DriverStructure {
  readonly id: string;
  readonly root: Object3D;
}

export interface DriverHud {
  readonly element: HTMLElement;
  note(text: string): void;
  cell(region: 'convoyPips' | 'focusHint'): HTMLElement;
}

export interface DriverTerminal {
  readonly shell: { onCommand(listener: (name: string, argv: readonly string[], result: { readonly ok: boolean }) => void): () => void };
}

export interface DriverHost {
  readonly document: Document;
  readonly canvas: HTMLCanvasElement;
  readonly run: () => Readonly<RunState>;
  readonly structures: () => readonly DriverStructure[];
  /** Scene objects by name: the environment ground and horizon, the labels group. */
  readonly sceneObject: (name: string) => Object3D | null;
  readonly focus: { readonly state: FocusCameraState; readonly camera: Camera; engage(id: string): boolean };
  readonly hud: DriverHud;
  readonly pacing: Pacing;
  readonly terminal: () => DriverTerminal | null;
  readonly interactions: { restrict(ids: readonly string[] | null): void };
  readonly requisition: { open(): void; showSignage(): void; readonly isOpen: boolean };
  readonly gate: { open(): void };
  /** Wall clock in milliseconds. */
  readonly clock: () => number;
}

export type BeatId = (typeof ONBOARDING)[number]['id'];

/** Each beat's exit as the driver checks it, beside the data file's text (acceptance 2). */
export const EXITS: Readonly<Record<string, { readonly text: string; readonly observed: string }>> = {
  'beat.void': { text: 'the grid floor begins writing itself', observed: 'durationMs of wall time under the beat.void hold elapses' },
  'beat.floor': { text: 'the floor reaches the horizon', observed: 'the visibility sweep reveals its last ring' },
  'beat.convoy': { text: 'the focus camera locks to that stele, head-on and orthographic', observed: 'focus.state.mode is locked on a target whose id starts anchor.convoy.' },
  'beat.reach': { text: 'a hard stop and one line: EPERM. man EPERM.', observed: 'the last boot_sector interaction record parses to boot.direct_reach with outcome costly' },
  'beat.terminal': { text: 'the player runs man EPERM', observed: 'shell.onCommand reports man with argv EPERM and an ok result' },
  'beat.trap': { text: 'a successful submission; the Program enters ring 0 for four ticks and leaves', observed: 'reduceRequisition lists a submission with errno null' },
  'beat.batching': { text: 'the player closes the requisition', observed: 'RequisitionPanel.isOpen becomes false' },
  'beat.gate': { text: 'the leg ends and evaluate runs', observed: 'legDone(run, boot_sector) is true, which chooseDisc writes' },
};

const distanceOf = (structure: DriverStructure): number => Math.hypot(structure.root.position.x, structure.root.position.z);

export class BootSectorDriver {
  private index = 0;
  private startedAt: number;
  /** Unheld wall time in this beat, for the hint. */
  private activeMs = 0;
  private lastNow: number;
  private hinted = false;
  private disposed = false;
  private release: (() => void) | null = null;
  private readonly hidden = new Map<string, { readonly scale: [number, number, number]; readonly visible: boolean }>();
  private sweepRadius = 0;
  private sweepLast = 0;
  private readonly sweepTarget: number;
  private litCount = 0;
  private litLast = 0;
  private revealedStack = false;
  private manRead = false;
  private unwatchShell: (() => void) | null = null;
  private hintSpan: HTMLElement | null = null;
  private readonly picker: (event: PointerEvent) => void;
  private pickerInstalled = false;
  private readonly blockOrbit: (event: Event) => void;
  private readonly onBeatListeners = new Set<(beat: OnboardingBeat) => void>();

  constructor(private readonly host: DriverHost) {
    this.startedAt = host.clock();
    this.lastNow = this.startedAt;
    const others = host.structures().filter(structure => !STELE_IDS.includes(structure.id) && structure.id !== ANCHORS.blockStack);
    this.sweepTarget = Math.max(...others.map(distanceOf), 0);
    this.picker = event => this.pick(event);
    this.blockOrbit = event => { if (event.target === host.canvas) event.stopPropagation(); };
    this.enterVoid();
  }

  get beat(): OnboardingBeat {
    const beat = ONBOARDING[this.index];
    if (beat === undefined) throw new Error('The driver has no beat after the gate.');
    return beat;
  }
  get beatId(): string { return this.beat.id; }
  get done(): boolean { return this.index >= ONBOARDING.length; }
  get finished(): boolean { return this.done; }

  onBeat(listener: (beat: OnboardingBeat) => void): () => void {
    this.onBeatListeners.add(listener);
    return () => { this.onBeatListeners.delete(listener); };
  }

  /* ---- the world, per beat ------------------------------------------ */

  private hide(structure: DriverStructure): void {
    if (this.hidden.has(structure.id)) return;
    const root = structure.root;
    this.hidden.set(structure.id, { scale: [root.scale.x, root.scale.y, root.scale.z], visible: root.visible });
    root.visible = false;
    root.scale.set(0, 0, 0); root.updateMatrix();
  }

  private reveal(id: string): void {
    const saved = this.hidden.get(id); if (saved === undefined) return;
    const structure = this.host.structures().find(candidate => candidate.id === id); if (structure === undefined) return;
    structure.root.visible = saved.visible;
    structure.root.scale.set(...saved.scale); structure.root.updateMatrix();
    this.hidden.delete(id);
  }

  private setSceneVisible(name: string, visible: boolean): void {
    const object = this.host.sceneObject(name); if (object !== null) object.visible = visible;
  }

  private pips(): HTMLElement[] { return [...this.host.hud.cell('convoyPips').querySelectorAll<HTMLElement>('.kt-pip')]; }

  private enterVoid(): void {
    // Black void: only the module ring under the convoy; the stele exist unlit; the HUD is hidden; the clock is held.
    for (const structure of this.host.structures()) if (structure.id !== ANCHORS.plate) this.hide(structure);
    this.setSceneVisible('kt.env.ground.grid', false);
    this.setSceneVisible('kt.env.horizon.line', false);
    this.setSceneVisible('kt.labels', false);
    this.host.hud.element.hidden = true;
    for (const pip of this.pips()) pip.hidden = true;
    this.release = this.host.pacing.hold(this.beat.id);
    // Orbit is added in beat two: until then a pointer on the canvas goes nowhere.
    this.host.document.addEventListener('pointerdown', this.blockOrbit, true);
    this.host.document.addEventListener('wheel', this.blockOrbit, true);
  }

  private enterFloor(now: number): void {
    this.release?.(); this.release = null;
    this.host.document.removeEventListener('pointerdown', this.blockOrbit, true);
    this.host.document.removeEventListener('wheel', this.blockOrbit, true);
    this.host.hud.element.hidden = false;
    this.setSceneVisible('kt.env.ground.grid', true);
    this.sweepRadius = 0; this.sweepLast = now;
    this.sweep(now, true);
  }

  /** One ring per RING_STEP_MS to the furthest anchor; the stele and the stack wait for their own beats. */
  private sweep(now: number, first = false): boolean {
    while (this.sweepRadius < this.sweepTarget && (first || now - this.sweepLast >= RING_STEP_MS)) {
      if (first) first = false; else this.sweepLast += RING_STEP_MS;
      this.sweepRadius += MODULE_METRES;
      for (const structure of this.host.structures()) {
        if (STELE_IDS.includes(structure.id) || structure.id === ANCHORS.blockStack) continue;
        if (distanceOf(structure) <= this.sweepRadius) this.reveal(structure.id);
      }
    }
    if (this.sweepRadius < this.sweepTarget) return false;
    this.setSceneVisible('kt.env.horizon.line', true);
    this.setSceneVisible('kt.labels', true);
    return true;
  }

  private enterConvoy(now: number): void {
    this.litCount = 0; this.litLast = now - STELE_LIGHT_MS;
    this.host.canvas.addEventListener('pointerdown', this.picker);
    this.pickerInstalled = true;
    this.light(now);
  }

  /** The five stele in roster order at STELE_LIGHT_MS each; the convoy row whose name matches lights with it. */
  private light(now: number): void {
    while (this.litCount < STELE_IDS.length && now - this.litLast >= STELE_LIGHT_MS) {
      const id = STELE_IDS[this.litCount]; const entry = ROSTER[this.litCount];
      if (id !== undefined) this.reveal(id);
      if (entry !== undefined) for (const pip of this.pips()) if (pip.querySelector('.kt-value')?.textContent === entry.name) pip.hidden = false;
      this.litCount += 1; this.litLast += STELE_LIGHT_MS;
    }
  }

  private pick(event: PointerEvent): void {
    if (event.button !== 0 || this.host.focus.state.mode !== 'free') return;
    const rect = this.host.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new Raycaster(); raycaster.layers.enableAll();
    raycaster.setFromCamera(ndc, this.host.focus.camera);
    const stele = this.host.structures().filter(structure => STELE_IDS.includes(structure.id) && !this.hidden.has(structure.id));
    const hits = raycaster.intersectObjects(stele.map(structure => structure.root), true);
    const hit = hits[0]; if (hit === undefined) return;
    const target = stele.find(structure => { let object: Object3D | null = hit.object; while (object !== null) { if (object === structure.root) return true; object = object.parent; } return false; });
    if (target !== undefined) this.host.focus.engage(target.id);
  }

  private enterReach(): void { this.revealedStack = false; }

  private revealStack(): void {
    this.reveal(ANCHORS.blockStack);
    this.host.interactions.restrict(['boot.direct_reach']);
    this.revealedStack = true;
    this.activeMs = 0;
  }

  private enterTerminal(): void {
    this.host.interactions.restrict(null);
    const span = this.host.document.createElement('span'); span.className = 'kt-row'; span.textContent = TERMINAL_HINT;
    this.host.hud.cell('focusHint').append(span); this.hintSpan = span;
    this.manRead = false;
  }

  private watchShell(): void {
    if (this.unwatchShell !== null) return;
    const terminal = this.host.terminal(); if (terminal === null) return;
    this.unwatchShell = terminal.shell.onCommand((name, argv, result) => { if (name === 'man' && argv[0] === 'EPERM' && result.ok) this.manRead = true; });
  }

  private enterTrap(): void {
    this.hintSpan?.remove(); this.hintSpan = null;
    this.unwatchShell?.(); this.unwatchShell = null;
    this.host.requisition.open();
  }

  private enterBatching(): void { this.host.requisition.showSignage(); }
  private enterGate(): void { this.host.gate.open(); }

  /* ---- the exits ---------------------------------------------------- */

  private exited(now: number): boolean {
    const beat = this.beat;
    const run = this.host.run();
    switch (beat.id) {
      case 'beat.void': return now - this.startedAt >= (beat.durationMs ?? 0);
      case 'beat.floor': return this.sweep(now);
      case 'beat.convoy': { this.light(now); const state = this.host.focus.state; return state.mode === 'locked' && (state.target?.id.startsWith(STELE_PREFIX) ?? false); }
      case 'beat.reach': {
        const mode = this.host.focus.state.mode;
        if (!this.revealedStack) { if (mode === 'releasing' || mode === 'free') this.revealStack(); return false; }
        const last = run.decisions.findLast(record => record.legId === 'boot_sector' && record.kind === 'interaction');
        return last !== undefined && last.outcome === 'costly' && parseInteractionChoice(last.choice)?.id === 'boot.direct_reach';
      }
      case 'beat.terminal': this.watchShell(); return this.manRead;
      case 'beat.trap': return reduceRequisition(run.decisions, run.discClass, run.difficulty).submissions.some(submission => submission.errno === null);
      case 'beat.batching': return !this.host.requisition.isOpen;
      case 'beat.gate': return legDone(run, 'boot_sector');
      default: return false;
    }
  }

  private enter(now: number): void {
    this.startedAt = now; this.activeMs = 0; this.hinted = false;
    for (const listener of this.onBeatListeners) listener(this.beat);
    switch (this.beat.id) {
      case 'beat.floor': this.enterFloor(now); break;
      case 'beat.convoy': this.enterConvoy(now); break;
      case 'beat.reach': this.enterReach(); break;
      case 'beat.terminal': this.enterTerminal(); break;
      case 'beat.trap': this.enterTrap(); break;
      case 'beat.batching': this.enterBatching(); break;
      case 'beat.gate': this.enterGate(); break;
      default: break;
    }
  }

  /** Once per frame with the wall clock. */
  update(now: number): void {
    if (this.disposed || this.done) return;
    const dt = Math.max(0, now - this.lastNow); this.lastNow = now;
    if (this.host.pacing.held().length === 0) this.activeMs += dt;
    while (!this.done && this.exited(now)) {
      this.index += 1;
      if (this.done) { this.finish(); return; }
      this.enter(now);
    }
    const beat = this.beat; const hint = HINTS[beat.id];
    const waiting = beat.id !== 'beat.reach' || this.revealedStack;
    if (!this.hinted && hint !== undefined && beat.hintAfterMs !== null && waiting && this.activeMs >= beat.hintAfterMs) {
      this.hinted = true; this.host.hud.note(hint);
    }
  }

  private finish(): void {
    if (this.pickerInstalled) { this.host.canvas.removeEventListener('pointerdown', this.picker); this.pickerInstalled = false; }
    this.host.interactions.restrict(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release?.(); this.release = null;
    this.host.document.removeEventListener('pointerdown', this.blockOrbit, true);
    this.host.document.removeEventListener('wheel', this.blockOrbit, true);
    this.finish();
    this.unwatchShell?.(); this.unwatchShell = null;
    this.hintSpan?.remove(); this.hintSpan = null;
    for (const id of [...this.hidden.keys()]) this.reveal(id);
    this.setSceneVisible('kt.env.ground.grid', true);
    this.setSceneVisible('kt.env.horizon.line', true);
    this.setSceneVisible('kt.labels', true);
    this.host.hud.element.hidden = false;
    for (const pip of this.pips()) pip.hidden = false;
  }
}
