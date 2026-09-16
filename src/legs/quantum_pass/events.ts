/**
 * KERNEL TRAIL: Quantum Pass, the event table. Narrative bible section 8,
 * leg 3, copied verbatim; weights sum to 100. `quantum.short_job_flood`
 * carries a comment rather than a predicate in the source, and the predicate
 * is implemented here: it gates on the scheduler in force being `sjf` or
 * `srtf`, read from the decision log because the run state carries no
 * scheduler id (the entry policy is `priority`).
 */
import type { RandomEventDef, RunState } from '@game/types';
import { currentScheduler } from './decisions';

export const quantumPassEvents: readonly RandomEventDef[] = [
  {
    id: 'quantum.priority_sweep',
    weight: 14,
    title: 'Priority Sweep',
    narration: 'A maintenance sweep enters the pass at priority 4 and stays for two hundred ticks. Everything the convoy has below it stops being scheduled and stays ready.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'quantum.short_job_flood',
    weight: 12,
    title: 'Short Job Flood',
    narration: 'A stream of two-tick jobs arrives and the shortest-first policy serves every one of them ahead of the convoy. The convoy has the longest burst on the board and always will.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: (run: RunState) => currentScheduler(run) === 'sjf' || currentScheduler(run) === 'srtf',
  },
  {
    id: 'quantum.expiry_storm',
    weight: 13,
    title: 'Expiry Storm',
    narration: 'The quantum expires on the convoy nine times in forty ticks, each time three instructions into useful work. The saving and restoring is charged at full rate.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { cycles: -50 },
    onlyIf: null,
  },
  {
    id: 'quantum.inversion_chapel',
    weight: 12,
    title: 'The Low Holder',
    narration: 'A background process at priority 34 holds the pass gate and is preempted every time it nearly finishes. Everything above it waits on something below it.',
    targets: 'sentinel', inflicts: 'priority_inversion',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'quantum.mlfq_demotion',
    weight: 11,
    title: 'Demoted',
    narration: 'A convoy Program uses its full slice twice and the multilevel queue drops it a level for it. Being busy is indistinguishable from being greedy at this altitude.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -35, bandwidth: -4 },
    onlyIf: null,
  },
  {
    id: 'quantum.aging_beacon',
    weight: 16,
    title: 'Aging Beacon',
    narration: 'An abandoned aging beacon still raises the priority of anything that has waited too long near it. SABLE marks the position and the convoy keeps to that side of the pass.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { cycles: 55 },
    onlyIf: null,
  },
  {
    id: 'quantum.gantt_survey',
    weight: 12,
    title: 'Completed Survey',
    narration: 'A survey marker at the summit records every schedule that has crossed here and what it cost. Average waiting time for the convoy\'s current policy is on the stone.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 40, bandwidth: 6 },
    onlyIf: null,
  },
  {
    id: 'quantum.idle_windfall',
    weight: 10,
    title: 'Idle CPU',
    narration: 'For thirty-one ticks nothing else is runnable and the convoy has the whole processor. It does not happen again.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 70, quota: 20 },
    onlyIf: null,
  },
];
