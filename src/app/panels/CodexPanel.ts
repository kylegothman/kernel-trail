/** The codex's first DOM view. A later UI pass replaces this plain reading surface. */
import type { AfflictionRemedy } from '@game/types';
import type { Codex } from '@ui/codex/Codex';
import type { CodexRegistry } from '@ui/codex/entries';
import { search } from '@ui/codex/search';
import { citation } from '@ui/cards/card';
import { DeferredPanel, button, paragraph, type PanelOptions, type PanelShell } from './panel';

export interface CodexPanelOptions extends PanelOptions {
  readonly codex: Pick<Codex, 'list' | 'open' | 'buildIndex' | 'onUnlock'>;
  readonly registry: Pick<CodexRegistry, 'ids'>;
}

function remedyText(remedy: AfflictionRemedy): string {
  switch (remedy.kind) {
    case 'set_scheduler': return `Scheduler: ${remedy.to}`;
    case 'set_replacement': return `Page replacement: ${remedy.to}`;
    case 'set_disk_policy': return `Disk policy: ${remedy.to}`;
    case 'set_allocation': return `Allocation: ${remedy.to}`;
    case 'adjust_quantum': return `${remedy.direction} the quantum.`;
    case 'reduce_degree': return `Reduce the degree by ${remedy.by}.`;
    case 'spend': return `Spend ${remedy.amount} ${remedy.resource}.`;
    case 'terminal': return remedy.command;
    case 'ability': return `Use ${remedy.member}'s ability.`;
  }
}

export class CodexPanel extends DeferredPanel {
  private selected: string | null = null;
  private query = '';
  private searchInput: HTMLInputElement | null = null;
  private listElement: HTMLElement | null = null;
  private reading: HTMLElement | null = null;
  private registrySize = -1;
  private readonly unsubscribe: () => void;
  private readonly onKey: (event: KeyboardEvent) => void;

  constructor(private readonly config: CodexPanelOptions) {
    super(config, 'codex', 'Codex');
    this.unsubscribe = config.codex.onUnlock(() => this.invalidate());
    this.onKey = event => {
      if (event.defaultPrevented || event.key !== 'Escape' || !this.isOpen) return;
      event.preventDefault(); this.close();
    };
    config.document.addEventListener('keydown', this.onKey);
  }

  open(id?: string): void { if (id !== undefined) this.selected = id; this.show(); }
  toggle(): void { if (this.isOpen) this.close(); else this.open(); }

  override flush(): void {
    const size = this.config.registry.ids().length;
    if (size !== this.registrySize) { this.registrySize = size; this.invalidate(); }
    super.flush();
  }

  protected render(shell: PanelShell): void {
    const { document: doc, codex, registry } = this.config;
    if (this.searchInput?.parentElement !== shell.body) {
      this.searchInput = doc.createElement('input'); this.searchInput.type = 'search';
      this.searchInput.className = 'kt-panel-search'; this.searchInput.setAttribute('aria-label', 'Search codex');
      this.searchInput.value = this.query;
      const input = this.searchInput;
      input.addEventListener('input', () => { this.query = input.value; this.invalidate(); });
      this.listElement = doc.createElement('div'); this.listElement.className = 'kt-panel-codex-list';
      this.reading = doc.createElement('article'); this.reading.setAttribute('aria-label', 'Codex reading pane');
      shell.body.replaceChildren(input, this.listElement, this.reading);
      shell.footer.replaceChildren(button(doc, 'Close', () => this.close()));
    }
    const list = this.listElement; const reading = this.reading;
    if (list === null || reading === null) return;
    list.replaceChildren(); reading.replaceChildren();
    const readable = codex.list(); const matches = new Set(search(codex.buildIndex(), this.query));
    for (const item of readable) {
      if (matches.has(item.id)) list.append(button(doc, item.title, () => { this.selected = item.id; this.invalidate(); }));
    }
    if (this.query.trim() === '') {
      const readableIds = new Set(readable.map(item => item.id));
      for (const id of registry.ids()) {
        if (!readableIds.has(id)) list.append(button(doc, `${id}: Locked`, () => { this.selected = id; this.invalidate(); }));
      }
    }
    if (list.childElementCount === 0) list.append(paragraph(doc, 'No matching entries.'));
    if (this.selected === null) { reading.append(paragraph(doc, 'Choose an entry to read.')); return; }
    const result = codex.open(this.selected);
    if (result.kind === 'locked') { reading.append(paragraph(doc, `${result.id}: Locked`)); return; }
    const { entry } = result;
    const heading = doc.createElement('h3'); heading.textContent = entry.title;
    reading.append(heading, paragraph(doc, entry.concept));
    if (entry.workedExample !== null) {
      reading.append(paragraph(doc, entry.workedExample.summary));
      const trace = doc.createElement('pre'); trace.textContent = entry.workedExample.trace.join('\n'); reading.append(trace);
    }
    if (entry.counterfactual !== null) reading.append(paragraph(doc, entry.counterfactual.narrative));
    if (result.remedy !== null) reading.append(paragraph(doc, `Remedy: ${remedyText(result.remedy)}`));
    if (entry.commands.length > 0) reading.append(paragraph(doc, `Commands: ${entry.commands.join(', ')}`));
    reading.append(paragraph(doc, citation(entry.chapter)));
  }

  override dispose(): void {
    this.unsubscribe(); this.config.document.removeEventListener('keydown', this.onKey); super.dispose();
  }
}
