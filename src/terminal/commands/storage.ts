/**
 * KERNEL TRAIL: the storage commands of Leg 9.
 *
 * `iostat` measures from the shell's disk service ring and the live queue,
 * `seekq` reads the queue and head from the view and the projected arm path
 * from the host, and `raid` reads the array state from the host. The disk
 * policy changes through exactly one sink dispatch.
 */
import type { TerminalCommandDef } from '@game/types';
import type { DiskSchedulingId } from '@kernel/types';
import { fixed, kv, percent, table } from '../output';
import { parseInteger } from '../parser';
import { bindOrFail, fail, ok, unavailable, type ShippedHandler } from '../registry';
import type { ShellContext } from '../Shell';
import { liveModes } from './io';

export const IOSTAT_DEF: TerminalCommandDef = {
  name: 'iostat',
  usage: 'iostat [--device <id>] [--variance] [--interval <ticks>]',
  summary: 'Report storage throughput, average wait, wait variance and queue depth.',
  manual: [
    'iostat prints per-device throughput, average service time, average wait time, wait',
    'time variance, and queue depth.',
    '',
    'Read variance next to the average, always. A policy with a good average and terrible',
    'variance is serving most requests quickly and abandoning a few completely, and the',
    'abandoned ones belong to processes that will block, time out, and die. The average',
    'will not show you that. This is the same lesson the ready queue taught, in different',
    'hardware.',
    '',
    'Queue depth tells you whether scheduling matters at all. With a queue depth of one',
    'there is nothing to reorder and every policy is the same policy. Disk scheduling only',
    'pays when requests are waiting, which means it pays most exactly when the system is',
    'under load.',
    '',
    'See also: seekq, raid, top, codex disk_scheduling.',
  ].join('\n'),
  chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.2.4'] },
};

export const SEEKQ_DEF: TerminalCommandDef = {
  name: 'seekq',
  usage: 'seekq [--policy <id>] [--direction up|down] [--path] [--compare]',
  summary: 'Show the pending request queue, the projected arm path, and set the policy.',
  manual: [
    'seekq lists pending requests by cylinder with the age of each, and draws the path',
    'the arm will take under the current policy.',
    '',
    'A mechanical drive costs three things per request: seek time to move the arm to the',
    'cylinder, rotational latency to wait for the sector to come round, and transfer',
    'time. Seek dominates, and it is the only one scheduling can reduce, which is why',
    'every one of these policies is about arm movement.',
    '',
    '  fcfs   serve in arrival order. Fair, and the arm may cross the platter repeatedly',
    '         for no reason. Use it as the baseline you are trying to beat.',
    '  sstf   serve the nearest request next. Large reduction in total travel. It also',
    '         starves the edges: while requests keep arriving near the head, a request at',
    '         cylinder 4 is never the nearest one and waits forever. This is starvation,',
    '         with the same structure as priority scheduling without aging, on different',
    '         hardware.',
    '  scan   sweep to one end serving everything on the way, reverse, sweep back. No',
    '         starvation, because the arm is guaranteed to arrive. Requests just behind',
    '         the arm wait almost a full sweep, so waiting time varies a lot depending on',
    '         where you happen to be.',
    '  cscan  sweep in one direction only, then return without serving. Treats the',
    '         cylinders as circular. Total travel is slightly higher than scan and waiting',
    '         time is much more uniform, because every position waits about the same.',
    '  look   scan, but reverse at the last request rather than at the physical end. Same',
    '  clook  behaviour, less pointless travel. These are what real drivers implement.',
    '',
    'Choosing between them is choosing what to optimise. sstf minimises the average and',
    'accepts terrible worst cases. cscan gives up some average to make the worst case',
    'predictable. If anything in your workload has a deadline, predictable beats fast.',
    '',
    '--compare replays the recorded queue under every policy and prints total travel,',
    'average wait and worst wait for each.',
    '',
    'See also: iostat, codex disk_scheduling.',
  ].join('\n'),
  chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.2.1', '11.2.2', '11.2.3', '11.2.4'] },
};

export const RAID_DEF: TerminalCommandDef = {
  name: 'raid',
  usage: 'raid [--level <n>] [--status] [--spare] [--rebuild]',
  summary: 'Show and configure the storage array, and manage rebuilds.',
  manual: [
    'raid reports the array level, device states, and rebuild progress.',
    '',
    'RAID combines several devices for one of two reasons, and it is worth being clear',
    'which one you are buying.',
    '  0   striping, no redundancy. Fast, and any single device failure loses everything.',
    '      This is not redundancy; it is the opposite of redundancy, since the array now',
    '      fails if any member fails.',
    '  1   mirroring. Every block on two devices. Survives one failure per mirror pair.',
    '      Costs half your capacity and makes reads faster and writes no slower.',
    '  4   striping with a dedicated parity device. Survives one failure. Every write',
    '      touches the parity device, which becomes the bottleneck.',
    '  5   striping with parity spread across all devices. Survives one failure, no parity',
    '      bottleneck. A small write costs a read of the old data and parity plus two',
    '      writes, which is the write amplification you will see in iostat.',
    '  6   two parity blocks. Survives two failures. More write cost, and worth it for',
    '      large arrays where a rebuild takes long enough that a second failure is likely.',
    '  10  mirrored stripes. Fast, survives failures that do not take out both halves of',
    '      a pair, costs half your capacity.',
    '',
    'The rebuild window is the dangerous part and it is where arrays actually die. While',
    'a degraded array rebuilds, it has no redundancy left, and the rebuild reads every',
    'block on every surviving device, which is exactly the workload most likely to expose',
    'a second failure. Shorten the window: keep a hot spare so the rebuild starts',
    'immediately, and reduce foreground I/O so it finishes sooner.',
    '',
    'One thing RAID does not do, stated here because assuming otherwise is how data is',
    'lost: it is not a backup. It protects against a device failing. It faithfully',
    'replicates every deletion, every overwrite and every corruption written through the',
    'file system, to every member, instantly.',
    '',
    'See also: iostat, journal (available later), codex raid.',
  ].join('\n'),
  chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.8.1', '11.8.2', '11.8.3', '11.8.4', '11.8.5'] },
};

function mean(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function variance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const average = mean(values);
  return mean(values.map(value => (value - average) ** 2));
}

const iostatHandler: ShippedHandler = {
  completions: [{ flag: 'device', kind: 'device' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('iostat', argv, { device: 1, variance: 0, interval: 1 });
    if (!bound.ok) return bound;
    const view = ctx.host.view();
    if (bound.args.has('device')) {
      const id = bound.args.value('device') ?? '';
      const device = view.devices.find(row => row.id === id);
      if (device === undefined) return fail('iostat', `no such device ${id}; the devices are ${view.devices.map(row => row.id).join(', ') || 'none'}.`, 'ENOENT');
      return ok(kv([
        ['device', device.id], ['name', device.displayName], ['kind', device.kind], ['mode', liveModes(ctx).get(device.id) ?? device.mode], ['latency', `${device.latency} ticks`],
        ['busy', device.busy ? 'yes' : 'no'], ['queue depth', device.queue.length], ['queued', device.queue.map(pid => `P${pid}`).join(' ') || '-'],
      ]));
    }
    let served = ctx.rings.diskServed.toArray();
    let window = Math.max(1, view.tick);
    if (bound.args.has('interval')) {
      const interval = parseInteger(bound.args.value('interval'));
      if (interval === null || interval < 1) return fail('iostat', '--interval needs a positive number of ticks.');
      served = served.filter(event => event.tick > view.tick - interval);
      window = interval;
    }
    const waits = served.map(event => event.waitTicks);
    const modes = liveModes(ctx);
    return ok([
      ...kv([
        ['disk policy', ctx.host.kernel.config.diskPolicy],
        ['head', `cylinder ${view.diskHead.cylinder} of ${view.diskHead.totalCylinders}, ${view.diskHead.direction}`],
        ['queue depth', view.diskQueue.length],
        ['served', `${served.length} in ${window} ticks`],
        ['throughput', `${fixed(served.length * 100 / window)} per 100 ticks`],
        ['average wait', `${fixed(mean(waits))} ticks`],
        ['wait variance', fixed(variance(waits))],
        ['worst wait', waits.length === 0 ? 0 : Math.max(...waits)],
      ]),
      ...table(['DEVICE', 'KIND', 'MODE', 'BUSY', 'QUEUE'], view.devices.map(device => [device.id, device.kind, modes.get(device.id) ?? device.mode, device.busy ? 'yes' : 'no', device.queue.length])),
    ]);
  },
};

const seekqHandler: ShippedHandler = {
  completions: [{ flag: 'policy', kind: 'disk' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('seekq', argv, { policy: 1, direction: 1, path: 0, compare: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('compare')) return unavailable('seekq', '--compare', 'the queue is not replayed under every policy by the kernel');
    if (bound.args.has('direction')) return unavailable('seekq', '--direction', 'the arm direction belongs to the policy in force');
    if (bound.args.has('policy')) {
      const policy = bound.args.value('policy') ?? '';
      const policies = ctx.host.specs.diskPolicies;
      if (!policies.includes(policy as DiskSchedulingId)) return fail('seekq', `unknown policy '${policy}'; the policies are ${policies.join(', ')}.`);
      const result = ctx.host.sink.dispatch({ kind: 'set_disk', id: policy as DiskSchedulingId }, { source: 'terminal', line: ctx.line });
      if (!result.ok) return fail('seekq', `the command bus refused the change: ${result.message}.`);
      return ok([`disk policy set to ${ctx.host.kernel.config.diskPolicy}`]);
    }
    const view = ctx.host.view();
    const lines = [
      `head at cylinder ${view.diskHead.cylinder} of ${view.diskHead.totalCylinders}, direction ${view.diskHead.direction}, policy ${ctx.host.kernel.config.diskPolicy}, ${view.diskQueue.length} pending`,
      ...table(['ID', 'PID', 'CYLINDER', 'WRITE', 'AGE'], view.diskQueue.map(request => [request.id, `P${request.pid}`, request.cylinder, request.write ? 'yes' : 'no', view.tick - request.queuedAtTick])),
    ];
    if (bound.args.has('path')) {
      const path = ctx.host.projectedPath();
      lines.push(`path: ${path.length === 0 ? 'no pending requests' : path.join(' -> ')}`);
    }
    return ok(lines);
  },
};

const raidHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('raid', argv, { level: 1, status: 0, spare: 0, rebuild: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('level')) return unavailable('raid', '--level', 'the array level is fixed by the leg that builds it');
    if (bound.args.has('spare')) return unavailable('raid', '--spare', 'spares are declared by the leg that builds the array');
    if (bound.args.has('rebuild')) return unavailable('raid', '--rebuild', 'rebuilds start when a member fails and a spare exists');
    const arrays = ctx.host.raid();
    if (arrays.length === 0) return ok(['no array configured']);
    const lines: string[] = [];
    for (const array of arrays) {
      const failed = array.members.filter(member => member.failed).length;
      const status = array.dataLost ? 'lost' : failed > 0 ? 'degraded' : 'healthy';
      lines.push(...kv([
        ['array', array.arrayId], ['level', array.level], ['status', status],
        ['members', array.members.map(member => `${member.driveId}${member.failed ? ' FAILED' : ''}`).join(', ')],
        ['spares', array.spareDriveIds.join(', ') || '-'],
        ['rebuilds', array.rebuilds.length === 0 ? '-' : array.rebuilds.map(row => `member ${row.memberIndex} -> ${row.spareDriveId} ${percent(row.completedPrefix / Math.max(1, array.blocksPerMember))}${array.rebuildPaused ? ' (paused)' : ''}`).join('; ')],
        ["blocks", `${array.counters.completedReadBlocks} read, ${array.counters.completedWriteBlocks} written, ${array.counters.completedRebuildBlocks} rebuilt`],
      ]));
    }
    return ok(lines);
  },
};

export const STORAGE_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['iostat', iostatHandler], ['seekq', seekqHandler], ['raid', raidHandler],
]);
