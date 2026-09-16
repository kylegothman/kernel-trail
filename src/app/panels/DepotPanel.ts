/** Plain depot catalogue stand-in. The structure and later UI pass replace this DOM. */
import type { ConvoyMemberId } from '@kernel/types';
import type { LegRunner } from '@game/LegRunner';
import type { Depot, DepotItemId } from '@game/depot/Depot';
import type { RunState } from '@game/types';
import { DeferredPanel, button, messageOf, paragraph, type PanelOptions, type PanelShell } from './panel';

export interface DepotPanelOptions extends PanelOptions {
  readonly runner: Pick<LegRunner, 'continueTravel'>;
  readonly run: () => Readonly<RunState>;
}

export type DepotPanelModel = Pick<Depot, 'catalogue' | 'buy' | 'recruitNotice' | 'hint'>;

export class DepotPanel extends DeferredPanel {
  private depot: DepotPanelModel | null = null;
  private readonly targets = new Map<DepotItemId, ConvoyMemberId>();
  private message = '';

  constructor(private readonly config: DepotPanelOptions) {
    super(config, 'depot', 'Depot open. Cycles accepted. Nothing here is a favour.');
  }

  open(depot: DepotPanelModel): void { this.depot = depot; this.targets.clear(); this.message = ''; this.show(); }

  protected render(shell: PanelShell): void {
    const depot = this.depot; if (depot === null) return;
    const { document: doc } = this.config;
    shell.body.replaceChildren(); shell.footer.replaceChildren();
    if (this.message !== '') shell.body.append(paragraph(doc, this.message));
    if (depot.hint !== null) shell.body.append(paragraph(doc, depot.hint));
    for (const offer of depot.catalogue()) {
      const row = doc.createElement('div'); row.className = 'kt-panel-row';
      row.append(paragraph(doc, `${offer.item}: ${offer.cycles} cycles, ${offer.blocks} blocks`));
      if (offer.item === 'repair' || offer.item === 'recruit') {
        const item = offer.item;
        const members = this.config.run().convoy.filter(member => item === 'repair' ? member.status !== 'derezzed' : member.status === 'derezzed');
        const select = doc.createElement('select'); select.setAttribute('aria-label', `${item} target`);
        const stored = this.targets.get(item);
        const target = members.find(member => member.id === stored)?.id ?? members[0]?.id;
        if (target !== undefined) this.targets.set(item, target); else this.targets.delete(item);
        for (const member of members) {
          const option = doc.createElement('option'); option.value = member.id;
          option.textContent = `${member.name} (${member.integrity})`; select.append(option);
        }
        if (target !== undefined) select.value = target;
        select.disabled = members.length === 0;
        select.addEventListener('change', () => {
          const member = members.find(candidate => candidate.id === select.value);
          if (member !== undefined) this.targets.set(item, member.id);
          this.invalidate();
        });
        row.append(select);
        if (item === 'recruit' && target !== undefined) {
          const notice = depot.recruitNotice(target); if (notice !== null) row.append(paragraph(doc, notice));
        }
      }
      if (offer.available) {
        row.append(button(doc, `Buy ${offer.item}`, () => {
          try {
            const result = depot.buy(offer.item, this.targets.get(offer.item) ?? null);
            this.message = result.ok ? `Purchased ${offer.item}.` : result.reason ?? 'Purchase refused.';
          } catch (error) { this.message = messageOf(error); }
          this.invalidate();
        }));
      } else row.append(paragraph(doc, offer.unavailableReason ?? 'Unavailable.'));
      shell.body.append(row);
    }
    shell.footer.append(button(doc, 'Leave', () => {
      try { this.config.runner.continueTravel(); this.close(); }
      catch (error) { this.message = messageOf(error); this.invalidate(); }
    }));
  }
}
