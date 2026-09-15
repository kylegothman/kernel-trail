import { InstancedMesh, MeshBasicNodeMaterial } from 'three/webgpu';
import type { BufferGeometry, Object3D } from 'three/webgpu';
import { PROFILES, type QualityTier } from '@platform';
import { fractureForTier, type FractureResult, type RngLike } from './fracture';
import { createDerezzFragmentNode } from './derezz.frag.glsl';
import { createDerezzVertexNode } from './derezz.vert.glsl';
import { DEREZZ_BEATS, terminationVariant, type DerezzBeat, type DerezzVariant, type TerminationReason } from './variants';

export interface DerezzSpawn {
  readonly source: BufferGeometry;
  readonly reason: TerminationReason;
  readonly namedConvoy: boolean;
  readonly rng: RngLike;
  readonly anchor?: Object3D;
}

export interface LiveDerezz {
  readonly id: number;
  readonly variant: DerezzVariant;
  readonly fracture: FractureResult;
  readonly namedConvoy: boolean;
  readonly mesh: InstancedMesh;
  readonly beats: readonly DerezzBeat[];
  age: number;
  alive: boolean;
}

interface Bucket { readonly cell: number; readonly mesh: InstancedMesh; count: number; }

/** Bounded derezz batches. Anonymous effects share a cell-size mesh; convoy deaths own one. */
export class DerezzPool {
  private readonly buckets = new Map<number, Bucket>();
  private readonly live: LiveDerezz[] = [];
  private nextId = 1;
  private readonly limit: number;
  constructor(readonly tier: QualityTier) { this.limit = PROFILES[tier].concurrentDerezz; }

  spawn(spec: DerezzSpawn): LiveDerezz | null {
    const fracture = fractureForTier(spec.source, spec.namedConvoy, this.tier, spec.rng);
    if (!spec.namedConvoy && this.live.filter((entry) => entry.alive && !entry.namedConvoy).length >= this.limit) return null;
    const id = this.nextId++;
    const bucket = spec.namedConvoy ? this.createBucket(fracture, -id) : this.bucketFor(fracture);
    const entry: LiveDerezz = { id, variant: terminationVariant(spec.reason), fracture, namedConvoy: spec.namedConvoy, mesh: bucket.mesh, beats: spec.namedConvoy ? DEREZZ_BEATS : [], age: spec.namedConvoy ? -0.4 : 0, alive: true };
    bucket.count += 1;
    bucket.mesh.count = Math.min(bucket.mesh.count + 1, bucket.mesh.instanceMatrix.count);
    this.live.push(entry);
    return entry;
  }

  update(dtSeconds: number): void {
    for (const entry of this.live) {
      if (!entry.alive) continue;
      entry.age += dtSeconds;
      const duration = entry.namedConvoy ? 4.7 : 0.52;
      if (entry.age >= duration) { entry.alive = false; }
    }
  }

  get activeCount(): number { return this.live.reduce((count, entry) => count + (entry.alive ? 1 : 0), 0); }
  get drawCalls(): number {
    let calls = 0;
    for (const bucket of this.buckets.values()) if (bucket.count > 0) calls += 1;
    return calls;
  }
  get entries(): readonly LiveDerezz[] { return this.live; }
  beatsAt(entry: LiveDerezz): readonly DerezzBeat[] {
    const ms = entry.age * 1000;
    return entry.beats.filter((beat) => ms >= beat.startMs && ms < beat.endMs);
  }
  dispose(): void {
    for (const bucket of this.buckets.values()) {
      bucket.mesh.geometry.dispose();
      if (Array.isArray(bucket.mesh.material)) for (const material of bucket.mesh.material) material.dispose();
      else bucket.mesh.material.dispose();
    }
    this.buckets.clear(); this.live.length = 0;
  }

  private bucketFor(fracture: FractureResult): Bucket {
    const existing = this.buckets.get(fracture.cell);
    if (existing) return existing;
    return this.createBucket(fracture, fracture.cell);
  }
  private createBucket(fracture: FractureResult, key: number): Bucket {
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    material.positionNode = createDerezzVertexNode();
    material.colorNode = createDerezzFragmentNode();
    const mesh = new InstancedMesh(fracture.geometry, material, Math.max(1, this.limit));
    mesh.count = 0;
    const bucket = { cell: fracture.cell, mesh, count: 0 };
    this.buckets.set(key, bucket);
    return bucket;
  }
}
