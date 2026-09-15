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
  readonly syscallCount?: number;
}

export interface EventConsumer {
  readonly name: string;
  beginFrame?(): void;
  consume(event: KernelEvent, aggregates?: FrameAggregates): void;
  endFrame?(aggregates: FrameAggregates): void;
}

export type ConsumerSlot = 'world' | 'audio' | 'codex' | 'hud';

export class FrameEventQueue {
  private readonly buffer: KernelEvent[] = [];
  private readonly counts = new Map<KernelEventType, number>();
  private readonly lastOfType = new Map<KernelEventType, KernelEvent>();
  private readonly accessesByPage = new Map<number, number>();
  private faultCount = 0;
  private tlbMissCount = 0;
  private busyWaitTicks = 0;
  private suppressed = 0;
  private syscallCount = 0;
  private readonly slots: Record<ConsumerSlot, EventConsumer | null> = { world: null, audio: null, codex: null, hud: null };
  private readonly disabled = new Set<string>();
  readonly failures: { consumer: string; error: unknown }[] = [];

  constructor(world?: EventConsumer | null) { if (world) this.slots.world = world; }

  push(events: readonly KernelEvent[]): void { for (const event of events) this.buffer.push(event); }
  addWorld(consumer: EventConsumer): void { this.slots.world = consumer; }
  addAudio(consumer: EventConsumer): void { this.slots.audio = consumer; }
  addCodex(consumer: EventConsumer): void { this.slots.codex = consumer; }
  addHud(consumer: EventConsumer): void { this.slots.hud = consumer; }
  register(slot: ConsumerSlot, consumer: EventConsumer): void { this.slots[slot] = consumer; }
  registerWorld(consumer: EventConsumer): void { this.addWorld(consumer); }
  registerAudio(consumer: EventConsumer): void { this.addAudio(consumer); }
  registerCodex(consumer: EventConsumer): void { this.addCodex(consumer); }
  registerHud(consumer: EventConsumer): void { this.addHud(consumer); }

  drain(dispatch?: (events: readonly KernelEvent[], aggregates?: FrameAggregates) => void): FrameAggregates {
    this.counts.clear();
    this.lastOfType.clear();
    this.accessesByPage.clear();
    this.faultCount = 0;
    this.tlbMissCount = 0;
    this.busyWaitTicks = 0;
    this.suppressed = 0;
    this.syscallCount = 0;
    const survivors: KernelEvent[] = [];

    for (const event of this.buffer) {
      const seen = (this.counts.get(event.type) ?? 0) + 1;
      this.counts.set(event.type, seen);
      if (event.type === 'memory.access') {
        const page = event.page as unknown as number;
        this.accessesByPage.set(page, (this.accessesByPage.get(page) ?? 0) + 1);
      } else if (event.type === 'memory.page_fault') this.faultCount += 1;
      else if (event.type === 'tlb.miss') this.tlbMissCount += 1;
      else if (event.type === 'sync.busy_wait') this.busyWaitTicks += event.spunTicks;
      else if (event.type === 'syscall.invoked') this.syscallCount += 1;

      const rule = COALESCE[event.type] ?? { kind: 'all' as const };
      if (rule.kind === 'all') survivors.push(event);
      else if (rule.kind === 'aggregate') this.suppressed += 1;
      else if (rule.kind === 'last') {
        if (this.lastOfType.has(event.type)) this.suppressed += 1;
        this.lastOfType.set(event.type, event);
      }
      else if (seen <= rule.n) survivors.push(event);
      else this.suppressed += 1;
    }
    for (const event of this.lastOfType.values()) survivors.push(event);
    survivors.sort((a, b) => a.seq - b.seq);
    const aggregates: FrameAggregates = { accessesByPage: this.accessesByPage, faultCount: this.faultCount, tlbMissCount: this.tlbMissCount, busyWaitTicks: this.busyWaitTicks, suppressed: this.suppressed, syscallCount: this.syscallCount };
    if (dispatch) dispatch(survivors, aggregates);
    this.dispatchConsumers(survivors, aggregates);
    this.buffer.length = 0;
    return aggregates;
  }

  peekRaw(): readonly KernelEvent[] { return this.buffer; }
  disable(name: string): void { this.disabled.add(name); }
  enable(name: string): void { this.disabled.delete(name); }

  private dispatchConsumers(events: readonly KernelEvent[], aggregates: FrameAggregates): void {
    for (const slot of ['world', 'audio', 'codex', 'hud'] as const) {
      const consumer = this.slots[slot];
      if (!consumer || this.disabled.has(consumer.name)) continue;
      try {
        consumer.beginFrame?.();
        for (const event of events) consumer.consume(event, aggregates);
        consumer.endFrame?.(aggregates);
      } catch (error) {
        this.failures.push({ consumer: consumer.name, error });
        this.disabled.add(consumer.name);
      }
    }
  }
}
