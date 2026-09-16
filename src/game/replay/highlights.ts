/**
 * Downsampling the event log to the debrief timeline. WP-18 specification
 * section 4: at most 400 entries, deterministic, keeping every fatal event,
 * every convoy `process.exited`, every `deadlock.detected` and every
 * `memory.thrashing` severity change, then an even sample of the rest.
 */

import type { ConvoyMemberId, KernelEvent, Pid } from '@kernel/types';
import type { ReplayHighlight } from './types';

export const HIGHLIGHT_CAP = 400;

/** Who a pid is in the player's terms, or null for a workload process. */
export type MemberOf = (pid: Pid) => ConvoyMemberId | null;

function who(pid: Pid | null, memberOf: MemberOf): string {
  if (pid === null) return 'idle';
  const member = memberOf(pid);
  return member === null ? `P${String(pid)}` : member.toUpperCase();
}

export function severityOf(event: KernelEvent, memberOf: MemberOf): ReplayHighlight['severity'] {
  switch (event.type) {
    case 'process.exited':
      if (event.reason === 'normal_exit') return 'info';
      return memberOf(event.pid) === null ? 'warning' : 'fatal';
    case 'process.starving':
      return event.fatal ? 'fatal' : 'warning';
    case 'kernel.panic':
      return 'fatal';
    case 'memory.thrashing':
    case 'memory.allocation_failed':
    case 'deadlock.detected':
    case 'deadlock.resolved':
    case 'sync.race_detected':
    case 'resource.denied':
    case 'fs.corruption':
    case 'security.access_denied':
    case 'security.escalation_attempt':
    case 'io.poll_wasted':
    case 'raid.rebuild':
      return 'warning';
    default:
      return 'info';
  }
}

/** One line per event, in the player's terms. */
export function summarise(event: KernelEvent, memberOf: MemberOf): string {
  switch (event.type) {
    case 'process.created':
      return `${who(event.pid, memberOf)} created${event.parent === null ? '' : ` by ${who(event.parent, memberOf)}`}`;
    case 'process.state_changed':
      return `${who(event.pid, memberOf)} ${event.from} to ${event.to}`;
    case 'process.exited':
      return event.reason === 'normal_exit'
        ? `${who(event.pid, memberOf)} finished with exit code ${event.exitCode}`
        : `${who(event.pid, memberOf)} derezzed: ${event.reason.replace(/_/g, ' ')}`;
    case 'process.reaped':
      return `${who(event.pid, memberOf)} reaped by ${who(event.by, memberOf)}`;
    case 'process.starving':
      return `${who(event.pid, memberOf)} has waited ${event.waitedTicks} ticks${event.fatal ? ', fatal' : ''}`;
    case 'context.switch':
      return `switch ${who(event.from, memberOf)} to ${who(event.to, memberOf)}: ${event.rationale}`;
    case 'quantum.expired':
      return `${who(event.pid, memberOf)} quantum expired at level ${event.level}`;
    case 'thread.created':
      return `${who(event.pid, memberOf)} started thread ${String(event.tid)}`;
    case 'thread.joined':
      return `${who(event.pid, memberOf)} joined thread ${String(event.tid)}`;
    case 'memory.access':
      return `${who(event.pid, memberOf)} ${event.write ? 'wrote' : 'read'} page ${String(event.page)}, ${event.hit ? 'hit' : 'miss'}`;
    case 'memory.page_fault':
      return `${who(event.pid, memberOf)} ${event.major ? 'major' : 'minor'} fault on page ${String(event.page)}`;
    case 'memory.page_loaded':
      return `${who(event.pid, memberOf)} page ${String(event.page)} loaded into frame ${String(event.frame)}`;
    case 'memory.page_evicted':
      return `frame ${String(event.frame)} evicted by ${event.policy}${event.dirty ? ', written back' : ''}`;
    case 'memory.allocated':
      return `${who(event.pid, memberOf)} allocated ${event.frames.length} frames by ${event.strategy.replace(/_/g, ' ')}`;
    case 'memory.allocation_failed':
      return `${who(event.pid, memberOf)} could not allocate ${event.requested}: ${event.reason.replace(/_/g, ' ')}`;
    case 'memory.thrashing':
      return `thrashing ${event.severity}: fault rate ${Math.round(event.faultRate)}`;
    case 'tlb.miss':
      return `${who(event.pid, memberOf)} TLB miss on page ${String(event.page)}`;
    case 'sync.acquired':
      return `${who(event.pid, memberOf)} acquired ${String(event.resource)}`;
    case 'sync.blocked':
      return `${who(event.pid, memberOf)} blocked on ${String(event.resource)}, ${event.queueLength} waiting`;
    case 'sync.released':
      return `${who(event.pid, memberOf)} released ${String(event.resource)}${event.woke === null ? '' : `, woke ${who(event.woke, memberOf)}`}`;
    case 'sync.race_detected':
      return 'race detected';
    case 'sync.busy_wait':
      return `${who(event.pid, memberOf)} spun ${event.spunTicks} ticks on ${String(event.resource)}`;
    case 'resource.requested':
      return `${who(event.pid, memberOf)} requested ${event.instances} of ${String(event.resource)}`;
    case 'resource.granted':
      return `${who(event.pid, memberOf)} granted ${event.instances} of ${String(event.resource)}`;
    case 'resource.denied':
      return `${who(event.pid, memberOf)} denied ${String(event.resource)}: ${event.reason}`;
    case 'bankers.evaluated':
      return `safety check for ${who(event.forRequest.pid, memberOf)} on ${String(event.forRequest.resource)}`;
    case 'deadlock.detected':
      return `deadlock among ${event.report.cycle.map((pid) => who(pid, memberOf)).join(', ')}`;
    case 'deadlock.resolved':
      return `deadlock resolved by ${event.method}: ${event.victims.map((pid) => who(pid, memberOf)).join(', ')}`;
    case 'disk.queued':
      return `${who(event.request.pid, memberOf)} queued cylinder ${event.request.cylinder}`;
    case 'disk.seek':
      return `head moved ${event.distance} cylinders, ${event.from} to ${event.to}`;
    case 'disk.served':
      return `${who(event.request.pid, memberOf)} served after ${event.waitTicks} ticks`;
    case 'raid.rebuild':
      return `rebuilding disk ${event.failedDisk}, ${Math.round(event.progress * 100)} percent`;
    case 'io.request':
      return `${who(event.pid, memberOf)} ${event.mode} request on ${String(event.device)}`;
    case 'io.interrupt':
      return `interrupt from ${String(event.device)}`;
    case 'io.dma_transfer':
      return `DMA moved ${event.bytes} bytes on ${String(event.device)}`;
    case 'io.poll_wasted':
      return `${event.wastedTicks} ticks wasted polling ${String(event.device)}`;
    case 'fs.block_allocated':
      return `block ${String(event.block)} allocated to inode ${String(event.inode)}`;
    case 'fs.fragmented':
      return `inode ${String(event.inode)} fragmented into ${event.extents} extents`;
    case 'fs.journal':
      return `journal ${event.entry.phase} for transaction ${event.entry.txId}`;
    case 'fs.corruption':
      return `inode ${String(event.inode)} corrupted${event.recoverable ? ', recoverable' : ''}`;
    case 'fs.recovered':
      return `inode ${String(event.inode)} recovered${event.fromJournal ? ' from the journal' : ''}`;
    case 'security.access_denied':
      return `${String(event.domain)} denied ${event.right} on ${event.object}`;
    case 'security.escalation_attempt':
      return `${who(event.pid, memberOf)} tried ring ${event.fromRing} to ${event.toRing}${event.blocked ? ', blocked' : ''}`;
    case 'syscall.invoked':
      return `${who(event.request.pid, memberOf)} called ${event.request.name}`;
    case 'kernel.panic':
      return `kernel panic: ${event.message}`;
    default:
      return unreachable(event);
  }
}

function unreachable(event: never): string {
  return String((event as { type?: unknown }).type);
}

/**
 * Deterministic selection: the mandatory events in log order, then the rest
 * sampled at evenly spaced indices, merged back into log order. Same input,
 * same entries, every time. Should the mandatory set alone exceed the cap,
 * the earliest entries win, so the cap holds in every case.
 */
export function selectHighlights(events: readonly KernelEvent[], memberOf: MemberOf, cap = HIGHLIGHT_CAP): ReplayHighlight[] {
  const mandatory: number[] = [];
  const optional: number[] = [];
  let lastThrashing: 'warning' | 'critical' | null = null;
  events.forEach((event, i) => {
    let keep = severityOf(event, memberOf) === 'fatal';
    if (event.type === 'process.exited' && memberOf(event.pid) !== null) keep = true;
    if (event.type === 'deadlock.detected') keep = true;
    if (event.type === 'memory.thrashing') {
      if (event.severity !== lastThrashing) keep = true;
      lastThrashing = event.severity;
    }
    (keep ? mandatory : optional).push(i);
  });
  const chosen = mandatory.slice(0, cap);
  const room = cap - chosen.length;
  if (room > 0 && optional.length > 0) {
    const take = Math.min(room, optional.length);
    for (let k = 0; k < take; k++) {
      const index = optional[Math.floor((k * optional.length) / take)];
      if (index !== undefined) chosen.push(index);
    }
  }
  chosen.sort((a, b) => a - b);
  return chosen.flatMap((i) => {
    const event = events[i];
    if (event === undefined) return [];
    return [{ tick: event.tick, type: event.type, summary: summarise(event, memberOf), severity: severityOf(event, memberOf) }];
  });
}
