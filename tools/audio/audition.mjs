#!/usr/bin/env node
/**
 * WP-25 section 7: render a leg's arrangement, or one section of it, to a
 * WAV through OfflineAudioContext at 48 kHz, deterministically from the
 * seed, and print the file's hash. It is how Kyle listens without playing
 * the game and how a reviewer checks two renders of one seed.
 *
 *   node tools/audio/audition.mjs --leg boot_sector
 *   node tools/audio/audition.mjs --leg quantum_pass --section travel --bars 16
 *   node tools/audio/audition.mjs --leg the_narrows --seed 7 --tier low --out narrows.wav
 *
 * Node has no offline audio context, so this is one file with two
 * branches: under Node it serves itself through a vite dev server and
 * drives the runner's own Chromium; in the browser it builds the real
 * engine over an offline context and drives its two hooks with the events
 * the game would send, so what is rendered is the production path: the
 * pool from POOL_SPLIT, the side-chain, the Conductor's table, the default
 * volumes. Without `--section` the render is a tour: the events of a leg
 * in an order the game could reach them, ending in a panic cut mid-bar.
 *
 * Two hashes are printed. The WAV's bytes can differ by one 16-bit step in
 * a fraction of a percent of samples between two renders of one seed,
 * because Chromium sums a node's inputs in an order that varies per
 * process; the schedule hash, over every note the sequencer placed and
 * every event the tour sent, is the same seed's same music.
 */

const IN_BROWSER = typeof document !== 'undefined';
const SAMPLE_RATE = 48000;
const DEFAULT_SEED = 0x4b54524c;
const TIERS = ['low', 'medium', 'high'];

/**
 * The tour, in bars from the leg's first bar line. Entry runs eight bars into
 * travel on its own; a crossing plays its eight-bar introduction and one pass
 * of its loop before it resolves; the debrief plays a full eight; the panic
 * cuts the bar after it.
 */
const TOUR = [
  { atBar: 0, kind: 'leg_entered' },
  { atBar: 24, kind: 'crossing_open' },
  { atBar: 40, kind: 'crossing_resolved', succeeded: true, casualties: 0 },
  { atBar: 52, kind: 'tombstone' },
  { atBar: 64, kind: 'crossing_open' },
  { atBar: 72, kind: 'crossing_resolved', succeeded: false, casualties: 0 },
  { atBar: 84, kind: 'debrief' },
  { atBar: 94.5, kind: 'panic' },
];
const TOUR_BARS = 98.5;

/* ------------------------------------------------------------------ */
/* Browser branch                                                      */
/* ------------------------------------------------------------------ */

function offlineAdapter(offline, clock) {
  return {
    get currentTime() { return clock.now; },
    sampleRate: offline.sampleRate,
    get state() { return 'running'; },
    destination: offline.destination,
    onstatechange: null,
    createGain: () => offline.createGain(),
    createOscillator: () => offline.createOscillator(),
    createBufferSource: () => offline.createBufferSource(),
    createBiquadFilter: () => offline.createBiquadFilter(),
    createWaveShaper: () => offline.createWaveShaper(),
    createConvolver: () => offline.createConvolver(),
    createDelay: (max) => offline.createDelay(max),
    createDynamicsCompressor: () => offline.createDynamicsCompressor(),
    createStereoPanner: () => offline.createStereoPanner(),
    createBuffer: (channels, length, rate) => offline.createBuffer(channels, length, rate),
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function toBase64(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(out);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function renderInBrowser(request) {
  const [{ AudioEngine }, { SECTION_IDS, barSeconds }, { legIndex }, { GENERATED_SCORE_SOURCE }] = await Promise.all([
    import('/src/audio/AudioEngine.ts'), import('/src/audio/score/Arrangement.ts'), import('/src/audio/score/material.ts'), import('/src/audio/score/source.ts'),
  ]);
  const index = legIndex(request.leg);
  const arrangement = GENERATED_SCORE_SOURCE.arrangement(request.leg, request.seed);
  if (request.section !== null && !SECTION_IDS.includes(request.section)) throw new Error(`no section ${request.section}; one of ${SECTION_IDS.join(', ')}`);
  const bar = barSeconds(arrangement);
  const bars = request.section === null ? TOUR_BARS : (request.bars ?? arrangement.sections[request.section].bars);
  const tail = 1.5;
  const seconds = bars * bar + tail;
  const offline = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
  const clock = { now: 0 };
  const engine = new AudioEngine({ tier: request.tier, seed: request.seed, contextFactory: () => offlineAdapter(offline, clock), reducedMotionProbe: () => false });
  engine.unlock();
  const score = engine.score;
  if (score === null) throw new Error(`the engine did not build: ${engine.adapter.failureReason ?? 'no reason recorded'}`);
  const schedule = [];
  score.sequencer.onNote = (part, note, onset, length, section) => {
    schedule.push(`${section} ${part} ${note.step} ${note.midi} ${note.velocity.toFixed(3)} ${note.cutoff.toFixed(4)} ${onset.toFixed(6)} ${length.toFixed(6)}`);
  };
  const send = (step) => {
    schedule.push(`event ${step.kind} ${clock.now.toFixed(6)}`);
    switch (step.kind) {
      case 'leg_entered': engine.onDirectorEvent({ kind: 'leg_entered', legId: request.leg, index }); return;
      case 'crossing_resolved': engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: step.succeeded, casualties: step.casualties }); return;
      case 'leg_exit': engine.onDirectorEvent({ kind: 'leg_exit' }); return;
      default: engine.onLegEvent({ kind: step.kind }); return;
    }
  };
  if (request.section === null) {
    // The leg's first bar line is the lead the Conductor gives a live start; the tour's bars count from it.
    clock.now = -0.02;
    send(TOUR[0]);
    for (const step of TOUR.slice(1)) {
      const t = step.atBar * bar;
      score.scheduleUntil(t, 0);
      clock.now = t;
      send(step);
    }
    score.scheduleUntil(bars * bar + tail, 0);
  } else {
    if (!score.audition(request.leg, request.section, 0)) throw new Error(`${request.section} did not start`);
    const end = bars * bar;
    score.scheduleUntil(end, 0);
    score.stop(end);
  }
  const stats = engine.stats();
  const timeline = score.conductor.timeline.map((e) => `${e.section}@${e.time.toFixed(2)}`);
  const scheduleHash = await sha256(schedule.join('\n'));
  const rendered = await offline.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.getChannelData(1);
  const pcm = new Int16Array(rendered.length * 2);
  let peak = 0;
  for (let i = 0; i < rendered.length; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    pcm[2 * i] = Math.round(l * 32767);
    pcm[2 * i + 1] = Math.round(r * 32767);
  }
  engine.dispose();
  return {
    base64: toBase64(new Uint8Array(pcm.buffer)),
    seconds: rendered.duration, peak, scheduleHash, scheduled: schedule.length, timeline,
    stats: { notes: stats.scoreNotes, unplaced: stats.scoreUnplaced, errors: stats.scoreErrors, stolen: stats.voicesStolen, dropped: stats.voicesDropped, peakVoices: stats.voicesPeak },
    arrangement: { tempo: arrangement.tempo, rootMidi: arrangement.rootMidi, mode: arrangement.mode, swing: arrangement.swing },
  };
}

/* ------------------------------------------------------------------ */
/* Node branch                                                         */
/* ------------------------------------------------------------------ */

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>KERNEL TRAIL audition</title><link rel="icon" href="data:,"></head>'
  + '<body><pre id="status">rendering</pre><script type="module" src="/tools/audio/audition.mjs"></script></body></html>';

function parseArgs(argv) {
  const out = { leg: null, section: null, bars: null, seed: DEFAULT_SEED, tier: 'high', out: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    const need = () => { if (value === undefined) throw new Error(`${key} needs a value`); i += 1; return value; };
    switch (key) {
      case '--leg': out.leg = need(); break;
      case '--section': out.section = need(); break;
      case '--bars': out.bars = Number.parseInt(need(), 10); break;
      case '--seed': out.seed = Number.parseInt(need(), 10); break;
      case '--tier': out.tier = need(); break;
      case '--out': out.out = need(); break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default: throw new Error(`unknown argument ${key}`);
    }
  }
  if (out.leg === null) throw new Error('--leg is required');
  if (!TIERS.includes(out.tier)) throw new Error(`--tier must be one of ${TIERS.join(', ')}`);
  if (out.bars !== null && !(Number.isInteger(out.bars) && out.bars > 0)) throw new Error('--bars must be a positive whole number');
  if (out.bars !== null && out.section === null) throw new Error('--bars needs --section; the tour has its own length');
  if (!Number.isInteger(out.seed)) throw new Error('--seed must be an integer');
  return out;
}

function usage() {
  console.log('usage: node tools/audio/audition.mjs --leg <leg_id> [--section <id> [--bars <n>]] [--seed <n>] [--tier low|medium|high] [--out <file.wav>]');
}

function wavBytes(pcmBytes, channels, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes.length, 40);
  return Buffer.concat([header, pcmBytes]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [{ createServer }, { chromium }, fs, os, path, crypto] = await Promise.all([
    import('vite'), import('playwright'), import('node:fs/promises'), import('node:os'), import('node:path'), import('node:crypto'),
  ]);
  const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0 } });
  server.middlewares.use((req, res, next) => {
    if (req.url === '/audition' || req.url.startsWith('/audition?')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(PAGE);
    } else next();
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
    await page.goto(`http://127.0.0.1:${address.port}/audition`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__kernelTrailAudition !== undefined, undefined, { timeout: 60_000 });
    const t0 = performance.now();
    const result = await page.evaluate((request) => globalThis.__kernelTrailAudition.render(request), { leg: args.leg, section: args.section, bars: args.bars, seed: args.seed, tier: args.tier });
    const renderMs = performance.now() - t0;
    if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
    const pcm = Buffer.from(result.base64, 'base64');
    const wav = wavBytes(pcm, 2, SAMPLE_RATE);
    const hash = crypto.createHash('sha256').update(wav).digest('hex');
    const outPath = args.out ?? path.join(os.tmpdir(), `kt-audition-${args.leg}-${args.section ?? 'tour'}-${args.seed}-${args.tier}.wav`);
    await fs.writeFile(outPath, wav);
    const peakDb = result.peak > 0 ? (20 * Math.log10(result.peak)).toFixed(1) : '-inf';
    console.log(`leg ${args.leg}  tier ${args.tier}  seed ${args.seed}`);
    console.log(`tempo ${result.arrangement.tempo}  root midi ${result.arrangement.rootMidi}  mode ${result.arrangement.mode}  swing ${result.arrangement.swing.toFixed(3)}`);
    console.log(`sections ${result.timeline.join(', ')}`);
    console.log(`notes ${result.stats.notes}  unplaced ${result.stats.unplaced}  errors ${result.stats.errors}  stolen ${result.stats.stolen}  dropped ${result.stats.dropped}  peak voices ${result.stats.peakVoices}`);
    console.log(`rendered ${result.seconds.toFixed(2)} s in ${(renderMs / 1000).toFixed(1)} s  peak ${result.peak.toFixed(3)} (${peakDb} dBFS)`);
    console.log(`wav ${outPath}`);
    console.log(`sha256 ${hash}`);
    console.log(`schedule sha256 ${result.scheduleHash} (${result.scheduled} events)`);
  } finally {
    await browser.close();
    await server.close();
  }
}

if (IN_BROWSER) {
  globalThis.__kernelTrailAudition = { render: renderInBrowser };
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
