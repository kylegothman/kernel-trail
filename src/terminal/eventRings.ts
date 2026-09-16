/**
 * KERNEL TRAIL: the shell's bounded event rings (WP-15 scope correction T5 and T10).
 *
 * `KernelEventStream` has no history buffer and `lastFrame` is the live array,
 * so the shell subscribes when it is created and keeps its own bounded copies
 * of the events its commands read back: the syscall log for `trace`, the
 * dispatch segments for `gantt`, races, acquisitions, disk service, interrupts,
 * security decisions and page faults. Every ring drops its oldest entry once it
 * is full, so a long run costs a fixed amount of memory.
 */
import type { Kernel, KernelEventOf, Pid, Unsubscribe } from '@kernel/types';

export class Ring<T> {
  private readonly items: T[] = [];
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('ring capacity must be a positive integer');
  }
  get length(): number { return this.items.length; }
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  /** Oldest first. A copy, so a command may filter without disturbing the ring. */
  toArray(): readonly T[] { return [...this.items]; }
  clear(): void { this.items.length = 0; }
}

/** One dispatch interval in the golden format of tests/kernel/scheduler/workloadRunner.ts. */
export interface GanttSegment { readonly name: string; readonly pid: Pid; readonly start: number; readonly end: number }

export interface ModeSwitch {
  readonly tick: number;
  readonly cause: 'trap' | 'interrupt' | 'return';
  readonly pid: Pid | null;
  readonly detail: string;
}

export interface EventRings {
  readonly syscalls: Ring<KernelEventOf<'syscall.invoked'>>;
  readonly races: Ring<KernelEventOf<'sync.race_detected'>>;
  readonly acquisitions: Ring<KernelEventOf<'sync.acquired'>>;
  readonly releases: Ring<KernelEventOf<'sync.released'>>;
  readonly diskQueued: Ring<KernelEventOf<'disk.queued'>>;
  readonly diskServed: Ring<KernelEventOf<'disk.served'>>;
  readonly interrupts: Ring<KernelEventOf<'io.interrupt'>>;
  readonly denials: Ring<KernelEventOf<'security.access_denied'>>;
  readonly escalations: Ring<KernelEventOf<'security.escalation_attempt'>>;
  readonly faults: Ring<KernelEventOf<'memory.page_fault'>>;
  readonly modeSwitches: Ring<ModeSwitch>;
  /** Closed dispatch segments followed by the open one, if a user process holds the CPU. */
  segments(): readonly GanttSegment[];
  dispose(): void;
}

export const DEFAULT_RING_CAPACITY = 2000;
export const GANTT_SEGMENT_CAPACITY = 512;

/** Render segments exactly as the Gantt goldens do: `P1[0-24] P2[24-27]`. */
export function renderGantt(segments: readonly GanttSegment[]): string {
  return segments.map(segment => `${segment.name}[${segment.start}-${segment.end}]`).join(' ');
}

/**
 * Subscribe every ring. The segment builder follows the workload runner to the
 * tick: a switch at tick t closes the previous interval at t - 1 and opens the
 * next there, which lines the kernel's first decision at tick 1 up with the
 * textbook's intervals starting at 0; an exit closes the open interval at its
 * own tick. Idle and init never appear as segments.
 */
export function createEventRings(kernel: Kernel, capacity = DEFAULT_RING_CAPACITY): EventRings {
  const closed = new Ring<GanttSegment>(GANTT_SEGMENT_CAPACITY);
  let active: { readonly pid: Pid; readonly name: string; readonly start: number } | null = null;
  const finish = (end: number): void => {
    if (active === null) return;
    closed.push({ name: active.name, pid: active.pid, start: active.start, end });
    active = null;
  };
  const rings = {
    syscalls: new Ring<KernelEventOf<'syscall.invoked'>>(capacity),
    races: new Ring<KernelEventOf<'sync.race_detected'>>(capacity),
    acquisitions: new Ring<KernelEventOf<'sync.acquired'>>(capacity),
    releases: new Ring<KernelEventOf<'sync.released'>>(capacity),
    diskQueued: new Ring<KernelEventOf<'disk.queued'>>(capacity),
    diskServed: new Ring<KernelEventOf<'disk.served'>>(capacity),
    interrupts: new Ring<KernelEventOf<'io.interrupt'>>(capacity),
    denials: new Ring<KernelEventOf<'security.access_denied'>>(capacity),
    escalations: new Ring<KernelEventOf<'security.escalation_attempt'>>(capacity),
    faults: new Ring<KernelEventOf<'memory.page_fault'>>(capacity),
    modeSwitches: new Ring<ModeSwitch>(capacity),
  };
  const events = kernel.events;
  const subscriptions: Unsubscribe[] = [
    events.on('syscall.invoked', event => {
      rings.syscalls.push(event);
      rings.modeSwitches.push({ tick: event.tick, cause: 'trap', pid: event.request.pid, detail: event.request.name });
    }),
    events.on('sync.race_detected', event => rings.races.push(event)),
    events.on('sync.acquired', event => rings.acquisitions.push(event)),
    events.on('sync.released', event => rings.releases.push(event)),
    events.on('disk.queued', event => rings.diskQueued.push(event)),
    events.on('disk.served', event => rings.diskServed.push(event)),
    events.on('io.interrupt', event => {
      rings.interrupts.push(event);
      rings.modeSwitches.push({ tick: event.tick, cause: 'interrupt', pid: event.pid, detail: event.device });
    }),
    events.on('security.access_denied', event => rings.denials.push(event)),
    events.on('security.escalation_attempt', event => rings.escalations.push(event)),
    events.on('memory.page_fault', event => rings.faults.push(event)),
    events.on('context.switch', event => {
      const start = event.tick - 1;
      finish(start);
      rings.modeSwitches.push({ tick: event.tick, cause: 'return', pid: event.to, detail: event.rationale });
      if (event.to !== null && event.to > 1) active = { pid: event.to, name: kernel.process(event.to)?.name ?? `P${event.to}`, start };
    }),
    events.on('process.exited', event => { if (active?.pid === event.pid) finish(event.tick); }),
  ];
  return {
    ...rings,
    segments: () => active === null ? closed.toArray() : [...closed.toArray(), { name: active.name, pid: active.pid, start: active.start, end: kernel.tick }],
    dispose: () => { for (const unsubscribe of subscriptions) unsubscribe(); },
  };
}
