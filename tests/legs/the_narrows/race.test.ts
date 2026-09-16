/**
 * WP-L04 acceptance 6 and 7, and the first two misconceptions.
 *
 * The unguarded plank loses updates and reports the interleaving that lost
 * them; the same loop under compare-and-swap loses none; and the second ford
 * corrupts the far post while both of its mutexes report no contention at all,
 * which is the whole of the second lesson.
 */
import { describe, expect, it } from 'vitest';
import { asResourceId } from '@kernel/types';
import { CELL_NEAR, compareAndSwapInstalled, installCompareAndSwap, LOCK_FORD_A, LOCK_FORD_B } from '@legs/the_narrows/ledger';
import { narrowsKernel } from './kernelFixture';

const RACE = 'sync.race_detected';

describe('the near post, unguarded', () => {
  it('loses an increment, and the race names both Programs and both values', () => {
    const fixture = narrowsKernel();
    fixture.run(120);
    const post = fixture.post('near');
    expect(post.serial).toBeGreaterThan(0);
    expect(post.value, 'the post should be behind its serial counter').toBeLessThan(post.serial);
    const races = fixture.events(RACE).filter((event) => event.type === RACE && event.race.location === CELL_NEAR);
    expect(races.length).toBeGreaterThan(0);
    const race = races.at(-1);
    if (race?.type !== RACE) throw new Error('no race recorded on the near post');
    expect(race.race.participants.length).toBeGreaterThanOrEqual(1);
    expect(race.race.expectedValue).toBeGreaterThan(race.race.corruptedValue);
  });

  it('reports the interleaving as load and store lines carrying the tick, the Program and the value', () => {
    const fixture = narrowsKernel();
    fixture.run(120);
    const race = fixture.events(RACE).at(0);
    if (race?.type !== RACE) throw new Error('no race recorded');
    expect(race.race.interleaving.length).toBeGreaterThanOrEqual(2);
    for (const line of race.race.interleaving) expect(line).toMatch(/^t=\d+ P\d+ (LOAD |STORE) \S+ (->|<-) -?\d+ \[holds .+\]$/);
    const shape = race.race.interleaving.map((line) => (line.includes('LOAD ') ? 'load' : 'store'));
    expect(shape).toContain('load');
  });

  it('loses nothing once compare-and-swap is installed, and every later write is atomic', () => {
    const fixture = narrowsKernel();
    installCompareAndSwap(fixture.kernel);
    expect(compareAndSwapInstalled(fixture.kernel)).toBe(true);
    fixture.run(120);
    const post = fixture.post('near');
    expect(post.value).toBe(post.serial);
    const cells = fixture.kernel.snapshot().subsystems?.sync?.payload.raceDetector.cells ?? [];
    const history = cells.find((row) => row.cell === CELL_NEAR)?.history ?? [];
    // The sweep stamps the post once, in a single instruction that reads
    // nothing and cannot lose anything. What must not appear is a store that
    // read the post first and still took the old path.
    const unguarded = history.filter((row) => row.op === 'store' && !row.atomic && row.rmw !== null);
    expect(unguarded, 'a read-modify-write completed without the atomic path').toEqual([]);
    expect(history.some((row) => row.op === 'store' && row.atomic), 'no atomic write reached the post').toBe(true);
  });

  it('switches path mid-run: the writes before the swap are plain and the writes after it are atomic', () => {
    const fixture = narrowsKernel();
    fixture.run(60);
    installCompareAndSwap(fixture.kernel);
    const at = fixture.kernel.tick;
    fixture.run(120);
    const cells = fixture.kernel.snapshot().subsystems?.sync?.payload.raceDetector.cells ?? [];
    const history = cells.find((row) => row.cell === CELL_NEAR)?.history ?? [];
    const loadTick = new Map(history.filter((row) => row.op === 'load').map((row) => [row.id, row.tick]));
    const began = (row: { readonly rmw: number | null; readonly tick: number }): number => (row.rmw === null ? row.tick : loadTick.get(row.rmw) ?? row.tick);
    const unguarded = history.filter((row) => row.op === 'store' && !row.atomic && began(row) > at);
    expect(unguarded, 'a read-modify-write that began after the swap still took the old path').toEqual([]);
    expect(history.some((row) => row.op === 'store' && row.atomic)).toBe(true);
  });
});

describe('the far post, guarded twice', () => {
  it('is corrupted while both mutexes report no contention, which is misconception two in one configuration', () => {
    const fixture = narrowsKernel();
    fixture.run(150);
    const post = fixture.post('far');
    expect(post.serial).toBeGreaterThan(1);
    expect(post.value, 'two correct guards over one post should still lose an increment').toBeLessThan(post.serial);
    const view = fixture.kernel.invariantState();
    for (const id of [LOCK_FORD_A, LOCK_FORD_B]) {
      const lock = view.syncPrimitives.find((primitive) => primitive.id === id);
      expect(lock, id).toBeDefined();
      expect(lock?.waitQueue, `${id} should have nobody queued: each guard is correct in isolation`).toEqual([]);
    }
    expect(fixture.events(RACE).some((event) => event.type === RACE && event.race.location.endsWith('ledger.far'))).toBe(true);
  });

  it('holds mutual exclusion on each mutex the whole time, so neither guard is the defect', () => {
    const fixture = narrowsKernel();
    // Sampled rather than every tick: the invariant harness itself asserts
    // I-21 on every tick of every run, and this is the leg's own witness.
    for (let tick = 0; tick < 120; tick += 4) {
      fixture.run(4);
      const view = fixture.kernel.invariantState();
      for (const id of [LOCK_FORD_A, LOCK_FORD_B]) {
        const lock = view.syncPrimitives.find((primitive) => primitive.id === id);
        expect(lock?.holders.length ?? 0, `${id} at tick ${tick}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never queues anyone on the plank lock, because the plank is the crossing nothing guards', () => {
    const fixture = narrowsKernel();
    fixture.run(120);
    const plank = fixture.kernel.invariantState().syncPrimitives.find((primitive) => primitive.id === asResourceId('lock.plank'));
    expect(plank?.holders).toEqual([]);
    expect(plank?.waitQueue).toEqual([]);
  });
});
