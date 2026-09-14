import { describe, expect, it } from 'vitest';
import { NvmDevice, type NvmOptions } from '@kernel/storage/nvm';
import { StorageSubsystem } from '@kernel/storage/StorageSubsystem';
import { createStreamRegistry } from '@kernel/rng';
import { asTick } from '@kernel/types';
import type { BlockId, DeviceId, StorageRequestSnapshot, StorageResultSnapshot } from '@kernel/types';

const REFERENCE_SEED = 0x4b54524c;
const SMALL: NvmOptions = { pages: 64, logicalPages: 40, pagesPerBlock: 8, overProvisionRatio: 0.25 };
function fixture(options: NvmOptions = SMALL) {
  let tick = 0; let next = 0;
  const requests = new Map<number, StorageRequestSnapshot>();
  const completed = new Map<number, { tick: number; result: StorageResultSnapshot }>();
  const device = new NvmDevice({ tick: () => asTick(tick), request: id => requests.get(id),
    completeRequest: (id, result, at) => { completed.set(id, { tick: at, result }); requests.delete(id); } }, options);
  const submit = (lba: number, data: readonly number[] | number) => {
    const id = next++;
    requests.set(id, { id, consumer: { kind: 'direct' }, pid: null, queuedAtTick: asTick(tick), target: { kind: 'nvm', deviceId: 'nvm0' as DeviceId },
      transfer: typeof data === 'number' ? { kind: 'read', lba: lba as BlockId, bytes: data } : { kind: 'write', lba: lba as BlockId, data }, completion: null, cancelledAtTick: null });
    device.submit(id); return id;
  };
  const step = () => { tick++; device.expireTimers(asTick(tick)); device.serviceCompletions(asTick(tick)); };
  const drain = () => { device.flush(); let limit = 100_000; while (device.busy && limit-- > 0) step(); if (device.busy) throw new Error('NVM did not drain'); };
  return { device, requests, completed, submit, step, drain, tick: () => tick, setTick: (value: number) => { tick = value; } };
}

describe('NVM FTL and media service', () => {
  it('DISK-NVM-1: all six HDD policy selections leave NVM request completion ticks identical', () => {
    const times = (['fcfs', 'sstf', 'scan', 'cscan', 'look', 'clook'] as const).map(policy => {
      let tick = 0;
      const storage = new StorageSubsystem({ tick: () => asTick(tick), enabled: () => true, emit: () => {},
        rng: createStreamRegistry(REFERENCE_SEED).stream('storage') }, { policy });
      const ids = [98, 183, 37, 122, 14, 124, 65, 67].map(address => storage.submitDevice('nvm0' as DeviceId,
        { kind: 'read', lba: address * 8 as BlockId, bytes: 4096 }, { kind: 'direct' }, null));
      for (tick = 1; tick <= 8; tick++) { storage.expireTimers(asTick(tick)); storage.serviceCompletions(asTick(tick)); }
      return ids.map(id => storage.peekCompletion(id)?.completedAtTick);
    });
    expect(times[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); for (const value of times) expect(value).toEqual(times[0]);
  });
  it('DISK-NVM-2: measures the exact approved fixed-seed workloads without calibration', () => {
    const measure = (random: boolean) => {
      const f = fixture({ pages: 2048, logicalPages: 1728, pagesPerBlock: 64 });
      const data = Array<number>(4096).fill(17);
      for (let page = 0; page < 1728; page++) f.submit(page * 8, data);
      f.drain(); f.device.resetCounters();
      const rng = createStreamRegistry(REFERENCE_SEED).stream('storage');
      for (let index = 0; index < 1000; index++) f.submit((random ? rng.int(0, 1728) : index) * 8, data);
      f.drain(); return f.device.metrics();
    };
    const sequential = measure(false); const random = measure(true);
    console.log('WP09 S3 fixed fixture', { sequential: sequential.writeAmplification, random: random.writeAmplification,
      randomPhysicalWrites: random.physicalWrites, sequentialPhysicalWrites: sequential.physicalWrites });
    expect(sequential.writeAmplification).toBeCloseTo(1, 1); expect(random.writeAmplification).toBeGreaterThan(3);
  }, 60_000);
  it('write costs ten reads before tick quantisation', () => { const f = fixture(); expect(f.device.serviceTimeUs(true)).toBe(10 * f.device.serviceTimeUs(false)); });
  it('erase before write: remaps to a fresh physical page and retains the invalid old image', () => {
    const f = fixture(); f.submit(0, Array<number>(4096).fill(1)); f.drain(); const first = f.device.physicalPage(0);
    f.submit(0, Array<number>(4096).fill(2)); f.drain(); expect(f.device.physicalPage(0)).not.toBe(first);
    expect(f.device.saveState().programmedPages.find(page => page.physicalPage === first)?.logicalPage).toBeNull(); expect(f.device.readPage(0)[0]).toBe(2);
  });
  it('eight sub-page writes form one physical page program and retain all bytes', () => {
    const f = fixture(); for (let sector = 0; sector < 8; sector++) f.submit(sector, Array<number>(512).fill(sector + 1));
    f.drain(); expect(f.device.metrics().physicalWrites).toBe(1); expect(f.completed.size).toBe(8);
    for (let sector = 0; sector < 8; sector++) expect(f.device.readPage(0).slice(sector * 512, (sector + 1) * 512)).toEqual(Array<number>(512).fill(sector + 1));
  });
  it('a later buffer generation cannot replace an in-flight program image', () => {
    const f = fixture(); const a = f.submit(0, Array<number>(4096).fill(3)); const b = f.submit(0, Array<number>(512).fill(8));
    f.step(); expect(f.completed.has(a)).toBe(true); expect(f.completed.has(b)).toBe(false); f.drain();
    expect(f.device.readPage(0).slice(0, 512)).toEqual(Array<number>(512).fill(8)); expect(f.device.readPage(0)[512]).toBe(3);
  });
  it('GC triggers strictly below reserve, chooses highest invalid count then lowest block, and reserves destinations', () => {
    const f = fixture(); const data = Array<number>(4096).fill(1);
    for (let page = 0; page < 40; page++) f.submit(page * 8, data); f.drain();
    for (let page = 0; page < 9; page++) f.submit(page * 8, data);
    while (f.device.saveState().gc === null) f.step();
    const snapshot = f.device.saveState(); expect(snapshot.gc?.victimBlock).toBe(0); expect(snapshot.gc?.relocations).toHaveLength(0);
    expect(f.device.trim(0, 1)).toMatchObject({ ok: false, errno: 'EBUSY' }); f.drain(); expect(f.device.metrics().blockErases).toBeGreaterThan(0);
  });
  it('snapshot restores active programming, pending generations and completion order with detached state', () => {
    const a = fixture(); a.submit(0, Array<number>(4096).fill(7)); a.submit(8, Array<number>(512).fill(9));
    const state = a.device.saveState(); const b = fixture(); b.setTick(a.tick()); for (const [id, request] of a.requests) b.requests.set(id, structuredClone(request));
    const commit = b.device.prepareRestore(state); expect(b.device.saveState().programs).toHaveLength(0); commit();
    a.drain(); b.drain(); expect(b.device.saveState()).toEqual(a.device.saveState()); expect([...b.completed]).toEqual([...a.completed]);
  });
  it('restore rejects duplicate physical mappings without mutating live state', () => {
    const f = fixture(); f.submit(0, Array<number>(4096).fill(1)); f.drain(); const state = f.device.saveState();
    expect(() => f.device.prepareRestore({ ...state, programmedPages: [...state.programmedPages, ...state.programmedPages] })).toThrow(); expect(f.device.saveState()).toEqual(state);
  });
  it('GC tie selection and partially copied relocation restore preserve data and future choices', () => {
    const a = fixture(); const data = Array<number>(4096).fill(31);
    for (let page = 0; page < 40; page++) a.submit(page * 8, data); a.drain();
    for (const page of [0, 8, 1, 9, 2, 10, 3, 11, 16]) a.submit(page * 8, data);
    for (let step = 0; step < 8; step++) a.step(); expect(a.device.saveState().gc).toBeNull(); a.step();
    expect(a.device.saveState().gc?.victimBlock).toBe(0); expect(a.device.saveState().gc?.relocations).toHaveLength(4);
    a.step(); a.step(); const state = a.device.saveState(); expect(state.gc?.nextRelocation).toBe(1);
    const b = fixture(); b.setTick(a.tick()); for (const [id, request] of a.requests) b.requests.set(id, structuredClone(request)); b.device.prepareRestore(state)();
    while (a.device.saveState().gc?.phase !== 'erase') { a.step(); b.step(); }
    const c = fixture(); c.setTick(a.tick()); for (const [id, request] of a.requests) c.requests.set(id, structuredClone(request));
    c.device.prepareRestore(a.device.saveState())();
    a.drain(); b.drain(); c.drain(); expect(b.device.saveState()).toEqual(a.device.saveState()); expect(c.device.saveState()).toEqual(a.device.saveState());
    for (let page = 0; page < 40; page++) expect(b.device.readPage(page)).toEqual(data);
  });
  it('cancelled in-flight programming drains without a second completion token', () => {
    const f = fixture(); const id = f.submit(0, Array<number>(4096).fill(23)); f.device.cancel(id); f.drain();
    expect(f.completed.get(id)?.result).toEqual({ kind: 'failed', reason: 'cancelled' }); expect(f.completed.size).toBe(1);
    expect(f.device.readPage(0)).toEqual(Array<number>(4096).fill(23)); expect(f.device.busy).toBe(false);
  });
  it('restore rejects a GC plan that would erase an unrelocated live page', () => {
    const f = fixture(); const data = Array<number>(4096).fill(31);
    for (let page = 0; page < 40; page++) f.submit(page * 8, data); f.drain();
    for (const page of [0, 8, 1, 9, 2, 10, 3, 11, 16]) f.submit(page * 8, data);
    while (f.device.saveState().gc === null) f.step();
    const state = f.device.saveState(); const gc = state.gc!; expect(gc.relocations).toHaveLength(4);
    expect(() => f.device.prepareRestore({ ...state, gc: { ...gc, relocations: gc.relocations.slice(0, -1) } })).toThrow('GC plan omits a live victim page');
    expect(f.device.saveState()).toEqual(state); f.drain(); expect(f.device.readPage(7)).toEqual(data);
  });
  it('restore rejects a missing in-flight program image atomically', () => {
    const f = fixture(); f.submit(0, Array<number>(4096).fill(4)); const state = f.device.saveState();
    expect(() => f.device.prepareRestore({ ...state, programs: [] })).toThrow(); expect(f.device.saveState()).toEqual(state);
  });
});
