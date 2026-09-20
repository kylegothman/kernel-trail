/**
 * The ducking envelope, WP-25 section 3. Side-chain compression is what makes
 * the chords breathe against a four-on-the-floor kick: on every kick the
 * pad, chords and bass dip and recover. Here it is a gain envelope triggered
 * per kick on every registered param, attack 5 ms, release 180 ms, depth per
 * tier, applied to the duck gain inside each `ChordVoice` and to the pad
 * drone's gate. There is no compressor and no detector; the kick knows when
 * it lands, so the envelope is scheduled, not measured.
 *
 * The same params carry the derezz duck (visual bible 9.4, "audio drops to
 * the low bed"): everything but the pad to silence over 400 ms, held until
 * the next section restores it.
 */
import type { QualityTier } from '@platform/quality';
import type { ParamLike } from '../context';
import { DEREZZ_DUCK_MS, MIN_EXP_TARGET } from './constants';
import { rampExp } from './envelope';

/** Section 3: attack 5 ms, release 180 ms. */
export const SIDECHAIN = { attackSeconds: 0.005, releaseSeconds: 0.18 } as const;

/** Section 3: depth per tier, pre-flight ruling 5, to be tuned after the audition. */
export const SIDECHAIN_DEPTH: Readonly<Record<QualityTier, number>> = { low: 0.5, medium: 0.6, high: 0.7 };

/** Seconds the derezz duck takes to restore when the next section begins. */
export const DUCK_RESTORE_SECONDS = 0.05;

export interface SidechainStats {
  triggers: number;
  ducks: number;
}

export class Sidechain {
  private readonly params = new Set<ParamLike>();
  private ducked = false;
  readonly stats: SidechainStats = { triggers: 0, ducks: 0 };

  /**
   * `depth` is the fraction of gain removed at the bottom of the dip.
   * `envelopeScale` is read per trigger, because reduced motion halves every
   * envelope time (WP-16 section 9) and the setting can change mid-run.
   */
  constructor(readonly depth: number, private readonly envelopeScale: () => number = () => 1) {
    if (!(depth >= 0 && depth < 1)) throw new RangeError(`sidechain: depth ${String(depth)} must be in [0, 1)`);
  }

  get size(): number {
    return this.params.size;
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  register(param: ParamLike): void {
    this.params.add(param);
  }

  unregister(param: ParamLike): void {
    this.params.delete(param);
  }

  /**
   * A kick at `when`. Each param is anchored at one, dips to `1 - depth` over
   * the attack and recovers exponentially over the release. The anchor is
   * exact because a recovery always finishes before the next kick can land:
   * 185 ms against a beat of at least 476 ms.
   */
  trigger(when: number): void {
    if (this.ducked) return;
    const scale = this.envelopeScale();
    const bottom = when + Math.max(0.001, SIDECHAIN.attackSeconds * scale);
    const top = bottom + Math.max(0.002, SIDECHAIN.releaseSeconds * scale);
    for (const param of this.params) {
      param.cancelScheduledValues(when);
      param.setValueAtTime(1, when);
      param.linearRampToValueAtTime(1 - this.depth, bottom);
      rampExp(param, 1, top);
    }
    this.stats.triggers += 1;
  }

  /** The derezz: every param to silence over 400 ms, held there. Kicks are ignored until `restore`. */
  duck(when: number): void {
    const seconds = (DEREZZ_DUCK_MS / 1000) * this.envelopeScale();
    for (const param of this.params) {
      param.cancelScheduledValues(when);
      param.setValueAtTime(1, when);
      param.linearRampToValueAtTime(MIN_EXP_TARGET, when + Math.max(0.002, seconds));
    }
    this.ducked = true;
    this.stats.ducks += 1;
  }

  /** Bring a ducked score back over `seconds`. Idempotent. */
  restore(when: number, seconds = DUCK_RESTORE_SECONDS): void {
    if (!this.ducked) return;
    for (const param of this.params) {
      param.cancelScheduledValues(when);
      param.setValueAtTime(MIN_EXP_TARGET, when);
      param.linearRampToValueAtTime(1, when + Math.max(0.002, seconds));
    }
    this.ducked = false;
  }
}
