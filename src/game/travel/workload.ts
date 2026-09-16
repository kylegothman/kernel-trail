import type { Pace, ProcessSpec } from '../types';
import { PACE_TABLE } from './paceRations';

/** Shared spawn-time transform; every spec, including a delayed convoy, is scaled. */
export function paceSpawnTransform(pace: Pace): (spec: ProcessSpec) => ProcessSpec {
  const rate = PACE_TABLE[pace].workloadArrivalRate;
  return spec => ({ ...spec, arrival: Math.round(spec.arrival / rate) });
}
