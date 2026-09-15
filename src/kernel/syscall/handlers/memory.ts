import { asPageId, asResourceId } from '../../types';
import type { SyscallName } from '../../types';
import { failure, success } from '../errno';
import type { SyscallHandler } from '../table';

export const MEMORY_HANDLERS: Readonly<Pick<Record<SyscallName, SyscallHandler>, 'mmap' | 'munmap' | 'brk'>> = Object.freeze({
  mmap: (request, state, pcb) => {
    const pages = Number(request.args[0]); const writable = request.args[1] === true; const region = request.args[2];
    if (typeof region === 'string') return state.mapRegion(pcb.pid, asResourceId(region), writable);
    if (state.pageCount(pcb.addressSpaceId) + pages > state.tuning.maxPagesPerProcess) return failure('ENOMEM', 'address space limit reached');
    const first = state.growAddressSpace(pcb, pages);
    return first === null ? failure('ENOMEM', 'address space exhausted') : success(first);
  },
  munmap: (request, state, pcb) => {
    const first = Number(request.args[0]); const pages = Number(request.args[1]);
    const size = state.pageCount(pcb.addressSpaceId);
    if (first + pages > size) return failure('EINVAL', 'range extends beyond the caller address space');
    const shared = state.unmapRange(pcb.pid, asPageId(first), pages);
    if (shared.ok) return shared;
    // Anonymous pages can only be released from the tail, so the remaining pages stay contiguous.
    if (first + pages !== size) return failure('EINVAL', 'anonymous pages are released from the end of the address space');
    state.shrinkAddressSpace(pcb, pages);
    return success();
  },
  brk: (request, state, pcb) => {
    const target = Number(request.args[0]); const size = state.pageCount(pcb.addressSpaceId);
    if (target > state.tuning.maxPagesPerProcess) return failure('ENOMEM', 'address space limit reached');
    if (target > size) { if (state.growAddressSpace(pcb, target - size) === null) return failure('ENOMEM', 'address space exhausted'); }
    else if (target < size) state.shrinkAddressSpace(pcb, size - target);
    return success(target);
  },
});
