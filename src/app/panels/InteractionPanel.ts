/** Plain anchor controls. Structures will replace this grouped DOM with world affordances. */
import type { CommandBus } from '@game/CommandBus';
import type { LegRunner } from '@game/LegRunner';
import type { CrossingDef } from '@game/crossing/Crossing';
import type { CrossingContext } from '@game/crossing/options';
import type { Depot } from '@game/depot/Depot';
import type { VergeLayout } from '@game/reclamation/verge';
import { DEPOT_LEGS } from '@game/travel/segments';
import type { InteractionDef, Leg, RunState } from '@game/types';
import type { LegContent } from '@legs/content';
import { DeferredPanel, button, messageOf, paragraph, resourcesText, type PanelOptions, type PanelShell } from './panel';

export interface InteractionPanelOptions extends PanelOptions {
  readonly runner: Pick<LegRunner, 'phase' | 'openCrossing' | 'openDepot' | 'openReclamation'>;
  readonly bus: Pick<CommandBus, 'dispatch'>;
  readonly run: () => Readonly<RunState>;
  readonly crossing: (def: CrossingDef, context: CrossingContext) => void;
  readonly depot: (depot: Depot) => void;
  readonly reclamation: (layout: VergeLayout) => void;
}

export class InteractionPanel extends DeferredPanel {
  private leg: Leg | null = null;
  private content: LegContent | null = null;
  private message = '';
  private readonly controls: { readonly button: HTMLButtonElement; readonly enabled: () => boolean }[] = [];

  constructor(private readonly config: InteractionPanelOptions) { super(config, 'interactions', 'Anchors'); }

  open(leg: Leg, content: LegContent): void { this.leg = leg; this.content = content; this.message = ''; this.show(); }

  private act(action: () => void): void {
    try { action(); this.message = ''; } catch (error) { this.message = messageOf(error); }
    this.invalidate();
  }

  private available(def: InteractionDef): boolean {
    try { return def.enabledWhen(this.config.run()); } catch { return false; }
  }

  private travelling(): boolean { return this.config.runner.phase === 'travelling'; }

  protected render(shell: PanelShell): void {
    const leg = this.leg; const content = this.content; if (leg === null || content === null) return;
    const { document: doc } = this.config;
    this.controls.length = 0; shell.body.replaceChildren(); shell.footer.replaceChildren();
    if (this.message !== '') shell.body.append(paragraph(doc, this.message, 'kt-panel-error'));
    const groups = new Map<string, readonly InteractionDef[]>();
    for (const def of leg.interactions) groups.set(def.anchor, [...(groups.get(def.anchor) ?? []), def]);
    for (const [anchor, defs] of groups) {
      const section = doc.createElement('section'); section.setAttribute('data-anchor', anchor);
      const heading = doc.createElement('h3'); heading.textContent = anchor; section.append(heading);
      for (const def of defs) {
        const row = doc.createElement('div'); row.className = 'kt-panel-row';
        const action = button(doc, def.label, () => this.act(() => {
          if (!this.config.bus.dispatch({ kind: 'interaction', id: def.id, anchor: def.anchor }, { source: 'world', legId: leg.id })) {
            throw new Error('Command queue full. Try again after the next tick.');
          }
        }));
        row.append(action, paragraph(doc, def.description), paragraph(doc, `Cost: ${resourcesText(def.cost)}`));
        this.controls.push({ button: action, enabled: () => this.travelling() && this.available(def) });
        section.append(row);
      }
      shell.body.append(section);
    }
    const crossings = doc.createElement('section'); const crossingsHeading = doc.createElement('h3');
    crossingsHeading.textContent = 'Crossings'; crossings.append(crossingsHeading);
    for (const def of content.crossings) {
      const row = doc.createElement('div'); row.className = 'kt-panel-row';
      row.append(paragraph(doc, `${def.id} (${def.anchor})`));
      const approach = button(doc, 'Approach', () => this.act(() => this.config.crossing(def, this.config.runner.openCrossing(def))));
      approach.setAttribute('aria-label', `Approach ${def.id}`);
      this.controls.push({ button: approach, enabled: () => this.travelling() }); row.append(approach); crossings.append(row);
    }
    if (content.crossings.length === 0) crossings.append(paragraph(doc, 'No crossings.'));
    shell.body.append(crossings);
    const depotHeading = doc.createElement('h3'); depotHeading.textContent = 'Depot';
    const depot = button(doc, 'Open depot', () => this.act(() => this.config.depot(this.config.runner.openDepot())));
    this.controls.push({ button: depot, enabled: () => DEPOT_LEGS.includes(leg.id) && this.travelling() });
    const reclamationHeading = doc.createElement('h3'); reclamationHeading.textContent = 'Reclamation';
    const reclamation = button(doc, 'Open reclamation', () => this.act(() => this.config.reclamation(this.config.runner.openReclamation())));
    this.controls.push({ button: reclamation, enabled: () => this.travelling() });
    shell.body.append(depotHeading, depot, reclamationHeading, reclamation);
  }

  override flush(): void {
    super.flush();
    if (!this.isOpen) return;
    for (const control of this.controls) {
      const disabled = !control.enabled(); if (control.button.disabled !== disabled) control.button.disabled = disabled;
    }
  }
}
