/**
 * KERNEL TRAIL: the deadlock commands of Leg 6.
 *
 * `wfg` builds its edges from the live view and its cycle from
 * `kernel.detectDeadlock()`, whose cycle the kernel already rotates to the
 * lowest pid. `bankers` prints the matrices from the host and one line per
 * `SafetyTraceStep` using that step's own explanation. `resources` lists the
 * resource table and changes the strategy through exactly one sink dispatch.
 */
import type { TerminalCommandDef } from '@game/types';
import type { DeadlockStrategy } from '@kernel/deadlock/DeadlockSubsystem';
import type { BankersState, Pid, ResourceId, SafetyCheckResult } from '@kernel/types';
import { table } from '../output';
import { parseInteger } from '../parser';
import { bindOrFail, fail, ok, pidArg, unavailable, type ShippedHandler } from '../registry';
import type { ShellContext } from '../Shell';

export const WFG_DEF: TerminalCommandDef = {
  name: 'wfg',
  usage: 'wfg [--cycle] [--explain <edge>] [--watch]',
  summary: 'Draw the wait-for graph and identify cycles in it.',
  manual: [
    'wfg draws the wait-for graph: one node per process, an edge from A to B when A is',
    'waiting for something B is holding.',
    '',
    'The wait-for graph is a collapsed form of the resource-allocation graph, and the',
    'collapse is only valid when every resource type has exactly one instance. With one',
    'instance, a cycle in this graph is a deadlock, full stop. With several instances of',
    'a type, a cycle is a possibility rather than a proof, and you need the full',
    'allocation matrix instead; see bankers.',
    '',
    'A deadlock requires all four of these to hold at the same time:',
    '  mutual exclusion  the resource cannot be shared',
    '  hold and wait     a process holding one resource requests another',
    '  no preemption     the resource cannot be taken back from its holder',
    '  circular wait     a closed chain of processes each waiting on the next',
    '',
    'Remove any one and deadlock becomes impossible. That is the entire theory, and it is',
    'why --explain names the condition each edge demonstrates: the remedy you pick should',
    'be aimed at a specific condition, and you should be able to say which.',
    '',
    'Notice what a deadlock does not look like. No process has failed. No error has been',
    'raised. Processor use is low because there is nothing to run, which reads as an idle',
    'system rather than a broken one. Deadlock is diagnosed by noticing an absence, and',
    'this graph is how you make the absence visible.',
    '',
    'See also: bankers, resources, ps, codex coffman.',
  ].join('\n'),
  chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.3.1', '8.3.2', '8.7.1'] },
};

export const BANKERS_DEF: TerminalCommandDef = {
  name: 'bankers',
  usage: 'bankers [--state] [--check <pid> <resource> <n>] [--sequence]',
  summary: 'Show the allocation matrices and test whether a request would keep the system safe.',
  manual: [
    'bankers --state prints the four matrices the avoidance algorithm works from:',
    '  available   free instances of each resource type',
    '  max         the most each process will ever need, declared in advance',
    '  allocation  what each process holds now',
    '  need        max minus allocation',
    '',
    '--check tests one hypothetical grant. It pretends to give the process what it asked',
    'for, then looks for a safe sequence: an ordering of all processes such that each one',
    'in turn can have its remaining need met from what is available plus what the earlier',
    'ones release when they finish. If such an ordering exists the state is safe and the',
    'grant is allowed. If not, the request is refused and the process waits, even though',
    'the resource is sitting free.',
    '',
    'Read that last clause again, because it is the part that feels wrong. The banker',
    'refuses requests it could satisfy. It is buying a guarantee: in a safe state,',
    'deadlock cannot occur, because a completion order always exists.',
    '',
    'Safe, unsafe and deadlocked are three states, not two. Every deadlocked state is',
    'unsafe. Most unsafe states are not deadlocked and never become deadlocked, because',
    'processes usually do not request their full declared maximum. An unsafe state is one',
    'where the system can no longer promise, and the algorithm trades away some real',
    'throughput for that promise.',
    '',
    'The costs of the promise, stated plainly: every process must declare its maximum in',
    'advance, which most real programs cannot do; the check runs on every request and',
    'costs time proportional to processes times resource types; and resources sit idle',
    'that could have been used. This is why real systems mostly do not do this.',
    '',
    '  bankers --check 3 gate_c 1     would granting this stay safe',
    '  bankers --sequence             print the current safe sequence, if one exists',
    '',
    'See also: wfg, resources, codex bankers.',
  ].join('\n'),
  chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.6.1', '8.6.3'] },
};

export const RESOURCES_DEF: TerminalCommandDef = {
  name: 'resources',
  usage: 'resources [--list] [--rank <id> <n>] [--strategy ignore|detect|avoid|prevent]',
  summary: 'List resource types, impose an acquisition order, and set the deadlock strategy.',
  manual: [
    'resources lists every resource type with total instances, available instances,',
    'holders, and whether it can be preempted.',
    '',
    '--rank assigns each resource a number and requires that any process acquiring more',
    'than one takes them in increasing rank order. This is prevention by attacking',
    'circular wait, and it is the cheapest prevention there is: no runtime check, no',
    'declared maximums, no refusals. A cycle needs some process to acquire downward, and',
    'no process ever does.',
    '',
    'It is not free. A process that needs rank 4 and rank 1 must take rank 1 first, even',
    'if it will not touch it for another 200 ticks, so it holds a resource it is not using',
    'and everyone else waits on it. Prevention converts a deadlock risk into a certain',
    'loss of concurrency. On this crossing that loss is about 40 percent of the segment.',
    '',
    '--strategy picks how the system handles deadlock at all:',
    '  ignore   do nothing. Most real systems, most of the time. Cheap, and correct until',
    '           it is not, at which point somebody reboots.',
    '  detect   let deadlocks happen, run a cycle test periodically, then recover by',
    '           preempting or terminating. Costs the detection sweep plus the lost work.',
    '  avoid    run the safety check before every grant. Costs throughput and requires',
    '           declared maximums.',
    '  prevent  make one of the four conditions structurally impossible. Costs',
    '           concurrency, permanently, whether or not a deadlock would ever have',
    '           occurred.',
    '',
    'There is no free option. Pick the one whose cost you can afford on this crossing.',
    '',
    'See also: wfg, bankers, codex deadlock_handling.',
  ].join('\n'),
  chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.1', '8.4', '8.5.4', '8.7.3'] },
};

const STRATEGIES: readonly DeadlockStrategy[] = ['ignore', 'detect', 'avoid', 'prevent'];

interface Edge { readonly from: Pid; readonly to: Pid; readonly resource: ResourceId }

/** An edge from A to B when A waits for something B holds: resource requests and synchronisation waits alike. */
function waitForEdges(ctx: ShellContext): Edge[] {
  const view = ctx.host.view();
  const edges = new Map<string, Edge>();
  const add = (from: Pid, to: Pid, resource: ResourceId): void => { if (from !== to) edges.set(`${from}>${to}>${resource}`, { from, to, resource }); };
  for (const waiter of view.processes) {
    for (const resource of waiter.requestedResources) {
      for (const holder of view.processes) if (holder.heldResources.includes(resource)) add(waiter.pid, holder.pid, resource);
    }
  }
  for (const primitive of view.syncPrimitives) {
    for (const waiter of primitive.waitQueue) for (const holder of primitive.holders) add(waiter, holder, primitive.id);
  }
  return [...edges.values()].sort((a, b) => a.from - b.from || a.to - b.to || (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
}

const wfgHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('wfg', argv, { cycle: 0, explain: 1, watch: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('watch')) return unavailable('wfg', '--watch', 'the shell runs one command at a time; run wfg again after stepping');
    const report = ctx.host.kernel.detectDeadlock();
    if (bound.args.has('explain')) {
      const text = bound.args.value('explain') ?? '';
      const match = /^P?(\d+)\s*[-,]\s*P?(\d+)$/.exec(text);
      if (match === null) return fail('wfg', `'${text}' is not an edge; write it as 3-5 (the shell reserves the > character).`);
      if (report === null) return fail('wfg', 'there is no cycle to explain: the wait-for graph has no cycle right now.');
      const from = Number(match[1]) as Pid; const to = Number(match[2]) as Pid;
      const index = report.cycle.findIndex((pid, position) => pid === from && report.cycle[(position + 1) % report.cycle.length] === to);
      if (index === -1) return fail('wfg', `edge P${from} -> P${to} is not on the detected cycle ${report.cycle.map(pid => `P${pid}`).join(' -> ')}.`);
      return ok([`edge P${from} -> P${to} demonstrates ${report.conditions[index] ?? report.conditions[0] ?? 'circular_wait'}`]);
    }
    const edges = waitForEdges(ctx);
    const lines = edges.length === 0 ? ['no edges: nobody is waiting on anyone'] : edges.map(edge => `P${edge.from} -> P${edge.to}  (${edge.resource})`);
    if (report === null) lines.push('no cycle');
    else {
      lines.push(`cycle: ${report.cycle.map(pid => `P${pid}`).join(' -> ')} -> P${report.cycle[0] ?? ''}`);
      lines.push(`resources: ${report.resources.join(', ') || '-'}`);
      lines.push(`conditions: ${report.conditions.join(', ')}`);
      lines.push(`suggested victims: ${report.suggestedVictims.map(pid => `P${pid}`).join(', ') || '-'}`);
    }
    return ok(lines);
  },
};

/**
 * The textbook safety algorithm over the live matrices (Silberschatz 8.6.3):
 * Work starts at Available; any unfinished process whose Need fits in Work is
 * assumed to finish and return its Allocation. The kernel's preview refuses a
 * zero-instance request, so `--sequence` walks the current state here and
 * prints only the verdict and the order, never an explanation of its own.
 */
function safeSequence(state: BankersState): readonly Pid[] | null {
  const work = [...state.available];
  const finished = state.processes.map(() => false);
  const order: Pid[] = [];
  // After every admission the scan restarts at the first process, as the kernel's own check does.
  let row = 0;
  while (row < state.processes.length) {
    const need = state.need[row] ?? [];
    if (finished[row] === true || !need.every((amount, column) => amount <= (work[column] ?? 0))) { row += 1; continue; }
    for (let column = 0; column < work.length; column++) work[column] = (work[column] ?? 0) + (state.allocation[row]?.[column] ?? 0);
    finished[row] = true;
    const pid = state.processes[row];
    if (pid !== undefined) order.push(pid);
    row = 0;
  }
  return finished.every(Boolean) ? order : null;
}

function safetyLines(result: SafetyCheckResult): string[] {
  return [
    `safe: ${result.safe ? 'yes' : 'no'}`,
    `sequence: ${result.sequence === null ? 'none' : result.sequence.map(pid => `P${pid}`).join(' ')}`,
    ...result.trace.map(step => step.explanation),
  ];
}

const bankersHandler: ShippedHandler = {
  completions: [{ flag: 'check', kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('bankers', argv, { state: 0, check: 3, sequence: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('check')) {
      const [pidText, resource, countText] = bound.args.values('check');
      const parsed = pidArg(pidText, 'bankers');
      if (!parsed.ok) return parsed;
      const count = parseInteger(countText);
      if (resource === undefined || count === null || count < 1) return fail('bankers', '--check needs a pid, a resource id and a positive instance count.');
      const state = ctx.host.bankers();
      if (!state.resources.includes(resource as ResourceId)) return fail('bankers', `no such resource ${resource}; the resources are ${state.resources.join(', ') || 'none'}.`, 'ENOENT');
      if (!state.processes.includes(parsed.pid)) return fail('bankers', `P${parsed.pid} is not in the allocation table.`, 'ESRCH');
      const result = ctx.host.kernel.evaluateBankers(parsed.pid, resource as ResourceId, count);
      return ok([`request P${parsed.pid} ${resource} x${count}`, ...safetyLines(result)]);
    }
    if (bound.args.has('sequence')) {
      const state = ctx.host.bankers();
      if (state.processes.length === 0 || state.resources.length === 0) return ok(['no processes or resources to sequence']);
      const sequence = safeSequence(state);
      return ok([`safe: ${sequence === null ? 'no' : 'yes'}`, `sequence: ${sequence === null ? 'none' : sequence.map(pid => `P${pid}`).join(' ')}`]);
    }
    const state = ctx.host.bankers();
    const names = state.resources;
    const lines = [`available: ${names.map((id, index) => `${id}=${state.available[index] ?? 0}`).join(' ') || 'no resources declared'}`];
    const headers = ['PID', ...names.map(id => `max ${id}`), ...names.map(id => `alloc ${id}`), ...names.map(id => `need ${id}`)];
    lines.push(...table(headers, state.processes.map((pid, row) => [
      `P${pid}`, ...names.map((_, col) => state.max[row]?.[col] ?? 0), ...names.map((_, col) => state.allocation[row]?.[col] ?? 0), ...names.map((_, col) => state.need[row]?.[col] ?? 0),
    ])));
    return ok(lines);
  },
};

const resourcesHandler: ShippedHandler = {
  completions: [{ flag: 'strategy', kind: 'deadlock-strategy' }, { flag: 'rank', kind: 'resource' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('resources', argv, { list: 0, rank: 2, strategy: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('rank')) return unavailable('resources', '--rank', 'acquisition ranks are declared by the leg, not assigned from the shell');
    if (bound.args.has('strategy')) {
      const strategy = bound.args.value('strategy') ?? '';
      if (!STRATEGIES.includes(strategy as DeadlockStrategy)) return fail('resources', `unknown strategy '${strategy}'; the strategies are ${STRATEGIES.join(', ')}.`);
      const result = ctx.host.sink.dispatch({ kind: 'set_deadlock_strategy', strategy: strategy as DeadlockStrategy }, { source: 'terminal', line: ctx.line });
      if (!result.ok) return fail('resources', `the command bus refused the change: ${result.message}.`);
      return ok([`deadlock strategy set to ${ctx.host.kernel.config.deadlockStrategy}`]);
    }
    const view = ctx.host.view();
    const holders = (id: ResourceId): string => {
      const rows = view.processes.map(pcb => ({ pid: pcb.pid, count: pcb.heldResources.filter(held => held === id).length })).filter(row => row.count > 0);
      return rows.length === 0 ? '-' : rows.map(row => (row.count === 1 ? `P${row.pid}` : `P${row.pid}x${row.count}`)).join(',');
    };
    return ok([
      `strategy ${ctx.host.kernel.config.deadlockStrategy}, ${view.resources.length} resource types`,
      ...table(['ID', 'TOTAL', 'AVAILABLE', 'HOLDERS', 'PREEMPTIBLE'], view.resources.map(resource => [
        resource.id, resource.totalInstances, resource.availableInstances, holders(resource.id), resource.preemptible ? 'yes' : 'no',
      ])),
    ]);
  },
};

export const DEADLOCK_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['wfg', wfgHandler], ['bankers', bankersHandler], ['resources', resourcesHandler],
]);
