/**
 * KERNEL TRAIL: Quantum Pass, the seven learning objectives. Curriculum map,
 * leg 3, transcribed verbatim; the assessment rules live in evaluate.ts.
 */
import type { LearningObjective } from '@game/types';
import { cite } from './chapters';

export const OBJECTIVE_IDS = {
  waitingTimeTarget: 'obj.quantum_pass.waiting_time_target',
  sjfIsOptimal: 'obj.quantum_pass.sjf_is_optimal',
  quantumSizing: 'obj.quantum_pass.quantum_sizing',
  clearStarvation: 'obj.quantum_pass.clear_starvation',
  avoidConvoyEffect: 'obj.quantum_pass.avoid_convoy_effect',
  tuneMlfq: 'obj.quantum_pass.tune_mlfq',
  switchRate: 'obj.quantum_pass.switch_rate',
} as const;

export const objectives: readonly LearningObjective[] = [
  {
    id: OBJECTIVE_IDS.waitingTimeTarget,
    statement: 'Brings average waiting time across the pass below 12 ticks with zero process.starving events marked fatal.',
    chapter: cite('5.2'),
    assessedBy: 'outcome',
  },
  {
    id: OBJECTIVE_IDS.sjfIsOptimal,
    statement: 'Runs the same arrival set under at least three non-preemptive policies with gantt --replay and identifies shortest-job-first as the one with the lowest average waiting time, recording the margin.',
    chapter: cite('5.3.2', '5.8.2'),
    assessedBy: 'terminal_command',
  },
  {
    id: OBJECTIVE_IDS.quantumSizing,
    statement: 'Sets a round-robin quantum between 1.2 and 4 times the median burst, holding context switch overhead under 10 percent of total CPU while average response time stays under 8 ticks.',
    chapter: cite('5.3.3'),
    assessedBy: 'decision',
  },
  {
    id: OBJECTIVE_IDS.clearStarvation,
    statement: 'Clears an active starvation affliction within 20 ticks of the first warning, by switching to priority_aging or by raising the starved Program priority with nice.',
    chapter: cite('5.3.4'),
    assessedBy: 'survival',
  },
  {
    id: OBJECTIVE_IDS.avoidConvoyEffect,
    statement: 'Declines first-come-first-served on the segment where one long CPU-bound Program arrives ahead of four short ones, finishing at least 30 percent below the recorded FCFS waiting-time baseline.',
    chapter: cite('5.3.1'),
    assessedBy: 'decision',
  },
  {
    id: OBJECTIVE_IDS.tuneMlfq,
    statement: 'Configures multilevel feedback queue level quanta so the two interactive Programs remain at level 0 and the CPU-bound Program descends at least two levels, with no Program left below its aging interval at the end of the segment.',
    chapter: cite('5.3.5', '5.3.6'),
    assessedBy: 'outcome',
  },
  {
    id: OBJECTIVE_IDS.switchRate,
    statement: 'Holds context switches under one per six ticks of simulated CPU while running a preemptive policy.',
    chapter: cite('5.1.3', '5.3.3'),
    assessedBy: 'outcome',
  },
];
