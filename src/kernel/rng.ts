/**
 * KERNEL TRAIL - sfc32 deterministic random number generator.
 *
 * Implements the frozen `Rng` contract from @kernel/types exactly as specified
 * in docs/02-KERNEL-SIM-SPEC section 1.2. The entire determinism story rests on
 * this file, so every arithmetic coercion below is normative. Removing a `| 0`
 * or a `>>> 0` produces a generator that agrees with this one for a while and
 * then silently diverges.
 *
 * This module has no imports beyond types, touches no globals, and calls
 * nothing from Math except `imul` and `floor`.
 */

import type { Rng, RngState } from './types';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** 2^32, written as a literal so no Math.pow rounding enters. Spec 1.2.1. */
const TWO_POW_32 = 4294967296;

/**
 * Outputs discarded after seeding and after forking. Spec 1.2.2: sfc32 seeded
 * from a low-entropy state produces visibly correlated first outputs, so the
 * generator is warmed by exactly this many draws. The number is part of the
 * contract; changing it changes every run in the game.
 */
export const WARMUP_DRAWS = 12;

/**
 * The kernel's stream registry, in the fixed order of spec 1.2.5. `root` is
 * seeded from `KernelConfig.seed`; every other entry is `root.fork(label)`.
 * All of them are forked whether or not the subsystem is enabled, so that
 * enabling a subsystem for one leg cannot shift another leg's streams.
 */
export const SUBSYSTEM_STREAM_LABELS = [
  'process',
  'scheduler',
  'memory',
  'vm',
  'sync',
  'deadlock',
  'storage',
  'io',
  'fs',
  'security',
  'events',
] as const;

export type SubsystemStreamLabel = (typeof SUBSYSTEM_STREAM_LABELS)[number];

/** The root stream's label. Child labels are slash-joined onto it. */
export const ROOT_STREAM_LABEL = 'root';

/* ------------------------------------------------------------------ */
/* Hash helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * splitmix32. Expands a single 32-bit seed into a stream of well-mixed 32-bit
 * words. Used for seeding (spec 1.2.2) and inside `fork` (spec 1.2.4).
 */
export function splitmix32(seed: number): () => number {
  let z = seed | 0;
  return (): number => {
    z = (z + 0x9e3779b9) | 0;
    let t = z ^ (z >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/**
 * FNV-1a over UTF-16 code units. Spec 1.2.4. Labels are restricted by
 * convention to ASCII `[a-z0-9_]` so surrogate pairs never arise.
 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ */
/* The generator                                                       */
/* ------------------------------------------------------------------ */

export class Sfc32Rng implements Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private streamLabel: string;

  /**
   * Construct from raw state words. Callers normally want `createRng`, which
   * performs the splitmix32 seeding and the warm-up. This constructor performs
   * neither, because `restore` and `fork` need the raw form.
   */
  constructor(words: readonly [number, number, number, number], label: string) {
    this.a = words[0] | 0;
    this.b = words[1] | 0;
    this.c = words[2] | 0;
    this.d = words[3] | 0;
    this.streamLabel = label;
  }

  /** The slash-joined stream path, for example `root/scheduler`. */
  get label(): string {
    return this.streamLabel;
  }

  /**
   * Advance the state and return the next uint32. Spec 1.2.1. Every `| 0` and
   * `>>> 0` here is load bearing.
   */
  nextUint32(): number {
    let a = this.a | 0;
    let b = this.b | 0;
    let c = this.c | 0;
    let d = this.d | 0;

    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;

    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    return t >>> 0;
  }

  /** Uniform in [0, 1). Spec 1.2.1. */
  next(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  /** Uniform integer in [minInclusive, maxExclusive). Spec 1.2.3. */
  int(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new RangeError('int: non-integer bound');
    }
    if (maxExclusive <= minInclusive) {
      throw new RangeError('int: empty range');
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  /**
   * True with the given probability. Strict `<` so `chance(0)` is always false
   * and `chance(1)` is always true, since `next()` never returns 1. Spec 1.2.3.
   */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Uniformly select one element. Throws on an empty array. Spec 1.2.3. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('pick: empty array');
    }
    const chosen = items[this.int(0, items.length)];
    if (chosen === undefined && !(0 in items)) {
      throw new RangeError('pick: sparse array');
    }
    return chosen as T;
  }

  /**
   * In-place Fisher-Yates, descending, exactly `length - 1` draws. Spec 1.2.3:
   * the direction is normative. An ascending variant consumes the same number
   * of draws and produces a different permutation.
   */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  /**
   * Fork an independent stream. Spec 1.2.4.
   *
   * F1: forking does not advance the parent. Nothing here calls `nextUint32`
   *     on `this`, so introducing a new subsystem cannot shift any stream
   *     forked before or after it.
   * F2: the child is a pure function of the parent's words and the label, so
   *     fork order is irrelevant and two labels give unrelated streams.
   */
  fork(label: string): Rng {
    const h = fnv1a32(label);
    const m = splitmix32((this.a ^ h) | 0);
    const words: [number, number, number, number] = [
      (this.a ^ Math.imul(h, 0x85ebca6b)) | 0,
      (this.b ^ Math.imul(h ^ 0x9e3779b9, 0xc2b2ae35)) | 0,
      (this.c ^ m()) | 0,
      (this.d ^ m()) | 0,
    ];
    const child = new Sfc32Rng(
      words,
      this.streamLabel.length > 0 ? `${this.streamLabel}/${label}` : label,
    );
    for (let i = 0; i < WARMUP_DRAWS; i++) {
      child.nextUint32();
    }
    return child;
  }

  /**
   * Opaque serialisable state. Words are stored unsigned so JSON round-trips
   * without sign surprises. Spec 1.2.6.
   */
  save(): RngState {
    return {
      algorithm: 'sfc32',
      words: [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0],
      label: this.streamLabel,
    };
  }

  /**
   * Replace state in place. Never creates a new object, because subsystems
   * hold references to their `Rng`. Words are reloaded signed so the
   * arithmetic matches. Spec 1.2.6.
   */
  restore(state: RngState): void {
    if (state.algorithm !== 'sfc32') {
      throw new Error(`unsupported rng algorithm ${String(state.algorithm)}`);
    }
    if (state.words.length !== 4) {
      throw new Error(`rng state must hold 4 words, received ${state.words.length}`);
    }
    this.a = state.words[0] | 0;
    this.b = state.words[1] | 0;
    this.c = state.words[2] | 0;
    this.d = state.words[3] | 0;
    this.streamLabel = state.label;
  }
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

/**
 * Seed a root generator. Spec 1.2.2: the 32-bit seed is expanded by
 * splitmix32 into four state words and then warmed by discarding exactly
 * `WARMUP_DRAWS` outputs.
 *
 * Verified vector (fixture RNG-1): `createRng(0x4B54524C, 'root')` has words
 * [481119784, 3409944657, 2818634109, 3205637164] and first five `next()`
 * values 0.6523296025, 0.4470959350, 0.2026866907, 0.4280106414, 0.2385281252.
 */
export function createRng(seed: number, label: string = ROOT_STREAM_LABEL): Sfc32Rng {
  const m = splitmix32(seed | 0);
  const rng = new Sfc32Rng([m(), m(), m(), m()], label);
  for (let i = 0; i < WARMUP_DRAWS; i++) {
    rng.nextUint32();
  }
  return rng;
}

/**
 * The kernel's stream registry. Spec 1.2.5. Iteration order of the returned
 * Map is the registry order, which is also the serialisation order used by
 * `KernelSnapshot.rng`: root first, then the eleven subsystem streams.
 */
export interface StreamRegistry {
  readonly root: Sfc32Rng;
  /** Keyed by bare label, for example `scheduler`, not `root/scheduler`. */
  readonly streams: ReadonlyMap<string, Sfc32Rng>;
  /** Root plus the eleven subsystem streams, in fixed registry order. */
  ordered(): readonly Sfc32Rng[];
  save(): readonly RngState[];
  restore(states: readonly RngState[]): void;
}

export function createStreamRegistry(seed: number): StreamRegistry {
  const root = createRng(seed, ROOT_STREAM_LABEL);
  const streams = new Map<string, Sfc32Rng>();
  for (const label of SUBSYSTEM_STREAM_LABELS) {
    // fork returns the Rng interface; the concrete class is what we store so
    // that snapshot and restore can address the raw words.
    streams.set(label, root.fork(label) as Sfc32Rng);
  }
  const order: Sfc32Rng[] = [root];
  for (const label of SUBSYSTEM_STREAM_LABELS) {
    order.push(streams.get(label) as Sfc32Rng);
  }

  return {
    root,
    streams,
    ordered: () => order,
    save: () => order.map((r) => r.save()),
    restore: (states) => {
      if (states.length !== order.length) {
        throw new Error(
          `rng registry expects ${order.length} states, received ${states.length}`,
        );
      }
      for (let i = 0; i < order.length; i++) {
        const target = order[i];
        const state = states[i];
        if (target === undefined || state === undefined) {
          throw new Error(`rng registry restore: missing entry at index ${i}`);
        }
        target.restore(state);
      }
    },
  };
}
