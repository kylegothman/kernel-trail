import { chromium } from 'playwright';
import { createServer, build } from 'vite';
import { resolve, join } from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { installWebGPUDiagnostics, checkWebGPUEnvironment } from './webgpuDiagnostics.ts';
import { allocationProbe } from './allocationProbe.ts';
import { capturePageDiagnostics, formatPageDiagnostics, navigateAndWaitForProbe } from './harness.ts';
import { runRealApp } from './realApp.mjs';

assert.equal(process.versions.node.split('.')[0], '22', `GPU tests require Node 22; running ${process.version}`);

/**
 * WP-23 section 2: the one place a platform-specific launch flag lives. macOS
 * without --ci keeps the WebGPU-over-Metal launch that npm run test:gpu is the
 * evidence for. Everywhere else, and under --ci anywhere, Chromium runs its
 * software rasteriser over WebGL2 and WebGPU is not requested; the preflight
 * reports it unavailable and the runner takes its forced-WebGL2 path.
 */
export function launchArguments(platform, ci) {
  if (platform === 'darwin' && !ci) return ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal'];
  return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
}

const ci = process.argv.includes('--ci');
/** Under --ci every timeout in this runner is four times longer; nothing asserted changes. */
const scale = ci ? 4 : 1;
const BUILD_DIR = join(os.tmpdir(), 'kt-wp12-gpu-build');
const RESULTS_PATH = join(os.tmpdir(), 'kt-wp12-gpu-results.json');
const artifactPath = (name) => join(os.tmpdir(), name);
/** Every fixture URL carries scale=4 under --ci; in-page deadlines read it through fixtureTimeScale(). */
const fixtureUrl = (url) => (ci ? `${url}${url.includes('?') ? '&' : '?'}scale=${scale}` : url);
const machine = { hostname: os.hostname(), cpu: os.cpus()[0]?.model, platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version };
console.log('GPU test machine:', JSON.stringify(machine));
console.log(`GPU test mode: ${ci ? 'ci (software rasteriser, timeouts x4)' : 'local'}; results ${RESULTS_PATH}`);
// The workflow uploads the results file from this path rather than guessing the runner's temp directory.
if (process.env.GITHUB_OUTPUT !== undefined) await fs.appendFile(process.env.GITHUB_OUTPUT, `results=${RESULTS_PATH}\n`);
await build({ plugins: [allocationProbe], build: {
  outDir: BUILD_DIR, emptyOutDir: true,
  rolldownOptions: { input: [resolve('tests/render/gpu/probe.html'),resolve('tests/render/gpu/focus.html'),resolve('tests/render/gpu/derezz.html'),resolve('tests/render/gpu/audio.html'),resolve('tests/render/gpu/hud.html'),resolve('tests/render/gpu/replay.html'),resolve('tests/render/gpu/boot.html')] },
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
  browser = await chromium.launch({ channel: 'chromium', headless: !headed, args: launchArguments(os.platform(), ci) });
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
      new Promise((_, reject) => { environmentTimer = setTimeout(() => reject(new Error(`GPU environment preflight timed out after ${60 * scale} seconds`)), 60_000 * scale); }),
    ]).finally(() => clearTimeout(environmentTimer));
    console.log('WebGPU environment:', JSON.stringify(environment));
    results.push({ environment });
    webgpuAvailable = environment.status === 'available';
    if (environment.status === 'no-adapter') {
      if (ci || os.platform() !== 'darwin') console.log('WebGPU was not exercised: this launch requests the software rasteriser over WebGL2 and no WebGPU adapter is expected.');
      else console.log(headed ? 'No WebGPU adapter is available in headed Chromium.' : 'No WebGPU adapter is available in headless Chromium.');
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
      await navigateAndWaitForProbe(page, fixtureUrl(`http://127.0.0.1:${address.port}/tests/render/gpu/probe.html${force ? '?webgl' : ''}`), diagnostics);
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
      await page.screenshot({ path: artifactPath(`kt-wp12-${force ? 'webgl' : 'webgpu'}.png`) });
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
      await page.exposeFunction('__wp13Capture',async phase=>{assert(['front','occluded','released'].includes(phase));await page.screenshot({path:artifactPath(`kt-${path}-${phase}.png`)});});
      console.log(`Starting ${path}`);
      await navigateAndWaitForProbe(page,fixtureUrl(`http://127.0.0.1:${address.port}/tests/render/gpu/focus.html?tier=${tier}${force?'&webgl':''}`),diagnostics);
      const info=await page.evaluate(()=>globalThis.__kernelTrailProbe.api.info());
      assert.equal(info.backend,force?'webgl2':'webgpu');
      const result=await page.evaluate(()=>globalThis.__kernelTrailProbe.api.run());
      console.log(`${path}:`,JSON.stringify(result));results.push({path,result});
      await page.screenshot({path:artifactPath(`kt-${path}.png`)});
      assert.equal(diagnostics.pageErrors.length,0,'WP-13 page errors');
      assert.deepEqual(diagnostics.messages.filter(message=>message.startsWith('[console.error]')),[]);
      await page.evaluate(()=>globalThis.__kernelTrailProbe.api.dispose());
    } catch(error) {
      console.error(`GPU test failed on ${path}:`,error.stack||String(error));
      console.error(formatPageDiagnostics(diagnostics));failures.push(`${path}: ${error.stack||String(error)}`);
    } finally {await page.close();}
  }
  for (const force of webgpuAvailable ? [false, true] : [true]) for (const tier of ['low', 'medium', 'high']) {
    const path = `wp14-derezz-${force ? 'webgl2' : 'webgpu'}-${tier}`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const diagnostics = capturePageDiagnostics(page);
    await page.addInitScript(installWebGPUDiagnostics);
    try {
      console.log(`Starting ${path}`);
      await navigateAndWaitForProbe(page, fixtureUrl(`http://127.0.0.1:${address.port}/tests/render/gpu/derezz.html?tier=${tier}${force ? '&webgl' : ''}`), diagnostics);
      const info = await page.evaluate(() => globalThis.__kernelTrailProbe.api.info());
      assert.equal(info.backend, force ? 'webgl2' : 'webgpu');
      const result = await page.evaluate(() => globalThis.__kernelTrailProbe.api.run());
      console.log(`${path}:`, JSON.stringify(result));
      assert.equal(result.drawCalls, 2, `${path}: anonymous batch plus convoy batch`);
      results.push({ path, result });
      assert.equal(diagnostics.pageErrors.length, 0, 'WP-14 derezz page errors');
      assert.deepEqual(diagnostics.messages.filter(message => message.startsWith('[console.error]')), []);
      await page.evaluate(() => globalThis.__kernelTrailProbe.api.dispose());
    } catch (error) {
      console.error(`GPU test failed on ${path}:`, error.stack || String(error));
      console.error(formatPageDiagnostics(diagnostics));
      failures.push(`${path}: ${error.stack || String(error)}`);
    } finally { await page.close(); }
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
      await audioPage.goto(fixtureUrl(`http://127.0.0.1:${address.port}/tests/render/gpu/audio.html`), { waitUntil: 'domcontentloaded', timeout: 60_000 * scale });
      await audioPage.waitForFunction(() => globalThis.__kernelTrailAudioProbe?.status === 'ready' || globalThis.__kernelTrailAudioProbe?.status === 'failed', undefined, { timeout: 60_000 * scale });
      const boot = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe);
      if (boot.status === 'failed') throw new Error(`Audio probe failed to initialise: ${boot.error?.message}\n${boot.error?.stack}`);
      const before = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe.api.info());
      assert.equal(before.state, 'unstarted', 'no audio context may exist before the gesture');
      assert.equal(before.constructions, 0, 'no audio context may be constructed before the gesture');
      const droppedBefore = await audioPage.evaluate(() => globalThis.__kernelTrailAudioProbe.api.poke());
      assert.equal(droppedBefore, 1, 'a cue before the gesture is dropped and counted');
      await audioPage.click('#unlock');
      await audioPage.waitForFunction(() => globalThis.__kernelTrailAudioProbe.api.info().state === 'running', undefined, { timeout: 10_000 * scale });
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
  // WP-17 HUD probe. One page at 1440 by 900, the worst-case fixture mounted
  // over an empty document, every HUD rect measured, the union over the viewport.
  {
    const path = 'wp17-hud';
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const diagnostics = capturePageDiagnostics(page);
    try {
      console.log(`Starting ${path}`);
      await navigateAndWaitForProbe(page, fixtureUrl(`http://127.0.0.1:${address.port}/tests/render/gpu/hud.html`), diagnostics);
      const result = await page.evaluate(() => globalThis.__kernelTrailProbe.api.run());
      console.log(`${path}: coverage ${(result.coverage * 100).toFixed(2)}% of 1440x900`, JSON.stringify(result));
      results.push({ path, result });
      assert.ok(result.coverage < 0.11, `${path}: coverage ${(result.coverage * 100).toFixed(2)}% exceeds 11%`);
      await page.screenshot({ path: join(os.tmpdir(), `kt-${path}.png`) });
      assert.equal(diagnostics.pageErrors.length, 0, 'WP-17 HUD page errors');
      assert.deepEqual(diagnostics.messages.filter(message => message.startsWith('[console.error]')), []);
      await page.evaluate(() => globalThis.__kernelTrailProbe.api.dispose());
    } catch (error) {
      console.error(`GPU test failed on ${path}:`, error.stack || String(error));
      console.error(formatPageDiagnostics(diagnostics));
      failures.push(`${path}: ${error.stack || String(error)}`);
    } finally { await page.close(); }
  }
  // WP-18 replay probe. The three production workers spawned from their built
  // chunks, one synthetic-leg replay through a test worker entry compared with
  // the main-thread hash, one persist checksum compared with the main-thread
  // value (acceptance 27), and the bake's source buffer detached after transfer
  // as observed inside the worker (acceptance 26).
  {
    const path = 'wp18-replay';
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const diagnostics = capturePageDiagnostics(page);
    try {
      console.log(`Starting ${path}`);
      await navigateAndWaitForProbe(page, fixtureUrl(`http://127.0.0.1:${address.port}/tests/render/gpu/replay.html`), diagnostics);
      const result = await page.evaluate(() => globalThis.__kernelTrailProbe.api.run());
      console.log(`${path}:`, JSON.stringify(result));
      results.push({ path, result });
      assert.equal(result.productionReplay.ok, false, `${path}: the production replay worker answers a stub leg with an error`);
      assert.match(result.productionReplay.message, /phase 2/, `${path}: the stub message names phase 2`);
      assert.equal(result.replay.ok, true, `${path}: the synthetic-leg replay in a real worker: ${result.replay.message}`);
      assert.equal(result.replay.hashMatchesMainThread, true, `${path}: worker and main-thread hashes agree`);
      assert.equal(result.persist.matchesMainThread, true, `${path}: persist worker checksum equals the main-thread value`);
      assert.equal(result.bake.validSet, true, `${path}: the production bake worker's set validates and matches generateBuffers`);
      assert.equal(result.bake.probeSetValid, true, `${path}: the probe worker's set validates and matches generateBuffers`);
      assert.equal(result.bake.detachedAfterTransfer, true, `${path}: the source buffer is detached after transfer`);
      assert.equal(result.bake.transferred, 6, `${path}: six backing stores in the transfer list`);
      assert.equal(diagnostics.pageErrors.length, 0, 'WP-18 replay page errors');
      assert.deepEqual(diagnostics.messages.filter(message => message.startsWith('[console.error]')), []);
      await page.evaluate(() => globalThis.__kernelTrailProbe.api.dispose());
    } catch (error) {
      console.error(`GPU test failed on ${path}:`, error.stack || String(error));
      console.error(formatPageDiagnostics(diagnostics));
      failures.push(`${path}: ${error.stack || String(error)}`);
    } finally { await page.close(); }
  }
  // WP-22 boots the production session on each backend at high tier.
  for (const force of webgpuAvailable ? [false, true] : [true]) {
    const path = `wp22-boot-${force ? 'webgl2' : 'webgpu'}-high`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const diagnostics = capturePageDiagnostics(page);
    await page.addInitScript(installWebGPUDiagnostics);
    try {
      console.log(`Starting ${path}`);
      // The fixture controls RAF, so readiness polling uses a real timer.
      await Promise.race([
        (async () => {
          await page.goto(fixtureUrl(`http://127.0.0.1:${address.port}/tests/render/gpu/boot.html${force ? '?webgl' : ''}`), {
            waitUntil: 'domcontentloaded', timeout: 60_000 * scale,
          });
          await page.waitForFunction(() => {
            const probe = globalThis.__kernelTrailProbe;
            return probe?.status === 'failed' || (probe?.status === 'ready' && typeof probe.api?.info === 'function');
          }, undefined, { polling: 50, timeout: 60_000 * scale });
          const failure = await page.evaluate(() => {
            const probe = globalThis.__kernelTrailProbe;
            return probe?.status === 'failed' ? probe.error : null;
          });
          if (failure) throw new Error(`Probe initialization failed: ${failure.message}\n${failure.stack}`);
        })(),
        diagnostics.firstPageError.then(error => { throw error; }),
      ]);
      const info = await page.evaluate(() => globalThis.__kernelTrailProbe.api.info());
      assert.equal(info.backend, force ? 'webgl2' : 'webgpu', `${path}: requested backend`);
      assert.equal(info.tier, 'high', `${path}: high tier`);
      const result = await page.evaluate(() => globalThis.__kernelTrailProbe.api.run());
      console.log(`${path}:`, JSON.stringify(result));
      results.push({ path, info, result });
      assert.equal(result.backend, info.backend);
      assert.equal(result.tier, 'high');
      assert.equal(result.frames, 120);
      assert.equal(result.structures, info.anchors);
      assert(result.ticks > 0, `${path}: the kernel advances`);
      assert.equal(result.terminal.command, 'ps');
      assert(result.terminal.lines > 0, `${path}: terminal output`);
      assert.deepEqual(result.crossing, { opened: true, resolved: true, closed: true });
      assert.equal(result.geometry.renderedDisposed, result.geometry.rendered);
      assert.equal(result.geometry.sourcesDisposed, result.geometry.sources);
      assert.equal(result.sceneEmpty, true);
      assert.equal(result.loopStopped, true);
      assert.equal(diagnostics.pageErrors.length, 0, 'WP-22 boot page errors');
      assert.deepEqual(diagnostics.messages.filter(message => message.startsWith('[console.error]')), []);
      await page.evaluate(() => globalThis.__kernelTrailProbe.api.dispose());
    } catch (error) {
      console.error(`GPU test failed on ${path}:`, error.stack || String(error));
      console.error(formatPageDiagnostics(diagnostics));
      failures.push(`${path}: ${error.stack || String(error)}`);
    } finally {
      await page.evaluate(() => globalThis.__kernelTrailProbe?.api?.dispose()).catch(() => undefined);
      await page.close();
    }
  }
  const realApp = await runRealApp(browser, `http://127.0.0.1:${address.port}`, webgpuAvailable);
  results.push(...realApp.results); failures.push(...realApp.failures);
  if (environmentDiagnostics.pageErrors.length) {
    failures.push('WebGPU environment page reported an error');
    console.error(formatPageDiagnostics(environmentDiagnostics));
  }
  const environmentLosses = await environmentPage.evaluate(() => globalThis.__kernelTrailDeviceLosses ?? []).catch(() => []);
  if(environmentLosses.length){console.error('Preflight device loss:',JSON.stringify(environmentLosses));failures.push('The preflight device lost its instance before cleanup');}
  // Loss reasons are streamed by the installed monitor; retain those messages in the result.
  await fs.writeFile(RESULTS_PATH, JSON.stringify({ machine, browser: browser.version(), ci, headed, webgpuAvailable, results, failures, environmentMessages: environmentDiagnostics.messages, environmentLosses }, null, 2));
  console.log(`Results written to ${RESULTS_PATH}`);
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
