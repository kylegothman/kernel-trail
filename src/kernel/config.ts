import { KernelConfigError } from './errors';
import type { KernelConfig, SchedulerId, SubsystemId } from './types';
import type { ThreadModel } from './process/threads';

export interface KernelTuning {
  readonly maxProcesses: number;
  readonly maxThreadsPerProcess: number;
  readonly threadCreateTicks: number;
  readonly cowCopyTicks: number;
  readonly tlbHitTicks: number;
  readonly tlbMissTicks: number;
  readonly minorFaultTicks: number;
  readonly majorFaultTicks: number;
  readonly workingSetWindow: number;
  readonly faultRateWindow: number;
  readonly lfuAging: number;
  readonly localitySize: number;
  readonly localityShiftChance: number;
  readonly writeRatio: number;
  readonly thrashingCriticalFaultMultiplier: number;
  readonly thrashingCriticalDemandRatio: number;
  readonly thrashingSuspendInterval: number;
  readonly thrashingSuspendDuration: number;
  readonly thrashingRecoveryTicks: number;
  readonly thrashingControl: 'working_set' | 'pff';
  readonly pffUpperBound: number;
  readonly pffLowerBound: number;
  readonly mlfqAccounting: 'per_slice' | 'cumulative';
  readonly contextSwitchTicks: number;
  readonly deadlockDetectionInterval: number;
  readonly threadModel: ThreadModel;
  readonly coreCount: number;
  readonly lwpPoolSize: number;
  readonly defaultSerialFraction: number;
  readonly degreeOfMultiprogramming: number;
  readonly checkInvariants: boolean;
}

export const DEFAULT_TUNING: KernelTuning = Object.freeze({
  maxProcesses: 64, maxThreadsPerProcess: 16, threadCreateTicks: 2, cowCopyTicks: 1,
  tlbHitTicks: 1, tlbMissTicks: 2,
  minorFaultTicks: 1, majorFaultTicks: 20, workingSetWindow: 10,
  // PFF has a 1000-tick sliding window; the global rate remains the shift EWMA.
  faultRateWindow: 1000, lfuAging: 0, localitySize: 4, localityShiftChance: 0.02, writeRatio: 0.3,
  thrashingCriticalFaultMultiplier: 2, thrashingCriticalDemandRatio: 1.5,
  // The minimum suspension matches the default recovery observation period.
  thrashingSuspendInterval: 50, thrashingSuspendDuration: 100, thrashingRecoveryTicks: 100,
  thrashingControl: 'working_set', pffUpperBound: 300, pffLowerBound: 50,
  mlfqAccounting: 'per_slice',
  contextSwitchTicks: 0, deadlockDetectionInterval: 20, threadModel: 'one_to_one',
  coreCount: 4, lwpPoolSize: 4, defaultSerialFraction: 0.25,
  degreeOfMultiprogramming: 8, checkInvariants: true,
});

const SCHEDULERS: readonly SchedulerId[] = ['fcfs', 'sjf', 'srtf', 'priority', 'priority_aging', 'rr', 'mlfq'];
const SUBSYSTEMS: readonly SubsystemId[] = ['process', 'scheduler', 'memory', 'vm', 'sync', 'deadlock', 'storage', 'io', 'fs', 'security'];

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new KernelConfigError(`${name} must be an integer >= ${minimum}`);
}

export function validateConfig(config: KernelConfig): void {
  integer('seed', config.seed, -Number.MAX_SAFE_INTEGER);
  integer('totalFrames', config.totalFrames, 1);
  if (!Number.isFinite(config.thrashingThreshold) || config.thrashingThreshold <= 0) throw new KernelConfigError('thrashingThreshold must be positive and finite');
  integer('pageSize', config.pageSize, 1);
  if (!Number.isInteger(Math.log2(config.pageSize))) throw new KernelConfigError('pageSize must be a power of two');
  integer('tlbEntries', config.tlbEntries, 0);
  integer('totalCylinders', config.totalCylinders, 1);
  integer('quantum', config.schedulerParams.quantum, 1);
  if (!SCHEDULERS.includes(config.scheduler)) throw new KernelConfigError(`unknown scheduler ${config.scheduler}`);
  for (const subsystem of config.enabledSubsystems) {
    if (!SUBSYSTEMS.includes(subsystem)) throw new KernelConfigError(`unknown subsystem ${subsystem}`);
  }
}

export function resolveTuning(overrides: Partial<KernelTuning> = {}): KernelTuning {
  const tuning: KernelTuning = {
    ...DEFAULT_TUNING, ...overrides,
    lwpPoolSize: overrides.lwpPoolSize ?? overrides.coreCount ?? DEFAULT_TUNING.lwpPoolSize,
  };
  integer('maxProcesses', tuning.maxProcesses, 1);
  integer('maxThreadsPerProcess', tuning.maxThreadsPerProcess, 1);
  integer('threadCreateTicks', tuning.threadCreateTicks, 0);
  integer('cowCopyTicks', tuning.cowCopyTicks, 0);
  integer('tlbHitTicks', tuning.tlbHitTicks, 1);
  integer('tlbMissTicks', tuning.tlbMissTicks, 1);
  integer('minorFaultTicks', tuning.minorFaultTicks, 1);
  integer('majorFaultTicks', tuning.majorFaultTicks, 1);
  integer('workingSetWindow', tuning.workingSetWindow, 1);
  integer('faultRateWindow', tuning.faultRateWindow, 1);
  integer('lfuAging', tuning.lfuAging, 0);
  integer('localitySize', tuning.localitySize, 1);
  integer('thrashingSuspendInterval', tuning.thrashingSuspendInterval, 1);
  integer('thrashingSuspendDuration', tuning.thrashingSuspendDuration, 1);
  integer('thrashingRecoveryTicks', tuning.thrashingRecoveryTicks, 1);
  for (const key of ['localityShiftChance', 'writeRatio'] as const) {
    if (!Number.isFinite(tuning[key]) || tuning[key] < 0 || tuning[key] > 1) throw new KernelConfigError(`${key} must be in [0, 1]`);
  }
  for (const key of ['thrashingCriticalFaultMultiplier', 'thrashingCriticalDemandRatio'] as const) {
    if (!Number.isFinite(tuning[key]) || tuning[key] <= 1) throw new KernelConfigError(`${key} must be finite and > 1`);
  }
  if (!['working_set', 'pff'].includes(tuning.thrashingControl)) throw new KernelConfigError('invalid thrashing control');
  if (!Number.isFinite(tuning.pffLowerBound) || !Number.isFinite(tuning.pffUpperBound)
    || tuning.pffLowerBound < 0 || tuning.pffUpperBound <= tuning.pffLowerBound) throw new KernelConfigError('invalid PFF bounds');
  if (!['per_slice', 'cumulative'].includes(tuning.mlfqAccounting)) throw new KernelConfigError('invalid MLFQ accounting mode');
  integer('contextSwitchTicks', tuning.contextSwitchTicks, 0);
  if (tuning.contextSwitchTicks > 2) throw new KernelConfigError('contextSwitchTicks must be <= 2');
  integer('deadlockDetectionInterval', tuning.deadlockDetectionInterval, 1);
  integer('coreCount', tuning.coreCount, 1);
  integer('lwpPoolSize', tuning.lwpPoolSize, 1);
  integer('degreeOfMultiprogramming', tuning.degreeOfMultiprogramming, 1);
  if (!['many_to_one', 'one_to_one', 'many_to_many'].includes(tuning.threadModel)) throw new KernelConfigError('invalid thread model');
  if (!(tuning.defaultSerialFraction >= 0 && tuning.defaultSerialFraction <= 1)) throw new KernelConfigError('serial fraction must be in [0, 1]');
  return Object.freeze(tuning);
}
