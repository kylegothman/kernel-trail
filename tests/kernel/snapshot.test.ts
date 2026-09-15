/**
 * WP-11: the process snapshot channel, the completeness rule and fresh-kernel
 * restore. Acceptance criteria 11 to 14 and 26 to 30 of the package, the
 * mid-run MLFQ restore WP-04 handed over, and fixture DET-D2 on a workload.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createKernel, type KernelImpl } from '@kernel/Kernel';
import { KernelConfigError } from '@kernel/errors';
import { asPageId, asPid, asResourceId, asTick } from '@kernel/types';
import type { KernelConfig, KernelEvent, KernelSnapshot, Pid, ProcessSnapshotState } from '@kernel/types';
import { REFERENCE_CONFIG } from './fixtures/referenceConfig';
import { canonical } from './canonical';

/**
 * The reference configuration with one change: fatal starvation is switched off,
 * because under FCFS the long-lived process that owns the shared region's backing
 * space would otherwise be killed at tick 538, and an owner exiting with live
 * attachers is a hazard no test here is about. Every policy and subsystem is the
 * reference one.
 */
const WORKLOAD_CONFIG: KernelConfig = { ...REFERENCE_CONFIG, schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, starvationFatalThreshold: 1_000_000 } };
const REGION = asResourceId('region:shared-counter');
const BOX = asResourceId('box:orders');
const SPECS = [
  // lumen owns the shared region's backing space, so it outlives every run here.
  { name: 'lumen', priority: 2, arrival: 0, burst: 12, service: 12_000, pages: 6, threads: 2 },
  // sable and orrery attach the region and stay alive for every run here too.
  { name: 'sable', priority: 4, arrival: 2, burst: 9, service: 12_000, pages: 5, threads: 3 },
  { name: 'orrery', priority: 6, arrival: 4, burst: 15, service: 12_000, pages: 6, threads: 2 },
  { name: 'kestrel', priority: 8, arrival: 6, burst: 10, service: 180, pages: 4, threads: 1 },
  { name: 'vesper', priority: 10, arrival: 8, burst: 14, service: 220, pages: 5, threads: 2 },
] as const;

const value = (result: { ok: boolean; value?: unknown }): number => {
  if (!result.ok || typeof result.value !== 'number') throw new Error('expected a numeric syscall value');
  return result.value;
};

/** A fresh kernel prepared exactly as the workload kernel is, without any workload. */
function freshTarget(config: KernelConfig = WORKLOAD_CONFIG): KernelImpl {
  const kernel = createKernel(config);
  kernel.installHooks({ security: { rights: () => ['read', 'write'] } });
  return kernel;
}

/** At least four processes, three multi-threaded, one shared region with two attachers, a mailbox with messages, an uncollected exit. */
function workload(config: KernelConfig = WORKLOAD_CONFIG): { kernel: KernelImpl; pids: Pid[]; child: Pid } {
  const kernel = freshTarget(config);
  const pids = SPECS.map(spec => kernel.spawn({ name: spec.name, priority: spec.priority, arrival: spec.arrival, burst: spec.burst, service: spec.service, pages: spec.pages }, { threadCount: spec.threads }));
  kernel.run(12);
  const owner = kernel.process(pids[0] ?? asPid(2));
  if (owner === undefined) throw new Error('missing region owner');
  kernel.ipc.createSharedRegion({ id: REGION, pages: [asPageId(0)], space: owner.addressSpaceId, attached: [], value: 0 });
  expect(kernel.ipc.mmap(pids[1] ?? asPid(3), REGION, true).ok).toBe(true);
  expect(kernel.ipc.mmap(pids[2] ?? asPid(4), REGION, false).ok).toBe(true);
  kernel.ipc.createMailbox(BOX, 4);
  expect(kernel.ipc.send(pids[3] ?? asPid(5), BOX, 7, kernel.tick).ok).toBe(true);
  expect(kernel.ipc.send(pids[4] ?? asPid(6), BOX, 9, kernel.tick).ok).toBe(true);
  let running: Pid | undefined;
  for (let guard = 0; guard < 200 && running === undefined; guard++) {
    kernel.step();
    running = pids.find(pid => kernel.process(pid)?.state === 'running');
  }
  if (running === undefined) throw new Error('no process ran');
  const child = asPid(value(kernel.syscall({ name: 'fork', pid: running, args: [] })));
  for (let guard = 0; guard < 200 && kernel.process(child)?.state === 'new'; guard++) kernel.step();
  expect(['ready', 'running']).toContain(kernel.process(child)?.state);
  expect(kernel.syscall({ name: 'exit', pid: child, args: [3] })).toEqual({ ok: true, value: null });
  expect(kernel.process(child)).toMatchObject({ state: 'zombie', exitCode: 3 });
  return { kernel, pids, child };
}

function processSlot(snapshot: KernelSnapshot): ProcessSnapshotState {
  const slot = snapshot.subsystems?.process;
  if (slot === undefined) throw new Error('snapshot has no process contribution');
  return slot;
}

function roundTrip(source: KernelImpl, ticks: number, target: KernelImpl = freshTarget(source.config)): { tailA: readonly KernelEvent[]; tailB: readonly KernelEvent[]; a: KernelImpl; b: KernelImpl } {
  const snap = structuredClone(source.snapshot());
  const tailA = source.run(ticks);
  target.restore(structuredClone(snap));
  const tailB = target.run(ticks);
  return { tailA, tailB, a: source, b: target };
}

describe('DET-D2 on a workload: snapshot at 2000, restore into a fresh kernel, run 3000', () => {
  it('continues byte for byte in events and final state', () => {
    const { kernel } = workload();
    kernel.run(2000 - kernel.tick);
    expect(kernel.processes.some(pcb => pcb.state === 'zombie')).toBe(true);
    const { tailA, tailB, a, b } = roundTrip(kernel, 3000);
    expect(tailB.length).toBeGreaterThan(100);
    expect(canonical(tailB)).toBe(canonical(tailA));
    expect(canonical(b.snapshot())).toBe(canonical(a.snapshot()));
    expect(b.tick).toBe(asTick(5000));
  });

  it('AC27: 1500 ticks in, 1500 ticks on, with the workload the criterion names', () => {
    const { kernel, pids, child } = workload();
    expect(pids.length).toBeGreaterThanOrEqual(4);
    expect(SPECS.filter(spec => spec.threads >= 2).length).toBeGreaterThanOrEqual(3);
    kernel.run(1500 - kernel.tick);
    const slot = processSlot(kernel.snapshot());
    expect(slot.ipc.sharedRegions[0]?.attachments).toHaveLength(2);
    expect(slot.ipc.mailboxes[0]?.messages.length).toBeGreaterThan(0);
    expect(kernel.process(child)?.state).toBe('zombie');
    const { tailA, tailB, a, b } = roundTrip(kernel, 1500);
    expect(canonical(tailB)).toBe(canonical(tailA));
    expect(canonical(b.snapshot())).toBe(canonical(a.snapshot()));
  });

  it('holds across every seed of a short sweep', () => {
    for (const seed of [1, 2, 3]) {
      const { kernel } = workload({ ...WORKLOAD_CONFIG, seed });
      kernel.run(300);
      const { tailA, tailB } = roundTrip(kernel, 300);
      expect(canonical(tailB)).toBe(canonical(tailA));
    }
  });
});

describe('WP-04 handover: a mid-run MLFQ workload restored into a fresh kernel', () => {
  const MLFQ: KernelConfig = { ...REFERENCE_CONFIG, scheduler: 'mlfq', enabledSubsystems: ['process', 'scheduler'],
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, levelQuanta: [2, 4, 8], agingInterval: 20, starvationThreshold: 2000, starvationFatalThreshold: 3000, preemptive: false } };
  const rows = [
    { name: 'short', arrival: 0, burst: 1 },
    ...Array.from({ length: 4 }, (_, index) => ({ name: `long-${index}`, arrival: 0, burst: 150 })),
    ...Array.from({ length: 8 }, (_, index) => ({ name: `later-${index}`, arrival: 35 + Math.floor(index / 3) * 3, burst: 20 })),
    // Three arrivals on one tick after aging has begun, so level 0 holds a waiter while a promoted process runs.
    ...Array.from({ length: 3 }, (_, index) => ({ name: `pair-${index}`, arrival: 60, burst: 30 })),
    { name: 'future', arrival: 180, burst: 5 },
  ];
  function build(): KernelImpl {
    const kernel = createKernel(MLFQ, { threadCreateTicks: 0, contextSwitchTicks: 0, degreeOfMultiprogramming: 32 });
    for (const row of rows) kernel.spawn({ name: row.name, priority: 20, arrival: row.arrival, burst: row.burst, service: row.burst, pages: 0 });
    return kernel;
  }
  it('has processes on all three levels and an aged process, then continues byte-identically', () => {
    const kernel = build();
    const aged = new Set<Pid>();
    let ready = false;
    for (let step = 0; step < 400 && !ready; step++) {
      const before = new Map(kernel.processes.map(pcb => [pcb.pid, { state: pcb.state, level: pcb.queueLevel }]));
      kernel.step();
      for (const pcb of kernel.processes) {
        const prior = before.get(pcb.pid);
        if (prior?.state === 'ready' && pcb.queueLevel < prior.level) aged.add(pcb.pid);
      }
      const policy = kernel.saveSchedulerState().payload.policy;
      ready = policy.policy === 'mlfq' && policy.queues.length === 3 && policy.queues.every(queue => queue.length > 0) && aged.size > 0;
    }
    expect(ready).toBe(true);
    const levels = new Set(kernel.processes.filter(pcb => pcb.state === 'ready').map(pcb => pcb.queueLevel));
    expect([...levels].sort()).toEqual([0, 1, 2]);
    const target = createKernel(MLFQ, { threadCreateTicks: 0, contextSwitchTicks: 0, degreeOfMultiprogramming: 32 });
    const { tailA, tailB, a, b } = roundTrip(kernel, 600, target);
    expect(tailA.length).toBeGreaterThan(0);
    expect(canonical(tailB)).toBe(canonical(tailA));
    expect(canonical(b.snapshot())).toBe(canonical(a.snapshot()));
    expect(canonical(b.processes)).toBe(canonical(a.processes));
  });
});

describe('snapshot shape and purity', () => {
  it('is a pure function of state at twenty points of a 5000-tick run (I-40)', () => {
    const { kernel } = workload();
    for (let point = 0; point < 20; point++) {
      kernel.run(250);
      expect(canonical(kernel.snapshot())).toBe(canonical(kernel.snapshot()));
    }
    expect(kernel.tick).toBeGreaterThanOrEqual(5000);
  });

  it('canonical never throws and structuredClone succeeds across a 10,000-tick reference run', () => {
    const { kernel } = workload();
    for (let point = 0; point < 20; point++) {
      kernel.run(500);
      const snapshot = kernel.snapshot();
      expect(() => canonical(snapshot)).not.toThrow();
      expect(() => structuredClone(snapshot)).not.toThrow();
    }
    expect(kernel.tick).toBeGreaterThanOrEqual(10_000);
  });

  it('holds the twelve RNG states in registry order, all sfc32, and restores them into the existing stream objects', () => {
    const { kernel } = workload();
    kernel.run(50);
    const snap = kernel.snapshot();
    expect(snap.rng.map(state => state.label)).toEqual(['root', 'root/process', 'root/scheduler', 'root/memory', 'root/vm', 'root/sync',
      'root/deadlock', 'root/storage', 'root/io', 'root/fs', 'root/security', 'root/events']);
    for (const state of snap.rng) expect(state.algorithm).toBe('sfc32');
    const target = freshTarget({ ...WORKLOAD_CONFIG, seed: 77 });
    const syncRng = target.syncSubsystem.rng; const vmRng = target.memorySubsystem.pager.rng;
    target.restore(snap);
    expect(target.syncSubsystem.rng).toBe(syncRng); expect(target.memorySubsystem.pager.rng).toBe(vmRng);
    expect(target.snapshot().rng).toEqual(snap.rng);
  });

  it('carries seq across restore and emits nothing while restoring', () => {
    const { kernel } = workload();
    kernel.run(200);
    const snap = kernel.snapshot();
    const target = freshTarget();
    let emitted = 0; target.events.onAny(() => { emitted += 1; });
    target.restore(snap);
    expect(emitted).toBe(0);
    expect(target.snapshot().seq).toBe(snap.seq);
    const next = target.step();
    expect(next[0]?.seq).toBe(snap.seq);
  });

  it('deep-copies on the way out, so mutating live state does not change a held snapshot', () => {
    const { kernel, pids } = workload();
    const snap = kernel.snapshot(); const held = canonical(snap);
    const pcb = kernel.table.get(pids[0] ?? asPid(2)); if (pcb === undefined) throw new Error('missing');
    pcb.priority = 33; kernel.run(40);
    expect(canonical(snap)).toBe(held);
  });

  it('orders every array as documented and excludes pid 0', () => {
    const { kernel } = workload();
    kernel.run(100);
    const snap = kernel.snapshot(); const slot = processSlot(snap);
    const ascending = (values: readonly number[]): boolean => values.every((v, i) => i === 0 || v > (values[i - 1] ?? -1));
    const ascendingText = (values: readonly string[]): boolean => values.every((v, i) => i === 0 || v > (values[i - 1] ?? ''));
    expect(snap.processes.some(pcb => pcb.pid === asPid(0))).toBe(false);
    expect(ascending(snap.processes.map(pcb => pcb.pid))).toBe(true);
    expect(ascending(snap.frames.map(frame => frame.id))).toBe(true);
    expect(ascending(snap.pageTables.map(([space]) => space))).toBe(true);
    for (const [, entries] of snap.pageTables) expect(ascending(entries.map(entry => entry.page))).toBe(true);
    expect(ascendingText(snap.syncPrimitives.map(p => p.id))).toBe(true);
    expect(ascendingText(snap.resources.map(r => r.id))).toBe(true);
    expect(ascending(snap.inodes.map(i => i.id))).toBe(true);
    expect(ascendingText(snap.domains.map(d => d.id))).toBe(true);
    expect(ascendingText(snap.devices.map(d => d.id))).toBe(true);
    expect(ascending(slot.programs.map(p => p.pid))).toBe(true);
    expect(ascendingText(slot.namedPrograms.map(p => p.name))).toBe(true);
    expect(ascending(slot.threads.map(t => t.tid))).toBe(true);
    expect(ascending(slot.rawWork.map(([pid]) => pid))).toBe(true);
    expect(ascending(slot.cowRefCounts.map(([frame]) => frame))).toBe(true);
    expect(ascending(slot.lwpBindings.map(([tid]) => tid))).toBe(true);
    expect(ascendingText(slot.ipc.sharedRegions.map(r => r.id))).toBe(true);
    expect(ascendingText(slot.ipc.mailboxes.map(m => m.id))).toBe(true);
  });

  it('refuses a snapshot version other than 1 with KernelConfigError', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    const snap = { ...kernel.snapshot(), version: 2 } as unknown as KernelSnapshot;
    expect(() => kernel.restore(snap)).toThrow(KernelConfigError);
    expect(() => kernel.restore(snap)).toThrow(/unsupported snapshot version/);
  });
});

describe('the process contribution', () => {
  it('AC26: every field is populated, counted from the kernel rather than by hand', () => {
    const { kernel, pids } = workload();
    kernel.run(300);
    // A fresh fork right before the snapshot leaves one undelivered fork return on the table.
    let parent: Pid | undefined;
    for (let guard = 0; guard < 200 && parent === undefined; guard++) { kernel.step(); parent = pids.find(pid => kernel.process(pid)?.state === 'running'); }
    if (parent === undefined) throw new Error('nothing ran');
    expect(kernel.syscall({ name: 'fork', pid: parent, args: [] }).ok).toBe(true);
    const slot = processSlot(kernel.snapshot());
    expect(slot.pendingChildReturns).toHaveLength(kernel.lifecycle.childForkReturns.size);
    for (const [key, field] of Object.entries(slot)) {
      expect(field, key).not.toBeUndefined();
      // Explicit LWP bindings exist only under many-to-many threading (covered below), and copy debts
      // only after a copy-on-write write, which this workload does not perform; both live tables are empty here.
      if (Array.isArray(field) && key !== 'lwpBindings' && key !== 'copyDebts') expect(field.length, `${key} is empty`).toBeGreaterThan(0);
    }
    expect(slot.programs).toHaveLength(kernel.processes.length);
    expect(slot.threads).toHaveLength(kernel.threads.table.size);
    expect(slot.ipc.sharedRegions).toHaveLength(1);
    expect(slot.ipc.mailboxes).toHaveLength(1);
    expect(slot.counters.nextPid).toBeGreaterThan(Math.max(...kernel.processes.map(pcb => pcb.pid)));
    expect(slot.counters.nextTid).toBeGreaterThan(Math.max(...kernel.threads.table.keys()));
    expect(slot.executionDebt).toBe(slot.copyDebts.reduce((total, [, debt]) => total + debt, 0));
    expect(slot.programs.every(row => row.repeating === false)).toBe(true);
  });

  it('carries explicit LWP bindings under many-to-many threading', () => {
    const options = { threadModel: 'many_to_many' as const, lwpPoolSize: 2, coreCount: 2 };
    const kernel = createKernel(REFERENCE_CONFIG, options);
    const pid = kernel.spawn({ name: 'bound', priority: 1, arrival: 0, burst: 20, service: 400, pages: 2 }, { threadCount: 2 });
    kernel.run(3);
    const pcb = kernel.table.get(pid); if (pcb === undefined) throw new Error('missing');
    expect(kernel.threads.create(pcb, undefined, { lwp: 1 }).ok).toBe(true);
    kernel.run(20);
    const slot = processSlot(kernel.snapshot());
    expect(slot.lwpBindings.length).toBeGreaterThan(0);
    const target = createKernel(REFERENCE_CONFIG, options);
    target.restore(kernel.snapshot());
    expect(processSlot(target.snapshot()).lwpBindings).toEqual(slot.lwpBindings);
    expect(canonical(target.run(100))).toBe(canonical(kernel.run(100)));
  });

  it('side tables survive a fresh-kernel restore, one case per table', () => {
    const { kernel, pids, child } = workload();
    kernel.registerProgram('spare', kernel.program(pids[0] ?? asPid(2)) ?? (() => { throw new Error('missing program'); })());
    kernel.run(400);
    const snap = kernel.snapshot(); const slot = processSlot(snap);
    const target = freshTarget();
    target.restore(structuredClone(snap));
    const restored = processSlot(target.snapshot());
    const cases: Record<string, [unknown, unknown]> = {
      programs: [slot.programs, restored.programs],
      namedPrograms: [slot.namedPrograms, restored.namedPrograms],
      threads: [slot.threads, restored.threads],
      rawWork: [slot.rawWork, restored.rawWork],
      rawBursts: [slot.rawBursts, restored.rawBursts],
      threadAccounting: [slot.threadAccounting, restored.threadAccounting],
      deliveryCursors: [slot.deliveryCursors, restored.deliveryCursors],
      burstSizes: [slot.burstSizes, restored.burstSizes],
      lwpBindings: [slot.lwpBindings, restored.lwpBindings],
      counters: [slot.counters, restored.counters],
      pendingChildReturns: [slot.pendingChildReturns, restored.pendingChildReturns],
      cowRefCounts: [slot.cowRefCounts, restored.cowRefCounts],
      copyDebts: [slot.copyDebts, restored.copyDebts],
      syscallResults: [slot.syscallResults, restored.syscallResults],
      createdEvents: [slot.createdEvents, restored.createdEvents],
      ipc: [slot.ipc, restored.ipc],
      tuning: [slot.tuning, restored.tuning],
      executionDebt: [slot.executionDebt, restored.executionDebt],
    };
    for (const [name, [before, after]] of Object.entries(cases)) expect(canonical(after), name).toBe(canonical(before));
    expect(slot.namedPrograms.some(row => row.name === 'spare' && row.pid === pids[0])).toBe(true);
    expect(target.process(child)).toMatchObject({ state: 'zombie', exitCode: 3 });
    expect(target.lastSyscallResult(child)).toEqual({ ok: true, value: null });
    expect(target.ipc.mailbox(BOX)?.queue.map(message => message.payload)).toEqual([7, 9]);
    expect(target.ipc.sharedRegion(REGION)?.attached).toEqual(kernel.ipc.sharedRegion(REGION)?.attached);
  });

  it('gives every restored thread its own block-reason object', () => {
    const { kernel, pids } = workload();
    kernel.run(30);
    const sleeper = pids[0] ?? asPid(2);
    const threads = [...(kernel.process(sleeper)?.threads ?? [])];
    expect(threads.length).toBeGreaterThanOrEqual(2);
    const until = asTick(kernel.tick + 400);
    // Blocking one thread yields the CPU, so wait for the process to run again before blocking the next with an equal reason.
    for (const tid of threads) {
      for (let guard = 0; guard < 400 && kernel.process(sleeper)?.state !== 'running'; guard++) kernel.step();
      expect(kernel.process(sleeper)?.state).toBe('running');
      kernel.blockProcess(sleeper, { kind: 'sleep', untilTick: until }, tid);
    }
    expect(kernel.process(sleeper)?.state).toBe('waiting');
    const target = freshTarget();
    target.restore(kernel.snapshot());
    const reasons = threads.map(tid => target.threads.table.get(tid)?.blockedOn);
    expect(reasons.every(reason => reason?.kind === 'sleep')).toBe(true);
    expect(new Set(reasons).size).toBe(threads.length);
    expect(reasons.includes(target.process(sleeper)?.blockedOn ?? null)).toBe(false);
  });

  it('issues ids above every live id after a restore', () => {
    const { kernel, pids } = workload();
    kernel.run(60);
    const snap = kernel.snapshot();
    const target = freshTarget();
    target.restore(snap);
    const maxPid = Math.max(...snap.processes.map(pcb => pcb.pid));
    const maxTid = Math.max(...processSlot(snap).threads.map(thread => thread.tid));
    let running: Pid | undefined;
    for (let guard = 0; guard < 100 && running === undefined; guard++) { target.step(); running = pids.find(pid => target.process(pid)?.state === 'running'); }
    if (running === undefined) throw new Error('nothing ran after restore');
    const pcb = target.table.get(running); if (pcb === undefined) throw new Error('missing');
    expect(value(target.syscall({ name: 'fork', pid: running, args: [] }))).toBeGreaterThan(maxPid);
    expect(value(target.threads.create(pcb))).toBeGreaterThan(maxTid);
  });

  it('survives structuredClone and canonical unchanged, and a cloned restore behaves like the original', () => {
    const { kernel } = workload();
    kernel.run(150);
    const snap = kernel.snapshot(); const clone = structuredClone(snap);
    expect(canonical(processSlot(clone))).toBe(canonical(processSlot(snap)));
    const original = freshTarget(); original.restore(snap);
    const cloned = freshTarget(); cloned.restore(clone);
    expect(canonical(cloned.run(200))).toBe(canonical(original.run(200)));
    expect(canonical(cloned.snapshot())).toBe(canonical(original.snapshot()));
  });

  it('the init-only guard and its marker are gone from src/kernel', () => {
    const root = resolve(__dirname, '..', '..', 'src', 'kernel');
    const files: string[] = [];
    const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith('.ts')) files.push(path);
    } };
    walk(root);
    const hits = files.filter(file => readFileSync(file, 'utf8').includes('blocked on contract change, see report'));
    expect(hits).toEqual([]);
    const kernel = createKernel(REFERENCE_CONFIG); kernel.spawn({ name: 'w', priority: 1, arrival: 0, burst: 4, service: 8, pages: 1 });
    expect(() => kernel.snapshot()).not.toThrow();
  });
});

describe('the completeness check and refused restores', () => {
  function workloadTarget(): { target: KernelImpl; before: string } {
    const { kernel } = workload(); kernel.run(100);
    return { target: kernel, before: canonical(kernel.snapshot()) };
  }
  function strip<T extends object>(source: T, key: keyof T): T {
    const copy = { ...source }; delete copy[key]; return copy;
  }

  it('AC28: four truncated snapshots are refused and leave the target canonically unchanged', () => {
    const { target, before } = workloadTarget();
    const { kernel: other } = workload({ ...WORKLOAD_CONFIG, seed: 5 }); other.run(90);
    const full = structuredClone(other.snapshot());
    const cases: KernelSnapshot[] = [
      strip(full, 'completeness'),
      { ...full, completeness: 'init_only' },
      strip({ ...full, completeness: 'full' }, 'subsystems'),
      { ...full, completeness: 'full', subsystems: strip(full.subsystems ?? {}, 'process') },
    ];
    for (const snapshot of cases) {
      expect(() => target.restore(snapshot)).toThrow(/completeness|process contribution|subsystems/);
      expect(canonical(target.snapshot())).toBe(before);
    }
  });

  it('refuses a contribution whose owner rejects its version, and rolls the kernel back', () => {
    const { target, before } = workloadTarget();
    const { kernel: other } = workload({ ...WORKLOAD_CONFIG, seed: 9 }); other.run(120);
    const full = structuredClone(other.snapshot());
    const sync = full.subsystems?.sync; if (sync === undefined) throw new Error('missing sync slot');
    const broken: KernelSnapshot = { ...full, subsystems: { ...full.subsystems, sync: { ...sync, version: 2 as unknown as 1 } } };
    expect(() => target.restore(broken)).toThrow();
    expect(canonical(target.snapshot())).toBe(before);
    const deadlock = full.subsystems?.deadlock; if (deadlock === undefined) throw new Error('missing deadlock slot');
    const brokenLate: KernelSnapshot = { ...full, subsystems: { ...full.subsystems, deadlock: { ...deadlock, version: 9 as unknown as 1 } } };
    expect(() => target.restore(brokenLate)).toThrow();
    expect(canonical(target.snapshot())).toBe(before);
    target.restore(full);
    expect(canonical(target.snapshot())).toBe(canonical(full));
  });

  it('refuses a full snapshot whose tuning differs from this kernel', () => {
    const { kernel } = workload(); kernel.run(20);
    const target = createKernel(WORKLOAD_CONFIG, { coreCount: 2 });
    const before = canonical(target.snapshot());
    expect(() => target.restore(kernel.snapshot())).toThrow(/tuning/);
    expect(canonical(target.snapshot())).toBe(before);
  });

  it('restores an init-only snapshot into a fresh kernel and refuses it for a workload kernel', () => {
    const fresh = createKernel(REFERENCE_CONFIG); fresh.run(40);
    const snap = fresh.snapshot();
    expect(snap.completeness).toBe('init_only');
    const target = createKernel(REFERENCE_CONFIG);
    target.restore(snap);
    expect(canonical(target.snapshot())).toBe(canonical(snap));
    const { target: busy, before } = workloadTarget();
    expect(() => busy.restore(snap)).toThrow(/completeness|init-only/);
    expect(canonical(busy.snapshot())).toBe(before);
  });

  it('refuses a process contribution that would reissue a live id, before any mutation', () => {
    const { target, before } = workloadTarget();
    const snap = structuredClone(target.snapshot()); const slot = processSlot(snap);
    const stale: KernelSnapshot = { ...snap, subsystems: { ...snap.subsystems, process: { ...slot, counters: { ...slot.counters, nextPid: 2 } } } };
    expect(() => target.restore(stale)).toThrow(/next pid/);
    expect(canonical(target.snapshot())).toBe(before);
  });
});
