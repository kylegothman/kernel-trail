import type { BlockId, StorageDiskGeometrySnapshot } from '../types';
export type DiskGeometry = StorageDiskGeometrySnapshot;
export const DEFAULT_DISK_GEOMETRY: DiskGeometry = Object.freeze({ cylinders: 200, headsPerCylinder: 4,
  sectorsPerTrack: 64, bytesPerSector: 512, rpm: 7200, seekOverheadMs: 0.5,
  seekPerCylinderMs: 0.04, transferMbPerSec: 100 });
export const sectorsPerCylinder = (g: DiskGeometry = DEFAULT_DISK_GEOMETRY): number => g.headsPerCylinder * g.sectorsPerTrack;
export const capacity = (g: DiskGeometry = DEFAULT_DISK_GEOMETRY): number => g.cylinders * sectorsPerCylinder(g) * g.bytesPerSector;
export function validateGeometry(g: DiskGeometry): void {
  if (g === null || typeof g !== 'object') throw new RangeError('invalid disk geometry');
  for (const k of ['cylinders', 'headsPerCylinder', 'sectorsPerTrack', 'bytesPerSector'] as const) {
    if (!Number.isSafeInteger(g[k]) || g[k] <= 0) throw new RangeError(`invalid disk ${k}`);
  }
  if (g.bytesPerSector !== 512) throw new RangeError('storage LBAs require 512-byte sectors');
  for (const k of ['rpm', 'transferMbPerSec'] as const) {
    if (!Number.isFinite(g[k]) || g[k] <= 0) throw new RangeError(`invalid disk ${k}`);
  }
  for (const k of ['seekOverheadMs', 'seekPerCylinderMs'] as const) {
    if (!Number.isFinite(g[k]) || g[k] < 0) throw new RangeError(`invalid disk ${k}`);
  }
  if (!Number.isSafeInteger(capacity(g))) throw new RangeError('unsafe disk capacity');
}
export function diskGeometry(overrides: Partial<DiskGeometry> = {}): DiskGeometry {
  const g = { ...DEFAULT_DISK_GEOMETRY, ...overrides }; validateGeometry(g); return g;
}
/** Storage BlockId is a sector LBA; WP-10 converts 4096-byte FS blocks by x8. */
export function blockToCylinder(block: BlockId | number, g: DiskGeometry = DEFAULT_DISK_GEOMETRY): number {
  if (!Number.isSafeInteger(block) || block < 0 || block >= capacity(g) / 512) throw new RangeError('disk LBA out of range');
  return Math.floor(block / sectorsPerCylinder(g));
}
