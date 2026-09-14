import { KernelInvariantError } from '../errors';
import type { Pid } from '../types';

/** Bounded FIFO. Only callback batch insertion and arbitrary removal are linear. */
export class CircularQueue {
  private readonly buffer: (Pid | undefined)[];
  private readonly members = new Set<Pid>();
  private readonly visible: Pid[] = [];
  private head = 0;
  private count = 0;
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new KernelInvariantError(13, 'invalid scheduler queue capacity');
    this.buffer = new Array<Pid | undefined>(capacity);
  }
  get size(): number { return this.count; }
  contains(pid: Pid): boolean { return this.members.has(pid); }
  peek(): Pid | null { return this.count === 0 ? null : this.buffer[this.head] ?? null; }
  enqueue(pid: Pid): void {
    if (this.members.has(pid)) return;
    if (this.count === this.capacity) throw new KernelInvariantError(13, 'scheduler queue capacity exceeded');
    this.buffer[(this.head + this.count) % this.capacity] = pid;
    this.members.add(pid); this.count += 1;
  }
  dequeue(): Pid | null {
    if (this.count === 0) return null;
    const pid = this.buffer[this.head]; this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity; this.count -= 1;
    if (pid === undefined) throw new KernelInvariantError(13, 'scheduler queue contains an empty slot');
    this.members.delete(pid); return pid;
  }
  remove(pid: Pid): boolean {
    if (!this.members.has(pid)) return false;
    if (this.peek() === pid) { this.dequeue(); return true; }
    let offset = 0;
    while (this.buffer[(this.head + offset) % this.capacity] !== pid) offset += 1;
    for (let index = offset; index < this.count - 1; index++) {
      this.buffer[(this.head + index) % this.capacity] = this.buffer[(this.head + index + 1) % this.capacity];
    }
    this.buffer[(this.head + this.count - 1) % this.capacity] = undefined;
    this.count -= 1; this.members.delete(pid); return true;
  }
  /** Order only a simultaneous callback batch; ordinary enqueue remains O(1). */
  insertBefore(pid: Pid, before: Pid): void {
    if (this.members.has(pid)) return;
    if (!this.members.has(before)) { this.enqueue(pid); return; }
    if (this.count === this.capacity) throw new KernelInvariantError(13, 'scheduler queue capacity exceeded');
    let offset = 0;
    while (this.buffer[(this.head + offset) % this.capacity] !== before) offset += 1;
    for (let index = this.count; index > offset; index--) {
      this.buffer[(this.head + index) % this.capacity] = this.buffer[(this.head + index - 1) % this.capacity];
    }
    this.buffer[(this.head + offset) % this.capacity] = pid;
    this.members.add(pid); this.count += 1;
  }
  toArray(): readonly Pid[] {
    this.visible.length = this.count;
    for (let index = 0; index < this.count; index++) {
      const pid = this.buffer[(this.head + index) % this.capacity];
      if (pid === undefined) throw new KernelInvariantError(13, 'scheduler queue contains an empty slot');
      this.visible[index] = pid;
    }
    return this.visible;
  }
}
