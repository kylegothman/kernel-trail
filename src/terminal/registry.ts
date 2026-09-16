/**
 * KERNEL TRAIL: the command registry (WP-15 spec 4, scope correction T6).
 *
 * `TerminalCommandDef` is frozen in @game/types and carries no handler, so the
 * registry pairs each definition with the handler this package ships for that
 * name. The base shell registers the fourteen names of design brief section 7;
 * a leg registers the rest through `Leg.terminalCommands`. Four names (hyper,
 * guest, migrate, belady) have no handler here and are accepted pending
 * `registerHandler`; any other name without a shipped handler, and any name
 * registered twice, is an error the leg author sees at registration time, so
 * the shell can never print a canned response.
 */
import type { TerminalCommandDef } from '@game/types';
import type { Errno } from '@kernel/types';
import type { ShellContext } from './Shell';

export type CommandResult =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string; readonly topic: string; readonly errno?: Errno };

/** Enumerable argument kinds a command declares so Tab completion can offer live values. */
export type CompletionKind =
  | 'pid' | 'scheduler' | 'replacement' | 'disk' | 'allocation' | 'device' | 'resource' | 'primitive'
  | 'syscall' | 'syscall-arg' | 'topic' | 'deadlock-strategy' | 'signal';

export interface ArgCompletion {
  /** The flag the value follows, or null for a positional argument. */
  readonly flag: string | null;
  readonly kind: CompletionKind;
}

export type CommandRun = (argv: readonly string[], ctx: ShellContext) => CommandResult;

export interface TerminalCommand {
  readonly def: TerminalCommandDef;
  readonly run: CommandRun;
  readonly completions?: readonly ArgCompletion[];
  /** Extra lines printed after usage and summary by `--help`, such as the ps state key. */
  readonly help?: readonly string[];
}

export interface ShippedHandler {
  readonly run: CommandRun;
  readonly completions?: readonly ArgCompletion[];
  readonly help?: readonly string[];
}

export const ok = (lines: readonly string[]): CommandResult => ({ ok: true, lines });

/** Every error names the man topic that explains it (WP-15 spec 4). */
export function fail(topic: string, text: string, errno?: Errno): CommandResult {
  const message = `${text} See man ${topic}.`;
  return errno === undefined ? { ok: false, message, topic } : { ok: false, message, topic, errno };
}

/** The names whose handlers a later leg supplies (scope correction T6). */
export const DEFERRED_COMMANDS: readonly string[] = ['hyper', 'guest', 'migrate', 'belady'];

/** Edit distance, for naming the nearest real topic or command. */
export function editDistance(a: string, b: string): number {
  const previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] ?? 0;
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

/** The candidate closest to `name`; ties resolve alphabetically so the answer is stable. */
export function nearest(name: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of [...candidates].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

export class CommandRegistry {
  private readonly commands = new Map<string, TerminalCommand>();
  private readonly pending = new Map<string, TerminalCommandDef>();

  constructor(private readonly shipped: ReadonlyMap<string, ShippedHandler>) {}

  /** Pair a definition with its shipped handler. Throws on a collision or a missing handler outside the deferred set. */
  register(def: TerminalCommandDef): void {
    if (this.commands.has(def.name) || this.pending.has(def.name)) throw new Error(`terminal command '${def.name}' is already registered`);
    const handler = this.shipped.get(def.name);
    if (handler !== undefined) { this.commands.set(def.name, { def, ...handler }); return; }
    if (!DEFERRED_COMMANDS.includes(def.name)) throw new Error(`terminal command '${def.name}' has no handler in this build; only ${DEFERRED_COMMANDS.join(', ')} may be registered without one`);
    this.pending.set(def.name, def);
  }

  /** The leg that introduces a deferred command supplies its handler here. */
  registerHandler(name: string, run: CommandRun, completions?: readonly ArgCompletion[]): void {
    if (this.commands.has(name)) throw new Error(`terminal command '${name}' already has a handler`);
    const def = this.pending.get(name);
    if (def === undefined) throw new Error(`terminal command '${name}' has no registered definition to attach a handler to`);
    this.pending.delete(name);
    this.commands.set(name, completions === undefined ? { def, run } : { def, run, completions });
  }

  get(name: string): TerminalCommand | undefined {
    const command = this.commands.get(name);
    if (command !== undefined) return command;
    const def = this.pending.get(name);
    if (def === undefined) return undefined;
    return { def, run: () => fail(name, `${name} has no handler in this build; the leg that introduces it supplies one.`) };
  }

  has(name: string): boolean { return this.commands.has(name) || this.pending.has(name); }

  /** Registered names, sorted. */
  names(): readonly string[] { return [...this.commands.keys(), ...this.pending.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); }

  definitions(): readonly TerminalCommandDef[] { return this.names().map(name => this.get(name)?.def).filter((def): def is TerminalCommandDef => def !== undefined); }
}
