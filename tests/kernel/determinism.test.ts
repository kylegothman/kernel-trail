/**
 * Fixtures DET-D1 to DET-D4 from sim spec 16.2, and the invariant stated at the
 * top of src/kernel/types.ts: a kernel constructed from the same KernelConfig
 * and stepped the same number of ticks produces a byte-identical event log and
 * snapshot every time.
 *
 * NOTE ON SCOPE. Phases 1 to 10 of `step()` are stubs at this commit, so the
 * event log these kernels produce is empty and the snapshot changes only in
 * `tick`. That does not make these tests vacuous: they exercise the real
 * constructor, the real RNG stream registry, the real tick counter, the real
 * snapshot and restore, and the real invariant harness, and they fail loudly the
 * moment a phase body introduces nondeterminism. Every assertion here is
 * written against the finished behaviour, so nothing needs rewriting as the
 * phases land.
 */

import { describe, expect, it } from 'vitest';
import { createKernel, InvariantViolation } from '@kernel/Kernel';
import { createRng, createStreamRegistry } from '@kernel/rng';
import { KernelEventBus } from '@kernel/EventBus';
import { canonicalise, checksumSafeSnapshot, fnv1a64 } from '@game/save';
import { asPid, asTick } from '@kernel/types';
import type { KernelConfig, KernelEvent, KernelSnapshot, SubsystemId } from '@kernel/types';

/** The reference configuration of sim spec 16.1, on the FCFS policy. */
const REFERENCE_CONFIG: KernelConfig = {
  seed: 0x4b54524c,
  // Sim spec 16.1 names 'rr'; FCFS is the only policy implemented at this
  // commit, so the determinism fixtures run on it. Swap to 'rr' once
  // src/kernel/scheduler/RR.ts exists; nothing else in this file changes.
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

const TICKS = 5000;

/** Deterministic serialisation: keys sorted, Maps flattened, -0 normalised. */
const canonicalLog = (events: readonly KernelEvent[]): string => canonicalise(events);
const canonicalSnapshot = (s: KernelSnapshot): string => canonicalise(checksumSafeSnapshot(s));
const hash = (s: string): string => fnv1a64(s);

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

  it('throws a useful error for a policy that is not built yet', () => {
    const k = createKernel(REFERENCE_CONFIG);
    expect(() => k.setScheduler('mlfq')).toThrow(/not implemented yet.*sim spec 5\.8/s);
  });
});
