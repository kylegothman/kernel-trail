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
  rolldownOptions: { input: [resolve('tests/render/gpu/probe.html'),resolve('tests/render/gpu/focus.html')] },
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
  for (const force of webgpuAvailable ? [false, true] : [true]) for(const tier of ['low','medium','high']) {
    const path=`wp13-${force?'webgl2':'webgpu'}-${tier}`;
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const diagnostics=capturePageDiagnostics(page);
    await page.addInitScript(installWebGPUDiagnostics);
    try {
      await page.exposeFunction('__wp13Capture',async phase=>{assert(['front','occluded','released'].includes(phase));await page.screenshot({path:`/private/tmp/kt-${path}-${phase}.png`});});
      console.log(`Starting ${path}`);
      await navigateAndWaitForProbe(page,`http://127.0.0.1:${address.port}/tests/render/gpu/focus.html?tier=${tier}${force?'&webgl':''}`,diagnostics);
      const info=await page.evaluate(()=>globalThis.__kernelTrailProbe.api.info());
      assert.equal(info.backend,force?'webgl2':'webgpu');
      const result=await page.evaluate(()=>globalThis.__kernelTrailProbe.api.run());
      console.log(`${path}:`,JSON.stringify(result));results.push({path,result});
      await page.screenshot({path:`/private/tmp/kt-${path}.png`});
      assert.equal(diagnostics.pageErrors.length,0,'WP-13 page errors');
      assert.deepEqual(diagnostics.messages.filter(message=>message.startsWith('[console.error]')),[]);
      await page.evaluate(()=>globalThis.__kernelTrailProbe.api.dispose());
    } catch(error) {
      console.error(`GPU test failed on ${path}:`,error.stack||String(error));
      console.error(formatPageDiagnostics(diagnostics));failures.push(`${path}: ${error.stack||String(error)}`);
    } finally {await page.close();}
  }
  // WP-16 audio probe. One page, a real click for the autoplay gesture, then
  // the assertions the package sends to the browser: no context before the
  // gesture, running after it, a two-second run with no page error, buffer
  // timing on both threads, and the always-running pool's cost per quantum.
  {
    const audioPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const audioDiagnostics = capturePageDiagnostics(audioPage);
    try {
      console.log('Starting audio probe; waiting for readiness');
      await audioPage.goto(`http://127.0.0.1:${address.port}/tests/render/gpu/audio.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await audioPage.waitForFunction(() => globalThis.__kernelTrailAudioProbe?.status === 'ready' || globalThis.__kernelTrailAudioProbe?.status === 'failed', undefined, { timeout: 60_000 });
      const boot = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe);
      if (boot.status === 'failed') throw new Error(`Audio probe failed to initialise: ${boot.error?.message}\n${boot.error?.stack}`);
      const before = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe.api.info());
      assert.equal(before.state, 'unstarted', 'no audio context may exist before the gesture');
      assert.equal(before.constructions, 0, 'no audio context may be constructed before the gesture');
      const droppedBefore = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe.api.poke());
      assert.equal(droppedBefore, 1, 'a cue before the gesture is dropped and counted');
      await audioPage.click('#unlock');
      await audioPage.waitForFunction(() => globalThis.__kernelTrailAudioProbe.api.info().state === 'running', undefined, { timeout: 10_000 });
      const after = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe.api.info());
      console.log('Audio context after gesture:', JSON.stringify(after));
      assert.equal(after.constructions, 1);
      const run = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe.api.run(2));
      console.log('Audio two-second run:', JSON.stringify(run));
      assert.equal(run.state, 'running', 'the context must stay running through the run');
      assert.equal(run.consumerErrors, 0, 'the consumer must not record an error');
      assert(run.cuesPlayed > 50, 'the run must play cues');
      assert(run.voicesPeak <= 64, 'the high-tier voice cap');
      const timing = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe.api.timing());
      console.log('generateBuffers timing (browser):', JSON.stringify(timing));
      assert.equal(timing.identical, true, 'worker and main-thread buffers must be byte-identical');
      const cost = {};
      for (const tier of ['low', 'medium', 'high']) {
        cost[tier] = await audioPage.evaluate(t => globalThis.__kernelTrailAudioProbe.api.cost(t), tier);
        console.log(`Audio pool cost ${tier}:`, JSON.stringify(cost[tier]));
        assert(cost[tier].peakSample > 0, `${tier}: the offline render must produce signal`);
        // A DynamicsCompressorNode is not a brick wall: Chrome applies makeup gain
        // past the threshold and the mandated 3 ms attack passes a transient's
        // first samples, so a 500-cue-per-second burst overshoots by a fraction of
        // a decibel before the destination clamps. Within 1 dB is the limiter working.
        assert(cost[tier].peakSample <= 1.122, `${tier}: the limiter must hold peaks within 1 dB of full scale, got ${cost[tier].peakSample}`);
      }
      if (cost.high.msPerQuantum > 2) {
        console.log(`WARNING: high tier always-running pool costs ${cost.high.msPerQuantum.toFixed(3)} ms per ${cost.high.quantumMs.toFixed(3)} ms render quantum, above the 2 ms line`);
      }
      results.push({ audio: { before, after, run, timing, cost } });
      await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe.api.dispose());
      assert.equal(audioDiagnostics.pageErrors.length, 0, 'Page errors during audio assertions');
      assert.deepEqual(audioDiagnostics.messages.filter(message => message.startsWith('[console.error]')), []);
      console.log('Audio probe passed');
    } catch (error) {
      console.error('Audio probe failed:', error.stack || String(error));
      console.error(formatPageDiagnostics(audioDiagnostics));
      failures.push(`audio: ${error.stack || String(error)}`);
    } finally {
      await audioPage.close();
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
