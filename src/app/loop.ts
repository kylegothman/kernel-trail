/**
 * KERNEL TRAIL - the fixed-timestep game loop. Architecture section 2.
 *
 * Simulation runs at a fixed 20 Hz. Rendering runs at the display refresh rate,
 * uncapped, with interpolation. 20 Hz because one tick is one CPU quantum unit,
 * because it divides evenly into 60 and 120 Hz so alpha lands on clean values,
 * because 50 ms is an exact integer so the accumulator never drifts over a
 * forty minute run, and because it leaves the sim about a third of a step per
 * frame at 60 fps.
 */

/** Simulation rate. One tick is one CPU quantum unit. */
export const TICK_HZ = 20;
/** Exactly 50. Kept integer so the accumulator never drifts. */
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_SECONDS = TICK_MS / 1000;

/**
 * Longest wall-clock gap we will simulate in one frame. 250 ms is five ticks:
 * enough to absorb a garbage collection pause or a shader compile hitch, short
 * enough that the sim can never outrun the renderer (the spiral of death).
 */
export const MAX_FRAME_MS = 250;
export const MAX_TICKS_PER_FRAME = MAX_FRAME_MS / TICK_MS; // 5

export interface FrameMetrics {
  /** Wall time between this rAF callback and the previous one. */
  readonly frameMs: number;
  /** Time spent inside our own frame body, excluding browser compositing. */
  readonly cpuMs: number;
  readonly simMs: number;
  readonly routeMs: number;
  readonly worldMs: number;
  readonly renderMs: number;
  readonly ticksThisFrame: number;
  /** Ticks discarded because the frame clamp hit. Non-zero means we are behind. */
  readonly droppedTicks: number;
  readonly alpha: number;
  readonly frameIndex: number;
}

/**
 * Everything the loop drives. The host supplies the implementation; the loop
 * knows nothing about kernels, scenes or stores, which is what makes it
 * unit-testable with a fake clock.
 */
export interface SimHost {
  /** Apply queued player commands. Runs immediately before every tick. */
  applyPendingCommands(tick: number): void;
  /** Advance the simulation exactly one tick. */
  fixedUpdate(tick: number): void;
  /** Publish store changes. Called once per frame after all ticks. */
  flushState(): void;
  /** Deliver this frame's batched kernel events to the world. */
  routeEvents(): void;
  /** Advance visuals. `alpha` is the fraction of a tick already elapsed. */
  variableUpdate(dtSeconds: number, alpha: number): void;
  /** Draw. */
  render(alpha: number): void;
  onFrameMetrics(m: FrameMetrics): void;
  /** Called when the loop pauses or resumes so audio and effects can react. */
  onRunStateChanged(running: boolean): void;
}

/** Injected so tests can drive the loop with a scripted clock. */
export interface LoopClock {
  now(): number;
  schedule(cb: (now: number) => void): number;
  cancel(handle: number): void;
}

export const browserClock: LoopClock = {
  now: () => performance.now(),
  schedule: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
};

export interface GameLoopOptions {
  readonly host: SimHost;
  readonly clock?: LoopClock;
  /** Multiplies simulated time. 0 pauses, 1 is normal, 3 is fast-forward. */
  readonly initialTimeScale?: number;
}

export class GameLoop {
  private readonly host: SimHost;
  private readonly clock: LoopClock;

  private handle = 0;
  private running = false;
  private lastMs = 0;
  private accumulatorMs = 0;
  private tick = 0;
  private frameIndex = 0;
  private timeScale: number;
  /** Set by pause, visibility change, or a fatal error. */
  private suspended = false;

  constructor(opts: GameLoopOptions) {
    this.host = opts.host;
    this.clock = opts.clock ?? browserClock;
    this.timeScale = opts.initialTimeScale ?? 1;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMs = this.clock.now();
    this.accumulatorMs = 0;
    this.host.onRunStateChanged(true);
    this.handle = this.clock.schedule(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clock.cancel(this.handle);
    this.host.onRunStateChanged(false);
  }

  /** Soft pause: keeps rendering so the world stays alive, stops advancing sim. */
  setTimeScale(scale: number): void {
    this.timeScale = Math.max(0, Math.min(8, scale));
  }

  get currentTimeScale(): number {
    return this.timeScale;
  }

  /** Hard suspend: stops the rAF entirely. Used on tab hide and on fatal error. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.clock.cancel(this.handle);
    this.host.onRunStateChanged(false);
  }

  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    // Discard everything that happened while we were away. The alternative,
    // catching up, would run thousands of ticks in one frame and would make a
    // backgrounded tab into a cheat.
    this.lastMs = this.clock.now();
    this.accumulatorMs = 0;
    this.host.onRunStateChanged(true);
    if (this.running) this.handle = this.clock.schedule(this.frame);
  }

  get currentTick(): number {
    return this.tick;
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  private readonly frame = (now: number): void => {
    if (!this.running || this.suspended) return;
    this.handle = this.clock.schedule(this.frame);

    const frameStart = now;
    let rawDelta = now - this.lastMs;
    this.lastMs = now;

    // A negative delta can occur if the clock is adjusted. Treat it as one frame.
    if (!Number.isFinite(rawDelta) || rawDelta < 0) rawDelta = TICK_MS;

    // The clamp. Without it, a 4-second stall queues 80 ticks, the frame that
    // simulates them takes longer than 4 seconds, and the queue grows forever.
    const frameMs = rawDelta;
    const clamped = Math.min(rawDelta, MAX_FRAME_MS);

    this.accumulatorMs += clamped * this.timeScale;

    const simStart = this.clock.now();
    let ticksThisFrame = 0;
    let droppedTicks = 0;

    while (this.accumulatorMs >= TICK_MS) {
      if (ticksThisFrame >= MAX_TICKS_PER_FRAME) {
        droppedTicks = Math.floor(this.accumulatorMs / TICK_MS);
        this.accumulatorMs = 0;
        break;
      }
      this.host.applyPendingCommands(this.tick);
      this.host.fixedUpdate(this.tick);
      this.tick += 1;
      this.accumulatorMs -= TICK_MS;
      ticksThisFrame += 1;
    }
    const simMs = this.clock.now() - simStart;

    const alpha = this.timeScale === 0 ? 0 : this.accumulatorMs / TICK_MS;

    this.host.flushState();

    const routeStart = this.clock.now();
    this.host.routeEvents();
    const routeMs = this.clock.now() - routeStart;

    const worldStart = this.clock.now();
    this.host.variableUpdate(clamped / 1000, alpha);
    const worldMs = this.clock.now() - worldStart;

    const renderStart = this.clock.now();
    this.host.render(alpha);
    const renderMs = this.clock.now() - renderStart;

    const end = this.clock.now();
    this.host.onFrameMetrics({
      frameMs,
      cpuMs: end - frameStart,
      simMs,
      routeMs,
      worldMs,
      renderMs,
      ticksThisFrame,
      droppedTicks,
      alpha,
      frameIndex: this.frameIndex++,
    });
  };
}

/* ------------------------------------------------------------------ */
/* Tab blur, visibility and focus. Architecture section 2.4.           */
/* ------------------------------------------------------------------ */

export interface VisibilityHooks {
  /** Tab hidden: write the provisional save, mute audio over 120 ms. */
  onHide(): void;
  /** Tab visible again: unmute and show the 400 ms resuming wipe. */
  onShow(): void;
  /** Another window on top, tab still visible: duck audio by 6 dB. */
  onBlur(): void;
  onFocus(): void;
}

/**
 * Three browser signals could pause the game and they mean different things.
 *
 *  - `visibilitychange` to hidden suspends the loop. rAF is throttled to about
 *    1 Hz or stopped when the tab is not on screen, so continuing would produce
 *    1000 ms deltas that the clamp turns into permanent tick loss. Suspending
 *    makes that explicit.
 *  - `visibilitychange` to visible resumes, which resets `lastMs` and zeroes
 *    the accumulator. Discarding the gap is the only choice that preserves both
 *    determinism and fairness; simulated time is not wall time, so nothing is
 *    lost conceptually.
 *  - `window.blur` keeps running. The player may be watching on a second
 *    monitor or reading the codex in another window, and pausing would surprise.
 *  - `pagehide` and `freeze` are no-ops. IndexedDB writes cannot be relied on
 *    there, so the provisional save is written on the preceding
 *    `visibilitychange` instead.
 */
export function installVisibilityGovernor(loop: GameLoop, hooks: VisibilityHooks): () => void {
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      hooks.onHide();
      loop.suspend();
    } else {
      loop.resume();
      hooks.onShow();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', hooks.onBlur);
  window.addEventListener('focus', hooks.onFocus);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', hooks.onBlur);
    window.removeEventListener('focus', hooks.onFocus);
  };
}
