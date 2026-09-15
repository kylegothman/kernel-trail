import { chromium } from 'playwright';
import { createServer, build } from 'vite';
import { resolve } from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { installWebGPUDiagnostics, checkWebGPUEnvironment } from './webgpuDiagnostics.ts';
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
const failures = [];
const headed = process.argv.includes('--headed');
let environmentPage;
let environmentDiagnostics;
let webgpuAvailable = false;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  browser = await chromium.launch({ channel: 'chromium', headless: !headed, args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal'] });
  console.log('Chromium:', browser.version());
  environmentPage = await browser.newPage();
  environmentDiagnostics = capturePageDiagnostics(environmentPage);
  await environmentPage.addInitScript(installWebGPUDiagnostics);
  try {
    await environmentPage.goto(`http://127.0.0.1:${address.port}/tests/render/gpu/preflight.html`);
    let environmentTimer;
    const environment = await Promise.race([
      environmentPage.evaluate(checkWebGPUEnvironment),
      environmentDiagnostics.firstPageError.then(error => { throw error; }),
      new Promise((_, reject) => { environmentTimer = setTimeout(() => reject(new Error('GPU environment preflight timed out after 60 seconds')), 60000); }),
    ]).finally(() => clearTimeout(environmentTimer));
    console.log('WebGPU environment:', JSON.stringify(environment));
    results.push({ environment });
    webgpuAvailable = environment.status === 'available';
    if (environment.status === 'no-adapter') {
      console.log(headed ? 'No WebGPU adapter is available in headed Chromium.' : 'No WebGPU adapter is available in headless Chromium.');
      console.log('Recording an environment limitation; running forced-WebGL2 separately. WebGPU results require a headed rerun.');
    } else if (!webgpuAvailable) failures.push('WebGPU preflight device lost before any renderer loaded');
  } catch (error) {
    failures.push(`WebGPU environment preflight: ${error.stack || String(error)}`);
    console.error(failures.at(-1));
    console.error(formatPageDiagnostics(environmentDiagnostics));
  }
  for (const force of webgpuAvailable ? [false, true] : [true]) {
    const path = force ? 'forced-webgl2' : 'preferred';
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const diagnostics = capturePageDiagnostics(page);
    await page.addInitScript(installWebGPUDiagnostics);
    try {
      console.log(`Starting ${path} probe; waiting for explicit readiness`);
      await navigateAndWaitForProbe(page, `http://127.0.0.1:${address.port}/tests/render/gpu/probe.html${force ? '?webgl' : ''}`, diagnostics);
      const info = await page.evaluate(() => globalThis.__kernelTrailProbe.api.info());
      console.log('Probe ready:', JSON.stringify(info));
      results.push({ path, info });
      assert.equal(info.backend, force ? 'webgl2' : 'webgpu', `${path} must exercise the requested backend`);
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
      console.error(`GPU test failed on ${path}:`, error.stack || String(error));
      console.error(formatPageDiagnostics(diagnostics));
      failures.push(`${path}: ${error.stack || String(error)}`);
    } finally {
      await page.close();
    }
  }
  if (environmentDiagnostics.pageErrors.length) {
    failures.push('WebGPU environment page reported an error');
    console.error(formatPageDiagnostics(environmentDiagnostics));
  }
  const environmentLosses = await environmentPage.evaluate(() => globalThis.__kernelTrailDeviceLosses ?? []).catch(() => []);
  if(environmentLosses.length){console.error('Preflight device loss:',JSON.stringify(environmentLosses));failures.push('The preflight device lost its instance before cleanup');}
  // Loss reasons are streamed by the installed monitor; retain those messages in the result.
  await fs.writeFile('/private/tmp/kt-wp12-gpu-results.json', JSON.stringify({ machine, browser: browser.version(), headed, webgpuAvailable, results, failures, environmentMessages: environmentDiagnostics.messages, environmentLosses }, null, 2));
  if (failures.length) throw new Error(`GPU run failed:
${failures.join('\n')}`);
  console.log(webgpuAvailable ? `GPU tests passed: ${browser.version()}` : 'Forced-WebGL2 tests passed; WebGPU was unavailable and remains unvalidated.');
} finally {
  if (environmentPage && !environmentPage.isClosed()) {
    await environmentPage.evaluate(() => globalThis.__kernelTrailEnvironmentDevice?.device.destroy()).catch(() => {});
    await environmentPage.close();
  }
  await browser?.close();
  await server.close();
}
