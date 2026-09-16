/**
 * Architecture 11.5's `REQUIRED_EVENTS` table, verbatim, all fourteen rows
 * (WP-20 section 6, acceptance 22). Every leg declares the signature
 * pathology it teaches; the chaotic policy is designed to trigger it, and a
 * leg whose pathology never fires cannot teach it.
 */
import type { LegId } from '@game/types';

export const REQUIRED_EVENTS: Readonly<Record<LegId, readonly string[]>> = {
  boot_sector:      ['syscall.invoked', 'process.created'],
  fork_fields:      ['process.created', 'process.exited', 'process.reaped'],
  the_weave:        ['thread.created', 'thread.joined', 'context.switch'],
  quantum_pass:     ['context.switch', 'quantum.expired', 'process.starving'],
  the_narrows:      ['sync.acquired', 'sync.blocked', 'sync.race_detected'],
  the_cistern:      ['sync.blocked', 'sync.released'],
  the_gridlock:     ['resource.requested', 'deadlock.detected', 'bankers.evaluated'],
  allocation_yards: ['memory.allocated', 'memory.allocation_failed', 'tlb.miss'],
  drowned_reach:    ['memory.page_fault', 'memory.page_evicted', 'memory.thrashing'],
  the_platters:     ['disk.queued', 'disk.seek', 'disk.served'],
  the_bus:          ['io.request', 'io.interrupt', 'io.poll_wasted'],
  the_archive:      ['fs.block_allocated', 'fs.journal', 'fs.corruption'],
  arbiter_wall:     ['security.access_denied', 'security.escalation_attempt'],
  the_portal:       ['context.switch', 'syscall.invoked'],
};
