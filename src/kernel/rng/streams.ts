// Keep one registry implementation while preserving the scaffold's existing imports.
export {
  createStreamRegistry as createStreams,
  SUBSYSTEM_STREAM_LABELS as STREAM_LABELS,
} from '../rng';
export type { StreamRegistry, SubsystemStreamLabel as StreamLabel } from '../rng';
