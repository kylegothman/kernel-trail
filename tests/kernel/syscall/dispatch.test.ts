/** WP-11: syscall dispatch (sim spec 14.1 with pre-flight rulings D3 and D8). */
import { describe, expect, it, vi } from 'vitest';
import { createKernel, type KernelImpl } from '@kernel/Kernel';
import { dispatch } from '@kernel/syscall/dispatch';
import { SYSCALL_TABLE, type SyscallHandler } from '@kernel/syscall/table';
import { instructionProgram } from '@kernel/process/Program';
import { asPid, asResourceId } from '@kernel/types';
import type { DomainId, KernelEvent, Pid, SyscallName } from '@kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

/** The compiler forces this record to cover the frozen union exactly: a missing or extra key is a type error. */
const EVERY_NAME: Readonly<Record<SyscallName, true>> = {
  fork: true, exec: true, exit: true, wait: true, kill: true, getpid: true, nice: true,
  mmap: true, munmap: true, brk: true,
  open: true, close: true, read: true, write: true, seek: true, stat: true, unlink: true, mkdir: true,
  sem_wait: true, sem_post: true, mutex_lock: true, mutex_unlock: true,
  request: true, release: true, ioctl: true, sync: true, chmod: true,
};

function runningProcess(kernel: KernelImpl, threads = 1): Pid {
  const pid = kernel.spawn({ name: 'caller', priority: 1, arrival: 0, burst: 400, service: 400, pages: 2 }, { threadCount: threads, program: instructionProgram([{ kind: 'compute' }]) });
  for (let guard = 0; guard < 50 && kernel.process(pid)?.state !== 'running'; guard++) kernel.step();
  expect(kernel.process(pid)?.state).toBe('running');
  return pid;
}

describe('the syscall table', () => {
  it('has one function per member of the frozen SyscallName union and nothing else', () => {
    const names = Object.keys(EVERY_NAME) as SyscallName[];
    expect(names).toHaveLength(27);
    for (const name of names) expect(typeof SYSCALL_TABLE[name], name).toBe('function');
    expect(Object.keys(SYSCALL_TABLE).sort()).toEqual([...names].sort());
    const kernel = createKernel(REFERENCE_CONFIG); const pid = runningProcess(kernel);
    for (const name of names) {
      const result = kernel.syscall({ name, pid, args: [] });
      if (!result.ok) expect(result.message, name).not.toMatch(/not implemented/);
    }
  });
});

describe('dispatch', () => {
  it('refuses an unknown pid with ESRCH before validation runs', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    expect(kernel.syscall({ name: 'exit', pid: asPid(999), args: ['not a code'] })).toMatchObject({ ok: false, errno: 'ESRCH' });
  });

  it('accepts any live caller and refuses zombies and tombstones (decision D3)', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    const spawned = kernel.spawn({ name: 'new', priority: 1, arrival: 100, burst: 4, service: 4, pages: 0 });
    expect(kernel.process(spawned)?.state).toBe('new');
    expect(kernel.syscall({ name: 'getpid', pid: spawned, args: [] })).toEqual({ ok: true, value: spawned });
    const pid = runningProcess(kernel);
    expect(kernel.syscall({ name: 'exit', pid, args: [0] })).toEqual({ ok: true, value: null });
    expect(kernel.process(pid)?.state).toBe('zombie');
    expect(kernel.syscall({ name: 'getpid', pid, args: [] })).toMatchObject({ ok: false, errno: 'ESRCH' });
  });

  it('enters ring 0 for the handler and restores the caller ring afterwards', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = runningProcess(kernel);
    const user = 'domain:user' as DomainId; kernel.securitySubsystem.defineDomain(user, 'user', 3); kernel.securitySubsystem.bindProcess(pid, user);
    expect(kernel.securitySubsystem.ring(pid)).toBe(3);
    const seen: number[] = [];
    // ring() is the live ring; identity() deliberately reports the pre-trap caller identity (WP-10 S13).
    const probe: SyscallHandler = (_request, _state, pcb) => { seen.push(kernel.securitySubsystem.ring(pcb.pid)); return { ok: true, value: null }; };
    expect(dispatch({ name: 'getpid', pid, args: [] }, kernel.syscallState, { ...SYSCALL_TABLE, getpid: probe })).toEqual({ ok: true, value: null });
    expect(seen).toEqual([0]);
    expect(kernel.securitySubsystem.ring(pid)).toBe(3);
  });

  it('a ring-0 caller holds control implicitly while a ring-3 caller without a grant gets EPERM on the same call', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = runningProcess(kernel);
    const stranger = kernel.spawn({ name: 'stranger', priority: 9, arrival: 0, burst: 5, service: 5, pages: 0 });
    const rings: number[] = [];
    const probe: SyscallHandler = (request, state, pcb) => { rings.push(kernel.securitySubsystem.ring(pcb.pid)); return SYSCALL_TABLE.kill(request, state, pcb); };
    const table = { ...SYSCALL_TABLE, kill: probe };
    // The caller starts in the kernel domain, ring 0: no grant exists for process:<stranger>, and the call succeeds.
    expect(kernel.securitySubsystem.identity(pid)?.ring).toBe(0);
    expect(dispatch({ name: 'kill', pid, args: [stranger, 0] }, kernel.syscallState, table)).toEqual({ ok: true, value: null });
    const user = 'domain:user' as DomainId; kernel.securitySubsystem.defineDomain(user, 'user', 3); kernel.securitySubsystem.bindProcess(pid, user);
    expect(dispatch({ name: 'kill', pid, args: [stranger, 0] }, kernel.syscallState, table)).toMatchObject({ ok: false, errno: 'EPERM' });
    // The handler ran once, in ring 0; the refused call never reached it.
    expect(rings).toEqual([0]);
  });

  it('restores the caller ring when a handler throws', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = runningProcess(kernel);
    const user = 'domain:user' as DomainId; kernel.securitySubsystem.defineDomain(user, 'user', 3); kernel.securitySubsystem.bindProcess(pid, user);
    const boom: SyscallHandler = () => { throw new Error('injected'); };
    expect(() => dispatch({ name: 'getpid', pid, args: [] }, kernel.syscallState, { ...SYSCALL_TABLE, getpid: boom })).toThrow('injected');
    expect(kernel.securitySubsystem.ring(pid)).toBe(3);
    expect(kernel.syscall({ name: 'getpid', pid, args: [] })).toEqual({ ok: true, value: pid });
  });

  it('emits syscall.invoked once per dispatch across a 5000-tick run, failures included', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    const program = instructionProgram([{ kind: 'syscall', call: { name: 'getpid', pid: asPid(0), args: [] } }, { kind: 'compute' },
      { kind: 'syscall', call: { name: 'nice', pid: asPid(0), args: ['bad'] } }, { kind: 'compute' }]);
    for (let index = 0; index < 4; index++) kernel.spawn({ name: `p${index}`, priority: index, arrival: index, burst: 6, service: 600, pages: 1 }, { program });
    const record = vi.spyOn(kernel.syscallState, 'record');
    let events = 0; kernel.events.onAny(event => { if (event.type === 'syscall.invoked') events += 1; });
    for (let tick = 0; tick < 5000; tick++) {
      kernel.step();
      if (tick % 97 === 0) kernel.syscall({ name: 'getpid', pid: asPid(1), args: [] });
      if (tick % 101 === 0) kernel.syscall({ name: 'exit', pid: asPid(4242), args: [0] });
    }
    expect(record.mock.calls.length).toBeGreaterThan(100);
    expect(events).toBe(record.mock.calls.length);
  });

  it('emits syscall.invoked for a failing call with the error attached', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = runningProcess(kernel);
    const log: KernelEvent[] = []; kernel.events.onAny(event => log.push(event));
    const request = { name: 'exit' as const, pid, args: [999] };
    const result = kernel.syscall(request);
    expect(result).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(log.filter(event => event.type === 'syscall.invoked')).toMatchObject([{ request, result }]);
  });

  it('executes synchronously outside the tick loop', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = runningProcess(kernel);
    const tick = kernel.tick;
    kernel.syscall({ name: 'getpid', pid, args: [] });
    kernel.syscall({ name: 'fork', pid, args: [] });
    expect(kernel.tick).toBe(tick);
  });

  it('applies a blocking sem_wait immediately and withholds the CPU on the next step', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = runningProcess(kernel);
    const other = kernel.spawn({ name: 'other', priority: 5, arrival: 0, burst: 100, service: 100, pages: 0 });
    kernel.step();
    const gate = asResourceId('gate'); kernel.syncSubsystem.createSemaphore(gate, 1, 0);
    expect(kernel.process(pid)?.state).toBe('running');
    kernel.syscall({ name: 'sem_wait', pid, args: [gate] });
    expect(kernel.process(pid)?.state).toBe('waiting');
    kernel.step();
    expect(kernel.process(pid)?.state).toBe('waiting');
    expect(kernel.process(other)?.state).toBe('running');
  });

  it('accepts the bare tlb_flush alias for kernel/tlb_flush (decision D8)', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = runningProcess(kernel);
    expect(kernel.syscall({ name: 'ioctl', pid, args: ['tlb_flush'] })).toEqual({ ok: true, value: null });
    expect(kernel.syscall({ name: 'ioctl', pid, args: ['kernel', 'tlb_flush'] })).toEqual({ ok: true, value: null });
    for (const args of [[], ['unknown'], [42]]) expect(kernel.syscall({ name: 'ioctl', pid, args })).toMatchObject({ ok: false, errno: 'EINVAL' });
  });
});
