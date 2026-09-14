import { describe, expect, it } from 'vitest';
import { createKernel as makeKernelForIo, type KernelImpl as IoKernel, type KernelOptions as IoKernelOptions } from '../../../src/kernel/Kernel';
import { instructionProgram as ioProgram, type Instruction as IoInstruction } from '../../../src/kernel/process/Program';
import { asPageId as ioPage, asTick as ioTick } from '../../../src/kernel/types';
import type { DeviceId as IoDeviceId, IoMode as IntegrationMode, KernelEvent as IoKernelEvent } from '../../../src/kernel/types';
import { REFERENCE_CONFIG as IO_REFERENCE } from '../fixtures/referenceConfig';

describe('kernel I/O integration', () => {
  const device = 'io-fixture' as IoDeviceId;
  const compute: IoInstruction = { kind: 'compute' };
  function kernel(mode: IntegrationMode = 'interrupt', tuning: IoKernelOptions = {}) {
    const result = makeKernelForIo({ ...IO_REFERENCE, enabledSubsystems: ['process', 'scheduler', 'io'] },
      { threadCreateTicks: 0, contextSwitchTicks: 0, ...tuning });
    result.ioSubsystem.registerTimerDevice({ id: device, latency: 20, mode, wordSize: 64 });
    return result;
  }
  function spawn(k: IoKernel, instructions: readonly IoInstruction[], service = 1000, count = 1) {
    const pid = k.spawn({ name: 'I/O integration actor', priority: 10, arrival: 0, burst: service, service, pages: 1 },
      { program: ioProgram(instructions), threadCount: count });
    const pcb = k.table.get(pid)!; const thread = k.threads.table.get(pcb.threads[0]!)!;
    return { pid, pcb, thread };
  }
  function until(k: IoKernel, condition: () => boolean, maximum = 400) {
    for (let count = 0; count < maximum && !condition(); count++) k.step();
    expect(condition()).toBe(true);
  }
  it.each(['interrupt', 'dma'] as const)('a final-unit %s instruction waits for completion before normal exit', mode => {
    const k = kernel(mode); const a = spawn(k, [{ kind: 'io', device }], 1);
    k.run(mode === 'dma' ? 2 : 1);
    expect(a.pcb.state).toBe('waiting'); expect(a.pcb.serviceRemaining).toBe(0);
    expect(a.thread.programCounter).toBe(1);
    until(k, () => a.pcb.state === 'zombie');
    expect(a.pcb.terminationReason).toBe('normal_exit');
    expect(k.tick).toBeGreaterThan(20); expect(k.ioSubsystem.saveState().io.payload.requests).toEqual([]);
  });
  it('charges interrupt debt to the kernel without advancing a process or increasing its CPU time', () => {
    const k = kernel(); const a = spawn(k, [compute]); k.step();
    const used = a.pcb.totalCpuUsed; const pc = a.thread.programCounter;
    k.ioSubsystem.interrupts.raise('timer' as IoDeviceId, { kind: 'timer' }); k.step();
    expect(k.ioSubsystem.debt).toBe(1); expect(k.saveSchedulerState().payload.runtime.switchDebt).toBe(1);
    expect(a.pcb.totalCpuUsed).toBe(used); expect(a.thread.programCounter).toBe(pc);
    k.step(); expect(k.ioSubsystem.debt).toBe(0); expect(a.pcb.totalCpuUsed).toBe(used);
    expect(k.saveSchedulerState().payload.accounting.busyTicks).toBe(1);
    k.step(); expect(a.pcb.totalCpuUsed).toBe(used + 1); expect(a.thread.programCounter).toBe(pc + 1);
  });
  it('preserves I/O debt when a context switch overwrites the shared debt counter', () => {
    const k = kernel('interrupt', { contextSwitchTicks: 1 });
    const a = spawn(k, [compute]); const b = spawn(k, [compute]); k.run(2);
    k.blockProcess(a.pid, { kind: 'sleep', untilTick: ioTick(100) });
    k.ioSubsystem.interrupts.raise('timer' as IoDeviceId, { kind: 'timer' });
    k.step(); expect([k.ioSubsystem.debt, k.saveSchedulerState().payload.runtime.switchDebt]).toEqual([1, 2]);
    k.step(); expect([k.ioSubsystem.debt, k.saveSchedulerState().payload.runtime.switchDebt]).toEqual([0, 1]);
    k.step(); expect([k.ioSubsystem.debt, k.saveSchedulerState().payload.runtime.switchDebt]).toEqual([0, 0]);
    expect(b.pcb.totalCpuUsed).toBe(0); k.step(); expect(b.pcb.totalCpuUsed).toBe(1);
  });
  it('drains I/O debt while idle, including an I/O-only kernel', () => {
    const k = makeKernelForIo({ ...IO_REFERENCE, enabledSubsystems: ['io'] });
    k.ioSubsystem.interrupts.raise('timer' as IoDeviceId, { kind: 'timer' });
    k.step(); expect([k.ioSubsystem.debt, k.saveSchedulerState().payload.runtime.switchDebt]).toEqual([1, 1]);
    k.step(); expect([k.ioSubsystem.debt, k.saveSchedulerState().payload.runtime.switchDebt]).toEqual([0, 0]);
    expect(k.processes.every(pcb => pcb.totalCpuUsed === 0)).toBe(true);
  });
  it('projects only whole-process waits while preserving each blocked TCB', () => {
    const k = kernel(); const a = spawn(k, [{ kind: 'io', device }, compute], 1000, 2);
    k.step(); expect(a.pcb.state).toBe('ready'); expect(k.ioSubsystem.devices.find(row => row.id === device)?.queue).toEqual([]);
    expect(a.pcb.threads.filter(tid => k.threads.table.get(tid)?.state === 'waiting')).toHaveLength(1);
    k.step(); expect(a.pcb.state).toBe('waiting'); expect(k.ioSubsystem.devices.find(row => row.id === device)?.queue).toEqual([a.pid]);
    until(k, () => a.pcb.state !== 'waiting');
    expect(a.pcb.threads.filter(tid => k.threads.table.get(tid)?.state === 'waiting')).toHaveLength(1);
    expect(k.ioSubsystem.devices.find(row => row.id === device)?.queue).toEqual([]);
  });
  it('suppresses program lookup, memory faults and PC advancement on every stolen DMA tick', () => {
    const k = makeKernelForIo({ ...IO_REFERENCE, enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'io'] },
      { threadCreateTicks: 0, contextSwitchTicks: 0 });
    k.ioSubsystem.registerTimerDevice({ id: device, latency: 20, mode: 'dma', wordSize: 64 });
    spawn(k, [{ kind: 'io', device }, compute]); let poison = false; let poisonedLookups = 0;
    const program = { ...ioProgram([compute]), at: () => { if (poison) poisonedLookups += 1;
      return poison ? { kind: 'access' as const, page: ioPage(999), write: true } : compute; } };
    const pid = k.spawn({ name: 'continuous DMA peer', priority: 10, arrival: 0, burst: 1000, service: 1000, pages: 1 }, { program });
    const worker = k.threads.table.get(k.process(pid)!.threads[0]!)!;
    const events: IoKernelEvent[] = []; k.events.onAny(event => events.push(event));
    k.onPhase(phase => { if (phase === 8) poison = k.ioSubsystem.saveState().io.payload.requests.some(req =>
      req.continuation.mode === 'dma' && req.service.kind === 'completed' && !req.continuation.dmaEventEmitted
      && req.continuation.elapsedTransferTicks < req.continuation.transferTicks
      && req.continuation.stealsCharged < req.continuation.stealAccumulator); });
    let observedSteals = 0;
    for (let tick = 0; tick < 90; tick++) {
      const before = k.ioSubsystem.cpuCharges.dmaStealTicks; const pc = worker.programCounter; k.step();
      if (k.ioSubsystem.cpuCharges.dmaStealTicks > before) { observedSteals += 1; expect(worker.programCounter).toBe(pc); }
    }
    expect(observedSteals).toBe(6); expect(poisonedLookups).toBe(0);
    expect(events.some(event => event.type === 'memory.page_fault' || event.type === 'security.access_denied')).toBe(false);
    expect(events.filter(event => event.type === 'io.dma_transfer')).toHaveLength(1);
  });
  it('preserves the legacy TLB ioctl and exposes tty0 and all six disk policy setters', () => {
    const k = makeKernelForIo(IO_REFERENCE); const init = k.processes[0]!.pid;
    expect(k.ioSubsystem.devices.map(row => row.id)).toContain('tty0');
    expect(k.syscall({ name: 'ioctl', pid: init, args: ['tlb_flush'] })).toEqual({ ok: true, value: null });
    expect(k.syscall({ name: 'ioctl', pid: init, args: ['tty0', 'set_mode', 'polling'] }).ok).toBe(true);
    expect(k.ioSubsystem.mode('tty0' as IoDeviceId)).toBe('polling');
    for (const policy of ['fcfs', 'sstf', 'scan', 'cscan', 'look', 'clook'] as const) {
      expect(k.syscall({ name: 'ioctl', pid: init, args: ['disk0', 'set_policy', policy] }).ok).toBe(true);
      expect(k.activeDiskPolicy).toBe(policy); expect(k.config.diskPolicy).toBe(policy);
    }
    expect(k.syscall({ name: 'ioctl', pid: init, args: ['tty0', 'unknown'] })).toMatchObject({ ok: false, errno: 'EINVAL' });
  });
  it('leaves disabled owners idle without RNG draws, requests or charges', () => {
    const k = makeKernelForIo({ ...IO_REFERENCE, enabledSubsystems: [] }); const before = k.snapshot();
    k.run(20); const after = k.snapshot();
    expect(after.rng).toEqual(before.rng);
    expect(after.subsystems?.io?.payload).toMatchObject({ requests: [], kernelDebt: 0, lastTimerTick: null,
      lastCompletionTick: null, cpuCharges: { issueTicks: 0, interruptTicks: 0, copyTicks: 0, dmaStealTicks: 0 } });
    expect(after.subsystems?.storage?.payload).toMatchObject({ requests: [], physicalOperations: [], paging: null });
  });
});

// Append-only WP-09 tests. These imports are valid at module scope after the existing describe.
import { createRng as ioComparisonRng } from '../../../src/kernel/rng';
import type { BlockId as IoBlockId, InodeId as IoInodeId, IoSnapshotResult as IoOwnedResult } from '../../../src/kernel/types';

// These fixtures use the real phase-8 gate. Kernel debt prevents any actor CPU
// delivery; a DMA steal consumes the peer's CPU tick while preserving its PC and
// useful service. The peer remains runnable for the full transfer, so the 100
// comparison includes sixty actual steals rather than a theoretical multiplier.
describe('I/O mode cost and device controls', () => {
  const device = 'cost-fixture' as IoDeviceId;
  function costRun(mode: IntegrationMode, peer = mode === 'dma', requests = 10) {
    const k = makeKernelForIo({ ...IO_REFERENCE, scheduler: 'priority', enabledSubsystems: ['process', 'scheduler', 'io'] },
      { threadCreateTicks: 0, contextSwitchTicks: 0 });
    k.ioSubsystem.registerTimerDevice({ id: device, latency: 20, mode, wordSize: 64 });
    const pid = k.spawn({ name: 'mode cost requester', priority: 0, arrival: 0, burst: requests, service: requests, pages: 0 },
      { program: ioProgram(Array.from({ length: requests }, () => ({ kind: 'io' as const, device }))) });
    const requester = k.process(pid)!; const thread = k.threads.table.get(requester.threads[0]!)!;
    const peerPid = peer ? k.spawn({ name: 'eligible DMA peer', priority: 20, arrival: 0, burst: 10000, service: 10000, pages: 0 },
      { program: ioProgram([{ kind: 'compute' }]) }) : null;
    const worker = peerPid === null ? null : k.process(peerPid)!;
    const workerThread = worker === null ? null : k.threads.table.get(worker.threads[0]!)!;
    const events: IoKernelEvent[] = []; k.events.onAny(event => events.push(event));
    let debtGate = false; let debtTicks = 0; let observedSteals = 0;
    k.onPhase(phase => { if (phase === 8) debtGate = k.saveSchedulerState().payload.runtime.switchDebt > 0; });
    for (let tick = 0; tick < 6000 && requester.state !== 'zombie'; tick++) {
      const requesterCpu = requester.totalCpuUsed; const workerCpu = worker?.totalCpuUsed ?? 0;
      const workerPc = workerThread?.programCounter ?? 0; const steals = k.ioSubsystem.cpuCharges.dmaStealTicks;
      k.step();
      if (debtGate) { debtTicks += 1; expect(requester.totalCpuUsed).toBe(requesterCpu); expect(worker?.totalCpuUsed ?? 0).toBe(workerCpu); }
      if (k.ioSubsystem.cpuCharges.dmaStealTicks > steals) {
        observedSteals += 1; expect(worker).not.toBeNull(); expect(worker!.totalCpuUsed).toBe(workerCpu + 1);
        expect(workerThread!.programCounter).toBe(workerPc); expect(requester.totalCpuUsed).toBe(requesterCpu);
      }
    }
    expect(requester.state).toBe('zombie'); expect(thread.programCounter).toBe(requests);
    expect(k.ioSubsystem.debt).toBe(0);
    return { k, requester, worker, workerThread, events, debtTicks, observedSteals };
  }
  it.each([
    ['polling', 840, 840, 0, 0, 0], ['interrupt', 670, 10, 20, 640, 0], ['dma', 100, 20, 20, 0, 60],
  ] as const)('IO-COST-1: ten requests in %s mode cost %i actual CPU ticks', (mode, total, requesterCpu, interrupt, copy, steals) => {
    const run = costRun(mode); const charges = run.k.ioSubsystem.cpuCharges;
    expect(run.requester.totalCpuUsed).toBe(requesterCpu);
    expect(charges).toEqual({ issueTicks: mode === 'dma' ? 20 : 10, interruptTicks: interrupt, copyTicks: copy, dmaStealTicks: steals });
    expect(run.requester.totalCpuUsed + charges.interruptTicks + charges.copyTicks + charges.dmaStealTicks).toBe(total);
    expect(run.debtTicks).toBe(interrupt + copy); expect(run.observedSteals).toBe(steals);
    expect(run.events.filter(event => event.type === 'io.interrupt')).toHaveLength(mode === 'polling' ? 0 : 10);
    expect(run.k.ioSubsystem.pollTicks(run.requester.pid)).toBe(mode === 'polling' ? 190 : 0);
    if (run.worker !== null) expect(run.worker.totalCpuUsed - run.workerThread!.programCounter).toBe(60);
    if (mode === 'dma') expect(run.events.filter(event => event.type === 'io.dma_transfer').map(event => event.bytes)).toEqual(Array(10).fill(4096));
  });
  it('IO-POLL-1: the final service unit survives setup, nineteen scheduled polls and sixty-four copies', () => {
    const run = costRun('polling', false, 1);
    expect(run.requester.totalCpuUsed).toBe(84); expect(run.requester.serviceRemaining).toBe(0);
    expect(run.events.filter(event => event.type === 'io.poll_wasted')).toEqual([
      expect.objectContaining({ device, wastedTicks: 19 }),
    ]);
  });
  it('creates no DMA steals when there is no eligible peer', () => {
    const run = costRun('dma', false, 1);
    expect(run.requester.totalCpuUsed).toBe(2); expect(run.observedSteals).toBe(0);
    expect(run.k.ioSubsystem.cpuCharges).toEqual({ issueTicks: 2, interruptTicks: 2, copyTicks: 0, dmaStealTicks: 0 });
  });
  it('changes live modes without modifying the frozen public defaults', () => {
    const k = makeKernelForIo({ ...IO_REFERENCE, enabledSubsystems: ['io'] }); const io = k.ioSubsystem;
    for (const name of ['disk0', 'nvm0', 'tty0', 'net0']) {
      const deviceId = name as IoDeviceId; const original = io.devices.find(row => row.id === deviceId)!.mode;
      expect(io.control(deviceId, 'set_mode', ['polling'], undefined)).toEqual({ ok: true, value: null });
      expect(io.mode(deviceId)).toBe('polling'); expect(io.devices.find(row => row.id === deviceId)!.mode).toBe(original);
      expect(io.control(deviceId, 'set_mode', ['invalid'], undefined)).toMatchObject({ ok: false, errno: 'EINVAL' });
      expect(io.control(deviceId, 'unknown', [], undefined)).toMatchObject({ ok: false, errno: 'EINVAL' });
    }
  });
  it('retains packet loss results and consumes exactly one root/io draw per completed packet, including probabilities zero and one', () => {
    const k = makeKernelForIo({ ...IO_REFERENCE, enabledSubsystems: ['io'] }); const io = k.ioSubsystem;
    const expected = ioComparisonRng(IO_REFERENCE.seed).fork('io');
    for (const probability of [0, 1, 0.5, 0.5]) {
      const before = k.snapshot().rng; expect(io.control('net0' as IoDeviceId, 'set_loss', [probability], undefined).ok).toBe(true);
      const requestId = io.submit({ kind: 'kernel', purpose: 'fixture' }, 'net0' as IoDeviceId);
      const request = io.saveState().io.payload.requests.find(row => row.id === requestId)!;
      expect(request.command).toEqual({ kind: 'packet', contents: Array(64).fill(0) });
      for (let tick = 0; tick < 100 && !io.saveState().io.payload.requests.find(row => row.id === requestId)?.wakeable; tick++) k.step();
      const lost = expected.next() < probability;
      const retained = io.saveState().io.payload.requests.find(row => row.id === requestId)!;
      expect(retained.service).toMatchObject({ kind: 'completed', result: { kind: lost ? 'lost' : 'ok' } });
      expect(io.takeResult(requestId)).toEqual(lost ? { kind: 'lost' } : { kind: 'ok', data: [] });
      expect(io.takeResult(requestId)).toBeNull();
      const after = k.snapshot().rng;
      expect(after.filter(row => row.label !== 'root/io')).toEqual(before.filter(row => row.label !== 'root/io'));
      expect(after.find(row => row.label === 'root/io')).toEqual(expected.save());
    }
  });
  it('drains emitted character bytes on flush and rejects reset while DMA remains in flight', () => {
    const k = makeKernelForIo({ ...IO_REFERENCE, enabledSubsystems: ['io'] }); const io = k.ioSubsystem;
    const tty = 'tty0' as IoDeviceId;
    const requestId = io.submit({ kind: 'kernel', purpose: 'fixture' }, tty, { kind: 'character', contents: [65, 66, 67] });
    for (let tick = 0; tick < 20 && io.takeResult(requestId) === null; tick++) k.step();
    expect(io.control(tty, 'flush', [], undefined)).toEqual({ ok: true, value: 3 });
    expect(io.control(tty, 'flush', [], undefined)).toEqual({ ok: true, value: 0 });
    const dma = 'reset-dma' as IoDeviceId; io.registerTimerDevice({ id: dma, latency: 20, mode: 'dma' });
    io.submit({ kind: 'kernel', purpose: 'fixture' }, dma);
    expect(io.control(dma, 'reset', [], undefined)).toMatchObject({ ok: false, errno: 'EBUSY' });
    expect(io.control(tty, 'set_loss', [0.5], undefined)).toMatchObject({ ok: false, errno: 'EINVAL' });
  });
  it('exposes NVM trim/flush and routes disk failure through an explicitly bound RAID target', () => {
    const k = makeKernelForIo({ ...IO_REFERENCE, enabledSubsystems: ['storage', 'io'] }); const io = k.ioSubsystem;
    expect(io.control('nvm0' as IoDeviceId, 'trim', [0, 1], undefined).ok).toBe(true);
    expect(io.control('nvm0' as IoDeviceId, 'flush', [], undefined).ok).toBe(true);
    const array = k.storageSubsystem.registerRaid({ arrayId: 'test-mirror', level: 1, members: ['test-a', 'test-b'], blocksPerMember: 32 });
    expect(io.bindStorage('disk0' as IoDeviceId, { kind: 'raid', arrayId: 'test-mirror' }).ok).toBe(true);
    expect(io.control('disk0' as IoDeviceId, 'set_policy', ['sstf'], undefined).ok).toBe(true);
    expect(k.storageSubsystem.activePolicy).toBe('sstf');
    expect(io.control('disk0' as IoDeviceId, 'fail_disk', [0], undefined).ok).toBe(true);
    expect(array.saveState().members[0]?.failed).toBe(true);
    expect(io.control('net0' as IoDeviceId, 'trim', [0, 1], undefined)).toMatchObject({ ok: false, errno: 'EINVAL' });
  });
});

// An init-only kernel may persist owned subsystem work without invoking the
// deferred WP-11 process-program restore channel. Both owners prepare against
// one exact snapshot, including their real request/flush foreign keys.
describe('AC23 combined storage and I/O continuation', () => {
  const configuration = { ...IO_REFERENCE, diskPolicy: 'scan' as const, enabledSubsystems: ['storage', 'io'] as const };
  const block = (value: number): IoBlockId => value as IoBlockId;
  const printer = 'restore-printer' as IoDeviceId;
  const storm = 'restore-storm' as IoDeviceId;
  const pulse = 'restore-pulse' as IoDeviceId;
  function stage() {
    const k = makeKernelForIo({ ...configuration, enabledSubsystems: [...configuration.enabledSubsystems] }); const io = k.ioSubsystem;
    io.registerTimerDevice({ id: storm, latency: 1, priority: 1 });
    io.registerTimerDevice({ id: pulse, latency: 1, priority: 10 }); io.registerPrinter(printer);
    for (let tick = 1; tick <= 29; tick++) { for (let count = 0; count < 5; count++) io.interrupts.raise(storm); k.step(); }
    const drive = k.storageSubsystem.drives.get('disk0')!;
    drive.head.cylinder = 50; drive.head.direction = 'up'; k.storageSubsystem.setCostMultiplier(20);
    for (const cylinder of [10, 20, 30]) io.submit({ kind: 'kernel', purpose: 'fixture' }, 'disk0' as IoDeviceId,
      { kind: 'read', lba: block(cylinder * 256), bytes: 512 });
    io.cache.write('disk0' as IoDeviceId, block(40 * 256), Array(512).fill(7));
    const pendingId = io.submit({ kind: 'kernel', purpose: 'fixture' }, pulse);
    const firstJob = io.spool.submit(printer, { kind: 'fixture' }, 7 as IoInodeId, Array(8).fill(65));
    const nextJob = io.spool.submit(printer, { kind: 'fixture' }, 7 as IoInodeId, Array(8).fill(66));
    io.control('net0' as IoDeviceId, 'set_loss', [0.5], undefined);
    const packetId = io.submit({ kind: 'kernel', purpose: 'fixture' }, 'net0' as IoDeviceId);
    for (let count = 0; count < 5; count++) io.interrupts.raise(storm); k.step();
    return { k, pendingId, firstJob, nextJob, packetId };
  }
  it('resumes the same SCAN path, next interrupt, next spool job, packet draw and debt in a fresh kernel', () => {
    const { k, pendingId, firstJob, nextJob, packetId } = stage(); const snapshot = k.snapshot(); const snapshotJson = JSON.stringify(snapshot);
    const ioState = snapshot.subsystems!.io!.payload; const storageState = snapshot.subsystems!.storage!.payload;
    expect(snapshot.tick).toBe(30); expect(ioState.devices.find(row => row.id === storm)).toMatchObject({ mode: 'polling', mitigation: { priorMode: 'interrupt' } });
    expect(ioState.interrupts.lines.find(row => row.device === pulse)?.pending).toEqual([
      expect.objectContaining({ kind: 'completion', requestId: pendingId }),
    ]);
    expect(ioState.spools.find(row => row.device === printer)?.jobs.map(row => row.id)).toEqual([firstJob, nextJob]);
    expect(ioState.spools.find(row => row.device === printer)?.jobs[0]?.offset).toBe(1);
    expect(storageState.drives.find(row => row.driveId === 'disk0')?.active).toMatchObject({ policy: 'scan' });
    expect(storageState.drives.find(row => row.driveId === 'disk0')?.queue).toHaveLength(3);
    expect(ioState.cache.flushes[0]?.progress.kind).toBe('storage'); expect(ioState.kernelDebt).toBeGreaterThan(0);
    const restored = makeKernelForIo({ ...configuration, enabledSubsystems: [...configuration.enabledSubsystems] }); restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    const path = () => k.storageSubsystem.drives.get('disk0')!.projectedPath('scan');
    const restoredPath = () => restored.storageSubsystem.drives.get('disk0')!.projectedPath('scan');
    expect(path()).toEqual([50, 199, 40, 30, 20, 10]); expect(restoredPath()).toEqual(path());
    const originalEvents: IoKernelEvent[] = []; const replayEvents: IoKernelEvent[] = [];
    k.events.onAny(event => originalEvents.push(event)); restored.events.onAny(event => replayEvents.push(event));
    const output = (kernel: IoKernel): readonly number[] => {
      const driver = kernel.ioSubsystem.saveState().io.payload.devices.find(row => row.id === printer)!.driver;
      if (driver.kind !== 'printer_fixture') throw new Error('missing printer fixture'); return driver.output;
    };
    const results: (IoOwnedResult | null)[][] = [[], []];
    for (let tick = 0; tick < 160; tick++) {
      k.step(); restored.step(); expect(restoredPath()).toEqual(path());
      expect(restored.ioSubsystem.debt).toBe(k.ioSubsystem.debt);
      expect(output(restored)).toEqual(output(k));
      const originalSpool = k.ioSubsystem.spool.snapshot().find(row => row.device === printer)!;
      expect(restored.ioSubsystem.spool.snapshot().find(row => row.device === printer)).toEqual(originalSpool);
      if (k.tick === 38) { expect(originalSpool.jobs[0]?.id).toBe(nextJob); expect(originalSpool.jobs[0]?.offset).toBe(1); }
      results[0]!.push(k.ioSubsystem.takeResult(packetId)); results[1]!.push(restored.ioSubsystem.takeResult(packetId));
    }
    expect(originalEvents.find(event => event.type === 'io.interrupt')).toMatchObject({ device: pulse });
    expect(replayEvents).toEqual(originalEvents); expect(results[1]).toEqual(results[0]);
    expect(results[0]!.filter(result => result !== null)).toHaveLength(1);
    expect(output(k)).toEqual([...Array(8).fill(65), ...Array(8).fill(66)]);
    expect(restored.snapshot()).toEqual(k.snapshot()); expect(JSON.stringify(snapshot)).toBe(snapshotJson);
  });
  it('rejects a broken cross-owner storage reference before changing the fresh kernel', () => {
    const { k } = stage(); const snapshot = k.snapshot();
    const restored = makeKernelForIo({ ...configuration, enabledSubsystems: [...configuration.enabledSubsystems] }); const before = restored.snapshot();
    const bad = structuredClone(snapshot);
    const request = bad.subsystems!.io!.payload.requests.find(row => row.service.kind === 'storage')!;
    (request as unknown as { service: { kind: 'storage'; storageRequestId: number } }).service = { kind: 'storage', storageRequestId: 999999 };
    expect(() => restored.restore(bad)).toThrow(); expect(restored.snapshot()).toEqual(before);
    restored.restore(snapshot); expect(restored.snapshot()).toEqual(snapshot);
  });
});
