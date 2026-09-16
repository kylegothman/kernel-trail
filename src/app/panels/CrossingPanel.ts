/** Plain crossing choice stand-in. Structure art and a later UI pass replace this DOM. */
import type { LegRunner } from '@game/LegRunner';
import type { CrossingDef, CrossingResult } from '@game/crossing/Crossing';
import { quote, type CrossingContext, type CrossingOption } from '@game/crossing/options';
import { DeferredPanel, button, messageOf, paragraph, resourcesText, type PanelOptions, type PanelShell } from './panel';

export interface CrossingPanelOptions extends PanelOptions {
  readonly runner: Pick<LegRunner, 'resolveCrossing' | 'continueTravel'>;
}

const OPTIONS: readonly CrossingOption[] = ['spin', 'block', 'monitor', 'wait'];

export class CrossingPanel extends DeferredPanel {
  private crossing: { readonly def: CrossingDef; readonly context: CrossingContext } | null = null;
  private result: CrossingResult | null = null;
  private error = '';

  constructor(private readonly config: CrossingPanelOptions) { super(config, 'crossing', 'Crossing'); }

  open(def: CrossingDef, context: CrossingContext): void {
    const current = this.crossing;
    if (this.isOpen && current !== null && current.def.id === def.id && current.def.legId === def.legId) return;
    this.crossing = { def, context }; this.result = null; this.error = ''; this.show();
  }

  protected render(shell: PanelShell): void {
    const crossing = this.crossing; if (crossing === null) return;
    const { document: doc } = this.config;
    shell.body.replaceChildren(); shell.footer.replaceChildren();
    shell.body.append(paragraph(doc, `Lock ${crossing.def.lockId}; ${crossing.def.kind}; ordered: ${crossing.context.ordered ? 'yes' : 'no'}`));
    shell.body.append(paragraph(doc, `C = ${crossing.context.contention.toFixed(2)}`));
    if (this.error !== '') shell.body.append(paragraph(doc, this.error, 'kt-panel-error'));
    const result = this.result;
    if (result !== null) {
      shell.body.append(paragraph(doc, `Succeeded: ${result.succeeded ? 'yes' : 'no'}; attempts: ${result.attempts}`));
      shell.body.append(paragraph(doc, `Afflicted: ${result.afflicted.map(a => `${a.member}: ${a.id}`).join(', ') || 'none'}`));
      shell.body.append(paragraph(doc, `Casualties: ${result.casualties.join(', ') || 'none'}`));
      shell.body.append(paragraph(doc, `Spent: ${resourcesText(result.spent)}`));
      if (result.refused !== null) shell.body.append(paragraph(doc, `Refused: ${result.refused}`, 'kt-panel-error'));
    }
    if (result === null || result.refused !== null) {
      const table = doc.createElement('table');
      const head = doc.createElement('thead'); const header = doc.createElement('tr');
      for (const label of ['Option', 'Cycles', 'Ticks', 'Quota', 'Bandwidth', 'Blocks', 'Success', 'Event draws', '']) {
        const th = doc.createElement('th'); th.scope = 'col'; th.textContent = label; header.append(th);
      }
      head.append(header); table.append(head);
      const body = doc.createElement('tbody');
      for (const option of OPTIONS) {
        const cost = quote(option, crossing.context); const row = doc.createElement('tr');
        for (const value of [option, cost.cyclesCost, cost.ticksCost, cost.quotaCost, cost.bandwidthCost, cost.blocksCost, `${(cost.successP * 100).toFixed(2)}%`, cost.eventDraws]) {
          const cell = doc.createElement('td'); cell.textContent = String(value); row.append(cell);
        }
        const action = doc.createElement('td');
        action.append(button(doc, `Choose ${option}`, () => {
          try { this.result = this.config.runner.resolveCrossing(crossing.def, option); this.error = ''; }
          catch (error) { this.error = messageOf(error); }
          this.invalidate();
        }));
        row.append(action); body.append(row);
      }
      table.append(body); shell.body.append(table);
    } else {
      shell.footer.append(button(doc, 'Continue', () => {
        try { this.config.runner.continueTravel(); this.close(); }
        catch (error) { this.error = messageOf(error); this.invalidate(); }
      }));
    }
  }
}
