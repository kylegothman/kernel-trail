/**
 * KERNEL TRAIL: the Allocation Yards' layout.
 *
 * A leg declares kinds and positions and never implements a structure (scope
 * correction section 15). The yard runs along z: the gantry looks down the
 * bays, the instruments stand on the east side, and the fragmentation meters
 * are one anchor holding two physically adjacent faces, because the second
 * misconception needs both needles inside a single orthographic lock and two
 * separate anchors could not promise that.
 */
import type { LayoutAnchor, LegLayout } from '@legs/layout';
import { CONVOY } from './populate';

/** Seven berths of three frames, which is exactly what the frame table seats. */
export const BAY_COUNT = 7;
export const BAY_SPACING = 6;

const bays: readonly LayoutAnchor[] = Array.from({ length: BAY_COUNT }, (_, index): LayoutAnchor => ({
  id: `anchor.bay.${index + 1}`,
  kind: 'slab',
  position: [-9, 0, -18 + index * BAY_SPACING],
  facing: [1, 0, 0],
  label: `Bay ${index + 1}`,
}));

const stele: readonly LayoutAnchor[] = CONVOY.map((spawn, index): LayoutAnchor => ({
  id: `anchor.convoy.${spawn.member}`,
  kind: 'stele',
  position: [-16, 0, -12 + index * 6],
  facing: [1, 0, 0],
  label: spawn.name,
}));

const anchors: readonly LayoutAnchor[] = [
  { id: 'anchor.yard', kind: 'frame_vault', position: [0, 0, 0], label: 'The yard from the gantry' },
  ...bays,
  { id: 'anchor.yard_office', kind: 'stele', position: [10, 0, -20], facing: [-1, 0, 0], label: 'The yard office' },
  // One anchor, two faces, side by side. External on the left, internal on the right.
  { id: 'anchor.frag_meters', kind: 'custom', structure: 'FragmentationMeters', position: [10, 2, -14], facing: [-1, 0, 0], label: 'External and internal, side by side' },
  { id: 'anchor.request_bar', kind: 'beam', position: [0, 6, 0], label: 'The refused request' },
  { id: 'anchor.paging_gate', kind: 'beam', position: [10, 0, -8], facing: [-1, 0, 0], label: 'The paging gate' },
  { id: 'anchor.index_board', kind: 'page_plate', position: [10, 0, -2], facing: [-1, 0, 0], label: 'The index board' },
  { id: 'anchor.page_size_dial', kind: 'custom', structure: 'PageSizeDial', position: [10, 1, 2], facing: [-1, 0, 0], label: 'The page size dial' },
  { id: 'anchor.translation_gate', kind: 'stele', position: [10, 0, 8], facing: [-1, 0, 0], label: 'The translation gate' },
  { id: 'anchor.tlb_console', kind: 'stele', position: [10, 0, 14], facing: [-1, 0, 0], label: 'The translation cache console' },
  { id: 'anchor.route_fork', kind: 'custom', structure: 'RouteFork', position: [0, 0, 20], label: 'Two roads, the same distance' },
  { id: 'anchor.protection_bench', kind: 'stele', position: [10, 0, 20], facing: [-1, 0, 0], label: 'The protection bench' },
  { id: 'anchor.compaction_crew', kind: 'stele', position: [-10, 0, 20], facing: [1, 0, 0], label: 'The compaction crew' },
  { id: 'anchor.depot', kind: 'custom', structure: 'Depot', position: [0, 0, 26], label: 'The last depot before the Reach' },
  ...stele,
];

/** Anchors the focus camera may frame. The meters and the request bar are the hero framing. */
const cameraTargets: readonly string[] = [
  'anchor.yard', 'anchor.request_bar', 'anchor.frag_meters', 'anchor.yard_office',
  'anchor.paging_gate', 'anchor.index_board', 'anchor.page_size_dial',
  'anchor.translation_gate', 'anchor.tlb_console', 'anchor.route_fork',
  'anchor.protection_bench', 'anchor.compaction_crew', 'anchor.depot',
  ...bays.map((bay) => bay.id),
  ...stele.map((one) => one.id),
];

/** Anchors that are not an interaction anchor, which `validateContent` requires to be listed. */
const INTERACTION_ANCHORS: ReadonlySet<string> = new Set([
  'anchor.compaction_crew', 'anchor.paging_gate', 'anchor.page_size_dial',
  'anchor.protection_bench', 'anchor.route_fork', 'anchor.tlb_console',
  'anchor.index_board', 'anchor.translation_gate',
]);

export const layout: LegLayout = {
  anchors,
  cameraTargets,
  extras: anchors.map((anchor) => anchor.id).filter((id) => !INTERACTION_ANCHORS.has(id)),
};
