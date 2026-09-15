import type { MemoryVisuals as MemoryContract } from '../WorldEventRouter';
import type { WorldEventContext } from '../contracts';
import type { KernelEventOf } from '@kernel/types';
import type { FrameAggregates } from '../FrameEventQueue';
import { DomainVisuals, type DomainRuntime } from './BaseVisuals';
export class MemoryVisuals extends DomainVisuals implements MemoryContract {
  constructor(runtime?: DomainRuntime) { super(runtime); }
  onAccess(e: KernelEventOf<'memory.access'>, _c: WorldEventContext): void { this.state(`page:${e.page as number}:dirty`, e.write ? 1 : 0); if (e.hit) this.spawn('page_flare', this.cyan(), 0.09, 1, e.page as number); }
  onPageFault(e: KernelEventOf<'memory.page_fault'>, _c: WorldEventContext): void { this.spawn('fault_mote', this.amber(), e.major ? 0.42 : 0.16, 1, e.page as number, e.major ? 1 : 0); }
  onPageLoaded(e: KernelEventOf<'memory.page_loaded'>, _c: WorldEventContext): void { this.spawn('page_flare', this.cyan(), 0.42, 1, e.page as number, e.frame as number); }
  onPageEvicted(e: KernelEventOf<'memory.page_evicted'>, _c: WorldEventContext): void { this.spawn(e.dirty ? 'page_dissolve' : 'page_flare', e.dirty ? this.amber() : this.cyan(), e.dirty ? 0.58 : 0.36, 1, e.frame as number); }
  onAllocated(e: KernelEventOf<'memory.allocated'>, _c: WorldEventContext): void { this.state(`allocation:${e.pid as number}:frames`, e.frames.length); }
  onAllocationFailed(e: KernelEventOf<'memory.allocation_failed'>, _c: WorldEventContext): void {
    this.spawn('fault_surge', this.amber(), 0.4, 1, e.requested, 0);
    if (e.reason === 'fragmentation') this.spawn('fault_surge', this.amber(), 0.4, 1, e.requested, 1);
  }
  onThrashing(e: KernelEventOf<'memory.thrashing'>, _c: WorldEventContext): void { this.state('memory:thrashing', e.faultRate); this.spawn('fault_surge', this.amber(), 0.4, e.severity === 'critical' ? 1 : 0.6, e.faultRate); }
  onTlbMiss(e: KernelEventOf<'tlb.miss'>, _c: WorldEventContext): void { this.spawn('seek_arc', this.amber(), 0.18, 1, e.page as number, 4, 0.18); }
  endFrame(a: FrameAggregates, _c: WorldEventContext): void {
    for (const [page, count] of a.accessesByPage) this.state(`page:${page}:accesses`, count);
    if (a.faultCount >= 1) this.spawn('fault_surge', this.amber(), 0.4, Math.min(1, a.faultCount / 400), a.faultCount);
  }
}
