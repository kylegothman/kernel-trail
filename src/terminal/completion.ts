/**
 * KERNEL TRAIL: Tab completion (WP-15 spec 6, acceptance 23).
 *
 * Command names come from the registry. Argument values come from what the
 * command declares (an enumerable kind per flag or positional) resolved
 * against the host: policy ids from the four kernel registries, live pids,
 * devices, resources and primitives from the view, syscall names and their
 * argument roles from CALL_SPECS. Nothing here is a hand-written list.
 */
import type { CommandRegistry, CompletionKind, TerminalCommand } from './registry';
import { classify } from './parser';
import type { ShellContext } from './Shell';
import { allTopics } from './man/ManPages';

export interface Completion {
  readonly candidates: readonly string[];
  /** The span of the input the candidate replaces. */
  readonly start: number;
  readonly end: number;
}

/** Signals the kernel models: 0 tests existence, 9 terminates (sim spec 14.3). */
const SIGNALS: readonly string[] = ['0', '9'];

function roleKind(role: string | undefined): CompletionKind | null {
  switch (role) {
    case 'pid': return 'pid';
    case 'device': return 'device';
    case 'resource': return 'resource';
    case 'primitive': return 'primitive';
    default: return null;
  }
}

/** The values a kind enumerates right now. */
export function valuesFor(kind: CompletionKind, ctx: ShellContext, registry: CommandRegistry, argv: readonly string[]): readonly string[] {
  const { host } = ctx;
  switch (kind) {
    case 'pid': return host.view().processes.map(pcb => String(pcb.pid));
    case 'scheduler': return host.specs.schedulers;
    case 'replacement': return host.specs.replacementPolicies;
    case 'disk': return host.specs.diskPolicies;
    case 'allocation': return host.specs.allocationStrategies;
    case 'device': return host.view().devices.map(device => device.id);
    case 'resource': return host.view().resources.map(resource => resource.id);
    case 'primitive': return host.view().syncPrimitives.map(primitive => primitive.id);
    case 'syscall': return host.specs.names;
    case 'deadlock-strategy': return ['ignore', 'detect', 'avoid', 'prevent'];
    case 'signal': return SIGNALS;
    case 'topic': return allTopics(registry, host);
    case 'syscall-arg': {
      const name = argv[0];
      const spec = name === undefined ? undefined : host.specs.names.includes(name as (typeof host.specs.names)[number]) ? host.specs.calls[name as (typeof host.specs.names)[number]] : undefined;
      if (spec === undefined) return [];
      const index = argv.length - 2;
      const arg = index < spec.args.length ? spec.args[index] : spec.repeat?.[(index - spec.args.length) % (spec.repeat.length || 1)];
      const resolved = roleKind(arg?.role);
      return resolved === null ? [] : valuesFor(resolved, ctx, registry, argv);
    }
    default: return [];
  }
}

function kindFor(command: TerminalCommand, argv: readonly string[]): CompletionKind | null {
  const declared = command.completions ?? [];
  const current = argv[argv.length - 1] ?? '';
  const previous = argv[argv.length - 2];
  if (previous !== undefined) {
    const flag = classify(previous);
    if (flag.kind === 'flag') {
      const match = declared.find(entry => entry.flag === flag.name);
      if (match !== undefined) return match.kind;
    }
  }
  if (classify(current).kind === 'flag') return null;
  let positionalIndex = 0;
  for (let index = 0; index < argv.length - 1; index++) {
    const word = argv[index] ?? '';
    const kind = classify(word);
    if (kind.kind === 'flag') {
      const match = declared.find(entry => entry.flag === kind.name);
      if (match !== undefined) index += 1;
      continue;
    }
    if (kind.kind === 'word') positionalIndex += 1;
  }
  const positionals = declared.filter(entry => entry.flag === null);
  const entry = positionals[positionalIndex] ?? (positionals.length > 0 && positionals[positionals.length - 1]?.kind === 'syscall-arg' ? positionals[positionals.length - 1] : undefined);
  return entry?.kind ?? null;
}

export function complete(input: string, registry: CommandRegistry, ctx: ShellContext): Completion {
  const words = input.split(/\s+/).filter(word => word.length > 0);
  const trailing = input.length > 0 && /\s$/.test(input);
  const current = trailing ? '' : words[words.length - 1] ?? '';
  const start = input.length - current.length;
  const end = input.length;
  const completingCommand = words.length === 0 || (words.length === 1 && !trailing);
  if (completingCommand) {
    return { candidates: registry.names().filter(name => name.startsWith(current)), start, end };
  }
  const command = registry.get(words[0] ?? '');
  if (command === undefined) return { candidates: [], start, end };
  const argv = trailing ? [...words.slice(1), ''] : words.slice(1);
  const kind = kindFor(command, argv);
  if (kind === null) return { candidates: [], start, end };
  const candidates = [...new Set(valuesFor(kind, ctx, registry, argv))].filter(value => value.startsWith(current)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { candidates, start, end };
}
