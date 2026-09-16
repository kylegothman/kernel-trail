/**
 * KERNEL TRAIL: errno manual pages (WP-15 spec 5, scope correction T7).
 *
 * Two page shapes. A native code is one of the eleven members of the frozen
 * Errno union: its page names the calls that can return it, from the table
 * below, transcribed from sim spec 14.4 with the two rows WP-11's decision D3
 * moved (wait and exec return EBUSY for a blocking non-running caller). A
 * substituted code is one of the seven Unix names sim spec 14.2 maps onto a
 * native code with a message prefix: its page names the native code and the
 * prefix and says why. The template text of both pages is the authored text
 * approved in the pre-flight; everything else is data.
 */
import type { Errno, SyscallName } from '@kernel/types';
import type { ErrnoSubstitution } from '@kernel/syscall/errno';

const EVERY_CALL_BUT_GETPID: readonly SyscallName[] = [
  'fork', 'exec', 'exit', 'wait', 'kill', 'nice', 'mmap', 'munmap', 'brk', 'open', 'close', 'read', 'write', 'seek', 'stat',
  'unlink', 'mkdir', 'sem_wait', 'sem_post', 'mutex_lock', 'mutex_unlock', 'request', 'release', 'ioctl', 'sync', 'chmod',
];

/** Sim spec 14.4, plus EBUSY for wait and exec (WP-11 decision D3). The compiler holds this to the eleven-member union. */
export const ERRNO_CALLS: Readonly<Record<Errno, readonly SyscallName[]>> = Object.freeze({
  EPERM: ['kill', 'nice', 'chmod', 'mutex_unlock', 'sem_post', 'release', 'ioctl'],
  ENOENT: ['exec', 'open', 'stat', 'unlink', 'mkdir', 'chmod', 'mmap', 'sem_wait', 'sem_post', 'mutex_lock', 'mutex_unlock', 'request', 'release', 'ioctl'],
  EAGAIN: ['fork', 'open', 'request'],
  ENOMEM: ['fork', 'exec', 'mmap', 'brk'],
  EACCES: ['exec', 'open', 'read', 'write', 'stat', 'unlink', 'mkdir', 'mmap'],
  EBUSY: ['read', 'write', 'unlink', 'sync', 'ioctl', 'wait', 'exec'],
  EEXIST: ['open', 'mkdir'],
  EINVAL: EVERY_CALL_BUT_GETPID,
  ENOSPC: ['open', 'write', 'mkdir'],
  EDEADLK: ['mutex_lock', 'request'],
  ESRCH: ['kill', 'wait'],
});

export const ERRNO_NAMES: readonly Errno[] = Object.freeze(Object.keys(ERRNO_CALLS) as Errno[]);

export function isErrno(name: string): name is Errno {
  return (ERRNO_NAMES as readonly string[]).includes(name);
}

/** Template 3b. */
export function errnoPage(code: Errno): string[] {
  const calls = ERRNO_CALLS[code].join(', ');
  const lines = [code, `returned by: ${calls}`];
  if (code === 'ESRCH') lines.push('Any call returns ESRCH when the calling pid does not exist.');
  lines.push('', `See also: ${calls}, syscall.`);
  return lines;
}

/** Template 3c. */
export function substitutedPage(row: ErrnoSubstitution): string[] {
  return [
    row.unix,
    `${row.unix} is not a member of this kernel's errno set. The simulator returns ${row.errno} in its place, with the message prefix "${row.prefix}", so the message still carries the meaning ${row.unix} would have carried.`,
    '',
    `See also: ${row.errno}, syscall.`,
  ];
}
