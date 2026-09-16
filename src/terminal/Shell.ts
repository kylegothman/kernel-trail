/**
 * KERNEL TRAIL: the shell (WP-15 spec 4).
 *
 * One line in, one CommandResult out. The shell parses, looks the command up,
 * binds `--help`, runs the handler, and turns anything the handler throws into
 * an error that names a man topic. It owns the event rings (scope correction
 * T5 and T10) and the history, and it holds no mutable kernel reference a
 * command could misuse: commands see a `TerminalHost`, whose kernel is the
 * frozen read interface, and every write goes through the host's sink.
 */
import type { Pid, ProcessControlBlock } from '@kernel/types';
import type { TerminalCommandDef } from '@game/types';
import { complete, type Completion } from './completion';
import { createEventRings, type EventRings } from './eventRings';
import { History } from './history';
import type { TerminalHost } from './host';
import { PARSER_TOPIC, parse } from './parser';
import { CommandRegistry, fail, nearest, ok, type CommandResult, type CommandRun, type ShippedHandler } from './registry';
import { BASE_DEFINITIONS, SHIPPED_HANDLERS } from './commands/index';

/**
 * What a command receives: the host, the shell's event rings, the registry
 * (read by `man` and by completion) and the line being run, for the sink's
 * origin. No mutable kernel reference: the host's kernel is the frozen read
 * interface and every write goes through the host's sink.
 */
export interface ShellContext {
  readonly host: TerminalHost;
  readonly rings: EventRings;
  readonly registry: CommandRegistry;
  readonly line: string;
}

export interface ShellOptions {
  readonly rings?: EventRings;
  readonly handlers?: ReadonlyMap<string, ShippedHandler>;
}

/**
 * The caller identity rule for syscalls the terminal issues (pre-flight F3).
 * The kernel has no shell process, so a command issues each call as the process
 * the call is about: `nice` and `kill` as their target (the call adjusts the
 * caller; self-kill passes the rights gate and records `killed_by_user`),
 * `wait` as the target's parent (only a parent may reap), and everything else
 * as the running process, else init, unless the player names a caller with
 * `--pid`. Every handler that issues a syscall references this function or
 * this comment rather than restating the rule.
 */
export function callerPid(host: TerminalHost, explicit?: Pid): Pid {
  if (explicit !== undefined) return explicit;
  const view = host.view();
  if (view.running !== null && view.running > 1) return view.running;
  const first = view.processes.find(pcb => pcb.pid === 1);
  return first?.pid ?? (1 as Pid);
}

/** Look a process up by pid in the live view, or explain which topic covers the miss. */
export function findProcess(host: TerminalHost, pid: Pid): Readonly<ProcessControlBlock> | undefined {
  return host.view().processes.find(pcb => pcb.pid === pid);
}

export class Shell {
  readonly registry: CommandRegistry;
  readonly history = new History();
  readonly rings: EventRings;
  private readonly ownsRings: boolean;

  constructor(readonly host: TerminalHost, options: ShellOptions = {}) {
    this.registry = new CommandRegistry(options.handlers ?? SHIPPED_HANDLERS);
    this.ownsRings = options.rings === undefined;
    this.rings = options.rings ?? createEventRings(host.kernel);
  }

  register(def: TerminalCommandDef): void { this.registry.register(def); }
  registerAll(defs: readonly TerminalCommandDef[]): void { for (const def of defs) this.registry.register(def); }
  registerHandler(name: string, run: CommandRun): void { this.registry.registerHandler(name, run); }

  execute(line: string): CommandResult {
    this.history.push(line);
    const parsed = parse(line);
    if (!parsed.ok) return { ok: false, message: parsed.message, topic: PARSER_TOPIC };
    if (parsed.line === null) return ok([]);
    const { command: name, argv, flags } = parsed.line;
    const command = this.registry.get(name);
    if (command === undefined) {
      const candidate = nearest(name, this.registry.names()) ?? PARSER_TOPIC;
      return fail(candidate, `unknown command '${name}'; the nearest is '${candidate}'.`);
    }
    if (flags.includes('help')) return ok([command.def.usage, command.def.summary, ...(command.help ?? [])]);
    const ctx: ShellContext = { host: this.host, rings: this.rings, registry: this.registry, line };
    try {
      return command.run(argv, ctx);
    } catch (error) {
      return fail(name, `${name} failed: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  complete(input: string): Completion {
    return complete(input, this.registry, { host: this.host, rings: this.rings, registry: this.registry, line: input });
  }

  dispose(): void { if (this.ownsRings) this.rings.dispose(); }
}

/** The base shell of design brief section 7: exactly the fourteen always-available commands, every one with a handler. */
export function createBaseShell(host: TerminalHost, options: ShellOptions = {}): Shell {
  const shell = new Shell(host, options);
  shell.registerAll(BASE_DEFINITIONS);
  return shell;
}
