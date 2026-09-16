/** A layout's browser stand-ins. The structures package owns the eventual art. */
import { DynamicDrawUsage, InstancedBufferAttribute, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { BufferGeometry, Object3D } from 'three/webgpu';
import { DASH, HATCH_ID, LAYER, SEMANTICS, gainFor, linearColor } from '@design';
import type { LegStage } from '@game/types';
import type { LegLayout } from '@legs/layout';
import { getMaterial } from '@render';
import type { FocusCameraRig, InstancedBatchDesc, InstancedBatchHandle } from '@render';
import { ManagedBatch } from '@render/RendererBackend';
import type { BatchChannel } from '@render/RendererBackend';
import type { StageServices, WorldContext } from '@world/contracts';
import { GeometryLeases, cachedGeometry } from '@world/forms';
import { SdfAtlas } from '@world/labels/SdfAtlas';
import { StageBuilder } from '@world/StageBuilder';
import { InstancedStructure } from '@world/structures/base/InstancedStructure';
import type { InstanceData } from '@world/instancing/InstancedBatch';
import {
  LayoutStructure, formFocusTarget, formGeometry, layoutFormKind, preparedFormGeometry,
} from './LayoutStructure';
import type { FormKind } from './LayoutStructure';

export interface LayoutStage extends LegStage {
  readonly structures: readonly LayoutStructure[];
  readonly structureCount: number;
  readonly instancedKinds: readonly FormKind[];
  readonly ready: Promise<void>;
  readonly disposed: boolean;
}

const semantic = SEMANTICS.page_clean;
const colour = linearColor(semantic.hex);
const instanceData: InstanceData = {
  colorGain: [colour.r, colour.g, colour.b, gainFor(semantic.family, semantic.level)],
  statePhase: [0, 0, semantic.pulseHz, 1],
  patternId: [DASH[semantic.dash].on, DASH[semantic.dash].off, HATCH_ID[semantic.hatch], 0],
};
let nextHorizonBatch = 0;

/** Line2 already instances segments, so a horizon batch expands anchor transforms into segments. */
class HorizonBatch implements InstancedBatchHandle {
  readonly name: string;
  readonly capacity: number;
  readonly object: Mesh<LineSegmentsGeometry>;
  readonly matrices: Float32Array;
  readonly colours: Float32Array;
  readonly state: Float32Array;
  readonly colorGain: Float32Array;
  readonly statePhase: Float32Array;
  readonly patternId: Float32Array;
  private readonly geometry = new GeometryLeases();
  private readonly segments: number;
  private readonly positions: Float32Array;
  private readonly weights: InstancedBufferAttribute;
  private readonly transform = new Matrix4();
  private readonly point = new Vector3();
  private dirty = true;
  private liveCount = 0;
  private disposed = false;

  constructor(desc: InstancedBatchDesc, private readonly source: BufferGeometry, context: WorldContext) {
    this.name = desc.name;
    this.capacity = desc.capacity;
    this.segments = source.getAttribute('instanceStart').count;
    this.matrices = new Float32Array(desc.capacity * 16);
    this.colours = new Float32Array(desc.capacity * 3);
    this.state = new Float32Array(desc.capacity * 4);
    this.colorGain = new Float32Array(desc.capacity * 4);
    this.statePhase = new Float32Array(desc.capacity * 4);
    this.patternId = new Float32Array(desc.capacity * 4);
    this.positions = new Float32Array(desc.capacity * this.segments * 6);
    const geometry = this.geometry.take(cachedGeometry(`layout.horizon.batch.${nextHorizonBatch++}`,
      () => new LineSegmentsGeometry().setPositions(this.positions)));
    if (!(geometry instanceof LineSegmentsGeometry)) throw new Error('Horizon needs line segment geometry');
    this.weights = new InstancedBufferAttribute(new Float32Array(desc.capacity * this.segments * 4), 4);
    this.weights.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aStatePhase', this.weights);
    geometry.instanceCount = 0;
    this.object = new Mesh(geometry, getMaterial('emissive-line', 'page_clean', context.quality));
    this.object.layers.set(LAYER.STRUCTURES);
    this.object.matrixAutoUpdate = false;
    this.object.frustumCulled = false;
  }

  get count(): number { return this.liveCount; }
  set count(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > this.capacity) throw new Error('Invalid horizon count');
    this.liveCount = value;
    this.object.geometry.instanceCount = value * this.segments;
    this.dirty = true;
  }
  touch(_from: number, _to: number, _channel?: BatchChannel): void { this.dirty = true; }
  flush(): void {
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    const start = this.source.getAttribute('instanceStart');
    const end = this.source.getAttribute('instanceEnd');
    const geometry = this.object.geometry;
    const outputStart = geometry.getAttribute('instanceStart');
    const outputEnd = geometry.getAttribute('instanceEnd');
    for (let slot = 0; slot < this.liveCount; slot++) {
      this.transform.fromArray(this.matrices, slot * 16);
      const weight = this.statePhase[slot * 4 + 3] ?? 1;
      for (let segment = 0; segment < this.segments; segment++) {
        const index = slot * this.segments + segment;
        this.point.fromBufferAttribute(start, segment).applyMatrix4(this.transform);
        outputStart.setXYZ(index, this.point.x, this.point.y, this.point.z);
        this.point.fromBufferAttribute(end, segment).applyMatrix4(this.transform);
        outputEnd.setXYZ(index, this.point.x, this.point.y, this.point.z);
        this.weights.setXYZW(index, 0, 0, semantic.pulseHz, weight);
      }
    }
    outputStart.needsUpdate = true;
    outputEnd.needsUpdate = true;
    this.weights.needsUpdate = true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.geometry.dispose();
  }
}

class LayoutInstances extends InstancedStructure {
  private readonly anchors: { structure: LayoutStructure; slot: number }[] = [];
  private readonly drawable: ManagedBatch | HorizonBatch;

  constructor(readonly kind: FormKind, capacity: number, context: WorldContext, services: StageServices) {
    const source = formGeometry(kind, context.quality);
    const prepared = preparedFormGeometry(kind, context.quality);
    let drawable: ManagedBatch | HorizonBatch | undefined;
    const groupServices: StageServices = {
      postFocus: services.postFocus,
      createBatch(desc) {
        drawable = kind === 'horizon' ? new HorizonBatch(desc, source, context)
          : new ManagedBatch(desc, prepared, getMaterial('emissive-panel', 'page_clean', context.quality), () => undefined);
        return drawable;
      },
    };
    super(`layout-${kind}-instances`, context, formFocusTarget(kind, source, false), groupServices, 'page_frames', {
      name: `kt.structures.layout.${kind}.batch`, capacity, geometry: 'slab', material: 'structure',
      perInstanceColour: true, castShadow: false, layer: LAYER.STRUCTURES,
    });
    if (!drawable) throw new Error('Layout batch was not constructed');
    this.drawable = drawable;
    this.shared(source);
    this.shared(prepared);
    this.batch.handle.object.userData['castsReflection'] = true;
  }

  add(structure: LayoutStructure): void {
    const slot = this.batch.allocate();
    this.batch.move(slot, structure.root.matrix);
    this.batch.write(slot, instanceData);
    this.anchors.push({ structure, slot });
  }

  update(_dtSeconds: number, _alpha: number): void {
    for (const { structure, slot } of this.anchors) {
      this.batch.move(slot, structure.root.matrix);
      this.batch.setFocusWeight(slot, this.context.focus.focusWeight(structure.root));
    }
    this.drawable.flush();
  }
}

export function buildLayoutStage(
  layout: LegLayout, context: WorldContext, services: StageServices,
  focus: FocusCameraRig, atlas: SdfAtlas,
): LayoutStage {
  if (context.scene.children.length !== 0) throw new Error('Previous layout stage must empty the scene');
  if (context.labels !== atlas || context.focus !== focus) throw new Error('Layout services must share the same atlas and focus rig');
  const ids = new Set<string>();
  const counts = new Map<FormKind, number>();
  for (const anchor of layout.anchors) {
    if (ids.has(anchor.id)) throw new Error(`Duplicate layout anchor: ${anchor.id}`);
    ids.add(anchor.id);
    const kind = layoutFormKind(anchor.kind);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const builder = new StageBuilder(context, services, focus);
  builder.addEnvironment();
  const instances = new Map<FormKind, LayoutInstances>();
  for (const [kind, count] of counts) {
    if (count <= 8) continue;
    const group = new LayoutInstances(kind, count, context, services);
    instances.set(kind, group);
    builder.groups.structures.add(group.root);
  }
  // Whole batches stay bright; their per-anchor state attributes supply dimming.
  const focusSet: readonly Object3D[] = Array.from(instances.values(), group => group.root);
  const targets = new Set(layout.cameraTargets);
  const structures = layout.anchors.map(anchor => {
    const group = instances.get(layoutFormKind(anchor.kind));
    const structure = new LayoutStructure(anchor, context, targets.has(anchor.id), !group, focusSet);
    builder.add(structure);
    group?.add(structure);
    return structure;
  });
  const built = builder.build();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    built.dispose();
    for (const group of instances.values()) group.dispose();
    if (context.scene.children.length !== 0) throw new Error('Layout disposal left scene children');
  };
  const ready = Promise.all(structures.filter(structure => structure.needsLabel).map(structure =>
    atlas.place(structure.definition.label ?? structure.id, 'page_clean', 'structureTitle',
      structure.root, builder.groups.labels, structure.labelOffset),
  )).then(() => undefined, (error: unknown) => {
    if (disposed) return;
    dispose();
    throw error;
  });
  return {
    structures, structureCount: structures.length, instancedKinds: Array.from(instances.keys()), ready,
    get disposed() { return disposed; },
    update(dtSeconds, alpha) {
      if (disposed) return;
      built.update(dtSeconds, alpha);
      for (const group of instances.values()) group.update(dtSeconds, alpha);
    },
    anchor: id => built.anchor(id), dispose,
  };
}
