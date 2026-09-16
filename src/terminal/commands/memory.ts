/**
 * KERNEL TRAIL: the memory commands of Leg 7 and Leg 8.
 *
 * Every read comes from the live view: the frame table and free list for
 * `free` and `frag`, the page tables for `pagetable`, the TLB and the memory
 * metrics for `tlb`, `vmstat` and `ws`, and the live degree for `degree`.
 * `belady` ships as a definition only (scope correction T6): its replay needs
 * the kernel's replacement policies, which the terminal may not import.
 */
import type { TerminalCommandDef } from '@game/types';
import type { PageReplacementId, Pid } from '@kernel/types';
import { fixed, kv, percent, table } from '../output';
import { parseInteger } from '../parser';
import { bindOrFail, fail, ok, pidArg, unavailable, type ShippedHandler } from '../registry';
import { callerPid, findProcess, type ShellContext } from '../Shell';

export const FREE_DEF: TerminalCommandDef = {
  name: 'free',
  usage: 'free [-f] [-h]',
  summary: 'Report memory totals, and with -f the shape of the free space.',
  manual: [
    'free prints total, used and free memory.',
    '',
    '-f prints something the totals cannot tell you: the shape of the free space. It',
    'lists every free run with its size, and the largest single run.',
    '',
    'That last number is the one that decides whether an allocation succeeds under',
    'contiguous allocation. A request for 12 contiguous frames fails when the largest',
    'free run is 9, regardless of whether 200 frames are free in total. The memory exists',
    'and it is unusable, because it is in the wrong shape. That is external',
    'fragmentation, and it is why an out-of-memory failure with plenty of free memory is',
    'a normal event rather than a contradiction.',
    '',
    'Two failures look identical in the totals and need opposite responses:',
    '  no_space       genuinely not enough free memory. Compaction will not help. You',
    '                 need to free something or run fewer things.',
    '  fragmentation  enough free memory, wrong shape. Compaction will help, at the cost',
    '                 of moving every occupied run and stalling every process that owns',
    '                 one. Paging avoids the problem entirely instead of curing it.',
    'Read the reason on the failure event before you spend anything.',
    '',
    'See also: frag, pagetable, vmstat, codex fragmentation.',
  ].join('\n'),
  chapter: { chapter: 9, title: 'Main Memory', sections: ['9.2.3'] },
};

export const PAGETABLE_DEF: TerminalCommandDef = {
  name: 'pagetable',
  usage: 'pagetable [pid] [--entry <page>] [--translate <logical>] [--bits]',
  summary: 'Show a process page table and translate logical addresses through it.',
  manual: [
    'pagetable prints one row per page of a process address space.',
    '',
    'Paging splits the address space into fixed-size pages and physical memory into',
    'frames of the same size, and keeps a table mapping one to the other. The mapping is',
    'arbitrary, so a process address space can be contiguous while the memory holding it',
    'is scattered anywhere. That is the whole trick, and it is why paging makes external',
    'fragmentation impossible: any free frame fits any page.',
    '',
    'What it does not remove is internal fragmentation. A process needing 2.3 pages gets',
    '3, and 0.7 of a page is wasted inside the last frame. Average waste is half a page',
    'per process, which is why page size is a real decision: larger pages mean smaller',
    'page tables and more internal waste.',
    '',
    'A logical address splits into a page number and an offset. The page number indexes',
    'this table to find a frame number; the offset is carried across unchanged. With a',
    '256-byte page, logical address 1000 is page 3, offset 232. If page 3 maps to frame',
    '11, the physical address is 11 * 256 + 232.',
    '',
    '--bits shows the per-page protection bits. These are enforced by the memory',
    'management unit on every access, not by any code you write, which is the only reason',
    'they are worth anything. A page marked non-executable cannot be executed even by the',
    'process that owns it and wants to.',
    '',
    'Note the cost this table implies. Every memory access now needs a table lookup',
    'first, which is itself a memory access. Without help, paging doubles the cost of',
    'every access. See tlb.',
    '',
    'See also: tlb, free, frag, codex paging.',
  ].join('\n'),
  chapter: { chapter: 9, title: 'Main Memory', sections: ['9.3.1', '9.3.2', '9.3.3', '9.4.1'] },
};

export const TLB_DEF: TerminalCommandDef = {
  name: 'tlb',
  usage: 'tlb [--stats] [--entries <n>] [--flush]',
  summary: 'Report translation lookaside buffer hit rate and size.',
  manual: [
    'tlb reports hits, misses, hit rate, and the number of entries.',
    '',
    'The translation lookaside buffer is a small associative cache of recent page-to-frame',
    'mappings, sitting in the memory management unit. It exists because paging otherwise',
    'costs two memory accesses per access: one to read the page table, one to read the',
    'data. The TLB makes the first one free when it hits.',
    '',
    'Effective access time = h * m + (1 - h) * 2m, where h is the hit rate and m is one',
    'memory access. At h = 0.99 you pay 1.01m and paging is nearly free. At h = 0.5 you',
    'pay 1.5m and half your memory bandwidth is going to translation.',
    '',
    'The hit rate is not a property of the hardware. It is a property of your access',
    'pattern. A TLB with 16 entries covers 16 pages; a loop touching 8 pages hits',
    'constantly and a loop striding across 400 pages misses constantly, on the same',
    'hardware. Buying more entries helps a little and costs real money. Improving',
    'locality helps a lot and costs a route choice.',
    '',
    '--flush empties the TLB, which is what happens on every context switch unless the',
    'entries are tagged with an address space id. That is a hidden cost of switching, on',
    'top of the register save you already measured.',
    '',
    'See also: pagetable, top, codex tlb.',
  ].join('\n'),
  chapter: { chapter: 9, title: 'Main Memory', sections: ['9.3.2'] },
};

export const FRAG_DEF: TerminalCommandDef = {
  name: 'frag',
  usage: 'frag [--internal] [--external] [--compare] [--compact]',
  summary: 'Measure fragmentation, compare allocation strategies, and compact.',
  manual: [
    'frag reports internal and external fragmentation separately, because they are',
    'different problems with opposite cures.',
    '',
    '  external  free memory exists but is split into runs too small to use. Caused by',
    '            variable-size contiguous allocation over time. Cured by compaction, or',
    '            avoided by paging.',
    '  internal  memory was allocated in fixed units larger than the request, and the',
    '            remainder inside the unit is unusable. Caused by fixed-size allocation.',
    '            Cured by smaller units, which cost more table space.',
    'Moving from contiguous allocation to paging trades the first for the second. That is',
    'a good trade, and it is a trade rather than a solution.',
    '',
    '--compare replays the recorded allocation sequence under all four strategies and',
    'prints the resulting fragmentation for each. On most sequences first fit and best fit',
    'land close together, with first fit faster; worst fit does badly, despite the',
    'plausible argument that leaving the largest hole must leave the most useful hole. It',
    'leaves the most holes, which is the opposite of useful. Run it before you believe any',
    'of this.',
    '',
    '--compact slides every occupied run together. It works, and it stops every process',
    'that owns memory for the duration, and it must update every base register. Price it',
    'against the alternative before spending.',
    '',
    'See also: free -f, pagetable, codex fragmentation.',
  ].join('\n'),
  chapter: { chapter: 9, title: 'Main Memory', sections: ['9.2.2', '9.2.3', '9.3.1'] },
};

export const VMSTAT_DEF: TerminalCommandDef = {
  name: 'vmstat',
  usage: 'vmstat [--interval <ticks>] [--faults] [--policy <id>]',
  summary: 'Report virtual memory activity: faults, evictions, write-backs and fault rate.',
  manual: [
    'vmstat prints paging activity over time: page faults, major faults, evictions,',
    'write-backs, free frames, and the smoothed fault rate.',
    '',
    'Demand paging brings a page into memory only when it is referenced. Nothing is',
    'loaded in advance. A reference to a page whose valid bit is clear traps to the',
    'kernel, which finds a free frame, reads the page from the backing store, fixes the',
    'table, and restarts the instruction that faulted. The process saw nothing except a',
    'delay.',
    '',
    'The delay is enormous compared to a memory access. If a memory access costs 200',
    'nanoseconds and a fault costs 8 milliseconds, the effective access time is',
    '  (1 - p) * 200ns + p * 8ms',
    'and a fault rate p of just 1 in 1000 makes the average access about 40 times slower',
    'than memory. To keep the slowdown under 10 percent you need p below roughly 1 in',
    '400,000. Page fault rates are not judged on a scale where 1 percent sounds small.',
    '',
    'major faults are the ones that read from the backing store. minor faults are',
    'satisfied without I/O, for instance when the page is already in memory and only the',
    'table entry was missing, or when a copy-on-write page is being copied. Only the',
    'major ones cost what the formula above describes.',
    '',
    'Watch the eviction count against the fault count. When they rise together and stay',
    'together, pages are being evicted and immediately faulted back in, which is the',
    'shape of thrashing.',
    '',
    'See also: ws, belady, degree, free, codex demand_paging.',
  ].join('\n'),
  chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.2.1', '10.2.3', '10.4.1'] },
};

export const WS_DEF: TerminalCommandDef = {
  name: 'ws',
  usage: 'ws [pid] [--window <ticks>] [--budget]',
  summary: 'Report the working set of each process and compare it against allocated frames.',
  manual: [
    'ws prints, per process, the set of pages referenced in the last window of ticks, its',
    'size, and the number of frames currently allocated to that process.',
    '',
    'The working set is the set of pages a process is actually using right now. Programs',
    'do not access memory uniformly; they work in one region for a while, then move to',
    'another. That is locality, and it is the reason demand paging works at all rather',
    'than being a disaster.',
    '',
    'The rule this gives you is short and it decides survival on this crossing:',
    '  if a process has fewer frames than its working set, it will fault continuously,',
    '  and giving it more processor time will not help.',
    'A process below its working set is not slow. It is unable to make progress, because',
    'every page it needs evicts another page it needs.',
    '',
    '--budget sums the working sets of all admitted processes and compares the total',
    'against the frames available. If the sum exceeds the supply, no allocation policy',
    'can fix it. Something has to be suspended. That is not a failure of the memory',
    'system; it is the memory system telling you the truth about the workload.',
    '',
    'Window size matters. Too short and you miss pages the process still needs; too long',
    'and you count pages it has finished with. The measured set is an estimate, and',
    'VESPER makes it a better one.',
    '',
    'See also: vmstat, degree, codex working_set.',
  ].join('\n'),
  chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.6.2', '10.6.3', '10.5.1'] },
};

export const BELADY_DEF: TerminalCommandDef = {
  name: 'belady',
  usage: 'belady [--policy <id>] [--frames <n>] [--string <refs>] [--compare]',
  summary: 'Replay a page reference string under any policy and frame count.',
  manual: [
    'belady replays a recorded reference string under a chosen replacement policy and',
    'frame count, and prints the fault count and the frame contents at each step.',
    '',
    'Use it to answer the question that policy arguments always come down to: how many',
    'faults would the other choice have produced on exactly this workload.',
    '',
    'The policies:',
    '  fifo     evict the oldest loaded page. Cheap, ignores use, and suffers Belady',
    '           anomaly: adding frames can increase faults. Try --frames 3 and then',
    '           --frames 4 on the scripted string and read the totals.',
    '  optimal  evict the page that will be referenced furthest in the future. Provably',
    '           minimal. Unimplementable, because it requires knowing the future. It is a',
    '           yardstick, and having a yardstick is worth a lot when comparing real',
    '           policies.',
    '  lru      evict the least recently used page. Approximates optimal by assuming the',
    '           recent past predicts the near future, which locality makes broadly true.',
    '           Belongs to the stack algorithms, which cannot exhibit Belady anomaly.',
    '  clock    second chance. One reference bit per frame and a moving hand. This is what',
    '           real systems use, because exact LRU needs work on every single memory',
    '           access and clock needs a bit set.',
    '  lfu      evict the least frequently used. Punishes a page that was heavily used',
    '           once and is now finished, and favours old popular pages forever.',
    '',
    'A note on the gap between lru and clock. Exact LRU requires updating an ordering on',
    'every access, in hardware, on the critical path of every load and store. Nobody does',
    'this. Clock gets most of the benefit from one bit and a pointer. When you pick lru',
    'here you are picking a model; when a real kernel picks it, it picks clock.',
    '',
    '  belady --policy fifo --frames 3     fault count under fifo with three frames',
    '  belady --compare                    all policies at the current frame count',
    '',
    'See also: vmstat, ws, codex page_replacement.',
  ].join('\n'),
  chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.4.2', '10.4.3', '10.4.4', '10.4.5', '10.4.6'] },
};

export const DEGREE_DEF: TerminalCommandDef = {
  name: 'degree',
  usage: 'degree [--set <n>] [--suspend <pid>] [--resume <pid>]',
  summary: 'Read or set the degree of multiprogramming, and suspend a process to the backing store.',
  manual: [
    'degree reports how many processes are currently admitted to memory, and sets it.',
    '',
    'Raising the degree of multiprogramming raises processor utilisation, up to a point,',
    'because more admitted processes mean more chances that something is ready when the',
    'processor is free. Past that point every admitted process gets fewer frames, resident',
    'sets fall below working sets, fault rates climb, and everything blocks on paging.',
    'Utilisation collapses.',
    '',
    'Here is the trap, and it has killed more convoys than any other single thing on this',
    'crossing. When thrashing starts, processor utilisation falls. A utilisation graph',
    'showing an idle processor invites exactly one response: admit more work. Doing that',
    'gives the new process frames taken from processes that were already short, and the',
    'collapse accelerates. The correct response to falling utilisation during thrashing is',
    'the opposite of the correct response to falling utilisation at any other time.',
    '',
    'Tell the two apart by reading the fault rate, not the utilisation. Idle processor',
    'with a low fault rate means admit more work. Idle processor with a high fault rate',
    'means suspend something.',
    '',
    '--suspend swaps a process out entirely, freeing all its frames at once. It is a',
    'blunt instrument and it is the fastest way out of a collapse.',
    '',
    'See also: vmstat, ws --budget, codex thrashing.',
  ].join('\n'),
  chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.6.1', '10.6.3'] },
};

function human(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${fixed(bytes / (1024 * 1024), 1)} MiB`;
  if (bytes >= 1024) return `${fixed(bytes / 1024, 1)} KiB`;
  return `${bytes} B`;
}

/** Contiguous runs of free frame ids, ascending. */
function freeRuns(freeList: readonly number[]): { start: number; length: number }[] {
  const sorted = [...freeList].sort((a, b) => a - b);
  const runs: { start: number; length: number }[] = [];
  for (const frame of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.start + last.length === frame) last.length += 1;
    else runs.push({ start: frame, length: 1 });
  }
  return runs;
}

const freeHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('free', argv, { f: 0, h: 0 });
    if (!bound.ok) return bound;
    const view = ctx.host.view();
    const total = view.frames.length; const free = view.freeList.length; const used = total - free;
    const size = view.config.pageSize;
    const show = (frames: number): string => (bound.args.has('h') ? `${frames} frames (${human(frames * size)})` : `${frames} frames`);
    const lines = kv([['total', show(total)], ['used', show(used)], ['free', show(free)], ['page size', bound.args.has('h') ? human(size) : `${size} bytes`]]);
    if (bound.args.has('f')) {
      const runs = freeRuns(view.freeList);
      lines.push(`${runs.length} free runs, largest ${Math.max(0, ...runs.map(run => run.length))} frames`);
      lines.push(...table(['START', 'LENGTH'], runs.map(run => [run.start, run.length])));
    }
    return ok(lines);
  },
};

function targetPid(ctx: ShellContext, text: string | undefined, topic: string): { readonly ok: true; readonly pid: Pid } | ReturnType<typeof fail> {
  if (text !== undefined) {
    const parsed = pidArg(text, topic);
    if (!parsed.ok) return parsed;
    if (findProcess(ctx.host, parsed.pid) === undefined) return fail(topic, `no such process ${parsed.pid}.`, 'ESRCH');
    return parsed;
  }
  const running = ctx.host.view().running;
  if (running === null || running <= 1) return fail(topic, 'no process named and no user process is running.');
  return { ok: true, pid: running };
}

const pagetableHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('pagetable', argv, { entry: 1, translate: 1, bits: 0 });
    if (!bound.ok) return bound;
    const target = targetPid(ctx, bound.args.positional[0], 'pagetable');
    if (!target.ok) return target;
    const view = ctx.host.view();
    const pcb = findProcess(ctx.host, target.pid);
    if (pcb === undefined) return fail('pagetable', `no such process ${target.pid}.`, 'ESRCH');
    const entries = view.pageTables.get(pcb.addressSpaceId) ?? [];
    const size = view.config.pageSize;
    if (bound.args.has('translate')) {
      const logical = parseInteger(bound.args.value('translate'));
      if (logical === null || logical < 0) return fail('pagetable', '--translate needs a non-negative logical address.');
      const page = Math.floor(logical / size); const offset = logical % size;
      const entry = entries[page];
      if (entry === undefined) return fail('pagetable', `logical address ${logical} is page ${page}, outside the ${entries.length}-page address space of P${pcb.pid}.`, 'EINVAL');
      const physical = entry.valid && entry.frame !== null ? `${entry.frame * size + offset} (frame ${entry.frame} * ${size} + ${offset})` : 'not resident: a fault would load it';
      return ok(kv([['logical', logical], ['page', page], ['offset', offset], ['frame', entry.frame ?? '-'], ['physical', physical]]));
    }
    let rows = entries;
    if (bound.args.has('entry')) {
      const page = parseInteger(bound.args.value('entry'));
      const entry = page === null ? undefined : entries[page];
      if (entry === undefined) return fail('pagetable', `page ${bound.args.value('entry') ?? ''} is outside the ${entries.length}-page address space of P${pcb.pid}.`, 'EINVAL');
      rows = [entry];
    }
    const resident = entries.filter(entry => entry.valid).length;
    const bits = bound.args.has('bits');
    const headers = ['PAGE', 'FRAME', 'VALID', 'DIRTY', 'REF', 'SWAPPED', ...(bits ? ['R', 'W', 'X'] : []), 'ACCESSES'];
    const flag = (value: boolean): string => (value ? 'y' : '-');
    return ok([
      `P${pcb.pid} space ${pcb.addressSpaceId}: ${entries.length} pages, ${resident} resident, page size ${size}`,
      ...table(headers, rows.map(entry => [
        entry.page, entry.frame ?? '-', flag(entry.valid), flag(entry.dirty), flag(entry.referenced), flag(entry.swapped),
        ...(bits ? [flag(entry.readable), flag(entry.writable), flag(entry.executable)] : []), entry.accessCount,
      ])),
    ]);
  },
};

const tlbHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('tlb', argv, { stats: 0, entries: 1, flush: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('entries')) return unavailable('tlb', '--entries', 'the TLB size is fixed by the leg configuration');
    if (bound.args.has('flush')) {
      // Issued as the running process, else init (callerPid rule in Shell.ts); the kernel pseudo-device flushes the TLB.
      const caller = callerPid(ctx.host);
      const result = ctx.host.sink.dispatch({ kind: 'syscall', request: { name: 'ioctl', pid: caller, args: ['kernel', 'tlb_flush'] } }, { source: 'terminal', line: ctx.line });
      if (!result.ok) return fail('tlb', `the command bus refused the call: ${result.message}.`);
      if (result.syscall === undefined) return fail('tlb', 'the command bus returned no result for the call.');
      if (!result.syscall.ok) return fail(result.syscall.errno, `tlb flush: ${result.syscall.errno} (${result.syscall.message}).`, result.syscall.errno);
      return ok([`TLB flushed by P${caller}`]);
    }
    const view = ctx.host.view();
    const valid = view.tlb.filter(entry => entry.valid);
    return ok([
      ...kv([['capacity', view.config.tlbEntries], ['valid entries', valid.length], ['hit rate', percent(view.metrics.memory.tlbHitRate)]]),
      ...table(['SPACE', 'PAGE', 'FRAME'], valid.map(entry => [entry.space, entry.page, entry.frame])),
    ]);
  },
};

const fragHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('frag', argv, { internal: 0, external: 0, compare: 0, compact: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('compare')) return unavailable('frag', '--compare', 'replaying the allocation sequence under the four strategies is not recorded by the kernel');
    if (bound.args.has('compact')) return unavailable('frag', '--compact', 'compaction has no write path from the shell');
    const view = ctx.host.view();
    const both = !bound.args.has('internal') && !bound.args.has('external');
    const runs = freeRuns(view.freeList);
    const pairs: (readonly [string, string | number])[] = [];
    if (both || bound.args.has('external')) pairs.push(['external', percent(view.metrics.memory.externalFragmentation)], ['free runs', runs.length], ['largest free run', `${Math.max(0, ...runs.map(run => run.length))} frames`]);
    if (both || bound.args.has('internal')) pairs.push(['internal', percent(view.metrics.memory.internalFragmentation)]);
    return ok(kv(pairs));
  },
};

const vmstatHandler: ShippedHandler = {
  completions: [{ flag: 'policy', kind: 'replacement' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('vmstat', argv, { interval: 1, faults: 0, policy: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('policy')) {
      const policy = bound.args.value('policy') ?? '';
      const policies = ctx.host.specs.replacementPolicies;
      if (!policies.includes(policy as PageReplacementId)) return fail('vmstat', `unknown policy '${policy}'; the policies are ${policies.join(', ')}.`);
      const result = ctx.host.sink.dispatch({ kind: 'set_replacement', id: policy as PageReplacementId }, { source: 'terminal', line: ctx.line });
      if (!result.ok) return fail('vmstat', `the command bus refused the change: ${result.message}.`);
      return ok([`replacement policy now ${ctx.host.kernel.config.replacementPolicy}`]);
    }
    const view = ctx.host.view();
    const memory = view.metrics.memory;
    const lines = kv([
      ['page faults', memory.pageFaults], ['major faults', memory.majorFaults], ['evictions', memory.evictions], ['write-backs', memory.writeBacks],
      ['free frames', `${memory.freeFrames} of ${memory.totalFrames}`], ['fault rate', `${fixed(memory.faultRate)} per 1000 ticks (smoothed)`],
      ['thrashing threshold', view.config.thrashingThreshold], ['replacement policy', ctx.host.kernel.config.replacementPolicy],
    ]);
    const faults = ctx.rings.faults.toArray();
    if (bound.args.has('interval')) {
      const interval = parseInteger(bound.args.value('interval'));
      if (interval === null || interval < 1) return fail('vmstat', '--interval needs a positive number of ticks.');
      const recent = faults.filter(event => event.tick > view.tick - interval);
      lines.push(`last ${interval} ticks: ${recent.length} faults, ${fixed(recent.length * 1000 / interval)} per 1000 ticks`);
    }
    if (bound.args.has('faults')) lines.push(...table(['TICK', 'PID', 'PAGE', 'MAJOR'], faults.slice(-20).map(event => [event.tick, `P${event.pid}`, event.page, event.major ? 'yes' : 'no'])));
    return ok(lines);
  },
};

const wsHandler: ShippedHandler = {
  completions: [{ flag: null, kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('ws', argv, { window: 1, budget: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('window')) return unavailable('ws', '--window', 'the working set window is a kernel tuning value; the current window is printed above the table');
    const view = ctx.host.view();
    let processes = view.processes.filter(pcb => pcb.pid > 1 && pcb.state !== 'terminated');
    if (bound.args.positional.length > 0) {
      const target = targetPid(ctx, bound.args.positional[0], 'ws');
      if (!target.ok) return target;
      processes = processes.filter(pcb => pcb.pid === target.pid);
    }
    const sizes = view.metrics.memory.workingSets;
    const rows = processes.map(pcb => {
      const ws = sizes.get(pcb.pid) ?? 0;
      const frames = view.frames.filter(frame => frame.owner === pcb.addressSpaceId).length;
      return { pcb, ws, frames, status: view.suspended(pcb.pid) ? 'suspended' : frames < ws ? 'short' : 'ok' };
    });
    const lines = [
      `window ${view.tuning.workingSetWindow} ticks`,
      ...table(['PID', 'NAME', 'WS', 'FRAMES', 'STATUS'], rows.map(row => [row.pcb.pid, row.pcb.name, row.ws, row.frames, row.status])),
    ];
    if (bound.args.has('budget')) {
      const demand = rows.reduce((sum, row) => sum + row.ws, 0);
      lines.push(`budget: working sets total ${demand} against ${view.frames.length} frames (${demand > view.frames.length ? 'over' : 'within'} supply)`);
    }
    return ok(lines);
  },
};

const degreeHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('degree', argv, { set: 1, suspend: 1, resume: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('suspend')) return unavailable('degree', '--suspend', 'suspension is the thrashing controller\'s decision; lower the degree with --set');
    if (bound.args.has('resume')) return unavailable('degree', '--resume', 'suspended processes resume when the controller admits them; raise the degree with --set');
    if (bound.args.has('set')) {
      const target = parseInteger(bound.args.value('set'));
      if (target === null || target < 1) return fail('degree', '--set needs a positive integer.');
      const result = ctx.host.sink.dispatch({ kind: 'set_degree', degree: target }, { source: 'terminal', line: ctx.line });
      if (!result.ok) return fail('degree', `the command bus refused the change: ${result.message}.`);
      return ok([`degree of multiprogramming set to ${ctx.host.degree()}`]);
    }
    const view = ctx.host.view();
    const admitted = view.processes.filter(pcb => pcb.pid > 1 && ['ready', 'running', 'waiting'].includes(pcb.state) && !view.suspended(pcb.pid));
    const suspended = view.processes.filter(pcb => pcb.pid > 1 && view.suspended(pcb.pid));
    return ok(kv([
      ['degree', ctx.host.degree()],
      ['ceiling', view.tuning.degreeOfMultiprogramming],
      ['admitted', `${admitted.length} (${admitted.map(pcb => `P${pcb.pid}`).join(' ') || '-'})`],
      ['suspended', suspended.map(pcb => `P${pcb.pid}`).join(' ') || '-'],
      ['fault rate', `${fixed(view.metrics.memory.faultRate)} per 1000 ticks`],
    ]));
  },
};

export const MEMORY_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['free', freeHandler], ['pagetable', pagetableHandler], ['tlb', tlbHandler], ['frag', fragHandler],
  ['vmstat', vmstatHandler], ['ws', wsHandler], ['degree', degreeHandler],
]);
