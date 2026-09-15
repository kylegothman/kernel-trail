/** WP-11: argument validation before any handler (sim spec 14.2). */
import { describe, expect, it, vi } from 'vitest';
import { createKernel, type KernelImpl } from '@kernel/Kernel';
import { CALL_SPECS, usage } from '@kernel/syscall/validate';
import { ERRNO_SUBSTITUTIONS, addressOutOfRange, badFd, directoryNotEmpty, isADirectory, noChildren, notADirectory, tooManyOpenFiles } from '@kernel/syscall/errno';
import { instructionProgram } from '@kernel/process/Program';
import { asPid, asResourceId } from '@kernel/types';
import type { DomainId, Pid, SyscallName } from '@kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import { canonical } from '../canonical';

const NAMES = Object.keys(CALL_SPECS) as SyscallName[];

function running(kernel: KernelImpl): Pid {
  const pid = kernel.spawn({ name: 'caller', priority: 1, arrival: 0, burst: 400, service: 400, pages: 2 }, { program: instructionProgram([{ kind: 'compute' }]) });
  for (let guard = 0; guard < 50 && kernel.process(pid)?.state !== 'running'; guard++) kernel.step();
  expect(kernel.process(pid)?.state).toBe('running');
  return pid;
}

/** A valid-typed argument list for each call, so arity and type cases can perturb one thing at a time. */
function sample(name: SyscallName): (string | number | boolean)[] {
  return CALL_SPECS[name].args.map(arg => (arg.kind === 'string' ? 'x' : arg.kind === 'boolean' ? false : 1));
}

describe('validation order and rules', () => {
  it('arity: one argument too few and one too many returns EINVAL for every call', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = running(kernel);
    for (const name of NAMES) {
      const spec = CALL_SPECS[name]; const args = sample(name);
      const required = spec.args.filter(arg => arg.optional !== true).length;
      if (required > 0) expect(kernel.syscall({ name, pid, args: args.slice(0, required - 1) }), `${name} too few`).toMatchObject({ ok: false, errno: 'EINVAL' });
      // A variadic tail has no "too many"; a resource vector with a dangling half is the analogue.
      const tooMany = spec.repeat === undefined ? [...args, 1] : name === 'ioctl' ? null : [...args, 'r', 1, 'extra'];
      if (tooMany !== null) expect(kernel.syscall({ name, pid, args: tooMany }), `${name} too many`).toMatchObject({ ok: false, errno: 'EINVAL' });
    }
  });

  it('types: a string where a number is declared returns EINVAL at every numeric position', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = running(kernel);
    let positions = 0;
    for (const name of NAMES) {
      const spec = CALL_SPECS[name]; const args = sample(name);
      spec.args.forEach((arg, index) => {
        if (arg.kind !== 'number') return;
        positions += 1;
        const bad = [...args]; bad[index] = 'seven';
        expect(kernel.syscall({ name, pid, args: bad }), `${name}[${index}]`).toMatchObject({ ok: false, errno: 'EINVAL' });
      });
      if (spec.repeat !== undefined && name !== 'ioctl') {
        expect(kernel.syscall({ name, pid, args: [...args, 'r', 'one'] })).toMatchObject({ ok: false, errno: 'EINVAL' }); positions += 1;
      }
    }
    expect(positions).toBeGreaterThan(15);
  });

  it('order: a call that is both wrong-arity and rights-denied returns the arity error', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = running(kernel);
    const victim = kernel.spawn({ name: 'victim', priority: 9, arrival: 0, burst: 5, service: 5, pages: 0 });
    const user = 'domain:user' as DomainId; kernel.securitySubsystem.defineDomain(user, 'user', 3); kernel.securitySubsystem.bindProcess(pid, user);
    expect(kernel.syscall({ name: 'kill', pid, args: [victim, 9, 'extra'] })).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(kernel.syscall({ name: 'kill', pid, args: [victim, 9] })).toMatchObject({ ok: false, errno: 'EPERM' });
  });

  it('fd range: a descriptor the caller does not hold returns the bad file descriptor prefix', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = running(kernel);
    const result = kernel.syscall({ name: 'close', pid, args: [7] });
    expect(result).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(!result.ok && result.message.startsWith('bad file descriptor: ')).toBe(true);
  });

  it('pid range: a nonexistent pid returns ESRCH', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = running(kernel);
    expect(kernel.syscall({ name: 'kill', pid, args: [4242] })).toMatchObject({ ok: false, errno: 'ESRCH' });
    expect(kernel.syscall({ name: 'wait', pid, args: [4242] })).toMatchObject({ ok: false, errno: 'ESRCH' });
  });

  it('address range: a page outside the caller address space returns the address out of range prefix', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = running(kernel);
    const result = kernel.syscall({ name: 'munmap', pid, args: [99, 1] });
    expect(result).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(!result.ok && result.message.startsWith('address out of range: ')).toBe(true);
    const huge = kernel.syscall({ name: 'read', pid, args: [99999999, 1000000000] });
    expect(!huge.ok && huge.message.startsWith('address out of range: ')).toBe(true);
  });

  it('negative size returns EINVAL', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = running(kernel);
    expect(kernel.syscall({ name: 'read', pid, args: [0, -1] })).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(kernel.syscall({ name: 'brk', pid, args: [-1] })).toMatchObject({ ok: false, errno: 'EINVAL' });
  });

  it('rights are checked with the caller domain, never the kernel one', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const pid = running(kernel);
    const victim = kernel.spawn({ name: 'victim', priority: 9, arrival: 0, burst: 5, service: 5, pages: 0 });
    const user = 'domain:user' as DomainId; kernel.securitySubsystem.defineDomain(user, 'user', 3); kernel.securitySubsystem.bindProcess(pid, user);
    const check = vi.spyOn(kernel.securitySubsystem, 'check');
    expect(kernel.syscall({ name: 'kill', pid, args: [victim, 9] })).toMatchObject({ ok: false, errno: 'EPERM' });
    expect(check).toHaveBeenCalledWith(user, `process:${victim}`, 'control');
    expect(check.mock.calls.every(call => call[0] !== 'domain:kernel')).toBe(true);
    kernel.securitySubsystem.matrix.grant(user, `process:${victim}`, ['control']);
    expect(kernel.syscall({ name: 'kill', pid, args: [victim, 9] })).toEqual({ ok: true, value: null });
  });

  it('the seven substitutions return the mapped errno and the exact prefix', () => {
    expect(ERRNO_SUBSTITUTIONS.map(row => [row.unix, row.errno, row.prefix])).toEqual([
      ['ECHILD', 'ESRCH', 'no children: '], ['ENOTDIR', 'EINVAL', 'not a directory: '], ['EBADF', 'EINVAL', 'bad file descriptor: '],
      ['EMFILE', 'EAGAIN', 'too many open files: '], ['EFAULT', 'EINVAL', 'address out of range: '], ['EISDIR', 'EINVAL', 'is a directory: '],
      ['ENOTEMPTY', 'EBUSY', 'directory not empty: '],
    ]);
    expect(noChildren(asPid(4))).toEqual({ ok: false, errno: 'ESRCH', message: 'no children: 4' });
    expect(notADirectory('/a')).toEqual({ ok: false, errno: 'EINVAL', message: 'not a directory: /a' });
    expect(badFd(3)).toEqual({ ok: false, errno: 'EINVAL', message: 'bad file descriptor: 3' });
    expect(tooManyOpenFiles(asPid(2))).toEqual({ ok: false, errno: 'EAGAIN', message: 'too many open files: 2' });
    expect(addressOutOfRange('page 9')).toEqual({ ok: false, errno: 'EINVAL', message: 'address out of range: page 9' });
    expect(isADirectory('/d')).toEqual({ ok: false, errno: 'EINVAL', message: 'is a directory: /d' });
    expect(directoryNotEmpty('/d')).toEqual({ ok: false, errno: 'EBUSY', message: 'directory not empty: /d' });
  });

  it('a failed validation leaves a canonically identical snapshot', () => {
    // Without security the trap gate is a no-op; with it, every gated call advances the trap counter by design.
    const kernel = createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: REFERENCE_CONFIG.enabledSubsystems.filter(id => id !== 'security') }); const pid = running(kernel);
    kernel.syncSubsystem.createMutex(asResourceId('m'));
    // A refused call records exactly two things by design: its result in the process contribution, and the
    // syscall.invoked event that advances seq. Everything else must be canonically identical.
    const view = (): string => { const snap = kernel.snapshot(); const slot = snap.subsystems?.process; return canonical({ ...snap, seq: 0, subsystems: { ...snap.subsystems, process: slot === undefined ? undefined : { ...slot, syscallResults: [] } } }); };
    const before = view();
    for (const request of [
      { name: 'exit' as const, args: [300] }, { name: 'read' as const, args: [1, 2, 3] }, { name: 'mutex_lock' as const, args: [7] },
      { name: 'request' as const, args: ['nope', 1] }, { name: 'ioctl' as const, args: ['ghost', 'reset'] }, { name: 'nice' as const, args: [50] },
    ]) expect(kernel.syscall({ ...request, pid }).ok, request.name).toBe(false);
    expect(view()).toBe(before);
  });

  it('CALL_SPECS produces a usage line for every call', () => {
    for (const name of NAMES) {
      const line = usage(name);
      expect(line.startsWith(`${name}(`)).toBe(true); expect(line.endsWith(')')).toBe(true);
      expect(CALL_SPECS[name].summary.length).toBeGreaterThan(10);
    }
    expect(usage('wait')).toBe('wait([pid])');
    expect(usage('request')).toBe('request(resource instances...)');
    expect(usage('ioctl')).toBe('ioctl(device, command, arg...)');
  });
});
