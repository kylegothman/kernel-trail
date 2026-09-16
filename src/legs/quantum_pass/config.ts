/**
 * KERNEL TRAIL: Quantum Pass, the kernel configuration.
 *
 * The three defaults that carry the leg's teaching: the pass opens under
 * `priority`, non-preemptive, and the priority policy runs with no aging
 * (sim spec 5.5 forces `agingInterval` to 0 inside the `priority` policy
 * whatever the parameters say). A player who never touches the ledge control
 * watches somebody starve.
 *
 * Two numbers differ from the package, for reasons the report records:
 *
 * - `agingInterval` is AGING_INTERVAL rather than 0. The shipped command bus
 *   carries a scheduler id and a quantum and nothing else (WP-19 R3, the sink
 *   adapter refuses `--aging` and `--levels`), so the interval a switch to
 *   `priority_aging` or `mlfq` picks up is the one this configuration holds
 *   for the whole leg. Under `priority` it is inert by construction.
 * - The starvation thresholds are scaled to the leg the runner actually plays:
 *   LEG_SEGMENTS is 70 segments, one segment per tick at steady pace, so the
 *   warning and the death have to land inside seventy ticks.
 *
 * The inert fields carry the package's defaults and the smoke test asserts
 * that poisoning them changes nothing.
 */
import type { KernelConfig, SchedulerParams } from '@kernel/types';
import { PACE_TABLE } from '@game/travel/paceRations';
import type { Pace, RunState } from '@game/types';

/**
 * Ticks a ready Program waits before `process.starving { fatal: false }` fires,
 * and ticks before it derezzes with `TerminationReason: 'starvation'`.
 *
 * The package's 120 and 300 are read at the package's scale, where the convoy
 * carries bursts of 24 and the pass runs 340 ticks. The shipped pass is
 * `LEG_SEGMENTS.quantum_pass` at 70 segments, one segment per tick at steady
 * pace, and the engine charges two ticks of thread creation on top of every
 * process (amendment 2), so a burst of one holds the processor for three. Both
 * thresholds are therefore scaled to this leg at the package's own ratios: the
 * warning at 40 percent of the death, and a warning window of 60 percent of it.
 * The warning also has to sit above the longest wait an ordinary queued Program
 * serves out, or a Program that is merely behind others acquires the starvation
 * affliction and drains for the rest of the leg. That floor is measured, not
 * assumed: see the leg's `starvation.test.ts`.
 */
export const STARVATION_THRESHOLD = 14;
export const STARVATION_FATAL_THRESHOLD = 35;
/** The aging interval a switch to `priority_aging` or `mlfq` inherits; inert under `priority`. */
export const AGING_INTERVAL = 8;
/** Sim spec 5.8's default level quanta; the MLFQ fixture uses the same array. */
export const LEVEL_QUANTA: readonly number[] = [4, 8, 16];
/** Sim spec 5.7: the context switch cost the leg draws to scale and charges to overhead. */
export const SWITCH_COST = 1;

export const ENABLED_SUBSYSTEMS: readonly KernelConfig['enabledSubsystems'][number][] = ['process', 'scheduler'];

/** Narrative bible 6.1: conservative 16, steady 8, aggressive 4, reckless 2. */
export function quantumForPace(pace: Pace): number {
  return PACE_TABLE[pace].quantum;
}

export function entrySchedulerParams(pace: Pace): SchedulerParams {
  return {
    quantum: quantumForPace(pace),
    levelQuanta: [...LEVEL_QUANTA],
    agingInterval: AGING_INTERVAL,
    starvationThreshold: STARVATION_THRESHOLD,
    starvationFatalThreshold: STARVATION_FATAL_THRESHOLD,
    preemptive: false,
  };
}

export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'priority',
    schedulerParams: entrySchedulerParams(run.policy.pace),
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
    enabledSubsystems: [...ENABLED_SUBSYSTEMS],
  };
}
