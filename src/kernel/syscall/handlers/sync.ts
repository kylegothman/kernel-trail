import { asResourceId } from '../../types';
import type { SyscallName } from '../../types';
import { failure } from '../errno';
import type { SyncOperation, SyscallHandler } from '../table';

function primitive(operation: SyncOperation): SyscallHandler {
  const expected = operation === 'sem_wait' || operation === 'sem_post' ? 'semaphore' : 'mutex';
  return (request, state, pcb) => {
    const resource = asResourceId(String(request.args[0]));
    if (state.primitiveKind(resource) !== expected) return failure('EINVAL', `${resource} is not a ${expected}`);
    return state.syncCall(pcb.pid, operation, resource);
  };
}

export const SYNC_HANDLERS: Readonly<Pick<Record<SyscallName, SyscallHandler>, 'sem_wait' | 'sem_post' | 'mutex_lock' | 'mutex_unlock'>> = Object.freeze({
  sem_wait: primitive('sem_wait'), sem_post: primitive('sem_post'), mutex_lock: primitive('mutex_lock'), mutex_unlock: primitive('mutex_unlock'),
});
