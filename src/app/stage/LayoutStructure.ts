/** Stand-in forms over layout data. The structures package replaces their art. */
import { Mesh, Vector2, Vector3 } from 'three/webgpu';
import type { BufferGeometry, Object3D } from 'three/webgpu';
import { FOCUS, LAYER, WORLD_CAP_HEIGHT_M } from '@design';
import type { LayoutAnchor, StructureKind } from '@legs/layout';
import type { QualityTier } from '@platform';
import { getMaterial, prepareSemanticGeometry } from '@render';
import type { FocusTarget } from '@render';
import type { WorldContext } from '@world/contracts';
import { Structure } from '@world/structures/base/Structure';
import {
  cachedGeometry, makeBeam, makeGridFloor, makeHexTile, makeHorizon,
  makePagePlate, makeResourceRing, makeSlab, makeStele,
} from '@world/forms';

export type FormKind = 'grid_floor' | 'stele' | 'slab' | 'page_plate'
  | 'resource_ring' | 'beam' | 'hex_tile' | 'horizon';

export function layoutFormKind(kind: StructureKind): FormKind {
  switch (kind) {
    case 'grid_floor': case 'stele': case 'slab': case 'page_plate':
    case 'resource_ring': case 'beam': case 'hex_tile': case 'horizon': return kind;
    default: return 'slab';
  }
}

export function formGeometry(kind: FormKind, tier: QualityTier): BufferGeometry {
  switch (kind) {
    case 'grid_floor': return makeGridFloor();
    case 'stele': return makeStele();
    case 'slab': return makeSlab();
    case 'page_plate': return makePagePlate();
    case 'resource_ring': return makeResourceRing(tier);
    case 'beam': return makeBeam(tier);
    case 'hex_tile': return makeHexTile();
    case 'horizon': return makeHorizon();
  }
}

/** Surface attributes belong to a prepared clone, never the library's source. */
export function preparedFormGeometry(kind: FormKind, tier: QualityTier): BufferGeometry {
  const source = formGeometry(kind, tier);
  if (kind === 'horizon') return source;
  return cachedGeometry(`layout.${kind}.${source.name}.page_clean`, () => {
    const geometry = source.clone();
    prepareSemanticGeometry(geometry, 'page_clean');
    return geometry;
  });
}

export function formFocusTarget(
  kind: FormKind, geometry: BufferGeometry, cameraTarget: boolean,
  focusSet: readonly Object3D[] = [],
): Omit<FocusTarget, 'id' | 'anchor'> {
  geometry.computeBoundingBox();
  const size = new Vector3();
  geometry.boundingBox?.getSize(size);
  const horizontal = kind === 'grid_floor' || kind === 'slab' || kind === 'page_plate'
    || kind === 'hex_tile' || kind === 'horizon';
  return {
    planeNormal: horizontal ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1),
    planeUp: horizontal ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0),
    extents: new Vector2(Math.max(size.x, 0.01), Math.max(horizontal ? size.z : size.y, 0.01)),
    padding: 0.12, focusSet, dimOthers: cameraTarget ? FOCUS.dimOthers : 0,
    labelPlane: 'billboard-to-focus', minGlyphHeight: WORLD_CAP_HEIGHT_M.structureTitle,
  };
}

export class LayoutStructure extends Structure {
  readonly formKind: FormKind;
  readonly sourceGeometry: BufferGeometry;
  readonly labelOffset: Vector3;
  readonly needsLabel: boolean;

  constructor(
    readonly definition: LayoutAnchor, context: WorldContext, cameraTarget: boolean,
    draw = true, focusSet: readonly Object3D[] = [],
  ) {
    const kind = layoutFormKind(definition.kind);
    const source = formGeometry(kind, context.quality);
    super(definition.id, context, formFocusTarget(kind, source, cameraTarget, focusSet));
    this.formKind = kind;
    this.sourceGeometry = this.shared(source);
    this.root.position.set(...definition.position);
    if (definition.facing) {
      const direction = new Vector3(...definition.facing);
      if (direction.lengthSq() > 0) this.root.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), direction.normalize());
    }
    this.root.updateMatrix();
    this.needsLabel = definition.kind !== kind;
    const bounds = source.boundingBox;
    this.labelOffset = new Vector3(
      bounds ? (bounds.min.x + bounds.max.x) / 2 : 0,
      (bounds?.max.y ?? 0) + WORLD_CAP_HEIGHT_M.structureTitle,
      bounds ? (bounds.min.z + bounds.max.z) / 2 : 0,
    );
    if (draw) {
      const geometry = this.shared(preparedFormGeometry(kind, context.quality));
      const material = getMaterial(kind === 'horizon' ? 'emissive-line' : 'emissive-panel', 'page_clean', context.quality);
      const mesh = new Mesh(geometry, material);
      mesh.name = `kt.structures.${definition.id}.form`;
      mesh.layers.set(LAYER.STRUCTURES);
      mesh.userData['castsReflection'] = true;
      this.root.add(mesh);
    }
  }

  update(_dtSeconds: number, _alpha: number): void {}
}
