/** Browser controls. Inputs change models; the session commits DOM after render. */
import { Vector3 } from 'three/webgpu';
import { CAMERA } from '@design';
import type { FocusCameraRig } from '@render';
import type { Terminal } from '@terminal/Terminal';
import { PLAYER_TIME_SCALES, ticksPerSecondOf, type Pacing } from './pacing';
import type { LayoutStructure } from './stage/LayoutStructure';

export interface CameraTarget {
  readonly focus: Vector3;
  yawRad: number;
  pitchRad: number;
  distanceM: number;
}

export function installInput(options: {
  readonly document: Document;
  readonly canvas: HTMLCanvasElement;
  /** WP-24 section 1: Space toggles the `player` hold; the brackets step through PLAYER_TIME_SCALES. */
  readonly pacing: Pacing;
  readonly focus: FocusCameraRig;
  readonly target: CameraTarget;
  readonly structures: () => readonly LayoutStructure[];
  readonly terminal: () => Terminal | null;
  readonly toggleCodex: () => void;
  readonly commit: (write: () => void) => void;
  readonly controlsBlocked?: () => boolean;
}): () => void {
  const position = new Vector3();
  const editable = (): boolean => {
    const active = options.document.activeElement;
    return active !== null && (options.terminal()?.element.contains(active) === true ||
      active.matches('input, textarea, select, [contenteditable="true"]'));
  };
  const rates = PLAYER_TIME_SCALES.map(ticksPerSecondOf);
  let releasePlayer: (() => void) | null = null;
  const togglePause = (): void => {
    if (options.controlsBlocked?.() === true) return;
    if (releasePlayer === null) releasePlayer = options.pacing.hold('player');
    else { releasePlayer(); releasePlayer = null; }
  };
  /** The index of the rate the player last chose, whatever holds are stacked on it; the default is the middle scale. */
  let chosen = 1;
  const step = (direction: 1 | -1): void => {
    if (options.controlsBlocked?.() === true) return;
    chosen = Math.max(0, Math.min(rates.length - 1, chosen + direction));
    const rate = rates[chosen];
    if (rate !== undefined) options.pacing.setRate(rate);
  };
  const key = (event: KeyboardEvent): void => {
    if (editable() || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.code) {
      case 'Backquote': options.commit(() => options.terminal()?.toggle()); break;
      case 'KeyC': options.toggleCodex(); break;
      case 'KeyF': {
        if (options.focus.state.mode !== 'free' && options.focus.state.mode !== 'releasing') options.focus.release();
        else {
          let nearest: LayoutStructure | undefined;
          let distance = Infinity;
          for (const structure of options.structures()) {
            structure.focusTarget.anchor.getWorldPosition(position);
            const next = position.distanceToSquared(options.focus.camera.position);
            if (next < distance) { nearest = structure; distance = next; }
          }
          if (nearest !== undefined) options.focus.engage(nearest.id);
        }
        break;
      }
      case 'Space': togglePause(); break;
      case 'BracketRight': step(1); break;
      case 'BracketLeft': step(-1); break;
      default: return;
    }
    event.preventDefault();
  };
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || options.focus.state.mode !== 'free') return;
    dragging = true; lastX = event.clientX; lastY = event.clientY;
    options.canvas.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent): void => {
    if (!dragging || options.focus.state.mode !== 'free') return;
    options.target.yawRad -= (event.clientX - lastX) * 0.005;
    options.target.pitchRad = Math.max(CAMERA.pitchMinDeg * Math.PI / 180, Math.min(CAMERA.pitchMaxDeg * Math.PI / 180,
      options.target.pitchRad + (event.clientY - lastY) * 0.005));
    lastX = event.clientX; lastY = event.clientY;
  };
  const up = (): void => { dragging = false; };
  const wheel = (event: WheelEvent): void => {
    if (options.focus.state.mode !== 'free') return;
    event.preventDefault();
    options.target.distanceM = Math.max(CAMERA.distanceMinM, Math.min(CAMERA.distanceMaxM,
      options.target.distanceM * Math.exp(event.deltaY * 0.001)));
  };
  options.document.addEventListener('keydown', key);
  options.canvas.addEventListener('pointerdown', down);
  options.canvas.addEventListener('pointermove', move);
  options.canvas.addEventListener('pointerup', up);
  options.canvas.addEventListener('pointercancel', up);
  options.canvas.addEventListener('wheel', wheel, { passive: false });
  return () => {
    releasePlayer?.(); releasePlayer = null;
    options.document.removeEventListener('keydown', key);
    options.canvas.removeEventListener('pointerdown', down);
    options.canvas.removeEventListener('pointermove', move);
    options.canvas.removeEventListener('pointerup', up);
    options.canvas.removeEventListener('pointercancel', up);
    options.canvas.removeEventListener('wheel', wheel);
  };
}
