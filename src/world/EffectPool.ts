/**
 * Bounded, recycling pool for transient visual effects.
 *
 * The simulator can emit hundreds of events in a single tick. A burst of page
 * faults during thrashing, or a cascade of terminations when a deadlock is
 * broken, would allocate hundreds of objects per frame if effects were created
 * on demand. This pool caps the count instead: when the pool is exhausted, the
 * oldest live effect is retired early and its slot reused, so the frame cost
 * stays flat no matter how loud the simulation gets.
 *
 * Retiring the oldest is deliberate. The newest event is the one the player is
 * reacting to, and a dropped tail effect is less noticeable than a dropped head.
 *
 * See 01-ARCHITECTURE.md section 3 and the per-tier caps in 03-VISUAL-BIBLE.md
 * section 12.
 */

export interface PooledEffect {
  /** Seconds this effect has been alive. The pool maintains it. */
  age: number;
  /** Total lifetime in seconds. The pool retires the effect when age exceeds it. */
  lifetime: number;
  /** True while the effect occupies a slot. */
  active: boolean;
}

export interface EffectPoolOptions<T extends PooledEffect> {
  /** Hard ceiling on simultaneously active effects. Comes from the quality tier. */
  readonly capacity: number;
  /** Builds one instance. Called `capacity` times at construction, never after. */
  readonly create: () => T;
  /** Prepares a recycled instance for reuse. Must reset all per-use state. */
  readonly reset: (effect: T) => void;
  /** Called when an effect leaves the active set, whether it expired or was evicted. */
  readonly release?: (effect: T) => void;
}

export class EffectPool<T extends PooledEffect> {
  private readonly all: T[] = [];
  private readonly free: T[] = [];
  /** Active effects in acquisition order, so index 0 is always the oldest. */
  private readonly live: T[] = [];
  private readonly opts: EffectPoolOptions<T>;

  /** Effects retired early because the pool was full. Surfaced in the dev HUD. */
  public evictions = 0;

  constructor(opts: EffectPoolOptions<T>) {
    if (opts.capacity <= 0) {
      throw new Error('EffectPool capacity must be positive');
    }
    this.opts = opts;
    // Allocate the whole pool up front. Steady-state allocation is then zero,
    // which is the entire point of the class.
    for (let i = 0; i < opts.capacity; i += 1) {
      const effect = opts.create();
      effect.active = false;
      effect.age = 0;
      this.all.push(effect);
      this.free.push(effect);
    }
  }

  get capacity(): number {
    return this.opts.capacity;
  }

  get activeCount(): number {
    return this.live.length;
  }

  /**
   * Take a slot. Never returns null: when the pool is full the oldest live
   * effect is retired to make room, so callers do not need a fallback path.
   */
  acquire(lifetime: number): T {
    let effect = this.free.pop();

    if (effect === undefined) {
      const oldest = this.live.shift();
      if (oldest === undefined) {
        // Unreachable while capacity > 0, but the type system does not know that.
        throw new Error('EffectPool exhausted with no live effects to evict');
      }
      this.retire(oldest);
      this.evictions += 1;
      effect = oldest;
    }

    effect.active = true;
    effect.age = 0;
    effect.lifetime = lifetime;
    this.opts.reset(effect);
    this.live.push(effect);
    return effect;
  }

  /**
   * Age every live effect and retire the expired ones. Call once per rendered
   * frame with the real elapsed time, not the simulation tick delta, because
   * effects are presentation and run on wall-clock time.
   */
  update(dtSeconds: number): void {
    // Iterate backwards so in-place removal does not skip entries.
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const effect = this.live[i];
      if (effect === undefined) continue;
      effect.age += dtSeconds;
      if (effect.age >= effect.lifetime) {
        this.live.splice(i, 1);
        this.retire(effect);
      }
    }
  }

  /** Read-only view of the live set, for the renderer to walk. Do not mutate. */
  get active(): readonly T[] {
    return this.live;
  }

  /** Retire everything. Used on leg teardown. */
  clear(): void {
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const effect = this.live[i];
      if (effect !== undefined) this.retire(effect);
    }
    this.live.length = 0;
    this.evictions = 0;
  }

  /** Every instance the pool owns, live or not. For disposing GPU resources. */
  get instances(): readonly T[] {
    return this.all;
  }

  private retire(effect: T): void {
    effect.active = false;
    effect.age = 0;
    this.opts.release?.(effect);
    this.free.push(effect);
  }
}
