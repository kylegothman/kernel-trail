import { KernelInvariantError } from '../errors';
import type { Pid, ResourceId } from '../types';
import { at, validateMatrix, validateMatrixAxes } from './bankers';

export interface DetectionState {
  readonly processes: readonly Pid[];
  readonly resources: readonly ResourceId[];
  readonly available: readonly number[];
  readonly allocation: readonly (readonly number[])[];
  /** Current outstanding requests, never maximum claims or remaining Need. */
  readonly request: readonly (readonly number[])[];
}

export interface DetectionResult {
  readonly deadlocked: readonly Pid[];
  readonly finishOrder: readonly Pid[];
  readonly finished: readonly boolean[];
  readonly work: readonly number[];
  readonly trace: readonly { readonly candidate: Pid; readonly work: readonly number[] }[];
}

/** Ch. 8.7.2. A process holding no instances is finished before the first scan. */
export function detectMultipleInstances(state: DetectionState): DetectionResult {
  validateMatrixAxes(state.processes, state.resources, state.available);
  validateMatrix(state.allocation, state.processes.length, state.resources.length, 'Allocation');
  validateMatrix(state.request, state.processes.length, state.resources.length, 'Request');
  const work = [...state.available];
  const finished = state.processes.map((_, i) => state.resources.every((__, j) => at(state.allocation, i, j) === 0));
  const finishOrder: Pid[] = [];
  const trace: { candidate: Pid; work: readonly number[] }[] = [];
  for (;;) {
    let picked = -1;
    for (let i = 0; i < state.processes.length; i += 1) {
      if (finished[i]) continue;
      let fits = true;
      for (let j = 0; j < state.resources.length; j += 1) {
        if (at(state.request, i, j) > at([work], 0, j)) { fits = false; break; }
      }
      if (fits) { picked = i; break; }
    }
    if (picked === -1) break;
    const pid = state.processes[picked];
    if (pid === undefined) throw new KernelInvariantError(5, 'Detection selected a missing process.');
    for (let j = 0; j < state.resources.length; j += 1) {
      work[j] = at([work], 0, j) + at(state.allocation, picked, j);
      if (!Number.isSafeInteger(at([work], 0, j))) {
        throw new KernelInvariantError(5, 'Detection Work exceeds the safe integer range.');
      }
    }
    finished[picked] = true;
    finishOrder.push(pid);
    trace.push({ candidate: pid, work: [...work] });
  }
  return {
    deadlocked: state.processes.filter((_, i) => !finished[i]),
    finishOrder, finished, work, trace,
  };
}
