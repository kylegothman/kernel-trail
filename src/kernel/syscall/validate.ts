/**
 * KERNEL TRAIL: argument validation before any handler (sim spec 14.2).
 *
 * Four checks in a fixed order: arity, types, ranges, rights. The per-call
 * specification is data, not code, so 27 validators cannot drift and WP-15's man
 * pages can print each call's usage line from the same table.
 */
import { asPid, asResourceId } from '../types';
import type { AccessRight, DeviceId, FileDescriptor, ProcessControlBlock, SyscallName, SyscallRequest, SyscallResult } from '../types';
import { addressOutOfRange, badFd, failure } from './errno';
import type { KernelState } from './table';

export type ArgRole = 'fd' | 'pid' | 'address' | 'size' | 'path' | 'resource' | 'device' | 'region' | 'primitive' | 'exit_code' | 'signal' | 'delta' | 'whence' | 'program';

export interface ArgSpec {
  readonly name: string;
  /** `scalar` accepts any of the three scalar kinds (command-specific ioctl arguments). */
  readonly kind: 'string' | 'number' | 'boolean' | 'scalar';
  readonly optional?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly role?: ArgRole;
}

export interface CallSpec {
  readonly args: readonly ArgSpec[];
  /** A pattern the argument list may repeat after `args`, for resource vectors and ioctl tails. */
  readonly repeat?: readonly ArgSpec[];
  /** The right the gate itself checks. Null when the owning subsystem checks the object's rights (decision D4). */
  readonly requiredRight: AccessRight | null;
  readonly summary: string;
}

const path: ArgSpec = { name: 'path', kind: 'string', role: 'path' };
const fd: ArgSpec = { name: 'fd', kind: 'number', min: 0, role: 'fd' };
const resource: ArgSpec = { name: 'resource', kind: 'string', role: 'resource' };
const primitive: ArgSpec = { name: 'resource', kind: 'string', role: 'primitive' };

export const CALL_SPECS: Readonly<Record<SyscallName, CallSpec>> = Object.freeze({
  fork: { args: [], requiredRight: null, summary: 'create a child with a copy-on-write address space' },
  exec: { args: [{ name: 'program', kind: 'string', role: 'program' }], requiredRight: null, summary: 'replace the caller program' },
  exit: { args: [{ name: 'code', kind: 'number', min: 0, max: 255, role: 'exit_code' }], requiredRight: null, summary: 'terminate the caller' },
  wait: { args: [{ name: 'pid', kind: 'number', optional: true, min: -1, role: 'pid' }], requiredRight: null, summary: 'reap a child, or block until one exits' },
  kill: { args: [{ name: 'pid', kind: 'number', min: 0, role: 'pid' }, { name: 'signal', kind: 'number', optional: true, min: 0, max: 9, role: 'signal' }], requiredRight: 'control', summary: 'terminate a process, or test that it exists' },
  getpid: { args: [], requiredRight: null, summary: 'return the caller pid' },
  nice: { args: [{ name: 'delta', kind: 'number', min: -20, max: 19, role: 'delta' }], requiredRight: 'control', summary: 'adjust the caller priority' },
  mmap: { args: [{ name: 'pages', kind: 'number', min: 1, role: 'size' }, { name: 'writable', kind: 'boolean' }, { name: 'region', kind: 'string', optional: true, role: 'region' }], requiredRight: null, summary: 'map pages, anonymous or from a shared region' },
  munmap: { args: [{ name: 'firstPage', kind: 'number', min: 0, role: 'address' }, { name: 'pages', kind: 'number', min: 1, role: 'size' }], requiredRight: null, summary: 'unmap a page range' },
  brk: { args: [{ name: 'pages', kind: 'number', min: 0, role: 'size' }], requiredRight: null, summary: 'set the address space size in pages' },
  open: { args: [path, { name: 'mode', kind: 'string' }], requiredRight: null, summary: 'open a path in mode r, w, rw, a or wx' },
  close: { args: [fd], requiredRight: null, summary: 'close a descriptor' },
  read: { args: [fd, { name: 'bytes', kind: 'number', min: 0, role: 'size' }], requiredRight: null, summary: 'read bytes from a descriptor' },
  write: { args: [fd, { name: 'bytes', kind: 'number', min: 0, role: 'size' }], requiredRight: null, summary: 'write bytes to a descriptor' },
  seek: { args: [fd, { name: 'offset', kind: 'number' }, { name: 'whence', kind: 'number', min: 0, max: 2, role: 'whence' }], requiredRight: null, summary: 'move a descriptor offset' },
  stat: { args: [path], requiredRight: null, summary: 'describe an inode as canonical JSON' },
  unlink: { args: [path], requiredRight: null, summary: 'remove a directory entry' },
  mkdir: { args: [path], requiredRight: null, summary: 'create a directory' },
  chmod: { args: [path, { name: 'bits', kind: 'string' }], requiredRight: null, summary: 'replace permissions with three characters over rwx-' },
  sync: { args: [], requiredRight: null, summary: 'flush dirty blocks and the journal' },
  sem_wait: { args: [primitive], requiredRight: null, summary: 'decrement a semaphore, blocking below zero' },
  sem_post: { args: [primitive], requiredRight: null, summary: 'increment a semaphore' },
  mutex_lock: { args: [primitive], requiredRight: null, summary: 'acquire a mutex' },
  mutex_unlock: { args: [primitive], requiredRight: null, summary: 'release a mutex' },
  request: { args: [], repeat: [resource, { name: 'instances', kind: 'number', min: 1 }], requiredRight: null, summary: 'request resource instances as one atomic vector' },
  release: { args: [], repeat: [resource, { name: 'instances', kind: 'number', min: 1 }], requiredRight: null, summary: 'release held resource instances' },
  ioctl: { args: [{ name: 'device', kind: 'string', role: 'device' }, { name: 'command', kind: 'string' }], repeat: [{ name: 'arg', kind: 'scalar' }], requiredRight: null, summary: 'drive a device or the kernel pseudo-device' },
});

/** The usage line WP-15 prints for `man <call>`. */
export function usage(name: SyscallName): string {
  const spec = CALL_SPECS[name];
  const show = (arg: ArgSpec): string => (arg.optional === true ? `[${arg.name}]` : arg.name);
  const parts = [...spec.args.map(show), ...(spec.repeat === undefined ? [] : [`${spec.repeat.map(show).join(' ')}...`])];
  return `${name}(${parts.join(', ')})`;
}

function invalid(message: string): SyscallResult { return failure('EINVAL', message); }

function typeOk(arg: ArgSpec, value: string | number | boolean): boolean {
  if (arg.kind === 'scalar') return true;
  if (typeof value !== arg.kind) return false;
  return typeof value !== 'number' || Number.isFinite(value);
}

/**
 * Validate in the order of sim spec 14.2. Returns null when the call may proceed,
 * otherwise the failure the dispatcher records and returns.
 */
export function validateArgs(request: SyscallRequest, state: KernelState, pcb: ProcessControlBlock): SyscallResult | null {
  const spec = CALL_SPECS[request.name];
  const args = request.args;
  const required = spec.args.filter(arg => arg.optional !== true).length;
  // 1. Arity.
  if (args.length < required) return invalid(`${request.name} expects at least ${required} argument(s), received ${args.length}`);
  if (spec.repeat === undefined) {
    if (args.length > spec.args.length) return invalid(`${request.name} expects at most ${spec.args.length} argument(s), received ${args.length}`);
  } else {
    const tail = args.length - spec.args.length;
    if (tail % spec.repeat.length !== 0) return invalid(`${request.name} expects ${spec.repeat.map(arg => arg.name).join(', ')} groups after its fixed arguments`);
    if (request.name === 'request' || request.name === 'release') { if (tail === 0) return invalid(`${request.name} expects at least one resource and count`); }
  }
  const specAt = (index: number): ArgSpec | undefined => {
    if (index < spec.args.length) return spec.args[index];
    if (spec.repeat === undefined) return undefined;
    return spec.repeat[(index - spec.args.length) % spec.repeat.length];
  };
  // 2. Types.
  for (let index = 0; index < args.length; index++) {
    const arg = specAt(index); const value = args[index];
    if (arg === undefined || value === undefined) return invalid(`${request.name} argument ${index} is unexpected`);
    if (!typeOk(arg, value)) return invalid(`${request.name} argument ${arg.name} must be a ${arg.kind}`);
  }
  // 3. Ranges: integer bounds first, then address bounds, then the named objects.
  // Address bounds precede object lookups so a huge length is refused with the
  // "address out of range: " prefix before a descriptor is even consulted (SEC-ARG-1).
  for (let index = 0; index < args.length; index++) {
    const arg = specAt(index); const value = args[index];
    if (arg === undefined || value === undefined || typeof value !== 'number' || arg.kind !== 'number') continue;
    if (!Number.isSafeInteger(value)) return invalid(`${request.name} argument ${arg.name} must be an integer`);
    if (arg.min !== undefined && value < arg.min) return arg.role === 'size' && value < 0 ? invalid(`${request.name} argument ${arg.name} must not be negative`) : invalid(`${request.name} argument ${arg.name} must be >= ${arg.min}`);
    if (arg.max !== undefined && value > arg.max) return invalid(`${request.name} argument ${arg.name} must be <= ${arg.max}`);
  }
  for (const addresses of [true, false]) {
    for (let index = 0; index < args.length; index++) {
      const arg = specAt(index); const value = args[index];
      if (arg === undefined || value === undefined) continue;
      if ((arg.role === 'address' || arg.role === 'size') !== addresses) continue;
      const range = checkRole(request, arg, value, state, pcb);
      if (range !== null) return range;
    }
  }
  // 4. Rights, with the caller's domain and never the kernel's.
  return checkRights(request, state, pcb);
}

function checkRole(request: SyscallRequest, arg: ArgSpec, value: string | number | boolean, state: KernelState, pcb: ProcessControlBlock): SyscallResult | null {
  switch (arg.role) {
    case 'fd':
      return typeof value === 'number' && pcb.openFiles.includes(value as FileDescriptor) ? null : badFd(typeof value === 'number' ? value : -1);
    case 'pid': {
      if (typeof value !== 'number' || value === -1) return null;
      return state.pcb(asPid(value)) === undefined ? failure('ESRCH', `no such process ${value}`) : null;
    }
    case 'address': {
      if (typeof value !== 'number') return null;
      return value < state.pageCount(pcb.addressSpaceId) ? null : addressOutOfRange(`page ${value} is outside the caller address space`);
    }
    case 'size': {
      if (typeof value !== 'number') return null;
      if (request.name === 'read' || request.name === 'write') {
        const ceiling = state.pageCount(pcb.addressSpaceId) * state.config.pageSize;
        return value <= ceiling ? null : addressOutOfRange('byte count exceeds the caller address space');
      }
      return null;
    }
    case 'region':
      return typeof value === 'string' && !state.regionExists(asResourceId(value)) ? failure('ENOENT', `no such shared region ${value}`) : null;
    case 'primitive':
      return typeof value === 'string' && state.primitiveKind(asResourceId(value)) === undefined ? failure('ENOENT', `no such synchronisation primitive ${value}`) : null;
    case 'resource':
      return typeof value === 'string' && !state.resourceExists(asResourceId(value)) ? failure('ENOENT', `no such resource ${value}`) : null;
    case 'device':
      return typeof value === 'string' && value !== 'kernel' && !state.deviceExists(value as DeviceId) ? failure('ENOENT', `no such device ${value}`) : null;
    case 'signal':
      return value === 0 || value === 9 ? null : invalid(`signal ${String(value)} is not modelled; use 0 or 9`);
    case 'program':
      return typeof value === 'string' && value.length > 0 ? null : invalid('exec requires a program name');
    default:
      return null;
  }
}

function checkRights(request: SyscallRequest, state: KernelState, pcb: ProcessControlBlock): SyscallResult | null {
  if (!state.enabled('security') || state.callerRing(pcb.pid) === 0) return null;
  const domain = state.callerDomain(pcb.pid);
  if (request.name === 'kill') {
    const target = request.args[0];
    if (typeof target !== 'number') return null;
    const targetPid = asPid(target);
    if (targetPid === pcb.pid || state.parentOf(targetPid) === pcb.pid) return null;
    return state.checkAccess(domain, `process:${target}`, 'control') ? null : failure('EPERM', `no control right on process:${target}`);
  }
  if (request.name === 'nice') {
    const delta = request.args[0];
    if (typeof delta !== 'number' || delta >= 0) return null;
    return state.checkAccess(domain, `process:${pcb.pid}`, 'control') ? null : failure('EPERM', 'raising priority needs the control right on the caller');
  }
  return null;
}
