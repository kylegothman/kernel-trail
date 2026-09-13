import type { KernelConfig } from '@kernel/types';
import type { KernelImpl, SpawnOptions } from '@kernel/Kernel';
import type { ProgramSpec } from '@kernel/process/Program';

export const REFERENCE_CONFIG: KernelConfig = {
  seed: 0x4b54524c,
  scheduler: 'fcfs',
  schedulerParams: {
    quantum: 4, levelQuanta: [4, 8, 16], agingInterval: 50,
    starvationThreshold: 120, starvationFatalThreshold: 300, preemptive: true,
  },
  totalFrames: 64, pageSize: 4096, replacementPolicy: 'lru',
  allocationStrategy: 'first_fit', tlbEntries: 16, diskPolicy: 'look',
  totalCylinders: 200, raidLevel: 5, fileAllocation: 'indexed',
  journalingEnabled: true, deadlockStrategy: 'detect', thrashingThreshold: 200,
  enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'sync', 'deadlock', 'storage', 'io', 'fs', 'security'],
};

export const spawn = (kernel: KernelImpl, spec: ProgramSpec, options?: SpawnOptions) => kernel.spawn(spec, options);
