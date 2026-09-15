import type { SchedulerVisuals as SchedulerContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class SchedulerVisuals extends DomainVisuals implements SchedulerContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onContextSwitch(e: KernelEventOf<'context.switch'>, _c: WorldEventContext): void { this.spawn('trap_arc', this.amber(), 0.18, 1, e.from as number | null ?? -1, e.to as number | null ?? -1); }
  onQuantumExpired(e: KernelEventOf<'quantum.expired'>, _c: WorldEventContext): void { this.spawn('lock_pulse', this.amber(), 0.06, 1, e.level); }
}
