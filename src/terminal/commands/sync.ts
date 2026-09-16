/**
 * KERNEL TRAIL: the synchronisation commands of Leg 4 and Leg 5.
 *
 * `lock`, `sem`, `buffer` and `rwlock` read the live primitives, waits and
 * scenarios from the view. `race` and `trace` read the shell's event rings
 * (scope correction T10): `trace` prints the `syscall.invoked` log as an strace,
 * one line per event, so its line count is the event count over the window.
 */
import type { TerminalCommandDef } from '@game/types';
import type { Pid } from '@kernel/types';
import { bar, fixed, kv, table } from '../output';
import { parseInteger } from '../parser';
import { bindOrFail, fail, ok, pidArg, unavailable, type ShippedHandler } from '../registry';
import type { ShellContext } from '../Shell';
import { formatCall, formatResult } from './base';

export const LOCK_DEF: TerminalCommandDef = {
  name: 'lock',
  usage: 'lock [--list] [--mark <start> <end>] [--inherit on|off] [--kind mutex|semaphore|monitor]',
  summary: 'List synchronisation primitives, mark a critical section, and set inheritance.',
  manual: [
    'lock --list prints every synchronisation primitive: its kind, its value, who holds',
    'it, and who is queued on it.',
    '',
    'A critical section is a region of code that touches shared data and must not be',
    'interleaved with another region touching the same data. Marking one is a claim you',
    'are making about your own code, and the system takes you at your word. Nothing in',
    'the hardware associates a lock with the data it protects. The association exists',
    'only in the discipline of the code, which is why two crossings guarding the same',
    'ledger with two different mutexes will still corrupt it, and why both crossings will',
    'look correct in isolation.',
    '',
    'Three requirements any correct solution must satisfy at once:',
    '  mutual exclusion  at most one process inside the section at a time',
    '  progress          if the section is free, some waiting process gets in, and the',
    '                    decision is not deferred forever by processes not trying to',
    '                    enter',
    '  bounded waiting   there is a limit on how many times others can enter ahead of',
    '                    you. Without this you have mutual exclusion and starvation.',
    'A protocol missing any one of them fails, and it usually fails on the third, quietly,',
    'under load.',
    '',
    'On section length. A section that is too long excludes everyone for no reason and',
    'converts a parallel program into a serial one; you measured that effect on the',
    'weave. A section that is too short leaves a write outside the guard, which is the',
    'defect you are here to avoid. Mark the smallest region that contains every access to',
    'the shared data, and no more.',
    '',
    '--inherit on enables priority inheritance: while a low-priority holder blocks a',
    'high-priority waiter, the holder temporarily runs at the waiter priority. This costs',
    'nothing when there is no contention and it is the difference between a bounded wait',
    'and an unbounded one.',
    '',
    'See also: race, trace, sem, codex critical_section.',
  ].join('\n'),
  chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.2', '6.5', '6.8'] },
};

export const RACE_DEF: TerminalCommandDef = {
  name: 'race',
  usage: 'race [--list] [--show <n>] [--expected]',
  summary: 'List detected data races and show the interleaving that caused each.',
  manual: [
    'race lists every data race the system detected, with the participating processes,',
    'the value that resulted, and the value that should have resulted.',
    '',
    '--show expands one race into its instruction interleaving. This is the part worth',
    'reading slowly. A statement like count = count + 1 is one line of source and three',
    'machine operations: load count into a register, add one, store the register back.',
    'Between any two of those operations the scheduler may preempt you, because the',
    'scheduler has no idea that those three operations were meant to be one thing.',
    '',
    'So two processes each running count = count + 1 can interleave as: A loads 5, B',
    'loads 5, A adds and stores 6, B adds and stores 6. Two increments, one result. No',
    'instruction executed incorrectly. The defect is entirely in the interleaving.',
    '',
    'This is why "the operation is fast, so it will not be interrupted" is not an',
    'argument, and why "I checked and it works" is not evidence. A race that needs a',
    'specific interleaving to appear will not appear on most runs, and will appear on the',
    'run that matters.',
    '',
    'See also: trace --replay, lock, codex race_condition.',
  ].join('\n'),
  chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.1', '6.2'] },
};

export const TRACE_DEF: TerminalCommandDef = {
  name: 'trace',
  usage: 'trace [--from <tick>] [--to <tick>] [--pid <pid>] [--replay <n>]',
  summary: 'Print the kernel event log for a tick range, and replay a recorded interleaving.',
  manual: [
    'trace prints the raw event log: every state change, every acquisition, every',
    'preemption, in order, with tick numbers.',
    '',
    'This run is deterministic. The whole run is a function of its seed and the decisions',
    'you have made, which means an interleaving that happened once can be reproduced',
    'exactly, forever. --replay takes a recorded race and re-runs the identical sequence',
    'of scheduling decisions against whatever protocol you have now installed.',
    '',
    'That property is why this game can teach synchronisation and a real machine mostly',
    'cannot. On a real machine you fix a race, the race stops appearing, and you have no',
    'way to know whether you fixed it or got lucky. Here you can fix it and prove it,',
    'against the exact interleaving that broke it.',
    '',
    '  trace --pid 4 --from 200 --to 260   everything Program 4 did in that window',
    '  trace --replay 1                    re-run recorded race 1 under current locking',
    '',
    'See also: race, gantt --replay, lock.',
  ].join('\n'),
  chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.1'] },
};

export const SEM_DEF: TerminalCommandDef = {
  name: 'sem',
  usage: 'sem [--list] [--set <id> <value>] [--order <pid>] [--trace <id>]',
  summary: 'Inspect and adjust semaphores, and show the acquisition order of a process.',
  manual: [
    'sem --list prints every semaphore with its current value, capacity, holders and',
    'wait queue.',
    '',
    'A semaphore is not a lock, though a semaphore with capacity 1 behaves like one. A',
    'counting semaphore holds an integer. Waiting on it decrements and blocks if the',
    'result would be negative; signalling increments and wakes a waiter. The integer is',
    'the point: it counts available instances of something, and it lets three Programs',
    'into a space that holds three, which no mutex can express.',
    '',
    'The bounded buffer needs three primitives and each does a different job:',
    '  empty  counts free slots. A producer waits on it.',
    '  full   counts filled slots. A consumer waits on it.',
    '  mutex  protects the buffer structure itself while it is modified.',
    'empty + full is always the capacity. Watch that invariant; if it drifts, a signal',
    'has been lost.',
    '',
    'Acquisition order is not a style question here. A producer that takes mutex first',
    'and then waits on empty is holding the mutex while asleep. The consumer that would',
    'have made room needs the mutex to do it. Nobody moves again, and the code reads',
    'perfectly well. Take the counting semaphore first, then the mutex, in both roles.',
    '',
    '--order prints the sequence in which a process acquires primitives. Compare two',
    'processes and look for a pair taken in opposite orders. That pair is a cycle waiting',
    'for the right timing.',
    '',
    'See also: buffer, rwlock, lock, wfg (available later).',
  ].join('\n'),
  chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.1'] },
};

export const BUFFER_DEF: TerminalCommandDef = {
  name: 'buffer',
  usage: 'buffer [--history <ticks>] [--capacity <n>] [--producers <n>] [--consumers <n>]',
  summary: 'Show and adjust the bounded buffer, its occupancy and its rates.',
  manual: [
    'buffer prints current occupancy, capacity, producer rate, consumer rate, and the',
    'occupancy history as a chart.',
    '',
    'The bounded buffer is the shape of almost every pipeline that has ever been built,',
    'and it has exactly two failure modes. If production outruns consumption the buffer',
    'fills; a correct implementation then blocks the producer, and an incorrect one drops',
    'data. If consumption outruns production the buffer empties and consumers block. Both',
    'are correct behaviour for a buffer. Neither is a healthy pipeline.',
    '',
    'The buffer cannot fix a rate mismatch. It can only absorb variance around a rate',
    'that already matches. Sizing it larger buys more absorption of bursts and buys',
    'nothing at all if the average rates differ, because a permanent mismatch fills any',
    'finite buffer eventually. If occupancy trends monotonically in either direction, the',
    'answer is producer or consumer counts, not capacity.',
    '',
    'Aim to keep occupancy off both walls. A buffer pinned at full means the producers',
    'are blocked and you have paid for parallelism you are not getting. A buffer pinned',
    'at empty means the consumers are.',
    '',
    'See also: sem, top, codex bounded_buffer.',
  ].join('\n'),
  chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.1'] },
};

export const RWLOCK_DEF: TerminalCommandDef = {
  name: 'rwlock',
  usage: 'rwlock [--list] [--policy reader|writer|fair] [--stats]',
  summary: 'Inspect and set the reader-writer lock policy.',
  manual: [
    'rwlock reports the reader-writer locks, their current holders, and the policy in',
    'force.',
    '',
    'A reader-writer lock exists because readers do not conflict with each other. Any',
    'number may hold the lock at once as long as no writer does. The gain is real: on a',
    'read-heavy structure it is the difference between serial access and near-free',
    'access.',
    '',
    'The cost is that the policy now has to decide something a mutex never had to: when a',
    'writer is waiting and new readers keep arriving, the system either admits them or',
    'holds them back, and both answers have a victim.',
    '',
    '  reader  yes. Maximum read throughput. The writer waits until there is a moment',
    '          with no readers at all, and on a busy structure that moment may not come.',
    '          This starves writers, and it starves them silently, because every reader',
    '          is being served promptly and the system looks healthy.',
    '  writer  no. Arriving readers queue behind the waiting writer. The writer gets in',
    '          promptly. Read throughput drops, and a stream of writers can starve',
    '          readers by the same mechanism in reverse.',
    '  fair    arrivals are served in order regardless of kind. Neither side starves.',
    '          Throughput sits between the two.',
    '',
    'There is no policy here that is correct in general. There is a policy that matches',
    'your workload, and choosing it requires knowing whether a stale read or a delayed',
    'write costs you more.',
    '',
    'See also: sem, ps -l, codex readers_writers.',
  ].join('\n'),
  chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.2'] },
};

const pids = (list: readonly Pid[]): string => (list.length === 0 ? '-' : list.map(pid => `P${pid}`).join(','));

const lockHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('lock', argv, { list: 0, mark: 2, inherit: 1, kind: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('mark')) return unavailable('lock', '--mark', 'critical sections are declared by the program, not from the shell');
    if (bound.args.has('inherit')) return unavailable('lock', '--inherit', 'priority inheritance is a kernel tuning value with no write path from the shell');
    if (bound.args.has('kind')) return unavailable('lock', '--kind', 'primitives are declared by the leg, not created from the shell');
    const view = ctx.host.view();
    return ok([
      `${view.syncPrimitives.length} primitives, ${view.syncWaits.length} waits, priority inheritance ${view.tuning.priorityInheritance ? 'on' : 'off'}`,
      ...table(['ID', 'KIND', 'VALUE', 'CAP', 'HOLDERS', 'QUEUE', 'ORDERED'], view.syncPrimitives.map(primitive => [
        primitive.id, primitive.kind, primitive.value, primitive.capacity, pids(primitive.holders), pids(primitive.waitQueue), primitive.ordered ? 'yes' : 'no',
      ])),
    ]);
  },
};

const raceHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('race', argv, { list: 0, show: 1, expected: 0 });
    if (!bound.ok) return bound;
    const races = ctx.rings.races.toArray();
    if (bound.args.has('show')) {
      const index = parseInteger(bound.args.value('show'));
      const race = index === null ? undefined : races[index - 1];
      if (race === undefined) return fail('race', `race ${bound.args.value('show') ?? ''} is not on the list; ${races.length} detected so far.`);
      return ok([
        `race ${index}: tick ${race.tick}, ${race.race.location}, participants ${pids(race.race.participants)}`,
        `expected ${race.race.expectedValue}, got ${race.race.corruptedValue}`,
        ...race.race.interleaving.map((step, position) => `  ${position + 1}. ${step}`),
      ]);
    }
    if (races.length === 0) return ok(['no data races detected']);
    const lines = table(['N', 'TICK', 'PARTICIPANTS', 'LOCATION', 'RESULT', 'EXPECTED'], races.map((event, position) => [
      position + 1, event.tick, pids(event.race.participants), event.race.location, event.race.corruptedValue, event.race.expectedValue,
    ]));
    if (bound.args.has('expected')) lines.push(...races.map((event, position) => `race ${position + 1}: expected ${event.race.expectedValue}, got ${event.race.corruptedValue}, lost ${event.race.expectedValue - event.race.corruptedValue}`));
    return ok(lines);
  },
};

const traceHandler: ShippedHandler = {
  completions: [{ flag: 'pid', kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('trace', argv, { from: 1, to: 1, pid: 1, replay: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('replay')) return unavailable('trace', '--replay', 'replaying a recorded interleaving is the counterfactual worker, not the terminal');
    const from = bound.args.has('from') ? parseInteger(bound.args.value('from')) : 0;
    const to = bound.args.has('to') ? parseInteger(bound.args.value('to')) : Number.MAX_SAFE_INTEGER;
    if (from === null || to === null) return fail('trace', '--from and --to need tick numbers.');
    let pid: Pid | null = null;
    if (bound.args.has('pid')) {
      const parsed = pidArg(bound.args.value('pid'), 'trace');
      if (!parsed.ok) return parsed;
      pid = parsed.pid;
    }
    const events = ctx.rings.syscalls.toArray().filter(event => event.tick >= from && event.tick <= to && (pid === null || event.request.pid === pid));
    return ok(events.map(event => `${event.tick}  P${event.request.pid}  ${formatCall(event.request)} ${formatResult(event.result)}`));
  },
};

const semHandler: ShippedHandler = {
  completions: [{ flag: 'order', kind: 'pid' }, { flag: 'trace', kind: 'primitive' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('sem', argv, { list: 0, set: 2, order: 1, trace: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('set')) return unavailable('sem', '--set', 'a semaphore changes only through sem_wait and sem_post');
    if (bound.args.has('order')) {
      const parsed = pidArg(bound.args.value('order'), 'sem');
      if (!parsed.ok) return parsed;
      const rows = ctx.rings.acquisitions.toArray().filter(event => event.pid === parsed.pid);
      if (rows.length === 0) return ok([`P${parsed.pid} has acquired nothing yet`]);
      return ok([`acquisition order of P${parsed.pid}`, ...table(['TICK', 'RESOURCE', 'KIND'], rows.map(event => [event.tick, event.resource, event.kind]))]);
    }
    if (bound.args.has('trace')) {
      const id = bound.args.value('trace') ?? '';
      const rows = [
        ...ctx.rings.acquisitions.toArray().filter(event => event.resource === id).map(event => ({ seq: event.seq, tick: event.tick, pid: event.pid, what: 'acquired' })),
        ...ctx.rings.releases.toArray().filter(event => event.resource === id).map(event => ({ seq: event.seq, tick: event.tick, pid: event.pid, what: event.woke === null ? 'released' : `released, woke P${event.woke}` })),
      ].sort((a, b) => a.seq - b.seq);
      if (rows.length === 0) return ok([`no acquisitions or releases of ${id} recorded`]);
      return ok(table(['TICK', 'PID', 'EVENT'], rows.map(row => [row.tick, `P${row.pid}`, row.what])));
    }
    const view = ctx.host.view();
    const semaphores = view.syncPrimitives.filter(primitive => primitive.kind === 'semaphore');
    if (semaphores.length === 0) return ok([`no semaphores declared (${view.syncPrimitives.length} other primitives)`]);
    return ok(table(['ID', 'VALUE', 'CAPACITY', 'HOLDERS', 'QUEUE'], semaphores.map(primitive => [
      primitive.id, primitive.value, primitive.capacity, pids(primitive.holders), pids(primitive.waitQueue),
    ])));
  },
};

const bufferHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('buffer', argv, { history: 1, capacity: 1, producers: 1, consumers: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('history')) return unavailable('buffer', '--history', 'occupancy is not sampled per tick by the kernel');
    if (bound.args.has('capacity')) return unavailable('buffer', '--capacity', 'the buffer is sized by the leg that creates it');
    if (bound.args.has('producers')) return unavailable('buffer', '--producers', 'producers are spawned by the leg that creates the buffer');
    if (bound.args.has('consumers')) return unavailable('buffer', '--consumers', 'consumers are spawned by the leg that creates the buffer');
    const view = ctx.host.view();
    const buffers = view.scenarios.filter(scenario => scenario.kind === 'bounded_buffer');
    if (buffers.length === 0) return ok(['no bounded buffer is running']);
    const tick = Math.max(1, view.tick);
    const lines: string[] = [];
    for (const buffer of buffers) {
      if (buffer.kind !== 'bounded_buffer') continue;
      lines.push(...kv([
        ['buffer', `${buffer.id} (${buffer.variant})`],
        ['occupancy', `${buffer.items.length}/${buffer.capacity} ${bar(buffer.items.length, buffer.capacity, 20)}`],
        ['produced', buffer.produced],
        ['consumed', buffer.consumed],
        ['in flight', buffer.inFlight],
        ['producer rate', `${fixed(buffer.produced / tick, 3)} per tick`],
        ['consumer rate', `${fixed(buffer.consumed / tick, 3)} per tick`],
        ['semaphores', `empty ${buffer.empty}, full ${buffer.full}, mutex ${buffer.mutex}`],
      ]));
      lines.push(...table(['ROLE', 'PID', 'TARGET', 'DONE', 'WORK'], buffer.actors.map(actor => [actor.role, `P${actor.actor.pid}`, actor.targetItems, actor.completedItems, actor.workTicks])));
    }
    return ok(lines);
  },
};

const rwlockHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('rwlock', argv, { list: 0, policy: 1, stats: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('policy')) return unavailable('rwlock', '--policy', 'the reader-writer policy is a kernel tuning value with no write path from the shell');
    const view = ctx.host.view();
    const lines = [`default policy ${view.tuning.rwlockPolicy}`];
    const locks = view.syncStates.filter(state => state.kind === 'rwlock');
    lines.push(...table(['ID', 'POLICY', 'WRITER', 'READERS', 'WAITING'], locks.map(state => state.kind === 'rwlock'
      ? [state.id, state.policy, state.writer === null ? '-' : `P${state.writer.pid}`, pids(state.readers.map(actor => actor.pid)), state.waitQueue.length]
      : [state.id, '-', '-', '-', 0])));
    if (bound.args.has('stats')) {
      for (const scenario of view.scenarios) {
        if (scenario.kind !== 'readers_writers') continue;
        lines.push(`scenario ${scenario.id}: policy ${scenario.policy}`);
        lines.push(...table(['ROLE', 'PID', 'DONE', 'WORST WAIT', 'OUTCOME'], scenario.actors.map(actor => [actor.role, `P${actor.actor.pid}`, actor.completedOperations, actor.worstWait, actor.outcome])));
      }
    }
    return ok(lines);
  },
};

export const SYNC_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['lock', lockHandler], ['race', raceHandler], ['trace', traceHandler],
  ['sem', semHandler], ['buffer', bufferHandler], ['rwlock', rwlockHandler],
]);
