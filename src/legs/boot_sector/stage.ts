/**
 * The stage as data (scope correction section 2): every anchor the package's
 * table names, its structure kind and its place on the 4.00 m module. The
 * boot package builds the scene from this layout; `createStage` is
 * `layoutStage` over it and pulls no renderer.
 */
import type { StageContext } from '@game/types';
import { layoutStage, type LayoutAnchor, type LegLayout } from '../layout';
import { ANCHORS } from './interactions';
import { MODULE_METRES } from './onboarding';
import { ROSTER } from './populate';
import { WINDOWS } from './windows';

const M = MODULE_METRES;

/** The five stele on the beat 1 ring of light, one module in radius, in roster order around it. */
function steleAnchors(): readonly LayoutAnchor[] {
  return ROSTER.map(({ member, name }, i) => {
    const angle = (2 * Math.PI * i) / ROSTER.length;
    return { id: `anchor.convoy.${member}`, kind: 'stele', position: [M * Math.sin(angle), 0, M * Math.cos(angle)], facing: [0, 0, 1], label: name };
  });
}

/** Six windows in a row across the depot face, one module apart. */
function windowAnchors(): readonly LayoutAnchor[] {
  return WINDOWS.map((def, i) => ({ id: def.anchor, kind: 'slab', position: [M * (i - (WINDOWS.length - 1) / 2), 0, -4 * M], facing: [0, 0, 1], label: def.service }));
}

export const anchors: readonly LayoutAnchor[] = [
  { id: ANCHORS.plate, kind: 'grid_floor', position: [0, 0, 0], label: 'The plate' },
  { id: ANCHORS.cpuPillar, kind: 'custom', structure: 'CpuPillar', position: [-2 * M, 0, -2 * M], facing: [0, 0, 1], label: 'CPU' },
  { id: ANCHORS.depot, kind: 'custom', structure: 'RequisitionHousing', position: [0, 0, -4 * M], facing: [0, 0, 1], label: 'Requisition' },
  ...windowAnchors(),
  { id: ANCHORS.blockStack, kind: 'slab', position: [M, 0, -M], label: 'blocks' },
  { id: ANCHORS.discPlinth, kind: 'custom', structure: 'DiscPlinth', position: [2 * M, 0, -2 * M], facing: [0, 0, 1], label: 'Disc class' },
  ...steleAnchors(),
  { id: ANCHORS.ringStack, kind: 'resource_ring', position: [0, M, 0], label: 'Boot rings' },
];

const INTERACTION_ANCHORS: ReadonlySet<string> = new Set([ANCHORS.plate, ANCHORS.cpuPillar, ANCHORS.depot, ANCHORS.blockStack, ANCHORS.discPlinth]);

export const layout: LegLayout = {
  anchors,
  /** Head-on locks: the pillar, the depot, each window, the plinth and each stele. The plate, the stack and the rings are orbit only. */
  cameraTargets: [ANCHORS.cpuPillar, ANCHORS.depot, ...WINDOWS.map((def) => def.anchor), ANCHORS.discPlinth, ...ROSTER.map(({ member }) => `anchor.convoy.${member}`)],
  extras: anchors.map((anchor) => anchor.id).filter((id) => !INTERACTION_ANCHORS.has(id)),
};

export function createStage(_ctx: StageContext): ReturnType<typeof layoutStage> {
  return layoutStage(layout);
}
