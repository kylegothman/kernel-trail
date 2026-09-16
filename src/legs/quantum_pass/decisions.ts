/**
 * KERNEL TRAIL: Quantum Pass, reading the decision log.
 *
 * Every player verb lands in `RunState.decisions` through the command bus
 * (architecture 4.7), so the policy in force at any tick, the quanta the
 * player committed, the terminal lines they submitted and the nice calls
 * they made are all recoverable from the records of this leg. The bus's own
 * `commandFromRecord` is the parser, so a record reads back exactly as it
 * was applied and never through a second grammar.
 */
import type { Pid, SchedulerId } from '@kernel/types';
import { commandFromRecord } from '@game/CommandBus';
import type { DecisionRecord, RunState } from '@game/types';

export const LEG_ID = 'quantum_pass' as const;
/** The bus prefixes a terminal-sourced choice; a leg strips it before reading the line. */
const TERMINAL_PREFIX = '[terminal] ';

export interface PolicyChange {
  readonly tick: number;
  readonly to: SchedulerId;
  readonly quantum: number | null;
}

export interface PolicySpan {
  readonly policy: SchedulerId;
  readonly from: number;
  /** Exclusive; the leg's tick count for the last span. */
  readonly to: number;
}

export interface NiceCall {
  readonly tick: number;
  readonly pid: Pid;
  readonly delta: number;
}

export interface TerminalLine {
  readonly tick: number;
  readonly name: string;
  readonly argv: readonly string[];
}

/** This leg's records only, in log order. */
export function legDecisions(run: Readonly<RunState>): readonly DecisionRecord[] {
  return run.decisions.filter((record) => record.legId === LEG_ID);
}

/** Every accepted scheduler change, in order; a refused command (outcome costly at admission) still reads as a change, since the bus records before it admits. */
export function policyChanges(run: Readonly<RunState>): readonly PolicyChange[] {
  const changes: PolicyChange[] = [];
  for (const record of legDecisions(run)) {
    if (record.kind !== 'set_scheduler') continue;
    const command = commandFromRecord(record);
    if (command === null || command.kind !== 'set_scheduler') continue;
    changes.push({ tick: record.tick, to: command.to, quantum: command.quantum ?? null });
  }
  return changes;
}

/** The scheduler in force now: the last change, or the entry policy. */
export function currentScheduler(run: Readonly<RunState>, entry: SchedulerId = 'priority'): SchedulerId {
  const changes = policyChanges(run);
  return changes.at(-1)?.to ?? entry;
}

/** The policy in force over each tick span of the leg, from the entry policy through every change. */
export function policyTimeline(run: Readonly<RunState>, ticks: number, entry: SchedulerId = 'priority'): readonly PolicySpan[] {
  const spans: PolicySpan[] = [];
  let policy = entry;
  let from = 0;
  for (const change of policyChanges(run)) {
    if (change.tick > from) spans.push({ policy, from, to: Math.min(change.tick, ticks) });
    policy = change.to;
    from = Math.min(change.tick, ticks);
  }
  spans.push({ policy, from, to: Math.max(from, ticks) });
  return spans;
}

/** The scheduler in force at a tick boundary. */
export function schedulerAt(run: Readonly<RunState>, tick: number, entry: SchedulerId = 'priority'): SchedulerId {
  let policy = entry;
  for (const change of policyChanges(run)) {
    if (change.tick <= tick) policy = change.to;
  }
  return policy;
}

/** The last quantum the player committed by a tick, or null when the pace binding alone set it. */
export function committedQuantumAt(run: Readonly<RunState>, tick: number): number | null {
  let quantum: number | null = null;
  for (const change of policyChanges(run)) {
    if (change.tick <= tick && change.quantum !== null) quantum = change.quantum;
  }
  return quantum;
}

/** Every `nice` syscall the player issued, as the target pid and the delta. */
export function niceCalls(run: Readonly<RunState>): readonly NiceCall[] {
  const calls: NiceCall[] = [];
  for (const record of legDecisions(run)) {
    if (record.kind !== 'syscall') continue;
    const command = commandFromRecord(record);
    if (command === null || command.kind !== 'syscall' || command.request.name !== 'nice') continue;
    const delta = command.request.args[0];
    if (typeof delta !== 'number') continue;
    calls.push({ tick: record.tick, pid: command.request.pid, delta });
  }
  return calls;
}

/** Every terminal line submitted this leg, split into a command name and its arguments. */
export function terminalLines(run: Readonly<RunState>): readonly TerminalLine[] {
  const lines: TerminalLine[] = [];
  for (const record of legDecisions(run)) {
    if (record.kind !== 'terminal') continue;
    const line = record.choice.startsWith(TERMINAL_PREFIX) ? record.choice.slice(TERMINAL_PREFIX.length) : record.choice;
    const [name, ...argv] = line.trim().split(/\s+/).filter((part) => part.length > 0);
    if (name === undefined || name.length === 0) continue;
    lines.push({ tick: record.tick, name, argv });
  }
  return lines;
}

/** The policies named by `gantt --replay <policy>` lines, in order. */
export function replayInvocations(run: Readonly<RunState>): readonly { readonly tick: number; readonly policy: string }[] {
  const invocations: { tick: number; policy: string }[] = [];
  for (const line of terminalLines(run)) {
    if (line.name !== 'gantt') continue;
    const flag = line.argv.indexOf('--replay');
    const policy = flag === -1 ? undefined : line.argv[flag + 1];
    if (policy !== undefined) invocations.push({ tick: line.tick, policy });
  }
  return invocations;
}

/** The instructive wrong remedy: a quantum raised while the policy in force was `priority`. */
export const WRONG_REMEDY_KIND = 'raise_quantum_under_priority';

/**
 * The death, as a decision. The crossing runner is the only writer of a `fatal`
 * decision outcome in the shipped engine and this leg declares no crossing, so
 * the leg records its own: a Program derezzed of starvation and no remedy
 * reached it. The harness requires a known-bad run to mark some decision fatal.
 */
export const UNREMEDIED_KIND = 'starvation_unremedied';

export function quantumRaisedUnderPriority(run: Readonly<RunState>, entry: SchedulerId = 'priority'): readonly PolicyChange[] {
  return policyChanges(run).filter((change) => change.to === 'priority' && change.quantum !== null && schedulerAt(run, change.tick - 1, entry) === 'priority');
}
