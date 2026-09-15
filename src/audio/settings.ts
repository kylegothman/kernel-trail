/**
 * Player-facing audio settings, package section 9. WP-17 owns the settings
 * UI and the persistence store; it reads and writes the record below under
 * `AUDIO_SETTINGS_KEY` and calls `AudioEngine.applySettings`. None of these
 * change which events are consumed, so toggling them mid-run diverges nothing.
 */

export interface AudioSettings {
  /** 0 to 1, applied to the master gain. */
  readonly master: number;
  readonly score: number;
  readonly world: number;
  readonly ui: number;
  /** The `voice_alerts` bus. Pre-flight ruling C12. */
  readonly alerts: number;
  /** Halves every envelope time and removes the alarm swell. */
  readonly reducedMotion: boolean;
  /** Collapses every panner to centre. */
  readonly mono: boolean;
  /** Master gain to zero, graph intact, so unmute is instant. */
  readonly mute: boolean;
}

/** The key WP-17's `settings` store files this record under. */
export const AUDIO_SETTINGS_KEY = 'audio';

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = Object.freeze({
  master: 0.8,
  score: 0.7,
  world: 0.85,
  ui: 0.6,
  alerts: 0.8,
  reducedMotion: false,
  mono: false,
  mute: false,
});

function volume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Validate a persisted record. Anything malformed falls back field by field. */
export function normaliseAudioSettings(value: unknown, fallback: AudioSettings = DEFAULT_AUDIO_SETTINGS): AudioSettings {
  if (typeof value !== 'object' || value === null) return fallback;
  const r = value as Record<string, unknown>;
  return {
    master: volume(r['master'], fallback.master),
    score: volume(r['score'], fallback.score),
    world: volume(r['world'], fallback.world),
    ui: volume(r['ui'], fallback.ui),
    alerts: volume(r['alerts'], fallback.alerts),
    reducedMotion: flag(r['reducedMotion'], fallback.reducedMotion),
    mono: flag(r['mono'], fallback.mono),
    mute: flag(r['mute'], fallback.mute),
  };
}

/**
 * Read `prefers-reduced-motion` once. `matchMedia` is the one DOM call beyond
 * the audio context the package allows (acceptance criterion 5), and it is
 * a read, not a subscription (pre-flight ruling I1).
 */
export function detectReducedMotion(probe?: () => boolean): boolean {
  try {
    if (probe !== undefined) return probe();
    if (typeof matchMedia !== 'function') return false;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export type SettingsListener = (settings: AudioSettings) => void;

/** A small observable record. WP-17 persists what `get()` returns. */
export class AudioSettingsStore {
  private current: AudioSettings;
  private readonly listeners: SettingsListener[] = [];

  constructor(initial: Partial<AudioSettings> = {}) {
    this.current = normaliseAudioSettings({ ...DEFAULT_AUDIO_SETTINGS, ...initial });
  }

  get(): AudioSettings {
    return this.current;
  }

  update(patch: Partial<AudioSettings>): AudioSettings {
    this.current = normaliseAudioSettings({ ...this.current, ...patch }, this.current);
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch {
        // A listener that throws must not take the store down.
      }
    }
    return this.current;
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}
