/**
 * KERNEL TRAIL: syscall dispatch (sim spec 14.1, with the pre-flight rulings D3 and D8).
 *
 * The public entry point executes the call immediately and synchronously,
 * outside the tick loop. A zombie, terminated or unknown caller is refused with
 * ESRCH; any live process may call (WP-02's rule, decision D3). The trap gate
 * is entered before validation and left in a finally block, so a handler that
 * throws cannot leave the caller in ring 0. `syscall.invoked` is recorded for
 * every call, success or failure, through `state.record`.
 */
import type { SyscallRequest, SyscallResult } from '../types';
import { failure } from './errno';
import { SYSCALL_TABLE, type KernelState, type SyscallHandler } from './table';
import { validateArgs } from './validate';

/** `ioctl('tlb_flush')` is the bare alias for `ioctl('kernel', 'tlb_flush')` (decision D8). */
export function normaliseRequest(request: SyscallRequest): SyscallRequest {
  if (request.name === 'ioctl' && request.args.length === 1 && request.args[0] === 'tlb_flush') return { ...request, args: ['kernel', 'tlb_flush'] };
  return request;
}

export function dispatch(request: SyscallRequest, state: KernelState, table: Readonly<Record<SyscallRequest['name'], SyscallHandler>> = SYSCALL_TABLE): SyscallResult {
  const pcb = state.pcb(request.pid);
  if (pcb === undefined || pcb.state === 'zombie' || pcb.state === 'terminated') {
    const result = failure('ESRCH', 'process not found');
    state.record(request.pid, request, result);
    return result;
  }
  const trap = state.rings.enter(pcb.pid);
  try {
    const normalised = normaliseRequest(request);
    const validation = validateArgs(normalised, state, pcb);
    const result = validation ?? table[normalised.name](normalised, state, pcb);
    state.record(pcb.pid, request, result);
    return result;
  } finally {
    state.rings.leave(pcb.pid, trap);
  }
}
