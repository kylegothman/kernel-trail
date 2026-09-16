import type { TerminationReason, Tick } from '@kernel/index';
import type { Affliction, AfflictionId, AfflictionRemedy, ChapterRef, ConvoyMember } from '../types';

export interface AfflictionSpec {
  readonly id: AfflictionId;
  readonly displayName: string;
  readonly drainPerTick: number;
  readonly fatalAfter: number | null;
  readonly remedy: AfflictionRemedy;
  readonly chapter: ChapterRef;
}
function spec(id: AfflictionId, displayName: string, drainPerTick: number, fatalAfter: number | null,
  remedy: AfflictionRemedy, chapter: number, sections: readonly string[], title: string): AfflictionSpec {
  return { id, displayName, drainPerTick, fatalAfter, remedy, chapter: { chapter, sections, title } };
}
/** Narrative bible 7.1 and remedy payloads from 7.2; RR citations corrected to 5.3.3. */
export const AFFLICTION_TABLE: Readonly<Record<AfflictionId, AfflictionSpec>> = {
  priority_inversion: spec('priority_inversion', 'Priority Inversion', 0.8, null, { kind: 'terminal', command: 'nice -p <holder-pid> -n -10' }, 6, ['6.6', '5.3.3'], 'Synchronization Tools'),
  memory_leak: spec('memory_leak', 'Memory Leak', 0.5, null, { kind: 'terminal', command: 'kill <leaker-pid>' }, 9, ['9.1', '10.8'], 'Main Memory'),
  starvation: spec('starvation', 'Starvation', 1.2, 180, { kind: 'set_scheduler', to: 'priority_aging' }, 5, ['5.3.3'], 'CPU Scheduling'),
  thrashing: spec('thrashing', 'Thrashing', 2.0, 90, { kind: 'reduce_degree', by: 2 }, 10, ['10.6'], 'Virtual Memory'),
  lock_convoy: spec('lock_convoy', 'Lock Convoy', 0.6, null, { kind: 'adjust_quantum', direction: 'increase' }, 6, ['6.5', '5.3.3'], 'Synchronization Tools'),
  livelock: spec('livelock', 'Livelock', 0.9, 140, { kind: 'terminal', command: 'backoff --random <pid>' }, 6, ['6.2', '6.7'], 'Synchronization Tools'),
  orphaned: spec('orphaned', 'Orphaned', 0.4, null, { kind: 'terminal', command: 'reparent <pid> 1' }, 3, ['3.3.2'], 'Processes'),
  fragmented: spec('fragmented', 'Fragmented', 0.7, null, { kind: 'ability', member: 'vesper' }, 9, ['9.2.3'], 'Main Memory'),
  cache_thrash: spec('cache_thrash', 'Cache Thrash', 0.5, null, { kind: 'adjust_quantum', direction: 'increase' }, 1, ['1.5.3', '5.3.3'], 'Introduction'),
  bit_rot: spec('bit_rot', 'Bit Rot', 0.3, 400, { kind: 'spend', resource: 'blocks', amount: 12 }, 11, ['11.8'], 'Mass-Storage Structure'),
  stack_overflow: spec('stack_overflow', 'Stack Overflow', 1.5, 60, { kind: 'ability', member: 'lumen' }, 9, ['9.3.3', '3.1.1'], 'Main Memory'),
  false_sharing: spec('false_sharing', 'False Sharing', 0.6, null, { kind: 'terminal', command: 'align --pad <pid>' }, 4, ['4.5', '1.5.3'], 'Threads & Concurrency'),
  interrupt_storm: spec('interrupt_storm', 'Interrupt Storm', 1.1, 110, { kind: 'terminal', command: 'ioctl <device> mode=dma' }, 12, ['12.2.5'], 'I/O Systems'),
};

export const TERMINATION_FOR_AFFLICTION: Readonly<Record<AfflictionId, TerminationReason>> = {
  priority_inversion: 'starvation', memory_leak: 'out_of_memory', starvation: 'starvation',
  thrashing: 'thrashing_collapse', lock_convoy: 'starvation', livelock: 'starvation',
  orphaned: 'killed_by_parent', fragmented: 'out_of_memory', cache_thrash: 'thrashing_collapse',
  bit_rot: 'storage_corruption', stack_overflow: 'protection_fault', false_sharing: 'starvation',
  interrupt_storm: 'io_timeout',
};

export function makeAffliction(id: AfflictionId, at: Tick): Affliction {
  const row = AFFLICTION_TABLE[id];
  return { id, displayName: row.displayName, acquiredAtTick: at,
    drainPerTick: row.drainPerTick, fatalAfter: row.fatalAfter, remedy: { ...row.remedy } };
}
export function drainDeathReason(member: Readonly<ConvoyMember>): TerminationReason {
  const strongest = [...member.afflictions].sort((a, b) => b.drainPerTick - a.drainPerTick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return strongest === undefined ? 'starvation' : TERMINATION_FOR_AFFLICTION[strongest.id];
}
