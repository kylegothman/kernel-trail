/**
 * The voice budget and the allocator. Pre-flight ruling C2: this file owns the
 * 16/32/64 table keyed by a type-only `QualityTier`, because `PROFILES` carries
 * no audio field and the architecture matrix makes `platform` type-only for
 * audio. Package section 8: over budget, steal the oldest voice in the same
 * bus, never drop the newest; `alarm` and `kernel.panic` are exempt.
 */
import type { QualityTier } from '@platform/quality';
import type { BusId, Voice, VoiceKind } from './voices/Voice';

export const VOICE_BUDGET: Readonly<Record<QualityTier, number>> = { low: 16, medium: 32, high: 64 };

/**
 * How the budget is split across the kinds, WP-25 section 2. The score's
 * share: `chord` holds the bass plus the chord voices (two at low, four at
 * medium and high, one spare at high for the release overlap on a chord
 * change), one kick, one lead (two at high), one pad drone at low, two at
 * medium, three at high, and one of the tones is the arp (two at high). The
 * rest is the world's. A travel section takes 6 voices at low, 9 at medium
 * and 11 at high. Each row sums to the tier's budget, asserted by test.
 */
export const POOL_SPLIT: Readonly<Record<QualityTier, Readonly<Record<VoiceKind, number>>>> = {
  low: { tone: 5, noise: 2, impact: 2, drone: 1, granular: 1, chord: 3, kick: 1, lead: 1 },
  medium: { tone: 8, noise: 5, impact: 5, drone: 2, granular: 5, chord: 5, kick: 1, lead: 1 },
  high: { tone: 22, noise: 10, impact: 8, drone: 3, granular: 12, chord: 6, kick: 1, lead: 2 },
};

export interface AllocatorStats {
  busy: number;
  peak: number;
  stolen: number;
  dropped: number;
}

export class VoiceAllocator {
  private readonly voices: Voice[] = [];
  private readonly byKind = new Map<VoiceKind, Voice[]>();
  readonly stats: AllocatorStats = { busy: 0, peak: 0, stolen: 0, dropped: 0 };

  constructor(readonly cap: number) {}

  register(voice: Voice): void {
    if (this.voices.length >= this.cap) {
      throw new Error(`voice budget: pool would exceed the cap of ${this.cap}`);
    }
    this.voices.push(voice);
    let list = this.byKind.get(voice.kind);
    if (list === undefined) {
      list = [];
      this.byKind.set(voice.kind, list);
    }
    list.push(voice);
  }

  get size(): number {
    return this.voices.length;
  }

  all(): readonly Voice[] {
    return this.voices;
  }

  /** Count of voices sounding right now, after reclaiming finished one-shots. */
  busyCount(now: number): number {
    this.reclaim(now);
    let n = 0;
    for (const v of this.voices) if (v.busy) n += 1;
    this.stats.busy = n;
    if (n > this.stats.peak) this.stats.peak = n;
    return n;
  }

  /**
   * Find a voice of `kind` for `bus`. Order of preference: silent and idle,
   * idle with a tail still ringing, then the oldest busy voice on the same bus,
   * then the oldest busy voice on any bus. Exempt voices are never stolen; if
   * every candidate is exempt the request is dropped and counted.
   */
  acquire(kind: VoiceKind, bus: BusId, now: number, exempt = false): Voice | null {
    const list = this.byKind.get(kind);
    if (list === undefined || list.length === 0) {
      this.stats.dropped += 1;
      return null;
    }
    this.reclaim(now);
    let idle: Voice | null = null;
    let tail: Voice | null = null;
    let oldestSameBus: Voice | null = null;
    let oldestAny: Voice | null = null;
    for (const v of list) {
      if (!v.busy) {
        if (v.finishAt <= now) {
          if (idle === null) idle = v;
        } else if (tail === null) {
          tail = v;
        }
        continue;
      }
      if (v.exempt) continue;
      if (v.bus === bus && (oldestSameBus === null || v.startedAt < oldestSameBus.startedAt)) oldestSameBus = v;
      if (oldestAny === null || v.startedAt < oldestAny.startedAt) oldestAny = v;
    }
    const chosen = idle ?? tail;
    if (chosen !== null) return this.claim(chosen, bus, exempt);
    const victim = oldestSameBus ?? oldestAny;
    if (victim === null) {
      this.stats.dropped += 1;
      return null;
    }
    victim.stop(now);
    this.stats.stolen += 1;
    return this.claim(victim, bus, exempt);
  }

  /** Release every busy world voice at `when`. Layers belong to the Score. Used by `kernel.panic`. */
  stopAll(when: number, keep: Voice | null = null): void {
    for (const v of this.voices) {
      if (v !== keep && v.busy && !v.layer) v.stop(when);
    }
  }

  /** Deadlock hold: every busy voice sustains until `until`. */
  sustainAll(when: number, until: number): void {
    for (const v of this.voices) v.sustainUntil(when, until);
  }

  dispose(): void {
    for (const v of this.voices) v.dispose();
    this.voices.length = 0;
    this.byKind.clear();
  }

  private claim(voice: Voice, bus: BusId, exempt: boolean): Voice {
    voice.bus = bus;
    voice.exempt = exempt;
    const n = this.busyCount(voice.startedAt) + 1;
    if (n > this.stats.peak) this.stats.peak = n;
    return voice;
  }

  private reclaim(now: number): void {
    for (const v of this.voices) {
      if (v.busy && v.finishAt <= now) {
        v.busy = false;
        v.exempt = false;
      }
    }
  }
}
