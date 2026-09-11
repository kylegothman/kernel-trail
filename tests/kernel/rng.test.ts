/**
 * Fixtures RNG-1, RNG-2, RNG-2b, RNG-2c, RNG-3 and RNG-4 from sim spec 16.2.
 *
 * Published decimal values are asserted to all ten places without widening
 * the tolerance. The uint32 sequence was recorded by the scaffold.
 */

import { describe, expect, it } from 'vitest';
import {
  createRng,
  createStreamRegistry,
  fnv1a32,
  ROOT_STREAM_LABEL,
  SUBSYSTEM_STREAM_LABELS,
  Sfc32Rng,
  splitmix32,
  WARMUP_DRAWS,
} from '@kernel/rng';
import type { RngState } from '@kernel/types';
import { KernelConfigError, KernelInvariantError } from '@kernel/errors';
import { createStreams, STREAM_LABELS } from '@kernel/rng/streams';

/** Ten decimal places, matching how the spec publishes its vectors. */
const draws = (rng: { next(): number }, n: number): string[] =>
  Array.from({ length: n }, () => rng.next().toFixed(10));

describe('RNG-1: seeding and the generator core', () => {
  it('produces the published state after splitmix32 seeding and 12 warm-up draws', () => {
    const rng = createRng(0x4b54524c, ROOT_STREAM_LABEL);
    expect(rng.save().words).toEqual([481119784, 3409944657, 2818634109, 3205637164]);
    expect(rng.save().algorithm).toBe('sfc32');
    expect(rng.save().label).toBe('root');
  });

  it('produces the published first five next() values', () => {
    const rng = createRng(0x4b54524c, ROOT_STREAM_LABEL);
    expect(draws(rng, 5)).toEqual([
      '0.6523296025',
      '0.4470959350',
      '0.2026866907',
      '0.4280106414',
      '0.2385281252',
    ]);
  });

  it('produces the matching uint32 sequence', () => {
    const rng = createRng(0x4b54524c, ROOT_STREAM_LABEL);
    expect([
      rng.nextUint32(),
      rng.nextUint32(),
      rng.nextUint32(),
      rng.nextUint32(),
      rng.nextUint32(),
    ]).toEqual([2801734309, 1920262419, 870532708, 1838291707, 1024470497]);
  });

  it('warms up by exactly WARMUP_DRAWS, which is 12', () => {
    expect(WARMUP_DRAWS).toBe(12);
    // Reconstruct the pre-warm-up state by hand and step it 12 times.
    const m = splitmix32(0x4b54524c | 0);
    const raw = new Sfc32Rng([m(), m(), m(), m()], ROOT_STREAM_LABEL);
    for (let i = 0; i < 12; i++) raw.nextUint32();
    expect(raw.save().words).toEqual(createRng(0x4b54524c, ROOT_STREAM_LABEL).save().words);
  });

  it('keeps next() strictly inside [0, 1)', () => {
    const rng = createRng(12345, 'range');
    for (let i = 0; i < 20000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('derived methods, sim spec 1.2.3', () => {
  it('int stays in range and rejects a bad range', () => {
    const rng = createRng(5, 'int');
    for (let i = 0; i < 10000; i++) {
      const v = rng.int(-5, 5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
    }
    expect(() => rng.int(4, 4)).toThrow(RangeError);
    expect(() => rng.int(0, 1.5)).toThrow(RangeError);
    expect(() => rng.int(3, 3)).toThrow('int: empty range');
    expect(() => rng.int(1.5, 4)).toThrow('int: non-integer bound');
  });

  it('chance(0) is never true and chance(1) is always true', () => {
    const rng = createRng(9, 'chance');
    for (let i = 0; i < 10000; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  it('pick throws on an empty array', () => {
    const rng = createRng(11, 'pick');
    expect(() => rng.pick([])).toThrow(RangeError);
    expect(['a', 'b', 'c']).toContain(rng.pick(['a', 'b', 'c']));
  });

  it('shuffle draws exactly length - 1 numbers and permutes in place', () => {
    const counted = createRng(21, 'shuffle');
    let calls = 0;
    const original = counted.next.bind(counted);
    counted.next = (): number => {
      calls += 1;
      return original();
    };
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const returned = counted.shuffle(items);
    expect(returned).toBe(items);
    expect(calls).toBe(items.length - 1);
    expect([...items].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('shuffle is reproducible from the same seed', () => {
    const a = createRng(777, 's').shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const b = createRng(777, 's').shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(b).toEqual(a);
  });

  it('shuffle direction is descending and seed 42 advances exactly seven draws', () => {
    const rng = createRng(42, 's');
    const bounds: number[] = [];
    const original = rng.int.bind(rng);
    rng.int = (lo, hi): number => {
      expect(lo).toBe(0);
      bounds.push(hi);
      return original(lo, hi);
    };
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(rng.shuffle(items)).toBe(items);
    expect(bounds).toEqual([8, 7, 6, 5, 4, 3, 2]);
    const reference = createRng(42, 's');
    for (let i = 0; i < 7; i++) reference.next();
    expect(rng.save()).toEqual(reference.save());
  });

  it('pick guards undefined selections with KernelInvariantError', () => {
    expect(() => createRng(11).pick([undefined])).toThrow(KernelInvariantError);
  });

  it('shuffle preserves undefined elements permitted by its generic contract', () => {
    const rng = createRng(42, 's');
    const before = createRng(42, 's');
    before.next();
    const items = [undefined, 1];
    expect(rng.shuffle(items)).toBe(items);
    expect(items).toContain(undefined);
    expect(items).toContain(1);
    expect(rng.save()).toEqual(before.save());
  });

  it('empty and singleton shuffles do not draw', () => {
    const rng = createRng(42, 's');
    const before = rng.save();
    expect(rng.shuffle([])).toEqual([]);
    expect(rng.shuffle([7])).toEqual([7]);
    expect(rng.save()).toEqual(before);
  });
});

describe('RNG-2: fork derivation, sim spec 1.2.4', () => {
  it('fork("scheduler") from seed 1234 gives the published sequence', () => {
    const root = createRng(1234, ROOT_STREAM_LABEL);
    expect(draws(root.fork('scheduler'), 5)).toEqual([
      '0.7590017407',
      '0.1837793530',
      '0.0627553733',
      '0.4116676911',
      '0.8262647619',
    ]);
  });

  it('RNG-2b: fork("memory") from seed 1234 gives the published sequence', () => {
    const root = createRng(1234, ROOT_STREAM_LABEL);
    expect(draws(root.fork('memory'), 5)).toEqual([
      '0.9880230038',
      '0.1402625744',
      '0.6085327168',
      '0.9143000133',
      '0.2004204346',
    ]);
  });

  it('F1: forking does not advance the parent', () => {
    const root = createRng(1234, ROOT_STREAM_LABEL);
    const before = root.save().words;
    root.fork('memory');
    root.fork('scheduler');
    root.fork('io');
    expect(root.save().words).toEqual(before);
    expect(root.save().words).toEqual(createRng(1234, ROOT_STREAM_LABEL).save().words);
  });

  it('RNG-2c: F2, fork order does not change any stream', () => {
    // Take the forks in a different order and interleave an extra one, which is
    // what "adding a subsystem" looks like.
    const root = createRng(1234, ROOT_STREAM_LABEL);
    const memory = root.fork('memory');
    const scheduler = root.fork('scheduler');
    root.fork('io');

    expect(draws(scheduler, 5)).toEqual([
      '0.7590017407',
      '0.1837793530',
      '0.0627553733',
      '0.4116676911',
      '0.8262647619',
    ]);
    expect(draws(memory, 5)).toEqual([
      '0.9880230038',
      '0.1402625744',
      '0.6085327168',
      '0.9143000133',
      '0.2004204346',
    ]);
  });

  it('different labels give unrelated streams', () => {
    const root = createRng(1234, ROOT_STREAM_LABEL);
    const a = draws(root.fork('scheduler'), 8);
    const b = draws(root.fork('memory'), 8);
    expect(a).not.toEqual(b);
    expect(fnv1a32('scheduler')).not.toBe(fnv1a32('memory'));
  });

  it('child labels are the slash-joined path', () => {
    const root = createRng(1234, ROOT_STREAM_LABEL);
    const vm = root.fork('vm');
    expect(vm.save().label).toBe('root/vm');
    expect(vm.fork('clock').save().label).toBe('root/vm/clock');
  });

  it('fork label validation rejects non-ASCII labels without advancing the parent', () => {
    const root = createRng(1234);
    const before = root.save();
    for (const label of ['', 'Scheduler', 'sched-1', 'a/b', 'a b', 'a\n', '\u00e9', '\ud83c\udf32']) {
      expect(() => root.fork(label)).toThrow('fork: label must match /^[a-z0-9_]+$/');
    }
    expect(() => root.fork('sched_1')).not.toThrow();
    expect(root.save()).toEqual(before);
  });

  it('fnv1a32 matches the reference offset basis and prime', () => {
    // FNV-1a of the empty string is the offset basis itself.
    expect(fnv1a32('')).toBe(0x811c9dc5);
    // Published FNV-1a 32 vector for "a".
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
});

describe('RNG-3: save and restore, sim spec 1.2.6', () => {
  it('round-trips through save/restore', () => {
    const rng = createRng(7, 'x');
    expect(draws(rng, 3)).toEqual(['0.9808979158', '0.9695635808', '0.6098223559']);

    const state = rng.save();
    expect(state.words).toEqual([1146746946, 1846046223, 117364893, 1648156502]);

    const expectedTail = ['0.0805552991', '0.0603317665', '0.0445723657'];
    expect(draws(rng, 3)).toEqual(expectedTail);

    // Restoring that state and drawing three more reproduces the last row.
    rng.restore(state);
    expect(draws(rng, 3)).toEqual(expectedTail);

    // And so does a completely separate generator restored from it.
    const other = createRng(999999, 'unrelated');
    other.restore(state);
    expect(draws(other, 3)).toEqual(expectedTail);
    expect(other.save().label).toBe('x');
  });

  it('stores words unsigned and reloads them signed', () => {
    const rng = createRng(0xdeadbeef, 'signs');
    for (const word of rng.save().words) {
      expect(word).toBeGreaterThanOrEqual(0);
      expect(word).toBeLessThanOrEqual(0xffffffff);
    }
    // A JSON round trip must not change behaviour.
    const viaJson = JSON.parse(JSON.stringify(rng.save())) as RngState;
    const clone = createRng(1, 'clone');
    clone.restore(viaJson);
    expect(draws(clone, 5)).toEqual(draws(createRng(0xdeadbeef, 'signs'), 5));
  });

  it('rejects an unsupported algorithm', () => {
    const rng = createRng(1, 'y');
    const bad = rng.save();
    Reflect.set(bad, 'algorithm', 'xoshiro');
    expect(() => rng.restore(bad)).toThrow('unsupported rng algorithm xoshiro');
  });
});

describe('RNG-4: uniformity, sim spec 16.2', () => {
  it('one million draws produce chi-square 8.230 with nine degrees of freedom', () => {
    const rng = createRng(99, 't');
    const bins = Array<number>(10).fill(0);
    for (let i = 0; i < 1_000_000; i++) {
      const index = Math.floor(rng.next() * 10);
      const count = bins[index];
      if (count === undefined) throw new Error(`draw outside the ten bins: ${index}`);
      bins[index] = count + 1;
    }
    const chiSquare = bins.reduce((sum, count) => sum + (count - 100_000) ** 2 / 100_000, 0);
    console.info(`RNG-4 chi-square: ${chiSquare.toFixed(4)}`);
    expect(chiSquare).toBeCloseTo(8.230, 3);
  });
});

describe('WP-01 stream registry surface', () => {
  it('saveAll has twelve states in the exact root-first order', () => {
    const registry = createStreams(1234);
    expect(registry.saveAll().map((state) => state.label)).toEqual([
      'root', ...STREAM_LABELS.map((label) => `root/${label}`),
    ]);
    expect(registry.saveAll()).toHaveLength(12);
    expect(registry.saveAll()[1]?.label).toBe('root/process');
    expect(registry.saveAll()[11]?.label).toBe('root/events');
  });

  it('streams isolation matches RNG-2 and leaves root unadvanced', () => {
    const registry = createStreams(1234);
    registry.stream('memory').next();
    registry.stream('io').next();
    expect(draws(registry.stream('scheduler'), 5)).toEqual([
      '0.7590017407', '0.1837793530', '0.0627553733', '0.4116676911', '0.8262647619',
    ]);
    expect(registry.root.save()).toEqual(createRng(1234).save());
  });

  it('restoreAll keeps all twelve object references and reproduces their next draws', () => {
    const registry = createStreams(1234);
    const refs = [registry.root, ...STREAM_LABELS.map((label) => registry.stream(label))];
    for (const rng of refs) rng.next();
    const saved = registry.saveAll();
    const expected = refs.map((rng) => rng.next());
    registry.restoreAll(saved);
    expect(registry.root).toBe(refs[0]);
    STREAM_LABELS.forEach((label, i) => expect(registry.stream(label)).toBe(refs[i + 1]));
    expect(refs.map((rng) => rng.next())).toEqual(expected);
  });

  it('restoreAll rejects wrong count and ordering before mutating any stream', () => {
    const registry = createStreams(1);
    const initial = registry.saveAll();
    const other = createStreams(2).saveAll();
    expect(() => registry.restoreAll(other.slice(1))).toThrow(KernelConfigError);
    const reordered = [...other];
    const last = reordered.pop();
    if (last === undefined) throw new Error('missing final stream fixture');
    reordered.unshift(last);
    expect(() => registry.restoreAll(reordered)).toThrow(KernelConfigError);
    const badTail = other.map((state, i) => i === 11 ? { ...state, label: 'root/wrong' } : state);
    expect(() => registry.restoreAll(badTail)).toThrow('expects root/events at index 11');
    expect(registry.saveAll()).toEqual(initial);
  });

  it('restoreAll validates the entire algorithm and word payload before mutation', () => {
    const registry = createStreams(1);
    const before = registry.saveAll();
    const bad = createStreams(2).saveAll();
    const last = bad[11];
    if (last === undefined) throw new Error('missing final stream fixture');
    Reflect.set(last, 'algorithm', 'other');
    expect(() => registry.restoreAll(bad)).toThrow(KernelConfigError);
    expect(registry.saveAll()).toEqual(before);
    Reflect.set(last, 'algorithm', 'sfc32');
    Reflect.set(last, 'words', [0, 1, 2, NaN]);
    expect(() => registry.restoreAll(bad)).toThrow(KernelConfigError);
    expect(registry.saveAll()).toEqual(before);
  });

  it('unknown stream labels throw without lazy forking', () => {
    const registry = createStreams(1234);
    const before = registry.saveAll();
    expect(() => Reflect.apply(registry.stream, registry, ['unknown'])).toThrow(KernelConfigError);
    expect(registry.saveAll()).toEqual(before);
  });
});

describe('kernel error classes', () => {
  it('preserves Error inheritance, exact names and primitive diagnostics', () => {
    const detail = { index: 4, valid: false, expected: 'dense', value: null };
    const invariant = new KernelInvariantError(0, 'RNG guard', detail);
    expect(invariant).toBeInstanceOf(Error);
    expect(invariant).toBeInstanceOf(KernelInvariantError);
    expect(invariant.name).toBe('KernelInvariantError');
    expect(invariant.invariant).toBe(0);
    expect(invariant.detail).toEqual(detail);
    detail.index = 7;
    expect(invariant.detail?.['index']).toBe(4);
    expect(Object.isFrozen(invariant.detail)).toBe(true);
    const config = new KernelConfigError('invalid registry');
    expect(config).toBeInstanceOf(Error);
    expect(config).toBeInstanceOf(KernelConfigError);
    expect(config.name).toBe('KernelConfigError');
    expect(config.message).toBe('invalid registry');
  });
});

describe('the stream registry, sim spec 1.2.5', () => {
  it('holds the root plus eleven subsystem streams in a fixed order', () => {
    const registry = createStreamRegistry(0x4b54524c);
    expect(SUBSYSTEM_STREAM_LABELS.length).toBe(11);
    const ordered = registry.ordered();
    expect(ordered.length).toBe(12);
    expect(ordered.map((r) => r.save().label)).toEqual([
      'root',
      'root/process',
      'root/scheduler',
      'root/memory',
      'root/vm',
      'root/sync',
      'root/deadlock',
      'root/storage',
      'root/io',
      'root/fs',
      'root/security',
      'root/events',
    ]);
  });

  it('leaves the root untouched by the eleven forks', () => {
    const registry = createStreamRegistry(1234);
    expect(registry.root.save().words).toEqual(
      createRng(1234, ROOT_STREAM_LABEL).save().words,
    );
  });

  it('matches the standalone fork vectors', () => {
    const registry = createStreamRegistry(1234);
    const scheduler = registry.streams.get('scheduler');
    expect(scheduler).toBeDefined();
    expect(draws(scheduler as Sfc32Rng, 5)).toEqual([
      '0.7590017407',
      '0.1837793530',
      '0.0627553733',
      '0.4116676911',
      '0.8262647619',
    ]);
  });

  it('save and restore round-trip every stream in place', () => {
    const a = createStreamRegistry(42);
    for (const stream of a.ordered()) stream.next();
    const states = a.save();

    const b = createStreamRegistry(999);
    const identities = b.ordered();
    b.restore(states);
    // Restore replaces state in place; subsystems hold references, so the
    // objects must be the same ones afterwards.
    expect(b.ordered()).toEqual(identities);
    expect(b.save()).toEqual(states);

    for (let i = 0; i < a.ordered().length; i++) {
      const left = a.ordered()[i];
      const right = b.ordered()[i];
      expect(right).toBeDefined();
      expect(draws(right as Sfc32Rng, 4)).toEqual(draws(left as Sfc32Rng, 4));
    }
  });

  it('rejects a state array of the wrong length', () => {
    const registry = createStreamRegistry(1);
    expect(() => registry.restore(registry.save().slice(0, 5))).toThrow(/expects 12 states/);
  });
});
