/**
 * KERNEL TRAIL - the typed observable store. Architecture section 4.3.
 *
 * No React, no Zustand, no Redux, no signals library. The requirements are
 * narrow: one mutable root object, a version counter, selector subscriptions
 * with custom equality, and a single flush per frame so listeners never see a
 * half-updated frame.
 *
 * Three decisions worth restating, because each is load bearing:
 *
 *  - The root is mutated in place. `RunState.convoy` is five objects updated
 *    many times a second and there is no virtual DOM to diff against, so a new
 *    object graph per mutation would allocate constantly for no benefit.
 *  - `mutate` throws if called during `flush`. A listener writing back into the
 *    store is a re-entrancy hazard whose ordering depends on iteration order.
 *    An error at the first occurrence beats a heisenbug in leg 9.
 *  - Flush is synchronous, once per frame, at a known point (GameLoop
 *    `flushState`), so the HUD and the world see identical state within a frame.
 */

export type Unsubscribe = () => void;
export type Equality<S> = (a: S, b: S) => boolean;

export interface Store<T extends object> {
  /** The live root. Treat as readonly outside `mutate`. */
  get(): Readonly<T>;
  /** Increments on every committed mutation. Cheap change detection. */
  readonly version: number;
  /** Mutate the root in place. Changes are published on the next `flush`. */
  mutate(recipe: (draft: T) => void): void;
  /** Subscribe to a derived slice. Fires on flush when the slice changes. */
  watch<S>(
    select: (s: Readonly<T>) => S,
    on: (next: S, prev: S) => void,
    eq?: Equality<S>,
  ): Unsubscribe;
  /** Subscribe to every commit. Use sparingly; prefer `watch`. */
  subscribe(on: (s: Readonly<T>, version: number) => void): Unsubscribe;
  /** Publish queued changes. Called once per frame by the game loop. */
  flush(): void;
}

interface Watcher<T> {
  readonly select: (s: Readonly<T>) => unknown;
  readonly on: (next: never, prev: never) => void;
  readonly eq: Equality<unknown>;
  last: unknown;
  dead: boolean;
}

const strictEq = (a: unknown, b: unknown): boolean => Object.is(a, b);

export function createStore<T extends object>(initial: T): Store<T> {
  const root = initial;
  let version = 0;
  let dirty = false;
  let flushing = false;
  const watchers = new Set<Watcher<T>>();
  const subscribers = new Set<(s: Readonly<T>, v: number) => void>();

  const store: Store<T> = {
    get: () => root,
    get version() {
      return version;
    },

    mutate(recipe) {
      if (flushing) throw new Error('store.mutate() during flush: listeners must not write.');
      recipe(root);
      version += 1;
      dirty = true;
    },

    watch<S>(select: (s: Readonly<T>) => S, on: (next: S, prev: S) => void, eq?: Equality<S>) {
      const watcher: Watcher<T> = {
        select: select as (s: Readonly<T>) => unknown,
        on: on as (next: never, prev: never) => void,
        eq: (eq ?? strictEq) as Equality<unknown>,
        last: select(root),
        dead: false,
      };
      watchers.add(watcher);
      return () => {
        watcher.dead = true;
        watchers.delete(watcher);
      };
    },

    subscribe(on) {
      subscribers.add(on);
      return () => {
        subscribers.delete(on);
      };
    },

    flush() {
      if (!dirty) return;
      dirty = false;
      flushing = true;
      try {
        for (const w of watchers) {
          if (w.dead) continue;
          const next = w.select(root);
          if (w.eq(next, w.last)) continue;
          const prev = w.last;
          w.last = next;
          (w.on as (next: unknown, prev: unknown) => void)(next, prev);
        }
        for (const s of subscribers) s(root, version);
      } finally {
        flushing = false;
      }
    },
  };
  return store;
}

/** Shallow array equality, for selectors that return `readonly Pid[]`. */
export const shallowArrayEq = <S>(a: readonly S[], b: readonly S[]): boolean =>
  a === b || (a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
