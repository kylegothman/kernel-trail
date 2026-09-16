/**
 * KERNEL TRAIL: Quantum Pass, the stage as data (scope correction section 2).
 *
 * The package's anchor table becomes a `LegLayout`: every interaction anchor
 * is present, every other anchor is listed in `extras`, and the camera targets
 * are the locks the package names. The switchback tiers, the quantum drum and
 * the Gantt ribbon have no registered factory, so they are `custom` structures
 * the render track supplies by name. `createStage` is `layoutStage` over this.
 */
import type { LegStage, StageContext } from '@game/types';
import { layoutStage, type LegLayout } from '@legs/layout';
import { ANCHORS } from './interactions';
import { ROSTER } from './segments';

export const TIER_ANCHORS: readonly string[] = ['anchor.tier.0', 'anchor.tier.1', 'anchor.tier.2'];
export const CONVOY_ANCHORS: readonly string[] = ROSTER.map((entry) => `anchor.convoy.${entry.member}`);
export const WAIT_COUNTER_ANCHORS: readonly string[] = ROSTER.map((entry) => `anchor.wait_counter.${entry.member}`);

const TIER_HEIGHT = 3;

export const layout: LegLayout = {
  anchors: [
    { id: ANCHORS.pass, kind: 'grid_floor', position: [0, 0, 0], label: 'Quantum Pass' },
    { id: ANCHORS.ledge, kind: 'beam', position: [0, 0, -12], facing: [0, 0, 1], label: 'The ledge' },
    { id: ANCHORS.ledgeControl, kind: 'slab', position: [6, 1, -10], facing: [-1, 0, 0], label: 'Ledge control' },
    { id: ANCHORS.quantumDrum, kind: 'custom', structure: 'QuantumDrum', position: [-6, 1, -10], facing: [1, 0, 0], label: 'Quantum drum' },
    { id: ANCHORS.ganttWall, kind: 'custom', structure: 'GanttRibbon', position: [0, 2, -16], facing: [0, 0, 1], label: 'Gantt wall' },
    ...TIER_ANCHORS.map((id, level) => ({ id, kind: 'ready_queue_procession' as const, position: [0, (2 - level) * TIER_HEIGHT, -4 + level * 4] as const, facing: [0, 0, 1] as const, label: `Tier ${level}` })),
    ...ROSTER.map((entry, index) => ({ id: `anchor.convoy.${entry.member}`, kind: 'stele' as const, position: [-8 + index * 4, 0, 6] as const, facing: [0, 0, -1] as const, label: entry.name })),
    ...ROSTER.map((entry, index) => ({ id: `anchor.wait_counter.${entry.member}`, kind: 'custom' as const, structure: 'WaitCounter', position: [-8 + index * 4, 3, 6] as const, label: `${entry.name} wait` })),
    { id: ANCHORS.estimateDepot, kind: 'slab', position: [10, 0, 2], facing: [-1, 0, 0], label: 'Burst estimate depot' },
    { id: ANCHORS.depot, kind: 'slab', position: [12, 0, 8], facing: [-1, 0, 0], label: 'Depot' },
  ],
  cameraTargets: [ANCHORS.pass, ANCHORS.ledge, ANCHORS.ledgeControl, ANCHORS.quantumDrum, ANCHORS.ganttWall, ...TIER_ANCHORS, ANCHORS.estimateDepot, ANCHORS.depot, ...CONVOY_ANCHORS],
  extras: [ANCHORS.ledge, ANCHORS.quantumDrum, ANCHORS.depot, ...TIER_ANCHORS, ...CONVOY_ANCHORS, ...WAIT_COUNTER_ANCHORS],
};

export function createStage(_ctx: StageContext): LegStage {
  return layoutStage(layout);
}
