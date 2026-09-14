import { KernelInvariantError } from '../errors';
import type { BankersState, Pid, SafetyCheckResult, SafetyTraceStep } from '../types';

/** An absent matrix cell is a broken resource state, never an implicit zero. */
export function at(matrix: readonly (readonly number[])[], i: number, j: number): number {
  const value = matrix[i]?.[j];
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || value === undefined) {
    throw new KernelInvariantError(5, `Resource matrix index (${i}, ${j}) is out of range.`);
  }
  return value;
}

function count(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KernelInvariantError(5, `${label} must be a nonnegative safe integer.`);
  }
}

export function validateMatrix(
  matrix: readonly (readonly number[])[], rows: number, columns: number, label: string,
): void {
  if (matrix.length !== rows) throw new KernelInvariantError(5, `${label} has the wrong row count.`);
  for (let i = 0; i < rows; i += 1) {
    if (matrix[i]?.length !== columns) {
      throw new KernelInvariantError(5, `${label} has the wrong column count in row ${i}.`);
    }
    for (let j = 0; j < columns; j += 1) count(at(matrix, i, j), `${label}[${i}][${j}]`);
  }
}

/** Need is a projection of the current matrices, not an independently mutable matrix. */
export function needMatrix(
  max: readonly (readonly number[])[], allocation: readonly (readonly number[])[],
): number[][] {
  const columns = max[0]?.length ?? 0;
  validateMatrix(max, max.length, columns, 'Max');
  validateMatrix(allocation, max.length, columns, 'Allocation');
  return max.map((row, i) => row.map((_, j) => {
    const need = at(max, i, j) - at(allocation, i, j);
    count(need, `Need[${i}][${j}]`);
    return need;
  }));
}

/** Matrix row and column order is part of the deterministic public result. */
export function validateMatrixAxes(
  processes: readonly Pid[], resources: readonly string[], available: readonly number[],
): void {
  for (let i = 0; i < processes.length; i += 1) {
    const pid = processes[i];
    const previous = processes[i - 1];
    if (pid === undefined || !Number.isSafeInteger(pid) || pid < 0 || (previous !== undefined && previous >= pid)) {
      throw new KernelInvariantError(5, 'Resource matrix processes must be unique ascending pids.');
    }
  }
  for (let j = 0; j < resources.length; j += 1) {
    const resource = resources[j];
    const previous = resources[j - 1];
    if (resource === undefined || (previous !== undefined && previous >= resource)) {
      throw new KernelInvariantError(5, 'Resource matrix columns must be unique lexicographic resource ids.');
    }
  }
  if (available.length !== resources.length) {
    throw new KernelInvariantError(5, 'Available has the wrong column count.');
  }
  available.forEach((value, j) => count(value, `Available[${j}]`));
}

function preparedNeed(state: BankersState): number[][] {
  validateMatrixAxes(state.processes, state.resources, state.available);
  validateMatrix(state.max, state.processes.length, state.resources.length, 'Max');
  validateMatrix(state.allocation, state.processes.length, state.resources.length, 'Allocation');
  return needMatrix(state.max, state.allocation);
}

function unsafe(work: readonly number[], stuck: readonly Pid[], trace: SafetyTraceStep[]): SafetyCheckResult {
  trace.push({
    work: [...work], candidate: null, admitted: false,
    explanation: `No remaining process has Need <= Work [${work.join(', ')}]. Stuck: ${stuck.map(pid => 'P' + pid).join(', ')}. State is UNSAFE.`,
  });
  return { safe: false, sequence: null, trace };
}

function scan(state: BankersState, forcedOrder?: readonly Pid[]): SafetyCheckResult {
  const need = preparedNeed(state);
  const work = [...state.available];
  const finish = state.processes.map(() => false);
  const sequence: Pid[] = [];
  const trace: SafetyTraceStep[] = [];
  if (forcedOrder !== undefined && (forcedOrder.length !== state.processes.length ||
    new Set(forcedOrder).size !== forcedOrder.length || forcedOrder.some(pid => !state.processes.includes(pid)))) {
    throw new KernelInvariantError(5, 'Forced safety order must contain every process exactly once.');
  }
  for (;;) {
    let picked = -1;
    for (let i = 0; i < state.processes.length; i += 1) {
      if (finish[i] || (forcedOrder !== undefined && state.processes[i] !== forcedOrder[sequence.length])) continue;
      let fits = true;
      for (let j = 0; j < state.resources.length; j += 1) {
        if (at(need, i, j) > at([work], 0, j)) { fits = false; break; }
      }
      if (fits) { picked = i; break; }
    }
    if (picked === -1) break;
    const pid = state.processes[picked];
    if (pid === undefined) throw new KernelInvariantError(5, 'Safety scan selected a missing process.');
    for (let j = 0; j < state.resources.length; j += 1) {
      work[j] = at([work], 0, j) + at(state.allocation, picked, j);
      count(at([work], 0, j), `Work[${j}]`);
    }
    finish[picked] = true;
    sequence.push(pid);
    trace.push({
      work: [...work], candidate: pid, admitted: true,
      explanation: `Need[P${pid}] fits in Work; assume it finishes and returns its allocation. Work becomes [${work.join(', ')}].`,
    });
  }
  return finish.every(Boolean)
    ? { safe: true, sequence, trace }
    : unsafe(work, state.processes.filter((_, i) => !finish[i]), trace);
}

// Ascending-first-match gives P1, P3, P0, P2, P4 in the worked example.
// The textbook's P1, P3, P4, P0, P2 is also safe, but is not this simulator's admission rule.
export function safetyCheck(state: BankersState): SafetyCheckResult {
  return scan(state);
}

/** Fixture-only demonstration that the textbook's alternative admission order is safe. */
export function safetyCheckWithOrder(state: BankersState, forcedOrder: readonly Pid[]): SafetyCheckResult {
  return scan(state, forcedOrder);
}

export type RequestPreview =
  | { readonly kind: 'safe'; readonly state: BankersState; readonly result: SafetyCheckResult }
  | { readonly kind: 'invalid' | 'unavailable' | 'unsafe'; readonly result: SafetyCheckResult };

function precheck(state: BankersState, explanation: string): SafetyCheckResult {
  return {
    safe: false, sequence: null,
    trace: [{ work: [...state.available], candidate: null, admitted: false, explanation }],
  };
}

/** Preview a whole request vector atomically; none of the caller's arrays are changed. */
export function previewRequest(state: BankersState, pid: Pid, request: readonly number[]): RequestPreview {
  const need = preparedNeed(state);
  const row = state.processes.indexOf(pid);
  if (row < 0 || request.length !== state.resources.length ||
    request.some(value => !Number.isSafeInteger(value) || value < 0) || !request.some(value => value > 0)) {
    return { kind: 'invalid', result: precheck(state, `Request for P${pid} has an invalid process or resource vector.`) };
  }
  for (let j = 0; j < request.length; j += 1) {
    if (at([request], 0, j) > at(need, row, j)) {
      return { kind: 'invalid', result: precheck(state, `Request for P${pid} exceeds its declared maximum claim for ${state.resources[j]}.`) };
    }
  }
  for (let j = 0; j < request.length; j += 1) {
    if (at([request], 0, j) > at([state.available], 0, j)) {
      return { kind: 'unavailable', result: precheck(state, `Request for P${pid} exceeds Available for ${state.resources[j]}; the resources are unavailable.`) };
    }
  }
  const allocation = state.allocation.map((values, i) => values.map((_, j) =>
    at(state.allocation, i, j) + (i === row ? at([request], 0, j) : 0)));
  const tentative: BankersState = {
    processes: [...state.processes], resources: [...state.resources],
    available: state.available.map((_, j) => at([state.available], 0, j) - at([request], 0, j)),
    max: state.max.map(values => [...values]), allocation,
    need: needMatrix(state.max, allocation),
  };
  const result = safetyCheck(tentative);
  return result.safe ? { kind: 'safe', state: tentative, result } : { kind: 'unsafe', result };
}
