/**
 * KERNEL TRAIL: the shared epitaph stones (WP-21 section 8).
 *
 * The forty-eight stones of narrative bible 9.3, transcribed verbatim, ids as
 * the bible gives them, in the bible's order. They cover every
 * `TerminationReason` with the counts of 9.4. A leg's own stones ride in its
 * `LegContent.epitaphs` and win: `sharedEpitaphSource` serves them alone for
 * a reason any of them names, and these only for a reason none does, because
 * a leg pins exact cause lines and `derezz` draws uniformly from what it is
 * served. `derezz` still filters by `member` and `legId` afterwards, so a leg
 * that pins a stone to one Program ships an unpinned one for the same reason
 * too, or an empty candidate list throws at death.
 *
 * `{NAME}` is substituted at death. A stone with `member` is reserved for that
 * Program and may name it outright; one with `legId` lands only on that leg.
 */
import type { EpitaphCopySource, EpitaphTemplate } from '@game/convoy/derezz';

export const SHARED_EPITAPHS: readonly EpitaphTemplate[] = [
  /* starvation */
  { id: 'ep.starv.always_next', reason: 'starvation',
    inscription: 'HERE LIES {NAME}, SHE WAS ALWAYS NEXT',
    cause: 'Indefinite blocking. Ready the entire time, scheduled never. Higher-priority arrivals kept coming and the policy had no aging term.',
    codexEntry: 'sched.starvation' },
  { id: 'ep.starv.ready_since', reason: 'starvation',
    inscription: 'HERE LIES {NAME}, READY SINCE TUESDAY',
    cause: 'Starvation under strict priority. Nothing was wrong with the process. Nothing was ever going to be.',
    codexEntry: 'sched.starvation' },
  { id: 'ep.starv.took_a_number', reason: 'starvation',
    inscription: 'HERE LIES {NAME}, TOOK A NUMBER',
    cause: 'The wait queue was unordered, so bounded waiting was never guaranteed. Arrival order and service order had nothing to do with each other.',
    codexEntry: 'sync.bounded-wait' },
  { id: 'ep.starv.priority_39', reason: 'starvation',
    inscription: 'HERE LIES {NAME}, PRIORITY 39 OF 40',
    cause: 'Low priority is not a small delay. Under a non-aging policy it is a permanent one.',
    codexEntry: 'sched.priority' },
  { id: 'ep.starv.shortest_last', reason: 'starvation',
    inscription: 'HERE LIES {NAME}, SHORTEST JOB LAST',
    cause: 'Shortest-job-first starves long bursts by construction. The convoy always has the longest burst on the board.',
    codexEntry: 'sched.sjf' },
  { id: 'ep.starv.aging_zero', reason: 'starvation',
    inscription: 'HERE LIES {NAME}, AGING WAS SET TO ZERO',
    cause: 'One parameter. agingInterval at 0 disables the only mechanism that guarantees a waiting process eventually runs.',
    codexEntry: 'sched.aging' },

  /* deadlock_victim */
  { id: 'ep.dead.held_the_door', reason: 'deadlock_victim', member: 'sable',
    inscription: 'HERE LIES SABLE, HELD THE DOOR',
    cause: 'Hold and wait. She acquired the first resource and blocked on the second without releasing the first, and the ring closed behind her.',
    codexEntry: 'deadlock.coffman' },
  { id: 'ep.dead.not_let_go', reason: 'deadlock_victim',
    inscription: 'HERE LIES {NAME}, WOULD NOT LET GO FIRST',
    cause: 'Circular wait. Every process in the cycle was behaving correctly and no correct behaviour opens a cycle.',
    codexEntry: 'deadlock.coffman' },
  { id: 'ep.dead.chosen', reason: 'deadlock_victim',
    inscription: 'HERE LIES {NAME}, CHOSEN BY THE ALGORITHM',
    cause: 'Deadlock recovery selects a victim by accumulated cost. It had no opinion about which process that was.',
    codexEntry: 'deadlock.recovery' },
  { id: 'ep.dead.waiting_on', reason: 'deadlock_victim',
    inscription: 'HERE LIES {NAME}, WAITING ON SOMEONE WHO WAS WAITING ON HER',
    cause: 'A two-node cycle in the wait-for graph. It was visible in wfg for forty ticks before it became fatal.',
    codexEntry: 'deadlock.wfg' },
  { id: 'ep.dead.four_conditions', reason: 'deadlock_victim',
    inscription: 'HERE LIES {NAME}, FOUR CONDITIONS, ALL PRESENT',
    cause: 'Mutual exclusion, hold and wait, no preemption, circular wait. Breaking any one of them would have been enough.',
    codexEntry: 'deadlock.coffman' },

  /* out_of_memory */
  { id: 'ep.oom.one_more_frame', reason: 'out_of_memory',
    inscription: 'HERE LIES {NAME}, ASKED FOR ONE MORE FRAME',
    cause: 'Allocation failed with ENOMEM. The request was legitimate and the free list was empty.',
    codexEntry: 'mem.allocation' },
  { id: 'ep.oom.none_adjacent', reason: 'out_of_memory',
    inscription: 'HERE LIES {NAME}, PLENTY OF ROOM, NONE OF IT ADJACENT',
    cause: 'External fragmentation. Ninety frames free, largest contiguous run seven, request eleven. Buying more memory would have added more holes.',
    codexEntry: 'mem.fragmentation' },
  { id: 'ep.oom.sixty_one', reason: 'out_of_memory',
    inscription: 'HERE LIES {NAME}, SIXTY FREE FRAMES, SIXTY-ONE NEEDED',
    cause: 'Over-subscription. The degree of multiprogramming committed more memory than the frame table contains.',
    codexEntry: 'vm.overcommit' },
  { id: 'ep.oom.small_and_patient', reason: 'out_of_memory',
    inscription: 'HERE LIES {NAME}, THE LEAK WAS SMALL AND PATIENT',
    cause: 'A child process allocated and never released, at 1.5 frames per tick, for four legs. Killing it would have returned every frame at once.',
    codexEntry: 'mem.leak' },
  { id: 'ep.oom.enomem', reason: 'out_of_memory',
    inscription: 'HERE LIES {NAME}, ENOMEM',
    cause: 'The allocator returned an error and the process had no path that handled one. Failure to allocate is a normal outcome and has to be one.',
    codexEntry: 'mem.allocation' },

  /* thrashing_collapse */
  { id: 'ep.thrash.all_disk', reason: 'thrashing_collapse',
    inscription: 'HERE LIES {NAME}, ALL DISK, NO PROGRESS',
    cause: 'Thrashing. Every page she needed had been evicted while she waited for the previous one. Reducing the degree of multiprogramming was the only remedy.',
    codexEntry: 'vm.thrashing' },
  { id: 'ep.thrash.faulted', reason: 'thrashing_collapse',
    inscription: 'HERE LIES {NAME}, FAULTED IN, FAULTED OUT, FAULTED IN',
    cause: 'Working set larger than the resident set. No replacement policy makes eleven pages fit in six frames.',
    codexEntry: 'vm.working-set' },
  { id: 'ep.thrash.ground_left', reason: 'thrashing_collapse', legId: 'drowned_reach',
    inscription: 'HERE LIES {NAME}, THE GROUND KEPT LEAVING',
    cause: 'Eviction rate exceeded fault-in rate for ninety consecutive ticks. The convoy was walking on pages that were being reclaimed behind it.',
    codexEntry: 'vm.thrashing' },
  { id: 'ep.thrash.ninety_eight', reason: 'thrashing_collapse',
    inscription: 'HERE LIES {NAME}, NINETY-EIGHT PERCENT UTILISED, ZERO PERCENT USEFUL',
    cause: 'High CPU utilisation during thrashing is the paging system working perfectly on work that accomplishes nothing.',
    codexEntry: 'vm.thrashing' },
  { id: 'ep.thrash.degree_eleven', reason: 'thrashing_collapse',
    inscription: 'HERE LIES {NAME}, DEGREE OF MULTIPROGRAMMING: ELEVEN',
    cause: 'Throughput rises with the degree of multiprogramming until the knee and falls off a cliff after it. The knee was at six.',
    codexEntry: 'vm.degree' },

  /* protection_fault */
  { id: 'ep.prot.someone_elses_mail', reason: 'protection_fault',
    inscription: 'HERE LIES {NAME}, READ SOMEONE ELSE\'S MAIL',
    cause: 'Access outside the process\'s address space. The page table had no valid entry and the hardware did not care what she intended.',
    codexEntry: 'mem.protection' },
  { id: 'ep.prot.ring_ambitions', reason: 'protection_fault',
    inscription: 'HERE LIES {NAME}, RING THREE, RING ZERO AMBITIONS',
    cause: 'Attempted privilege transition without authorisation. The boundary is checked in hardware on every crossing and it does not negotiate.',
    codexEntry: 'sec.rings' },
  { id: 'ep.prot.dereferenced_nothing', reason: 'protection_fault',
    inscription: 'HERE LIES {NAME}, DEREFERENCED NOTHING',
    cause: 'A read through an invalid pointer. Page zero is unmapped deliberately so that this failure is loud instead of silent.',
    codexEntry: 'mem.protection' },
  { id: 'ep.prot.wrote_to_read', reason: 'protection_fault',
    inscription: 'HERE LIES {NAME}, WROTE TO A PAGE MARKED READ',
    cause: 'Protection bits are per page and are checked on every access. The entry was valid, resident, and read-only.',
    codexEntry: 'mem.protection' },
  { id: 'ep.prot.no_entry', reason: 'protection_fault',
    inscription: 'HERE LIES {NAME}, THE MATRIX HAD NO ENTRY FOR HER',
    cause: 'Access matrix lookup returned nothing for that domain and object pair. Absence of a right is a denial, not a question.',
    codexEntry: 'sec.access-matrix' },

  /* io_timeout */
  { id: 'ep.io.still_polling', reason: 'io_timeout',
    inscription: 'HERE LIES {NAME}, STILL POLLING',
    cause: 'Busy-wait on a status register. Every check was a real cycle and the device was never going to answer.',
    codexEntry: 'io.polling' },
  { id: 'ep.io.said_it_would_call', reason: 'io_timeout',
    inscription: 'HERE LIES {NAME}, THE DEVICE SAID IT WOULD CALL',
    cause: 'Blocked on an interrupt that was never raised. A dropped completion is indistinguishable from a slow device until the timeout fires.',
    codexEntry: 'io.interrupts' },
  { id: 'ep.io.one_per_byte', reason: 'io_timeout',
    inscription: 'HERE LIES {NAME}, ONE INTERRUPT PER BYTE',
    cause: 'Interrupt storm. Handler overhead consumed the processor entirely. Moving the device to DMA would have made it one interrupt per transfer.',
    codexEntry: 'io.dma' },
  { id: 'ep.io.kept_reordering', reason: 'io_timeout',
    inscription: 'HERE LIES {NAME}, LAST IN A QUEUE THAT KEPT REORDERING',
    cause: 'Seek starvation under shortest-seek-first. The arm stayed where the requests were dense and never came out to the edge.',
    codexEntry: 'storage.scheduling' },
  { id: 'ep.io.seek_pattern', reason: 'io_timeout',
    inscription: 'HERE LIES {NAME}, SEEK 0, SEEK 199, SEEK 1, SEEK 198',
    cause: 'First-come-first-served disk scheduling. Total head travel exceeded useful transfer by a factor of thirty and every seek was correct.',
    codexEntry: 'storage.scheduling' },

  /* storage_corruption */
  { id: 'ep.corrupt.never_the_commit', reason: 'storage_corruption',
    inscription: 'HERE LIES {NAME}, WROTE THE DATA, NEVER THE COMMIT',
    cause: 'An unjournaled update interrupted between the data write and the metadata write. Neither state is the one the file system believed in.',
    codexEntry: 'fs.journaling' },
  { id: 'ep.corrupt.block_disagrees', reason: 'storage_corruption',
    inscription: 'HERE LIES {NAME}, BLOCK 4471 DISAGREES',
    cause: 'Silent data corruption. The read succeeded, the checksum agreed with the corrupted value, and nothing reported a failure.',
    codexEntry: 'storage.bit-rot' },
  { id: 'ep.corrupt.half_directory', reason: 'storage_corruption',
    inscription: 'HERE LIES {NAME}, HALF A DIRECTORY',
    cause: 'The directory entry was removed and the inode link count was not decremented. Consistency checking found it and could not decide which half was true.',
    codexEntry: 'fs.consistency' },
  { id: 'ep.corrupt.parity_same_disk', reason: 'storage_corruption',
    inscription: 'HERE LIES {NAME}, PARITY WAS ON THE SAME DISK',
    cause: 'Redundancy that shares a failure domain is not redundancy. The array survived exactly as long as its worst member.',
    codexEntry: 'storage.raid' },
  { id: 'ep.corrupt.no_codec', reason: 'storage_corruption',
    inscription: 'HERE LIES {NAME}, THE JOURNAL WAS THERE, NOBODY COULD READ IT',
    cause: 'Corruption is recoverable while ORRERY lives. After that the record survives and the ability to replay it does not.',
    codexEntry: 'fs.journaling' },

  /* normal_exit */
  { id: 'ep.exit.nobody_called_wait', reason: 'normal_exit',
    inscription: 'HERE LIES {NAME}, EXIT CODE ZERO, NOBODY CALLED WAIT',
    cause: 'Terminated successfully and became a zombie. The process table entry and its quota stayed allocated until something read the exit status.',
    codexEntry: 'proc.orphan-zombie' },
  { id: 'ep.exit.finished_then_stayed', reason: 'normal_exit',
    inscription: 'HERE LIES {NAME}, FINISHED, THEN STAYED',
    cause: 'Exit is not release. A terminated process holds its PCB until its parent reaps it, and a parent that never calls wait never will.',
    codexEntry: 'proc.orphan-zombie' },
  { id: 'ep.exit.pending_paperwork', reason: 'normal_exit',
    inscription: 'HERE LIES {NAME}, DONE, PENDING PAPERWORK',
    cause: 'Reaped forty ticks after termination by PID 1 at leg boundary. Everything it was holding was unavailable for those forty ticks.',
    codexEntry: 'proc.reaping' },
  { id: 'ep.exit.not_collected', reason: 'normal_exit',
    inscription: 'HERE LIES {NAME}, RETURNED SUCCESSFULLY, WAS NOT COLLECTED',
    cause: 'The work completed. The accounting did not. Both are the operating system\'s responsibility and only one of them was discharged.',
    codexEntry: 'proc.reaping' },

  /* killed_by_user */
  { id: 'ep.user.you_did_this', reason: 'killed_by_user',
    inscription: 'HERE LIES {NAME}, YOU DID THIS',
    cause: 'Terminated by an explicit kill from the terminal. The signal was delivered, the process had no handler for it, and the kernel did the rest.',
    codexEntry: 'proc.signals' },
  { id: 'ep.user.no_last_words', reason: 'killed_by_user',
    inscription: 'HERE LIES {NAME}, KILL -9, NO LAST WORDS',
    cause: 'SIGKILL cannot be caught, blocked or handled. Nothing the process had open was flushed and nothing it was holding was released cleanly.',
    codexEntry: 'proc.signals' },
  { id: 'ep.user.typed_confidently', reason: 'killed_by_user',
    inscription: 'HERE LIES {NAME}, TYPED CONFIDENTLY',
    cause: 'The livelock would have cleared with a randomised backoff on either participant, at a cost of two bandwidth.',
    codexEntry: 'sync.livelock' },
  { id: 'ep.user.other_pid', reason: 'killed_by_user',
    inscription: 'HERE LIES {NAME}, YOU MEANT THE OTHER PID',
    cause: 'Process identifiers are reused. Running ps before kill is procedure rather than caution.',
    codexEntry: 'proc.pid' },

  /* killed_by_parent */
  { id: 'ep.parent.exited_first', reason: 'killed_by_parent',
    inscription: 'HERE LIES {NAME}, THE PARENT EXITED FIRST',
    cause: 'Cascading termination. Under this policy a parent\'s exit takes its entire subtree with it, whatever the children were doing.',
    codexEntry: 'proc.termination' },
  { id: 'ep.parent.family_matter', reason: 'killed_by_parent',
    inscription: 'HERE LIES {NAME}, SIGKILL, FAMILY MATTER',
    cause: 'A parent may terminate a child that has exceeded its resource allocation. It does not require the child\'s cooperation.',
    codexEntry: 'proc.termination' },
  { id: 'ep.parent.adopted_then_not', reason: 'killed_by_parent',
    inscription: 'HERE LIES {NAME}, ADOPTED, THEN NOT',
    cause: 'Reparented to PID 1 after being orphaned, then terminated in a group cleanup it had been placed into without being asked.',
    codexEntry: 'proc.orphan-zombie' },
  { id: 'ep.parent.group_went_down', reason: 'killed_by_parent',
    inscription: 'HERE LIES {NAME}, THE GROUP WENT DOWN TOGETHER',
    cause: 'The signal was addressed to a process group. Membership was inherited at fork and nothing since had changed it.',
    codexEntry: 'proc.signals' },
];

/** A leg's own stones alone for a reason any of them names, else the shared stones for it (WP-21 pre-flight ruling 3). */
export function sharedEpitaphSource(extra: readonly EpitaphTemplate[]): EpitaphCopySource {
  return {
    templates: (reason) => {
      const own = extra.filter((template) => template.reason === reason);
      return own.length > 0 ? own : SHARED_EPITAPHS.filter((template) => template.reason === reason);
    },
  };
}
