import { chromium } from 'playwright';
import { createServer, build } from 'vite';
import { resolve } from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { allocationProbe } from './allocationProbe.ts';
import { capturePageDiagnostics, formatPageDiagnostics, navigateAndWaitForProbe } from './harness.ts';

assert.equal(process.versions.node.split('.')[0], '22', `GPU tests require Node 22; running ${process.version}`);
const machine = { hostname: os.hostname(), cpu: os.cpus()[0]?.model, platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version };
console.log('GPU test machine:', JSON.stringify(machine));
await build({ plugins: [allocationProbe], build: {
  outDir: '/private/tmp/kt-wp12-gpu-build', emptyOutDir: true,
  rolldownOptions: { input: resolve('tests/render/gpu/probe.html') },
} });
if (process.argv.includes('--build-only')) process.exit(0);

const server = await createServer({ plugins: [allocationProbe], optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0 } });
let browser;
const results = [];
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  console.log('Chromium:', browser.version());
  for (const force of [false, true]) {
    const path = force ? 'forced-webgl2' : 'preferred';
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const diagnostics = capturePageDiagnostics(page);
    try {
      console.log(`Starting ${path} probe; waiting for explicit readiness`);
      await navigateAndWaitForProbe(page, `http://127.0.0.1:${address.port}/tests/render/gpu/probe.html${force ? '?webgl' : ''}`, diagnostics);
      const info = await page.evaluate(() => globalThis.__kernelTrailProbe.api.info());
      console.log('Probe ready:', JSON.stringify(info));
      results.push({ path, info });
      for (const [tier, calls, triangles] of [['low', 220, 180000], ['medium', 450, 450000], ['high', 900, 1100000]]) {
        const stats = await page.evaluate(t => globalThis.__kernelTrailProbe.api.tier(t), tier);
        console.log(`${path} ${tier}:`, JSON.stringify({ stats, budgets: { drawCalls: calls, triangles, targetMemoryBytes: 210 * 1024 * 1024 } }));
        assert(stats.drawCalls <= calls, `${path}/${tier}: draw-call budget`);
        assert(stats.triangles <= triangles, `${path}/${tier}: triangle budget`);
        assert(stats.targetMemoryBytes <= 210 * 1024 * 1024, `${path}/${tier}: target memory budget`);
        results.push({ path, tier, stats });
      }
      const allocations = await page.evaluate(() => globalThis.__kernelTrailProbe.api.allocations(300));
      console.log(`${path} 300-frame allocations:`, JSON.stringify(allocations));
      assert.deepEqual(allocations, { Matrix4: 0, Vector3: 0, Color: 0 });
      results.push({ path, frames: 300, allocations });
      if (!force) {
        const timing = await page.evaluate(() => globalThis.__kernelTrailProbe.api.timing());
        console.log('High-tier GPU milliseconds:', JSON.stringify(timing));
        results.push({ path, timing });
      } else {
        const recovery = await page.evaluate(() => globalThis.__kernelTrailProbe.api.recovery());
        console.log('Device loss:', JSON.stringify(recovery));
        assert.deepEqual(recovery, { attempts: [true], outcome: 'recovered_same', backend: 'webgl2' });
        results.push({ path, recovery });
      }
      await page.screenshot({ path: `/private/tmp/kt-wp12-${force ? 'webgl' : 'webgpu'}.png` });
      assert.equal(diagnostics.pageErrors.length, 0, 'Page errors during GPU assertions');
      assert.deepEqual(diagnostics.messages.filter(message => message.startsWith('[console.error]')), []);
      await page.evaluate(() => globalThis.__kernelTrailProbe.api.dispose());
    } catch (error) {
      console.error(`GPU test failed on ${path}:`, error.stack ?? error);
      console.error(formatPageDiagnostics(diagnostics));
      throw error;
    } finally {
      await page.close();
    }
  }
  await fs.writeFile('/private/tmp/kt-wp12-gpu-results.json', JSON.stringify({ machine, browser: browser.version(), results }, null, 2));
  console.log(`GPU tests passed: ${browser.version()}`);
} finally {
  await browser?.close();
  await server.close();
}
