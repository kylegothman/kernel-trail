#!/usr/bin/env node
/**
 * WP-25 section 7: render a leg's arrangement, or one section of it, to a
 * WAV through OfflineAudioContext at 48 kHz, deterministically from the
 * seed, and print the file's hash. It is how Kyle listens without playing
 * the game and how a reviewer checks that two renders of one seed are
 * byte-identical.
 *
 *   node tools/audio/audition.mjs --leg boot_sector
 *   node tools/audio/audition.mjs --leg quantum_pass --section travel --bars 16
 *   node tools/audio/audition.mjs --leg the_narrows --seed 7 --tier low --out narrows.wav
 *
 * Node has no offline audio context, so this is one file with two
 * branches: under Node it serves itself through a vite dev server and
 * drives the runner's own Chromium; in the browser it builds the graph,
 * the pool, the side-chain and the sequencer over an offline context,
 * schedules the whole render at once, and hands back 16-bit PCM. Without
 * `--section` the render is a tour of every section in the order the game
 * would reach them, ending in a panic cut half way through a bar.
 */

const IN_BROWSER = typeof document !== 'undefined';
const SAMPLE_RATE = 48000;
const DEFAULT_SEED = 0x4b54524c;
const TIERS = ['low', 'medium', 'high'];

/**
 * The score's slice of the pool per tier, the split the pre-flight
 * approved. `POOL_SPLIT` carries these counts once WP-16's layers have gone
 * (the conductor commit); until then the tool holds them here.
 */
const SCORE_POOL = {
  low: { chord: 3, kick: 1, lead: 1, tone: 5, drone: 1 },
  medium: { chord: 5, kick: 1, lead: 1, tone: 8, drone: 2 },
  high: { chord: 6, kick: 1, lead: 2, tone: 22, drone: 3 },
};

/** The tour: every section in an order the game could reach them, the panic cut mid-bar at the end. */
const TOUR = [
  ['entry', 8], ['travel', 16], ['crossing', 16], ['resolve_good', 4], ['travel', 8], ['loss', 4],
  ['travel', 8], ['resolve_bad', 4], ['debrief', 8], ['travel', 2.5], ['panic', 4],
];

/* ------------------------------------------------------------------ */
/* Browser branch                                                      */
/* ------------------------------------------------------------------ */

function offlineAdapter(offline) {
  return {
    get currentTime() { return 0; },
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

async function renderInBrowser(request) {
  const [buffersModule, graphModule, budgetModule, tone, drone, chordVoice, kickVoice, leadVoice, sidechainModule, sequencerModule, material, arrangementModule, rngModule, settingsModule] = await Promise.all([
    import('/src/audio/buffers.ts'), import('/src/audio/graph.ts'), import('/src/audio/VoiceBudget.ts'),
    import('/src/audio/voices/ToneVoice.ts'), import('/src/audio/voices/DroneVoice.ts'), import('/src/audio/voices/ChordVoice.ts'),
    import('/src/audio/voices/KickVoice.ts'), import('/src/audio/voices/LeadVoice.ts'), import('/src/audio/synth/sidechain.ts'),
    import('/src/audio/score/Sequencer.ts'), import('/src/audio/score/material.ts'), import('/src/audio/score/Arrangement.ts'),
    import('/src/kernel/rng.ts'), import('/src/audio/settings.ts'),
  ]);
  const arrangement = material.arrangementFor(request.leg, request.seed);
  const sections = arrangementModule.SECTION_IDS;
  if (request.section !== null && !sections.includes(request.section)) throw new Error(`no section ${request.section}; one of ${sections.join(', ')}`);
  const plan = request.section === null ? TOUR : [[request.section, request.bars ?? arrangement.sections[request.section].bars]];
  const bar = arrangementModule.barSeconds(arrangement);
  const tail = 1.5;
  const totalBars = plan.reduce((sum, [, bars]) => sum + bars, 0);
  const seconds = totalBars * bar + tail;
  const offline = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
  const ctx = offlineAdapter(offline);
  const buffers = graphModule.uploadBuffers(ctx, buffersModule.generateBuffers(request.seed, SAMPLE_RATE), request.tier);
  const graph = new graphModule.MasterGraph(ctx, request.tier, buffers);
  // The level the game plays at: the default score and master volumes.
  const defaults = settingsModule.DEFAULT_AUDIO_SETTINGS;
  graph.setBusGain('score', defaults.score, 0, 0.001);
  graph.setMasterGain(defaults.master, 0);
  let sequencer = null;
  const host = {
    ctx, buffers,
    busInput: (bus) => (bus === 'score' && sequencer !== null ? sequencer.trim : graph.busInput(bus)),
    envelopeScale: 1, mono: false, rng: rngModule.createRng(request.seed, 'audio').fork('runtime'),
  };
  const sidechain = new sidechainModule.Sidechain(sidechainModule.SIDECHAIN_DEPTH[request.tier], () => 1);
  const allocator = new budgetModule.VoiceAllocator(budgetModule.VOICE_BUDGET[request.tier]);
  const pool = SCORE_POOL[request.tier];
  const make = (count, factory) => {
    for (let i = 0; i < count; i++) {
      const voice = factory();
      voice.warmUp(0);
      allocator.register(voice);
      if (voice instanceof drone.DroneVoice) sidechain.register(voice.gate);
    }
  };
  make(pool.chord, () => new chordVoice.ChordVoice(host, sidechain));
  make(pool.kick, () => new kickVoice.KickVoice(host, sidechain));
  make(pool.lead, () => new leadVoice.LeadVoice(host));
  make(pool.tone, () => new tone.ToneVoice(host));
  make(pool.drone, () => new drone.DroneVoice(host));
  // The schedule, as text, for a hash that does not depend on how the platform sums a node's inputs.
  const schedule = [];
  const originalAcquire = allocator.acquire.bind(allocator);
  allocator.acquire = (kind, bus, when, exempt) => { const voice = originalAcquire(kind, bus, when, exempt); schedule.push(`${kind}@${when.toFixed(6)}${voice === null ? ' unplaced' : ''}`); return voice; };
  const voicing = Object.fromEntries(Object.entries(material.SCORE_VOICING).map(([part, v]) => [part, { ...v, patch: (n, c, out) => { v.patch(n, c, out); schedule.push(`${part} ${c.section.id} ${n.step} ${n.midi} ${n.velocity.toFixed(3)} ${n.cutoff.toFixed(4)} ${c.seconds.toFixed(6)}`); } }]));
  sequencer = new sequencerModule.Sequencer({ ctx, allocator, voicing, envelopeScale: 1, scoreBus: graph.busInput('score') });

  // The plan walks bar by bar through the hook; a panic entry is a cut, applied between two scheduling passes.
  let entry = 0;
  let remaining = plan[0][1];
  let cutAt = null;
  let before = 0;
  for (const [id, bars] of plan) {
    if (id === 'panic') { cutAt = before * bar; break; }
    before += bars;
  }
  sequencer.onBar = (info) => {
    if (info.section === 'panic') return info.barInSection >= info.bars ? 'end' : null;
    if (remaining > 0) { remaining -= 1; return null; }
    entry += 1;
    const next = plan[entry];
    if (next === undefined || next[0] === 'panic') return 'end';
    remaining = next[1] - 1;
    return next[0];
  };
  const started = sequencer.start(arrangement, plan[0][0], 0);
  if (started !== 'ok') throw new Error(`sequencer: ${started}`);
  remaining -= 1;
  if (cutAt === null) {
    sequencer.scheduleUntil(seconds, 0);
  } else {
    sequencer.scheduleUntil(cutAt, 0);
    sequencer.cut(cutAt);
    sequencer.scheduleUntil(seconds, 0);
  }
  const stats = { ...sequencer.stats, stolen: allocator.stats.stolen, dropped: allocator.stats.dropped, kicks: sidechain.stats.triggers };
  const scheduleText = schedule.join('\n');
  const scheduleDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scheduleText));
  const scheduleHash = [...new Uint8Array(scheduleDigest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
  return {
    base64: toBase64(new Uint8Array(pcm.buffer)),
    seconds: rendered.duration, peak, stats, scheduleHash, scheduled: schedule.length,
    arrangement: { tempo: arrangement.tempo, rootMidi: arrangement.rootMidi, mode: arrangement.mode, swing: arrangement.swing },
    plan: plan.map(([id, bars]) => `${id} x${bars}`),
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
  if (out.bars !== null && !(out.bars > 0)) throw new Error('--bars must be positive');
  if (!Number.isInteger(out.seed)) throw new Error('--seed must be an integer');
  if (out.section !== null && out.bars !== null && !Number.isInteger(out.bars)) throw new Error('--bars must be a whole number');
  return out;
}

function usage() {
  console.log('usage: node tools/audio/audition.mjs --leg <leg_id> [--section <id>] [--bars <n>] [--seed <n>] [--tier low|medium|high] [--out <file.wav>]');
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
    console.log(`plan ${result.plan.join(', ')}`);
    console.log(`notes ${result.stats.notes}  unplaced ${result.stats.unplaced}  kicks ${result.stats.kicks}  bars ${result.stats.bars}  stolen ${result.stats.stolen}`);
    console.log(`rendered ${result.seconds.toFixed(2)} s in ${(renderMs / 1000).toFixed(1)} s  peak ${result.peak.toFixed(3)} (${peakDb} dBFS)`);
    console.log(`wav ${outPath}`);
    console.log(`sha256 ${hash}`);
    // Chromium sums a node's inputs in an order that varies per process, so two renders of one seed can differ by
    // one 16-bit step in a fraction of a percent of samples. The schedule hash is the same seed's same music.
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
