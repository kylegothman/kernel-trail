import { Box3, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three/webgpu';

export interface RngLike { next(): number; }

export interface FractureResult {
  readonly geometry: BufferGeometry;
  readonly cell: number;
  readonly cubes: number;
}

const CORNERS: readonly [number, number, number][] = [
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
];
const FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 0], [0, 2, 3, 0], [1, 5, 6, 1], [1, 6, 2, 1],
  [5, 4, 7, 2], [5, 7, 6, 2], [4, 0, 3, 3], [4, 3, 7, 3],
  [3, 2, 6, 4], [3, 6, 7, 4], [4, 5, 1, 5], [4, 1, 0, 5],
];

function boundsOf(source: BufferGeometry): Box3 {
  if (!source.boundingBox) source.computeBoundingBox();
  return source.boundingBox?.clone() ?? new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5));
}

function cubeCount(bounds: Box3, cell: number): number {
  const size = bounds.getSize(new Vector3());
  return Math.max(1, Math.ceil(size.x / cell) * Math.ceil(size.y / cell) * Math.ceil(size.z / cell));
}

function boundedCell(bounds: Box3, requested: number, cap: number): number {
  let cell = Math.max(0.0001, requested);
  while (cubeCount(bounds, cell) > cap) cell *= 1.08;
  return cell;
}

/** Voxelise a geometry into deterministic cubes. The source is never mutated. */
export function fracture(source: BufferGeometry, requestedCell: number, rng: RngLike, cap = Number.POSITIVE_INFINITY): FractureResult {
  const bounds = boundsOf(source);
  const cell = Number.isFinite(cap) ? boundedCell(bounds, requestedCell, Math.max(1, cap)) : Math.max(0.0001, requestedCell);
  const size = bounds.getSize(new Vector3());
  const nx = Math.max(1, Math.ceil(size.x / cell));
  const ny = Math.max(1, Math.ceil(size.y / cell));
  const nz = Math.max(1, Math.ceil(size.z / cell));
  const cubes = nx * ny * nz;
  const positions: number[] = [];
  const centroids: number[] = [];
  const randoms: number[] = [];
  const seeds: number[] = [];
  const surfaces: number[] = [];
  const half = cell * 0.5;

  for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) {
    const cx = bounds.min.x + Math.min((x + 0.5) * cell, size.x - half);
    const cy = bounds.min.y + Math.min((y + 0.5) * cell, size.y - half);
    const cz = bounds.min.z + Math.min((z + 0.5) * cell, size.z - half);
    const seed = rng.next();
    const random = [rng.next(), rng.next(), rng.next()];
    const surface = x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1 ? 1 : 0;
    for (const [a, b, c] of FACES) {
      for (const index of [a, b, c]) {
        const corner = CORNERS[index]!;
        positions.push(cx + corner[0] * half, cy + corner[1] * half, cz + corner[2] * half);
        centroids.push(cx, cy, cz);
        randoms.push(random[0]!, random[1]!, random[2]!);
        seeds.push(seed);
        surfaces.push(surface);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('aCentroid', new Float32BufferAttribute(new Float32Array(centroids), 3));
  geometry.setAttribute('aRandom', new Float32BufferAttribute(new Float32Array(randoms), 3));
  geometry.setAttribute('aSeed', new Float32BufferAttribute(new Float32Array(seeds), 1));
  geometry.setAttribute('aSurface', new Float32BufferAttribute(new Float32Array(surfaces), 1));
  geometry.computeBoundingBox();
  return { geometry, cell, cubes };
}

export function cellForBounds(source: BufferGeometry, namedConvoy: boolean): number {
  const bounds = boundsOf(source);
  const size = bounds.getSize(new Vector3());
  if (Math.max(size.x, size.y, size.z) > 4) return 0.2;
  return namedConvoy ? 0.06 : 0.12;
}

export function fractureForTier(source: BufferGeometry, namedConvoy: boolean, tier: 'low' | 'medium' | 'high', rng: RngLike): FractureResult {
  const caps = { low: 600, medium: 1800, high: 4096 } as const;
  return fracture(source, cellForBounds(source, namedConvoy), rng, caps[tier]);
}
