import { asPid } from '../../types';
import type { SyscallName } from '../../types';
import { failure, success } from '../errno';
import type { SyscallHandler } from '../table';

const MAX_PRIORITY = 39;

export const PROCESS_HANDLERS: Readonly<Pick<Record<SyscallName, SyscallHandler>, 'fork' | 'exec' | 'exit' | 'wait' | 'kill' | 'getpid' | 'nice'>> = Object.freeze({
  fork: (_request, state, pcb) => state.fork(pcb),
  exec: (request, state, pcb) => state.exec(pcb, String(request.args[0])),
  exit: (request, state, pcb) => state.exit(pcb, Number(request.args[0])),
  wait: (request, state, pcb) => {
    const arg = request.args[0];
    return state.wait(pcb, typeof arg === 'number' && arg >= 0 ? asPid(arg) : null);
  },
  kill: (request, state, pcb) => {
    const target = state.pcb(asPid(Number(request.args[0])));
    if (target === undefined || target.pid === asPid(0)) return failure('ESRCH', 'process not found');
    if (request.args[1] === 0) return target.state === 'terminated' ? failure('ESRCH', 'process has exited') : success();
    if (target.state === 'zombie' || target.state === 'terminated') return failure('ESRCH', 'process has exited');
    return state.kill(target, target.parent === pcb.pid);
  },
  getpid: (_request, _state, pcb) => success(pcb.pid),
  nice: (request, state, pcb) => {
    const next = Math.min(MAX_PRIORITY, Math.max(0, pcb.priority + Number(request.args[0])));
    state.setPriority(pcb, next);
    return success(next);
  },
});
