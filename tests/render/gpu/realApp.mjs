import assert from 'node:assert/strict';
import { capturePageDiagnostics, formatPageDiagnostics } from './harness.ts';
import { installGpuValidation } from './validation.ts';

/**
 * Navigate the actual index/main/title/session path without injected legs or clocks.
 * WP-23 section 2: `options.scale` multiplies the frame-settle wait under --ci and
 * `options.tiers` limits the qualities selected through the title UI; `auto` always runs.
 */
export async function runRealApp(browser, baseUrl, webgpuAvailable, options = {}) {
  const scale = options.scale ?? 1;
  const qualities = ['auto', ...(options.tiers ?? ['low', 'medium', 'high'])];
  const results = [], failures = [];
  for (const backend of webgpuAvailable ? ['webgpu', 'webgl2'] : ['webgl2']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    if (backend === 'webgl2') await context.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    });
    await context.addInitScript(installGpuValidation);
    try {
      // Auto starts with empty storage and runs the real benchmark. Subsequent
      // pages use its cache, then select each tier through the real title UI.
      for (const quality of qualities) {
        const path = `wp22-real-app-${backend}-${quality}`;
        const page = await context.newPage();
        const diagnostics = capturePageDiagnostics(page);
        try {
          console.log(`Starting ${path}`);
          await page.goto(`${baseUrl}/?seed=77`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.getByRole('button', { name: 'New run', exact: true }).waitFor({ timeout: 60_000 });
          await page.evaluate(() => globalThis.__kernelTrailGpuValidation.setPhase('title'));
          await page.locator('select[name="quality"]').selectOption(quality);
          await page.evaluate(value => globalThis.__kernelTrailGpuValidation.setPhase(`boot-sector:${value}`), quality);
          await page.getByRole('button', { name: 'New run', exact: true }).click();
          await waitForLegRail(page, 'The Boot Sector', 60_000);
          await settleFrames(page, 120, scale);
          await page.evaluate(value => globalThis.__kernelTrailGpuValidation.setPhase(`resize:${value}`), quality);
          await page.setViewportSize({ width: 1200, height: 1533 });
          await settleFrames(page, 2, scale);
          const resizeNotice = await page.locator('.kt-resize-status').allTextContents();
          await page.setViewportSize({ width: 1440, height: 900 });
          await settleFrames(page, 2, scale);
          await page.waitForFunction(() => document.querySelector('.kt-resize-status') === null, undefined, { timeout: 60_000 });
          assert.equal(await page.locator('.kt-card--panic').count(), 0, `${path}: resize recovery`);
          const validation = await page.evaluate(() => globalThis.__kernelTrailGpuValidation.snapshot());
          const tier = await page.evaluate(() => JSON.parse(localStorage.getItem('kt.tier.v1') ?? 'null')?.tier);
          const result = { path, backend, requestedQuality: quality, tier, frames: 120, devicePixelRatio: 2, resizeNotice, validation };
          console.log(`${path}:`, JSON.stringify(result));
          results.push(result);
          assert.deepEqual(validation, [], `${path}: native GPU validation`);
          assert.equal(diagnostics.pageErrors.length, 0, `${path}: page errors`);
          assert.deepEqual(diagnostics.messages.filter(message => message.startsWith('[console.error]')), [], `${path}: console errors`);
        } catch (error) {
          const validation = await page.evaluate(() => globalThis.__kernelTrailGpuValidation?.snapshot()).catch(() => null);
          console.error(`${path} native validation:`, JSON.stringify(validation));
          console.error(formatPageDiagnostics(diagnostics));
          failures.push(`${path}: ${error.stack || String(error)}`);
        } finally { await page.close(); }
      }
    } finally { await context.close(); }
  }
  return { results, failures };
}

/** The title screen has gone, the leg rail names the leg and the interaction panel is mounted (WP-23 section 1 reuses this). */
export async function waitForLegRail(page, title, timeout) {
  await page.waitForFunction(expected => document.querySelector('.kt-title-screen') === null &&
    document.querySelector('.kt-tl')?.textContent?.includes(expected) &&
    document.querySelector('.kt-panel--interactions') !== null, title, { timeout });
}

export async function settleFrames(page, count, scale = 1) {
  await page.evaluate(async ([count, scale]) => {
            let timer;
            try {
              await Promise.race([
                (async () => {
                  for (let frame = 0; frame < count; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
                  await globalThis.__kernelTrailGpuValidation.flush();
                })(),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Real app frames or GPU completion stalled within ${60 * scale} s`)), 60_000 * scale); }),
              ]);
            } finally { clearTimeout(timer); }
  }, [count, scale]);
}
