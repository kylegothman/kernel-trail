/**
 * KERNEL TRAIL: the host the terminal shell runs against (WP-15 scope correction T1 and T4).
 *
 * Architecture 1.3 gives `terminal` a type-only import of `kernel` and forbids
 * `game` from importing `terminal` at all, so the interfaces both sides share
 * are declared here in the game layer, which may import kernel values, and
 * src/terminal/host.ts and src/terminal/commandSink.ts re-export them.
 * `createTerminalHost` is the one place kernel runtime values cross into the
 * shell: the syscall specs, the errno substitutions, the four policy registries,
 * and read accessors bound to the live kernel. Every write the terminal makes
 * goes through the `CommandSink`, which WP-17's CommandBus implements, so a
 * decision is recorded before any mutator runs.
 */
import { ALLOCATORS, CALL_SPECS, DISK_POLICIES, ERRNO_SUBSTITUTIONS, REPLACEMENT_POLICIES, SCHEDULERS, SYSCALL_NAMES, usage } from '@kernel/index';
import type { KernelImpl } from '@kernel/Kernel';
import type { DeadlockStrategy } from '@kernel/deadlock/DeadlockSubsystem';
import type { InvariantView } from '@kernel/invariants';
import type { CallSpec } from '@kernel/syscall/validate';
import type { ErrnoSubstitution } from '@kernel/syscall/errno';
import type {
  AllocationStrategy, BankersState, DiskSchedulingId, FsSnapshotState, IoSnapshotBuffer, IpcSnapshot, Kernel,
  PageReplacementId, Pid, SchedulerId, SchedulerParams, SecuritySnapshotState, StorageRaidSnapshot, SyscallName,
  SyscallRequest, SyscallResult,
} from '@kernel/types';
import type { Pace, Rations, RunState } from './types';

/** Every write the terminal can ask for. The sink records the decision, then calls the mutator. */
export type TerminalCommandRequest =
  | { readonly kind: 'set_scheduler'; readonly id: SchedulerId; readonly params?: Partial<SchedulerParams> }
  | { readonly kind: 'set_replacement'; readonly id: PageReplacementId }
  | { readonly kind: 'set_disk'; readonly id: DiskSchedulingId }
  | { readonly kind: 'set_allocation'; readonly strategy: AllocationStrategy }
  | { readonly kind: 'set_pace'; readonly pace: Pace }
  | { readonly kind: 'set_rations'; readonly rations: Rations }
  | { readonly kind: 'set_degree'; readonly degree: number }
  | { readonly kind: 'set_deadlock_strategy'; readonly strategy: DeadlockStrategy }
  | { readonly kind: 'syscall'; readonly request: SyscallRequest };

/** `ok: true` means the sink accepted and applied the request; a syscall's own errno rides in `syscall`. `ok: false` means the sink refused. */
export type SinkResult =
  | { readonly ok: true; readonly syscall?: SyscallResult }
  | { readonly ok: false; readonly message: string };

export interface CommandSink {
  dispatch(request: TerminalCommandRequest, origin: { readonly source: 'terminal'; readonly line: string }): SinkResult;
}

export interface TerminalHost {
  /** The frozen read interface and nothing more; commands never see a subsystem object. */
  readonly kernel: Kernel;
  /** `kernel.invariantState()`, fresh on every call. */
  view(): InvariantView;
  pollTicks(pid: Pid): number;
  spinTicks(pid: Pid): number;
  readonly specs: {
    readonly names: readonly SyscallName[];
    readonly calls: Readonly<Record<SyscallName, CallSpec>>;
    usage(name: SyscallName): string;
    readonly substitutions: readonly ErrnoSubstitution[];
    readonly schedulers: readonly SchedulerId[];
    readonly replacementPolicies: readonly PageReplacementId[];
    readonly diskPolicies: readonly DiskSchedulingId[];
    readonly allocationStrategies: readonly AllocationStrategy[];
  };
  readonly sink: CommandSink;
  run(): Readonly<RunState>;
  /** Null unless the file system subsystem is enabled. */
  fs(): FsSnapshotState['payload'] | null;
  /** Null unless the security subsystem is enabled. */
  security(): SecuritySnapshotState['payload'] | null;
  ipc(): IpcSnapshot;
  raid(): readonly StorageRaidSnapshot[];
  ioBuffers(): readonly IoSnapshotBuffer[];
  ioCharges(): { readonly issueTicks: number; readonly interruptTicks: number; readonly copyTicks: number; readonly dmaStealTicks: number };
  bankers(): BankersState;
  degree(): number;
  projectedPath(): readonly number[];
}

const keysOf = <K extends string>(record: Readonly<Record<K, unknown>>): readonly K[] => Object.freeze(Object.keys(record) as K[]);

export function createTerminalHost(kernel: KernelImpl, sink: CommandSink, run: () => Readonly<RunState>): TerminalHost {
  const enabled = (id: 'fs' | 'security'): boolean => kernel.config.enabledSubsystems.includes(id);
  return {
    kernel,
    view: () => kernel.invariantState(),
    pollTicks: pid => kernel.ioSubsystem.pollTicks(pid),
    spinTicks: pid => kernel.syncSubsystem.spinTicks(pid),
    specs: {
      names: SYSCALL_NAMES,
      calls: CALL_SPECS,
      usage,
      substitutions: ERRNO_SUBSTITUTIONS,
      schedulers: keysOf(SCHEDULERS),
      replacementPolicies: keysOf(REPLACEMENT_POLICIES),
      diskPolicies: keysOf(DISK_POLICIES),
      allocationStrategies: keysOf(ALLOCATORS),
    },
    sink,
    run,
    fs: () => (enabled('fs') ? kernel.fileSystemSubsystem.state() : null),
    security: () => (enabled('security') ? kernel.securitySubsystem.state() : null),
    ipc: () => kernel.ipc.snapshotContribution(),
    raid: () => [...kernel.storageSubsystem.raid.values()].map(array => array.saveState()),
    ioBuffers: () => kernel.ioSubsystem.saveState().io.payload.buffers,
    ioCharges: () => kernel.ioSubsystem.cpuCharges,
    bankers: () => kernel.deadlockSubsystem.resources.bankersState(),
    degree: () => kernel.memorySubsystem.pager.control.degreeOfMultiprogramming,
    projectedPath: () => kernel.storageSubsystem.projectedPath(),
  };
}
