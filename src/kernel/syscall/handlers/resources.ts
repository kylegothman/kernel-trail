import { asResourceId } from '../../types';
import type { ResourceId, SyscallName, SyscallRequest } from '../../types';
import type { ResourceVector } from '../../deadlock/resources';
import { failure } from '../errno';
import type { SyscallHandler } from '../table';

function vectorOf(request: SyscallRequest): ResourceVector {
  const rows: [ResourceId, number][] = [];
  for (let index = 0; index + 1 < request.args.length; index += 2) rows.push([asResourceId(String(request.args[index])), Number(request.args[index + 1])]);
  return rows;
}

export const RESOURCE_HANDLERS: Readonly<Pick<Record<SyscallName, SyscallHandler>, 'request' | 'release'>> = Object.freeze({
  request: (request, state, pcb) => state.request(pcb.pid, vectorOf(request)),
  release: (request, state, pcb) => {
    const vector = vectorOf(request);
    for (const [id, count] of vector) {
      const held = pcb.heldResources.filter(candidate => candidate === id).length;
      if (held < count) return failure('EPERM', `releasing ${count} of ${id} but holding ${held}`);
    }
    return state.release(pcb.pid, vector);
  },
});
