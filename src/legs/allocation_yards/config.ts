/**
 * KERNEL TRAIL: the Allocation Yards' kernel configuration.
 *
 * `vm` is not enabled, which is the single most important line here. With it
 * off there is no demand paging, no replacement policy, no eviction and no
 * fault path: every page a Program owns is resident from allocation and
 * `replacementPolicy` is never read. Leg 8 turns `vm` on and the valid bit
 * starts meaning something.
 *
 * `totalFrames` is 21 rather than the package's 96 (pre-flight ruling 1). With
 * `vm` off the kernel admits at most eight processes and hands each the
 * rations floor of three frames, so a frame table any larger than seven times
 * that floor can never refuse an allocation, and `memory.allocation_failed`
 * is one of the three events `REQUIRED_EVENTS` demands of this leg. Twenty one
 * frames is seven berths of three, which is the smallest yard that seats the
 * convoy and its two residents and refuses the eighth arrival.
 */
import { PACE_TABLE } from '@game/travel/paceRations';
import type { KernelConfig } from '@kernel/types';
import type { RunState } from '@game/types';

/** Seven berths of three frames. The eighth arrival is refused. */
export const TOTAL_FRAMES = 21;
/** The entry page size; the player moves it at the dial. */
export const ENTRY_PAGE_SIZE = 4096;
/** Real and load-bearing: `locality_over_hardware` forbids changing it. */
export const TLB_ENTRIES = 16;
/** Frames each admitted process holds, which is the rations floor of sim spec 6.6. */
export const FRAMES_PER_PROCESS = 3;

export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                        // the leg is not about scheduling; rr keeps the yard traffic even
    schedulerParams: {
      quantum: PACE_TABLE[run.policy.pace].quantum,  // Ch. 5.3.3
      agingInterval: 0,                     // nothing here starves; aging would only add noise
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: TOTAL_FRAMES,
    pageSize: ENTRY_PAGE_SIZE,
    replacementPolicy: 'lru',               // INERT: 'vm' is not enabled. Nothing is ever evicted in this leg.
    allocationStrategy: 'first_fit',        // the entry value; the player changes it at the yard office
    tlbEntries: TLB_ENTRIES,
    diskPolicy: 'look',                     // inert: 'storage' is not enabled
    totalCylinders: 200,                    // inert
    raidLevel: null,                        // inert
    fileAllocation: 'indexed',              // inert: 'fs' is not enabled
    journalingEnabled: false,               // inert
    deadlockStrategy: 'ignore',             // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,                // INERT here. Leg 8 makes it real.
    enabledSubsystems: ['process', 'scheduler', 'memory'],
  };
}
