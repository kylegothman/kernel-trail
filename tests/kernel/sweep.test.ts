/**
 * WP-11 fixture INV-ALL-2: every scheduler times every replacement policy times
 * every disk policy, each run for SWEEP_TICKS under the reference workload with
 * the harness on, zero violations; and each combination run twice hashes the same.
 * Budgeted on its own (pre-flight D10); the wall time is printed for the report.
 */
import { describe, expect, it } from 'vitest';
import type { DiskSchedulingId, KernelConfig, PageReplacementId, SchedulerId } from '@kernel/types';
import { REFERENCE_CONFIG } from './fixtures/referenceConfig';
import { referenceWorkload } from './fixtures/workloads';
import { canonical, hash } from './canonical';

const SCHEDULERS: readonly SchedulerId[] = ['fcfs', 'sjf', 'srtf', 'priority', 'priority_aging', 'rr', 'mlfq'];
const REPLACEMENTS: readonly PageReplacementId[] = ['fifo', 'lru', 'clock', 'optimal', 'lfu', 'random'];
const DISKS: readonly DiskSchedulingId[] = ['fcfs', 'sstf', 'scan', 'cscan', 'look', 'clook'];
/**
 * The fixture says 2000. At 2000 the 504 runs took 103 s on the authoring machine, and the
 * CI runner is assumed at least twice as slow, which crosses the 120 s line pre-flight
 * decision D10 set, so the tick count is halved as that decision directs. The 2000-tick
 * sweep was run once and passed; the report records both timings.
 */
const SWEEP_TICKS = 1000;

/**
 * The reference configuration with the three policies substituted. Fatal starvation
 * is switched off because the shared region's owner must outlive every run: under
 * SJF and SRTF the long-lived owner is served last and would be killed, and an
 * owner exiting with live attachers is the hazard WP-11 reports rather than fixes.
 */
function combination(scheduler: SchedulerId, replacementPolicy: PageReplacementId, diskPolicy: DiskSchedulingId): KernelConfig {
  return { ...REFERENCE_CONFIG, scheduler, replacementPolicy, diskPolicy, schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, starvationFatalThreshold: 1_000_000 } };
}

describe('INV-ALL-2', () => {
  it(`runs all 252 combinations for ${SWEEP_TICKS} ticks with zero violations, each twice with identical hashes`, () => {
    const started = performance.now();
    let combinations = 0;
    for (const scheduler of SCHEDULERS) for (const replacement of REPLACEMENTS) for (const disk of DISKS) {
      const config = combination(scheduler, replacement, disk);
      const run = (): string => {
        const { kernel } = referenceWorkload(config, { devBuild: true }, 50, SWEEP_TICKS * 3);
        const log = kernel.run(SWEEP_TICKS);
        return hash(canonical([log, kernel.snapshot()]));
      };
      const first = run();
      expect(run(), `${scheduler}/${replacement}/${disk}`).toBe(first);
      combinations += 1;
    }
    const seconds = (performance.now() - started) / 1000;
    console.log(`INV-ALL-2: ${combinations} combinations, ${SWEEP_TICKS} ticks each, run twice: ${seconds.toFixed(1)} s`);
    expect(combinations).toBe(252);
  }, 600_000);
});
