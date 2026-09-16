/**
 * WP-20 section 7 as amended and scope correction W3: a golden run is stored
 * in three tiers. Tier 1, the fingerprint, is one line (seed, ticks, event
 * count, hash) and is what CI compares. Tier 2, the structural summary, is
 * one line per event type (count, first tick, last tick) and localises
 * almost every regression on its own. Tier 3, the full log, is never
 * committed; it is regenerated from the seed on demand and rendered by
 * `tools/golden/renderEventLog.ts`.
 *
 * The hash is `hashEventLog` from `@game/replay/hash` (W2), so a golden hash
 * equals a replay hash for the same log by construction.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KernelEvent } from '@kernel/types';
import { canonicalise, withoutMapsAndSets } from '@game/save';
import type { LegId } from '@game/types';
import type { HarnessResult } from './LegHarness';
import { REPO_ROOT } from './loadLeg';

export const GOLDEN_DIR = resolve(REPO_ROOT, 'tests', 'golden', 'legs');
export type GoldenPath = 'good' | 'bad';

export interface Fingerprint {
  readonly seed: number;
  readonly ticks: number;
  readonly events: number;
  readonly hash: string;
}

export interface SummaryRow {
  readonly type: string;
  readonly count: number;
  readonly first: number;
  readonly last: number;
}

export interface GoldenTiers {
  readonly fingerprint: Fingerprint;
  readonly summary: readonly SummaryRow[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function fingerprintOf(result: HarnessResult): Fingerprint {
  return { seed: result.seed, ticks: result.ticks, events: result.events.length, hash: result.logHash };
}

/** One line: `seed=<n> ticks=<n> events=<n> hash=<16 hex>`. */
export function renderFingerprint(fingerprint: Fingerprint): string {
  return `seed=${fingerprint.seed} ticks=${fingerprint.ticks} events=${fingerprint.events} hash=${fingerprint.hash}\n`;
}

export function parseFingerprint(text: string): Fingerprint {
  const match = /^seed=(\d+) ticks=(\d+) events=(\d+) hash=([0-9a-f]{16})\s*$/.exec(text.trim());
  if (match === null) throw new Error(`malformed fingerprint: ${JSON.stringify(text.trim())}`);
  return { seed: Number(match[1]), ticks: Number(match[2]), events: Number(match[3]), hash: match[4] ?? '' };
}

/** Per event type in code-unit sorted order: count, first tick, last tick. */
export function summaryOf(events: readonly KernelEvent[]): readonly SummaryRow[] {
  const rows = new Map<string, { count: number; first: number; last: number }>();
  for (const event of events) {
    const row = rows.get(event.type);
    if (row === undefined) rows.set(event.type, { count: 1, first: event.tick, last: event.tick });
    else {
      row.count += 1;
      row.first = Math.min(row.first, event.tick);
      row.last = Math.max(row.last, event.tick);
    }
  }
  return [...rows.entries()].sort((a, b) => compare(a[0], b[0])).map(([type, row]) => ({ type, ...row }));
}

const TYPE_WIDTH = 30;
const NUMBER_WIDTH = 6;

export function renderSummary(rows: readonly SummaryRow[]): string {
  const lines = [`${'type'.padEnd(TYPE_WIDTH)}${'count'.padStart(NUMBER_WIDTH)}${'first'.padStart(NUMBER_WIDTH + 1)}${'last'.padStart(NUMBER_WIDTH + 1)}`];
  for (const row of rows) {
    lines.push(`${row.type.padEnd(TYPE_WIDTH)}${String(row.count).padStart(NUMBER_WIDTH)}${String(row.first).padStart(NUMBER_WIDTH + 1)}${String(row.last).padStart(NUMBER_WIDTH + 1)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseSummary(text: string): readonly SummaryRow[] {
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  const header = lines.shift();
  if (header === undefined || header.split(/\s+/).join(' ') !== 'type count first last') throw new Error(`malformed summary header: ${JSON.stringify(header ?? '')}`);
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) throw new Error(`malformed summary row: ${JSON.stringify(line)}`);
    const [type, count, first, last] = parts;
    return { type: type ?? '', count: Number(count), first: Number(first), last: Number(last) };
  });
}

export function goldenFiles(id: LegId, path: GoldenPath, dir: string = GOLDEN_DIR): { readonly fingerprint: string; readonly summary: string } {
  return { fingerprint: join(dir, `${id}.${path}.fingerprint.txt`), summary: join(dir, `${id}.${path}.summary.txt`) };
}

/** Both tiers, or null when either file is absent. A missing golden is a failure in the suites, never a silent record. */
export function readGolden(id: LegId, path: GoldenPath, dir: string = GOLDEN_DIR): GoldenTiers | null {
  const files = goldenFiles(id, path, dir);
  if (!existsSync(files.fingerprint) || !existsSync(files.summary)) return null;
  return { fingerprint: parseFingerprint(readFileSync(files.fingerprint, 'utf8')), summary: parseSummary(readFileSync(files.summary, 'utf8')) };
}

export function writeGolden(id: LegId, path: GoldenPath, tiers: GoldenTiers, dir: string = GOLDEN_DIR): void {
  mkdirSync(dir, { recursive: true });
  const files = goldenFiles(id, path, dir);
  writeFileSync(files.fingerprint, renderFingerprint(tiers.fingerprint), 'utf8');
  writeFileSync(files.summary, renderSummary(tiers.summary), 'utf8');
}

export function tiersOf(result: HarnessResult): GoldenTiers {
  return { fingerprint: fingerprintOf(result), summary: summaryOf(result.events) };
}

/** Tier 1 first, then tier 2 row by row; empty when the tiers agree. */
export function compareTiers(actual: GoldenTiers, expected: GoldenTiers): readonly string[] {
  const problems: string[] = [];
  for (const key of ['seed', 'ticks', 'events', 'hash'] as const) {
    if (actual.fingerprint[key] !== expected.fingerprint[key]) problems.push(`fingerprint.${key}: expected ${expected.fingerprint[key]}, got ${actual.fingerprint[key]}`);
  }
  const want = new Map(expected.summary.map((row) => [row.type, row]));
  const got = new Map(actual.summary.map((row) => [row.type, row]));
  for (const [type, row] of want) {
    const other = got.get(type);
    if (other === undefined) problems.push(`summary ${type}: expected count=${row.count} first=${row.first} last=${row.last}, never fired`);
    else if (other.count !== row.count || other.first !== row.first || other.last !== row.last) {
      problems.push(`summary ${type}: expected count=${row.count} first=${row.first} last=${row.last}, got count=${other.count} first=${other.first} last=${other.last}`);
    }
  }
  for (const [type, row] of got) if (!want.has(type)) problems.push(`summary ${type}: not in the golden, fired count=${row.count} first=${row.first} last=${row.last}`);
  return problems;
}

export interface Divergence {
  readonly index: number;
  readonly tick: number;
  readonly seq: number;
  readonly expectedEvent: KernelEvent | null;
  readonly actualEvent: KernelEvent | null;
  readonly expected: readonly KernelEvent[];
  readonly actual: readonly KernelEvent[];
}

const encode = (event: KernelEvent): string => canonicalise(withoutMapsAndSets(event));

/** The first event, in seq order, at which two logs disagree, with `context` events on each side of it in both logs. */
export function firstDivergence(expected: readonly KernelEvent[], actual: readonly KernelEvent[], context = 50): Divergence | null {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const want = expected[index] ?? null;
    const got = actual[index] ?? null;
    if (want !== null && got !== null && encode(want) === encode(got)) continue;
    const anchor = got ?? want;
    return {
      index,
      tick: anchor?.tick ?? 0,
      seq: anchor?.seq ?? 0,
      expectedEvent: want,
      actualEvent: got,
      expected: expected.slice(Math.max(0, index - context), index + context + 1),
      actual: actual.slice(Math.max(0, index - context), index + context + 1),
    };
  }
  return null;
}

/**
 * The earliest tick at which the summaries disagree: the smallest `first` of
 * any row whose count, first or last differs, or of a row present on one
 * side only. Null when the summaries agree.
 */
export function earliestSummaryDivergence(actual: readonly SummaryRow[], expected: readonly SummaryRow[]): { readonly type: string; readonly tick: number } | null {
  const want = new Map(expected.map((row) => [row.type, row]));
  const got = new Map(actual.map((row) => [row.type, row]));
  let best: { type: string; tick: number } | null = null;
  const consider = (type: string, tick: number): void => {
    if (best === null || tick < best.tick || (tick === best.tick && compare(type, best.type) < 0)) best = { type, tick };
  };
  for (const [type, row] of want) {
    const other = got.get(type);
    if (other === undefined) consider(type, row.first);
    else if (other.first !== row.first) consider(type, Math.min(other.first, row.first));
    else if (other.count !== row.count || other.last !== row.last) consider(type, row.first);
  }
  for (const [type, row] of got) if (!want.has(type)) consider(type, row.first);
  return best;
}
