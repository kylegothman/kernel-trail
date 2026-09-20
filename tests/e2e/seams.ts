/**
 * WP-23 section 1: typed access to the debug seam from the Node side of the
 * playthrough. The seam is `KernelTrailDebug` from `src/app/BrowserSession.ts`,
 * attached by `src/main.ts` at `globalThis.__kernelTrailDebug` in a
 * development build only. Every function here evaluates in the page and
 * reads; nothing writes through the seam. The type import is erased, so this
 * file loads under Node's type stripping with no path alias.
 */
import type { Page } from 'playwright';
import type { KernelTrailDebug } from '../../src/app/BrowserSession';

export interface SeamSnapshot {
  readonly buildId: string;
  readonly legId: ReturnType<KernelTrailDebug['legId']>;
  readonly tick: number;
  readonly phase: ReturnType<KernelTrailDebug['phase']>;
  readonly logHash: string;
  readonly legHashes: ReturnType<KernelTrailDebug['legHashes']>;
}

type SeamWindow = typeof globalThis & { __kernelTrailDebug?: KernelTrailDebug };

/** Resolves once a session has attached the seam; rejects on the timeout. */
export async function waitForSeam(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(() => (globalThis as SeamWindow).__kernelTrailDebug !== undefined, undefined, { timeout, polling: 50 });
}

/** One atomic read of every scalar surface: the page's loop cannot advance between the fields. */
export function readSeam(page: Page): Promise<SeamSnapshot> {
  return page.evaluate(() => {
    const seam = (globalThis as SeamWindow).__kernelTrailDebug;
    if (seam === undefined) throw new Error('The debug seam is not attached; is this a development build?');
    return { buildId: seam.buildId, legId: seam.legId(), tick: seam.tick(), phase: seam.phase(), logHash: seam.logHash(), legHashes: seam.legHashes() };
  });
}

/** Resolves when the seam's tick reaches `tick`, polling on a real timer. */
export async function waitForTick(page: Page, tick: number, timeout: number): Promise<void> {
  await page.waitForFunction(target => ((globalThis as SeamWindow).__kernelTrailDebug?.tick() ?? -1) >= target, tick, { timeout, polling: 50 });
}

/**
 * The reload proof's atomic pre-reload read. The listener runs after the
 * session's own pagehide handler has taken the provisional save and no frame
 * can run in between, so the tick and hash it records describe exactly the
 * saved state. The value survives the reload in sessionStorage, which is the
 * test's own storage and not the seam's.
 */
export const PRE_RELOAD_KEY = 'kt.e2e.preReload';

export async function armPreReloadCapture(page: Page): Promise<void> {
  await page.evaluate(key => {
    window.addEventListener('pagehide', () => {
      const seam = (globalThis as SeamWindow).__kernelTrailDebug;
      if (seam === undefined) return;
      sessionStorage.setItem(key, JSON.stringify({ tick: seam.tick(), logHash: seam.logHash() }));
    });
  }, PRE_RELOAD_KEY);
}

export async function readPreReloadCapture(page: Page): Promise<{ readonly tick: number; readonly logHash: string } | null> {
  const raw = await page.evaluate(key => sessionStorage.getItem(key), PRE_RELOAD_KEY);
  return raw === null ? null : (JSON.parse(raw) as { tick: number; logHash: string });
}
