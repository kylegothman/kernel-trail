import type { IoVisuals as IoContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class IoVisuals extends DomainVisuals implements IoContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onRequest(e: KernelEventOf<'io.request'>, _c: WorldEventContext): void { this.state(`io:${e.device}:mode`, e.mode); }
  onInterrupt(e: KernelEventOf<'io.interrupt'>, _c: WorldEventContext): void { this.spawn('interrupt_spike', this.amber(), 0.12, 1, e.pid as number | null ?? -1); }
  onDma(e: KernelEventOf<'io.dma_transfer'>, _c: WorldEventContext): void { this.spawn('seek_arc', this.cyan(), 0.4, Math.min(1, e.bytes / 16384), e.bytes); }
  onPollWasted(e: KernelEventOf<'io.poll_wasted'>, _c: WorldEventContext): void { this.state(`io:${e.device}:wasted`, e.wastedTicks); }
}
