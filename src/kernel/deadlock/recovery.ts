import { KernelInvariantError } from '../errors';
import type { Program } from '../process/Program';
import type { ThreadControlBlock } from '../process/threads';
import { asResourceId } from '../types';
import type { DeadlockSnapshotState, Pid, ProcessControlBlock, ResourceId } from '../types';

export type RollbackCheckpoint = DeadlockSnapshotState['payload']['checkpoints'][number];
export type VictimCandidate = Pick<ProcessControlBlock, 'pid' | 'convoyMemberId' | 'priority' | 'totalCpuUsed' | 'heldResources' | 'serviceRemaining'>;

/** Ch. 8.8.1. Every key is deliberate; convoy membership is the first key. */
export function compareVictims(a: VictimCandidate, b: VictimCandidate): number {
  const convoyA = a.convoyMemberId !== null ? 1 : 0;
  const convoyB = b.convoyMemberId !== null ? 1 : 0;
  if (convoyA !== convoyB) return convoyA - convoyB;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.totalCpuUsed !== b.totalCpuUsed) return a.totalCpuUsed - b.totalCpuUsed;
  if (a.heldResources.length !== b.heldResources.length) return b.heldResources.length - a.heldResources.length;
  if (a.serviceRemaining !== b.serviceRemaining) return b.serviceRemaining - a.serviceRemaining;
  return b.pid - a.pid;
}

export function suggestedVictims(cycle: readonly Pid[], lookup: (pid: Pid) => VictimCandidate | undefined): Pid[] {
  const candidates = cycle.map(pid => {
    const process = lookup(pid);
    if (process === undefined) throw new KernelInvariantError(26, `deadlock victim ${pid} is missing`);
    return process;
  });
  return candidates.sort(compareVictims).map(process => process.pid);
}

export function chooseVictim(cycle: readonly Pid[], lookup: (pid: Pid) => VictimCandidate | undefined): Pid {
  const victim = suggestedVictims(cycle, lookup)[0];
  if (victim === undefined) throw new KernelInvariantError(26, 'cannot choose a victim from an empty deadlock set');
  return victim;
}

export interface RollbackEligibility {
  readonly process: Readonly<ProcessControlBlock>;
  readonly threads: readonly Readonly<ThreadControlBlock>[];
  readonly checkpoint: RollbackCheckpoint | undefined;
  readonly program: Program | undefined;
  readonly preemptionCount: number;
  readonly maxPreemptions: number;
  readonly hasSyncOwnership: boolean;
  readonly hasUnrelatedContinuation: boolean;
  readonly preemptible: (resource: ResourceId) => boolean;
  readonly isOwnedResource: (resource: ResourceId) => boolean;
}

/** PC-only rollback cannot undo external effects or another thread's progress. */
export function canRollback(input: RollbackEligibility): boolean {
  const { process, checkpoint, program } = input;
  const threads = input.threads.filter(thread => thread.pid === process.pid && thread.state !== 'terminated');
  const thread = threads[0];
  if (checkpoint === undefined || program === undefined || threads.length !== 1 || thread === undefined
    || checkpoint.pid !== process.pid || checkpoint.tid !== thread.tid || process.state !== 'waiting'
    || input.preemptionCount >= input.maxPreemptions || input.hasSyncOwnership || input.hasUnrelatedContinuation
    || process.heldResources.length === 0 || !process.heldResources.every(resource => input.isOwnedResource(resource) && input.preemptible(resource))
    || !Number.isSafeInteger(checkpoint.programCounter) || checkpoint.programCounter < 0
    || checkpoint.programCounter > thread.programCounter) return false;
  for (let pc = checkpoint.programCounter; pc < thread.programCounter; pc += 1) {
    const instruction = program.at(pc);
    if (instruction.kind === 'compute') continue;
    if (instruction.kind !== 'syscall' || (instruction.call.name !== 'request' && instruction.call.name !== 'release')) return false;
    const args = instruction.call.args;
    if (args.length === 0 || args.length % 2 !== 0) return false;
    for (let index = 0; index < args.length; index += 2) {
      const id = args[index]; const instances = args[index + 1];
      if (typeof id !== 'string' || !input.isOwnedResource(asResourceId(id))
        || typeof instances !== 'number' || !Number.isSafeInteger(instances) || instances < 0) return false;
    }
  }
  return true;
}
