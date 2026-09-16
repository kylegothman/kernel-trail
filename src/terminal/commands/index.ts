/**
 * KERNEL TRAIL: the shipped command handlers and their definitions.
 *
 * Every definition is byte-identical to its `TerminalCommandDef` in
 * docs/05-CURRICULUM-MAP.md; the group modules hold them beside their
 * handlers. The base shell registers exactly the fourteen names of design brief
 * section 7, and the rest lie dormant until a leg registers the matching
 * definition through `Leg.terminalCommands`.
 */
import type { TerminalCommandDef } from '@game/types';
import type { ShippedHandler } from '../registry';
import { BASE_HANDLERS, MAN_DEF, MODE_DEF, SYSCALL_DEF } from './base';
import { AMDAHL_DEF, IPC_DEF, KILL_DEF, PROCESS_HANDLERS, PS_DEF, PSTREE_DEF, THREADS_DEF, TOP_DEF, WAIT_DEF } from './process';
import { GANTT_DEF, NICE_DEF, SCHED_DEF, SCHEDULER_HANDLERS } from './scheduler';
import { BUFFER_DEF, LOCK_DEF, RACE_DEF, RWLOCK_DEF, SEM_DEF, SYNC_HANDLERS, TRACE_DEF } from './sync';
import { BANKERS_DEF, DEADLOCK_HANDLERS, RESOURCES_DEF, WFG_DEF } from './deadlock';
import { BELADY_DEF, DEGREE_DEF, FRAG_DEF, FREE_DEF, MEMORY_HANDLERS, PAGETABLE_DEF, TLB_DEF, VMSTAT_DEF, WS_DEF } from './memory';
import { IOSTAT_DEF, RAID_DEF, SEEKQ_DEF, STORAGE_HANDLERS } from './storage';
import { DEVSTAT_DEF, IOMODE_DEF, IO_HANDLERS, IRQ_DEF } from './io';
import { FILESYSTEM_HANDLERS, FSCK_DEF, INODE_DEF, JOURNAL_DEF, LSOF_DEF, MOUNT_DEF } from './filesystem';
import { ACCESS_DEF, AUDIT_DEF, CHMOD_DEF, RING_DEF, SECURITY_HANDLERS } from './security';

/* Leg 13 defines three commands whose handlers a later leg supplies (scope correction T6); their definitions ship here. */
export const HYPER_DEF: TerminalCommandDef = {
  name: 'hyper',
  usage: 'hyper [--type 0|1|2|container] [--traps] [--ring <n>] [--shadow] [--balloon <frames>]',
  summary: 'Configure and inspect the hypervisor, its trap log and its memory management.',
  manual: [
    'hyper reports the virtual machine manager configuration and the traps it has handled.',
    '',
    'The problem virtualization solves is that a guest operating system expects to run in',
    'ring 0 and there is already something there. The solution is to run the guest kernel',
    'in a less privileged ring and let its privileged instructions fault. The hypervisor',
    'catches each fault, works out what the guest was trying to do, does an equivalent',
    'thing to the virtual hardware, and returns. That is trap and emulate, and it is the',
    'whole idea.',
    '',
    'It only works if every privileged instruction actually traps when executed in the',
    'lower ring. Architectures where some privileged instructions fail silently instead of',
    'trapping cannot be virtualized this way, which is why binary translation exists',
    '(rewrite the guest instruction stream before it runs) and why hardware assistance',
    'exists (add a mode where the guest may believe it is in ring 0 while the hypervisor',
    'stays above it). Modern hardware provides the third, and the trap count in --traps is',
    'the cost you are still paying.',
    '',
    'Types:',
    '  0          firmware-level partitioning. The hardware is split up before any',
    '             software runs. Fast and inflexible.',
    '  1          the hypervisor is the operating system on bare metal. Guests run on it.',
    '             This is what data centres run.',
    '  2          the hypervisor is an application on a normal host operating system.',
    '             Convenient, and every guest operation passes through two kernels.',
    '  container  no guest kernel at all. Isolated namespaces and resource limits inside',
    '             one shared kernel. Startup is immediate and overhead is close to zero,',
    '             because there is nothing to emulate.',
    '',
    'The container line is worth reading twice. A container is not a small virtual machine.',
    'There is one kernel and every container shares it. That is why containers are cheap,',
    'and it is precisely why a kernel compromise reaches every container on the host. If',
    'your isolation requirement includes the kernel, a container does not provide it.',
    '',
    '--shadow shows the two-level address translation: guest page tables map guest virtual',
    'to guest physical, and the hypervisor maps guest physical to host physical. Every',
    'guest memory access resolves through both.',
    '',
    '--balloon reclaims memory from a guest by asking a driver inside it to allocate pages',
    'and hand them back. The guest then makes its own eviction decisions with the reduced',
    'supply, using its own knowledge of which pages matter. The alternative, having the',
    'host silently page out guest memory, produces double paging: the host swaps out a',
    'page, the guest then decides to evict the same page, and the page is read in from the',
    'host store purely to be written to the guest store. Ballooning exists to avoid that.',
    '',
    'See also: guest, migrate, codex virtualization.',
  ].join('\n'),
  chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.4.1', '18.4.2', '18.4.3', '18.5.2', '18.5.3', '18.5.4', '18.5.8', '18.6.2'] },
};

export const GUEST_DEF: TerminalCommandDef = {
  name: 'guest',
  usage: 'guest [--list] [--quantum <n>] [--frames <n>] [--devices emulated|paravirt] [--stats]',
  summary: 'Configure the guest machine scheduler, memory and devices, and report its metrics.',
  manual: [
    'guest configures the virtual machine the convoy travels inside, and reports what it',
    'is doing.',
    '',
    'Everything you learned about scheduling now happens twice, and the two layers do not',
    'compose the way you would hope. The guest kernel schedules its processes across what',
    'it believes is a processor. That processor is itself a thread the host schedules. A',
    'guest process granted a full guest quantum receives it only when the guest is running,',
    'so its effective quantum is the guest quantum multiplied by the guest share of the',
    'host. Set both to small values and guest processes receive slivers of time, while the',
    'guest kernel reports that it scheduled them normally, because from inside it did.',
    '',
    'The same doubling applies to memory. The guest performs replacement on guest physical',
    'frames it believes are real, and the host performs replacement on the host frames',
    'backing them. Neither layer can see the other decisions. See hyper --balloon for why',
    'that matters.',
    '',
    '--devices chooses how the guest sees hardware:',
    '  emulated  the hypervisor imitates a real device register by register. The guest',
    '            uses its existing driver and knows nothing. Correct, and every register',
    '            access is a trap.',
    '  paravirt  the guest uses a driver written for virtualization and talks to the',
    '            hypervisor through a shared ring buffer. Far fewer traps, and it requires',
    '            a guest that knows it is a guest.',
    '',
    'See also: hyper, sched, ws, codex nested_scheduling.',
  ].join('\n'),
  chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.5.5', '18.6.1', '18.6.2', '18.6.3'] },
};

export const MIGRATE_DEF: TerminalCommandDef = {
  name: 'migrate',
  usage: 'migrate <target-host> [--precopy] [--dirty-rate] [--downtime]',
  summary: 'Move a running guest to another host and report the transfer and downtime.',
  manual: [
    'migrate moves a running virtual machine from one host to another without terminating',
    'it.',
    '',
    'The state to move is mostly memory, and the machine keeps running and keeps modifying',
    'that memory while it is being copied. So the copy proceeds in rounds: send all pages,',
    'then send the pages that were dirtied during the previous send, then the ones dirtied',
    'during that, and so on. Each round is smaller than the last, provided the guest dirties',
    'pages more slowly than the link can carry them.',
    '',
    'When the remaining set is small enough, the guest is paused, the last pages and the',
    'processor state are sent, and the guest resumes on the target. The pause is the',
    'downtime, and keeping it short is the entire objective.',
    '',
    '--dirty-rate is the number to watch. If the guest dirties pages faster than the link',
    'carries them, the rounds stop shrinking and pre-copy never converges. The options are',
    'then a slower guest, a faster link, or accepting a longer pause.',
    '',
    'Live migration is the clearest single argument for the whole idea of a virtual',
    'machine. A running system with its processes, memory and open connections intact is',
    'moved to different hardware, because the system does not have a relationship with any',
    'hardware at all any more; it has a relationship with an interface the hypervisor',
    'provides.',
    '',
    'See also: hyper, guest, codex live_migration.',
  ].join('\n'),
  chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.6.5'] },
};


/** Design brief section 7: the always-available command set. */
export const BASE_COMMAND_NAMES: readonly string[] = [
  'ps', 'top', 'kill', 'nice', 'free', 'vmstat', 'iostat', 'lsof', 'mount', 'bankers', 'wfg', 'pagetable', 'trace', 'man',
];

/** Every definition this package transcribed, in curriculum map order. */
export const ALL_DEFINITIONS: readonly TerminalCommandDef[] = [
  MAN_DEF, SYSCALL_DEF, MODE_DEF,
  PS_DEF, WAIT_DEF, KILL_DEF, PSTREE_DEF, IPC_DEF,
  THREADS_DEF, AMDAHL_DEF, TOP_DEF,
  SCHED_DEF, NICE_DEF, GANTT_DEF,
  LOCK_DEF, RACE_DEF, TRACE_DEF,
  SEM_DEF, BUFFER_DEF, RWLOCK_DEF,
  WFG_DEF, BANKERS_DEF, RESOURCES_DEF,
  FREE_DEF, PAGETABLE_DEF, TLB_DEF, FRAG_DEF,
  VMSTAT_DEF, WS_DEF, BELADY_DEF, DEGREE_DEF,
  IOSTAT_DEF, SEEKQ_DEF, RAID_DEF,
  IOMODE_DEF, IRQ_DEF, DEVSTAT_DEF,
  INODE_DEF, JOURNAL_DEF, FSCK_DEF, LSOF_DEF, MOUNT_DEF,
  ACCESS_DEF, RING_DEF, AUDIT_DEF, CHMOD_DEF,
  HYPER_DEF, GUEST_DEF, MIGRATE_DEF,
];

/** Handlers by command name, one entry per shipped handler. */
export const SHIPPED_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ...BASE_HANDLERS, ...PROCESS_HANDLERS, ...SCHEDULER_HANDLERS, ...SYNC_HANDLERS, ...DEADLOCK_HANDLERS, ...MEMORY_HANDLERS,
  ...STORAGE_HANDLERS, ...IO_HANDLERS, ...FILESYSTEM_HANDLERS, ...SECURITY_HANDLERS,
]);

export function definitionOf(name: string): TerminalCommandDef | undefined {
  return ALL_DEFINITIONS.find(def => def.name === name);
}

export const BASE_DEFINITIONS: readonly TerminalCommandDef[] = BASE_COMMAND_NAMES
  .map(name => definitionOf(name))
  .filter((def): def is TerminalCommandDef => def !== undefined);
