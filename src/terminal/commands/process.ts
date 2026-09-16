/**
 * KERNEL TRAIL: the process commands of Leg 1 and Leg 2.
 *
 * `ps`, `pstree`, `threads` and `top` walk the live view on every call. `wait`
 * and `kill` issue their syscalls through the sink under the caller rule stated
 * on callerPid in Shell.ts. `amdahl` reads its defaults from the live tuning
 * and the running process. `ipc` reads the shared regions and mailboxes.
 */
import type { TerminalCommandDef } from '@game/types';
import type { BlockReason, Pid, ProcessControlBlock, ProcessState } from '@kernel/types';
import { fixed, kv, percent, table } from '../output';
import { parseInteger, parseNumber } from '../parser';
import { bindOrFail, fail, ok, pidArg, unavailable, type CommandResult, type ShippedHandler } from '../registry';
import { findProcess, type ShellContext } from '../Shell';

export const PS_DEF: TerminalCommandDef = {
  name: 'ps',
  usage: 'ps [-l] [-e] [pid...]',
  summary: 'List processes and their control blocks.',
  manual: [
    'ps prints one line per process. With -l it prints the long form, which is a',
    'readable dump of the process control block.',
    '',
    'The PCB is the process, as far as the kernel is concerned. A process is not the',
    'code; several processes can run the same code. A process is this record plus the',
    'address space it points at. When the scheduler switches away from a process, every',
    'register it was using is copied into this record, and copied back out when it runs',
    'again. That copy is the context switch, and it is why switching is not free.',
    '',
    'Columns in the long form:',
    '  PID     process id',
    '  PPID    parent process id. Every process except the first has one.',
    '  STATE   new, ready, running, waiting, terminated, or zombie',
    '  PRI     priority. Lower is more urgent.',
    '  BURST   ticks of CPU still needed by the current burst',
    '  SVC     total service time still required, across all bursts',
    '  BLOCKED what this process is waiting for, if anything',
    '  AS      address space id',
    '',
    'STATE is worth reading carefully. running means it holds the processor right now,',
    'and exactly one process can. ready means it could run and is waiting for a turn.',
    'waiting means it could not run even if offered the processor, because it is waiting',
    'for an event; the BLOCKED column names the event. zombie means it has already',
    'exited and is holding its slot until its parent collects it.',
    '',
    'A process in waiting will never be helped by giving it more processor time. Look at',
    'BLOCKED and satisfy that instead.',
    '',
    'See also: wait, kill, pstree, top.',
  ].join('\n'),
  chapter: { chapter: 3, title: 'Processes', sections: ['3.1.2', '3.1.3'] },
};

export const WAIT_DEF: TerminalCommandDef = {
  name: 'wait',
  usage: 'wait <pid> | wait -a',
  summary: 'Collect the exit status of a terminated child and free its table slot.',
  manual: [
    'wait blocks the caller until the named child terminates, then returns its exit',
    'status and releases its process table slot. With -a it reaps every child of the',
    'convoy that has already exited, without blocking.',
    '',
    'This is the step everyone forgets. When a process exits it does not disappear. It',
    'moves to the zombie state and keeps its PCB, because its exit status has to be',
    'stored somewhere until its parent asks for it. The kernel cannot know whether the',
    'parent cares. So the slot is held.',
    '',
    'A zombie uses no processor time at all. Check it with top: it sits at zero percent',
    'forever. The resource it exhausts is the process table, which is a fixed-size array',
    'in kernel memory. When the table is full, fork fails with EAGAIN, and the failure',
    'appears in a process that has nothing to do with the zombies.',
    '',
    'You cannot kill a zombie. It has already exited; there is nothing left to signal.',
    'Only its parent can clear it, by calling wait. If the parent is gone, the child is',
    'reparented to the first process, which reaps continuously, and the problem solves',
    'itself at the cost of the parent.',
    '',
    'See also: ps, kill, man EAGAIN, codex zombie_orphan.',
  ].join('\n'),
  chapter: { chapter: 3, title: 'Processes', sections: ['3.3.2'] },
};

export const KILL_DEF: TerminalCommandDef = {
  name: 'kill',
  usage: 'kill [-s <signal>] <pid>',
  summary: 'Send a signal to a running process.',
  manual: [
    'kill sends a signal to a process. The name is misleading: most signals do not',
    'terminate anything, and the default signal can be caught and ignored.',
    '',
    'Signals reach a process only while it exists. A process in the zombie state has',
    'already exited, so a signal to it succeeds and does nothing. If you find yourself',
    'killing zombies, read wait instead.',
    '',
    'Killing a parent has consequences you should predict before you type it. Its',
    'children become orphans and are reparented. In this system that means they are',
    'collected immediately, which does clear a jammed process table, and it also means',
    'you have spent a Program to avoid typing wait.',
    '',
    'Signals:',
    '  -s term   ask the process to exit. It may decline.',
    '  -s kill   remove it from the table. It cannot decline and cannot clean up.',
    '            Anything it held, including locks, is held forever.',
    '',
    'That last line matters more than it looks. A process killed with -s kill while',
    'holding a mutex does not release the mutex. You will meet this again at the ford.',
    '',
    'See also: ps, wait, nice.',
  ].join('\n'),
  chapter: { chapter: 3, title: 'Processes', sections: ['3.3.2'] },
};

export const PSTREE_DEF: TerminalCommandDef = {
  name: 'pstree',
  usage: 'pstree [pid]',
  summary: 'Show the process hierarchy as a tree of parents and children.',
  manual: [
    'pstree draws the parent-child hierarchy rooted at the given process, or at the',
    'first process if none is given.',
    '',
    'Processes form a tree because fork is the only way to make one. A new process is',
    'always a copy of an existing one, which is why every process has exactly one parent',
    'and why the tree has a single root. exec does not make a new process; it replaces',
    'the program running inside an existing one, so the tree does not change shape when',
    'you exec, only the label does.',
    '',
    'Zombies are drawn in the tree with a hollow marker. Their position tells you which',
    'parent owes you a wait call.',
    '',
    'See also: ps, wait.',
  ].join('\n'),
  chapter: { chapter: 3, title: 'Processes', sections: ['3.3.1'] },
};

export const IPC_DEF: TerminalCommandDef = {
  name: 'ipc',
  usage: 'ipc [--channels] [--bind <channel> <transfer>]',
  summary: 'List interprocess communication channels and bind a transfer to one.',
  manual: [
    'ipc lists the channels available for moving data between address spaces, and binds',
    'a pending transfer to one.',
    '',
    'Two processes cannot read each other memory. That is the whole point of an address',
    'space, and it is enforced by hardware. So passing data between them requires the',
    'kernel to cooperate, and there are two shapes that cooperation takes.',
    '',
    'Shared memory: the kernel maps one region of physical memory into both address',
    'spaces. Setup costs a syscall. After that, the processes read and write it directly',
    'at memory speed with no kernel involvement per message. The kernel has also stopped',
    'protecting them from each other in that region, so they must arrange their own',
    'mutual exclusion. You will do that at the ford.',
    '',
    'Message passing: each send and each receive is a syscall, so the kernel copies the',
    'data and the cost is per message. Nothing is shared, so nothing can be corrupted by',
    'a badly timed write. It is the safer shape and the slower one.',
    '',
    'The rule that follows: many small messages favour message passing, few large ones',
    'favour shared memory. Count before you bind.',
    '',
    '  ipc --channels                  list channels and their costs',
    '  ipc --bind shm survey_dump      bind the survey transfer to shared memory',
    '',
    'See also: man shared_memory, codex ipc_models.',
  ].join('\n'),
  chapter: { chapter: 3, title: 'Processes', sections: ['3.4.1', '3.5', '3.6.1'] },
};

export const THREADS_DEF: TerminalCommandDef = {
  name: 'threads',
  usage: 'threads [pid] [--tls] [--cancel <tid>] [--mode deferred|async]',
  summary: 'List the strands of a Program, inspect thread-local storage, and cancel one.',
  manual: [
    'threads lists the threads inside a process, with the state of each.',
    '',
    'A thread has its own program counter, registers and stack, and shares everything',
    'else with the other threads of the same process: the code, the heap, the open file',
    'descriptors, the address space. That sharing is the entire reason threads are',
    'cheap to create and cheap to switch between, and it is the entire reason they are',
    'dangerous. Two processes cannot corrupt each other memory. Two threads do it by',
    'default.',
    '',
    '--tls shows which variables are thread-local. A thread-local variable has one copy',
    'per thread, so writes from different threads cannot collide. Anything the threads',
    'genuinely share has to be shared, and has to be protected. Anything they do not',
    'share should be thread-local, and putting it there costs nothing.',
    '',
    '--cancel asks a thread to stop. Read --mode before you use it.',
    '  deferred  the thread stops at the next declared cancellation point, having',
    '            finished whatever partial update it was in the middle of.',
    '  async     the thread stops immediately, wherever it is. If it was halfway',
    '            through updating shared state, that state stays halfway updated, and',
    '            if it held a lock, it still holds it.',
    'deferred is the correct default and async is for the case where correctness has',
    'already been lost.',
    '',
    'See also: amdahl, top -H, codex tls.',
  ].join('\n'),
  chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.1.2', '4.6.3', '4.6.4'] },
};

export const AMDAHL_DEF: TerminalCommandDef = {
  name: 'amdahl',
  usage: 'amdahl --serial <fraction> --cores <n> [--strands <n>]',
  summary: 'Compute the speedup ceiling for a workload with a fixed serial fraction.',
  manual: [
    'amdahl prints the best speedup achievable for a workload, given the fraction of it',
    'that cannot be done in parallel.',
    '',
    '  speedup <= 1 / (S + (1 - S) / N)',
    '',
    'S is the serial fraction and N is the number of processing cores. The formula says',
    'something blunt: as N grows without limit, speedup approaches 1/S and stops. A',
    'workload that is 25 percent serial can never go more than four times faster, on any',
    'machine, ever, no matter how many cores you buy.',
    '',
    'Two consequences worth carrying:',
    '',
    'First, the ceiling is set by the serial part, so effort spent shrinking S is worth',
    'more than effort spent adding cores once N is past a handful. On this crossing the',
    'single-file bridge is S. You can pick a route with a shorter bridge.',
    '',
    'Second, N in the formula is cores, not threads. Adding threads beyond the core count',
    'does not increase N. It increases the number of things competing for the same N',
    'cores, which adds switching overhead and buys nothing. The formula has no term for',
    'that overhead, so real speedup falls below the ceiling rather than reaching it.',
    '',
    '  amdahl --serial 0.3 --cores 4     print the ceiling for this segment',
    '',
    'See also: threads, codex amdahl.',
  ].join('\n'),
  chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.2'] },
};

export const TOP_DEF: TerminalCommandDef = {
  name: 'top',
  usage: 'top [-H] [-n <rows>]',
  summary: 'Live view of processor use, per process or, with -H, per thread.',
  manual: [
    'top refreshes a live table ordered by processor use.',
    '',
    'Read the summary line first. It splits processor time into: user, work done in user',
    'mode; sys, work done in the kernel on behalf of a process; and idle, nobody wanted',
    'it. A high sys number with low throughput usually means the system is spending its',
    'time switching or trapping rather than computing.',
    '',
    '-H expands each process into its threads. Use it on the weave: a process showing 95',
    'percent total that is eight threads at 12 percent each is behaving differently from',
    'one thread at 95 percent, and the difference decides whether more strands will help.',
    '',
    'Idle time is not always waste. A pool with 20 percent worker idle and no queued task',
    'waiting is correctly sized. A pool with 0 percent idle and a queue is undersized.',
    '',
    'See also: ps, threads, vmstat, iostat.',
  ].join('\n'),
  chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.1.1'] },
};

/** Unix-style single letters (pre-flight F15). Unix has no letter for new; O is the on-processor letter; X is dead. */
export const STATE_LETTER: Readonly<Record<ProcessState, string>> = { new: 'N', ready: 'R', running: 'O', waiting: 'S', zombie: 'Z', terminated: 'X' };

export function describeBlock(reason: BlockReason | null): string {
  if (reason === null) return '-';
  switch (reason.kind) {
    case 'semaphore': return `semaphore ${reason.resource}`;
    case 'mutex': return `mutex ${reason.resource}`;
    case 'condition': return `condition ${reason.monitor}/${reason.condition}`;
    case 'io': return `io ${reason.device}`;
    case 'page_fault': return `page_fault ${reason.page}`;
    case 'child_wait': return reason.child === null ? 'child_wait any' : `child_wait P${reason.child}`;
    case 'sleep': return `sleep until ${reason.untilTick}`;
  }
}

const isUser = (pcb: Readonly<ProcessControlBlock>): boolean => pcb.pid > 1;

const psHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'pid' }],
  help: ['S letters: N new, R ready, O running, S waiting, Z zombie, X terminated'],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('ps', argv, { l: 0, e: 0 });
    if (!bound.ok) return bound;
    const view = ctx.host.view();
    let processes = bound.args.has('e') ? view.processes : view.processes.filter(isUser);
    if (bound.args.positional.length > 0) {
      const wanted: Pid[] = [];
      for (const text of bound.args.positional) {
        const parsed = pidArg(text, 'ps');
        if (!parsed.ok) return parsed;
        if (!view.processes.some(pcb => pcb.pid === parsed.pid)) return fail('ps', `no such process ${parsed.pid}.`, 'ESRCH');
        wanted.push(parsed.pid);
      }
      processes = view.processes.filter(pcb => wanted.includes(pcb.pid));
    }
    if (bound.args.has('l')) {
      return ok(table(['PID', 'PPID', 'STATE', 'PRI', 'BURST', 'SVC', 'BLOCKED', 'AS', 'NAME'], processes.map(pcb => [
        pcb.pid, pcb.parent === null ? '-' : pcb.parent, pcb.state, pcb.priority, pcb.cpuBurstRemaining, pcb.serviceRemaining,
        describeBlock(pcb.blockedOn), pcb.addressSpaceId, pcb.name,
      ])));
    }
    return ok(table(['PID', 'S', 'NAME'], processes.map(pcb => [pcb.pid, STATE_LETTER[pcb.state], pcb.name])));
  },
};

function reap(ctx: ShellContext, zombie: Readonly<ProcessControlBlock>, parent: Pid): CommandResult {
  // Only a parent may reap, so the call is issued as the parent (callerPid rule in Shell.ts).
  const result = ctx.host.sink.dispatch({ kind: 'syscall', request: { name: 'wait', pid: parent, args: [zombie.pid] } }, { source: 'terminal', line: ctx.line });
  if (!result.ok) return fail('wait', `the command bus refused the call: ${result.message}.`);
  if (result.syscall === undefined) return fail('wait', 'the command bus returned no result for the call.');
  if (!result.syscall.ok) return fail(result.syscall.errno, `wait P${zombie.pid} as parent P${parent}: ${result.syscall.errno} (${result.syscall.message}).`, result.syscall.errno);
  return ok([`reaped P${zombie.pid} (${zombie.name}) exit status ${String(result.syscall.value)}, by parent P${parent}`]);
}

const waitHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('wait', argv, { a: 0 });
    if (!bound.ok) return bound;
    const view = ctx.host.view();
    if (bound.args.has('a')) {
      const zombies = view.processes.filter(pcb => pcb.state === 'zombie' && pcb.parent !== null
        && view.processes.some(parent => parent.pid === pcb.parent && parent.state !== 'zombie' && parent.state !== 'terminated'));
      if (zombies.length === 0) return ok([`no zombies to reap among ${view.processes.filter(isUser).length} processes`]);
      const lines: string[] = [];
      for (const zombie of zombies) {
        const result = reap(ctx, zombie, zombie.parent as Pid);
        if (!result.ok) return result;
        lines.push(...result.lines);
      }
      return ok(lines);
    }
    const parsed = pidArg(bound.args.positional[0], 'wait');
    if (!parsed.ok) return parsed;
    const target = findProcess(ctx.host, parsed.pid);
    if (target === undefined) return fail('wait', `no such process ${parsed.pid}.`, 'ESRCH');
    if (target.parent === null) return fail('wait', `P${target.pid} has no parent to reap it.`);
    if (target.state !== 'zombie') return fail('wait', `P${target.pid} is ${target.state}, not a zombie; wait would block its parent P${target.parent}.`);
    return reap(ctx, target, target.parent);
  },
};

/** Pre-flight F4: the kernel models signals 0 and 9 only. */
function signalNumber(text: string | undefined): number | null {
  if (text === undefined || text === 'kill' || text === 'term' || text === '9') return 9;
  if (text === '0' || text === 'check') return 0;
  return null;
}

const killHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'pid' }, { flag: 's', kind: 'signal' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('kill', argv, { s: 1 });
    if (!bound.ok) return bound;
    const signal = signalNumber(bound.args.value('s'));
    if (signal === null) return fail('kill', `signal '${bound.args.value('s') ?? ''}' is not modelled; use kill, term or 0.`);
    const parsed = pidArg(bound.args.positional[0], 'kill');
    if (!parsed.ok) return parsed;
    // Issued as the target itself (callerPid rule in Shell.ts): self-kill passes the rights gate and records killed_by_user.
    const request = { name: 'kill' as const, pid: parsed.pid, args: [parsed.pid, signal] };
    const result = ctx.host.sink.dispatch({ kind: 'syscall', request }, { source: 'terminal', line: ctx.line });
    if (!result.ok) return fail('kill', `the command bus refused the call: ${result.message}.`);
    if (result.syscall === undefined) return fail('kill', 'the command bus returned no result for the call.');
    if (!result.syscall.ok) return fail(result.syscall.errno, `kill P${parsed.pid}: ${result.syscall.errno} (${result.syscall.message}).`, result.syscall.errno);
    return ok([signal === 0 ? `P${parsed.pid} exists and accepts signals` : `sent signal ${signal} to P${parsed.pid}`]);
  },
};

const pstreeHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('pstree', argv, {});
    if (!bound.ok) return bound;
    const view = ctx.host.view();
    let root: Pid = 1 as Pid;
    if (bound.args.positional.length > 0) {
      const parsed = pidArg(bound.args.positional[0], 'pstree');
      if (!parsed.ok) return parsed;
      root = parsed.pid;
    }
    const byPid = new Map(view.processes.map(pcb => [pcb.pid, pcb]));
    if (!byPid.has(root)) return fail('pstree', `no such process ${root}.`, 'ESRCH');
    const children = new Map<Pid, Pid[]>();
    for (const pcb of view.processes) {
      if (pcb.parent === null || pcb.pid === root && pcb.parent === pcb.pid) continue;
      const list = children.get(pcb.parent) ?? [];
      list.push(pcb.pid);
      children.set(pcb.parent, list);
    }
    const lines: string[] = [];
    const draw = (pid: Pid, prefix: string, last: boolean, top: boolean): void => {
      const pcb = byPid.get(pid);
      if (pcb === undefined) return;
      const marker = pcb.state === 'zombie' ? 'o' : '*';
      const branch = top ? '' : last ? '`- ' : '|- ';
      lines.push(`${prefix}${branch}${marker} ${pcb.name}(${pcb.pid}) ${pcb.state}`);
      const next = top ? '' : `${prefix}${last ? '   ' : '|  '}`;
      const kids = children.get(pid) ?? [];
      kids.forEach((kid, index) => draw(kid, next, index === kids.length - 1, false));
    };
    draw(root, '', true, true);
    return ok(lines);
  },
};

const ipcHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('ipc', argv, { channels: 0, bind: 2 });
    if (!bound.ok) return bound;
    if (bound.args.has('bind')) return unavailable('ipc', '--bind', 'the kernel has no transfer to bind; sends and receives are the mailbox syscalls');
    const snapshot = ctx.host.ipc();
    const lines: string[] = [`shared regions: ${snapshot.sharedRegions.length}`];
    if (snapshot.sharedRegions.length > 0) {
      lines.push(...table(['REGION', 'PAGES', 'ATTACHED', 'VALUE'], snapshot.sharedRegions.map(region => [
        region.id, region.pages.length, region.attachments.map(row => `P${row.pid}`).join(',') || '-', region.value,
      ])));
    }
    lines.push(`mailboxes: ${snapshot.mailboxes.length}`);
    if (snapshot.mailboxes.length > 0) {
      lines.push(...table(['MAILBOX', 'CAPACITY', 'QUEUED', 'SEND-WAIT', 'RECV-WAIT'], snapshot.mailboxes.map(box => [
        box.id, box.capacity, box.messages.length, box.sendWaiters.map(pid => `P${pid}`).join(',') || '-', box.recvWaiters.map(pid => `P${pid}`).join(',') || '-',
      ])));
    }
    return ok(lines);
  },
};

const threadsHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('threads', argv, { tls: 0, cancel: 1, mode: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('tls')) return unavailable('threads', '--tls', 'the kernel models no thread-local storage');
    if (bound.args.has('cancel')) return unavailable('threads', '--cancel', 'the kernel models no thread cancellation');
    if (bound.args.has('mode')) return unavailable('threads', '--mode', 'the kernel models no cancellation mode');
    const view = ctx.host.view();
    let filter: Pid | null = null;
    if (bound.args.positional.length > 0) {
      const parsed = pidArg(bound.args.positional[0], 'threads');
      if (!parsed.ok) return parsed;
      if (!view.processes.some(pcb => pcb.pid === parsed.pid)) return fail('threads', `no such process ${parsed.pid}.`, 'ESRCH');
      filter = parsed.pid;
    }
    const rows = [...view.threads.values()].filter(thread => filter === null ? thread.pid > 1 : thread.pid === filter).sort((a, b) => a.tid - b.tid);
    return ok([
      `${rows.length} threads, model ${view.tuning.threadModel}, ${view.tuning.coreCount} cores`,
      ...table(['TID', 'PID', 'STATE', 'PC', 'SVC', 'LWP', 'BLOCKED'], rows.map(thread => [
        thread.tid, thread.pid, thread.state, thread.programCounter, thread.serviceRemaining, thread.lwp === null ? '-' : thread.lwp, describeBlock(thread.blockedOn),
      ])),
    ]);
  },
};

const amdahlHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('amdahl', argv, { serial: 1, cores: 1, strands: 1 });
    if (!bound.ok) return bound;
    const serial = parseNumber(bound.args.value('serial'));
    if (serial === null || serial < 0 || serial > 1) return fail('amdahl', '--serial needs a fraction between 0 and 1.');
    const view = ctx.host.view();
    // Pre-flight F23: cores default to the live tuning, strands to the running process's thread count.
    const cores = bound.args.has('cores') ? parseInteger(bound.args.value('cores')) : view.tuning.coreCount;
    if (cores === null || cores < 1) return fail('amdahl', '--cores needs a positive integer.');
    const running = view.running === null ? undefined : view.processes.find(pcb => pcb.pid === view.running);
    const strands = bound.args.has('strands') ? parseInteger(bound.args.value('strands')) : (running?.threads.length ?? cores);
    if (strands === null || strands < 1) return fail('amdahl', '--strands needs a positive integer.');
    const speedup = (n: number): number => 1 / (serial + (1 - serial) / n);
    const effective = Math.min(strands, cores);
    return ok(kv([
      ['serial fraction', fixed(serial, 3)],
      ['cores', cores],
      ['strands', `${strands}${bound.args.has('strands') ? '' : running === undefined ? ' (default: cores)' : ` (default: P${running.pid} has ${strands})`}`],
      ['ceiling at cores', `${fixed(speedup(cores))}x`],
      ['ceiling at strands', `${fixed(speedup(effective))}x (${effective} of ${cores} cores busy)`],
      ['limit as cores grow', serial === 0 ? 'unbounded' : `${fixed(1 / serial)}x`],
    ]));
  },
};

const topHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('top', argv, { H: 0, n: 1 });
    if (!bound.ok) return bound;
    const rows = bound.args.has('n') ? parseInteger(bound.args.value('n')) : null;
    if (bound.args.has('n') && (rows === null || rows < 1)) return fail('top', '-n needs a positive integer.');
    const view = ctx.host.view();
    const tick = Math.max(1, view.tick);
    const charges = ctx.host.ioCharges();
    // Pre-flight F14: sys is the kernel's own CPU, charged to no process.
    const sysTicks = charges.interruptTicks + charges.copyTicks + charges.dmaStealTicks + view.metrics.scheduling.contextSwitches * view.tuning.contextSwitchTicks;
    const user = view.tick === 0 ? 0 : view.metrics.scheduling.cpuUtilisation;
    const sys = view.tick === 0 ? 0 : sysTicks / tick;
    const idle = Math.max(0, 1 - user - sys);
    const processes = view.processes.filter(isUser);
    const zombies = processes.filter(pcb => pcb.state === 'zombie').length;
    const lines = [`tick ${view.tick}  cpu user ${percent(user)} sys ${percent(sys)} idle ${percent(idle)}  processes ${processes.length} (${zombies} zombie)`];
    if (bound.args.has('H')) {
      const threads = [...view.threads.values()].filter(thread => thread.pid > 1).sort((a, b) => a.tid - b.tid);
      lines.push(...table(['TID', 'PID', 'STATE', 'PC', 'SVC'], threads.slice(0, rows ?? threads.length).map(thread => [thread.tid, thread.pid, thread.state, thread.programCounter, thread.serviceRemaining])));
      return ok(lines);
    }
    const share = (ticks: number): number => view.tick === 0 ? 0 : ticks / tick;
    const ranked = processes.map(pcb => {
      const spin = ctx.host.spinTicks(pcb.pid);
      const poll = ctx.host.pollTicks(pcb.pid);
      return { pcb, user: share(pcb.totalCpuUsed), work: share(Math.max(0, pcb.totalCpuUsed - spin - poll)), spin: share(spin), poll: share(poll) };
    }).sort((a, b) => b.user - a.user || a.pcb.pid - b.pcb.pid);
    lines.push(...table(['PID', 'NAME', 'S', 'PRI', 'user%', 'work%', 'spin%', 'poll%'], ranked.slice(0, rows ?? ranked.length).map(row => [
      row.pcb.pid, row.pcb.name, STATE_LETTER[row.pcb.state], row.pcb.priority, percent(row.user), percent(row.work), percent(row.spin), percent(row.poll),
    ])));
    return ok(lines);
  },
};

export const PROCESS_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['ps', psHandler], ['wait', waitHandler], ['kill', killHandler], ['pstree', pstreeHandler], ['ipc', ipcHandler],
  ['threads', threadsHandler], ['amdahl', amdahlHandler], ['top', topHandler],
]);
