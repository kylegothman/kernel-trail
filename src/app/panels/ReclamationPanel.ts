/** Empty-trace stand-in. The real-time reclamation round replaces this panel. */
import type { LegRunner } from '@game/LegRunner';
import type { ReclamationResult } from '@game/reclamation/Reclamation';
import type { VergeLayout } from '@game/reclamation/verge';
import { DeferredPanel, button, messageOf, paragraph, type PanelOptions, type PanelShell } from './panel';

export interface ReclamationPanelOptions extends PanelOptions {
  readonly runner: Pick<LegRunner, 'submitReclamation' | 'continueTravel'>;
}

export class ReclamationPanel extends DeferredPanel {
  private layout: VergeLayout | null = null;
  private result: ReclamationResult | null = null;
  private error = '';

  constructor(private readonly config: ReclamationPanelOptions) { super(config, 'reclamation', 'Reclamation'); }

  open(layout: VergeLayout): void { this.layout = layout; this.result = null; this.error = ''; this.show(); }

  private submit(): void {
    if (this.result !== null) return;
    try {
      this.result = this.config.runner.submitReclamation([]);
      this.config.runner.continueTravel();
      this.error = '';
    } catch (error) { this.error = messageOf(error); }
    this.invalidate();
  }

  protected render(shell: PanelShell): void {
    const layout = this.layout; if (layout === null) return;
    const { document: doc } = this.config;
    shell.body.replaceChildren(); shell.footer.replaceChildren();
    shell.body.append(paragraph(doc, `F = ${layout.f.toFixed(2)}; fragments: ${layout.fragments.length}; leaked: ${layout.leaked.length}; seconds: ${layout.seconds}`));
    shell.body.append(paragraph(doc, 'This stand-in submits an empty trace. The real-time round will replace it.'));
    if (this.error !== '') shell.body.append(paragraph(doc, this.error, 'kt-panel-error'));
    if (this.result === null) {
      shell.footer.append(button(doc, 'Sweep', () => this.submit()), button(doc, 'Skip', () => this.submit()));
    } else {
      const gain = this.result.yield;
      shell.body.append(paragraph(doc, `Yield: ${gain.quota} quota, ${gain.blocks} blocks, ${gain.cycles} cycles.`));
      shell.footer.append(button(doc, 'Close', () => this.close()));
    }
  }
}
