import { describe, expect, it, vi } from 'vitest';
import { createKernel, type KernelImpl } from '@kernel/Kernel';
import { KernelConfigError, KernelInvariantError } from '@kernel/errors';
import { transition } from '@kernel/process/transitions';
import { IpcManager, type SharedMapping } from '@kernel/process/ipc';
import type { CowCapacity } from '@kernel/process/lifecycle';
import { instructionProgram, generatedProgram, scriptedProgram, type ProgramSpec } from '@kernel/process/Program';
import { createRng } from '@kernel/rng';
import { asFrameId, asPageId, asPid, asResourceId, asTick } from '@kernel/types';
import type { AddressSpaceId, FileDescriptor, KernelEvent, Pid, ProcessControlBlock, ProcessState, SyscallResult, Tid } from '@kernel/types';
import type { EmittableEvent } from '@kernel/EventBus';
import { REFERENCE_CONFIG } from './fixtures/referenceConfig';
import { canonical } from './canonical';

const RESIDENT_CONFIG = { ...REFERENCE_CONFIG, enabledSubsystems: REFERENCE_CONFIG.enabledSubsystems.filter(id => id !== 'vm') };

const WORK: ProgramSpec = { name: 'worker', priority: 20, burst: 100, service: 100, arrival: 0, pages: 3 };
function live(kernel: KernelImpl, pid: Pid): ProcessControlBlock {
  const pcb = kernel.table.get(pid);
  if (pcb === undefined) throw new Error('missing fixture process');
  return pcb;
}
function value(result: SyscallResult): number {
  if (!result.ok || typeof result.value !== 'number') throw new Error(`unexpected syscall result ${JSON.stringify(result)}`);
  return result.value;
}
function family(maxProcesses = 64) {
  const kernel = createKernel(RESIDENT_CONFIG, { maxProcesses });
  const parent = kernel.spawn(WORK); kernel.step();
  const call = (name: 'fork' | 'exit' | 'wait' | 'exec' | 'kill', pid = parent, args: (number | string)[] = []) => kernel.syscall({ name, pid, args });
  const fork = () => asPid(value(call('fork')));
  return { kernel, parent, call, fork };
}

describe('process construction and transitions', () => {
  it('init exists; idle is hidden; process views are finite, frozen and live', () => {
    const kernel = createKernel(RESIDENT_CONFIG);
    expect(kernel.process(asPid(1))?.name).toBe('init');
    expect(kernel.process(asPid(0))?.serviceRemaining).toBe(Infinity);
    expect(kernel.processes.every(p => p.pid !== asPid(0))).toBe(true);
    expect(Object.isFrozen(kernel.processes)).toBe(true);
    expect(() => canonical(kernel.processes)).not.toThrow();
    const pid = kernel.spawn(WORK); const held = kernel.process(pid); kernel.step();
    expect(held).toBe(kernel.process(pid)); expect(held?.state).toBe('running');
  });
  it('pid allocation never repeats across 200 spawns and 200 exits', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    const pids: Pid[] = [];
    for (let i = 0; i < 200; i++) {
      const pid = kernel.spawn(WORK); pids.push(pid);
      expect(kernel.syscall({ name: 'exit', pid, args: [0] }).ok).toBe(true);
    }
    expect(pids[0]).toBe(2); expect(new Set(pids).size).toBe(200); expect(pids[199]).toBe(201);
  });
  it('all ten representable legal edges emit exactly one matching state change', () => {
    const edges: readonly (readonly [ProcessState, ProcessState])[] = [
      ['new', 'ready'], ['ready', 'running'], ['running', 'ready'], ['running', 'waiting'],
      ['waiting', 'ready'], ['running', 'zombie'], ['ready', 'zombie'], ['waiting', 'zombie'],
      ['zombie', 'terminated'], ['new', 'terminated'],
    ];
    for (const [from, to] of edges) {
      const kernel = createKernel(REFERENCE_CONFIG); const pcb = live(kernel, kernel.spawn(WORK));
      pcb.state = from; pcb.readySince = from === 'ready' ? asTick(0) : null;
      const events: EmittableEvent[] = [];
      transition(pcb, to, { tick: asTick(4), emit: event => events.push(event), blockReason: { kind: 'sleep', untilTick: asTick(9) } });
      expect(pcb.state).toBe(to);
      expect(events.filter(event => event.type === 'process.state_changed')).toEqual([{ type: 'process.state_changed', pid: pcb.pid, from, to }]);
    }
  });
  it('every illegal edge, including waiting -> running and zombie -> ready, throws I-11', () => {
    const states: ProcessState[] = ['new', 'ready', 'running', 'waiting', 'zombie', 'terminated'];
    const allowed = new Set(['new/ready', 'ready/running', 'running/ready', 'running/waiting', 'ready/waiting', 'waiting/ready', 'running/zombie', 'ready/zombie', 'waiting/zombie', 'zombie/terminated', 'new/terminated']);
    const kernel = createKernel(REFERENCE_CONFIG); const pcb = live(kernel, kernel.spawn(WORK));
    for (const from of states) for (const to of states) {
      if (allowed.has(`${from}/${to}`)) continue;
      pcb.state = from;
      try { transition(pcb, to, { tick: kernel.tick, emit: () => {} }); throw new Error('illegal edge accepted'); }
      catch (error) { expect(error).toBeInstanceOf(KernelInvariantError); expect(error).toMatchObject({ invariant: 11 }); }
    }
  });
  it('ready -> waiting requires memory suspension; every other reason still throws I-11', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pcb = live(kernel, kernel.spawn(WORK));
    const blockReason = { kind: 'sleep' as const, untilTick: asTick(9) };
    for (const reason of [undefined, 'reparent'] as const) {
      pcb.state = 'ready'; pcb.readySince = asTick(0);
      expect(() => transition(pcb, 'waiting', { tick: asTick(4), emit: () => {}, blockReason, ...(reason === undefined ? {} : { reason }) }))
        .toThrowError(expect.objectContaining({ invariant: 11 }));
      expect(pcb.state).toBe('ready'); expect(pcb.readySince).toBe(0);
    }
    const events: EmittableEvent[] = []; const blocked = vi.fn();
    transition(pcb, 'waiting', { tick: asTick(4), emit: event => events.push(event), reason: 'memory_suspension', blockReason, onBlock: blocked });
    expect(pcb).toMatchObject({ state: 'waiting', readySince: null, blockedOn: blockReason });
    expect(blocked).toHaveBeenCalledExactlyOnceWith(pcb);
    expect(events).toEqual([{ type: 'process.state_changed', pid: pcb.pid, from: 'ready', to: 'waiting' }]);
  });
  it('dispatch resets aged priority and admission emits process.created exactly once', () => {
    const { kernel, parent, fork } = family(); const child = fork(); live(kernel, child).priority = 0;
    kernel.blockProcess(parent, { kind: 'sleep', untilTick: asTick(8) });
    const frame = kernel.step();
    expect(kernel.process(child)?.priority).toBe(WORK.priority);
    expect(frame.filter(event => event.type === 'process.created' && event.pid === child)).toHaveLength(0);
  });
});

describe('fork, exit, wait and exec', () => {
  it('fork copies fields, appends one apostrophe, retains descriptors and starts one thread at the continuation', () => {
    const { kernel, parent, fork } = family();
    // Creation overhead precedes the timed first access; fork must not race either.
    kernel.run(kernel.tuning.threadCreateTicks + kernel.tuning.tlbMissTicks - 1);
    const retained: FileDescriptor[] = []; kernel.installHooks({ fs: { retainDescriptor: fd => retained.push(fd) } });
    const source = live(kernel, parent); source.openFiles = [4 as FileDescriptor]; source.heldResources = [asResourceId('lock')]; source.queueLevel = 2;
    const child = fork(); const pcb = live(kernel, child);
    expect(pcb).toMatchObject({ parent, name: "worker'", state: 'new', arrivalTick: kernel.tick, totalCpuUsed: 0,
      queueLevel: 0, heldResources: [], requestedResources: [], blockedOn: null, domain: source.domain });
    expect(pcb.threads).toHaveLength(1); expect(pcb.threads[0]).not.toBe(source.threads[0]);
    expect(kernel.threads.table.get(pcb.threads[0] as Tid)?.programCounter).toBe(1);
    expect(pcb.openFiles).toEqual(source.openFiles); expect(pcb.openFiles).not.toBe(source.openFiles);
    expect(retained).toEqual([4]);
    expect(kernel.table.raw.get(child)).toEqual(kernel.table.raw.get(parent));
    expect(kernel.table.raw.get(child)).not.toBe(kernel.table.raw.get(parent));
  });
  it('fork EAGAIN and zombie accumulation count unreaped children against the table cap', () => {
    const { kernel, parent, call, fork } = family(6);
    for (let i = 0; i < 4; i++) { const child = fork(); kernel.step(); expect(call('exit', child, [i]).ok).toBe(true); }
    expect(kernel.processes.filter(p => p.state === 'zombie')).toHaveLength(4);
    expect(call('fork')).toMatchObject({ ok: false, errno: 'EAGAIN' });
    expect(call('wait').ok).toBe(true); expect(kernel.table.activeCount).toBe(5);
    expect(call('fork', parent).ok).toBe(true);
  });
  it('fork COW shares frames and allocates none; VM-COW-1 copies one page as a minor fault', () => {
    const { kernel, parent, fork } = family(); const source = live(kernel, parent);
    const pages = kernel.pageTables.get(source.addressSpaceId); if (pages === undefined) throw new Error('missing pages');
    for (let i = 0; i < pages.length; i++) {
      const pte = pages[i]; const frame = kernel.frame(asFrameId(i)); if (pte === undefined || frame === undefined) throw new Error('missing frame');
      pte.valid = true; pte.frame = frame.id; frame.owner = source.addressSpaceId; frame.page = pte.page;
    }
    const events: KernelEvent[] = []; kernel.events.onAny(event => events.push(event));
    const copy = vi.fn(); kernel.installHooks({ memory: {
      allocateFrame: (space, page) => { const frame = kernel.frame(asFrameId(3)); if (frame === undefined) return null; frame.owner = space; frame.page = page; return frame.id; }, copyFrame: copy,
    } });
    const child = live(kernel, fork()); const childPages = kernel.pageTables.get(child.addressSpaceId);
    expect(childPages?.map(p => p.frame)).toEqual(pages.map(p => p.frame));
    expect(pages.every(p => !p.writable)).toBe(true); expect(childPages?.every(p => !p.writable)).toBe(true);
    expect([...kernel.lifecycle.cowRefCount.values()]).toEqual([2, 2, 2]);
    expect(events.filter(e => e.type === 'memory.allocated')).toHaveLength(0);
    expect(kernel.lifecycle.resolveCow(child, asPageId(0))).toEqual({ ok: true, value: 3 });
    expect(copy).toHaveBeenCalledWith(0, 3);
    expect(events.filter(e => e.type === 'memory.page_fault')).toMatchObject([{ major: false, pid: child.pid, page: 0 }]);
    expect(events.filter(e => e.type === 'memory.page_loaded')).toHaveLength(1);
    expect(events.filter(e => e.type === 'memory.page_evicted')).toHaveLength(0);
    expect(kernel.lifecycle.cowRefCount.get(asFrameId(0))).toBe(1); expect(pages[0]?.writable).toBe(true);
    expect(childPages?.[0]?.writable).toBe(true); expect(childPages?.[0]?.frame).toBe(3);
  });
  it('pending COW capacity emits one minor and preserves copying and refcounts until the reserved frame is ready', () => {
    const { kernel, parent, fork } = family(); const child = live(kernel, fork());
    const page = asPageId(0); const source = kernel.pageTables.get(child.addressSpaceId)?.find(entry => entry.page === page)?.frame;
    if (source === undefined || source === null) throw new Error('missing COW source');
    let reported = false; let capacity: CowCapacity = { state: 'pending', reported: false };
    const prepare = vi.fn(() => capacity.state === 'pending' ? { ...capacity, reported } : capacity);
    const copy = vi.fn((from: typeof source, to: typeof source) => kernel.memorySubsystem.copyFrame(from, to));
    kernel.installHooks({ memory: { prepareCow: prepare, copyFrame: copy } });
    const events: KernelEvent[] = [];
    kernel.events.onAny(event => { events.push(event); if (event.type === 'memory.page_fault') reported = true; });
    const before = kernel.process(parent)?.serviceRemaining;
    expect(kernel.lifecycle.resolveCow(child, page)).toEqual({ pending: true });
    expect(kernel.lifecycle.resolveCow(child, page)).toEqual({ pending: true });
    expect(copy).not.toHaveBeenCalled(); expect(kernel.lifecycle.cowRefCount.get(source)).toBe(2);
    expect(kernel.pageTables.get(child.addressSpaceId)?.find(entry => entry.page === page)).toMatchObject({ frame: source, writable: false });
    expect(kernel.process(parent)?.serviceRemaining).toBe(before);
    const frame = kernel.memorySubsystem.allocateFrame(child.addressSpaceId, page);
    if (frame === null) throw new Error('missing reserved COW capacity');
    capacity = { state: 'ready', frame, reported };
    expect(kernel.lifecycle.resolveCow(child, page)).toEqual({ ok: true, value: frame });
    expect(copy).toHaveBeenCalledExactlyOnceWith(source, frame);
    expect(prepare).toHaveBeenCalledWith(child.pid, page, source);
    expect(kernel.lifecycle.cowRefCount.get(source)).toBe(1); expect(kernel.lifecycle.cowRefCount.get(frame)).toBe(1);
    expect(events.filter(event => event.type === 'memory.page_fault')).toMatchObject([{ pid: child.pid, page, major: false }]);
    expect(events.filter(event => event.type === 'memory.page_loaded')).toMatchObject([{ pid: child.pid, page, frame }]);
  });
  it('shared mapping resolution and notifications preserve backing identity across nonresident aliases and unmap', () => {
    const { kernel, parent, fork } = family(); const owner = live(kernel, parent); const child = live(kernel, fork());
    const backingPage = asPageId(0); const source = kernel.pageTables.get(owner.addressSpaceId)?.find(entry => entry.page === backingPage);
    if (source?.frame === null || source === undefined) throw new Error('missing shared backing');
    const frame = kernel.frame(source.frame); if (frame === undefined) throw new Error('missing shared frame');
    const notifications: { kind: string; mapping: SharedMapping; resolved: SharedMapping | undefined; pinned: boolean }[] = [];
    const ipc = new IpcManager({
      process: pid => kernel.table.get(pid), pageTable: space => kernel.pageTables.get(space) ?? [], frame: id => kernel.frame(id),
      rights: () => ['read'], block: () => {},
      onSharedMap: (pid, mapping) => notifications.push({ kind: 'map', mapping, resolved: ipc.sharedMapping(pid, mapping.page), pinned: frame.pinned }),
      onSharedUnmap: (pid, mapping) => notifications.push({ kind: 'unmap', mapping, resolved: ipc.sharedMapping(pid, mapping.page), pinned: frame.pinned }),
    });
    const region = asResourceId('read-only-shared'); ipc.createSharedRegion({ id: region, pages: [backingPage], space: owner.addressSpaceId, attached: [], value: 0 });
    expect(ipc.mmap(child.pid, region, true)).toMatchObject({ ok: false, errno: 'EACCES' }); expect(notifications).toEqual([]);
    const mappedPage = asPageId(value(ipc.mmap(child.pid, region, false)));
    const mapping = { region, space: child.addressSpaceId, page: mappedPage, backingSpace: owner.addressSpaceId, backingPage };
    expect(ipc.sharedMapping(child.pid, mappedPage)).toEqual(mapping); expect(Object.isFrozen(ipc.sharedMapping(child.pid, mappedPage))).toBe(true);
    expect(notifications).toEqual([{ kind: 'map', mapping, resolved: mapping, pinned: true }]);
    source.valid = false; source.frame = null; source.swapped = true; ipc.refreshSharedMappings();
    expect(kernel.pageTables.get(child.addressSpaceId)?.find(entry => entry.page === mappedPage)).toMatchObject({ valid: false, frame: null, writable: false });
    expect(ipc.sharedMapping(child.pid, mappedPage)).toEqual(mapping);
    expect(ipc.munmap(child.pid, region).ok).toBe(true);
    expect(notifications[1]).toEqual({ kind: 'unmap', mapping, resolved: undefined, pinned: false });
    expect(ipc.sharedMapping(child.pid, mappedPage)).toBeUndefined();
  });
  it('exit releases resources, queues, descriptors and threads while preserving the zombie identity', () => {
    const { kernel, parent, call, fork } = family(); const child = fork(); kernel.step();
    const pcb = live(kernel, child); const lock = asResourceId('gate'); const queue = [child]; const descriptors: FileDescriptor[] = [];
    pcb.heldResources = [lock]; pcb.requestedResources = [lock]; pcb.openFiles = [3 as FileDescriptor];
    const release = vi.fn(); kernel.installHooks({ sync: { releaseAll: release, removeWaiter: pid => { const index = queue.indexOf(pid); if (index >= 0) queue.splice(index, 1); } }, fs: { closeDescriptor: (_pcb, fd) => descriptors.push(fd) } });
    expect(call('exit', child, [7]).ok).toBe(true);
    expect(release).toHaveBeenCalledWith(pcb); expect(queue).toEqual([]); expect(descriptors).toEqual([3]);
    expect(pcb).toMatchObject({ state: 'zombie', pid: child, parent, name: "worker'", exitCode: 7, heldResources: [], openFiles: [], threads: [] });
    expect(kernel.events.lastFrame.filter(e => e.type === 'process.exited' && e.pid === child)).toHaveLength(1);
  });
  it('wait reaps the lowest pid first and returns each exit code', () => {
    const { kernel, call, fork, parent } = family(); const children = [fork(), fork(), fork()]; kernel.step();
    for (const pid of [...children].reverse()) call('exit', pid, [pid + 10]);
    for (const pid of children) {
      expect(call('wait')).toEqual({ ok: true, value: pid + 10 }); expect(kernel.process(pid)?.state).toBe('terminated');
      expect(kernel.events.lastFrame.filter(e => e.type === 'process.reaped' && e.pid === pid)).toMatchObject([{ by: parent }]);
    }
    expect(call('wait')).toEqual({ ok: false, errno: 'ESRCH', message: `no children: ${parent}` });
  });
  it('wait blocks, and phase 4 wakes and reaps after a live child exits', () => {
    const { kernel, parent, call, fork } = family(); const child = fork();
    expect(call('wait')).toEqual({ ok: true, value: null }); expect(kernel.process(parent)?.blockedOn).toEqual({ kind: 'child_wait', child: null });
    kernel.step(); expect(kernel.process(child)?.state).toBe('running'); call('exit', child, [17]);
    kernel.step(); expect(kernel.process(parent)?.state).toBe('running'); expect(kernel.lastSyscallResult(parent)).toEqual({ ok: true, value: 17 });
    expect(kernel.process(child)?.state).toBe('terminated');
  });
  it('orphan adoption uses the parent side table and emits same-state changes', () => {
    const { kernel, parent, call, fork } = family(); const children = [fork(), fork()];
    const held = children.map(pid => kernel.process(pid)); call('exit', parent, [0]);
    expect(children.map(pid => kernel.table.parents.get(pid))).toEqual([1, 1]);
    expect(held.map(p => p?.parent)).toEqual([1, 1]);
    for (const pid of children) expect(kernel.events.lastFrame.filter(e => e.type === 'process.state_changed' && e.pid === pid)).toMatchObject([{ from: 'new', to: 'new' }]);
  });
  it('an orphan zombie is reaped by init in the same exit phase', () => {
    const { kernel, parent, call, fork } = family(); const child = fork(); kernel.step(); call('exit', child, [2]); call('exit', parent, [0]);
    expect(kernel.process(child)?.state).toBe('terminated');
    expect(kernel.events.lastFrame.filter(e => e.type === 'process.reaped' && e.pid === child)).toMatchObject([{ by: 1 }]);
  });
  it('init exit emits the specified panic', () => {
    const kernel = createKernel(REFERENCE_CONFIG); kernel.syscall({ name: 'exit', pid: asPid(1), args: [0] });
    expect(kernel.events.lastFrame.filter(e => e.type === 'kernel.panic')).toMatchObject([{ message: 'init exited' }]);
  });
  it('exec preserves identity, closes only close-on-exec descriptors, and resets the program and thread set', () => {
    const { kernel, parent, call } = family(); const pcb = live(kernel, parent);
    pcb.openFiles = [3 as FileDescriptor, 4 as FileDescriptor]; pcb.queueLevel = 2;
    const closed: FileDescriptor[] = [];
    kernel.installHooks({ fs: { closeOnExec: (_p, fd) => fd === 4, closeDescriptor: (_p, fd) => closed.push(fd) } });
    const before = { pid: pcb.pid, parent: pcb.parent, priority: pcb.priority, basePriority: pcb.basePriority, domain: pcb.domain };
    const oldTid = pcb.threads[0]; const replacement = instructionProgram([{ kind: 'compute' }, { kind: 'compute' }]); kernel.registerProgram('replacement', replacement);
    expect(call('exec', parent, ['missing'])).toMatchObject({ ok: false, errno: 'ENOENT' });
    expect(call('exec', parent, ['replacement']).ok).toBe(true); expect(pcb).toMatchObject({ ...before, queueLevel: 0, openFiles: [3] });
    expect(closed).toEqual([4]); expect(pcb.threads).toHaveLength(1); expect(pcb.threads[0]).not.toBe(oldTid);
    expect(kernel.threads.table.get(pcb.threads[0] as Tid)?.programCounter).toBe(0);
    expect(kernel.program(parent)).toBe(replacement); kernel.run(kernel.tuning.threadCreateTicks + 2); expect(kernel.process(parent)?.state).toBe('zombie');
  });
});

describe('IPC', () => {
  it('mailbox rendezvous blocks a sender and wakes it only in phase 4', () => {
    const { kernel, parent, fork } = family(); const receiver = fork(); const id = asResourceId('rendezvous'); kernel.ipc.createMailbox(id, 0);
    expect(kernel.ipc.send(parent, id, 42, kernel.tick).ok).toBe(true);
    expect(kernel.process(parent)?.blockedOn).toEqual({ kind: 'semaphore', resource: 'mbox:rendezvous:send' });
    kernel.step(); expect(kernel.process(receiver)?.state).toBe('running');
    expect(kernel.ipc.receive(receiver, id)).toEqual({ ok: true, value: 42 }); expect(kernel.process(parent)?.state).toBe('waiting');
    kernel.step(); expect(kernel.process(parent)?.state).toBe('ready'); expect(kernel.ipc.mailbox(id)?.sendWaiters).toEqual([]);
  });
  it('mailbox bounded capacity three blocks the fourth sender and fills a vacancy FIFO', () => {
    const { kernel, parent } = family(); const id = asResourceId('bounded'); const mailbox = kernel.ipc.createMailbox(id, 3);
    for (let i = 1; i <= 4; i++) kernel.ipc.send(parent, id, i, kernel.tick);
    expect(mailbox.queue.map(m => m.payload)).toEqual([1, 2, 3]); expect(mailbox.sendWaiters).toEqual([parent]);
    const receiver = kernel.spawn(WORK); kernel.step();
    expect(kernel.ipc.receive(receiver, id)).toEqual({ ok: true, value: 1 }); expect(mailbox.queue.map(m => m.payload)).toEqual([2, 3, 4]);
    kernel.step(); expect(kernel.process(parent)?.state).toBe('ready');
  });
  it('shared region pins frames until the last munmap, preserving protection rights', () => {
    const { kernel, parent, fork } = family(); const second = fork(); const id = asResourceId('shared'); const space = 99 as AddressSpaceId;
    const template = kernel.pageTables.get(live(kernel, parent).addressSpaceId)?.[0]; const frame = kernel.frame(asFrameId(0));
    if (template === undefined || frame === undefined) throw new Error('missing memory fixture');
    frame.owner = space; frame.page = asPageId(0);
    kernel.pageTables.set(space, [{ ...template, frame: frame.id, valid: true }]);
    kernel.ipc.createSharedRegion({ id, space, pages: [asPageId(0)], attached: [], value: 0 });
    expect(kernel.ipc.mmap(parent, id)).toMatchObject({ ok: false, errno: 'EACCES' });
    kernel.installHooks({ security: { rights: () => ['read', 'write'] } });
    const firstPage = value(kernel.ipc.mmap(parent, id)); kernel.ipc.mmap(second, id, false); expect(frame.pinned).toBe(true);
    expect(kernel.pageTables.get(live(kernel, parent).addressSpaceId)?.find(p => p.page === firstPage)?.writable).toBe(true);
    kernel.ipc.munmap(parent, id); expect(frame.pinned).toBe(true); kernel.ipc.munmap(second, id); expect(frame.pinned).toBe(false);
  });
});

describe('programs and configuration', () => {
  it('scripted programs are pure, retain the reference string, then compute', () => {
    const source = [1, 2]; const program = scriptedProgram(source, 4); source[0] = 99;
    expect(program.referenceString).toEqual([1, 2]); expect(program.at(0)).toEqual({ kind: 'access', page: 1, write: false });
    expect(program.at(2)).toEqual({ kind: 'compute' }); expect(program.at(0)).toEqual(program.at(0));
  });
  it('generated programs consume their fork up front and indexing never consumes RNG', () => {
    const rng = createRng(123); const program = generatedProgram(rng, { pages: 10, service: 100 }); const state = rng.save();
    const sequence = Array.from({ length: 100 }, (_, index) => program.at(index));
    expect(rng.save()).toEqual(state); expect(Array.from({ length: 100 }, (_, index) => program.at(index))).toEqual(sequence);
    expect(sequence).toEqual(Array.from({ length: 100 }, (_, index) => generatedProgram(createRng(123), { pages: 10, service: 100 }).at(index)));
  });
  it('rejects invalid configuration and tuning before running', () => {
    for (const config of [{ ...REFERENCE_CONFIG, totalFrames: 0 }, { ...REFERENCE_CONFIG, pageSize: 3 }, { ...REFERENCE_CONFIG, tlbEntries: -1 },
      { ...REFERENCE_CONFIG, totalCylinders: 0 }, { ...REFERENCE_CONFIG, schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 0 } }]) {
      expect(() => createKernel(config)).toThrow(KernelConfigError);
    }
    expect(() => createKernel(REFERENCE_CONFIG, { contextSwitchTicks: 3 })).toThrow(KernelConfigError);
  });
});

describe('lifecycle cleanup regressions', () => {
  it('exec detaches only its shared mappings before freeing private pages', () => {
    const { kernel, parent, fork, call } = family(); const second = fork(); kernel.step(); const id = asResourceId('exec-shared'); const space = 99 as AddressSpaceId;
    const template = kernel.pageTables.get(live(kernel, parent).addressSpaceId)?.[0]; const backing = kernel.memorySubsystem.loadPage(space, asPageId(0));
    const frame = backing === null ? undefined : kernel.frame(backing);
    if (template === undefined || frame === undefined) throw new Error('missing memory fixture');
    frame.owner = space; frame.page = asPageId(0); kernel.pageTables.set(space, [{ ...template, valid: true, frame: frame.id }]);
    kernel.ipc.createSharedRegion({ id, space, pages: [asPageId(0)], attached: [], value: 0 });
    const freed: number[] = []; kernel.installHooks({ security: { rights: () => ['read', 'write'] }, memory: { freeFrame: id => freed.push(id) } });
    kernel.ipc.mmap(parent, id); kernel.ipc.mmap(second, id);
    kernel.registerProgram('fresh', instructionProgram([{ kind: 'compute' }]));
    call('exec', parent, ['fresh']); expect(kernel.ipc.sharedRegion(id)?.attached).toEqual([second]); expect(frame.pinned).toBe(true); expect(freed).not.toContain(frame.id);
    expect(() => kernel.ipc.refreshSharedMappings()).not.toThrow();
    call('exec', second, ['fresh']); expect(kernel.ipc.sharedRegion(id)?.attached).toEqual([]); expect(frame.pinned).toBe(false); expect(freed).not.toContain(frame.id);
  });
  it('exec closes adjacent close-on-exec descriptors even when closing mutates the descriptor array', () => {
    const { kernel, parent, call } = family(); const pcb = live(kernel, parent); pcb.openFiles = [3 as FileDescriptor, 4 as FileDescriptor];
    const closed: number[] = []; kernel.installHooks({ fs: { closeOnExec: () => true, closeDescriptor: (process, fd) => { closed.push(fd); process.openFiles.splice(process.openFiles.indexOf(fd), 1); } } });
    kernel.registerProgram('fresh', instructionProgram([{ kind: 'compute' }])); call('exec', parent, ['fresh']); expect(closed).toEqual([3, 4]); expect(pcb.openFiles).toEqual([]);
  });
  it('wait of a non-child returns ESRCH even when caller is not running', () => {
    const { kernel, parent, call, fork } = family(); const child = fork(); kernel.step();
    kernel.spawn(WORK, { parent: child }); expect(call('wait', child, [9999])).toMatchObject({ ok: false, errno: 'ESRCH' });
    expect(kernel.process(parent)?.state).toBe('running');
  });
  it('fork instruction puts the child at the next instruction and returns zero on first dispatch', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const parent = kernel.spawn(WORK, { program: instructionProgram([{ kind: 'syscall', call: { name: 'fork', pid: asPid(9), args: [] } }]) });
    kernel.run(kernel.tuning.threadCreateTicks + 1); const child = asPid(value(kernel.lastSyscallResult(parent) ?? { ok: false, errno: 'ESRCH', message: 'missing result' }));
    const tid = kernel.process(child)?.threads[0]; expect(kernel.threads.table.get(tid as Tid)?.programCounter).toBe(1);
    kernel.blockProcess(parent, { kind: 'sleep', untilTick: asTick(10) }); kernel.step(); expect(kernel.lastSyscallResult(child)).toEqual({ ok: true, value: 0 });
  });
});

it('allProgramsScripted considers every runnable user process and excludes init', () => {
  const kernel = createKernel(RESIDENT_CONFIG); expect(kernel.allProgramsScripted()).toBe(true);
  kernel.spawn({ ...WORK, referenceString: [0, 1, 2] }); kernel.step(); expect(kernel.allProgramsScripted()).toBe(true);
  const generated = kernel.spawn(WORK); kernel.step(); expect(kernel.allProgramsScripted()).toBe(false);
  kernel.syscall({ name: 'exit', pid: generated, args: [0] }); expect(kernel.allProgramsScripted()).toBe(true);
});

it('unknown scheduler and subsystem identifiers are rejected at the config boundary', () => {
  const scheduler = { ...REFERENCE_CONFIG }; Reflect.set(scheduler, 'scheduler', 'unknown');
  expect(() => createKernel(scheduler)).toThrow(KernelConfigError);
  const subsystem = { ...REFERENCE_CONFIG }; Reflect.set(subsystem, 'enabledSubsystems', ['unknown']);
  expect(() => createKernel(subsystem)).toThrow(KernelConfigError);
});
