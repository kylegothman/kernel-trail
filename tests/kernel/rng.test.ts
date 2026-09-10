/**
 * Fixtures RNG-1, RNG-2, RNG-2b, RNG-2c and RNG-3 from sim spec 16.2.
 *
 * Every expected value in this file was produced by running the algorithm, not
 * by reading it off the specification. They agree with sim spec 1.2.2, 1.2.4
 * and 1.2.6 to all ten published decimal places.
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
    for (let i = 0; i < 5000; i++) {
      const v = rng.int(3, 11);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(11);
    }
    expect(() => rng.int(4, 4)).toThrow(RangeError);
    expect(() => rng.int(0, 1.5)).toThrow(RangeError);
  });

  it('chance(0) is never true and chance(1) is always true', () => {
    const rng = createRng(9, 'chance');
    for (let i = 0; i < 2000; i++) {
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
    const vm = root.fork('vm') as Sfc32Rng;
    expect(vm.save().label).toBe('root/vm');
    expect((vm.fork('clock') as Sfc32Rng).save().label).toBe('root/vm/clock');
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
    const bad = { algorithm: 'xoshiro', words: [1, 2, 3, 4], label: 'y' } as unknown as RngState;
    expect(() => rng.restore(bad)).toThrow(/unsupported rng algorithm/);
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
