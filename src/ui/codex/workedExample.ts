/**
 * Builds `CodexWorkedExample` from the kernel event log at the moment an
 * entry becomes readable. Narrative bible 14.2 and 14.3: at most 12 lines,
 * oldest first, plus the named metrics the entry's prose interpolates. It is
 * never authored by hand; every field here derives from the log, the run
 * state or the metrics the host supplies.
 */
import type { KernelEvent, Tick } from '@kernel/types';
import type { LegId, RunState } from '@game/types';
import type { CodexWorkedExample } from '@game/codexTypes';

export const WORKED_EXAMPLE_MAX_LINES = 12;

function scalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    return `{${keys.length}}`;
  }
  return '?';
}

/**
 * One line per event, in the register of 14.3:
 * `t4994  memory.thrashing  faultRate 47  severity warning`. Keys in the
 * event's own declaration order, objects and arrays summarised by size.
 */
export function renderEventLine(e: KernelEvent): string {
  const fields: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 'tick' || k === 'seq' || k === 'type') continue;
    fields.push(`${k} ${scalar(v)}`);
  }
  return [`t${String(e.tick)}`, e.type, ...fields].join('  ');
}

export interface WorkedExampleInput {
  /** The recent event log, any order; the last `WORKED_EXAMPLE_MAX_LINES` by seq are kept. */
  readonly log: readonly KernelEvent[];
  readonly trigger: KernelEvent | null;
  readonly run: Readonly<RunState>;
  readonly legId: LegId;
  readonly capturedAtTick: Tick;
  readonly metrics: Readonly<Record<string, number>>;
}

/** The player's last recorded decision and what the sim did back, one sentence. */
export function summarise(input: WorkedExampleInput): string {
  const decision = input.run.decisions[input.run.decisions.length - 1];
  const did =
    decision === undefined
      ? 'Before any recorded decision'
      : `At tick ${String(decision.tick)} you chose ${decision.kind} ${decision.choice}`;
  const back =
    input.trigger === null
      ? `the run reached tick ${String(input.capturedAtTick)}.`
      : `the kernel reported ${input.trigger.type} at tick ${String(input.trigger.tick)}.`;
  return `${did}, and ${back}`;
}

export function buildWorkedExample(input: WorkedExampleInput): CodexWorkedExample {
  const ordered = [...input.log].sort((a, b) => a.seq - b.seq);
  const tail = ordered.slice(Math.max(0, ordered.length - WORKED_EXAMPLE_MAX_LINES));
  return {
    capturedAtTick: input.capturedAtTick,
    legId: input.legId,
    summary: summarise(input),
    trace: tail.map(renderEventLine),
    metrics: { ...input.metrics },
  };
}
