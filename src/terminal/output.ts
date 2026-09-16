/**
 * KERNEL TRAIL: the three output helpers of WP-15 spec 7. Command output is
 * plain text in fixed columns, and no command formats a table by hand.
 */

export type Cell = string | number;

/** Column widths are computed once; numbers right-align, text left-aligns. */
export function table(headers: readonly string[], rows: readonly (readonly Cell[])[]): string[] {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => String(row[index] ?? '').length)));
  const numeric = headers.map((_, index) => rows.length > 0 && rows.every(row => typeof row[index] === 'number'));
  const render = (cells: readonly Cell[]): string => cells.map((cell, index) => {
    const text = String(cell);
    const width = widths[index] ?? text.length;
    return numeric[index] === true ? text.padStart(width) : text.padEnd(width);
  }).join('  ').trimEnd();
  return [render(headers), ...rows.map(row => render(row))];
}

/** Two-column key-value output, keys padded to one width. */
export function kv(pairs: readonly (readonly [string, Cell])[]): string[] {
  const width = Math.max(0, ...pairs.map(([key]) => key.length));
  return pairs.map(([key, value]) => `${key.padEnd(width)}  ${String(value)}`);
}

/** A small inline meter: `[####......]`. Values are clamped to the range. */
export function bar(value: number, max: number, width: number): string {
  const cells = Math.max(1, Math.floor(width));
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * cells);
  return `[${'#'.repeat(filled)}${'.'.repeat(cells - filled)}]`;
}

/** One decimal, with the sign the reader expects. */
export function percent(ratio: number): string {
  const clamped = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
  return `${(clamped * 100).toFixed(1)}%`;
}

/** Fixed decimals for metrics that are means rather than counts. */
export function fixed(value: number, decimals = 2): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : 'n/a';
}
