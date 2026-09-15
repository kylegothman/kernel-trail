/**
 * Where a cue comes from on screen. Pre-flight ruling C11: the world layer
 * runs before audio and will publish a position per structure; until WP-14
 * lands, the default source answers null and every cue sits at centre.
 *
 * TODO(astra): WP-14 publishes structure positions; supply a PositionSource
 * that projects the event's structure to normalised screen x in [-1, 1] and
 * pass it to AudioEngine's options at the registration site.
 */
import type { KernelEvent } from '@kernel/types';

export interface PositionSource {
  /** Normalised screen x of the event's structure, -1 left to 1 right, or null. */
  xOf(e: KernelEvent): number | null;
}

export const CENTRED_POSITION_SOURCE: PositionSource = { xOf: () => null };
