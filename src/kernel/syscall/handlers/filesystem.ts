import type { SyscallName } from '../../types';
import type { SyscallHandler } from '../table';

const file: SyscallHandler = (request, state) => state.file(request);

export const FILESYSTEM_HANDLERS: Readonly<Pick<Record<SyscallName, SyscallHandler>, 'open' | 'close' | 'read' | 'write' | 'seek' | 'stat' | 'unlink' | 'mkdir' | 'chmod' | 'sync'>> = Object.freeze({
  open: file, close: file, read: file, write: file, seek: file, stat: file, unlink: file, mkdir: file, chmod: file,
  sync: (_request, state, pcb) => state.syncFiles(pcb),
});
