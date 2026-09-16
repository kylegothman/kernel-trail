/**
 * The DOM rule, architecture section 7.5: reads first, then writes, once per
 * frame, at a single point. A layout read after a style write forces a
 * synchronous reflow inside a frame that also submits several hundred draw
 * calls, so a component that needs a measurement queues a read and acts on
 * it the following frame.
 */
export class DomBatch {
  private readonly reads: (() => void)[] = [];
  private readonly writes: (() => void)[] = [];
  readonly stats = { flushes: 0, reads: 0, writes: 0 };

  /** Layout reads run at the start of the next flush, before any write. */
  read(fn: () => void): void {
    this.reads.push(fn);
  }

  write(fn: () => void): void {
    this.writes.push(fn);
  }

  get pending(): number {
    return this.reads.length + this.writes.length;
  }

  flush(): void {
    this.stats.flushes += 1;
    const reads = this.reads.splice(0, this.reads.length);
    for (const r of reads) {
      this.stats.reads += 1;
      r();
    }
    const writes = this.writes.splice(0, this.writes.length);
    for (const w of writes) {
      this.stats.writes += 1;
      w();
    }
  }
}
