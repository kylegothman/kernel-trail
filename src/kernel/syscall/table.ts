/**
 * KERNEL TRAIL: the syscall table (sim spec 14.1, 14.3).
 *
 * `KernelState` is the narrow view of the kernel a handler may touch. Every
 * operation on it delegates to the subsystem that owns the logic; a handler is a
 * validated adapter and nothing more. The table is keyed by the frozen
 * SyscallName union, so a missing handler is a compile error.
 */
import type { EmittableEvent } from '../EventBus';
import type {
  AccessRight, AddressSpaceId, DeviceId, DomainId, FrameId, KernelConfig, PageId, Pid, ProcessControlBlock,
  ResourceId, SubsystemId, SyscallName, SyscallRequest, SyscallResult, Tick,
} from '../types';
import type { KernelTuning } from '../config';
import type { ResourceVector } from '../deadlock/resources';
import { PROCESS_HANDLERS } from './handlers/process';
import { MEMORY_HANDLERS } from './handlers/memory';
import { FILESYSTEM_HANDLERS } from './handlers/filesystem';
import { SYNC_HANDLERS } from './handlers/sync';
import { RESOURCE_HANDLERS } from './handlers/resources';
import { DEVICE_HANDLERS } from './handlers/device';

export type SyncOperation = 'sem_wait' | 'sem_post' | 'mutex_lock' | 'mutex_unlock';
export type SyncPrimitiveKind = 'mutex' | 'semaphore' | 'monitor' | 'rwlock' | 'barrier';

/** What the dispatcher and the handlers may reach. Implemented by the kernel as closures over its private state. */
export interface KernelState {
  readonly tick: Tick;
  readonly config: Readonly<KernelConfig>;
  readonly tuning: KernelTuning;
  enabled(subsystem: SubsystemId): boolean;
  pcb(pid: Pid): ProcessControlBlock | undefined;
  parentOf(pid: Pid): Pid | null;
  /** Pages in an address space, the bound for addresses and byte counts (SEC-ARG-1). */
  pageCount(space: AddressSpaceId): number;
  /** The trap gate of sim spec 13.1 rule 2; null when security is disabled. */
  readonly rings: { enter(pid: Pid): number | null; leave(pid: Pid, trap: number | null): void };
  /** The caller's own domain, never the kernel's (sim spec 14.2 step 4). */
  callerDomain(pid: Pid): DomainId;
  /** The ring the caller trapped from; ring 0 holds every control right implicitly (sim spec 14.3, nice and kill). */
  callerRing(pid: Pid): number;
  /** checkAccess of sim spec 13.2, emitting security.access_denied on refusal. Only meaningful with security enabled. */
  checkAccess(domain: DomainId, object: string, right: AccessRight): boolean;
  /** Record the result and emit syscall.invoked, deferring the event while the file system owns the call. */
  record(pid: Pid, request: SyscallRequest, result: SyscallResult): void;
  emit(event: EmittableEvent): void;

  fork(pcb: ProcessControlBlock): SyscallResult;
  exec(pcb: ProcessControlBlock, program: string): SyscallResult;
  exit(pcb: ProcessControlBlock, code: number): SyscallResult;
  wait(pcb: ProcessControlBlock, child: Pid | null): SyscallResult;
  kill(target: ProcessControlBlock, byParent: boolean): SyscallResult;
  setPriority(pcb: ProcessControlBlock, priority: number): void;

  regionExists(id: ResourceId): boolean;
  mapRegion(pid: Pid, id: ResourceId, writable: boolean): SyscallResult;
  unmapRange(pid: Pid, firstPage: PageId, pages: number): SyscallResult;
  /** Anonymous growth; returns the first new page, or null when the space is exhausted. */
  growAddressSpace(pcb: ProcessControlBlock, pages: number): PageId | null;
  /** Anonymous shrink from the tail, releasing frames through the copy-on-write rule. */
  shrinkAddressSpace(pcb: ProcessControlBlock, pages: number): readonly FrameId[];

  file(request: SyscallRequest): SyscallResult;
  syncFiles(pcb: ProcessControlBlock): SyscallResult;

  primitiveKind(resource: ResourceId): SyncPrimitiveKind | undefined;
  syncCall(pid: Pid, operation: SyncOperation, resource: ResourceId): SyscallResult;

  resourceExists(id: ResourceId): boolean;
  request(pid: Pid, vector: ResourceVector): SyscallResult;
  release(pid: Pid, vector: ResourceVector): SyscallResult;

  deviceExists(id: DeviceId): boolean;
  ioctl(pcb: ProcessControlBlock, device: DeviceId, command: string, args: readonly (string | number | boolean)[]): SyscallResult;
}

export type SyscallHandler = (request: SyscallRequest, state: KernelState, pcb: ProcessControlBlock) => SyscallResult;

export const SYSCALL_TABLE: Readonly<Record<SyscallName, SyscallHandler>> = Object.freeze({
  ...PROCESS_HANDLERS, ...MEMORY_HANDLERS, ...FILESYSTEM_HANDLERS, ...SYNC_HANDLERS, ...RESOURCE_HANDLERS, ...DEVICE_HANDLERS,
});

export const SYSCALL_NAMES: readonly SyscallName[] = Object.freeze(Object.keys(SYSCALL_TABLE) as SyscallName[]);
