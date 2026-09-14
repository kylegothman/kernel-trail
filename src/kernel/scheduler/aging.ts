import type { Pid, SchedulerContext } from '../types';

/** Phase 6 visits ready processes in PID order; dispatch resets the boost. */
export function applyAging(ctx: SchedulerContext, readyPids: readonly Pid[]): void {
  if (ctx.params.agingInterval <= 0) return;
  for (const pid of [...readyPids].sort((a, b) => a - b)) {
    const pcb = ctx.process(pid);
    if (pcb?.state !== 'ready' || pcb.readySince === null || pcb.pid <= 1) continue;
    const waited = ctx.tick - pcb.readySince;
    if (waited > 0 && waited % ctx.params.agingInterval === 0) pcb.priority = Math.max(0, pcb.priority - 1);
  }
}
