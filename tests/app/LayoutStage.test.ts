import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, InstancedMesh, Matrix4, Mesh, PlaneGeometry, Scene, Vector3 } from 'three/webgpu';
import type { BufferGeometry } from 'three/webgpu';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { buildLayoutStage } from '@app/stage/LayoutStage';
import type { LayoutStage } from '@app/stage/LayoutStage';
import { FOCUS, FORM, LAYER, MIN_GLYPH_PX, TYPE_SCALE } from '@design';
import { asTick } from '@kernel/types';
import type { LayoutAnchor, LegLayout, StructureKind } from '@legs/layout';
import { BlendedPerspectiveCamera, FocusCameraRig, holoLabel } from '@render';
import * as materials from '@render/materials';
import type { StageServices, WorldContext } from '@world/contracts';
import { GeometryLeases, makeGridFloor, makeHorizon, makeSlab } from '@world/forms';
import { PROFILES, type QualityTier } from '@platform';
import { SdfAtlas } from '@world/labels/SdfAtlas';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  materials.disposeMaterials();
  vi.restoreAllMocks();
});

function setup(scene = new Scene(), existingFocus?: FocusCameraRig, tier: QualityTier = 'high') {
  const camera = new BlendedPerspectiveCamera(46, 1440 / 900, 0.1, 2000);
  camera.position.set(0, 4, 20);
  camera.updateMatrixWorld();
  const focus = existingFocus ?? new FocusCameraRig({ scene, camera, aspect: 1440 / 900, viewportHeightPx: 900 });
  const assets: Awaited<ReturnType<typeof holoLabel>>[] = [];
  const provider: typeof holoLabel = async (_text, _semantic, _tier, capHeight) => {
    const object = new Group();
    const geometry = new PlaneGeometry(1, capHeight);
    const mesh = new Mesh(geometry, materials.createLabelPlateMaterial());
    mesh.layers.set(LAYER.TEXT);
    object.add(mesh);
    const asset = {
      object, mesh, minimumDevicePixels: MIN_GLYPH_PX, microRem: TYPE_SCALE.micro.sizeRem,
      dispose: vi.fn(() => { geometry.dispose(); mesh.material.dispose(); object.removeFromParent(); }),
    };
    assets.push(asset);
    return asset;
  };
  const atlas = new SdfAtlas(tier, focus, 900, provider);
  const place = vi.spyOn(atlas, 'place');
  const context: WorldContext = {
    scene, quality: tier, focus, labels: atlas, materials: { ...materials, holoLabel },
    time: { elapsedSeconds: 0, alpha: 0 }, elapsedSeconds: 0, tick: 0, suppressEffects: false,
    kernel: { process: () => undefined, tick: asTick(0) },
  };
  const services: StageServices = {
    createBatch: () => { throw new Error('Layout owns the geometry-specific batch factory'); },
    postFocus: { focusBlend: 0, focusDistanceM: 0 },
  };
  cleanups.push(() => { atlas.dispose(); focus.dispose(); });
  return { scene, focus, atlas, place, assets, context, services };
}

function build(harness: ReturnType<typeof setup>, layout: LegLayout): LayoutStage {
  const stage = buildLayoutStage(layout, harness.context, harness.services, harness.focus, harness.atlas);
  cleanups.push(() => stage.dispose());
  return stage;
}

function geometryDisposals(scene: Scene) {
  const geometries = new Map<BufferGeometry, ReturnType<typeof vi.fn>>();
  scene.traverse(object => {
    if (!(object instanceof Mesh) || geometries.has(object.geometry)) return;
    const disposed = vi.fn();
    object.geometry.addEventListener('dispose', disposed);
    geometries.set(object.geometry, disposed);
  });
  return geometries;
}

const kinds: readonly StructureKind[] = [
  'grid_floor', 'stele', 'slab', 'page_plate', 'resource_ring', 'beam', 'hex_tile', 'horizon',
  'frame_vault', 'ready_queue_procession', 'wait_for_ring', 'platter_stack', 'page_ocean',
  'bus_spine', 'archive_shelves', 'domain_rings', 'custom',
];

describe('browser layout stage', () => {
  it('draws all seventeen kinds and keeps every anchor reachable through focus', async () => {
    const harness = setup();
    const anchors: LayoutAnchor[] = kinds.map((kind, index) => ({
      id: `anchor-${kind}`, kind, position: [index * 4, 0, 0], facing: [1, 0, 0],
      ...(kind === 'frame_vault' ? { label: 'Frame vault label' } : {}),
    }));
    const stage = build(harness, { anchors, cameraTargets: anchors.slice(0, -1).map(anchor => anchor.id), extras: [] });
    await stage.ready;
    expect(stage.structureCount).toBe(17);
    expect(stage.structures).toHaveLength(17);
    expect(harness.scene.children).toHaveLength(8);
    expect(new Set(stage.structures.map(structure => structure.focusTarget.id)).size).toBe(17);
    for (const [index, structure] of stage.structures.entries()) {
      expect(stage.anchor(structure.id)).toBe(structure.root);
      expect(structure.root.position.toArray()).toEqual([index * 4, 0, 0]);
      expect(new Vector3(0, 0, 1).applyQuaternion(structure.root.quaternion).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-10);
      expect(structure.focusTarget.extents.x).toBeGreaterThan(0);
      expect(structure.focusTarget.extents.y).toBeGreaterThan(0);
      expect(structure.focusTarget.padding).toBe(0.12);
      expect(harness.focus.engage(structure.id)).toBe(true);
      stage.update(0.52, 0);
      expect(harness.focus.state.target?.id).toBe(structure.id);
    }
    expect(stage.structures.at(-1)?.focusTarget.dimOthers).toBe(0);
    const slab = stage.structures.find(structure => structure.definition.kind === 'slab');
    expect(slab?.focusTarget.extents.x).toBeCloseTo(FORM.pagePlate.x);
    expect(slab?.focusTarget.extents.y).toBeCloseTo(FORM.pagePlate.z);
    expect(harness.place.mock.calls.map(call => call[0])).toEqual([
      'Frame vault label', 'anchor-ready_queue_procession', 'anchor-wait_for_ring',
      'anchor-platter_stack', 'anchor-page_ocean', 'anchor-bus_spine',
      'anchor-archive_shelves', 'anchor-domain_rings', 'anchor-custom',
    ]);
    expect(harness.assets).toHaveLength(9);
    for (const call of harness.place.mock.calls) {
      expect(call[1]).toBe('page_clean');
      expect(call[2]).toBe('structureTitle');
    }
    stage.dispose();
    expect(harness.scene.children).toHaveLength(0);
    for (const anchor of anchors) expect(harness.focus.engage(anchor.id)).toBe(false);
    for (const asset of harness.assets) expect(asset.dispose).toHaveBeenCalledOnce();
  });

  it('releases geometry only after the last owner and supports a fresh atlas on the next leg', async () => {
    const harness = setup();
    const external = new GeometryLeases();
    cleanups.push(() => external.dispose());
    const shared = external.take(makeSlab());
    const sourceDisposed = vi.fn();
    shared.addEventListener('dispose', sourceDisposed);
    const layout: LegLayout = {
      anchors: [{ id: 'first', kind: 'custom', position: [0, 0, 0] }], cameraTargets: ['first'], extras: [],
    };
    const first = build(harness, layout);
    await first.ready;
    const owned = geometryDisposals(harness.scene);
    expect(first.structures[0]?.sourceGeometry).toBe(shared);
    first.dispose();
    first.dispose();
    expect(first.disposed).toBe(true);
    expect(sourceDisposed).not.toHaveBeenCalled();
    expect(harness.scene.children).toHaveLength(0);
    for (const disposed of owned.values()) expect(disposed).toHaveBeenCalledOnce();
    external.dispose();
    expect(sourceDisposed).toHaveBeenCalledOnce();

    const nextHarness = setup(harness.scene, harness.focus);
    const second = build(nextHarness, layout);
    await second.ready;
    expect(second.structures[0]?.sourceGeometry).not.toBe(shared);
    expect(nextHarness.place).toHaveBeenCalledOnce();
    expect(nextHarness.focus.engage('first')).toBe(true);
    second.update(0.52, 0);
    second.dispose();
    expect(nextHarness.scene.children).toHaveLength(0);
    expect(nextHarness.focus.engage('first')).toBe(false);
  });

  it('instances nine slabs in one draw while preserving independent focus and transforms', async () => {
    const harness = setup();
    const anchors: LayoutAnchor[] = Array.from({ length: 9 }, (_, index) => ({
      id: `slab-${index}`, kind: 'slab', position: [index * 4, index, 0],
    }));
    const stage = build(harness, { anchors, cameraTargets: anchors.map(anchor => anchor.id), extras: [] });
    await stage.ready;
    stage.update(0, 0);
    expect(stage.structureCount).toBe(9);
    expect(stage.instancedKinds).toEqual(['slab']);
    const meshes: InstancedMesh[] = [];
    harness.scene.traverse(object => { if (object instanceof InstancedMesh) meshes.push(object); });
    expect(meshes).toHaveLength(1);
    const mesh = meshes[0];
    if (!mesh) throw new Error('Expected a slab instance batch');
    expect(mesh.count).toBe(9);
    for (let index = 0; index < anchors.length; index++) {
      const matrix = new Matrix4();
      mesh.getMatrixAt(index, matrix);
      expect(new Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([index * 4, index, 0]);
      expect(harness.focus.engage(`slab-${index}`)).toBe(true);
    }
    harness.focus.engage('slab-0');
    stage.update(0.52, 0);
    const phase = mesh.geometry.getAttribute('aStatePhase');
    expect(phase.getW(0)).toBe(1);
    for (let index = 1; index < anchors.length; index++) expect(phase.getW(index)).toBeCloseTo(1 - FOCUS.dimOthers);
    const owned = geometryDisposals(harness.scene);
    stage.dispose();
    expect(harness.scene.children).toHaveLength(0);
    for (const disposed of owned.values()) expect(disposed).toHaveBeenCalledOnce();
  });

  it('draws eight horizon anchors alongside the environment and releases their geometry', async () => {
    const harness = setup();
    const anchors: LayoutAnchor[] = Array.from({ length: 8 }, (_, index) => ({
      id: `horizon-${index}`, kind: 'horizon', position: [index * 4, 0, 0],
    }));
    const stage = build(harness, { anchors, cameraTargets: anchors.map(anchor => anchor.id), extras: [] });
    await stage.ready;
    stage.update(0, 0);
    expect(stage.structureCount).toBe(8);
    expect(stage.instancedKinds).toEqual([]);
    const lines: Mesh[] = [];
    harness.scene.traverse(object => {
      if (object instanceof Mesh && object.geometry instanceof LineSegmentsGeometry) lines.push(object);
    });
    expect(lines).toHaveLength(9);
    expect(lines.filter(line => line.layers.isEnabled(LAYER.ENV))).toHaveLength(1);
    expect(lines.filter(line => line.layers.isEnabled(LAYER.STRUCTURES))).toHaveLength(8);
    for (const anchor of anchors) expect(harness.focus.engage(anchor.id)).toBe(true);
    const owned = geometryDisposals(harness.scene);
    stage.dispose();
    expect(harness.scene.children).toHaveLength(0);
    for (const disposed of owned.values()) expect(disposed).toHaveBeenCalledOnce();
  });

  it('rejects an instance ceiling before mounting the scene or retaining source geometry', () => {
    const harness = setup(new Scene(), undefined, 'low');
    const external = new GeometryLeases();
    cleanups.push(() => external.dispose());
    const factories = [makeSlab, makeGridFloor, makeHorizon];
    const sources = factories.map(make => external.take(make()));
    const disposed = sources.map(source => {
      const listener = vi.fn(); source.addEventListener('dispose', listener); return listener;
    });
    const anchors: LayoutAnchor[] = Array.from({ length: PROFILES.low.maxInstances.page_frames + 1 }, (_, index) => ({
      id: `slab-${index}`, kind: 'slab', position: [index * 4, 0, 0],
    }));
    const ids = anchors.map(anchor => anchor.id);
    expect(() => build(harness, { anchors, cameraTargets: ids, extras: ids })).toThrow(/page_frames exceeds low instance ceiling/);
    expect(harness.scene.children).toHaveLength(0);
    for (const listener of disposed) expect(listener).not.toHaveBeenCalled();
    external.dispose();
    for (const listener of disposed) expect(listener).toHaveBeenCalledOnce();
    const next = new GeometryLeases();
    cleanups.push(() => next.dispose());
    for (const [index, make] of factories.entries()) expect(next.take(make())).not.toBe(sources[index]);
  });

  it('batches repeated horizon lines without losing segment transforms', async () => {
    const harness = setup();
    const anchors: LayoutAnchor[] = Array.from({ length: 9 }, (_, index) => ({
      id: `horizon-${index}`, kind: 'horizon', position: [index * 4, 0, 0],
    }));
    const stage = build(harness, { anchors, cameraTargets: anchors.map(anchor => anchor.id), extras: [] });
    await stage.ready;
    stage.update(0, 0);
    expect(stage.instancedKinds).toEqual(['horizon']);
    const lines: Mesh[] = [];
    harness.scene.traverse(object => {
      if (object instanceof Mesh && object.geometry instanceof LineSegmentsGeometry
        && object.layers.isEnabled(LAYER.STRUCTURES)) lines.push(object);
    });
    expect(lines).toHaveLength(1);
    const geometry = lines[0]?.geometry;
    if (!(geometry instanceof LineSegmentsGeometry)) throw new Error('Expected line segment geometry');
    expect(geometry.instanceCount).toBe(9 * 256);
    const start = geometry.getAttribute('instanceStart');
    expect(start.getX(256) - start.getX(0)).toBeCloseTo(4);
    for (let index = 0; index < start.count; index++) {
      expect(Number.isFinite(start.getX(index))).toBe(true);
      expect(Number.isFinite(start.getZ(index))).toBe(true);
    }
    const owned = geometryDisposals(harness.scene);
    stage.dispose();
    for (const disposed of owned.values()) expect(disposed).toHaveBeenCalledOnce();
  });
});
