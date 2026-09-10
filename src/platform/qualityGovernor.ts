/**
 * KERNEL TRAIL: runtime quality governor.
 *
 * Implements 01-ARCHITECTURE section 6.4. Watches frame time, downgrades the
 * tier after a sustained run of over-budget frames, and offers (never applies)
 * an upgrade after a long run of headroom.
 *
 * Three properties matter more than the thresholds:
 *
 * 1. **Downgrades are automatic, upgrades are offered.** An automatic upgrade
 *    followed by an automatic downgrade is an oscillation the player experiences
 *    as the game flickering between two looks. Offering it puts one line in the
 *    HUD that the player accepts once.
 * 2. **Hysteresis is asymmetric and generous.** The downgrade needs 90
 *    consecutive-equivalent bad frames (about 1.5 s), the upgrade offer needs
 *    1800 good ones (about 30 s), and every change starts a 600-frame cooldown
 *    during which nothing is counted at all.
 * 3. **A tier change must not stall the frame.** This class only decides and
 *    announces. The listener reconfigures render targets and lowers instance
 *    draw limits; it MUST NOT rebuild materials or geometry, because a downgrade
 *    happens precisely when the game is already struggling.
 *
 * This module deliberately does not import the profile table from
 * `src/platform/quality.ts`. The governor's job is to pick a tier; mapping a
 * tier to a profile belongs to whoever applies it, and keeping the dependency
 * one-way means the governor is testable with no renderer and no Three.js.
 */

import type { QualityTier } from './capabilities';
import { TIER_ORDER } from './capabilities';

/* ------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The subset of the game loop's per-frame metrics the governor reads. Declared
 * here rather than imported from the loop so that `src/platform` does not depend
 * on `src/app`; the loop's own `FrameMetrics` structurally satisfies this.
 */
export interface GovernorFrameSample {
  /** Wall-clock milliseconds for the whole frame, as measured by the loop. */
  readonly frameMs: number;
  /**
   * Simulation ticks the loop could not run this frame. A dropped tick is a
   * stronger signal than frame time alone, because it means the CPU side is
   * behind rather than the GPU being briefly busy.
   */
  readonly droppedTicks: number;
}

export type TierChangeReason =
  /** The initial tier, announced once so listeners have a starting point. */
  | 'boot'
  /** The player chose a tier by hand. Disables all automatic changes. */
  | 'user'
  /** Sustained over-budget frames. One step down the ladder. */
  | 'auto-downgrade'
  /**
   * Already at `low` and still over budget. The tier does not change; the
   * last-resort measures from section 6.5 apply instead.
   */
  | 'auto-downgrade-floor'
  /** Sustained headroom. An offer, not a change. `tier` is the proposed tier. */
  | 'upgrade-offered';

export interface TierChangeEvent {
  /** For 'upgrade-offered', the tier being proposed rather than the tier in use. */
  readonly tier: QualityTier;
  readonly previous: QualityTier;
  readonly reason: TierChangeReason;
  /**
   * Non-null only for 'auto-downgrade-floor': the render scale the backend
   * should adopt in place of a tier change. Section 6.5 step 1.
   */
  readonly renderScaleOverride: number | null;
  /** Median frame time over the recent window, for the diagnostics panel. */
  readonly medianFrameMs: number;
}

export type TierChangeListener = (e: TierChangeEvent) => void;
export type Unsubscribe = () => void;

export interface GovernorOptions {
  /** Frame time above which a frame counts as over budget. */
  readonly budgetMs: number;
  /** Weighted over-budget frames required to downgrade. */
  readonly consecutive: number;
  /** Frames ignored entirely after any tier change or leg transition. */
  readonly cooldownFrames: number;
  /** Frames of stable headroom before an upgrade is offered. */
  readonly upgradeWindow: number;
  /**
   * Render scale applied when already at `low` and still over budget. Section
   * 6.5 pairs this with pinning `maxPixelRatio` to 1, which the listener does.
   */
  readonly floorRenderScale: number;
  /**
   * Frames of history kept for the reported median. Long enough to be stable,
   * short enough that the number tracks what the player is looking at now.
   */
  readonly historyFrames: number;
}

/**
 * 18.5 ms rather than 16.6: a frame that misses vsync by a fraction is still a
 * 60 fps experience on a display with any frame pacing at all, and treating
 * every 17 ms frame as a failure would downgrade a machine that is fine.
 */
export const DEFAULT_GOVERNOR: GovernorOptions = {
  budgetMs: 18.5,
  consecutive: 90,
  cooldownFrames: 600,
  upgradeWindow: 1800,
  floorRenderScale: 0.6,
  historyFrames: 120,
};

/* ------------------------------------------------------------------------- */
/* The governor                                                               */
/* ------------------------------------------------------------------------- */

export class QualityGovernor {
  private tier: QualityTier;
  private over = 0;
  private under = 0;
  private cooldown = 0;
  /** Set when the player picks a tier by hand. Disables all automatic changes. */
  private manual = false;
  /** True once the floor measures are in effect, so they are announced once only. */
  private atFloor = false;

  private readonly listeners = new Set<TierChangeListener>();

  /** Ring buffer of recent frame times. Fixed size; never allocates after boot. */
  private readonly history: Float64Array;
  private historyWrite = 0;
  private historyFilled = 0;
  /** Scratch for the median, so `medianFrameMs` allocates nothing per call. */
  private readonly sortScratch: Float64Array;

  constructor(
    initial: QualityTier,
    private readonly opts: GovernorOptions = DEFAULT_GOVERNOR,
  ) {
    this.tier = initial;
    this.history = new Float64Array(opts.historyFrames);
    this.sortScratch = new Float64Array(opts.historyFrames);
    // Start in cooldown: the first second of any session includes shader
    // compilation and is never representative.
    this.cooldown = opts.cooldownFrames;
  }

  get current(): QualityTier {
    return this.tier;
  }

  get isManual(): boolean {
    return this.manual;
  }

  /** Frames remaining before automatic decisions resume. Diagnostics only. */
  get cooldownRemaining(): number {
    return this.cooldown;
  }

  on(listener: TierChangeListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Announce the starting tier. Call once, after the first listener is attached,
   * so the backend and the HUD both learn the boot tier through the same channel
   * they will learn every later change through.
   */
  announceInitial(): void {
    this.emit({
      tier: this.tier,
      previous: this.tier,
      reason: 'boot',
      renderScaleOverride: null,
      medianFrameMs: this.medianFrameMs(),
    });
  }

  /** The player chose a tier. All automatic changes stop for the session. */
  setManual(tier: QualityTier): void {
    const previous = this.tier;
    this.manual = true;
    this.tier = tier;
    this.atFloor = false;
    this.resetCounters();
    this.cooldown = this.opts.cooldownFrames;
    this.emit({
      tier,
      previous,
      reason: 'user',
      renderScaleOverride: null,
      medianFrameMs: this.medianFrameMs(),
    });
  }

  /**
   * Hand control back to the governor after a manual choice. The tier in force
   * stays where the player left it and becomes the new starting point.
   */
  clearManual(): void {
    this.manual = false;
    this.resetCounters();
    this.cooldown = this.opts.cooldownFrames;
  }

  /**
   * Called on every leg transition. The first seconds after a stage build are
   * never typical: geometry is being generated, materials are compiling, and the
   * establishing camera move is the heaviest shot in the leg.
   */
  pauseForTransition(): void {
    this.cooldown = this.opts.cooldownFrames;
    this.resetCounters();
  }

  /**
   * Feed one frame. `drawCallOverBudget` comes from the render stats compared
   * against the tier's draw-call ceiling (12.1); it is a separate signal because
   * a frame can be inside its millisecond budget on a fast GPU while still
   * submitting more draws than the tier permits, and that will fall over on the
   * next scene.
   */
  onFrame(sample: GovernorFrameSample, drawCallOverBudget: boolean): void {
    this.pushHistory(sample.frameMs);

    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    if (this.manual) return;

    const overBudget = sample.frameMs > this.opts.budgetMs || drawCallOverBudget;
    if (overBudget) {
      // A frame that also dropped ticks counts triple. The simulation falling
      // behind is the failure the player actually feels.
      this.over += sample.droppedTicks > 0 ? 3 : 1;
      this.under = 0;
    } else {
      this.under += 1;
      // Decay rather than reset, so an alternating good/bad pattern (which is
      // exactly what a machine sitting on the edge of the budget produces) still
      // trips the downgrade instead of oscillating forever at zero.
      this.over = this.over > 0 ? this.over - 1 : 0;
    }

    if (this.over >= this.opts.consecutive) {
      this.downgrade();
      return;
    }

    if (this.under >= this.opts.upgradeWindow) {
      this.under = 0;
      const idx = TIER_ORDER.indexOf(this.tier);
      const next = idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : undefined;
      if (next !== undefined && !this.atFloor) {
        this.emit({
          tier: next,
          previous: this.tier,
          reason: 'upgrade-offered',
          renderScaleOverride: null,
          medianFrameMs: this.medianFrameMs(),
        });
      }
    }
  }

  /** Median frame time over the retained history. Zero before the first frame. */
  medianFrameMs(): number {
    const n = this.historyFilled;
    if (n === 0) return 0;
    const scratch = this.sortScratch;
    for (let i = 0; i < n; i++) {
      // TypeScript 7 applies noUncheckedIndexedAccess to typed arrays as well as
      // plain ones, so the index is widened to number | undefined. The read is in
      // range by construction, and 0 is a safe coalesce for a frame time.
      scratch[i] = this.history[i] ?? 0;
    }
    const view = scratch.subarray(0, n);
    view.sort();
    return view[n >> 1] ?? 0;
  }

  private downgrade(): void {
    const previous = this.tier;
    const idx = TIER_ORDER.indexOf(this.tier);
    const lower = idx > 0 ? TIER_ORDER[idx - 1] : undefined;

    this.resetCounters();
    this.cooldown = this.opts.cooldownFrames;

    if (lower !== undefined) {
      this.tier = lower;
      this.emit({
        tier: lower,
        previous,
        reason: 'auto-downgrade',
        renderScaleOverride: null,
        medianFrameMs: this.medianFrameMs(),
      });
      return;
    }

    // Already at low. The tier cannot fall further, so section 6.5's last-resort
    // measures apply. Announced once: repeating it every 1.5 s would spam the
    // listener and re-trigger a render-target rebuild that changes nothing.
    if (this.atFloor) return;
    this.atFloor = true;
    this.emit({
      tier: this.tier,
      previous,
      reason: 'auto-downgrade-floor',
      renderScaleOverride: this.opts.floorRenderScale,
      medianFrameMs: this.medianFrameMs(),
    });
  }

  private resetCounters(): void {
    this.over = 0;
    this.under = 0;
  }

  private pushHistory(ms: number): void {
    this.history[this.historyWrite] = ms;
    this.historyWrite = (this.historyWrite + 1) % this.history.length;
    if (this.historyFilled < this.history.length) this.historyFilled += 1;
  }

  private emit(e: TierChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(e);
      } catch (err) {
        // A listener that throws must not take the frame down with it, and must
        // not prevent the other listeners from learning about the change. The
        // backend and the HUD are both listeners; losing the HUD update is
        // survivable, losing the backend reconfiguration is not.
        if (import.meta.env.DEV) {
          console.error('[kt] quality governor listener threw', err);
        }
      }
    }
  }
}
