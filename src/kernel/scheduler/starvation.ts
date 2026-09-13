import type { EmittableEvent } from '../EventBus';
import type { SchedulerHooks } from '../Kernel';
import type { ProcessControlBlock, SchedulerContext, SchedulerPolicy } from '../types';
import { SchedulerBase } from './SchedulerBase';

export interface StarvationEffects {
  emit(event: EmittableEvent): void;
  /** Perform lifecycle transition T8 with terminationReason set to starvation. */
  terminate(pcb: ProcessControlBlock): void;
}

/** Phase 6 runs before the scheduler decision and reads continuous ready time. */
export function ageAndDetectStarvation(
  ctx: SchedulerContext,
  policy: SchedulerPolicy,
  effects: StarvationEffects,
): void {
  if (policy instanceof SchedulerBase) policy.age(ctx);

  // Copy before terminating, since lifecycle cleanup can remove queue members.
  const ready = [...ctx.readyQueue].sort((a, b) => a - b);
  for (const pid of ready) {
    const pcb = ctx.process(pid);
    if (pcb === undefined || pcb.state !== 'ready' || pcb.readySince === null) continue;

    const waited = ctx.tick - pcb.readySince;
    const multiplier = pcb.convoyMemberId === 'sable' ? 3 : 1;
    const warningThreshold = ctx.params.starvationThreshold * multiplier;
    const fatalThreshold = ctx.params.starvationFatalThreshold * multiplier;

    if (waited === warningThreshold) {
      effects.emit({ type: 'process.starving', pid, waitedTicks: waited, fatal: false });
    }
    if (waited >= fatalThreshold) {
      effects.emit({ type: 'process.starving', pid, waitedTicks: waited, fatal: true });
      effects.terminate(pcb);
    }
  }
}

/** Resolve the active policy each tick so mid-run swaps also change aging hooks. */
export function createSchedulerHooks(
  policy: () => SchedulerPolicy,
  effects: StarvationEffects,
): SchedulerHooks {
  return { ageAndDetectStarvation: ctx => ageAndDetectStarvation(ctx, policy(), effects) };
}
