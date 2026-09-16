/**
 * KERNEL TRAIL: the scheduling commands of Leg 3.
 *
 * `sched` reads the live policy, parameters and metrics, and changes them
 * through exactly one sink dispatch. `nice` issues its syscall as the target
 * (callerPid rule in Shell.ts). `gantt` renders the shell's own dispatch
 * segments in the golden format of the scheduler tests (scope correction T5).
 */
import type { TerminalCommandDef } from '@game/types';
import type { SchedulerId, SchedulerParams } from '@kernel/types';
import { renderGantt } from '../eventRings';
import { fixed, kv, percent } from '../output';
import { parseInteger } from '../parser';
import { bindOrFail, fail, ok, pidArg, unavailable, type ShippedHandler } from '../registry';
import { findProcess, type ShellContext } from '../Shell';

export const SCHED_DEF: TerminalCommandDef = {
  name: 'sched',
  usage: 'sched [--policy <id>] [--quantum <n>] [--aging <n>] [--levels <n,n,n>]',
  summary: 'Read or set the CPU scheduling policy and its parameters.',
  manual: [
    'sched with no arguments prints the current policy, its parameters, and the live',
    'metrics. With arguments it changes the policy immediately, on the running system.',
    '',
    'Policies:',
    '  fcfs            run to completion in arrival order. Simple and fair in the weakest',
    '                  sense of fair. One long job at the front makes everyone behind it',
    '                  wait for all of it. That is the convoy effect and it is why this',
    '                  policy is a teaching example rather than a choice.',
    '  sjf             pick the shortest next burst. Provably gives the minimum average',
    '                  waiting time for a fixed set of jobs. Requires knowing burst',
    '                  lengths in advance, which no real system does; see --estimate.',
    '  srtf            preemptive sjf. A shorter arrival preempts the running job.',
    '                  Better average waiting time, more switches, and long jobs can be',
    '                  pushed back indefinitely.',
    '  priority        pick the lowest priority number. Nothing guarantees a high number',
    '                  ever runs. This policy starves processes. It is not a defect in',
    '                  the implementation.',
    '  priority_aging  the same, plus every process gains a priority level for each',
    '                  --aging ticks it spends ready without running. Starvation becomes',
    '                  impossible because waiting is itself a path to the front.',
    '  rr              each ready process gets --quantum ticks in turn. Response time is',
    '                  bounded by (n-1) * quantum, which is the property interactive',
    '                  work needs. Average waiting time is worse than sjf.',
    '  mlfq            several round-robin queues at different levels. A process that',
    '                  uses its whole quantum drops a level; a process that blocks early',
    '                  stays. This separates interactive work from CPU-bound work',
    '                  without being told which is which.',
    '',
    'On --quantum. There is a floor and a ceiling and both hurt. Set it near 1 and the',
    'system spends its time saving and restoring registers; measure it with top and watch',
    'sys climb while throughput falls. Set it far above the typical burst and round robin',
    'degenerates into fcfs, because everyone finishes before being preempted. The useful',
    'range is a small multiple of the typical burst: long enough that most bursts finish',
    'inside one slice, short enough that response time stays bounded.',
    '',
    'On --aging. Zero disables it. Any nonzero value makes starvation impossible under',
    'priority, at the cost of letting low-priority work eventually displace high-priority',
    'work. That trade is the point.',
    '',
    'See also: gantt, nice, top, codex scheduling_criteria.',
  ].join('\n'),
  chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.3.1', '5.3.2', '5.3.3', '5.3.4', '5.3.6'] },
};

export const NICE_DEF: TerminalCommandDef = {
  name: 'nice',
  usage: 'nice [-n <delta>] <pid>',
  summary: 'Adjust one process priority number.',
  manual: [
    'nice changes the priority of a running process by the given delta.',
    '',
    'The number is a priority, and in this system, as in Silberschatz, a lower number',
    'means more urgent. nice -n -5 makes a process more likely to run. nice -n 5 makes it',
    'less likely. The name comes from being nice to other processes by lowering your own',
    'claim, which is why the sign reads backwards from what most people expect the first',
    'time.',
    '',
    'nice is a blunt instrument and it is worth knowing what it cannot do. It does not',
    'give a process more processor time in absolute terms; it changes its position in a',
    'comparison against other ready processes. Under fcfs it has no effect at all, because',
    'fcfs never consults priority. Under round robin it has no effect either. It matters',
    'under priority, priority_aging and mlfq.',
    '',
    'Using nice to rescue a starving process works, once. It fixes this process now. It',
    'does not fix the policy that starved it, and the next process down will starve in',
    'exactly the same way. Aging fixes the policy.',
    '',
    'See also: sched --aging, ps -l, codex starvation.',
  ].join('\n'),
  chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.3.4'] },
};

export const GANTT_DEF: TerminalCommandDef = {
  name: 'gantt',
  usage: 'gantt [--last <ticks>] [--replay <policy>] [--metrics]',
  summary: 'Draw the execution timeline, and replay the same arrivals under another policy.',
  manual: [
    'gantt draws which process held the processor during each tick, as a chart. Gaps are',
    'context switches and idle time, drawn to scale, so overhead is visible as area rather',
    'than quoted as a number.',
    '',
    '--metrics prints the four numbers that decide whether a policy is doing well:',
    '  waiting time     total time ready but not running. Minimise this for throughput.',
    '  turnaround time  arrival to completion. Waiting time plus service time.',
    '  response time    arrival to first run. Minimise this for anything a human waits on.',
    '  cpu utilisation  fraction of ticks doing work rather than switching or idling.',
    'These conflict. A policy that minimises response time will switch often and lose',
    'utilisation to overhead. Deciding which number matters is the scheduling problem;',
    'the algorithms are just answers to different versions of it.',
    '',
    '--replay re-runs the exact arrival times and burst lengths you already experienced,',
    'under a different policy, and prints both charts. The run is deterministic, so this',
    'is a real comparison rather than an estimate. It is the only honest way to answer',
    'the question "would something else have been better", and you can ask it after the',
    'fact, which is when the question usually occurs to people.',
    '',
    '  gantt --replay sjf      what the last segment looked like under sjf',
    '',
    'See also: sched, top, codex scheduling_criteria.',
  ].join('\n'),
  chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.2', '5.8.1', '5.8.2'] },
};

function schedulingLines(ctx: ShellContext): string[] {
  const view = ctx.host.view();
  const params = view.schedulerParams;
  const metrics = view.metrics.scheduling;
  return [
    ...kv([
      ['policy', view.schedulerId],
      ['quantum', params.quantum],
      ['aging interval', params.agingInterval === 0 ? '0 (aging off)' : params.agingInterval],
      ['level quanta', params.levelQuanta === undefined ? '-' : params.levelQuanta.join(',')],
      ['starvation warning', params.starvationThreshold],
      ['starvation fatal', params.starvationFatalThreshold],
      ['preemptive', params.preemptive ? 'yes' : 'no'],
      ['running', view.running === null ? '-' : `P${view.running}`],
      ['ready queues', view.queues.map((queue, level) => `L${level}[${queue.map(pid => `P${pid}`).join(' ')}]`).join(' ') || '-'],
    ]),
    'metrics',
    ...kv([
      ['waiting time', fixed(metrics.averageWaitingTime)],
      ['turnaround time', fixed(metrics.averageTurnaroundTime)],
      ['response time', fixed(metrics.averageResponseTime)],
      ['throughput', `${fixed(metrics.throughput)} per 100 ticks`],
      ['cpu utilisation', percent(metrics.cpuUtilisation)],
      ['context switches', metrics.contextSwitches],
      ['worst wait', metrics.worstWait],
    ]),
  ];
}

const schedHandler: ShippedHandler = {
  completions: [{ flag: 'policy', kind: 'scheduler' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('sched', argv, { policy: 1, quantum: 1, aging: 1, levels: 1 });
    if (!bound.ok) return bound;
    const { args } = bound;
    if (!args.has('policy') && !args.has('quantum') && !args.has('aging') && !args.has('levels')) return ok(schedulingLines(ctx));
    const params: { quantum?: number; agingInterval?: number; levelQuanta?: readonly number[] } = {};
    const policies = ctx.host.specs.schedulers;
    const policy = args.value('policy');
    if (policy !== undefined && !policies.includes(policy as SchedulerId)) return fail('sched', `unknown policy '${policy}'; the policies are ${policies.join(', ')}.`);
    if (args.has('quantum')) {
      const quantum = parseInteger(args.value('quantum'));
      if (quantum === null || quantum < 1) return fail('sched', '--quantum needs a positive integer.');
      params.quantum = quantum;
    }
    if (args.has('aging')) {
      const aging = parseInteger(args.value('aging'));
      if (aging === null || aging < 0) return fail('sched', '--aging needs a non-negative integer; zero disables it.');
      params.agingInterval = aging;
    }
    if (args.has('levels')) {
      const levels = (args.value('levels') ?? '').split(',').map(text => parseInteger(text.trim()));
      if (levels.length === 0 || levels.some(level => level === null || level < 1)) return fail('sched', '--levels needs a comma-separated list of positive quanta, such as 4,8,16.');
      params.levelQuanta = levels as number[];
    }
    const id = (policy ?? ctx.host.view().schedulerId) as SchedulerId;
    const request = Object.keys(params).length === 0 ? { kind: 'set_scheduler' as const, id } : { kind: 'set_scheduler' as const, id, params: params as Partial<SchedulerParams> };
    const result = ctx.host.sink.dispatch(request, { source: 'terminal', line: ctx.line });
    if (!result.ok) return fail('sched', `the command bus refused the change: ${result.message}.`);
    const view = ctx.host.view();
    return ok([`scheduler set to ${view.schedulerId} (quantum ${view.schedulerParams.quantum}, aging ${view.schedulerParams.agingInterval}, levels ${view.schedulerParams.levelQuanta?.join(',') ?? '-'})`]);
  },
};

const niceHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('nice', argv, { n: 1 });
    if (!bound.ok) return bound;
    const delta = bound.args.has('n') ? parseInteger(bound.args.value('n')) : 10;
    if (delta === null) return fail('nice', '-n needs an integer delta.');
    const parsed = pidArg(bound.args.positional[0], 'nice');
    if (!parsed.ok) return parsed;
    const target = findProcess(ctx.host, parsed.pid);
    if (target === undefined) return fail('nice', `no such process ${parsed.pid}.`, 'ESRCH');
    const before = target.priority;
    // The nice call adjusts its caller, so it is issued as the target (callerPid rule in Shell.ts).
    const result = ctx.host.sink.dispatch({ kind: 'syscall', request: { name: 'nice', pid: parsed.pid, args: [delta] } }, { source: 'terminal', line: ctx.line });
    if (!result.ok) return fail('nice', `the command bus refused the call: ${result.message}.`);
    if (result.syscall === undefined) return fail('nice', 'the command bus returned no result for the call.');
    if (!result.syscall.ok) return fail(result.syscall.errno, `nice P${parsed.pid} by ${delta}: ${result.syscall.errno} (${result.syscall.message}).`, result.syscall.errno);
    return ok([`P${parsed.pid} (${target.name}) priority ${before} -> ${String(result.syscall.value)}`]);
  },
};

const ganttHandler: ShippedHandler = {
  completions: [{ flag: 'replay', kind: 'scheduler' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('gantt', argv, { last: 1, replay: 1, metrics: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('replay')) return unavailable('gantt', '--replay', 'replaying the arrivals under another policy is the counterfactual worker, not the terminal');
    let segments = ctx.rings.segments();
    if (bound.args.has('last')) {
      const last = parseInteger(bound.args.value('last'));
      if (last === null || last < 1) return fail('gantt', '--last needs a positive number of ticks.');
      const cutoff = ctx.host.kernel.tick - last;
      segments = segments.filter(segment => segment.end > cutoff).map(segment => ({ ...segment, start: Math.max(segment.start, cutoff) }));
    }
    const lines = [renderGantt(segments)];
    if (bound.args.has('metrics')) {
      const metrics = ctx.host.view().metrics.scheduling;
      lines.push(...kv([
        ['waiting time', fixed(metrics.averageWaitingTime)],
        ['turnaround time', fixed(metrics.averageTurnaroundTime)],
        ['response time', fixed(metrics.averageResponseTime)],
        ['cpu utilisation', percent(metrics.cpuUtilisation)],
      ]));
    }
    return ok(lines);
  },
};

export const SCHEDULER_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['sched', schedHandler], ['nice', niceHandler], ['gantt', ganttHandler],
]);
