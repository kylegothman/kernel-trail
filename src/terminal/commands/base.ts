/**
 * KERNEL TRAIL: the Leg 0 commands, `syscall` and `mode` (`man` joins them with the man module).
 *
 * `syscall` is the one command that issues an arbitrary call on the player's
 * behalf, so its formatting helpers are shared with `trace`, which prints the
 * same calls back out of the event log.
 */
import type { TerminalCommandDef } from '@game/types';
import type { SyscallName, SyscallRequest, SyscallResult } from '@kernel/types';
import { table } from '../output';
import { parseInteger } from '../parser';
import { bindOrFail, fail, nearest, ok, pidArg, type ShippedHandler } from '../registry';
import { callerPid, type ShellContext } from '../Shell';

export const MAN_DEF: TerminalCommandDef = {
  name: 'man',
  usage: 'man <topic>',
  summary: 'Read the manual page for a command, a concept or an error code.',
  manual: [
    'man prints the manual page for a topic. A topic is a command name (man ps), a',
    'concept (man syscall), or an error code (man EPERM).',
    '',
    'Manual pages in this system are written to be read before you need them, which is',
    'not how anyone reads them. Reading one after a failure is the normal case and is',
    'expected. Every error message printed by this shell names the topic that explains',
    'it, so the error itself tells you what to type next.',
    '',
    'A manual page never tells you which choice to make. It tells you what the choice',
    'costs. The codex, which fills in as you encounter things, is where remedies live.',
    '',
    'See also: syscall, mode, codex.',
  ].join('\n'),
  chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.2'] },
};

export const SYSCALL_DEF: TerminalCommandDef = {
  name: 'syscall',
  usage: 'syscall <name> [args...]',
  summary: 'Issue a system call directly and print the result and its cost.',
  manual: [
    'syscall submits a request to the kernel on your behalf and prints what came back.',
    '',
    'A system call is not a function call. A function call jumps to another address in',
    'your own address space and costs a few ticks. A system call raises a trap: the',
    'processor stops executing your code, switches from user mode to kernel mode, runs',
    'kernel code that validates every argument you passed because it trusts none of',
    'them, switches back, and resumes you. That round trip is the mode-switch cost, and',
    'this shell charges you 4 cycles for it whether you asked for one block or one',
    'hundred. Batch your requests.',
    '',
    'The kernel validates arguments because a system call is the only door between code',
    'that may do anything and code that may not. If the kernel trusted your arguments,',
    'the door would not be a door.',
    '',
    'Results come back as ok with a value, or as an errno. Common errnos here:',
    '  EPERM   you asked for something your current mode does not permit',
    '  ENOMEM  the resource exists but there is not enough of it',
    '  EINVAL  the arguments were malformed; the trap still cost you 4 cycles',
    '',
    'Examples:',
    '  syscall brk 12          request 12 more quota',
    '  syscall open manifest   open the convoy manifest, returns a descriptor',
    '',
    'See also: mode, man EPERM.',
  ].join('\n'),
  chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.3', '2.3.1', '2.3.2'] },
};

export const MODE_DEF: TerminalCommandDef = {
  name: 'mode',
  usage: 'mode [--history]',
  summary: 'Report the current processor mode and, with --history, every switch this leg.',
  manual: [
    'mode prints whether the processor is currently executing in user mode or kernel',
    'mode, and which Program it is executing on behalf of.',
    '',
    'There is one processor and one mode bit. When the bit says kernel, the running code',
    'may touch any memory and issue any instruction. When it says user, a large set of',
    'instructions fault instead of executing. The bit is hardware. No program can set it',
    'by asking politely; it flips on a trap, on an interrupt, and on nothing else.',
    '',
    'This is worth being precise about because two different ideas are often confused.',
    'Kernel mode is a processor state that lasts microseconds. An administrator account',
    'is a policy label that lasts for a login session. They are unrelated. The same',
    'Program in this convoy enters kernel mode dozens of times per leg and is never an',
    'administrator.',
    '',
    'mode --history prints every switch this leg with the cause: trap, interrupt, or',
    'return. If the count surprises you, that is the lesson. The kernel is not running',
    'alongside your Programs. It is running only in these intervals.',
    '',
    'See also: syscall, ring (available later).',
  ].join('\n'),
  chapter: { chapter: 1, title: 'Introduction', sections: ['1.4.1', '1.4.2'] },
};

/** A literal argument as the player typed it: integers and booleans convert, everything else is a string. */
export function convertArgument(text: string): string | number | boolean {
  const integer = parseInteger(text);
  if (integer !== null) return integer;
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

export function formatArgument(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export function formatCall(request: SyscallRequest): string {
  return `${request.name}(${request.args.map(formatArgument).join(', ')})`;
}

/** `= value` or `= ERRNO (message)`, from whichever arm of the result is present (scope correction T10). */
export function formatResult(result: SyscallResult): string {
  return result.ok ? `= ${result.value === null ? 'null' : formatArgument(result.value)}` : `= ${result.errno} (${result.message})`;
}

const syscallHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'syscall' }, { flag: null, kind: 'syscall-arg' }, { flag: 'pid', kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('syscall', argv, { pid: 1 });
    if (!bound.ok) return bound;
    const [name, ...rest] = bound.args.positional;
    if (name === undefined) return fail('syscall', 'syscall needs the name of a call.');
    const names = ctx.host.specs.names;
    if (!names.includes(name as SyscallName)) {
      const near = nearest(name, names) ?? 'syscall';
      return fail(near, `unknown system call '${name}'; the nearest is '${near}'.`);
    }
    let explicit;
    if (bound.args.has('pid')) {
      const parsed = pidArg(bound.args.value('pid'), 'syscall');
      if (!parsed.ok) return parsed;
      explicit = parsed.pid;
    }
    // Caller identity follows the rule stated on callerPid in Shell.ts.
    const caller = callerPid(ctx.host, explicit);
    const request: SyscallRequest = { name: name as SyscallName, pid: caller, args: rest.map(convertArgument) };
    const result = ctx.host.sink.dispatch({ kind: 'syscall', request }, { source: 'terminal', line: ctx.line });
    if (!result.ok) return fail('syscall', `the command bus refused the call: ${result.message}.`);
    if (result.syscall === undefined) return fail('syscall', 'the command bus returned no result for the call.');
    const tick = ctx.host.kernel.tick;
    if (!result.syscall.ok) return fail(result.syscall.errno, `${formatCall(request)} ${formatResult(result.syscall)} for caller P${caller} at tick ${tick}.`, result.syscall.errno);
    return ok([`${formatCall(request)} ${formatResult(result.syscall)}`, `caller P${caller}, tick ${tick}`]);
  },
};

const modeHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('mode', argv, { history: 0 });
    if (!bound.ok) return bound;
    const view = ctx.host.view();
    const lines: string[] = [];
    // Pre-flight F16: kernel while kernel work is outstanding, else user on behalf of the running process, else idle.
    if (view.switchDebt + view.ioDebt > 0) lines.push(`mode: kernel (${view.switchDebt} switch and ${view.ioDebt} I/O ticks of kernel work outstanding)`);
    else if (view.running !== null) {
      const pcb = view.processes.find(candidate => candidate.pid === view.running);
      lines.push(`mode: user, on behalf of ${pcb?.name ?? 'an unnamed process'} (P${view.running})`);
    } else lines.push('mode: idle, no process holds the processor');
    lines.push(`tick ${view.tick}`);
    if (bound.args.has('history')) {
      const switches = ctx.rings.modeSwitches.toArray();
      lines.push(...table(['TICK', 'CAUSE', 'PID', 'DETAIL'], switches.map(row => [row.tick, row.cause, row.pid === null ? '-' : `P${row.pid}`, row.detail])));
      lines.push(`${switches.length} switches recorded`);
    }
    return ok(lines);
  },
};

export const BASE_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['syscall', syscallHandler],
  ['mode', modeHandler],
]);
