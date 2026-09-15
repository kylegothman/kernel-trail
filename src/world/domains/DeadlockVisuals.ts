import type { DeadlockVisuals as DeadlockContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class DeadlockVisuals extends DomainVisuals implements DeadlockContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onRequested(e: KernelEventOf<'resource.requested'>, _c: WorldEventContext): void { this.spawn('trap_arc', this.amber(), 0.26, 1, e.instances); }
  onGranted(e: KernelEventOf<'resource.granted'>, _c: WorldEventContext): void { this.spawn('seek_arc', this.cyan(), 0.16, 1, e.instances); }
  onDenied(e: KernelEventOf<'resource.denied'>, _c: WorldEventContext): void { this.spawn('denial_ward', this.amber(), 0.18, 1, e.reason === 'unsafe' ? 1 : 0); }
  onBankers(e: KernelEventOf<'bankers.evaluated'>, _c: WorldEventContext): void {
    this.state('bankers:rows', e.result.trace.length);
    e.result.trace.forEach((step, index) => { this.state(`bankers:row:${index}`, step.admitted ? 1 : 0); this.label(step.explanation); });
    if (!e.result.safe) this.state('bankers:unsafe', 1);
  }
  onDetected(e: KernelEventOf<'deadlock.detected'>, _c: WorldEventContext): void {
    this.spawn('deadlock_ring', this.amber(), 1, 1, e.report.cycle.length, e.report.conditions.length);
    for (const condition of e.report.conditions) this.label(condition);
  }
  onResolved(e: KernelEventOf<'deadlock.resolved'>, _c: WorldEventContext): void { this.spawn(e.method === 'terminate' ? 'derezz' : 'seek_arc', this.amber(), 0.52, 1, e.victims.length); }
}
