/**
 * Provisional throughput target shared with the harness's golden runs.
 * The balance pass owns replacement with authored per-leg companion values.
 */
import type { LegContent } from '@legs/content';

export const PROVISIONAL_THROUGHPUT_TARGET = 0.1;

export function throughputTargetFor(content: LegContent): number {
  return content.throughputTarget ?? PROVISIONAL_THROUGHPUT_TARGET;
}
