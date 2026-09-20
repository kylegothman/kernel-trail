/**
 * WP-24 section 4: what a declined verb says.
 *
 * A refused interaction is recorded `costly` and, before this, shown as
 * nothing. The reason lives in the `CommandOutcome` the bus returns from
 * `drain`, which the host hands straight to the director; `ObservedBus`
 * publishes each drain so a panel can read it. `refusalFor` turns one
 * outcome into a line: the director's own reason when it refused before the
 * handler, the leg's line when the handler declined (the Boot Sector's two
 * verbs resolve through the leg's own data), otherwise `Declined.` (pre-flight
 * ruling 9.14; a refusals map on the companion is a follow-up). The line is
 * shown under the verb's row for `REFUSAL_LINE_MS` of wall time, then gone.
 * `costly` stays the recorded outcome; the frozen union is untouched.
 */
import type { Tick } from '@kernel/types';
import { CommandBus, type CommandOutcome } from '@game/CommandBus';
import type { RunState } from '@game/types';
import { DIRECT_REACH_LINE } from '@legs/boot_sector/copy';
import { parseInteractionChoice, reduceRequisition } from '@legs/boot_sector/windows';

export const REFUSAL_LINE_MS = 2000;
/** The panel's own line for a handler decline no leg has a line for. */
export const DECLINED_LINE = 'Declined.';

export interface Refusal {
  /** The interaction id the line belongs under. */
  readonly id: string;
  readonly text: string;
}

export interface OutcomeSource {
  onOutcomes(listener: (outcomes: readonly CommandOutcome[]) => void): () => void;
}

/** The bus the session builds: every drain is published after the director has observed it. */
export class ObservedBus extends CommandBus implements OutcomeSource {
  private readonly listeners = new Set<(outcomes: readonly CommandOutcome[]) => void>();
  onOutcomes(listener: (outcomes: readonly CommandOutcome[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  override drain(at: Tick): CommandOutcome[] {
    const outcomes = super.drain(at);
    if (outcomes.length > 0) for (const listener of this.listeners) listener(outcomes);
    return outcomes;
  }
}

/** The errno line in the form of the leg's own hard stop: `EPERM. man EPERM.` */
export const errnoLine = (errno: string): string => `${errno}. man ${errno}.`;

/** The Boot Sector's line for a handler decline, from the leg's data, or null for a verb it has no line for. */
export function bootSectorLine(run: Readonly<RunState>, id: string): string | null {
  if (id === 'boot.direct_reach') return DIRECT_REACH_LINE;
  if (id === 'boot.trap_purchase') {
    const errno = reduceRequisition(run.decisions, run.discClass, run.difficulty).submissions.at(-1)?.errno ?? null;
    return errno === null ? null : errnoLine(errno);
  }
  return null;
}

/** One outcome to one line, or null when the command was not an interaction or was not refused. */
export function refusalFor(outcome: CommandOutcome, run: Readonly<RunState>): Refusal | null {
  if (outcome.command.kind !== 'interaction') return null;
  const id = outcome.command.id;
  if (outcome.refused !== null) return { id, text: outcome.refused };
  const record = run.decisions[outcome.decisionIndex];
  if (record === undefined || record.kind !== 'interaction' || record.outcome !== 'costly') return null;
  if (parseInteractionChoice(record.choice)?.id !== id) return null;
  const line = record.legId === 'boot_sector' ? bootSectorLine(run, id) : null;
  return { id, text: line ?? DECLINED_LINE };
}

/** The lines currently showing, keyed by interaction id, each until a wall-clock time. */
export class RefusalLines {
  private readonly lines = new Map<string, { readonly text: string; readonly until: number }>();

  show(refusal: Refusal, nowMs: number): void {
    this.lines.set(refusal.id, { text: refusal.text, until: nowMs + REFUSAL_LINE_MS });
  }

  /** Drop expired lines; true when anything changed. */
  expire(nowMs: number): boolean {
    let changed = false;
    for (const [id, line] of this.lines) if (nowMs >= line.until) { this.lines.delete(id); changed = true; }
    return changed;
  }

  text(id: string): string | null { return this.lines.get(id)?.text ?? null; }
  get size(): number { return this.lines.size; }
}

export function refusalElement(doc: Document, text: string): HTMLElement {
  const p = doc.createElement('p');
  p.className = 'kt-panel-error kt-refusal';
  p.setAttribute('role', 'status');
  p.textContent = text;
  return p;
}
