import type { DiskSchedulingId } from '../types';
import { requireDiskPolicy } from './DiskQueue';
import { createFcfs } from './policies/fcfs';
import { createSstf } from './policies/sstf';
import { createScan } from './policies/scan';
import { createCscan } from './policies/cscan';
import { createLook } from './policies/look';
import { createClook } from './policies/clook';
export const DISK_POLICIES = Object.freeze({ fcfs: createFcfs, sstf: createSstf, scan: createScan, cscan: createCscan, look: createLook, clook: createClook });
export function createDiskPolicy(id: DiskSchedulingId) { requireDiskPolicy(id); return DISK_POLICIES[id](); }
