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
import type { Errno, Pid } from '@kernel/types';
import type { ShellContext } from './Shell';
import { bindFlags, parseInteger, type BoundArgs, type FlagSpec } from './parser';

export type CommandResult =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string; readonly topic: string; readonly errno?: Errno };

export type CommandFailure = Extract<CommandResult, { readonly ok: false }>;

/** Enumerable argument kinds a command declares so Tab completion can offer live values. */
export type CompletionKind =
  | 'pid' | 'scheduler' | 'replacement' | 'disk' | 'allocation' | 'device' | 'resource' | 'primitive'
  | 'syscall' | 'syscall-arg' | 'topic' | 'deadlock-strategy' | 'signal'
  /** A flag that takes one value with nothing to enumerate, declared so the positional count stays right. */
  | 'value';

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
export function fail(topic: string, text: string, errno?: Errno): CommandFailure {
  const message = `${text} See man ${topic}.`;
  return errno === undefined ? { ok: false, message, topic } : { ok: false, message, topic, errno };
}

/** The error every unsupported flag returns (pre-flight F19): an error with a topic, never output. */
export function unavailable(topic: string, flag: string, reason: string): CommandFailure {
  return fail(topic, `${flag} is not available in this shell: ${reason}.`);
}

/** Bind flags or explain the mistake under the command's own man topic. */
export function bindOrFail(topic: string, argv: readonly string[], spec: FlagSpec): { readonly ok: true; readonly args: BoundArgs } | CommandFailure {
  const bound = bindFlags(argv, spec);
  return bound.ok ? bound : fail(topic, `${bound.message}.`);
}

/** A positional or flag value that must be a process id. */
export function pidArg(text: string | undefined, topic: string): { readonly ok: true; readonly pid: Pid } | CommandFailure {
  const value = parseInteger(text);
  if (value === null || value < 0) return fail(topic, `'${text ?? ''}' is not a process id.`);
  return { ok: true, pid: value as Pid };
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

/** A definition as the lines it is compared by, so a differing re-registration can name the first one that differs. */
function definitionLines(def: TerminalCommandDef): readonly string[] {
  const chapter = def.chapter === null ? 'null' : `${def.chapter.chapter} ${JSON.stringify(def.chapter.title)} [${def.chapter.sections.join(', ')}]`;
  return [`name: ${def.name}`, `usage: ${def.usage}`, `summary: ${def.summary}`, `chapter: ${chapter}`, ...def.manual.split('\n').map((line, i) => `manual[${i}]: ${line}`)];
}

/** Null when the two definitions are byte-identical, else the first line of each that differs. */
export function firstDefinitionDifference(registered: TerminalCommandDef, candidate: TerminalCommandDef): { readonly registered: string; readonly candidate: string } | null {
  const a = definitionLines(registered);
  const b = definitionLines(candidate);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { registered: a[i] ?? '<end of definition>', candidate: b[i] ?? '<end of definition>' };
  }
  return null;
}

export class CommandRegistry {
  private readonly commands = new Map<string, TerminalCommand>();
  private readonly pending = new Map<string, TerminalCommandDef>();

  constructor(private readonly shipped: ReadonlyMap<string, ShippedHandler>) {}

  /**
   * Pair a definition with its shipped handler. A byte-identical
   * re-registration is a no-op, so a leg may re-ship a base definition
   * through `Leg.terminalCommands` (WP-21 section 4); a differing one throws
   * naming the first differing line, as does a missing handler outside the
   * deferred set.
   */
  register(def: TerminalCommandDef): void {
    const existing = this.commands.get(def.name)?.def ?? this.pending.get(def.name);
    if (existing !== undefined) {
      const difference = firstDefinitionDifference(existing, def);
      if (difference === null) return;
      throw new Error(`terminal command '${def.name}' is already registered with a different definition; first differing line: registered "${difference.registered}" versus new "${difference.candidate}"`);
    }
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
