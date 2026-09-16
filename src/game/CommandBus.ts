/**
 * KERNEL TRAIL - the command bus. Architecture section 4.7.
 *
 * Every player verb from any surface travels this one road: the HUD, the
 * world's anchors and the terminal dispatch a `Command`, the game loop
 * drains the queue immediately before a tick, and for each command the bus
 * appends exactly one `DecisionRecord` to `RunState.decisions` and then calls
 * the mutator. Nothing else in `src/ui` or `src/terminal` may call a kernel
 * mutator, because an unrecorded decision breaks replay and therefore the
 * counterfactual debrief. Commands are applied at tick boundaries and
 * recorded with that tick, which is what makes `decisions` plus the seed
 * reproduce the run.
 */

import type {
  AllocationStrategy,
  ConvoyMemberId,
  DiskSchedulingId,
  PageReplacementId,
  SchedulerId,
  SchedulerParams,
  SyscallRequest,
  SyscallResult,
  Tick,
} from '@kernel/types';
import type { DecisionRecord, LegId, Pace, Rations, RunState } from '@game/types';
import type { Store } from './store';

export type Command =
  | { readonly kind: 'set_scheduler'; readonly to: SchedulerId; readonly quantum?: number }
  | { readonly kind: 'set_replacement'; readonly to: PageReplacementId }
  | { readonly kind: 'set_disk_policy'; readonly to: DiskSchedulingId }
  | { readonly kind: 'set_allocation'; readonly to: AllocationStrategy }
  | { readonly kind: 'set_pace'; readonly to: Pace }
  | { readonly kind: 'set_rations'; readonly to: Rations }
  | { readonly kind: 'set_degree'; readonly to: number }
  | { readonly kind: 'use_ability'; readonly member: ConvoyMemberId; readonly target: number | null }
  | { readonly kind: 'syscall'; readonly request: SyscallRequest }
  | { readonly kind: 'interaction'; readonly id: string; readonly anchor: string }
  | { readonly kind: 'terminal'; readonly line: string };

export type CommandKind = Command['kind'];

export interface CommandOrigin {
  /** Where the command came from. Replay only accepts 'replay'. */
  readonly source: 'hud' | 'world' | 'terminal' | 'replay';
  readonly legId: LegId;
}

/** The mutating subset of `Kernel` the bus may call. Type-only; the instance is injected. */
export interface KernelMutators {
  setScheduler(id: SchedulerId, params?: Partial<SchedulerParams>): void;
  setReplacementPolicy(id: PageReplacementId): void;
  setDiskPolicy(id: DiskSchedulingId): void;
  setAllocationStrategy(s: AllocationStrategy): void;
  syscall(request: SyscallRequest): SyscallResult;
}

/**
 * Verbs whose mechanics belong to other packages: abilities, interactions and
 * crossings to the leg runner (WP-19), terminal lines to the terminal
 * (WP-15). The bus records the decision and hands the command over.
 */
export interface CommandHandlers {
  useAbility(member: ConvoyMemberId, target: number | null, at: Tick): void;
  interaction(id: string, anchor: string, at: Tick): void;
  terminal(line: string, at: Tick): void;
}

export interface CommandBusOptions {
  readonly store: Store<RunState>;
  readonly kernel: KernelMutators;
  readonly handlers: CommandHandlers;
  /** Bounded so a stuck key cannot queue ten thousand commands. */
  readonly capacity?: number;
}

export interface CommandOutcome {
  readonly command: Command;
  readonly origin: CommandOrigin;
  readonly at: Tick;
  /** Index of the record appended to `RunState.decisions`. */
  readonly decisionIndex: number;
  readonly syscall: SyscallResult | null;
}

export const COMMAND_QUEUE_CAPACITY = 64;

/** The `choice` string a command records, stable so replay and the debrief can read it back. */
export function describeChoice(cmd: Command): string {
  switch (cmd.kind) {
    case 'set_scheduler':
      return cmd.quantum === undefined ? cmd.to : `${cmd.to} q=${cmd.quantum}`;
    case 'set_replacement':
    case 'set_disk_policy':
    case 'set_allocation':
    case 'set_pace':
    case 'set_rations':
      return cmd.to;
    case 'set_degree':
      return String(cmd.to);
    case 'use_ability':
      return cmd.target === null ? cmd.member : `${cmd.member} -> ${cmd.target}`;
    case 'syscall':
      return `${cmd.request.name}(${cmd.request.args.map(String).join(', ')})`;
    case 'interaction':
      return `${cmd.id} @ ${cmd.anchor}`;
    case 'terminal':
      return cmd.line;
    default:
      return assertNever(cmd);
  }
}

export class CommandBus {
  private readonly queue: { cmd: Command; origin: CommandOrigin }[] = [];
  private readonly store: Store<RunState>;
  private readonly kernel: KernelMutators;
  private readonly handlers: CommandHandlers;
  private readonly capacity: number;
  /** Commands refused because the queue was full. */
  dropped = 0;

  constructor(options: CommandBusOptions) {
    this.store = options.store;
    this.kernel = options.kernel;
    this.handlers = options.handlers;
    this.capacity = options.capacity ?? COMMAND_QUEUE_CAPACITY;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Queue a command. Returns false, and drops it, when the queue is full. */
  dispatch(cmd: Command, origin: CommandOrigin): boolean {
    if (this.queue.length >= this.capacity) {
      this.dropped += 1;
      return false;
    }
    this.queue.push({ cmd, origin });
    return true;
  }

  /** Drained by the game loop immediately before a tick, in dispatch order. */
  drain(at: Tick): CommandOutcome[] {
    const items = this.queue.splice(0, this.queue.length);
    return items.map((item) => this.apply(item.cmd, item.origin, at));
  }

  /** Record the decision, then mutate. In that order, always. */
  apply(cmd: Command, origin: CommandOrigin, at: Tick): CommandOutcome {
    const record: DecisionRecord = {
      tick: at,
      legId: origin.legId,
      kind: cmd.kind,
      choice: describeChoice(cmd),
      outcome: 'pending',
      relatedObjective: null,
    };
    let decisionIndex = -1;
    this.store.mutate((s) => {
      decisionIndex = s.decisions.push(record) - 1;
    });
    const syscall = this.mutate(cmd, at);
    return { command: cmd, origin, at, decisionIndex, syscall };
  }

  private mutate(cmd: Command, at: Tick): SyscallResult | null {
    switch (cmd.kind) {
      case 'set_scheduler':
        this.kernel.setScheduler(cmd.to, cmd.quantum === undefined ? undefined : { quantum: cmd.quantum });
        return null;
      case 'set_replacement':
        this.kernel.setReplacementPolicy(cmd.to);
        return null;
      case 'set_disk_policy':
        this.kernel.setDiskPolicy(cmd.to);
        return null;
      case 'set_allocation':
        this.kernel.setAllocationStrategy(cmd.to);
        return null;
      case 'set_pace':
        this.store.mutate((s) => {
          s.policy.pace = cmd.to;
        });
        return null;
      case 'set_rations':
        this.store.mutate((s) => {
          s.policy.rations = cmd.to;
        });
        return null;
      case 'set_degree':
        this.store.mutate((s) => {
          s.policy.degreeOfMultiprogramming = cmd.to;
        });
        return null;
      case 'use_ability':
        this.handlers.useAbility(cmd.member, cmd.target, at);
        return null;
      case 'syscall':
        return this.kernel.syscall(cmd.request);
      case 'interaction':
        this.handlers.interaction(cmd.id, cmd.anchor, at);
        return null;
      case 'terminal':
        this.handlers.terminal(cmd.line, at);
        return null;
      default:
        return assertNever(cmd);
    }
  }
}

function assertNever(x: never): never {
  throw new Error(`CommandBus: unhandled command ${JSON.stringify(x)}`);
}
