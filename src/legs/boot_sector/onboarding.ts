/**
 * The tutorial's eight beats as data (pre-flight ruling 8). The boot package
 * drives them; the leg holds only the sequence, its entry and exit
 * conditions, and the timings the package fixes. Nothing here is a modal
 * dialogue or a tooltip overlay: every instruction is a diegetic object or a
 * line of terminal output. Every beat may be skipped once the profile records
 * one completed Boot Sector, and none may be skipped before.
 */
export interface OnboardingBeat {
  readonly id: string;
  readonly title: string;
  readonly entry: string;
  readonly world: string;
  readonly playerMust: string;
  /**
   * WP-24 ruling: one sentence saying what the player must do next, naming
   * the input (click, key, verb). The boot package shows it on a card while
   * the beat is active and as the HUD line after `hintAfterMs`.
   */
  readonly hint: string;
  readonly exit: string;
  /** The only non-interactive beat carries a fixed duration; the rest end on their exit condition. */
  readonly durationMs: number | null;
  /** The hint the world offers after this many milliseconds without the expected action, or null. */
  readonly hintAfterMs: number | null;
}

/** The module the grid floor writes itself on, visual bible 10 and the beat 1 ring radius. */
export const MODULE_METRES = 4;
/** Each stele takes this long to light in beat 3. */
export const STELE_LIGHT_MS = 400;

export const ONBOARDING: readonly OnboardingBeat[] = [
  { id: 'beat.void', title: 'Nothing exists', entry: 'run start', world: 'Black void. A single ring of light under the convoy at the module radius, five stele unlit.', playerMust: 'nothing', hint: 'Nothing to press yet. The floor is about to write itself.', exit: 'the grid floor begins writing itself', durationMs: 3000, hintAfterMs: null },
  { id: 'beat.floor', title: 'The floor writes itself', entry: 'beat 1 timer expires', world: 'The grid floor writes outward ring by ring on the module until it reaches the horizon; concentric rings stack above as subsystems come up.', playerMust: 'nothing; camera orbit is added', hint: 'Drag on the floor to orbit the camera.', exit: 'the floor reaches the horizon', durationMs: null, hintAfterMs: 6000 },
  { id: 'beat.convoy', title: 'The convoy lights', entry: 'floor complete', world: 'The five stele light in roster order and the HUD convoy panel gains one row each.', playerMust: 'click one stele', hint: 'Click a stele to inspect a convoy member.', exit: 'the focus camera locks to that stele, head-on and orthographic', durationMs: null, hintAfterMs: 6000 },
  { id: 'beat.reach', title: 'The reach', entry: 'focus released', world: 'A stack of storage blocks within arm reach, closer and warmer than the depot, labelled blocks.', playerMust: 'reach for them', hint: 'Press F to release the lock, then use the Take the blocks verb to reach for them.', exit: 'a hard stop and one line: EPERM. man EPERM.', durationMs: null, hintAfterMs: 20000 },
  { id: 'beat.terminal', title: 'The terminal', entry: 'EPERM shown', world: 'The terminal affordance lights for the first time with a single character prompt.', playerMust: 'open the terminal and type anything', hint: 'Press ` to open the terminal, then type man EPERM.', exit: 'the player runs man EPERM', durationMs: null, hintAfterMs: null },
  { id: 'beat.trap', title: 'The trap', entry: 'at least one man page read', world: 'The depot opens: six windows, each with a kernel and user toggle, the queue drawn on the ground.', playerMust: 'make one purchase through a window', hint: 'Set a window to kernel, click Add, then click Submit.', exit: 'a successful submission; the Program enters ring 0 for four ticks and leaves', durationMs: null, hintAfterMs: null },
  { id: 'beat.batching', title: 'The batching lesson', entry: 'first successful purchase', world: 'The depot signage states the trap price once.', playerMust: 'complete outfitting', hint: 'Read the signage, finish outfitting, then click Close.', exit: 'the player closes the requisition', durationMs: null, hintAfterMs: null },
  { id: 'beat.gate', title: 'The disc class gate', entry: 'requisition closed', world: 'Three discs on a plinth, each stating its ledger and multiplier.', playerMust: 'confirm the class and name the resource it is short of', hint: 'Click the resource this disc class is short of.', exit: 'the leg ends and evaluate runs', durationMs: null, hintAfterMs: null },
];
