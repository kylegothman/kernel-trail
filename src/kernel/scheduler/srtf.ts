import type { SchedulerContext, SchedulingDecision } from '../types';
import { SjfScheduler, sjfCmp } from './sjf';

export const srtfCmp = sjfCmp;

export class SrtfScheduler extends SjfScheduler {
  override readonly id = 'srtf';
  override readonly displayName = 'Shortest Remaining Time First';
  override readonly isPreemptive = true;

  override onTick(ctx: SchedulerContext): SchedulingDecision {
    this.prepare(ctx);
    const running = this.current(ctx);
    const next = this.nextReady(ctx);
    if (running !== undefined && (next === undefined || this.key(next) >= this.key(running))) {
      return this.decision(ctx, running.pid, 'no ready process has strictly shorter remaining service');
    }
    const reason = next === undefined ? 'no process is ready'
      : running === undefined ? `shortest remaining service, ${this.key(next)} ticks`
        : `shortest remaining service, ${this.key(next)} ticks against ${this.key(running)}`;
    // The kernel's running-to-ready callback requeues the outgoing process once.
    return this.dispatch(ctx, next, reason);
  }
}
