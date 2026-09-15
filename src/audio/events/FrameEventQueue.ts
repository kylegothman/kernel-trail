/**
 * The per-frame queue, a local copy of architecture 3.4 with the same
 * `COALESCE` table, so the audio consumer sees exactly the coalesced stream
 * the world will see.
 *
 * TODO(astra): WP-14 supplies FrameEventQueue; switch the import to
 * `@world/FrameEventQueue` at the registration site in AudioEngine.ts and
 * delete this file once its tests pass against the shared table.
 */
import type { KernelEvent, KernelEventType } from '@kernel/types';

export type CoalesceRule =
  | { readonly kind: 'all' }
  | { readonly kind: 'last' }
  | { readonly kind: 'sample'; readonly n: number }
  | { readonly kind: 'aggregate' };

export const COALESCE: Partial<Record<KernelEventType, CoalesceRule>> = {
  'memory.access': { kind: 'aggregate' },
  'memory.page_fault': { kind: 'sample', n: 12 },
  'tlb.miss': { kind: 'sample', n: 8 },
  'disk.seek': { kind: 'last' },
  'io.poll_wasted': { kind: 'last' },
  'sync.busy_wait': { kind: 'sample', n: 4 },
  'syscall.invoked': { kind: 'sample', n: 6 },
};

export interface FrameAggregates {
  readonly accessesByPage: Map<number, number>;
  readonly faultCount: number;
  readonly tlbMissCount: number;
  readonly busyWaitTicks: number;
  readonly suppressed: number;
}

const ALL: CoalesceRule = { kind: 'all' };

export class FrameEventQueue {
  private readonly buffer: KernelEvent[] = [];
  private readonly counts = new Map<KernelEventType, number>();
  private readonly lastOfType = new Map<KernelEventType, KernelEvent>();
  private readonly accessesByPage = new Map<number, number>();
  private readonly survivors: KernelEvent[] = [];
  private faultCount = 0;
  private tlbMissCount = 0;
  private busyWaitTicks = 0;
  private suppressed = 0;

  push(events: readonly KernelEvent[]): void {
    for (const e of events) this.buffer.push(e);
  }

  get pending(): number {
    return this.buffer.length;
  }

  drain(dispatch: (events: readonly KernelEvent[]) => void): FrameAggregates {
    this.counts.clear();
    this.lastOfType.clear();
    this.accessesByPage.clear();
    this.faultCount = 0;
    this.tlbMissCount = 0;
    this.busyWaitTicks = 0;
    this.suppressed = 0;
    const survivors = this.survivors;
    survivors.length = 0;

    for (const e of this.buffer) {
      const seen = (this.counts.get(e.type) ?? 0) + 1;
      this.counts.set(e.type, seen);
      if (e.type === 'memory.access') {
        const page = e.page as unknown as number;
        this.accessesByPage.set(page, (this.accessesByPage.get(page) ?? 0) + 1);
      } else if (e.type === 'memory.page_fault') {
        this.faultCount += 1;
      } else if (e.type === 'tlb.miss') {
        this.tlbMissCount += 1;
      } else if (e.type === 'sync.busy_wait') {
        this.busyWaitTicks += e.spunTicks;
      }
      const rule = COALESCE[e.type] ?? ALL;
      switch (rule.kind) {
        case 'all':
          survivors.push(e);
          break;
        case 'aggregate':
          this.suppressed += 1;
          break;
        case 'last':
          this.lastOfType.set(e.type, e);
          break;
        case 'sample':
          if (seen <= rule.n) survivors.push(e);
          else this.suppressed += 1;
          break;
        default:
          break;
      }
    }
    for (const e of this.lastOfType.values()) survivors.push(e);
    survivors.sort((a, b) => a.seq - b.seq);
    dispatch(survivors);
    this.buffer.length = 0;
    return {
      accessesByPage: this.accessesByPage,
      faultCount: this.faultCount,
      tlbMissCount: this.tlbMissCount,
      busyWaitTicks: this.busyWaitTicks,
      suppressed: this.suppressed,
    };
  }

  peekRaw(): readonly KernelEvent[] {
    return this.buffer;
  }
}
