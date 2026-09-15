import type { ProcessVisuals as ProcessContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class ProcessVisuals extends DomainVisuals implements ProcessContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onCreated(e: KernelEventOf<'process.created'>, _c: WorldEventContext): void { this.spawn('page_flare', this.cyan(), 0.42, 1, e.pid as number); }
  onStateChanged(e: KernelEventOf<'process.state_changed'>, _c: WorldEventContext): void { this.state(`process:${e.pid as number}:state`, e.to); }
  onExited(e: KernelEventOf<'process.exited'>, _c: WorldEventContext): void { this.spawn('derezz', this.cyan(), 1.4, 1, e.pid as number); }
  onReaped(e: KernelEventOf<'process.reaped'>, _c: WorldEventContext): void { this.spawn('page_dissolve', this.slate(), 0.26, 1, e.by as number); }
  onStarving(e: KernelEventOf<'process.starving'>, _c: WorldEventContext): void { this.state(`process:${e.pid as number}:starving`, e.waitedTicks); if (e.fatal) this.spawn('denial_ward', this.amber(), 0.4); }
  onThreadCreated(e: KernelEventOf<'thread.created'>, _c: WorldEventContext): void { this.spawn('lock_pulse', this.cyan(), 0.26, 1, e.tid as number); }
  onThreadJoined(e: KernelEventOf<'thread.joined'>, _c: WorldEventContext): void { this.spawn('page_dissolve', this.cyan(), 0.16, 1, e.tid as number); }
}
