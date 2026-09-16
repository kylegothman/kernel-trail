/**
 * KERNEL TRAIL, the Narrows: where everything stands.
 *
 * A canyon of black glass with one lit span across it, one entity wide. The
 * layout is data and pulls no renderer; `createStage` is `layoutStage` over it
 * and the boot package walks the same anchors to build the real scene.
 *
 * Four anchors have no registered structure factory and are declared `custom`
 * with the name the registry must supply. The contention readout is a number
 * and never a colour band, so it is its own anchor rather than a property of
 * the turnstile, and the interrupt switch is a structure rather than a label
 * because the wiring reaching one core of four has to be readable before the
 * player uses it.
 */
import type { LegStage, StageContext } from '@game/types';
import { layoutStage, type LayoutAnchor, type LegLayout } from '@legs/layout';

const anchors: readonly LayoutAnchor[] = [
  { id: 'anchor.canyon', kind: 'horizon', position: [0, 0, 0], label: 'The Narrows' },
  { id: 'anchor.plank', kind: 'beam', position: [0, 0, -6], facing: [0, 0, -1], label: 'The plank' },
  { id: 'anchor.ledger_post.near', kind: 'stele', position: [-2, 0, -2], facing: [0, 0, -1], label: 'The near post' },
  { id: 'anchor.ledger_post.far', kind: 'stele', position: [-2, 0, -14], facing: [0, 0, 1], label: 'The far post' },
  { id: 'anchor.turnstile', kind: 'wait_for_ring', position: [0, 0, -1], facing: [0, 0, -1], label: 'The turnstile' },
  { id: 'anchor.contention_readout', kind: 'custom', structure: 'ContentionReadout', position: [1.5, 2, -1], facing: [0, 0, 1], label: 'C' },
  { id: 'anchor.second_ford', kind: 'resource_ring', position: [0, 0, -22], facing: [0, 0, -1], label: 'The second ford' },
  { id: 'anchor.wide_ford', kind: 'custom', structure: 'WideFord', position: [0, 0, -34], facing: [0, 0, -1], label: 'The wide ford' },
  { id: 'anchor.interrupt_switch', kind: 'custom', structure: 'InterruptSwitch', position: [3, 0, -32], facing: [-1, 0, 0], label: 'The interrupt switch' },
  { id: 'anchor.peterson_stone', kind: 'slab', position: [-4, 0, -8], facing: [1, 0, 0], label: 'The two-process stone' },
  { id: 'anchor.inheritance_toggle', kind: 'custom', structure: 'InheritanceToggle', position: [3, 0, -18], facing: [-1, 0, 0], label: 'Priority inheritance' },
  { id: 'anchor.convoy.lumen', kind: 'stele', position: [-6, 0, 2], label: 'LUMEN' },
  { id: 'anchor.convoy.sable', kind: 'stele', position: [-3, 0, 2], label: 'SABLE' },
  { id: 'anchor.convoy.orrery', kind: 'stele', position: [0, 0, 2], label: 'ORRERY' },
  { id: 'anchor.convoy.kestrel', kind: 'stele', position: [3, 0, 2], label: 'KESTREL' },
  { id: 'anchor.convoy.vesper', kind: 'stele', position: [6, 0, 2], label: 'VESPER' },
];

/** Anchors no interaction names: the crossing anchors, the posts, and the convoy stele. */
const extras: readonly string[] = [
  'anchor.canyon', 'anchor.ledger_post.near', 'anchor.ledger_post.far', 'anchor.contention_readout',
  'anchor.second_ford', 'anchor.convoy.lumen', 'anchor.convoy.sable', 'anchor.convoy.orrery',
  'anchor.convoy.kestrel', 'anchor.convoy.vesper',
];

export const layout: LegLayout = {
  anchors,
  // The readout is framed with the turnstile rather than on its own.
  cameraTargets: anchors.map((anchor) => anchor.id).filter((id) => id !== 'anchor.contention_readout'),
  extras,
};

export function createStage(_ctx: StageContext): LegStage {
  return layoutStage(layout);
}
