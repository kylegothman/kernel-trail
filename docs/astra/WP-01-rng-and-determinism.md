# WP-01: RNG, event bus and the determinism fixtures

## Objective

When this package is done the repository has a working sfc32 random number
generator that matches the published test vectors bit for bit, a stream registry
that forks eleven named substreams without disturbing each other, a kernel event
bus that allocates monotonic sequence numbers and exposes `KernelEventStream`, a
canonical serialiser that turns any kernel state into a stable string, and a
determinism test file whose four cases can run (three of them will be skipped
until WP-02 provides `createKernel`). Every other kernel package draws its
randomness and emits its events through what you build here.

## Prerequisites

None. This is a wave 0 package.

Files that must already exist:

- `src/kernel/types.ts` (frozen contract, present in the repository)
- `tsconfig.json` with the path aliases
- `package.json` with `typecheck`, `test` and `build` scripts

If `src/kernel/rng.ts` exists in the repository as a reference implementation,
treat it as input to verify, then move its contents to
`src/kernel/rng/Sfc32Rng.ts` and delete the old path. If it does not exist,
write it from the specification. Either way the shipping path is
`src/kernel/rng/Sfc32Rng.ts`.

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 1 in full: 1.1 (the tick model), 1.2.1 through
  1.2.6 (the generator core, seeding, derived methods, `fork`, the stream
  registry, save and restore), 1.3 (forbidden APIs), 1.4 (the determinism test)
- `02-KERNEL-SIM-SPEC.md` section 2.1, phases only, so you know what order events
  arrive in
- `02-KERNEL-SIM-SPEC.md` section 16.1 (the reference configuration) and 16.2
  (the determinism fixture table)
- `01-ARCHITECTURE.md` section 1.4 (forbidden globals inside `src/kernel`) and
  1.6 (the kernel barrel)
- `01-ARCHITECTURE.md` section 11.2 (determinism testing)

## Files you will create

```
src/kernel/rng/Sfc32Rng.ts
src/kernel/rng/streams.ts
src/kernel/EventBus.ts
src/kernel/errors.ts
tests/kernel/canonical.ts
tests/kernel/rng.test.ts
tests/kernel/eventBus.test.ts
tests/kernel/determinism.test.ts
```

## Files you may modify

```
src/kernel/index.ts       (create it if absent; export only what section 1.6 lists)
```

Nothing else. `src/kernel/types.ts` is frozen and read-only.

**Path reconciliation, decided after the first implementation attempt.** The
scaffold shipped `src/kernel/rng.ts` while this list names `src/kernel/rng/`.
Folding the generator into the existing `rng.ts` was correct, but leaving
`src/kernel/rng/streams.ts` beside it creates a file and a directory with the
same name. `@kernel/rng` currently resolves to `rng.ts` in tsc, vite and vitest,
so it works, and it stops working the day anyone adds `src/kernel/rng/index.ts`.
Resolve it one of two ways and say which you chose:

- consolidate into the folder: `src/kernel/rng/index.ts` holds the generator,
  `src/kernel/rng/streams.ts` stays, and the bare `rng.ts` goes away; or
- consolidate into the file: `streams.ts` moves to `src/kernel/rngStreams.ts`
  and the `rng/` directory goes away.

Either is acceptable. A file shadowing a directory is not.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
/** Discrete simulation time. Monotonic, integer, starts at 0. Never wall-clock. */
export type Tick = Brand<number, 'Tick'>;

export const asTick = (n: number): Tick => n as Tick;

/**
 * Seeded PRNG. The ONLY source of randomness permitted inside src/kernel.
 * Implementations must be pure functions of their internal state so that a run
 * can be replayed exactly from its seed.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** Uniformly select one element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher-Yates. Returns the same array for chaining. */
  shuffle<T>(items: T[]): T[];
  /** Fork an independent stream, so adding a subsystem cannot shift others. */
  fork(label: string): Rng;
  /** Opaque serialisable state, for save files and replay. */
  save(): RngState;
  restore(state: RngState): void;
}

export interface RngState {
  readonly algorithm: 'sfc32';
  readonly words: readonly [number, number, number, number];
  readonly label: string;
}

export interface KernelEventStream {
  on<T extends KernelEventType>(type: T, handler: (e: KernelEventOf<T>) => void): Unsubscribe;
  onAny(handler: (e: KernelEvent) => void): Unsubscribe;
  /** Events emitted during the most recent step, in order. */
  readonly lastFrame: readonly KernelEvent[];
}

export type Unsubscribe = () => void;

export type KernelEventType = KernelEvent['type'];
export type KernelEventOf<T extends KernelEventType> = Extract<KernelEvent, { type: T }>;
```

`KernelEvent` itself is a 48-variant discriminated union in `types.ts`. Do not
paste it, do not re-declare it, do not add a variant. Every variant extends:

```ts
interface EventBase {
  readonly tick: Tick;
  /** Monotonic across the whole run. Used to order and to dedupe on replay. */
  readonly seq: number;
}
```

## Specification

### 1. `src/kernel/errors.ts`

Create two error classes and nothing else.

```ts
export class KernelInvariantError extends Error {
  constructor(
    readonly invariant: number,
    message: string,
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>,
  ) { ... }
}

export class KernelConfigError extends Error { ... }
```

`KernelInvariantError.name` must be the literal string `'KernelInvariantError'`
so tests can match it without importing the class. Both classes set
`Object.setPrototypeOf(this, new.target.prototype)` in the constructor, because
the ES2022 target plus a subclassed `Error` otherwise breaks `instanceof`.

`detail` accepts only primitives. It must never hold a PCB, a frame, or anything
mutable, because the error is serialised into a diagnostics bundle.

### 2. `src/kernel/rng/Sfc32Rng.ts`

Implement exactly the algorithm in sim spec 1.2.1. Copy the generator core
character for character:

```ts
function sfc32Next(s: Sfc32State): number {
  let { a, b, c, d } = s;
  a |= 0; b |= 0; c |= 0; d |= 0;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  s.a = a; s.b = b; s.c = c; s.d = d;
  return t >>> 0;
}
```

Every `| 0` and `>>> 0` is load-bearing. Dropping one produces a generator that
agrees with this one for a while and then diverges, which is the worst possible
failure mode for a determinism contract. Do not "simplify" the expression, do not
hoist the coercions, do not use `Math.trunc`.

`next()` returns `sfc32Next(state) / 4294967296`. Write the divisor as that
literal. Do not write `2 ** 32` and do not write `Math.pow(2, 32)`.

Seeding, from sim spec 1.2.2: expand the 32-bit seed with splitmix32 into four
words, then discard exactly 12 outputs as warm-up. Both the splitmix32 body and
the warm-up count are normative.

```ts
function splitmix32(seed: number): () => number {
  let z = seed | 0;
  return () => {
    z = (z + 0x9e3779b9) | 0;
    let t = z ^ (z >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function createRng(seed: number, label = 'root'): Rng {
  const m = splitmix32(seed | 0);
  const rng = new Sfc32Rng([m(), m(), m(), m()], label);
  for (let i = 0; i < 12; i++) rng.nextUint32();
  return rng;
}
```

Derived methods, from sim spec 1.2.3, exactly as written there:

- `int(lo, hi)` throws `RangeError('int: non-integer bound')` when either bound
  is not an integer, and `RangeError('int: empty range')` when `hi <= lo`.
  Returns `lo + Math.floor(this.next() * (hi - lo))`.
- `chance(p)` is `this.next() < p`, strict `<`, so `chance(0)` is always false
  and `chance(1)` is always true.
- `pick(items)` throws `RangeError('pick: empty array')` on an empty array,
  otherwise returns `items[this.int(0, items.length)]`. Under
  `noUncheckedIndexedAccess` this needs an explicit undefined check that throws
  a `KernelInvariantError`; the index is provably in range, so the throw is
  unreachable and should say so in a comment.
- `shuffle(items)` is Fisher-Yates iterating **descending** from
  `items.length - 1` down to 1, drawing exactly `length - 1` numbers with
  `this.int(0, i + 1)`. The direction is normative: an ascending variant consumes
  the same count and produces a different permutation.

`fork(label)`, from sim spec 1.2.4, has two properties that are separately
tested:

- **F1.** Forking must not advance the parent. `fork` reads the parent's words
  and never calls `sfc32Next` on the parent.
- **F2.** The child stream is a pure function of the parent state and the label,
  so fork order does not matter.

```ts
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

fork(label: string): Rng {
  const h = fnv1a32(label);
  const m = splitmix32((this.a ^ h) | 0);
  const words: [number, number, number, number] = [
    (this.a ^ Math.imul(h, 0x85ebca6b)) | 0,
    (this.b ^ Math.imul(h ^ 0x9e3779b9, 0xc2b2ae35)) | 0,
    (this.c ^ m()) | 0,
    (this.d ^ m()) | 0,
  ];
  const child = new Sfc32Rng(words, this.label ? `${this.label}/${label}` : label);
  for (let i = 0; i < 12; i++) child.nextUint32();
  return child;
}
```

Labels are restricted by convention to ASCII `[a-z0-9_]`. Throw
`RangeError('fork: label must match /^[a-z0-9_]+$/')` on anything else, so a
surrogate pair can never enter `fnv1a32`.

`save()` and `restore()`, from sim spec 1.2.6: words are stored unsigned with
`>>> 0` and reloaded signed with `| 0`. `restore` throws
`` new Error(`unsupported rng algorithm ${state.algorithm}`) `` on a mismatch.
`restore` replaces state in place and does not construct a new object, because
subsystems hold references to their `Rng`.

Expose `nextUint32(): number` as a public method on the class (not on the `Rng`
interface, which is frozen). WP-06's random replacement policy and the test file
both use it.

### 3. `src/kernel/rng/streams.ts`

The stream registry from sim spec 1.2.5.

```ts
export const STREAM_LABELS = [
  'process', 'scheduler', 'memory', 'vm', 'sync',
  'deadlock', 'storage', 'io', 'fs', 'security', 'events',
] as const;

export type StreamLabel = typeof STREAM_LABELS[number];

export interface StreamRegistry {
  readonly root: Rng;
  stream(label: StreamLabel): Rng;
  /** All twelve states, root first, then STREAM_LABELS order. */
  saveAll(): readonly RngState[];
  restoreAll(states: readonly RngState[]): void;
}

export function createStreams(seed: number): StreamRegistry;
```

All eleven substreams are forked at construction, in `STREAM_LABELS` order,
whether or not the subsystem appears in `KernelConfig.enabledSubsystems`. That is
what makes fixture `DET-D3` pass: enabling a subsystem for one leg must not
change any other leg's stream.

`saveAll()` returns twelve `RngState` objects: the root at index 0, then the
eleven substreams in `STREAM_LABELS` order. `restoreAll` requires exactly twelve
entries in that order and throws `KernelConfigError` otherwise. It calls
`restore` on the existing objects, never replacing them.

`stream()` throws on an unknown label rather than lazily forking one, because a
lazily forked stream would depend on call order.

### 4. `src/kernel/EventBus.ts`

```ts
export interface EventEmitter {
  /** Assigns tick and seq, appends to the frame, dispatches synchronously. */
  emit(event: EmittableEvent): void;
  /** Clears the frame buffer in place. Called at the top of step(). */
  beginFrame(): void;
  readonly stream: KernelEventStream;
  readonly seq: number;
  /** Restore path only. Sets the sequence counter. */
  setSeq(seq: number): void;
  setTick(tick: Tick): void;
}
```

`EmittableEvent` is the payload without the `EventBase` fields, derived from the
frozen union so it stays in step automatically:

```ts
export type EmittableEvent = {
  [T in KernelEventType]: Omit<KernelEventOf<T>, 'tick' | 'seq'>
}[KernelEventType];
```

Behaviour:

1. `emit` stamps `tick` from the emitter's current tick and `seq` from a counter
   that increments on **every** emit and is never reset by `restore`, because
   `KernelSnapshot.seq` carries it. The first event of a run has `seq` 0.
2. The stamped event is appended to the frame array, then dispatched: typed
   handlers registered for that exact `type` first, in registration order, then
   `onAny` handlers, in registration order.
3. `beginFrame()` sets `frame.length = 0`. It does not allocate a new array,
   because `KernelEventStream.lastFrame` is a stable reference that a renderer
   may hold across frames.
4. A handler that throws must not corrupt the bus. Catch, record the failure in
   an internal list, and continue dispatching to the remaining handlers. Expose
   the failures as `readonly handlerFailures: readonly { name: string; error: unknown }[]`
   for the tests. Do not use `console`.
5. Unsubscribing from inside a handler must be safe. Iterate a snapshot of the
   handler array, or use an index-based loop with a tombstone. Adding a handler
   from inside a handler must not deliver the current event to the new handler.
6. `emit` must not allocate beyond the single stamped event object. No
   intermediate arrays, no spread of the handler list in the common path. This is
   called several hundred times per tick on the Drowned Reach.

The `stream` property is a `KernelEventStream` whose `lastFrame` is the same
array `emit` appends to.

### 5. `tests/kernel/canonical.ts`

The deterministic serialiser described in sim spec 1.4. It is the only place in
the test suite allowed to walk kernel state structurally.

```ts
export function canonical(value: unknown): string;
export function hash(s: string): string;   // FNV-1a 32-bit, 8 lowercase hex chars
export function strip<T extends string>(...keys: T[]): (o: object) => object;
```

`canonical` rules, all of them normative:

- Object keys sorted lexicographically by code unit.
- `undefined` properties dropped entirely.
- Numbers: assert `Number.isFinite` and throw naming the path if not; render with
  `Number.prototype.toString()`; render `-0` as `0`.
- `Map` renders as a key-sorted array of `[key, value]` pairs.
- `Set` renders as a sorted array of its values.
- Arrays keep their order.
- Functions, symbols and class instances that are not `Map`/`Set` throw, naming
  the path. That throw is the point: it catches a policy object that leaked into
  a snapshot.
- Strings are JSON-escaped.

`hash` is FNV-1a 32-bit over the canonical string, formatted as 8 lowercase hex
characters with leading zeros.

`strip('seq')` returns a function that shallow-copies an object without the named
keys, used by fixture `DET-D3`.

### 6. `src/kernel/index.ts`

Create the barrel with exactly these exports and no others for now:

```ts
export * from './types';
export { createRng } from './rng/Sfc32Rng';
export { KernelInvariantError, KernelConfigError } from './errors';
```

WP-02 adds `createKernel`. WP-03, WP-05, WP-09 add their registries. Do not
add placeholders for them.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `tests/kernel/rng.test.ts` passes, including every numeric value in sim spec
   fixtures `RNG-1`, `RNG-2`, `RNG-2b`, `RNG-2c`, `RNG-3` and `RNG-4`.
5. A grep for `Math.random`, `Date.now`, `performance`, `console`, `setTimeout`,
   `window`, `document`, `globalThis` under `src/kernel/` returns zero matches.
   The test file `tests/kernel/determinism.test.ts` performs this check by
   reading the source files, so it is enforced rather than manual.
6. `tests/kernel/eventBus.test.ts` passes all cases listed below.
7. `canonical()` applied twice to the same value returns identical strings, and
   applied to two structurally equal objects with keys inserted in different
   orders returns identical strings.
8. `canonical()` throws when handed an object containing a function, and the
   thrown message contains the property path.
9. `EventBus.emit` allocates at most one object per call. Verified by a test that
   emits 100,000 events into a bus with one no-op handler and asserts the
   elapsed `performance.now()` delta is under 250 ms in the test file. The test
   file may use `performance.now`; the kernel may not.
10. `tests/kernel/determinism.test.ts` exists with all four cases D1 to D4
    written. D1, D2 and D4 are marked `test.skip` with the comment
    `// TODO(astra): enable when WP-02 lands createKernel`. D3 is also skipped.
    The forbidden-identifier scan in the same file is **not** skipped and runs.
11. Zero `// TODO(astra):` markers outside the four skipped determinism cases.
12. `src/kernel/types.ts` is byte-identical to its state before this package
    started. Verified by `git diff --exit-code src/kernel/types.ts`.

## Tests you must write

### `tests/kernel/rng.test.ts`

| Case | Assertion |
|---|---|
| `RNG-1 state` | `createRng(0x4B54524C, 'root').save().words` deep-equals `[481119784, 3409944657, 2818634109, 3205637164]` |
| `RNG-1 draws` | the first five `next()` values from that generator equal `0.6523296025, 0.4470959350, 0.2026866907, 0.4280106414, 0.2385281252`, each to 10 decimal places (`toBeCloseTo(expected, 10)`) |
| `RNG-2 scheduler fork` | `createRng(1234, 'root').fork('scheduler')` first five = `0.7590017407, 0.1837793530, 0.0627553733, 0.4116676911, 0.8262647619` |
| `RNG-2b memory fork` | same root, `fork('memory')` first five = `0.9880230038, 0.1402625744, 0.6085327168, 0.9143000133, 0.2004204346` |
| `RNG-2c fork order F1/F2` | from a fresh `createRng(1234, 'root')`, fork in the order `memory`, `scheduler`, `io`; the `scheduler` and `memory` first-five sequences are identical to the two rows above, and the root's `save().words` deep-equals a freshly seeded `createRng(1234, 'root').save().words` |
| `RNG-3 save/restore` | `createRng(7, 'x')` first three = `0.9808979158, 0.9695635808, 0.6098223559`; `save().words` deep-equals `[1146746946, 1846046223, 117364893, 1648156502]`; next three = `0.0805552991, 0.0603317665, 0.0445723657`; after `restore` of the saved state, three more draws reproduce that same last row exactly |
| `RNG-4 uniformity` | 1,000,000 draws from `createRng(99, 't')` bucketed into 10 equal bins gives chi-square `8.230` with 9 degrees of freedom, asserted `toBeCloseTo(8.230, 3)` |
| `shuffle direction` | `createRng(42, 's').shuffle([0,1,2,3,4,5,6,7])` consumes exactly 7 draws; assert by comparing the generator's word state against a generator advanced 7 times |
| `int bounds` | `int(3, 3)` throws `RangeError`; `int(1.5, 4)` throws `RangeError`; 10,000 draws of `int(-5, 5)` all satisfy `-5 <= n < 5` |
| `chance edges` | `chance(0)` is false 10,000 times; `chance(1)` is true 10,000 times |
| `pick empty` | `pick([])` throws `RangeError` |
| `fork label validation` | `fork('Scheduler')` throws; `fork('sched-1')` throws; `fork('sched_1')` does not |
| `restore algorithm guard` | restoring a state whose `algorithm` is not `'sfc32'` throws with a message containing the offending value |
| `streams registry` | `createStreams(1234).saveAll()` has length 12; index 0 has label `'root'`; index 1 has label `'root/process'`; index 11 has label `'root/events'` |
| `streams isolation` | `createStreams(1234).stream('scheduler')` first five equal the `RNG-2` row, proving the registry forks from an unadvanced root |

### `tests/kernel/eventBus.test.ts`

| Case | Assertion |
|---|---|
| `seq monotonic` | 50 emits produce `seq` 0 through 49 with no gaps |
| `seq survives beginFrame` | after `beginFrame()`, the next emit has `seq` 50, not 0 |
| `tick stamping` | after `setTick(asTick(7))`, an emitted event has `tick === 7` |
| `lastFrame identity` | `stream.lastFrame` is the same array object before and after `beginFrame()` |
| `lastFrame contents` | after `beginFrame()` and three emits, `lastFrame.length === 3` and the entries are in emit order |
| `typed subscription` | `on('process.created', h)` delivers only `process.created` events to `h`, and `h` receives a value whose `name` field is accessible without a cast |
| `onAny ordering` | with one typed and one `onAny` handler registered, the typed one fires first |
| `unsubscribe` | the returned `Unsubscribe` stops delivery, and calling it twice is a no-op |
| `unsubscribe during dispatch` | a handler that unsubscribes a later handler during its own call does not throw and the later handler does not receive that event |
| `add during dispatch` | a handler that subscribes a new handler during its own call does not deliver the current event to the new one |
| `throwing handler` | a handler that throws does not prevent the remaining handlers from receiving the event, and the failure appears in `handlerFailures` |
| `emit cost` | 100,000 emits with one no-op handler complete in under 250 ms |

### `tests/kernel/determinism.test.ts`

Write all four cases from sim spec 1.4 verbatim (D1, D2, D3, D4), each marked
`test.skip` with `// TODO(astra): enable when WP-02 lands createKernel`. Also
write, unskipped:

| Case | Assertion |
|---|---|
| `forbidden identifiers` | reading every `.ts` file under `src/kernel/` and matching against the forbidden list from architecture 1.4 produces zero hits. Read files with `node:fs` and blank comments before matching, via `stripComments(source, false)` from `tests/kernel/sourceScan.ts`. Keep string literals, so computed access like `Math['random']` is still caught. The rule governs code: the frozen `types.ts` and `Kernel.ts` headers state the prohibition in prose and must not be flagged |
| `no three import` | no file under `src/kernel/` contains an import specifier starting with `three` |
| `canonical stability` | `canonical(x) === canonical(x)` for a nested fixture containing a `Map`, a `Set`, an array and a `-0` |
| `canonical key order` | two objects with the same entries inserted in different orders serialise identically |
| `canonical rejects functions` | `canonical({ a: { b: () => 1 } })` throws with a message containing `a.b` |
| `canonical rejects NaN` | `canonical({ a: [1, NaN] })` throws with a message containing `a.1` |
| `hash format` | `hash('')` and `hash('abc')` each match `/^[0-9a-f]{8}$/` and differ from each other |

## Out of scope

Do not create, modify or stub any of the following. Other packages own them.

- `src/kernel/Kernel.ts`, `src/kernel/process/`, `src/kernel/scheduler/`,
  `src/kernel/memory/`, `src/kernel/sync/`, `src/kernel/deadlock/`,
  `src/kernel/storage/`, `src/kernel/io/`, `src/kernel/fs/`,
  `src/kernel/security/`, `src/kernel/syscall/`
- Anything under `src/game/`, `src/world/`, `src/render/`, `src/ui/`,
  `src/design/`, `src/platform/`, `src/audio/`, `src/terminal/`, `src/legs/`
- `src/kernel/types.ts` and `src/game/types.ts`, which are frozen
- `package.json` scripts. If a script you need is missing, report it.

Do not implement the invariant checks. WP-11 owns `src/kernel/invariants.ts`.
This package only provides the error class they throw.

## Report back

State:

1. Pass or fail for each of the twelve acceptance criteria, by number.
2. The three verification command outcomes.
3. The exact chi-square value your `RNG-4` test produced, to four decimal places,
   and whether it matched `8.230` within tolerance. If it did not, do not adjust
   the tolerance: report the divergence, because it means the generator does not
   match the reference.
4. Whether `src/kernel/rng.ts` was present as a reference implementation, and if
   so, whether it matched the specification before you moved it. Name any line
   where it differed.
5. Every `// TODO(astra):` left in the tree, with file and line.
6. The measured milliseconds for the 100,000-emit test.
