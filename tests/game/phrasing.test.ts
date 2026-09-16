/**
 * The phrasing layer, WP-18 acceptance 17 to 19 and the tests table: every
 * number in a sentence is in the results it was built from, no dashes, no
 * forbidden term, no imperative, at most two sentences, the Program and the
 * metric named for every casualty, and the architecture 8.7 example verbatim.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRng } from '../../src/kernel/rng';
import type { ConvoyMemberId, TerminationReason } from '../../src/kernel/types';
import { describeAlternative, numbersIn, phraseCounterfactual, toCodexCounterfactual, type PhrasingInput } from '../../src/game/replay/phrasing';
import type { ObservedLeg, ReplayRequest, ReplayResult } from '../../src/game/replay/types';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * The twelve remedy patterns WP-15's `no remedies` case scans man pages for
 * (tests/terminal/man.test.ts). Kept local rather than imported from another
 * package's test file, per pre-flight ruling 14; the duplication is deliberate.
 */
const IMPERATIVES = ['you must', 'switch to', 'switch the', 'set the scheduler', 'increase the quantum', 'decrease the quantum',
  'raise the quantum', 'lower the quantum', 'reduce the degree', 'lower the degree', 'the fix is', 'should be set'];

const MEMBERS: readonly ConvoyMemberId[] = ['lumen', 'sable', 'orrery', 'kestrel', 'vesper'];
const REASONS: readonly TerminationReason[] = ['starvation', 'thrashing_collapse', 'deadlock_victim', 'out_of_memory', 'protection_fault', 'io_timeout', 'killed_by_user', 'storage_corruption'];

function result(seed: number, casualties: ReplayResult['casualties']): ReplayResult {
  const rng = createRng(seed, 'phrasing');
  return {
    ok: true,
    ticks: rng.int(500, 8000),
    eventLogHash: '0'.repeat(16),
    survivors: MEMBERS.filter((m) => !casualties.some((c) => c.member === m)),
    casualties,
    scheduling: {
      averageWaitingTime: rng.next() * 300,
      averageTurnaroundTime: rng.next() * 900,
      averageResponseTime: rng.next() * 40,
      contextSwitches: rng.int(0, 4000),
      cpuUtilisation: rng.next(),
      worstWait: rng.int(0, 600),
    },
    memory: { pageFaults: rng.int(0, 5000), evictions: rng.int(0, 3000), faultRate: rng.next() * 400 },
    storage: { seekDistance: rng.int(0, 40_000) },
    score: { survivors: 0, throughput: 0, efficiency: 0, correctness: 0, conceptsMastered: 0, classMultiplier: 1, total: 0 },
    highlights: [],
    diagnostics: { skippedDecisions: 0, legs: [] },
  };
}

const REQUESTS: readonly Pick<ReplayRequest, 'overrides' | 'configPatch'>[] = [
  { overrides: { scheduler: 'rr', quantum: 4, suppressRecordedPolicyChanges: true } },
  { overrides: { scheduler: 'priority_aging', suppressRecordedPolicyChanges: true } },
  { overrides: { scheduler: 'srtf', suppressRecordedPolicyChanges: true } },
  { overrides: { quantum: 2, suppressRecordedPolicyChanges: true } },
  { overrides: { replacement: 'optimal', suppressRecordedPolicyChanges: true } },
  { overrides: { replacement: 'clock', suppressRecordedPolicyChanges: true } },
  { overrides: { diskPolicy: 'clook', suppressRecordedPolicyChanges: true } },
  { overrides: { allocation: 'best_fit', suppressRecordedPolicyChanges: true } },
  { overrides: { pace: 'conservative', suppressRecordedPolicyChanges: true } },
  { overrides: { rations: 'generous', suppressRecordedPolicyChanges: true } },
  { overrides: { degreeOfMultiprogramming: 4, suppressRecordedPolicyChanges: true } },
  { overrides: { suppressRecordedPolicyChanges: true }, configPatch: { deadlockStrategy: 'avoid' } },
  { overrides: { scheduler: 'mlfq', replacement: 'lru', diskPolicy: 'scan', suppressRecordedPolicyChanges: true } },
];

/** Fifty generated inputs: casualties saved, casualties repeated, clean legs, and a loss the alternative introduced. */
function generate(): { input: PhrasingInput; text: string }[] {
  const out: { input: PhrasingInput; text: string }[] = [];
  const rng = createRng(0x4b54524c, 'cases');
  for (let i = 0; i < 50; i++) {
    const request = REQUESTS[i % REQUESTS.length];
    if (request === undefined) throw new Error('fixture');
    const member = rng.pick(MEMBERS);
    const reason = rng.pick(REASONS);
    const shape = i % 4;
    const baselineLoss = shape === 0 || shape === 1 ? [{ member, reason, tick: rng.int(1, 5000) }] : [];
    const alternativeLoss = shape === 1 ? [{ member, reason, tick: rng.int(1, 5000) }] : shape === 3 ? [{ member, reason, tick: rng.int(1, 5000) }] : [];
    const baseline = result(1000 + i, baselineLoss);
    const alternative = result(2000 + i, alternativeLoss);
    const input: PhrasingInput = { baseline, alternative, request, ...(i % 5 === 0 ? { floor: true } : {}) };
    out.push({ input, text: phraseCounterfactual(input) });
  }
  return out;
}

/** Every number a sentence may use: the two results' numeric leaves, rounded and exact, and the override values. */
function allowed(input: PhrasingInput): Set<number> {
  const numbers = new Set<number>();
  const walk = (value: unknown): void => {
    if (typeof value === 'number') {
      numbers.add(value);
      numbers.add(Math.round(value));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  walk(input.baseline);
  walk(input.alternative);
  walk(input.request.overrides);
  return numbers;
}

const sentences = (text: string): string[] => text.split(/(?<=\.)\s+/).filter((s) => s.length > 0);

/** Em dash and en dash, built from code points so this file does not carry the characters it forbids. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);

describe('phrasing', () => {
  const cases = generate();

  it('numbers from result: every number in 50 generated sentences is in the results it was built from', () => {
    expect(cases).toHaveLength(50);
    let numbers = 0;
    for (const { input, text } of cases) {
      const ok = allowed(input);
      for (const n of numbersIn(text)) {
        numbers += 1;
        expect(ok.has(n), `${n} in "${text}"`).toBe(true);
      }
    }
    expect(numbers).toBeGreaterThan(100);
  });

  it('no em dash, and no en dash used as one', () => {
    for (const { text } of cases) expect(text).not.toMatch(DASHES);
    expect(describeAlternative({ overrides: { scheduler: 'rr', suppressRecordedPolicyChanges: true } })).not.toMatch(DASHES);
  });

  it('no forbidden words: scanning the full list in contracts.lock.json', () => {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts.lock.json'), 'utf8')) as { forbiddenTerms: string[] };
    expect(lock.forbiddenTerms.length).toBeGreaterThan(10);
    const forbidden = new RegExp(`\\b(${lock.forbiddenTerms.join('|')})\\b`, 'i');
    for (const { text } of cases) expect(text).not.toMatch(forbidden);
    for (const request of REQUESTS) expect(describeAlternative(request)).not.toMatch(forbidden);
  });

  it('no imperatives: none of the twelve remedy patterns appears', () => {
    expect(IMPERATIVES).toHaveLength(12);
    for (const { text } of cases) {
      const lower = text.toLowerCase();
      for (const pattern of IMPERATIVES) expect(lower, `"${pattern}" in "${text}"`).not.toContain(pattern);
    }
  });

  it('two sentences: no counterfactual exceeds two', () => {
    for (const { text } of cases) {
      const parts = sentences(text);
      expect(parts.length, text).toBeGreaterThanOrEqual(1);
      expect(parts.length, text).toBeLessThanOrEqual(2);
      for (const s of parts) expect(s).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('names the program: every sentence about a casualty names the Program and the metric', () => {
    const metricWords = /waits|page faults|lost to|derezzes/;
    let seen = 0;
    for (const { input, text } of cases) {
      const lost = input.baseline.casualties[0] ?? input.alternative.casualties[0];
      if (lost === undefined) continue;
      seen += 1;
      const first = sentences(text).find((s) => s.includes(lost.member.toUpperCase()));
      expect(first, text).toBeDefined();
      expect(first ?? '', text).toMatch(metricWords);
      expect(text).toMatch(/Average waiting time|Page faults|Head movement|average waiting time|page faults|head movement/);
    }
    expect(seen).toBeGreaterThan(30);
  });

  it('architecture example: the 8.7 worked example renders from a ReplayResult carrying those numbers', () => {
    const baseline: ObservedLeg = {
      casualties: [{ member: 'sable', reason: 'starvation', tick: 412 }],
      scheduling: { averageWaitingTime: 94, averageTurnaroundTime: 300, averageResponseTime: 9, contextSwitches: 200, cpuUtilisation: 0.8, worstWait: 210 },
      memory: { pageFaults: 40, evictions: 10, faultRate: 8 },
      storage: { seekDistance: 100 },
    };
    const alternative: ReplayResult = { ...result(1, []), scheduling: { ...baseline.scheduling, averageWaitingTime: 38, worstWait: 61 } };
    const text = phraseCounterfactual({ baseline, alternative, request: { overrides: { scheduler: 'rr', quantum: 4, suppressRecordedPolicyChanges: true } } });
    expect(text).toBe('Under round-robin with a quantum of 4, SABLE waits 61 ticks instead of 210 and survives. Average waiting time falls from 94 to 38.');
    // The codex side: dotted keys over the three metric groups, plus the tick count.
    const codex = toCodexCounterfactual(alternative, describeAlternative({ overrides: { scheduler: 'rr', quantum: 4, suppressRecordedPolicyChanges: true } }), 41, 7, text);
    expect(codex.alternative).toBe('round-robin with a quantum of 4');
    expect(codex.decisionIndex).toBe(41);
    expect(codex.replaySeed).toBe(7);
    expect(codex.narrative).toBe(text);
    expect(codex.projected['scheduling.averageWaitingTime']).toBe(38);
    expect(codex.projected['scheduling.worstWait']).toBe(61);
    expect(codex.projected['memory.pageFaults']).toBe(alternative.memory.pageFaults);
    expect(codex.projected['storage.seekDistance']).toBe(alternative.storage.seekDistance);
    expect(codex.projected['ticks']).toBe(alternative.ticks);
    expect(Object.keys(codex.projected).sort()).toEqual([
      'memory.evictions', 'memory.faultRate', 'memory.pageFaults',
      'scheduling.averageResponseTime', 'scheduling.averageTurnaroundTime', 'scheduling.averageWaitingTime', 'scheduling.contextSwitches', 'scheduling.cpuUtilisation', 'scheduling.worstWait',
      'storage.seekDistance', 'ticks',
    ]);
  });

  it('ten sample sentences for the report', () => {
    const sample = cases.slice(0, 10).map((c) => c.text);
    for (const line of sample) expect(line.length).toBeGreaterThan(20);
    console.log(sample.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  });
});
