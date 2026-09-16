/**
 * KERNEL TRAIL: the shared events guard for leg evaluation (WP-21 section 9).
 *
 * The frozen `LegEvaluationContext.events` is typed as a floor, `{ type }`,
 * while the runner passes the full kernel log. `asKernelEvents` is the one
 * place a leg's `evaluate` narrows that floor to `KernelEvent`, so payload
 * reads (`event.pid`, `event.reason`, `event.fatal`) are typed rather than
 * cast, and a caller that hands a leg something other than the log fails
 * loudly instead of reading `undefined` payloads.
 */
import type { KernelEvent } from '@kernel/types';

/** Narrows the runner's log unchanged; throws on an element that carries no `tick` and `seq`. */
export function asKernelEvents(events: readonly { readonly type: string }[]): readonly KernelEvent[] {
  events.forEach((event, index) => {
    const candidate = event as { readonly type: string; readonly tick?: unknown; readonly seq?: unknown };
    if (typeof candidate.tick !== 'number' || typeof candidate.seq !== 'number') {
      throw new Error(`asKernelEvents: event ${index} (${event.type}) has no tick and seq; evaluate was not given the runner's event log`);
    }
  });
  return events as readonly KernelEvent[];
}
