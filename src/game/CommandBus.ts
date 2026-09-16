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
  SyscallName,
  SyscallRequest,
  SyscallResult,
  Tick,
} from '@kernel/types';
import { asPid } from '@kernel/types';
import type { DeadlockStrategy } from '@kernel/index';
import type { DecisionRecord, LegId, Pace, Rations, RunState } from '@game/types';
import type { Store } from './store';

export type Command =
  | { readonly kind: 'set_scheduler'; readonly to: SchedulerId; readonly quantum?: number }
  | { readonly kind: 'set_replacement'; readonly to: PageReplacementId }
  | { readonly kind: 'set_disk_policy'; readonly to: DiskSchedulingId }
  | { readonly kind: 'set_allocation'; readonly to: AllocationStrategy }
  | { readonly kind: 'set_deadlock_strategy'; readonly to: DeadlockStrategy }
  | { readonly kind: 'set_pace'; readonly to: Pace }
  | { readonly kind: 'set_rations'; readonly to: Rations }
  | { readonly kind: 'set_degree'; readonly to: number }
  | { readonly kind: 'use_ability'; readonly member: ConvoyMemberId; readonly target: number | null }
  | { readonly kind: 'syscall'; readonly request: SyscallRequest }
  | { readonly kind: 'interaction'; readonly id: string; readonly anchor: string }
  | { readonly kind: 'terminal'; readonly line: string };

export type CommandKind = Command['kind'];

export interface CommandOrigin {
  /** Original terminal writes retain their provenance during replay. */
  readonly source: 'hud' | 'world' | 'terminal' | 'replay';
  readonly legId: LegId;
}

/** The mutating subset of `Kernel` the bus may call. Type-only; the instance is injected. */
export interface KernelMutators {
  setScheduler(id: SchedulerId, params?: Partial<SchedulerParams>): void;
  setReplacementPolicy(id: PageReplacementId): void;
  setDiskPolicy(id: DiskSchedulingId): void;
  setAllocationStrategy(s: AllocationStrategy): void;
  setDeadlockStrategy(strategy: DeadlockStrategy): void;
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
  /** Runs after recording and before any command mutation. WP-19 ruling R1. */
  readonly admit?: (cmd: Command, origin: CommandOrigin, at: Tick) => { ok: true } | { ok: false; reason: string };
}

export interface CommandOutcome {
  readonly command: Command;
  readonly origin: CommandOrigin;
  readonly at: Tick;
  /** Index of the record appended to `RunState.decisions`. */
  readonly decisionIndex: number;
  readonly syscall: SyscallResult | null;
  readonly refused: string | null;
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
    case 'set_deadlock_strategy':
    case 'set_pace':
    case 'set_rations':
      return cmd.to;
    case 'set_degree':
      return String(cmd.to);
    case 'use_ability':
      return cmd.target === null ? cmd.member : `${cmd.member} -> ${cmd.target}`;
    case 'syscall':
      // JSON-quoted args and the calling pid, so `commandFromRecord` can rebuild
      // the exact request: a `"7"` and a `7` validate differently in the syscall
      // table, and the pid is what the call acts as. WP-18 pre-flight ruling 1.
      return `${cmd.request.name}(${cmd.request.args.map((a) => JSON.stringify(a)).join(', ')}) pid=${cmd.request.pid}`;
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
  private readonly admit: CommandBusOptions['admit'];
  /** Commands refused because the queue was full. */
  dropped = 0;

  constructor(options: CommandBusOptions) {
    this.store = options.store;
    this.kernel = options.kernel;
    this.handlers = options.handlers;
    this.capacity = options.capacity ?? COMMAND_QUEUE_CAPACITY;
    this.admit = options.admit;
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
      choice: origin.source === 'terminal' ? TERMINAL_CHOICE_PREFIX + describeChoice(cmd) : describeChoice(cmd),
      outcome: 'pending',
      relatedObjective: null,
    };
    let decisionIndex = -1;
    this.store.mutate((s) => {
      decisionIndex = s.decisions.push(record) - 1;
    });
    const admission = this.admit?.(cmd, origin, at);
    if (admission?.ok === false) {
      this.store.mutate((s) => {
        const decision = s.decisions[decisionIndex];
        if (decision !== undefined) decision.outcome = 'costly';
      });
      return { command: cmd, origin, at, decisionIndex, syscall: null, refused: admission.reason };
    }
    const syscall = this.mutate(cmd, at);
    return { command: cmd, origin, at, decisionIndex, syscall, refused: null };
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
      case 'set_deadlock_strategy':
        this.kernel.setDeadlockStrategy(cmd.to);
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

/* ------------------------------------------------------------------ */
/* The inverse, for replay. WP-18 scope correction U2.                 */
/* ------------------------------------------------------------------ */

/**
 * Exhaustive over the frozen unions: a member added to any of them is a
 * compile error here, so the parser can never accept a stale id or refuse a
 * live one, and no kernel registry has to be imported to validate a string.
 */
const SCHEDULER_IDS: Readonly<Record<SchedulerId, true>> = {
  fcfs: true, sjf: true, srtf: true, priority: true, priority_aging: true, rr: true, mlfq: true,
};
const REPLACEMENT_IDS: Readonly<Record<PageReplacementId, true>> = {
  fifo: true, lru: true, clock: true, optimal: true, lfu: true, random: true,
};
const DISK_IDS: Readonly<Record<DiskSchedulingId, true>> = {
  fcfs: true, sstf: true, scan: true, cscan: true, look: true, clook: true,
};
const ALLOCATION_IDS: Readonly<Record<AllocationStrategy, true>> = {
  first_fit: true, best_fit: true, worst_fit: true, buddy: true,
};
const DEADLOCK_STRATEGIES: Readonly<Record<DeadlockStrategy, true>> = {
  ignore: true, detect: true, avoid: true, prevent: true,
};
const PACES: Readonly<Record<Pace, true>> = { conservative: true, steady: true, aggressive: true, reckless: true };
const RATIONS: Readonly<Record<Rations, true>> = { generous: true, standard: true, lean: true, starved: true };
const SYSCALL_NAMES: Readonly<Record<SyscallName, true>> = {
  fork: true, exec: true, exit: true, wait: true, kill: true, getpid: true, nice: true,
  mmap: true, munmap: true, brk: true,
  open: true, close: true, read: true, write: true, seek: true, stat: true, unlink: true, mkdir: true,
  sem_wait: true, sem_post: true, mutex_lock: true, mutex_unlock: true,
  request: true, release: true,
  ioctl: true, sync: true, chmod: true,
};

function isMember<K extends string>(table: Readonly<Record<K, true>>, value: string): value is K {
  return Object.prototype.hasOwnProperty.call(table, value);
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function syscallFromChoice(choice: string): Command | null {
  const m = /^([a-z_]+)\((.*)\) pid=(\d+)$/s.exec(choice);
  const name = m?.[1];
  const inner = m?.[2];
  const pid = Number(m?.[3]);
  if (name === undefined || inner === undefined || !isMember(SYSCALL_NAMES, name) || !Number.isSafeInteger(pid)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(`[${inner}]`);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isScalar)) return null;
  return { kind: 'syscall', request: { name, pid: asPid(pid), args: parsed } };
}

/**
 * The exact inverse of `describeChoice` for the kinds replay applies, so a
 * recorded decision lands in a replay through the same `apply` as live play.
 * Returns null for `terminal` and `interaction`, which are audit lines whose
 * effect was recorded as a separate command, for `use_ability`, and for a
 * choice string that does not parse or names an unknown id.
 */
const TERMINAL_CHOICE_PREFIX = '[terminal] ';

/** Plain choice strings from older saves remain valid and replay normally. */
export function originFromRecord(record: DecisionRecord): CommandOrigin {
  return { source: record.choice.startsWith(TERMINAL_CHOICE_PREFIX) ? 'terminal' : 'replay', legId: record.legId };
}

export function commandFromRecord(record: DecisionRecord): Command | null {
  const choice = record.choice.startsWith(TERMINAL_CHOICE_PREFIX)
    ? record.choice.slice(TERMINAL_CHOICE_PREFIX.length)
    : record.choice;
  switch (record.kind) {
    case 'set_scheduler': {
      const m = /^([a-z_]+)(?: q=(\d+))?$/.exec(choice);
      const to = m?.[1];
      if (to === undefined || !isMember(SCHEDULER_IDS, to)) return null;
      const quantum = m?.[2];
      return quantum === undefined ? { kind: 'set_scheduler', to } : { kind: 'set_scheduler', to, quantum: Number(quantum) };
    }
    case 'set_replacement':
      return isMember(REPLACEMENT_IDS, choice) ? { kind: 'set_replacement', to: choice } : null;
    case 'set_disk_policy':
      return isMember(DISK_IDS, choice) ? { kind: 'set_disk_policy', to: choice } : null;
    case 'set_allocation':
      return isMember(ALLOCATION_IDS, choice) ? { kind: 'set_allocation', to: choice } : null;
    case 'set_deadlock_strategy':
      return isMember(DEADLOCK_STRATEGIES, choice) ? { kind: 'set_deadlock_strategy', to: choice } : null;
    case 'set_pace':
      return isMember(PACES, choice) ? { kind: 'set_pace', to: choice } : null;
    case 'set_rations':
      return isMember(RATIONS, choice) ? { kind: 'set_rations', to: choice } : null;
    case 'set_degree': {
      const to = Number(choice);
      return /^-?\d+$/.test(choice) && Number.isSafeInteger(to) ? { kind: 'set_degree', to } : null;
    }
    case 'syscall':
      return syscallFromChoice(choice);
    case 'use_ability':
      // TODO(astra): WP-19 replays abilities through the RunDirector
      return null;
    case 'interaction':
    case 'terminal':
      return null;
    default:
      return null;
  }
}
