/**
 * Audio-only synthesis constants. Pre-flight ruling C4: every beat shared with
 * the visuals comes from the frozen design tokens (`DUR`, `PULSE`,
 * `FOCUS_DURATION_MS`, `PANIC_POST.floodMs`, `DENIED_FLASH_MS`,
 * `CORRUPTION.rampInMs`); a number only the audio graph uses lives here, each
 * with the package line that states it. Nothing in this file is a motion token
 * and nothing here may be imported by another layer.
 */

/** Package line 161: ratio 20, knee 0, attack 0.003. Set once, never automated. */
export const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.1 } as const;

/** Package line 160: the per-bus compressor that keeps a busy bus from masking the others. */
export const BUS_COMPRESSOR = { threshold: -14, knee: 6, ratio: 4, attack: 0.01, release: 0.25 } as const;

/** Package line 172: impulse length by tier, seconds. Low tier bypasses the convolver. */
export const IMPULSE_SECONDS = { high: 1.8, medium: 0.9 } as const;

/** Package line 173: the low-tier delay pair that stands in for the convolver. */
export const LOW_TIER_DELAY = { seconds: 0.11, secondsB: 0.173, feedback: 0.32 } as const;

/** Package line 268: pan is clamped to plus or minus this. Never fully hard. */
export const PAN_CLAMP = 0.7;

/** Package line 228: the derezz pre-roll duck. Visual bible 9.4 gives the same 400 ms. */
export const DEREZZ_DUCK_MS = 400;

/** Package line 228: the restore after the tombstone. */
export const DEREZZ_RESTORE_MS = 1200;

/** Visual bible 9.4: the tombstone rises 3900 ms after the fracture begins. */
export const TOMBSTONE_AFTER_FRACTURE_MS = 3900;

/** Package line 259: every voice sustains and stops moving for this long. */
export const DEADLOCK_HOLD_MS = 600;

/** Visual bible 8.4 and Appendix A: a dirty eviction takes 220 ms longer. */
export const DIRTY_EVICT_EXTRA_MS = 220;

/** Package line 194: never ramp exponentially to or from zero. */
export const MIN_EXP_TARGET = 1e-4;

/** Package line 250: seek sweep duration is proportional to distance. */
export const SEEK_SWEEP = { baseMs: 40, msPerCylinder: 3, maxMs: 900 } as const;

/** Architecture 3.7: 500 faults in a frame is full intensity, and four grains sound at once. */
export const FAULT_DENSITY = { fullAtFaults: 400, maxGrainsPerSecond: 40 } as const;

/** Package line 262: interrupt ticks per frame before the density alone reads as a buzz. */
export const INTERRUPT_TICKS_PER_FRAME = 6;

/** Granular slots per voice and grain lengths, milliseconds. Pre-flight D1. */
export const GRAIN = { slotsPerVoice: 4, minMs: 12, maxMs: 45, lookaheadMs: 120 } as const;

/** Seconds of noise generated at boot. Two seconds loops without an audible period. */
export const NOISE_SECONDS = 2;

/** Seconds of grain material. Grains read short windows of it. */
export const GRAIN_BUFFER_SECONDS = 1;

/** Send level from each bus into the space. */
export const SEND_LEVEL = 0.16;

/** Package section 5: the pulse gate rate window and duty cycle. */
export const PULSE_GATE = { minHz: 0.5, maxHz: 6, duty: 0.4, switchesPerSecondAtMax: 40 } as const;

/** Package section 9: reduced motion halves every envelope time. */
export const REDUCED_MOTION_ENVELOPE_SCALE = 0.5;

/** Package section 5: `pulse` fades in above this cpu utilisation. */
export const PULSE_CPU_THRESHOLD = 0.25;

/** Package section 5: `contention` is fully open at this total wait-queue depth. */
export const CONTENTION_FULL_DEPTH = 8;

/** Cents of detune between the two oscillators of a race-detected pair. */
export const RACE_BEAT_CENTS = 14;

/** Cents the strain layer detunes against the bed at full strain. */
export const STRAIN_DETUNE_CENTS = 28;
