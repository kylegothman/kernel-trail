/**
 * Pitch material. Package section 4: one mode across the whole game so layered
 * cues never clash, a minor pentatonic over a root the leg supplies, every pitch
 * computed from the root so transposing a leg is one number.
 */

/** A2. Low enough to be the bed, high enough that a fifth above is not mud. */
export const DEFAULT_ROOT_MIDI = 45;

/** Semitone offsets of the minor pentatonic within one octave. */
export const MINOR_PENTATONIC: readonly number[] = [0, 3, 5, 7, 10];

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Scale degree to MIDI note. Degrees wrap into octaves; negative degrees descend. */
export function degreeToMidi(rootMidi: number, degree: number, octave = 0): number {
  const n = MINOR_PENTATONIC.length;
  const wrapped = ((degree % n) + n) % n;
  const octaves = Math.floor(degree / n) + octave;
  const step = MINOR_PENTATONIC[wrapped];
  if (step === undefined) throw new Error('tuning: degree out of range');
  return rootMidi + octaves * 12 + step;
}

export function pitchHz(rootMidi: number, degree: number, octave = 0): number {
  return midiToHz(degreeToMidi(rootMidi, degree, octave));
}

/**
 * Two octaves of the mode, so ten siblings are distinguishable before a pitch
 * repeats. Pids are dense integers, so neighbours land on neighbouring degrees.
 */
export function pidToDegree(pid: number): number {
  return ((pid % 10) + 10) % 10;
}

export function pitchForPid(rootMidi: number, pid: number, octave = 1): number {
  return pitchHz(rootMidi, pidToDegree(pid), octave);
}

/** Frequency ratio of a detune in cents. */
export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}
