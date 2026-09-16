/**
 * KERNEL TRAIL: terminal input history. Capped at 200 entries, trimmed from
 * the head, never persisted across runs (WP-15 spec 6).
 */

export class History {
  private readonly lines: string[] = [];
  private cursor = 0;

  constructor(readonly capacity = 200) {}

  get entries(): readonly string[] { return this.lines; }

  /** Blank lines and immediate repeats are not recorded. */
  push(line: string): void {
    const text = line.trim();
    if (text.length === 0) { this.cursor = this.lines.length; return; }
    if (this.lines[this.lines.length - 1] !== text) this.lines.push(text);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    this.cursor = this.lines.length;
  }

  /** The previous entry, or null at the oldest. */
  up(): string | null {
    if (this.cursor === 0) return null;
    this.cursor -= 1;
    return this.lines[this.cursor] ?? null;
  }

  /** The next entry, or null once past the newest (which means an empty prompt). */
  down(): string | null {
    if (this.cursor >= this.lines.length) return null;
    this.cursor += 1;
    return this.lines[this.cursor] ?? null;
  }

  reset(): void { this.cursor = this.lines.length; }
}
