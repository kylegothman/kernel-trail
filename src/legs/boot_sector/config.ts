/**
 * The smallest kernel configuration in the game. Only `process` and
 * `scheduler` are enabled; the syscall table is kernel core, so
 * `syscall.invoked` fires without anything further. Every other field is an
 * inert default that the smoke suite proves is never read.
 */
import type { KernelConfig } from '@kernel/types';
import type { RunState } from '@game/types';

export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'fcfs',
    schedulerParams: {
      quantum: 8,
      agingInterval: 0,
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: false,
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
    journalingEnabled: false,
    deadlockStrategy: 'ignore',
    thrashingThreshold: 200,
    enabledSubsystems: ['process', 'scheduler'],
  };
}
