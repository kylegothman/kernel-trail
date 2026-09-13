import { KernelInvariantError } from '../errors';
import type { Pid, ProcessControlBlock } from '../types';

/** A process heap whose cached public view is in dispatch order. */
export class MinHeap {
  private readonly heap: Pid[] = [];
  private readonly positions = new Map<Pid, number>();
  private readonly sorted: Pid[] = [];
  private sortedDirty = false;

  constructor(
    private readonly process: (pid: Pid) => ProcessControlBlock | undefined,
    private readonly comparator: (a: ProcessControlBlock, b: ProcessControlBlock) => number,
  ) {}

  get size(): number { return this.heap.length; }

  /** Queue membership is a set, so repeated notifications cannot duplicate it. */
  push(pid: Pid): void {
    if (this.positions.has(pid)) return;
    this.requireProcess(pid);
    const index = this.heap.length;
    this.heap.push(pid);
    this.positions.set(pid, index);
    this.sortedDirty = true;
    this.siftUp(index);
  }

  peek(): Pid | null { return this.heap[0] ?? null; }

  pop(): Pid | null {
    const root = this.peek();
    if (root !== null) this.remove(root);
    return root;
  }

  remove(pid: Pid): boolean {
    const index = this.positions.get(pid);
    if (index === undefined) return false;
    const last = this.heap.pop();
    if (last === undefined) throw new KernelInvariantError(13, 'scheduler heap membership is inconsistent');
    this.positions.delete(pid);
    this.sortedDirty = true;
    if (index < this.heap.length) {
      this.heap[index] = last;
      this.positions.set(last, index);
      const parent = Math.floor((index - 1) / 2);
      if (index > 0 && this.compare(last, this.at(parent)) < 0) this.siftUp(index);
      else this.siftDown(index);
    }
    return true;
  }

  /** Bottom-up heapification is linear, even when every priority has changed. */
  rebuild(): void {
    for (let index = Math.floor(this.heap.length / 2) - 1; index >= 0; index -= 1) {
      this.siftDown(index);
    }
    this.sortedDirty = true;
  }

  /** Reuse both this array and its ordering until membership or keys change. */
  toArray(): readonly Pid[] {
    if (this.sortedDirty) {
      this.sorted.length = this.heap.length;
      for (let index = 0; index < this.heap.length; index += 1) this.sorted[index] = this.at(index);
      this.sorted.sort((a, b) => this.compare(a, b));
      this.sortedDirty = false;
    }
    return this.sorted;
  }

  private requireProcess(pid: Pid): ProcessControlBlock {
    const pcb = this.process(pid);
    if (pcb === undefined) throw new KernelInvariantError(13, 'scheduler heap contains an unknown process', { pid });
    return pcb;
  }

  private compare(a: Pid, b: Pid): number {
    if (a === b) return 0;
    return this.comparator(this.requireProcess(a), this.requireProcess(b));
  }

  private at(index: number): Pid {
    const pid = this.heap[index];
    if (pid === undefined) throw new KernelInvariantError(13, 'scheduler heap index is out of bounds', { index });
    return pid;
  }

  private swap(a: number, b: number): void {
    const first = this.at(a);
    const second = this.at(b);
    this.heap[a] = second;
    this.heap[b] = first;
    this.positions.set(first, b);
    this.positions.set(second, a);
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.at(index), this.at(parent)) >= 0) return;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    while (index * 2 + 1 < this.heap.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      const next = right < this.heap.length && this.compare(this.at(right), this.at(left)) < 0 ? right : left;
      if (this.compare(this.at(next), this.at(index)) >= 0) return;
      this.swap(index, next);
      index = next;
    }
  }
}
