import { describe, expect, it } from 'vitest';
import { StorageSubsystem } from '@kernel/storage/StorageSubsystem';
import { createStreamRegistry } from '@kernel/rng';
import { asTick } from '@kernel/types';
import type { BlockId, RaidLevel } from '@kernel/types';
import type { EmittableEvent } from '@kernel/EventBus';

const SEED = 0x4b54524c;
function fixture(level: RaidLevel, n = 6, blocks = 64) {
  let tick = 0; const events: EmittableEvent[] = [];
  const storage = new StorageSubsystem({ tick: () => asTick(tick), enabled: () => true,
    emit: event => events.push(event), rng: createStreamRegistry(SEED).stream('storage') });
  const members = Array.from({ length: n }, (_, index) => `member${index}`); const spares = ['spare0', 'spare1'];
  for (const drive of [...members, ...spares]) storage.ensureDrive(drive);
  storage.registerRaid({ arrayId: 'array', level, members, blocksPerMember: blocks, spares });
  const step = () => { tick++; storage.expireTimers(asTick(tick)); storage.serviceCompletions(asTick(tick)); };
  const submit = (lba: number, value: readonly number[] | number) => storage.submit({ kind: 'raid', arrayId: 'array' },
    typeof value === 'number' ? { kind: 'read', lba: lba as BlockId, bytes: value } : { kind: 'write', lba: lba as BlockId, data: value });
  const drain = () => { let limit = 100_000; while (storage.raid.get('array')!.busy && limit-- > 0) step(); if (storage.raid.get('array')!.busy) throw new Error('RAID did not drain'); };
  const complete = (id: number) => { let limit = 100_000; while (storage.peekCompletion(id) === null && limit-- > 0) step(); return storage.takeCompletion(id)?.result; };
  return { storage, get raid() { return storage.raid.get('array')!; }, events, submit, step, drain, complete, tick: () => tick, setTick: (value: number) => { tick = value; } };
}
const sector = (value: number) => Array<number>(512).fill(value);

describe('RAID physical plans and parity', () => {
  it.each([[0, 1], [1, 2], [4, 4], [5, 4], [6, 6], [10, 2]] as const)('RAID-1 level %i produces %i physical operations', (level, count) => {
    const f = fixture(level); const id = f.submit(0, sector(5)); expect(f.raid.queueLengths().reduce((a, b) => a + b, 0)).toBe(count);
    expect(f.complete(id)).toEqual({ kind: 'ok', data: [] }); expect(f.raid.metrics().completedPhysicalReads + f.raid.metrics().completedPhysicalWrites).toBe(count);
  });
  it('RAID-2: a complete four-block RAID-5 stripe writes five sectors without reads', () => {
    const f = fixture(5, 5); const id = f.submit(0, [...sector(1), ...sector(2), ...sector(3), ...sector(4)]);
    expect(f.raid.queueLengths()).toEqual([1, 1, 1, 1, 1]); expect(f.complete(id)?.kind).toBe('ok'); expect(f.raid.metrics().completedPhysicalReads).toBe(0);
    expect(f.storage.readSector('member4', 0 as BlockId)).toEqual(sector(1 ^ 2 ^ 3 ^ 4));
  });
  it('capacity follows all six layouts and RAID-5 parity rotates across twenty stripes', () => {
    for (const [level, disks] of [[0, 6], [1, 3], [4, 5], [5, 5], [6, 4], [10, 3]] as const) expect(fixture(level).raid.capacity).toBe(disks * 64);
    const f = fixture(5); expect(Array.from({ length: 20 }, (_, stripe) => f.raid.parityDisk(stripe)))
      .toEqual([5, 4, 3, 2, 1, 0, 5, 4, 3, 2, 1, 0, 5, 4, 3, 2, 1, 0, 5, 4]);
  });
  it('S4 fixed queue fixture measures all plans at the submission tick before service', () => {
    const rng = createStreamRegistry(SEED).stream('storage'); const addresses = Array.from({ length: 200 }, () => rng.int(0, 320));
    const a = fixture(4, 5, 80); const b = fixture(5, 5, 80);
    for (const address of addresses) { a.submit(address, sector(17)); b.submit(address, sector(17)); }
    const dedicated = [...a.raid.queueLengths()]; const rotated = [...b.raid.queueLengths()];
    expect(dedicated[4]).toBe(400); for (const count of dedicated.slice(0, 4)) expect(dedicated[4]!).toBeGreaterThanOrEqual(3 * count);
    expect(rotated).toEqual([166, 162, 130, 180, 162]);
    const mean = rotated.reduce((sum, count) => sum + count, 0) / rotated.length;
    expect(rotated.every(count => Math.abs(count - mean) <= 0.25 * mean)).toBe(true);
  });
  it.each([0, 1, 4, 5, 6, 10] as const)('RAID-3/4: level %i applies failure tolerance and never injects failures', level => {
    const f = fixture(level); f.raid.failDisk(0); expect(f.raid.status).toBe(level === 0 ? 'lost' : 'degraded');
    f.raid.failDisk(1); expect(f.raid.status).toBe(level === 6 ? 'degraded' : 'lost');
    const other = fixture(level); other.raid.failDisk(0); other.raid.failDisk(2);
    expect(other.raid.status).toBe([1, 6, 10].includes(level) ? 'degraded' : 'lost');
  });
  it('RAID-6 P and Q reconstruct two missing data sectors independently', () => {
    const f = fixture(6, 6); const input = [...sector(7), ...sector(19), ...sector(41), ...sector(73)];
    expect(f.complete(f.submit(0, input))?.kind).toBe('ok'); f.raid.pauseRebuild(); f.raid.failDisk(0); f.raid.failDisk(1);
    const id = f.submit(0, 1024); expect(f.complete(id)).toEqual({ kind: 'ok', data: input.slice(0, 1024) });
    expect(f.storage.readSector('member5', 0 as BlockId)).not.toEqual(f.storage.readSector('member4', 0 as BlockId));
  });
  it.each([[0, 5], [0, 4], [4, 5]] as const)('RAID-6 survives data/parity failure pair %i,%i', (first, second) => {
    const f = fixture(6, 6, 8); const input = [...sector(13), ...sector(29), ...sector(61), ...sector(127)];
    expect(f.complete(f.submit(0, input))?.kind).toBe('ok'); f.raid.pauseRebuild(); f.raid.failDisk(first); f.raid.failDisk(second);
    expect(f.complete(f.submit(0, input.length))).toEqual({ kind: 'ok', data: input });
  });
  it('RAID-6 rebuilds two failed data members through both spare queues', () => {
    const f = fixture(6, 6, 8); const input = [...sector(13), ...sector(29), ...sector(61), ...sector(127)];
    expect(f.complete(f.submit(0, input))?.kind).toBe('ok'); f.raid.failDisk(0); f.raid.failDisk(1); f.drain();
    expect(f.raid.status).toBe('healthy'); expect(f.raid.metrics().completedRebuildBlocks).toBe(16);
    expect(f.complete(f.submit(0, input.length))).toEqual({ kind: 'ok', data: input });
  });
  it('degraded reconstruction reads n-1 disks; mirror reads the lower live copy', () => {
    for (const level of [4, 5, 6] as const) {
      const f = fixture(level); f.raid.pauseRebuild(); f.raid.failDisk(0); f.submit(0, 512);
      expect(f.raid.queueLengths().reduce((a, b) => a + b, 0)).toBe(5);
    }
    const mirror = fixture(1); mirror.raid.pauseRebuild(); mirror.raid.failDisk(0); mirror.submit(0, 512);
    expect(mirror.raid.queueLengths()).toEqual([0, 1, 0, 0, 0, 0]);
  });
  it('rebuild cap is issuance; pause retains in-flight work and completion advances progress', () => {
    const f = fixture(5, 5, 8); f.raid.failDisk(0); f.step();
    const first = f.raid.saveState(); expect(first.rebuilds[0]?.nextSectorToIssue).toBe(4); expect(first.rebuilds[0]?.completedPrefix).toBe(0);
    f.raid.pauseRebuild(); for (let index = 0; index < 60; index++) f.step();
    expect(f.raid.saveState().rebuilds[0]?.nextSectorToIssue).toBe(4); expect(f.raid.metrics().completedRebuildBlocks).toBeGreaterThan(0);
    f.raid.resumeRebuild(); f.drain(); expect(f.raid.status).toBe('healthy');
    const progress = f.events.filter(event => event.type === 'raid.rebuild').map(event => event.progress);
    expect(progress.at(-1)).toBe(1); expect(progress.every(value => value >= 0 && value <= 1)).toBe(true);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(true);
  });
  it('fatal loss remains latched in snapshots after failure during rebuild', () => {
    const f = fixture(5, 5, 8); f.raid.failDisk(0); f.step(); f.raid.failDisk(1);
    for (let index = 0; index < 60; index++) f.step(); expect(f.raid.saveState().dataLost).toBe(true); expect(f.raid.status).toBe('lost');
    const before = f.raid.saveState(); const commit = f.raid.prepareRestore(before); commit(); expect(f.raid.status).toBe('lost');
  });
  it('concurrent small writes to one stripe cannot lose a parity update', () => {
    const f = fixture(5, 5); const a = f.submit(0, sector(37)); const b = f.submit(1, sector(83));
    expect(f.complete(a)?.kind).toBe('ok'); expect(f.complete(b)?.kind).toBe('ok');
    expect(f.storage.readSector('member4', 0 as BlockId)).toEqual(sector(37 ^ 83));
    f.raid.pauseRebuild(); f.raid.failDisk(0); expect(f.complete(f.submit(0, 1024))).toEqual({ kind: 'ok', data: [...sector(37), ...sector(83)] });
  });
  it('foreground writes keep a rebuilt spare current without decreasing reported progress', () => {
    const f = fixture(5, 5, 8); expect(f.complete(f.submit(0, [...sector(1), ...sector(2), ...sector(3), ...sector(4)]))?.kind).toBe('ok');
    f.raid.failDisk(0); for (let index = 0; index < 25; index++) f.step(); const id = f.submit(0, sector(91));
    expect(f.complete(id)?.kind).toBe('ok'); f.drain(); expect(f.raid.status).toBe('healthy');
    expect(f.complete(f.submit(0, 512))).toEqual({ kind: 'ok', data: sector(91) });
    const progress = f.events.filter(event => event.type === 'raid.rebuild').map(event => event.progress);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(true);
  });
  it('storage snapshot restores partial dependency results, physical queues and rebuild deadlines', () => {
    const a = fixture(6, 6, 8); expect(a.complete(a.submit(0, [...sector(3), ...sector(5), ...sector(7), ...sector(11)]))?.kind).toBe('ok');
    a.raid.failDisk(0); for (let index = 0; index < 12; index++) a.step();
    const snapshot = a.storage.saveState(); const b = fixture(6, 6, 8); b.setTick(a.tick());
    const before = b.storage.saveState(); const commit = b.storage.prepareRestore(snapshot); expect(b.storage.saveState()).toEqual(before); commit();
    a.drain(); b.drain(); expect(b.storage.saveState()).toEqual(a.storage.saveState());
    expect(b.complete(b.submit(0, 512))).toEqual({ kind: 'ok', data: sector(3) });
  });
  it('restore refuses a dependency cycle without mutating pending transactions', () => {
    const f = fixture(5); f.submit(0, sector(9)); const state = f.raid.saveState();
    const transactions = state.transactions.map(tx => ({ ...tx, operations: tx.operations.map((op, index) => index === 0 ? { ...op, dependsOn: [op.id] } : op) }));
    expect(() => f.raid.prepareRestore({ ...state, transactions })).toThrow(); expect(f.raid.saveState()).toEqual(state);
  });
  it('normal idle operation consumes no failure RNG draws', () => {
    const rng = createStreamRegistry(SEED).stream('storage'); const before = rng.save();
    let tick = 0; const storage = new StorageSubsystem({ tick: () => asTick(tick), enabled: () => true, emit: () => {}, rng });
    for (tick = 1; tick <= 10_000; tick++) { storage.expireTimers(asTick(tick)); storage.serviceCompletions(asTick(tick)); }
    expect(rng.save()).toEqual(before); expect(storage.saveState().payload.drives).toHaveLength(1);
  });
  it('measures foreground throughput while rebuild shares the physical queues', () => {
    const measure = (paused: boolean) => {
      const f = fixture(5, 5, 64); f.raid.failDisk(0); if (paused) f.raid.pauseRebuild();
      for (let index = 0; index < 200; index++) { f.submit(1 + 4 * (index % 64), 512); f.step(); }
      return { foregroundBlocks: f.raid.metrics().completedReadBlocks, rebuiltBlocks: f.raid.metrics().completedRebuildBlocks };
    };
    const rebuilding = measure(false); const paused = measure(true);
    console.log('WP09 rebuild throughput, 200 ticks', { rebuilding, paused, ratio: rebuilding.foregroundBlocks / paused.foregroundBlocks });
    expect(rebuilding.rebuiltBlocks).toBeGreaterThan(0); expect(paused.rebuiltBlocks).toBe(0);
    expect(paused.foregroundBlocks).toBeGreaterThan(rebuilding.foregroundBlocks);
  });
});
