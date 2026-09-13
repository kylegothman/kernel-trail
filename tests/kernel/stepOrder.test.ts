import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { instructionProgram, type ProgramSpec } from '@kernel/process/Program';
import { asPageId, asPid, asResourceId, asTick } from '@kernel/types';
import type { KernelEvent, Tid } from '@kernel/types';
import { REFERENCE_CONFIG } from './fixtures/referenceConfig';
import { canonical, hash, strip } from './canonical';

const WORK: ProgramSpec = { name: 'compute', priority: 20, burst: 20, service: 20, arrival: 0, pages: 0 };

describe('eleven-phase execution', () => {
  it('phase order is 1,2,3,4,5,6,7,8,9,10,11 for 100 consecutive ticks', () => {
    const kernel = createKernel(REFERENCE_CONFIG); let phases: number[] = [];
    const off = kernel.onPhase(phase => phases.push(phase));
    for (let tick = 1; tick <= 100; tick++) {
      phases = []; kernel.step(); expect(phases.join(',')).toBe('1,2,3,4,5,6,7,8,9,10,11');
    }
    off(); phases = []; kernel.step(); expect(phases).toEqual([]);
  });
  it('tick starts at zero and increments by exactly one', () => {
    const kernel = createKernel(REFERENCE_CONFIG); expect(kernel.tick).toBe(0);
    for (let tick = 1; tick <= 100; tick++) { kernel.step(); expect(kernel.tick).toBe(tick); }
  });
  it('beginFrame clears in place; run copies all frames; seq never resets over 500 ticks', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const originalFrame = kernel.events.lastFrame;
    const observed: KernelEvent[] = []; kernel.events.onAny(event => observed.push(event));
    for (let arrival = 0; arrival < 500; arrival += 10) kernel.spawn({ ...WORK, burst: 2, service: 2, arrival });
    const runLog = [...kernel.run(500)];
    expect(runLog.length).toBeGreaterThan(100); expect(runLog).toEqual(observed);
    expect(kernel.events.lastFrame).toBe(originalFrame);
    expect(kernel.events.lastFrame.every(event => event.tick === 500)).toBe(true);
    for (let index = 1; index < runLog.length; index++) expect(runLog[index]?.seq).toBeGreaterThan(runLog[index - 1]?.seq ?? -1);
    const latest = [...kernel.events.lastFrame]; runLog.length = 0; expect(kernel.events.lastFrame).toEqual(latest);
  });
  it('sleep wakes in phase 4, before admission, and remains ready when another process holds the CPU', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const sleeper = kernel.spawn(WORK); const holder = kernel.spawn(WORK);
    kernel.step(); kernel.blockProcess(sleeper, { kind: 'sleep', untilTick: asTick(4) });
    kernel.run(2); expect(kernel.process(sleeper)?.state).toBe('waiting'); expect(kernel.process(holder)?.state).toBe('running');
    const seen: string[] = []; kernel.onPhase(phase => { if (kernel.tick === 4 && [1, 4, 5].includes(phase)) seen.push(`${phase}:${kernel.process(sleeper)?.state}`); });
    kernel.step(); expect(seen).toEqual(['1:waiting', '4:waiting', '5:ready']);
    expect(kernel.process(sleeper)).toMatchObject({ state: 'ready', readySince: 4, blockedOn: null });
  });
  it('unblock before admit enters the bootstrap queue first', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const sleeper = kernel.spawn(WORK); const arrival = kernel.spawn({ ...WORK, arrival: 3 });
    kernel.step(); kernel.blockProcess(sleeper, { kind: 'sleep', untilTick: asTick(3) }); kernel.step(); kernel.step();
    expect(kernel.process(sleeper)?.state).toBe('running'); expect(kernel.process(arrival)?.state).toBe('ready');
  });
  it('degree of multiprogramming admits ascending pids and excludes init', () => {
    const kernel = createKernel(REFERENCE_CONFIG, { degreeOfMultiprogramming: 1 }); const first = kernel.spawn({ ...WORK, service: 1 }); const second = kernel.spawn(WORK);
    kernel.step(); expect(kernel.process(first)?.state).toBe('zombie'); expect(kernel.process(second)?.state).toBe('new');
    kernel.step(); expect(kernel.process(second)?.state).toBe('running');
  });
  it.each([0, 1, 2])('context switch cost %i produces that many idle ticks before service', cost => {
    const kernel = createKernel(REFERENCE_CONFIG, { contextSwitchTicks: cost }); const pid = kernel.spawn(WORK);
    if (cost > 0) { kernel.run(cost); expect(kernel.process(pid)?.totalCpuUsed).toBe(0); }
    kernel.step(); expect(kernel.process(pid)?.totalCpuUsed).toBe(1);
  });
  it('device completions precede interrupts and condition checks; disabled hooks are inert', () => {
    const calls: string[] = []; const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn(WORK);
    kernel.installHooks({ io: { serviceCompletions: () => calls.push('completion'), deliverInterrupts: () => calls.push('interrupt'), isSatisfied: () => { calls.push('satisfied'); return true; } } });
    kernel.step(); kernel.blockProcess(pid, { kind: 'io', device: 'disk' as import('@kernel/types').DeviceId }); calls.length = 0; kernel.step();
    expect(calls.slice(0, 2)).toEqual(['completion', 'interrupt']); expect(calls[2]).toBe('satisfied');
    const disabled = createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: ['process', 'scheduler'] }); const completion = vi.fn();
    disabled.installHooks({ io: { serviceCompletions: completion, deliverInterrupts: completion }, memory: { expireTimers: completion }, storage: { expireTimers: completion } });
    disabled.run(20); expect(completion).not.toHaveBeenCalled();
  });
  it('deadlock detect hook runs only on its enabled strategy and interval', () => {
    const ticks: number[] = []; const kernel = createKernel(REFERENCE_CONFIG, { deadlockDetectionInterval: 3 }); kernel.installHooks({ deadlock: { maybeDetect: tick => ticks.push(tick) } }); kernel.run(10);
    expect(ticks).toEqual([3, 6, 9]);
    const ignored = createKernel({ ...REFERENCE_CONFIG, deadlockStrategy: 'ignore' }); const detect = vi.fn(); ignored.installHooks({ deadlock: { maybeDetect: detect } }); ignored.run(100); expect(detect).not.toHaveBeenCalled();
  });
  it('a major page fault charges CPU but preserves PC until phase 4 makes it runnable', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn({ ...WORK, pages: 1 }, { program: instructionProgram([{ kind: 'access', page: asPageId(0), write: false }]) });
    let loaded = false; kernel.installHooks({ memory: { access: () => ({ hit: loaded }), isSatisfied: () => loaded } });
    kernel.step(); const tid = kernel.process(pid)?.threads[0]; if (tid === undefined) throw new Error('missing thread');
    expect(kernel.process(pid)).toMatchObject({ state: 'waiting', totalCpuUsed: 1 }); expect(kernel.threads.table.get(tid)?.programCounter).toBe(0);
    kernel.step(); expect(kernel.process(pid)?.totalCpuUsed).toBe(1);
    loaded = true; kernel.step(); expect(kernel.threads.table.get(tid)?.programCounter).toBe(1); expect(kernel.process(pid)?.totalCpuUsed).toBe(2);
  });
  it.each(['many_to_one', 'one_to_one'] as const)('THREAD integration: %s blocks the proper scheduling entity', model => {
    const kernel = createKernel(REFERENCE_CONFIG, { threadModel: model }); const pid = kernel.spawn({ ...WORK, burst: 100, service: 100 }, { threadCount: 4 }); kernel.step();
    const tid = kernel.process(pid)?.threads[0]; if (tid === undefined) throw new Error('missing thread');
    kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(10) }, tid);
    const used = kernel.process(pid)?.totalCpuUsed ?? 0;
    expect(kernel.process(pid)?.state).toBe(model === 'many_to_one' ? 'waiting' : 'ready'); kernel.run(3);
    expect((kernel.process(pid)?.totalCpuUsed ?? 0) - used).toBe(model === 'many_to_one' ? 0 : 3);
  });
  it('exec inside instruction delivery starts replacement at PC zero', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn(WORK, { program: instructionProgram([{ kind: 'syscall', call: { name: 'exec', pid: asPid(99), args: ['next'] } }]) });
    kernel.registerProgram('next', instructionProgram([{ kind: 'compute' }, { kind: 'compute' }])); kernel.step();
    const tid = kernel.process(pid)?.threads[0]; expect(kernel.threads.table.get(tid as Tid)?.programCounter).toBe(0);
    kernel.run(2); expect(kernel.process(pid)?.state).toBe('zombie');
  });
  it('empty threads exits with code zero', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn(WORK); kernel.step(); const pcb = kernel.table.get(pid); if (pcb === undefined) throw new Error('missing process');
    const tid = pcb.threads[0]; if (tid === undefined) throw new Error('missing thread'); kernel.threads.join(pcb, tid);
    expect(kernel.process(pid)).toMatchObject({ state: 'zombie', exitCode: 0 });
  });
  it('unimplemented methods throw, while init-only snapshots preserve the user-requested replay regression', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const snap = kernel.snapshot();
    for (const action of [() => kernel.setReplacementPolicy('fifo'), () => kernel.setDiskPolicy('sstf'), () => kernel.evaluateBankers(asPid(2), asResourceId('r'), 1), () => kernel.detectDeadlock()]) expect(action).toThrow(/^not implemented:/);
    kernel.setAllocationStrategy('buddy'); expect(kernel.activeAllocationStrategy).toBe('buddy');
    kernel.restore(snap); kernel.spawn(WORK);
    expect(() => kernel.snapshot()).toThrow(/^not implemented: snapshot.*KernelSnapshot channel/);
    expect(() => kernel.restore(snap)).toThrow(/^not implemented: restore.*KernelSnapshot channel/);
  });
});

describe('populated process replay evidence', () => {
  function workload(seed: number, io = true) {
    const kernel = createKernel({ ...REFERENCE_CONFIG, seed, enabledSubsystems: REFERENCE_CONFIG.enabledSubsystems.filter(s => io || s !== 'io') });
    for (let i = 0; i < 8; i++) kernel.spawn({ ...WORK, name: `p${i}`, arrival: i * 3, pages: 8, service: 50, burst: 10 }, { threadCount: i % 3 + 1 });
    return kernel;
  }
  it('DET-D1 workload: 5000 ticks produce byte-identical nonempty logs and process state', () => {
    const a = workload(123); const b = workload(123); const first = a.run(5000); const second = b.run(5000);
    expect(first.length).toBeGreaterThan(30); expect(canonical(second)).toBe(canonical(first)); expect(canonical(b.processes)).toBe(canonical(a.processes));
  });
  it('DET-D3 workload: I/O enablement does not change context switches', () => {
    const a = workload(123, false); const b = workload(123); const switches = (events: readonly KernelEvent[]) => events.filter(e => e.type === 'context.switch').map(strip('seq'));
    const first = switches(a.run(5000)); expect(first.length).toBeGreaterThan(0); expect(canonical(switches(b.run(5000)))).toBe(canonical(first));
  });
  it('DET-D4 workload: 64 seeds, twice each, 1000 ticks, identical hashes', () => {
    for (let seed = 0; seed < 64; seed++) {
      const a = workload(seed); const b = workload(seed); const logA = a.run(1000); const logB = b.run(1000);
      expect(hash(canonical([logA, a.processes]))).toBe(hash(canonical([logB, b.processes])));
    }
  });
});

describe('thread progress at blocking and completion boundaries', () => {
  it('creation on the last CPU unit preserves its charged work instead of exiting', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn({ ...WORK, service: 1, burst: 1 }, { program: instructionProgram([{ kind: 'thread_create' }]) });
    kernel.step(); expect(kernel.process(pid)?.state).toBe('running'); expect(kernel.process(pid)?.threads).toHaveLength(2);
    expect(kernel.table.raw.get(pid)?.rawService).toBe(2); expect(kernel.process(pid)?.serviceRemaining).toBe(1);
    kernel.run(4); expect(kernel.process(pid)?.state).toBe('terminated');
  });
  it('a final-unit fault completes after wake instead of holding the CPU forever', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn({ ...WORK, service: 1, burst: 1 }, { program: instructionProgram([{ kind: 'access', page: asPageId(0), write: false }]) });
    kernel.installHooks({ memory: { access: () => ({ hit: false }), isSatisfied: () => true } });
    kernel.step(); expect(kernel.process(pid)?.state).toBe('waiting'); kernel.step(); expect(kernel.process(pid)?.state).toBe('zombie');
  });
  it('one-to-one wait blocks the calling thread while its sibling continues', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn(WORK, { threadCount: 2 }); kernel.step();
    kernel.spawn(WORK, { parent: pid }); const before = kernel.process(pid)?.totalCpuUsed ?? 0;
    kernel.syscall({ name: 'wait', pid, args: [] }); expect(kernel.process(pid)?.state).toBe('ready');
    kernel.step(); expect(kernel.process(pid)?.totalCpuUsed).toBe(before + 1);
  });
  it('any runnable LWP wakes the process even when the last blocker sleeps longer', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn({ ...WORK, burst: 100, service: 100 }, { threadCount: 2 }); kernel.step();
    const tids = kernel.process(pid)?.threads; if (tids?.[0] === undefined || tids[1] === undefined) throw new Error('missing threads');
    kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(5) }, tids[0]); kernel.step();
    kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(10) }, tids[1]); kernel.run(3);
    expect(kernel.tick).toBe(5); expect(kernel.process(pid)?.state).toBe('running'); expect(kernel.threads.table.get(tids[1])?.state).toBe('waiting');
  });
  it('finishing the last runnable thread yields the CPU while its sibling is blocked', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn({ ...WORK, service: 64, burst: 64 }, { threadCount: 2, serialFraction: 1 });
    const other = kernel.spawn({ ...WORK, arrival: 40 }); kernel.step(); const tid = kernel.process(pid)?.threads[0]; if (tid === undefined) throw new Error('missing thread');
    kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(100) }, tid); kernel.run(44);
    expect(kernel.process(pid)?.state).toBe('waiting'); expect(kernel.process(other)?.totalCpuUsed).toBeGreaterThan(0);
  });
  it('mailbox completion clears for a woken thread while its sibling keeps the PCB runnable', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = kernel.spawn({ ...WORK, burst: 100, service: 100 }, { threadCount: 3 }); const peer = kernel.spawn(WORK);
    const box = asResourceId('threadbox'); kernel.ipc.createMailbox(box, 0); kernel.step();
    kernel.ipc.send(pid, box, 2.5, kernel.tick); expect(kernel.process(pid)?.state).toBe('ready');
    kernel.step(); kernel.ipc.receive(peer, box); kernel.step();
    expect(kernel.lastSyscallResult(pid)).toEqual({ ok: true, value: null }); expect(kernel.ipc.hasCompletion(pid)).toBe(false);
    expect(kernel.ipc.hasMailboxWait(pid)).toBe(false);
  });
});

it('snapshot rejects custom tuning and IPC state instead of silently dropping it', () => {
  expect(() => createKernel(REFERENCE_CONFIG, { coreCount: 8 }).snapshot()).toThrow(/^not implemented:/);
  const kernel = createKernel(REFERENCE_CONFIG); kernel.ipc.createMailbox(asResourceId('empty'), 1);
  expect(() => kernel.snapshot()).toThrow(/^not implemented:/);
});
