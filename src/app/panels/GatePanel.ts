/**
 * WP-24 section 3: the disc class gate. Shows GATE_QUESTION, the three discs
 * on the plinth with their ledgers, the four resource kinds as buttons, and
 * dispatches `boot.choose_disc` with `anchor.disc_plinth:<resource>`. The
 * handler decides good or costly; the panel shows which with one sentence
 * from the leg's own copy, and the leg ends on the record the handler writes.
 */
import type { Tick } from '@kernel/types';
import type { CommandBus } from '@game/CommandBus';
import { startingLedger } from '@game/travel/ledger';
import type { DiscClass, RunState } from '@game/types';
import { GATE_QUESTION, codexEntries } from '@legs/boot_sector/copy';
import { ANCHORS } from '@legs/boot_sector/interactions';
import { reduceRequisition } from '@legs/boot_sector/windows';
import { DeferredPanel, button, messageOf, paragraph, resourcesText, type PanelOptions, type PanelShell } from './panel';

export interface GatePanelOptions extends PanelOptions {
  /** Applied synchronously at `tick`: the panel holds the clock, and a held clock drains no queue. */
  readonly bus: Pick<CommandBus, 'apply'>;
  readonly run: () => Readonly<RunState>;
  readonly tick: () => Tick;
}

/** The four ledger stocks the gate asks about, narrative bible 4 and 5.2. */
export const GATE_RESOURCES = ['cycles', 'quota', 'blocks', 'bandwidth'] as const;
const CLASSES: readonly DiscClass[] = ['shell', 'daemon', 'compiler'];
/** Score multipliers, narrative bible 4.1 to 4.3; nothing in src/game carries them. */
const SCORE_MULTIPLIER: Readonly<Record<DiscClass, number>> = { shell: 1.0, daemon: 2.0, compiler: 3.5 };

const firstSentence = (text: string): string => text.slice(0, text.indexOf('. ') + 1);
/** One sentence from the leg's copy for each outcome: the ledger entry for a right answer, the allocator entry for a wrong one. */
export const GATE_LINES = {
  good: firstSentence(codexEntries.find(entry => entry.id === 'codex.resource_ledger')?.concept ?? 'Four stocks, one for each thing a machine runs out of.'),
  costly: firstSentence(codexEntries.find(entry => entry.id === 'codex.os_role')?.concept ?? 'An operating system is a resource allocator and a control program.'),
} as const;

export class GatePanel extends DeferredPanel {
  private message = '';
  private seenDecisions = -1;

  constructor(private readonly config: GatePanelOptions) { super(config, 'gate', GATE_QUESTION); }

  open(): void { this.message = ''; this.show(); }

  protected render(shell: PanelShell): void {
    const { document: doc } = this.config;
    const run = this.config.run();
    const state = reduceRequisition(run.decisions, run.discClass, run.difficulty);
    shell.body.replaceChildren(); shell.footer.replaceChildren();
    if (this.message !== '') shell.body.append(paragraph(doc, this.message, 'kt-panel-error'));
    const plinth = doc.createElement('section'); plinth.setAttribute('aria-label', 'Disc plinth');
    for (const disc of CLASSES) {
      const line = paragraph(doc, `${disc}${disc === run.discClass ? ' (issued)' : ''}: ${resourcesText({ ...startingLedger(disc, run.difficulty) })}; score x${SCORE_MULTIPLIER[disc]}`);
      line.setAttribute('data-disc', disc); plinth.append(line);
    }
    shell.body.append(plinth);
    const gate = state.gate;
    if (gate === null) {
      const choices = doc.createElement('div'); choices.setAttribute('aria-label', 'Resource kinds');
      for (const resource of GATE_RESOURCES) {
        choices.append(button(doc, resource, () => {
          try {
            const outcome = this.config.bus.apply({ kind: 'interaction', id: 'boot.choose_disc', anchor: `${ANCHORS.discPlinth}:${resource}` }, { source: 'world', legId: 'boot_sector' }, this.config.tick());
            this.message = outcome.refused ?? '';
          } catch (error) { this.message = messageOf(error); }
          this.invalidate();
        }));
      }
      shell.body.append(choices);
    } else {
      const verdict = gate.correct ? 'good' : 'costly';
      const answer = paragraph(doc, `${gate.answer}: ${verdict}. ${GATE_LINES[verdict]}`);
      answer.setAttribute('data-outcome', verdict); answer.setAttribute('role', 'status');
      shell.body.append(answer);
    }
    this.seenDecisions = run.decisions.length;
  }

  override flush(): void {
    if (this.isOpen && this.config.run().decisions.length !== this.seenDecisions) this.invalidate();
    super.flush();
  }
}
