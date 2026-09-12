import type { DeviceId, PageId, ResourceId, Rng, SyscallRequest, Tid } from '../types';
import { asPageId } from '../types';

export type Instruction =
  | { kind: 'compute' }
  | { kind: 'access'; page: PageId; write: boolean }
  | { kind: 'syscall'; call: SyscallRequest }
  | { kind: 'io'; device: DeviceId }
  | { kind: 'acquire'; resource: ResourceId }
  | { kind: 'release'; resource: ResourceId }
  | { kind: 'thread_create' }
  | { kind: 'thread_join'; tid: Tid };

export interface Program {
  at(index: number): Instruction;
  readonly length: number;
  readonly referenceString: readonly PageId[] | null;
}

/** Kernel-owned spawn input, structurally accepted from a leg without importing it. */
export interface ProgramSpec {
  readonly name: string;
  readonly priority: number;
  readonly burst: number;
  readonly service: number;
  readonly arrival: number;
  readonly pages: number;
  readonly referenceString?: readonly number[];
}

const COMPUTE: Instruction = Object.freeze({ kind: 'compute' });

export function instructionProgram(
  instructions: readonly Instruction[],
  referenceString: readonly PageId[] | null = null,
): Program {
  const saved = instructions.map(instruction => instruction.kind === 'syscall'
    ? Object.freeze({ ...instruction, call: Object.freeze({ ...instruction.call, args: Object.freeze([...instruction.call.args]) }) })
    : Object.freeze({ ...instruction }));
  const references = referenceString === null ? null : Object.freeze([...referenceString]);
  return Object.freeze({
    length: saved.length,
    referenceString: references,
    at: (index: number): Instruction => {
      if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('program index must be a non-negative integer');
      return saved[index] ?? COMPUTE;
    },
  });
}

export function scriptedProgram(referenceString: readonly number[], serviceTicks: number): Program {
  if (!Number.isSafeInteger(serviceTicks) || serviceTicks < 0) throw new RangeError('invalid program service');
  const refs = referenceString.map(page => {
    if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('invalid reference page');
    return asPageId(page);
  });
  const instructions: Instruction[] = Array.from({ length: serviceTicks }, (_, i) => {
    const page = refs[i];
    return page === undefined ? COMPUTE : { kind: 'access', page, write: false };
  });
  return instructionProgram(instructions, refs);
}

// TODO(astra): replace with the sim spec 7.7 locality model in WP-06
export function generatedProgram(rng: Rng, spec: Pick<ProgramSpec, 'pages' | 'service'>): Program {
  if (!Number.isSafeInteger(spec.pages) || spec.pages < 0 || !Number.isSafeInteger(spec.service) || spec.service < 0) {
    throw new RangeError('invalid generated program dimensions');
  }
  const instructions: Instruction[] = [];
  const pages = Array.from({ length: spec.pages }, (_, i) => asPageId(i));
  let inside: PageId[] = [];
  let outside: PageId[] = [];
  for (let i = 0; i < spec.service; i++) {
    if (pages.length === 0) {
      instructions.push(COMPUTE);
      continue;
    }
    if (i % 40 === 0) {
      const shuffled = rng.shuffle([...pages]);
      const size = Math.ceil(spec.pages * 0.4);
      inside = shuffled.slice(0, size);
      outside = shuffled.slice(size);
    }
    const local = rng.chance(0.85);
    const choices = local || outside.length === 0 ? inside : outside;
    instructions.push({ kind: 'access', page: rng.pick(choices), write: false });
  }
  return instructionProgram(instructions);
}
