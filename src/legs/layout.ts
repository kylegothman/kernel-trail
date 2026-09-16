/**
 * KERNEL TRAIL: the leg layout, a stage without a renderer (WP-21 section 2).
 *
 * A leg describes where its structures stand as data. `layoutStage` turns that
 * data into a `LegStage` whose `anchor(id)` resolves to the declared
 * `LayoutAnchor`, which is all the headless harness and the interaction
 * predicates need, and it pulls no `three`. The boot package walks the same
 * layout later to build the real scene with `StageBuilder`, so the kinds below
 * are the contract the render track implements against: the eight forms of
 * `src/world/forms`, the eight named structures of
 * `src/world/structures/base/StructureRegistry.ts` in snake case, and
 * `custom` for a structure a leg has asked the registry to supply by name. Do
 * not add a kind a leg has not asked for.
 */
import type { LegStage } from '@game/types';

export type StructureKind =
  | 'grid_floor' | 'stele' | 'slab' | 'page_plate' | 'resource_ring' | 'beam' | 'hex_tile' | 'horizon'
  | 'frame_vault' | 'ready_queue_procession' | 'wait_for_ring' | 'platter_stack' | 'page_ocean'
  | 'bus_spine' | 'archive_shelves' | 'domain_rings' | 'custom';

export interface LayoutAnchor {
  /** An `InteractionDef.anchor` or a camera target. */
  readonly id: string;
  readonly kind: StructureKind;
  readonly position: readonly [number, number, number];
  readonly facing?: readonly [number, number, number];
  /** For 'custom': the name the boot package's structure registry must supply. */
  readonly structure?: string;
  readonly label?: string;
}

export interface LegLayout {
  readonly anchors: readonly LayoutAnchor[];
  /** Anchor ids the focus camera may frame. */
  readonly cameraTargets: readonly string[];
  /** Anchor ids that are not interaction anchors. */
  readonly extras: readonly string[];
}

/** A `LegStage` over the layout: `anchor(id)` returns the `LayoutAnchor`, `update` and `dispose` do nothing. */
export function layoutStage(layout: LegLayout): LegStage {
  const byId = new Map<string, LayoutAnchor>(layout.anchors.map((anchor) => [anchor.id, anchor]));
  return {
    update: () => undefined,
    anchor: (id) => byId.get(id) ?? null,
    dispose: () => undefined,
  };
}
