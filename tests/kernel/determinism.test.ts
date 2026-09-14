/**
 * Fixtures DET-D1 to DET-D4 from sim spec 16.2, and the invariant stated at the
 * top of src/kernel/types.ts: a kernel constructed from the same KernelConfig
 * and stepped the same number of ticks produces a byte-identical event log and
 * snapshot every time.
 *
 * The four reference tests now run through the WP-02 bootstrap FCFS. Their
 * init-only snapshots exercise the retained scaffold restore path. Populated
 * workload replay is tested in stepOrder.test.ts; saving those workloads needs
 * the frozen KernelSnapshot extension reported for WP-11.
 */

import { describe, expect, it, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createKernel, InvariantViolation } from '@kernel/Kernel';
import { createRng, createStreamRegistry } from '@kernel/rng';
import { KernelEventBus } from '@kernel/EventBus';
import { checksumSafeSnapshot } from '@game/save';
import { asPid, asTick } from '@kernel/types';
import type { KernelConfig, KernelEvent, KernelSnapshot, SubsystemId } from '@kernel/types';
import { canonical, hash, strip } from './canonical';
import { stripComments } from './sourceScan';

/** The exact reference configuration from sim spec 16.1. */
const CONFIG: KernelConfig = {
  seed: 0x4b54524c,
  scheduler: 'fcfs',
  schedulerParams: {
    quantum: 4,
    levelQuanta: [4, 8, 16],
    agingInterval: 50,
    starvationThreshold: 120,
    starvationFatalThreshold: 300,
    preemptive: true,
  },
  totalFrames: 64,
  pageSize: 4096,
  replacementPolicy: 'lru',
  allocationStrategy: 'first_fit',
  tlbEntries: 16,
  diskPolicy: 'look',
  totalCylinders: 200,
  raidLevel: 5,
  fileAllocation: 'indexed',
  journalingEnabled: true,
  deadlockStrategy: 'detect',
  thrashingThreshold: 200,
  enabledSubsystems: [
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
  ],
};

/** Keep the existing executable coverage while RR is owned by WP-04. */
const REFERENCE_CONFIG: KernelConfig = { ...CONFIG, scheduler: 'fcfs' };
const TICKS = 5000;

// The scaffold uses Infinity for an unlimited budget. Preserve its existing
// save-layer projection for active snapshot tests; canonical itself rejects it.
const canonicalLog = (events: readonly KernelEvent[]): string => canonical(events);
const canonicalSnapshot = (s: KernelSnapshot): string => canonical(checksumSafeSnapshot(s));

test('D1: identical construction produces identical event logs', () => {
  const a = createKernel(CONFIG);
  const b = createKernel(CONFIG);
  const ea = a.run(TICKS);
  const eb = b.run(TICKS);
  expect(canonical(eb)).toBe(canonical(ea));
  expect(canonical(b.snapshot())).toBe(canonical(a.snapshot()));
});

test('D2: snapshot/restore mid-run is transparent', () => {
  const a = createKernel(CONFIG);
  a.run(2000);
  const snap = structuredClone(a.snapshot());
  const tailA = a.run(3000);

  const b = createKernel(CONFIG);
  b.restore(structuredClone(snap));
  const tailB = b.run(3000);

  expect(canonical(tailB)).toBe(canonical(tailA));
  expect(canonical(b.snapshot())).toBe(canonical(a.snapshot()));
});

test('D3: adding a subsystem stream does not shift existing streams', () => {
  const withoutIo = { ...CONFIG, enabledSubsystems: CONFIG.enabledSubsystems.filter(s => s !== 'io') };
  const a = createKernel(withoutIo);
  const b = createKernel(CONFIG);
  const sa = a.run(TICKS).filter(e => e.type === 'context.switch');
  const sb = b.run(TICKS).filter(e => e.type === 'context.switch');
  // Scheduling decisions are unaffected by whether the io subsystem exists,
  // for a workload that issues no I/O.
  expect(canonical(sb.map(strip('seq')))).toBe(canonical(sa.map(strip('seq'))));
});

test('D4: seed sweep is stable across runs', () => {
  for (let seed = 0; seed < 64; seed++) {
    const c = { ...CONFIG, seed };
    const h1 = hash(canonical(createKernel(c).run(1000)));
    const h2 = hash(canonical(createKernel(c).run(1000)));
    expect(h2).toBe(h1);
  }
});

describe('D1: identical construction produces identical event logs', () => {
  it('agrees byte for byte over 5000 ticks', () => {
    const a = createKernel(REFERENCE_CONFIG);
    const b = createKernel(REFERENCE_CONFIG);
    const ea = a.run(TICKS);
    const eb = b.run(TICKS);

    expect(canonicalLog(eb)).toBe(canonicalLog(ea));
    expect(canonicalSnapshot(b.snapshot())).toBe(canonicalSnapshot(a.snapshot()));
    expect(b.tick).toBe(a.tick);
    expect(a.tick).toBe(asTick(TICKS));
  });

  it('advances the tick counter by exactly one per step, starting from 0', () => {
    const k = createKernel(REFERENCE_CONFIG);
    expect(k.tick).toBe(asTick(0));
    for (let i = 1; i <= 25; i++) {
      k.step();
      expect(k.tick).toBe(asTick(i));
    }
  });

  it('exposes lastFrame as the same array object every step', () => {
    const k = createKernel(REFERENCE_CONFIG);
    const frame = k.events.lastFrame;
    k.step();
    k.step();
    expect(k.events.lastFrame).toBe(frame);
  });

  it('rejects a negative or fractional tick count', () => {
    const k = createKernel(REFERENCE_CONFIG);
    expect(() => k.run(-1)).toThrow(RangeError);
    expect(() => k.run(2.5)).toThrow(RangeError);
  });
});

describe('D2: snapshot/restore mid-run is transparent', () => {
  it('produces the same continuation from a restored snapshot', () => {
    const a = createKernel(REFERENCE_CONFIG);
    a.run(2000);
    const snap = structuredClone(a.snapshot());
    const tailA = a.run(3000);

    const b = createKernel(REFERENCE_CONFIG);
    b.restore(structuredClone(snap));
    const tailB = b.run(3000);

    expect(canonicalLog(tailB)).toBe(canonicalLog(tailA));
    expect(canonicalSnapshot(b.snapshot())).toBe(canonicalSnapshot(a.snapshot()));
    expect(b.tick).toBe(a.tick);
  });

  it('is structurally cloneable, holding no functions', () => {
    const k = createKernel(REFERENCE_CONFIG);
    k.run(37);
    expect(() => structuredClone(k.snapshot())).not.toThrow();
  });

  it('is a pure function of state: two calls with no step agree (I-40)', () => {
    const k = createKernel(REFERENCE_CONFIG);
    k.run(101);
    expect(canonicalSnapshot(k.snapshot())).toBe(canonicalSnapshot(k.snapshot()));
  });

  it('does not alias live state, so a later step cannot mutate a held snapshot', () => {
    const k = createKernel(REFERENCE_CONFIG);
    k.run(10);
    const held = canonicalSnapshot(k.snapshot());
    const snapshot = k.snapshot();
    k.run(50);
    expect(canonicalSnapshot(snapshot)).toBe(held);
  });

  it('carries seq across restore rather than resetting it (I-38)', () => {
    const a = createKernel(REFERENCE_CONFIG);
    a.run(500);
    const snap = a.snapshot();
    const b = createKernel(REFERENCE_CONFIG);
    b.restore(snap);
    expect(b.snapshot().seq).toBe(snap.seq);
  });

  it('restores every RNG stream in the fixed registry order (I-39)', () => {
    const a = createKernel(REFERENCE_CONFIG);
    a.run(120);
    const snap = a.snapshot();
    expect(snap.rng.length).toBe(12);
    expect(snap.rng.map((s) => s.label)).toEqual([
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
    for (const state of snap.rng) expect(state.algorithm).toBe('sfc32');

    const b = createKernel({ ...REFERENCE_CONFIG, seed: 999 });
    b.restore(snap);
    expect(b.snapshot().rng).toEqual(snap.rng);
  });

  it('refuses an unknown snapshot version', () => {
    const k = createKernel(REFERENCE_CONFIG);
    const snap = { ...k.snapshot(), version: 2 } as unknown as KernelSnapshot;
    expect(() => k.restore(snap)).toThrow(/unsupported snapshot version/);
  });
});

describe('D3: adding a subsystem does not shift existing streams', () => {
  it('forks all eleven streams whether or not the subsystem is enabled', () => {
    const withoutIo: KernelConfig = {
      ...REFERENCE_CONFIG,
      enabledSubsystems: REFERENCE_CONFIG.enabledSubsystems.filter(
        (s: SubsystemId) => s !== 'io',
      ),
    };
    const a = createKernel(withoutIo);
    const b = createKernel(REFERENCE_CONFIG);

    const sa = a.run(TICKS).filter((e) => e.type === 'context.switch');
    const sb = b.run(TICKS).filter((e) => e.type === 'context.switch');
    expect(canonicalLog(sb)).toBe(canonicalLog(sa));

    // The direct statement of F1: the scheduler stream is bit-identical.
    const streamOf = (snap: KernelSnapshot, label: string): readonly number[] =>
      snap.rng.find((s) => s.label === label)?.words ?? [];
    expect(streamOf(b.snapshot(), 'root/scheduler')).toEqual(
      streamOf(a.snapshot(), 'root/scheduler'),
    );
    expect(streamOf(b.snapshot(), 'root/vm')).toEqual(streamOf(a.snapshot(), 'root/vm'));
  });

  it('gives an identical registry for the same seed regardless of construction order', () => {
    const a = createStreamRegistry(1234);
    const b = createStreamRegistry(1234);
    expect(b.save()).toEqual(a.save());
  });
});

describe('D4: seed sweep is stable across runs', () => {
  it('hashes identically for 64 seeds', () => {
    for (let seed = 0; seed < 64; seed++) {
      const config: KernelConfig = { ...REFERENCE_CONFIG, seed };
      const h1 = hash(canonicalLog(createKernel(config).run(200)));
      const h2 = hash(canonicalLog(createKernel(config).run(200)));
      expect(h2).toBe(h1);
    }
  });

  it('gives a different RNG registry for a different seed', () => {
    const a = createKernel({ ...REFERENCE_CONFIG, seed: 1 }).snapshot().rng;
    const b = createKernel({ ...REFERENCE_CONFIG, seed: 2 }).snapshot().rng;
    expect(b).not.toEqual(a);
  });
});

describe('the event log is a faithful, reproducible transcript', () => {
  /**
   * The bus is complete even though the phases that feed it are not, so this
   * drives it directly from a seeded stream. It is the byte-identical-event-log
   * assertion in its strongest available form at this commit.
   */
  const transcribe = (seed: number): KernelEvent[] => {
    const bus = new KernelEventBus();
    const rng = createRng(seed, 'root').fork('events');
    const log: KernelEvent[] = [];
    bus.onAny((e) => log.push(e));

    for (let t = 1; t <= 400; t++) {
      const tick = asTick(t);
      bus.beginFrame();
      const count = rng.int(0, 4);
      for (let i = 0; i < count; i++) {
        const pid = asPid(rng.int(1, 9));
        if (rng.chance(0.5)) {
          bus.emit(tick, 'context.switch', {
            from: null,
            to: pid,
            rationale: `dispatch ${pid}`,
          });
        } else {
          bus.emit(tick, 'process.state_changed', { pid, from: 'ready', to: 'running' });
        }
      }
    }
    return log;
  };

  it('produces byte-identical logs for the same seed', () => {
    expect(canonicalLog(transcribe(4242))).toBe(canonicalLog(transcribe(4242)));
  });

  it('produces different logs for different seeds', () => {
    expect(canonicalLog(transcribe(1))).not.toBe(canonicalLog(transcribe(2)));
  });

  it('stamps a strictly increasing seq and a non-decreasing tick (I-38)', () => {
    const log = transcribe(77);
    expect(log.length).toBeGreaterThan(0);
    for (let i = 1; i < log.length; i++) {
      const prev = log[i - 1];
      const cur = log[i];
      expect(cur?.seq).toBe((prev?.seq ?? -1) + 1);
      expect(cur?.tick).toBeGreaterThanOrEqual(prev?.tick ?? 0);
    }
    expect(log[0]?.seq).toBe(0);
  });

  it('reuses the lastFrame array and truncates it per frame', () => {
    const bus = new KernelEventBus();
    const frame = bus.lastFrame;
    bus.emit(asTick(1), 'kernel.panic', { message: 'one' });
    expect(frame.length).toBe(1);
    bus.beginFrame();
    expect(frame.length).toBe(0);
    expect(bus.lastFrame).toBe(frame);
    // seq is monotonic across frames, never reset.
    bus.emit(asTick(2), 'kernel.panic', { message: 'two' });
    expect(frame[0]?.seq).toBe(1);
  });

  it('delivers to typed and any handlers, and stops after unsubscribe', () => {
    const bus = new KernelEventBus();
    const typed: number[] = [];
    const all: number[] = [];
    const offTyped = bus.on('kernel.panic', (e) => typed.push(e.seq));
    const offAny = bus.onAny((e) => all.push(e.seq));

    bus.emit(asTick(1), 'kernel.panic', { message: 'a' });
    bus.emit(asTick(1), 'process.reaped', { pid: asPid(1), by: asPid(2) });
    expect(typed).toEqual([0]);
    expect(all).toEqual([0, 1]);

    offTyped();
    offAny();
    bus.emit(asTick(2), 'kernel.panic', { message: 'b' });
    expect(typed).toEqual([0]);
    expect(all).toEqual([0, 1]);
  });

  it('unsubscribes the right handler when several are registered', () => {
    const bus = new KernelEventBus();
    const seen: string[] = [];
    bus.on('kernel.panic', () => seen.push('first'));
    const offSecond = bus.on('kernel.panic', () => seen.push('second'));
    bus.on('kernel.panic', () => seen.push('third'));

    offSecond();
    bus.emit(asTick(1), 'kernel.panic', { message: 'x' });
    expect(seen).toEqual(['first', 'third']);
  });
});

describe('the invariant harness, sim spec 15', () => {
  it('runs in dev builds and passes on a freshly constructed kernel', () => {
    const k = createKernel(REFERENCE_CONFIG, { devBuild: true });
    expect(() => k.run(200)).not.toThrow();
  });

  it('compiles out in production builds', () => {
    const k = createKernel(REFERENCE_CONFIG, { devBuild: false });
    expect(() => k.run(200)).not.toThrow();
  });

  it('I-17 and I-20: the frame table starts conserved and the free list ascending', () => {
    const k = createKernel(REFERENCE_CONFIG);
    k.step();
    const snap = k.snapshot();
    expect(snap.frames.length).toBe(REFERENCE_CONFIG.totalFrames);
    for (const frame of snap.frames) expect(frame.owner).toBeNull();
    expect(snap.frames.map((f) => f.id)).toEqual(
      snap.frames.map((_, i) => i),
    );
  });

  it('throws InvariantViolation naming the number and the tick', () => {
    const violation = new InvariantViolation(13, 'P4 is ready but not queued', 88);
    expect(violation.invariant).toBe(13);
    expect(violation.tick).toBe(88);
    expect(violation.message).toBe('I-13 violated at tick 88: P4 is ready but not queued');
    expect(violation).toBeInstanceOf(Error);
  });
});

describe('policy swap mid-run, a core player verb', () => {
  it('keeps the kernel deterministic across setScheduler', () => {
    const drive = (): string => {
      const k = createKernel(REFERENCE_CONFIG);
      k.run(50);
      k.setScheduler('fcfs', { quantum: 8 });
      k.run(50);
      return canonicalSnapshot(k.snapshot());
    };
    expect(drive()).toBe(drive());
  });

  it('selects the implemented MLFQ policy through the existing registry', () => {
    const k = createKernel(REFERENCE_CONFIG);
    k.setScheduler('mlfq');
    expect(k.saveSchedulerState().payload.policy.policy).toBe('mlfq');
  });
});

describe('canonical state encoding', () => {
  it('is stable for nested Maps, Sets, arrays and negative zero', () => {
    const fixture = {
      map: new Map<unknown, unknown>([['z', new Set([3, 1, 2])], ['a', [-0, { ok: true }]]]),
      set: new Set<unknown>([{ b: 2, a: 1 }, 'value']),
      array: [null, false, 2.5],
    };
    expect(canonical(fixture)).toBe(canonical(fixture));
    expect(canonical(fixture)).toBe(
      '{"array":[null,false,2.5],"map":[["a",[0,{"ok":true}]],["z",[1,2,3]]],"set":["value",{"a":1,"b":2}]}',
    );
  });

  it('sorts object keys by code unit regardless of insertion order', () => {
    const a = { z: 1, a: 2, Z: 3, '\u{1f600}': 4, '\ue000': 5 };
    const b = { '\ue000': 5, '\u{1f600}': 4, Z: 3, a: 2, z: 1 };
    expect(canonical(a)).toBe(canonical(b));
    expect(canonical(a)).toBe('{"Z":3,"a":2,"z":1,"\u{1f600}":4,"\ue000":5}');
    expect(canonical({ 2: 'two', 10: 'ten' })).toBe('{"10":"ten","2":"two"}');
  });

  it('drops undefined object properties and supports objects without prototypes', () => {
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    record['present'] = null;
    record['missing'] = undefined;
    expect(canonical(record)).toBe('{"present":null}');
    expect(canonical({ a: undefined, b: { c: undefined } })).toBe('{"b":{}}');
  });

  it('normalises negative zero and preserves finite number precision', () => {
    expect(canonical([-0, 0, Number.MIN_VALUE, Number.MAX_VALUE, 1e-7, 1e21])).toBe(
      '[0,0,5e-324,1.7976931348623157e+308,1e-7,1e+21]',
    );
  });

  it('JSON-escapes string values and object keys', () => {
    expect(canonical({ 'a"b': '\n\t"\\\u0000' })).toBe('{"a\\"b":"\\n\\t\\"\\\\\\u0000"}');
  });

  it('keeps array order', () => {
    expect(canonical([3, 1, 2])).toBe('[3,1,2]');
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });

  it('sorts Map entries independently of insertion order, breaking equal-key ties by value', () => {
    const entries: [unknown, unknown][] = [[{ key: 1 }, 'z'], [{ key: 1 }, 'a'], ['b', 2], ['a', 1]];
    const a = new Map(entries);
    const b = new Map(entries.toReversed());
    expect(canonical(a)).toBe(canonical(b));
    expect(canonical(a)).toBe('[["a",1],["b",2],[{"key":1},"a"],[{"key":1},"z"]]');
    expect(Array.from(a.keys())).toEqual(entries.map(([key]) => key));
  });

  it('sorts Set values independently of insertion order, including equal encodings', () => {
    const values: unknown[] = [{ b: 2, a: 1 }, 'z', 'a', { a: 1, b: 2 }];
    expect(canonical(new Set(values))).toBe(canonical(new Set(values.toReversed())));
    expect(canonical(new Set(values))).toBe('["a","z",{"a":1,"b":2},{"a":1,"b":2}]');
  });

  it('rejects functions with their property path', () => {
    expect(() => canonical({ a: { b: () => 1 } })).toThrow(/a\.b/);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite number %s with its array path', (value) => {
    expect(() => canonical({ a: [1, value] })).toThrow(/a\.1/);
  });

  it('rejects symbol values and symbol keys with their containing path', () => {
    expect(() => canonical({ a: Symbol('hidden') })).toThrow(/a/);
    expect(() => canonical({ a: { [Symbol('hidden')]: 1 } })).toThrow(/symbol key at \$\.a/);
  });

  it('rejects class instances even when their own data is serialisable', () => {
    class Policy {
      readonly quantum = 4;
    }
    expect(() => canonical({ a: new Policy() })).toThrow(/class instance at \$\.a/);
    expect(() => canonical({ a: new Date(0) })).toThrow(/class instance at \$\.a/);
  });

  it('rejects undefined outside object properties and sparse array slots', () => {
    expect(() => canonical(undefined)).toThrow(/undefined at \$/);
    expect(() => canonical({ a: [undefined] })).toThrow(/a\.0/);
    expect(() => canonical({ a: new Array<unknown>(1) })).toThrow(/a\.0/);
    expect(() => canonical(new Map([[undefined, 1]]))).toThrow(/0\.key/);
    expect(() => canonical(new Map([['key', undefined]]))).toThrow(/0\.value/);
    expect(() => canonical(new Set([undefined]))).toThrow(/0/);
  });

  it('rejects BigInt with its path', () => {
    expect(() => canonical({ a: 1n })).toThrow(/bigint at \$\.a/);
  });

  it('rejects object, Map and Set cycles with their paths', () => {
    const record: Record<string, unknown> = {};
    record['self'] = record;
    expect(() => canonical({ a: record })).toThrow(/cycle at \$\.a\.self/);
    const map = new Map<string, unknown>();
    map.set('self', map);
    expect(() => canonical({ a: map })).toThrow(/cycle at \$\.a\.0\.value/);
    const set = new Set<unknown>();
    set.add(set);
    expect(() => canonical({ a: set })).toThrow(/cycle at \$\.a\.0/);
  });

  it('allows shared references that do not form cycles', () => {
    const shared = { a: 1 };
    expect(canonical([shared, shared])).toBe('[{"a":1},{"a":1}]');
    expect(canonical(new Map([[shared, shared]]))).toBe('[[{"a":1},{"a":1}]]');
  });

  it('hashes to eight lowercase FNV-1a hex digits', () => {
    expect(hash('')).toBe('811c9dc5');
    expect(hash('')).toMatch(/^[0-9a-f]{8}$/);
    expect(hash('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(hash('')).not.toBe(hash('abc'));
  });

  it('strips named keys with a shallow copy while keeping the original intact', () => {
    const nested = { seq: 2 };
    const source = { seq: 3, tick: 4, nested };
    const result = strip('seq', 'tick')(source);
    expect(result).toEqual({ nested });
    expect(result).not.toBe(source);
    expect(Reflect.get(result, 'nested')).toBe(nested);
    expect(source).toEqual({ seq: 3, tick: 4, nested: { seq: 2 } });
    expect(strip()(source)).toEqual(source);
  });
});

const KERNEL_ROOT = resolve(__dirname, '..', '..', 'src', 'kernel');
const FORBIDDEN_IDENTIFIERS = /\bMath\s*(?:\.\s*random\b|\[\s*['"`]random['"`]\s*\])|\bDate\s*(?:\.\s*now\b|\[\s*['"`]now['"`]\s*\])|\bnew\s+Date\b|\bcrypto\s*(?:\.\s*getRandomValues\b|\[\s*['"`]getRandomValues['"`]\s*\])|\b(?:performance|setTimeout|setInterval|queueMicrotask|requestAnimationFrame|fetch|window|document|navigator|globalThis|localStorage|indexedDB|Worker|console)\b/g;
const THREE_IMPORT = /\b(?:from|import)\s*['"`]three[^'"`]*['"`]|\b(?:import|require)\s*\(\s*['"`]three[^'"`]*['"`]/g;

function kernelSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...kernelSources(path));
    else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(path);
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function scanRawSource(source: string, pattern: RegExp): { line: number; match: string }[] {
  // Matches across the whole string, so multiline property access like
  // `Math\n.random` is caught. Callers scanning real files pass source that
  // has already had its comments blanked; see tests/kernel/sourceScan.ts for
  // why comments are exempt and string literals are not.
  return Array.from(source.matchAll(pattern), (match) => ({
    line: source.slice(0, match.index).split('\n').length,
    match: match[0],
  }));
}

describe('kernel source guards, comments exempt', () => {
  it('contains no forbidden identifiers in code, including computed access', () => {
    const files = kernelSources(KERNEL_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      scanRawSource(stripComments(readFileSync(file, 'utf8'), false), FORBIDDEN_IDENTIFIERS).map((hit) => ({
        file: relative(KERNEL_ROOT, file),
        ...hit,
      })),
    );
    expect(violations).toEqual([]);
  });

  it('contains no import specifier starting with three', () => {
    const violations = kernelSources(KERNEL_ROOT).flatMap((file) =>
      scanRawSource(stripComments(readFileSync(file, 'utf8'), false), THREE_IMPORT).map((hit) => ({
        file: relative(KERNEL_ROOT, file),
        ...hit,
      })),
    );
    expect(violations).toEqual([]);
  });

  it('detects every forbidden API in raw comments, literals and computed access', () => {
    const identifiers = [
      'Math.random', 'Date.now', 'new Date()', 'performance.now', 'performance',
      'crypto.getRandomValues', 'setTimeout', 'setInterval', 'queueMicrotask',
      'requestAnimationFrame', 'fetch', 'window', 'document', 'navigator',
      'globalThis', 'localStorage', 'indexedDB', 'Worker', 'console',
      'Math["random"]', "Date['now']", 'crypto[`getRandomValues`]', 'Math\n.random',
    ];
    for (const identifier of identifiers) {
      expect(scanRawSource(`// ${identifier}`, FORBIDDEN_IDENTIFIERS)).not.toEqual([]);
      expect(scanRawSource('const text = `' + identifier + '`;', FORBIDDEN_IDENTIFIERS)).not.toEqual([]);
    }
    expect(scanRawSource('const windowSize = Math.floor(2);', FORBIDDEN_IDENTIFIERS)).toEqual([]);
  });

  it('detects static, side-effect, dynamic, type and CommonJS three imports', () => {
    const imports = [
      "import { Mesh } from 'three';", "import 'three/addons';",
      "const module = import('three/webgpu');", "type T = import('three').Mesh;",
      "const module = require('three');", "export * from 'three/tsl';",
      "import 'three-extension';",
    ];
    for (const source of imports) expect(scanRawSource(source, THREE_IMPORT)).not.toEqual([]);
    expect(scanRawSource("import { createRng } from './rng';", THREE_IMPORT)).toEqual([]);
  });
});
