import type { SystemVisuals as SystemContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { FrameAggregates } from '../FrameEventQueue';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class SystemVisuals extends DomainVisuals implements SystemContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onSyscall(e: KernelEventOf<'syscall.invoked'>, _c: WorldEventContext): void { this.spawn('trap_arc', e.result.ok ? this.cyan() : this.amber(), 0.2, 1, e.request.pid as number); this.label(e.request.name); }
  onPanic(e: KernelEventOf<'kernel.panic'>, _c: WorldEventContext): void { this.panic(e.message); }
  endFrame(a: FrameAggregates, _c: WorldEventContext): void {
    if ((a.syscallCount ?? 0) > 6) this.spawn('trap_arc', this.cyan(), 0.2, Math.min(1, (a.syscallCount ?? 0) / 200), a.syscallCount);
  }
}
