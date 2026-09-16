/**
 * Plain DOM title stand-in. A later interface pass replaces its presentation
 * without changing run selection, save validation, or the start gesture.
 */
import { LEG_ORDER, type DifficultyTier, type DiscClass, type SaveFile } from '@game/types';
import type { StoredSave } from '@game/save';
import { loadOutcome } from '@game/persist/LoadService';
import { LEG_LOADERS } from '@legs/registry';
import { PROFILES, setUserTier, type QualityTier } from '@platform/index';
import { CYAN, FONT_STACK, SLATE, VOID, cssColor } from '@design';
import type { BootContext, SessionStart } from '../boot';

const DISC_OPTIONS: readonly DiscClass[] = ['shell', 'daemon', 'compiler'];
const DIFFICULTY_OPTIONS: readonly DifficultyTier[] = ['novice', 'operator', 'architect', 'kernel_space'];
const QUALITY_OPTIONS: readonly (QualityTier | 'auto')[] = ['auto', 'low', 'medium', 'high'];
const LEG_LOAD_TIMEOUT_MS = 10_000;

export interface TitleScreen {
  readonly element: HTMLElement;
  /** The saved-run availability check, exposed so hosts can observe its completion. */
  readonly ready: Promise<void>;
  dispose(): void;
}

export type StartFromTitle = (start: SessionStart, boot: BootContext) => void | Promise<unknown>;

function select<T extends string>(doc: Document, labelText: string, choices: readonly T[], value: T): {
  readonly label: HTMLLabelElement;
  readonly control: HTMLSelectElement;
  value(): T;
} {
  const label = doc.createElement('label');
  label.textContent = labelText;
  label.style.cssText = `display:grid;gap:6px;margin:14px 0;color:${cssColor(SLATE.primary)};font:13px ${FONT_STACK.mono}`;
  const control = doc.createElement('select');
  control.name = labelText.toLowerCase().replaceAll(' ', '-');
  control.style.cssText = `padding:9px;background:${cssColor(VOID.base)};color:${cssColor(SLATE.primary)};border:1px solid ${cssColor(CYAN.dim)};font:inherit`;
  for (const choice of choices) {
    const option = doc.createElement('option');
    option.value = choice;
    option.textContent = choice.replaceAll('_', ' ');
    control.append(option);
  }
  control.value = value;
  label.append(control);
  return { label, control, value: () => choices.find(choice => choice === control.value) ?? value };
}

function button(doc: Document, text: string): HTMLButtonElement {
  const element = doc.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.style.cssText = `padding:10px 16px;background:${cssColor(VOID.base)};color:${cssColor(SLATE.primary)};border:1px solid ${cssColor(CYAN.dim)};font:14px ${FONT_STACK.mono};cursor:pointer`;
  return element;
}

/** A query override is numeric and unsigned, matching the generated 32-bit seed. */
export function seedForNewRun(search: string): number {
  const override = new URLSearchParams(search).get('seed');
  if (override !== null) {
    const seed = Number(override);
    if (override.trim() === '' || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new Error('Seed must be an integer from 0 to 4294967295.');
    }
    return seed;
  }
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Leg load timed out.')), LEG_LOAD_TIMEOUT_MS);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** No modal role, backdrop or focus trap. The callback runs in the click gesture. */
export function mountTitleScreen(boot: BootContext, onStart: StartFromTitle): TitleScreen {
  const doc = boot.overlay.ownerDocument;
  const element = doc.createElement('section');
  element.className = 'kt-title-screen';
  element.style.cssText = `pointer-events:auto;position:absolute;top:12%;left:50%;transform:translateX(-50%);width:min(420px,calc(100% - 48px));box-sizing:border-box;padding:28px;background:${cssColor(VOID.base, 0.95)};border:1px solid ${cssColor(CYAN.dim)};color:${cssColor(SLATE.primary)};font-family:${FONT_STACK.mono}`;
  const heading = doc.createElement('h1');
  heading.textContent = 'KERNEL TRAIL';
  heading.style.cssText = `margin:0 0 24px;font:600 27px ${FONT_STACK.mono};letter-spacing:3px`;
  const disc = select(doc, 'Disc class', DISC_OPTIONS, 'shell');
  const difficulty = select(doc, 'Difficulty', DIFFICULTY_OPTIONS, 'operator');
  const quality = select(doc, 'Quality', QUALITY_OPTIONS, 'auto');
  const actions = doc.createElement('div');
  actions.style.cssText = 'display:flex;gap:12px;margin-top:24px;flex-wrap:wrap';
  const newRun = button(doc, 'New run');
  const continueRun = button(doc, 'Continue');
  continueRun.hidden = true;
  continueRun.disabled = true;
  const status = doc.createElement('p');
  status.className = 'kt-title-status';
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = `margin:18px 0 0;font:12px/1.6 ${FONT_STACK.mono};color:${cssColor(SLATE.primary)}`;
  actions.append(newRun, continueRun);
  element.append(heading, disc.label, difficulty.label, quality.label, actions, status);
  boot.overlay.append(element);

  let disposed = false;
  let starting = false;
  let saved: SaveFile | null = null;
  let canContinue = false;

  const controls = (disabled: boolean): void => {
    newRun.disabled = disabled;
    continueRun.disabled = disabled || !canContinue;
    disc.control.disabled = disabled;
    difficulty.control.disabled = disabled;
    quality.control.disabled = disabled;
  };
  const reportStartFailure = (error: unknown): void => {
    if (disposed) return;
    starting = false;
    controls(false);
    status.textContent = error instanceof Error ? error.message : String(error);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    newRun.removeEventListener('click', startNew);
    continueRun.removeEventListener('click', startSaved);
    element.remove();
  };
  const begin = (start: SessionStart): void => {
    if (disposed || starting) return;
    starting = true;
    controls(true);
    status.textContent = 'Starting run...';
    try {
      const chosen = quality.value();
      const tier = chosen === 'auto' ? boot.tier : setUserTier(boot.caps, boot.buildId, chosen).tier;
      boot.backend.setQuality(PROFILES[tier]);
      boot.backend.postChain?.setTier(tier);
      // Do not await anything before the callback: the session unlocks audio here.
      const started = onStart(start, { ...boot, tier });
      void Promise.resolve(started).then(dispose, reportStartFailure);
    } catch (error) { reportStartFailure(error); }
  };
  const startNew = (): void => {
    try {
      begin({ kind: 'new', seed: seedForNewRun(doc.defaultView?.location.search ?? ''), discClass: disc.value(), difficulty: difficulty.value() });
    } catch (error) { reportStartFailure(error); }
  };
  const startSaved = (): void => { if (saved !== null && canContinue) begin({ kind: 'resume', file: saved }); };
  newRun.addEventListener('click', startNew);
  continueRun.addEventListener('click', startSaved);

  const inspectSavedRun = async (): Promise<void> => {
    try {
      const records = await boot.db.list<StoredSave>('saves');
      records.sort((a, b) => b.savedAtIso.localeCompare(a.savedAtIso) || (a.kind === 'provisional' ? -1 : b.kind === 'provisional' ? 1 : 0));
      for (const record of records) {
        const outcome = await loadOutcome(boot.db, record.id);
        if ((outcome.kind === 'ok' || outcome.kind === 'repaired') && outcome.file.run.status === 'in_progress') {
          saved = outcome.file;
          break;
        }
      }
      if (disposed || starting || saved === null) return;
      continueRun.hidden = false;
      status.textContent = 'Checking the saved journey...';
      const ids = LEG_ORDER.slice(0, saved.run.legIndex + 1);
      const results = await Promise.allSettled(ids.map(id => withTimeout(Promise.resolve().then(() => LEG_LOADERS[id]()))));
      if (disposed || starting) return;
      const unavailable = ids.find((_id, index) => results[index]?.status === 'rejected');
      if (unavailable !== undefined) {
        status.textContent = `This save passed through ${unavailable}, which is not in this build`;
        return;
      }
      canContinue = true;
      continueRun.disabled = false;
      status.textContent = '';
    } catch (error) {
      if (!disposed && !starting) status.textContent = `The saved run could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return { element, ready: inspectSavedRun(), dispose };
}
