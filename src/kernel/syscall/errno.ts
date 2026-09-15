/**
 * KERNEL TRAIL: the frozen Errno set and the seven substitutions of sim spec 14.2.
 *
 * Errno lacks seven codes Unix would use. Each substitution keeps its meaning in
 * the message prefix, and every handler builds the message through the
 * constructor here rather than by hand, so the prefixes cannot drift.
 */
import type { Errno, FileDescriptor, Pid, SyscallResult } from '../types';

export function failure(errno: Errno, message: string): SyscallResult {
  return { ok: false, errno, message };
}
export function success(value: string | number | boolean | null = null): SyscallResult {
  return { ok: true, value };
}

export interface ErrnoSubstitution {
  readonly unix: string;
  readonly errno: Errno;
  readonly prefix: string;
}

/** The table of sim spec 14.2, in its printed order. WP-15's man pages read it. */
const ROWS: readonly ErrnoSubstitution[] = [
  { unix: 'ECHILD', errno: 'ESRCH', prefix: 'no children: ' },
  { unix: 'ENOTDIR', errno: 'EINVAL', prefix: 'not a directory: ' },
  { unix: 'EBADF', errno: 'EINVAL', prefix: 'bad file descriptor: ' },
  { unix: 'EMFILE', errno: 'EAGAIN', prefix: 'too many open files: ' },
  { unix: 'EFAULT', errno: 'EINVAL', prefix: 'address out of range: ' },
  { unix: 'EISDIR', errno: 'EINVAL', prefix: 'is a directory: ' },
  { unix: 'ENOTEMPTY', errno: 'EBUSY', prefix: 'directory not empty: ' },
];
export const ERRNO_SUBSTITUTIONS: readonly ErrnoSubstitution[] = Object.freeze(ROWS.map(row => Object.freeze({ ...row })));

function substitute(unix: string, detail: string): SyscallResult {
  const row = ERRNO_SUBSTITUTIONS.find(candidate => candidate.unix === unix);
  if (row === undefined) throw new Error(`no errno substitution for ${unix}`);
  return failure(row.errno, `${row.prefix}${detail}`);
}

export const noChildren = (pid: Pid): SyscallResult => substitute('ECHILD', String(pid));
export const notADirectory = (path: string): SyscallResult => substitute('ENOTDIR', path);
export const badFd = (fd: FileDescriptor | number): SyscallResult => substitute('EBADF', String(fd));
export const tooManyOpenFiles = (pid: Pid): SyscallResult => substitute('EMFILE', String(pid));
export const addressOutOfRange = (detail: string): SyscallResult => substitute('EFAULT', detail);
export const isADirectory = (path: string): SyscallResult => substitute('EISDIR', path);
export const directoryNotEmpty = (path: string): SyscallResult => substitute('ENOTEMPTY', path);
