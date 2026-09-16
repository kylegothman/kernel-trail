/**
 * KERNEL TRAIL: the I/O commands of Leg 10.
 *
 * `iomode` reads the device table from the view and changes a device's mode
 * through the sink as an ioctl on the player's behalf. `irq` reads the shell's
 * interrupt ring, the pending lines from the view and the kernel's own CPU
 * charges from the host. `devstat` reads the device queues and the buffers.
 */
import type { TerminalCommandDef } from '@game/types';
import type { IoMode } from '@kernel/types';
import { fixed, kv, percent, table } from '../output';
import { bindOrFail, fail, ok, unavailable, type ShippedHandler } from '../registry';
import { callerPid, type ShellContext } from '../Shell';

export const IOMODE_DEF: TerminalCommandDef = {
  name: 'iomode',
  usage: 'iomode [--device <id>] [--set polling|interrupt|dma] [--attach <id> block|character|network]',
  summary: 'Show and set how the processor communicates with a device, and attach a new one.',
  manual: [
    'iomode reports each device transfer mode and lets you change it.',
    '',
    '  polling    the processor reads a status register in a loop until the device is',
    '             ready. Every one of those reads is a processor cycle spent on nothing.',
    '             It is the right choice when the wait is shorter than the cost of',
    '             handling an interrupt, and the wrong choice by an enormous margin when',
    '             the wait is long.',
    '  interrupt  the device raises a signal when it is ready. The processor does other',
    '             work in the meantime and is interrupted to handle completion. Costs a',
    '             context switch into the handler and back, per event.',
    '  dma        the device transfers directly to and from memory, and interrupts the',
    '             processor once when the whole transfer is done. Per-byte processor cost',
    '             is zero.',
    '',
    'The usual summary is that interrupts beat polling, and that is true for the case',
    'everyone has in mind: a slow device with occasional events. Invert the case and the',
    'answer inverts. A device delivering events faster than the handler runs will spend',
    'all available processor time entering and leaving the handler, and the system will',
    'appear fully busy while completing nothing. At that arrival rate, polling the device',
    'in a controlled loop and batching what you find is faster, because you pay the entry',
    'cost once for many events. High-rate network drivers do exactly this.',
    '',
    'So the rule is about rates rather than about mechanisms: interrupt when events are',
    'rarer than the handler cost, poll when they are more frequent.',
    '',
    '--attach binds an unfamiliar device to one of the standard application interfaces.',
    'This is what a device driver is: the thing that presents a specific piece of hardware',
    'through a general interface so that no program has to know which device it is talking',
    'to. Choose the interface that matches the device semantics. A block device supports',
    'seeking to an arbitrary position; a character device is a stream and seeking on it is',
    'meaningless. Attaching a stream as a block device succeeds and gives you a seek that',
    'silently does nothing.',
    '',
    'See also: irq, devstat, codex io_methods.',
  ].join('\n'),
  chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.2.2', '12.2.3', '12.2.4', '12.3.1', '12.5'] },
};

export const IRQ_DEF: TerminalCommandDef = {
  name: 'irq',
  usage: 'irq [--rate] [--coalesce <n>] [--handlers] [--latency]',
  summary: 'Report interrupt rate and handler time, and set coalescing.',
  manual: [
    'irq prints the interrupt rate per device, the time spent in each handler, and the',
    'fraction of processor time going to interrupt handling.',
    '',
    'An interrupt is a hardware event that stops the running instruction stream, switches',
    'to kernel mode, runs a handler, and returns. It is the same mechanism as a trap, with',
    'one difference that matters: a trap is raised by the running program and an interrupt',
    'is raised by something outside it, at a moment the program cannot predict or refuse.',
    '',
    'The cost is per interrupt and it does not shrink when interrupts get more frequent.',
    'Multiply it out on any device and you find a rate above which the processor cannot',
    'keep up. Past that rate the system enters an interrupt storm: fully occupied, making',
    'no progress, and unable to run the code that would drain the device queue. The',
    'utilisation meter reads near 100 percent, which is why this failure is often',
    'mistaken for healthy load.',
    '',
    '--coalesce n tells the device to raise one interrupt per n events, or after a short',
    'timeout, whichever comes first. It trades a little latency for a large reduction in',
    'per-event overhead, and it is the standard fix.',
    '',
    'Handlers must be short. Anything a handler does, it does with other interrupts',
    'possibly disabled and with the interrupted process suspended. Real systems split',
    'handlers into a minimal part that runs immediately and a deferred part that runs',
    'later as ordinary kernel work.',
    '',
    'See also: iomode, top, codex interrupt_storm.',
  ].join('\n'),
  chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.2.3', '12.7'] },
};

export const DEVSTAT_DEF: TerminalCommandDef = {
  name: 'devstat',
  usage: 'devstat [--device <id>] [--buffer <n>] [--copies] [--async on|off]',
  summary: 'Show device queues and buffering, set buffer size, and set request mode.',
  manual: [
    'devstat prints per-device queue length, buffer occupancy, copy count per transfer,',
    'and whether requests are blocking or asynchronous.',
    '',
    'Buffering exists for three separate reasons and it is worth keeping them apart.',
    'First, speed mismatch: a fast producer and a slow device need somewhere to put the',
    'difference. Second, transfer size mismatch: a device that moves 512 bytes at a time',
    'serving a request for 3000. Third, copy semantics: the write call returns as soon as',
    'the data is in the kernel buffer, so the calling program may reuse its own memory',
    'immediately, even though the device has not seen the data yet.',
    '',
    'That third one has a consequence people are surprised by. A write that returned',
    'successfully has not necessarily reached the device, and a power loss between the',
    'return and the flush loses it. Anything that must be durable has to say so; see sync',
    'and the journal.',
    '',
    '--copies counts how many times each transfer is copied on its way through. Every copy',
    'costs memory bandwidth and none of them do anything useful. Two is normal, one is',
    'good, and more than two usually means a layer is buffering something that was already',
    'buffered.',
    '',
    '--async on issues requests without blocking the caller; the caller is notified on',
    'completion. Use it when the result is not needed immediately, such as a log write.',
    'Use blocking when the next instruction genuinely depends on the data, such as reading',
    'the route configuration you are about to follow. Making everything asynchronous is',
    'not free: it moves the waiting into your own code and makes ordering your problem.',
    '',
    'See also: iomode, irq, iostat, codex io_buffering.',
  ].join('\n'),
  chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.3.4', '12.4.2', '12.4.3'] },
};

/** The three transfer modes of the frozen IoMode union. */
const MODES: readonly IoMode[] = ['polling', 'interrupt', 'dma'];

/** Live transfer modes by device id. The view's Device.mode is the configured default, so the I/O payload is read instead. */
export function liveModes(ctx: ShellContext): ReadonlyMap<string, IoMode> {
  return new Map(ctx.host.ioDevices().map(device => [device.id, device.mode]));
}

const iomodeHandler: ShippedHandler = {
  completions: [{ flag: 'device', kind: 'device' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('iomode', argv, { device: 1, set: 1, attach: 2 });
    if (!bound.ok) return bound;
    if (bound.args.has('attach')) return unavailable('iomode', '--attach', 'devices are registered by the leg with their interface already chosen');
    const view = ctx.host.view();
    const id = bound.args.value('device');
    const device = id === undefined ? undefined : view.devices.find(row => row.id === id);
    if (id !== undefined && device === undefined) return fail('iomode', `no such device ${id}; the devices are ${view.devices.map(row => row.id).join(', ') || 'none'}.`, 'ENOENT');
    if (bound.args.has('set')) {
      const mode = bound.args.value('set') ?? '';
      if (!MODES.includes(mode as IoMode)) return fail('iomode', `unknown mode '${mode}'; the modes are ${MODES.join(', ')}.`);
      if (device === undefined) return fail('iomode', '--set needs --device to name the device.');
      // Issued as the running process, else init (callerPid rule in Shell.ts); the driver's set_mode ioctl changes the mode.
      const caller = callerPid(ctx.host);
      const result = ctx.host.sink.dispatch({ kind: 'syscall', request: { name: 'ioctl', pid: caller, args: [device.id, 'set_mode', mode] } }, { source: 'terminal', line: ctx.line });
      if (!result.ok) return fail('iomode', `the command bus refused the call: ${result.message}.`);
      if (result.syscall === undefined) return fail('iomode', 'the command bus returned no result for the call.');
      if (!result.syscall.ok) return fail(result.syscall.errno, `iomode ${device.id}: ${result.syscall.errno} (${result.syscall.message}).`, result.syscall.errno);
      // The device table in the view refreshes with the next tick; the driver has already switched.
      return ok([`${device.id} mode set to ${mode}`]);
    }
    const modes = liveModes(ctx);
    const rows = device === undefined ? view.devices : [device];
    return ok(table(['DEVICE', 'KIND', 'MODE', 'DEFAULT', 'LATENCY', 'BUSY', 'QUEUE'], rows.map(row => [row.id, row.kind, modes.get(row.id) ?? row.mode, row.mode, row.latency, row.busy ? 'yes' : 'no', row.queue.length])));
  },
};

const irqHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('irq', argv, { rate: 0, coalesce: 1, handlers: 0, latency: 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('coalesce')) return unavailable('irq', '--coalesce', 'the kernel models no interrupt coalescing');
    const view = ctx.host.view();
    const interrupts = ctx.rings.interrupts.toArray();
    const charges = ctx.host.ioCharges();
    const tick = Math.max(1, view.tick);
    const first = interrupts[0]?.tick ?? view.tick;
    const window = Math.max(1, view.tick - first + 1);
    const counts = new Map<string, number>();
    for (const event of interrupts) counts.set(event.device, (counts.get(event.device) ?? 0) + 1);
    const pending = new Map(view.interruptLines.map(line => [line.device, line.pending]));
    const devices = [...new Set([...counts.keys(), ...pending.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lines = kv([
      ['interrupts', `${interrupts.length} recorded over ${window} ticks`],
      ['rate', `${fixed(interrupts.length * 1000 / window)} per 1000 ticks`],
      ['handler ticks', charges.interruptTicks],
      ['handler share', percent(charges.interruptTicks / tick)],
      ['pending', view.interruptLines.reduce((sum, line) => sum + line.pending, 0)],
    ]);
    lines.push(...table(['DEVICE', 'COUNT', 'RATE', 'PENDING'], devices.map(device => [device, counts.get(device) ?? 0, fixed((counts.get(device) ?? 0) * 1000 / window), pending.get(device) ?? 0])));
    if (bound.args.has('handlers')) lines.push(`handler cost ${view.tuning.interruptServiceTicks} ticks per interrupt, at most ${view.tuning.maxInterruptsPerTick} per tick, storm above ${view.tuning.interruptStormThreshold} in ${view.tuning.interruptStormWindow} ticks`);
    if (bound.args.has('latency')) lines.push(`kernel I/O debt outstanding ${view.ioDebt} ticks; copy ${charges.copyTicks}, DMA steal ${charges.dmaStealTicks}, issue ${charges.issueTicks} ticks charged so far`);
    return ok(lines);
  },
};

const devstatHandler: ShippedHandler = {
  completions: [{ flag: 'device', kind: 'device' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('devstat', argv, { device: 1, buffer: 1, copies: 0, async: 1 });
    if (!bound.ok) return bound;
    if (bound.args.has('buffer')) return unavailable('devstat', '--buffer', 'buffers are configured by the leg that registers the device');
    if (bound.args.has('async')) return unavailable('devstat', '--async', 'the kernel models blocking requests only');
    const view = ctx.host.view();
    const id = bound.args.value('device');
    const devices = id === undefined ? view.devices : view.devices.filter(row => row.id === id);
    if (id !== undefined && devices.length === 0) return fail('devstat', `no such device ${id}; the devices are ${view.devices.map(row => row.id).join(', ') || 'none'}.`, 'ENOENT');
    const buffers = ctx.host.ioBuffers().filter(buffer => id === undefined || buffer.device === id);
    const modes = liveModes(ctx);
    const lines = table(['DEVICE', 'KIND', 'MODE', 'BUSY', 'QUEUE'], devices.map(row => [row.id, row.kind, modes.get(row.id) ?? row.mode, row.busy ? 'yes' : 'no', row.queue.length]));
    lines.push(`${buffers.length} buffers`);
    if (buffers.length > 0) {
      lines.push(...table(['DEVICE', 'SCHEME', 'READY', 'FILLING', 'DRAINING', 'STALLS', 'WAITERS'], buffers.map(buffer => [
        buffer.device, buffer.scheme.kind === 'circular' ? `circular(${buffer.scheme.capacity})` : buffer.scheme.kind, buffer.ready.length,
        buffer.filling === null ? '-' : `${buffer.filling.remainingTicks} ticks left`, buffer.draining === null ? '-' : `${buffer.draining.remainingTicks} ticks left`,
        buffer.stalls, buffer.producerWaiters.length + buffer.consumerWaiters.length,
      ])));
    }
    if (bound.args.has('copies')) {
      const charges = ctx.host.ioCharges();
      lines.push(`copy ticks ${charges.copyTicks}, DMA steal ticks ${charges.dmaStealTicks}, issue ticks ${charges.issueTicks}, interrupt ticks ${charges.interruptTicks}`);
    }
    return ok(lines);
  },
};

export const IO_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['iomode', iomodeHandler], ['irq', irqHandler], ['devstat', devstatHandler],
]);
