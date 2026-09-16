/**
 * KERNEL TRAIL, the Narrows: the kernel this leg asks for.
 *
 * Round robin because preemption is what makes the interleaving happen at all:
 * under a non-preemptive policy the read-modify-write on the ledger post is
 * never split and the leg teaches nothing. Aging is off because the priority
 * inversion needs strict priority numbers to invert.
 *
 * `enabledSubsystems` is process, scheduler and sync. `deadlock` stays off: a
 * two-node cycle here blocks silently and drains the travel meter, because the
 * Cistern deadlocks the player and the Gridlock names it, and taking that
 * sequence early breaks two legs. `memory` stays off because page tables in
 * the Narrows belong to the Allocation Yards. Every other field below is inert
 * and the smoke test's poison run proves it.
 */
import type { KernelConfig } from '@kernel/types';
import type { RunState } from '@game/types';
import { PACE_TABLE } from '@game/travel/paceRations';

/** `LegRunner.enter` overwrites this with the pace quantum at entry; this is the same value. */
export function quantumForPace(run: RunState): number {
  return PACE_TABLE[run.policy.pace].quantum;
}

export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',
    schedulerParams: {
      quantum: quantumForPace(run),
      agingInterval: 0,
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: 64,
    pageSize: 4096,
    replacementPolicy: 'lru',
    allocationStrategy: 'first_fit',
    tlbEntries: 16,
    diskPolicy: 'look',
    totalCylinders: 200,
    raidLevel: null,
    fileAllocation: 'indexed',
    // Load bearing rather than inert-adjacent: a race here leaves a corrupted
    // manifest the Archive cannot replay, because there is no journal yet.
    journalingEnabled: false,
    deadlockStrategy: 'ignore',
    thrashingThreshold: 200,
    enabledSubsystems: ['process', 'scheduler', 'sync'],
  };
}
