/**
 * KERNEL TRAIL: Quantum Pass, the player verbs. Package "Interactions",
 * operator costs. The ledge-control verbs are declared here so the world can
 * expose them; the change itself travels as a `set_scheduler` command on the
 * bus (scope correction 17.3: an interaction handler mutates RunState only),
 * so the companion handlers in content.ts only keep the decision log honest.
 */
import type { InteractionDef } from '@game/types';

export const ANCHORS = {
  pass: 'anchor.pass',
  ledge: 'anchor.ledge',
  ledgeControl: 'anchor.ledge_control',
  quantumDrum: 'anchor.quantum_drum',
  ganttWall: 'anchor.gantt_wall',
  estimateDepot: 'anchor.estimate_depot',
  depot: 'anchor.depot',
} as const;

export const INTERACTION_IDS = {
  setPolicy: 'pass.set_policy',
  setQuantum: 'pass.set_quantum',
  setAging: 'pass.set_aging',
  setLevels: 'pass.set_levels',
  buyEstimates: 'pass.buy_estimates',
  readGantt: 'pass.read_gantt',
  readWaitCounters: 'pass.read_wait_counters',
} as const;

export const interactions: readonly InteractionDef[] = [
  {
    id: INTERACTION_IDS.setPolicy,
    label: 'Set scheduling policy',
    description: 'Change the policy on the running system. All seven are available and none of them is free.',
    anchor: ANCHORS.ledgeControl,
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: INTERACTION_IDS.setQuantum,
    label: 'Set the quantum',
    description: 'Ticks each ready process gets in turn. There is a floor and a ceiling and both hurt.',
    anchor: ANCHORS.ledgeControl,
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: INTERACTION_IDS.setAging,
    label: 'Set the aging interval',
    description: 'Ticks a ready process waits before gaining a priority level. Zero disables it.',
    anchor: ANCHORS.ledgeControl,
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: INTERACTION_IDS.setLevels,
    label: 'Set the level quanta',
    description: 'One quantum per multilevel feedback queue level, highest priority first.',
    anchor: ANCHORS.ledgeControl,
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: INTERACTION_IDS.buyEstimates,
    label: 'Buy burst estimates',
    description: 'Predicted burst lengths from exponential averaging over previous bursts. They are predictions.',
    anchor: ANCHORS.estimateDepot,
    cost: { cycles: 30, bandwidth: 4 },
    enabledWhen: (run) => run.resources.cycles >= 30 && run.resources.bandwidth >= 4,
  },
  {
    id: INTERACTION_IDS.readGantt,
    label: 'Read the ribbon',
    description: 'Lock to the Gantt wall. Gaps are switches and idle, drawn to scale.',
    anchor: ANCHORS.ganttWall,
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: INTERACTION_IDS.readWaitCounters,
    label: 'Read the wait counters',
    description: 'How long each ready Program has been ready without running.',
    anchor: ANCHORS.pass,
    cost: {},
    enabledWhen: () => true,
  },
];
