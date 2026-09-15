/**
 * The audio surface the HUD, the codex and the cards may touch. Scope
 * correction S10: `src/ui` does not import `@audio`; the host passes the
 * engine's `ui` cue methods and `unlock` in, and the fixtures pass spies.
 */
export interface UiSounds {
  /** Called from the first pointer or key handler so the audio context may start. */
  unlock(): void;
  keyTick(): void;
  commandAccept(): void;
  commandReject(): void;
  alertAppear(): void;
  focusEngage(): void;
  focusRelease(): void;
}

export const SILENT_SOUNDS: UiSounds = {
  unlock: () => undefined,
  keyTick: () => undefined,
  commandAccept: () => undefined,
  commandReject: () => undefined,
  alertAppear: () => undefined,
  focusEngage: () => undefined,
  focusRelease: () => undefined,
};
