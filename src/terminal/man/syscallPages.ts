/**
 * KERNEL TRAIL: syscall manual pages (scope correction T7, template 3a).
 *
 * Assembled from `host.specs`: the usage line, the CallSpec summary, the
 * argument list with each ArgSpec kind and role, the right the gate checks,
 * the codes whose ERRNO_CALLS row names the call, and a See also line naming
 * the command that wraps the call where one exists. Labels are the approved
 * template text; everything else is data.
 */
import type { SyscallName } from '@kernel/types';
import type { ArgSpec } from '@kernel/syscall/validate';
import type { TerminalHost } from '../host';
import { ERRNO_CALLS, ERRNO_NAMES } from './errnoPages';

/** Commands that wrap a call. Only true wrappers, not every command that reads the same state. */
export const CALL_WRAPPERS: Readonly<Partial<Record<SyscallName, readonly string[]>>> = Object.freeze({
  kill: ['kill'], wait: ['wait'], nice: ['nice'], chmod: ['chmod'], ioctl: ['iomode', 'tlb'],
});

/** Topic prefix that selects the syscall page when a command shares the name (kill, wait, nice, chmod). */
export const CALL_PREFIX = 'call:';

function describeArgument(arg: ArgSpec): string {
  const parts = [`  ${arg.name}  ${arg.kind}`];
  if (arg.optional === true) parts.push('optional');
  if (arg.role !== undefined) parts.push(`role ${arg.role}`);
  if (arg.min !== undefined) parts.push(`min ${arg.min}`);
  if (arg.max !== undefined) parts.push(`max ${arg.max}`);
  return parts.join(' ');
}

export function errnosOf(name: SyscallName): readonly string[] {
  return ERRNO_NAMES.filter(code => ERRNO_CALLS[code].includes(name));
}

/** Template 3a. */
export function syscallPage(name: SyscallName, host: TerminalHost): string[] {
  const spec = host.specs.calls[name];
  const lines = [`${name}: ${spec.summary}`, `usage: ${host.specs.usage(name)}`, 'arguments:'];
  if (spec.args.length === 0) lines.push('  none');
  for (const arg of spec.args) lines.push(describeArgument(arg));
  if (spec.repeat !== undefined) lines.push(`  ${spec.repeat.map(arg => arg.name).join(' ')}  repeated as a group`);
  lines.push(`rights: ${spec.requiredRight ?? 'checked by the subsystem that owns the object'}`);
  const errnos = errnosOf(name);
  lines.push(`errno: ${errnos.length === 0 ? 'none' : errnos.join(', ')}`);
  const seeAlso = [...(CALL_WRAPPERS[name] ?? []), 'syscall', ...errnos.slice(0, 1)];
  lines.push('', `See also: ${seeAlso.join(', ')}.`);
  return lines;
}
