/**
 * Synthesised UI sounds for the HUD, the terminal and the codex, WP-16
 * section 7, re-voiced by WP-25 section 5 into the current leg's key: the
 * accept and the focus pair move between the tonic and the fifth, the alert
 * is the third under the sixth, the reject is the palette's shaped burst.
 * Quiet, short, and the focus pair lasts exactly the camera's 520 ms engage
 * and 380 ms release. `keyTick` is the one sound left as WP-16 made it,
 * because a terminal should sound like a terminal. The ids are unchanged.
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
