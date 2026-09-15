/**
 * The five score layers, package section 5. Layered, not sequenced: there is
 * no timeline, only gains that follow the load model.
 */
export type LayerId = 'bed' | 'pulse' | 'strain' | 'contention' | 'alarm';
export const LAYER_IDS: readonly LayerId[] = ['bed', 'pulse', 'strain', 'contention', 'alarm'];

export interface LayerSpec {
  readonly id: LayerId;
  readonly kind: 'drone' | 'noise';
  /** Scale degree over the leg's root, and the octave. */
  readonly degree: number;
  readonly octave: number;
  readonly maxGain: number;
  readonly detuneCents: number;
  /** Lowpass cutoff as a multiple of the layer's pitch. */
  readonly filterMul: number;
}

export const LAYERS: Readonly<Record<LayerId, LayerSpec>> = {
  /** The floor of the mix: the root, always present. */
  bed: { id: 'bed', kind: 'drone', degree: 0, octave: 0, maxGain: 0.3, detuneCents: 4, filterMul: 4 },
  /** A fifth up, gated at the context-switch rate. */
  pulse: { id: 'pulse', kind: 'drone', degree: 3, octave: 1, maxGain: 0.2, detuneCents: 5, filterMul: 6 },
  /** The minor third above, detuned against the bed as faults rise. */
  strain: { id: 'strain', kind: 'drone', degree: 1, octave: 1, maxGain: 0.24, detuneCents: 7, filterMul: 8 },
  /** A narrow band of noise that widens with the wait queues. */
  contention: { id: 'contention', kind: 'noise', degree: 0, octave: 2, maxGain: 0.18, detuneCents: 0, filterMul: 1 },
  /** The minor seventh, two octaves up. Swells and decays; never sustained. */
  alarm: { id: 'alarm', kind: 'drone', degree: 4, octave: 2, maxGain: 0.34, detuneCents: 9, filterMul: 10 },
};

export interface LayerTargets {
  bed: number;
  pulse: number;
  strain: number;
  contention: number;
  alarm: number;
}

export function makeTargets(): LayerTargets {
  return { bed: 1, pulse: 0, strain: 0, contention: 0, alarm: 0 };
}
