/**
 * The HUD: the game's only always-on screen-space layer. Visual bible 11,
 * architecture 4.5 and 7.5.
 *
 * It carries status and never simulation data: six regions fed by selector
 * subscriptions on the run store and the telemetry store, an alert stack fed
 * by the kernel event stream through the shared per-frame queue, and nothing
 * else. Every DOM write goes through `DomBatch` and lands when the host calls
 * `flush()` once per frame. The HUD never reads layout.
 *
 * Everything it needs arrives by constructor injection with type-only imports
 * from the other layers: the stores, the focus state, the sounds, the clock.
 * No `three`, no `document` global, no timers: `frame(now)` is the clock.
 */
import type { KernelEvent, Pid } from '@kernel/types';
import type { RunState } from '@game/types';
import type { Store } from '@game/store';
import type { HudTelemetry } from '@game/runStore';
import type { EventConsumer } from '@world/FrameEventQueue';
import type { FocusCameraState, FocusMode } from '@render';
import { DomBatch } from '../DomBatch';
import { SILENT_SOUNDS, type UiSounds } from '../sounds';
import { HUD_CSS } from './hud.css';
import { HUD_ACTIVE, HUD_ACTIVE_HOLD_MS, HUD_FOCUSED, HUD_REST, type HudRegionId } from './layout';
import { el, setText } from './dom';
import { createLegRail, legRailEq, legRailProps, type LegRailProps } from './regions/LegRail';
import { createPolicyChips, policyChipsEq, policyChipsProps, type PolicyChipsProps } from './regions/PolicyChips';
import { createMeters, metersEq, metersProps, type MetersProps } from './regions/Meters';
import { createConvoyPips, convoyPipsEq, convoyPipsProps, type ConvoyPipsProps } from './regions/ConvoyPips';
import {
  createResourceLedgerView,
  resourceLedgerEq,
  resourceLedgerProps,
  type ResourceLedgerProps,
} from './regions/ResourceLedgerView';
import { AlertModel, composeAlert, createAlertStack, deriveAlert, type HudAlert } from './regions/AlertStack';
import { createFocusHint, type FocusHintProps } from './regions/FocusHint';

export interface HudOptions {
  /** The HUD appends its container to this element and removes it on dispose. */
  readonly root: HTMLElement;
  readonly runStore: Store<RunState>;
  readonly telemetry: Store<HudTelemetry>;
  /** Milliseconds, monotonic. The host passes performance.now or a fake. */
  readonly clock: () => number;
  /** The camera's current state, read once per frame. */
  readonly focusState: () => FocusCameraState;
  readonly sounds?: UiSounds;
  readonly batch?: DomBatch;
  readonly engageKey?: string;
  /** Whether to inject the stylesheet. The GPU page and the app want it; some tests do not. */
  readonly injectStyle?: boolean;
}

export type HudVisibility = 'visible' | 'hidden';

const CELL_OF: Readonly<Record<HudRegionId, string>> = {
  legRail: 'kt-tl',
  policyChips: 'kt-tr',
  convoyPips: 'kt-bl',
  resourceLedger: 'kt-br',
  alertStack: 'kt-alerts',
  focusHint: 'kt-hint',
};

export class Hud implements EventConsumer {
  readonly name = 'hud';
  readonly element: HTMLElement;
  readonly batch: DomBatch;
  readonly derezz: { begin(): void; tombstone(): void };

  private readonly doc: Document;
  private readonly runStore: Store<RunState>;
  private readonly telemetry: Store<HudTelemetry>;
  private readonly clock: () => number;
  private readonly focusState: () => FocusCameraState;
  private readonly sounds: UiSounds;
  private readonly engageKey: string;
  private readonly style: HTMLStyleElement | null;
  private readonly cells: Record<HudRegionId, HTMLElement>;
  private readonly activeUntil = new Map<HudRegionId, number>();
  private readonly alertModel = new AlertModel();
  private readonly unsubscribes: (() => void)[] = [];
  private readonly alertStack;
  private readonly focusHint;
  private readonly paceRow: HTMLElement;
  private paceLabel = '';
  private hover: string | null = null;
  private focusMode: FocusMode = 'free';
  private visibility: HudVisibility = 'visible';
  private unlocked = false;
  private disposed = false;

  constructor(options: HudOptions) {
    this.doc = options.root.ownerDocument;
    this.runStore = options.runStore;
    this.telemetry = options.telemetry;
    this.clock = options.clock;
    this.focusState = options.focusState;
    this.sounds = options.sounds ?? SILENT_SOUNDS;
    this.engageKey = options.engageKey ?? 'F';
    this.batch = options.batch ?? new DomBatch();
    const doc = this.doc;

    this.element = el(doc, 'div', 'kt-hud');
    this.element.style.pointerEvents = 'none';
    if (options.injectStyle !== false) {
      this.style = doc.createElement('style');
      this.style.textContent = HUD_CSS;
      this.element.append(this.style);
    } else {
      this.style = null;
    }

    const legRail = createLegRail(doc);
    const topRight = el(doc, 'div', 'kt-cell kt-tr');
    const policyChips = createPolicyChips(doc);
    const meters = createMeters(doc);
    // WP-24 section 1: the pace indicator, one row under the tick counter in the
    // top-right cell (pre-flight ruling 7a). The centre column stays empty per
    // visual bible 11.3; the cell's bound in layout.ts carries the extra row.
    this.paceRow = el(doc, 'div', 'kt-row kt-pace');
    this.paceRow.setAttribute('aria-label', 'Pace');
    topRight.append(policyChips.el, this.paceRow, meters.el);
    const convoyPips = createConvoyPips(doc);
    const ledger = createResourceLedgerView(doc);
    const alertStack = createAlertStack(doc);
    const focusHint = createFocusHint(doc);
    this.alertStack = alertStack;
    this.focusHint = focusHint;
    this.cells = {
      legRail: legRail.el,
      policyChips: topRight,
      convoyPips: convoyPips.el,
      resourceLedger: ledger.el,
      alertStack: alertStack.el,
      focusHint: focusHint.el,
    };
    for (const cell of Object.values(this.cells)) {
      cell.style.pointerEvents = 'auto';
      this.element.append(cell);
    }
    options.root.append(this.element);

    const write = <P>(region: HudRegionId, apply: (p: P) => boolean) => (p: P): void => {
      this.batch.write(() => {
        if (apply(p)) this.flash(region);
      });
    };

    // Initial paint, then the selector subscriptions. Each selector returns a
    // small props record with its own equality, so a flush that changes
    // nothing a region shows fires nothing.
    const run = this.runStore.get();
    const tel = this.telemetry.get();
    legRail.update(legRailProps(tel.leg, run.legProgress));
    policyChips.update(policyChipsProps(tel, run.policy));
    policyChips.setTick(tel.tick);
    meters.update(metersProps(tel));
    convoyPips.update(convoyPipsProps(run.convoy));
    ledger.update(resourceLedgerProps(run.resources));
    alertStack.update({ alerts: this.alertModel.alerts });
    focusHint.update(this.hintProps());

    this.unsubscribes.push(
      this.runStore.watch<LegRailProps>((s) => legRailProps(this.telemetry.get().leg, s.legProgress), write('legRail', (p) => legRail.update(p)), legRailEq),
      this.telemetry.watch<LegRailProps>((t) => legRailProps(t.leg, this.runStore.get().legProgress), write('legRail', (p) => legRail.update(p)), legRailEq),
      this.runStore.watch<PolicyChipsProps>((s) => policyChipsProps(this.telemetry.get(), s.policy), write('policyChips', (p) => policyChips.update(p)), policyChipsEq),
      this.telemetry.watch<PolicyChipsProps>((t) => policyChipsProps(t, this.runStore.get().policy), write('policyChips', (p) => policyChips.update(p)), policyChipsEq),
      this.telemetry.watch<number>((t) => t.tick, (tick) => this.batch.write(() => policyChips.setTick(tick))),
      this.telemetry.watch<MetersProps>(metersProps, write('policyChips', (p) => meters.update(p)), metersEq),
      this.runStore.watch<ConvoyPipsProps>((s) => convoyPipsProps(s.convoy), write('convoyPips', (p) => convoyPips.update(p)), convoyPipsEq),
      this.runStore.watch<ResourceLedgerProps>((s) => resourceLedgerProps(s.resources), write('resourceLedger', (p) => ledger.update(p)), resourceLedgerEq),
    );

    this.derezz = {
      begin: () => this.setVisibility('hidden'),
      tombstone: () => this.setVisibility('visible'),
    };

    const unlock = (): void => {
      if (this.unlocked) return;
      this.unlocked = true;
      this.sounds.unlock();
    };
    this.element.addEventListener('pointerdown', unlock);
    this.element.addEventListener('keydown', unlock);
    this.unsubscribes.push(() => {
      this.element.removeEventListener('pointerdown', unlock);
      this.element.removeEventListener('keydown', unlock);
    });
  }

  /* ---- EventConsumer ------------------------------------------------ */

  consume(event: KernelEvent): void {
    const derived = deriveAlert(event, (pid) => this.programName(pid));
    if (derived === null) return;
    const alert = composeAlert(derived, this.clock());
    if (this.alertModel.push(alert)) this.sounds.alertAppear();
    this.queueAlerts();
  }

  /* ---- per frame ---------------------------------------------------- */

  /** Called by the host once per rendered frame with the wall clock. */
  frame(nowMs: number): void {
    if (this.disposed) return;
    for (const [region, until] of this.activeUntil) {
      if (nowMs >= until) {
        this.activeUntil.delete(region);
        const cell = this.cells[region];
        this.batch.write(() => cell.removeAttribute('data-hud-state'));
      }
    }
    if (this.alertModel.expire(nowMs)) this.queueAlerts();
    const mode = this.focusState().mode;
    if (mode !== this.focusMode) {
      if (mode === 'engaging') this.sounds.focusEngage();
      if (mode === 'releasing') this.sounds.focusRelease();
      this.focusMode = mode;
      this.batch.write(() => {
        if (mode === 'locked') this.element.setAttribute('data-focus', 'locked');
        else this.element.removeAttribute('data-focus');
      });
    }
  }

  /** Apply every queued DOM write. The host calls this once per frame, after rendering. */
  flush(): void {
    this.batch.flush();
  }

  /* ---- host inputs -------------------------------------------------- */

  /** WP-24 section 1: the pace indicator's text, `2x` or `paused (crossing)`. A changed label flashes the cell. */
  setPace(label: string): void {
    if (label === this.paceLabel) return;
    this.paceLabel = label;
    this.batch.write(() => {
      if (setText(this.paceRow, label)) this.flash('policyChips');
    });
  }

  /** The pace indicator's element, for the host and the tests. */
  get pace(): HTMLElement {
    return this.paceRow;
  }

  /** The anchor under the cursor, or null. Drives the focus hint. */
  setHover(anchorId: string | null): void {
    if (anchorId === this.hover) return;
    this.hover = anchorId;
    const props = this.hintProps();
    this.batch.write(() => {
      if (this.focusHint.update(props)) this.flash('focusHint');
    });
  }

  /* ---- queries, for the host and the tests -------------------------- */

  get alerts(): readonly HudAlert[] {
    return this.alertModel.alerts;
  }

  get hidden(): boolean {
    return this.visibility === 'hidden';
  }

  get focus(): FocusMode {
    return this.focusMode;
  }

  cell(region: HudRegionId): HTMLElement {
    return this.cells[region];
  }

  /** Whether the region is inside its 1.2 s full-opacity hold. */
  isActive(region: HudRegionId): boolean {
    return this.activeUntil.has(region);
  }

  /**
   * The opacity the stylesheet resolves for a region from the HUD's state:
   * hidden is 0, a focus lock is HUD_FOCUSED for everything but the alert
   * stack, a changed value holds HUD_ACTIVE, otherwise HUD_REST. Kept in one
   * place so the Node suite can assert the rules the CSS encodes without a
   * layout engine.
   */
  opacityOf(region: HudRegionId): number {
    if (this.visibility === 'hidden') return 0;
    if (this.focusMode === 'locked') return region === 'alertStack' ? HUD_ACTIVE : HUD_FOCUSED;
    if (this.activeUntil.has(region)) return HUD_ACTIVE;
    return HUD_REST;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubscribes) u();
    this.unsubscribes.length = 0;
    this.element.remove();
  }

  /* ---- internals ---------------------------------------------------- */

  private flash(region: HudRegionId): void {
    this.activeUntil.set(region, this.clock() + HUD_ACTIVE_HOLD_MS);
    this.cells[region].setAttribute('data-hud-state', 'active');
  }

  private queueAlerts(): void {
    const alerts = [...this.alertModel.alerts];
    this.batch.write(() => {
      if (this.alertStack.update({ alerts })) this.flash('alertStack');
    });
  }

  private hintProps(): FocusHintProps {
    return { anchorId: this.hover, engageKey: this.engageKey };
  }

  private programName(pid: Pid): string | null {
    for (const m of this.runStore.get().convoy) if (m.pid === pid) return m.name;
    return null;
  }

  private setVisibility(v: HudVisibility): void {
    if (v === this.visibility) return;
    this.visibility = v;
    this.batch.write(() => {
      this.element.hidden = v === 'hidden';
    });
  }
}

export function createHud(options: HudOptions): Hud {
  return new Hud(options);
}

export { CELL_OF as HUD_CELL_CLASS };
