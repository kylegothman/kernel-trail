/**
 * WP-20 section 7.1 and scope correction W5: the tier 3 renderer. One event
 * per line: `tick`, `seq`, `type`, then the remaining fields in sorted key
 * order as `key=value` separated by single spaces, nested values through
 * `canonicalise`, no locale formatting anywhere. The kernel event union is
 * type-only, so there is no runtime source for a declared field order;
 * sorted keys are stable and deterministic, and that is what this prints.
 */
import type { KernelEvent } from '@kernel/types';
import { canonicalise, withoutMapsAndSets } from '@game/save';

const BARE = /^[A-Za-z0-9_.:/+-]*$/;

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return BARE.test(value) ? value : JSON.stringify(value);
  return canonicalise(withoutMapsAndSets(value));
}

export const EVENT_LOG_HEADER = `${'tick'.padStart(6)} ${'seq'.padStart(7)}  ${'type'.padEnd(26)} payload`;

export function renderEventLine(event: KernelEvent): string {
  const record = event as unknown as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => key !== 'tick' && key !== 'seq' && key !== 'type' && record[key] !== undefined).sort();
  const payload = keys.map((key) => `${key}=${renderValue(record[key])}`).join(' ');
  return `${String(event.tick).padStart(6)} ${String(event.seq).padStart(7)}  ${event.type.padEnd(26)} ${payload}`.trimEnd();
}

export function renderEventLog(events: readonly KernelEvent[]): string {
  return [EVENT_LOG_HEADER, ...events.map(renderEventLine)].join('\n') + '\n';
}
