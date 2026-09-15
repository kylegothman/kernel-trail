/**
 * Synthesised UI sounds for the HUD, the terminal and the codex, package
 * section 7. Quiet, short, in the game's tuning, and the focus pair lasts
 * exactly the camera's 520 ms engage and 380 ms release.
 */
import type { SoundBank } from '../events/eventSounds';

export type UiSoundId = 'keyTick' | 'commandAccept' | 'commandReject' | 'alertAppear' | 'focusEngage' | 'focusRelease';
export const UI_SOUND_IDS: readonly UiSoundId[] = ['keyTick', 'commandAccept', 'commandReject', 'alertAppear', 'focusEngage', 'focusRelease'];

export class UiSounds {
  constructor(private readonly bank: SoundBank) {}

  play(id: UiSoundId): void {
    switch (id) {
      case 'keyTick': this.bank.uiKeyTick(); return;
      case 'commandAccept': this.bank.uiCommandAccept(); return;
      case 'commandReject': this.bank.uiCommandReject(); return;
      case 'alertAppear': this.bank.uiAlertAppear(); return;
      case 'focusEngage': this.bank.uiFocusEngage(); return;
      case 'focusRelease': this.bank.uiFocusRelease(); return;
      default: return;
    }
  }

  keyTick(): void { this.play('keyTick'); }
  commandAccept(): void { this.play('commandAccept'); }
  commandReject(): void { this.play('commandReject'); }
  alertAppear(): void { this.play('alertAppear'); }
  focusEngage(): void { this.play('focusEngage'); }
  focusRelease(): void { this.play('focusRelease'); }
}
