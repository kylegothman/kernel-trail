import { describe, expect, it, vi } from 'vitest';
import { WorkingSet, WorkingSetModel } from '@kernel/memory/workingSet';
import { LocalityGenerator } from '@kernel/memory/locality';
import { generatedProgram } from '@kernel/process/Program';
import { createRng, createStreamRegistry } from '@kernel/rng';
import { asPageId, asPid, asTick } from '@kernel/types';

describe('working-set windows', () => {
  it('VM-WS-1 produces the textbook five-page and two-page localities', () => {
    const ring = new WorkingSet(10);
    for (const page of [2, 6, 1, 5, 7, 7, 7, 7, 5, 1]) ring.push(asPageId(page));
    expect(ring.distinctCount).toBe(5);
    expect([...ring.pages].sort((a, b) => a - b)).toEqual([1, 2, 5, 6, 7]);
    for (const page of [3, 4, 3, 4, 4, 4, 3, 4, 4, 4]) ring.push(asPageId(page));
    expect(ring.distinctCount).toBe(2);
    expect([...ring.pages].sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it.each([1, 2, 10, 31])('keeps exact ring and count-map state through 1000 pushes with capacity %i', capacity => {
    const rng = createRng(12345);
    const ring = new WorkingSet(capacity);
    const oracle: number[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const page = rng.int(0, 20);
      ring.push(asPageId(page)); oracle.push(page);
      if (oracle.length > capacity) oracle.shift();
      expect(ring.references).toEqual(oracle);
      expect(ring.distinctCount).toBe(new Set(oracle).size);
      expect(ring.size).toBe(Math.min(index + 1, capacity));
    }
    ring.reset(); expect(ring.references).toEqual([]); expect(ring.distinctCount).toBe(0);
  });

  it('deletes a page only when the last duplicate leaves the ring', () => {
    const ring = new WorkingSet(3);
    [1, 1, 2, 3].forEach(page => ring.push(asPageId(page)));
    expect(ring.distinctCount).toBe(3);
    ring.push(asPageId(3));
    expect(ring.distinctCount).toBe(2);
    expect(ring.references).toEqual([2, 3, 3]);
  });

  it('rejects invalid dimensions and references', () => {
    expect(() => new WorkingSet(0)).toThrow();
    expect(() => new WorkingSet(1.5)).toThrow();
    expect(() => new WorkingSet().push(asPageId(-1))).toThrow();
  });
});

describe('working-set estimates and shared VM draws', () => {
  it('consumes exactly 100 draws per continuously eligible process in ticks 1 through 1000', () => {
    const rng = createStreamRegistry(12345).stream('vm');
    const model = new WorkingSetModel(10, rng);
    const pids = [4, 2, 3].map(asPid);
    for (const pid of pids) { model.admit(pid, asTick(0)); model.push(pid, asPageId(1)); }
    const ranges = new Set<number>();
    for (let tick = 0; tick <= 1000; tick += 1) {
      model.updateNoise(asTick(tick), pids);
      for (const entry of model.saveState().processes) ranges.add(entry.noise);
    }
    expect(model.noiseDraws).toBe(300);
    expect([...ranges].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
    expect([...model.trueSizes()]).toEqual([[2, 1], [3, 1], [4, 1]]);
    expect([...model.reportedSizes().values()].every(size => size >= 0)).toBe(true);
  });

  it('uses ascending PID order and one draw per due process even with duplicate input', () => {
    const rng = createRng(12345);
    const int = vi.spyOn(rng, 'int').mockReturnValueOnce(-2).mockReturnValueOnce(2);
    const model = new WorkingSetModel(10, rng);
    model.admit(asPid(5), asTick(10)); model.admit(asPid(2), asTick(1));
    model.updateNoise(asTick(9), [asPid(5), asPid(2)]);
    expect(int).not.toHaveBeenCalled();
    model.updateNoise(asTick(10), [asPid(5), asPid(2), asPid(2), asPid(0)]);
    model.updateNoise(asTick(10), [asPid(5), asPid(2)]);
    expect(int.mock.calls).toEqual([[-2, 3], [-2, 3]]);
    expect(model.saveState().processes.map(entry => [entry.pid, entry.noise])).toEqual([[2, -2], [5, 2]]);
  });

  it('excludes inactive processes without catch-up draws and changes precision only on cadence', () => {
    const rng = createRng(321);
    const int = vi.spyOn(rng, 'int');
    const model = new WorkingSetModel(10, rng);
    model.admit(asPid(2), asTick(1)); model.admit(asPid(3), asTick(1));
    model.updateNoise(asTick(10), [asPid(2)]);
    model.setPrecision(true);
    model.updateNoise(asTick(15), [asPid(3)]);
    expect(model.noiseDraws).toBe(1);
    for (let tick = 20; tick <= 1000; tick += 10) model.updateNoise(asTick(tick), [asPid(3)]);
    expect(model.noiseDraws).toBe(100);
    expect(int.mock.calls[0]).toEqual([-2, 3]);
    expect(int.mock.calls.slice(1).every(([low, high]) => low === -1 && high === 2)).toBe(true);
    expect(model.saveState().processes.find(entry => entry.pid === 3)?.noise).toBeGreaterThanOrEqual(-1);
    expect(model.saveState().processes.find(entry => entry.pid === 3)?.noise).toBeLessThanOrEqual(1);
  });

  it('restores rings and deadlines without consuming or reordering the shared stream', () => {
    const registry = createStreamRegistry(0x4b54524c);
    const rng = registry.stream('vm');
    const model = new WorkingSetModel(10, rng);
    for (const pid of [2, 3].map(asPid)) model.admit(pid, asTick(0));
    for (let tick = 1; tick <= 35; tick += 1) {
      model.push(asPid(2), asPageId(tick % 7)); model.updateNoise(asTick(tick), [asPid(3), asPid(2)]);
      if (tick % 6 === 0) rng.pick([1, 4, 8]);
    }
    const saved = JSON.parse(JSON.stringify(model.saveState()));
    const randomState = registry.save();
    const replayRegistry = createStreamRegistry(5);
    replayRegistry.restore(randomState);
    const replay = new WorkingSetModel(10, replayRegistry.stream('vm'));
    const before = replayRegistry.save();
    replay.prepareRestore(saved)(); expect(replayRegistry.save()).toEqual(before);
    for (let tick = 36; tick <= 1000; tick += 1) {
      for (const instance of [model, replay]) {
        instance.push(asPid(2), asPageId(tick % 11)); instance.updateNoise(asTick(tick), [asPid(3), asPid(2)]);
      }
      if (tick % 6 === 0) expect(rng.pick([1, 4, 8])).toBe(replayRegistry.stream('vm').pick([1, 4, 8]));
      expect(replay.saveState()).toEqual(model.saveState());
    }
    expect(replayRegistry.save()).toEqual(registry.save());
  });

  it('atomically rejects malformed snapshots and detaches saved reference arrays', () => {
    const model = new WorkingSetModel(2, createRng(42));
    model.admit(asPid(2), asTick(0)); model.push(asPid(2), asPageId(1));
    const before = model.saveState();
    const entry = before.processes[0]!;
    for (const invalid of [
      { ...before, noiseDraws: -1 },
      { ...before, processes: [{ ...entry, references: [1, 2, 3] }] },
      { ...before, processes: [{ ...entry, noise: 3 }] },
      { ...before, processes: [{ ...entry, nextNoiseTick: 11 }] },
      { ...before, processes: [entry, entry] },
    ]) {
      expect(() => model.prepareRestore(invalid)).toThrow(); expect(model.saveState()).toEqual(before);
    }
    model.push(asPid(2), asPageId(2)); expect(before.processes[0]?.references).toEqual([1]);
    model.remove(asPid(2)); expect(model.trueSize(asPid(2))).toBe(0);
    expect(() => model.push(asPid(2), asPageId(0))).toThrow();
  });
});

describe('locality generation', () => {
  it('shifts about 200 times in 10000 references while preserving locality bounds and writes', () => {
    const generator = new LocalityGenerator(createStreamRegistry(0x4b54524c).stream('vm'), 40);
    let writes = 0;
    for (let index = 0; index < 10000; index += 1) {
      const access = generator.next()!;
      expect(access.page).toBeGreaterThanOrEqual(generator.localityBase);
      expect(access.page).toBeLessThan(generator.localityBase + 4);
      writes += Number(access.write);
    }
    expect(generator.shiftDecisions).toBeGreaterThanOrEqual(170);
    expect(generator.shiftDecisions).toBeLessThanOrEqual(230);
    expect(writes).toBeGreaterThan(2800); expect(writes).toBeLessThan(3200);
  });

  it.each([1, 2, 4])('allows shifts when page count %i is at or below locality size', pages => {
    const generator = new LocalityGenerator(createRng(41), pages, { localityShiftChance: 1 });
    for (let index = 0; index < 20; index += 1) expect(generator.next()!.page).toBeLessThan(pages);
    expect(generator.shiftDecisions).toBe(20); expect(generator.localityBase).toBe(0);
  });

  it('includes the last legal window and draws a page after a shift', () => {
    const rng = createRng(41);
    const int = vi.spyOn(rng, 'int').mockImplementation((_, max) => max - 1);
    const generator = new LocalityGenerator(rng, 7, { localitySize: 4, localityShiftChance: 1, writeRatio: 1 });
    expect(generator.next()).toEqual({ page: 6, write: true });
    expect(generator.localityBase).toBe(3);
    expect(int.mock.calls).toEqual([[0, 4], [0, 4]]);
  });

  it('zero-page programs consume no random draws and all generated instruction reads are pure', () => {
    const rng = createRng(411);
    const before = rng.save();
    const empty = generatedProgram(rng, { pages: 0, service: 20 });
    expect(rng.save()).toEqual(before);
    expect(empty.at(0)).toEqual({ kind: 'compute' });
    const program = generatedProgram(rng, { pages: 40, service: 100 });
    const after = rng.save();
    const instructions = Array.from({ length: 100 }, (_, index) => program.at(index));
    for (let index = 99; index >= 0; index -= 1) expect(program.at(index)).toEqual(instructions[index]);
    expect(rng.save()).toEqual(after); expect(program.referenceString).toBeNull();
  });

  it('validates locality tuning even for zero-page programs', () => {
    expect(() => new LocalityGenerator(createRng(1), 0, { localitySize: 0 })).toThrow();
    expect(() => new LocalityGenerator(createRng(1), 1, { writeRatio: 2 })).toThrow();
    expect(() => new LocalityGenerator(createRng(1), 1, { localityShiftChance: Number.NaN })).toThrow();
  });
});
