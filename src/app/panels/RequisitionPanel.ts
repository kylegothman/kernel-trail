/**
 * WP-24 section 3: the six requisition windows as the player's UI.
 *
 * The verbs take their arguments in the anchor string and this panel supplies
 * them, dispatching through the bus exactly what the harness script
 * dispatches (tests/legs/boot_sector/scripts.ts is the reference for every
 * string): `boot.set_mode` with `anchor.win.<id>:<mode>`, `boot.batch_request`
 * with `anchor.win.<id>:<amount>` (bare for a service with no goods), and
 * `boot.trap_purchase` with `anchor.win.<id>`. After each tick the panel
 * re-reads `reduceRequisition` and re-renders from it, so what the player
 * sees is the leg's own view of the requisition and never the panel's
 * memory. An errno comes back as a refusal line with the man page beside it.
 *
 * The panel holds the clock while it is open, and a held clock drains no
 * queue, so the verbs are applied through the bus synchronously at the
 * current tick, the road the terminal's sink takes; the record lands in the
 * same order a queued command would at that tick boundary, and the refusal
 * is read from the outcome apply returns.
 */
import type { Tick } from '@kernel/types';
import type { CommandBus } from '@game/CommandBus';
import type { RunState } from '@game/types';
import { DEPOT_AMBIENT, TRAP_SIGNAGE } from '@legs/boot_sector/copy';
import { TRAP_COST, WINDOWS, reduceRequisition, unitPrice, windowAnchor, type RequisitionState, type WindowDef, type WindowId, type WindowMode } from '@legs/boot_sector/windows';
import { DeferredPanel, button, messageOf, paragraph, type PanelOptions, type PanelShell } from './panel';
import { RefusalLines, refusalElement, refusalFor } from './RefusalLine';

export interface RequisitionPanelOptions extends PanelOptions {
  readonly bus: Pick<CommandBus, 'apply'>;
  readonly run: () => Readonly<RunState>;
  /** The kernel tick a verb is applied at. */
  readonly tick: () => Tick;
  readonly clock?: () => number;
  /** Beat 7 exits when the player closes the requisition through the panel's own Close. */
  readonly onClose?: () => void;
}

const LEG_ID = 'boot_sector';

export class RequisitionPanel extends DeferredPanel {
  private message = '';
  private signage = false;
  /** The amount typed per window, kept across re-renders; the window's default until typed. */
  private readonly amounts = new Map<WindowId, number>();
  private submitAt: WindowId | null = null;
  private seenDecisions = -1;
  private readonly refusals = new RefusalLines();

  constructor(private readonly config: RequisitionPanelOptions) { super(config, 'requisition', 'Requisition'); }

  open(): void { this.message = ''; this.show(); }

  /** Beat 7: the depot signage states the trap price once, in the heading. */
  showSignage(): void { this.signage = true; this.invalidate(); }

  /** The leg's own view of the requisition, re-derived from the decision log. */
  state(): RequisitionState {
    const run = this.config.run();
    return reduceRequisition(run.decisions, run.discClass, run.difficulty);
  }

  private now(): number { return this.config.clock?.() ?? performance.now(); }

  private dispatch(id: string, anchor: string): void {
    try {
      const outcome = this.config.bus.apply({ kind: 'interaction', id, anchor }, { source: 'world', legId: LEG_ID }, this.config.tick());
      const refusal = refusalFor(outcome, this.config.run());
      if (refusal !== null && refusal.id === 'boot.trap_purchase') this.refusals.show(refusal, this.now());
      this.message = '';
    } catch (error) { this.message = messageOf(error); }
    this.invalidate();
  }

  private amountOf(def: WindowDef): number { return this.amounts.get(def.id) ?? def.defaultAmount; }

  private renderWindow(doc: Document, def: WindowDef, state: RequisitionState, run: Readonly<RunState>): HTMLElement {
    const row = doc.createElement('div'); row.className = 'kt-panel-row'; row.setAttribute('data-window', def.id);
    const title = doc.createElement('h3'); title.textContent = def.service; row.append(title);
    const price = unitPrice(def, run.difficulty);
    row.append(paragraph(doc, def.lot === null ? 'No goods; the service is the request.' : `${price} cycles per ${def.resource}, lots of ${def.lot.units}.`));
    const mode = state.modes[def.id];
    const other: WindowMode = mode === 'kernel' ? 'user' : 'kernel';
    const toggle = button(doc, `Mode: ${mode}`, () => this.dispatch('boot.set_mode', `${windowAnchor(def.id)}:${other}`));
    toggle.setAttribute('aria-label', `${def.service} mode`);
    row.append(toggle);
    const hasField = def.resource !== null || def.id === 'priority';
    if (hasField) {
      const field = doc.createElement('input'); field.type = 'number'; field.step = '1';
      field.setAttribute('aria-label', `${def.service} amount`);
      // Bounded by the window's definition: a stocked window releases at most what the ledger holds; a priority window lowers only.
      field.min = def.resource !== null ? String(-run.resources[def.resource]) : '0';
      field.value = String(this.amountOf(def));
      field.addEventListener('change', () => { const value = Number(field.value); if (Number.isSafeInteger(value)) this.amounts.set(def.id, value); });
      row.append(field);
    }
    const add = button(doc, 'Add', () => this.dispatch('boot.batch_request', hasField ? `${windowAnchor(def.id)}:${this.amountOf(def)}` : windowAnchor(def.id)));
    add.setAttribute('aria-label', `Add ${def.service}`);
    row.append(add);
    return row;
  }

  protected render(shell: PanelShell): void {
    const { document: doc } = this.config;
    const run = this.config.run();
    const state = this.state();
    shell.heading.textContent = this.signage ? TRAP_SIGNAGE : 'Requisition';
    shell.body.replaceChildren(); shell.footer.replaceChildren();
    shell.body.append(paragraph(doc, DEPOT_AMBIENT));
    if (this.message !== '') shell.body.append(paragraph(doc, this.message, 'kt-panel-error'));
    for (const def of WINDOWS) shell.body.append(this.renderWindow(doc, def, state, run));
    const pending = doc.createElement('section'); pending.setAttribute('aria-label', 'Pending submission');
    const pendingHeading = doc.createElement('h3'); pendingHeading.textContent = 'Pending'; pending.append(pendingHeading);
    const list = doc.createElement('ul');
    for (const item of state.pending) { const li = doc.createElement('li'); li.textContent = `${item.window}: ${item.amount}`; list.append(li); }
    if (state.pending.length === 0) list.append(paragraph(doc, 'Nothing pending; a submission here carries the window\'s default amount.'));
    pending.append(list);
    shell.body.append(pending);
    const done = doc.createElement('section'); done.setAttribute('aria-label', 'Submissions');
    const doneHeading = doc.createElement('h3'); doneHeading.textContent = 'Submissions'; done.append(doneHeading);
    for (const submission of state.submissions) {
      const items = submission.items.map(item => `${item.window}: ${item.amount}`).join(', ') || 'nothing';
      done.append(paragraph(doc, `${submission.mode} at ${submission.window ?? 'no window'}; ${items}; ${submission.errno ?? 'ok'}`));
    }
    shell.body.append(done);
    // The trap is raised at one window: the first pending item's, or the chosen one for a bare submission. The chooser, Submit and
    // its refusal line live in the footer, pinned at the panel's bottom while the windows scroll above them (the M3 playtest found
    // Submit below the visible edge at 1000 px tall).
    const first = state.pending[0]?.window ?? null;
    const at = doc.createElement('select'); at.setAttribute('aria-label', 'Submit at window');
    for (const def of WINDOWS) { const option = doc.createElement('option'); option.value = def.id; option.textContent = def.service; at.append(option); }
    const chosen = first ?? this.submitAt ?? WINDOWS[0]?.id ?? 'quota';
    at.value = chosen; at.disabled = first !== null;
    at.addEventListener('change', () => { this.submitAt = at.value as WindowId; });
    const submit = button(doc, `Submit (trap: ${TRAP_COST} cycles)`, () => this.dispatch('boot.trap_purchase', windowAnchor(at.value as WindowId)));
    submit.setAttribute('aria-label', 'Submit');
    submit.disabled = run.resources.cycles < TRAP_COST;
    shell.footer.append(at, submit, button(doc, 'Close', () => { this.close(); this.config.onClose?.(); }));
    const refusal = this.refusals.text('boot.trap_purchase');
    if (refusal !== null) shell.footer.append(refusalElement(doc, refusal));
    this.seenDecisions = run.decisions.length;
  }

  override flush(): void {
    if (this.isOpen) {
      // After each tick, the leg's view again: a new record or an expired line re-renders.
      if (this.config.run().decisions.length !== this.seenDecisions) this.invalidate();
      if (this.refusals.size > 0 && this.refusals.expire(this.now())) this.invalidate();
    }
    super.flush();
  }

}
