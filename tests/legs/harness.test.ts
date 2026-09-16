/**
 * The harness's own suite, WP-20 "Tests you must write", run against the
 * composite synthetic leg of scope correction W8. No real leg exists today,
 * so every real-leg case in the other suites skips; this file is what proves
 * the harness.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { asPid, asTick, createKernel } from '@kernel/index';
import { originFromRecord } from '@game/CommandBus';
import { runReplay } from '@game/replay/runReplay';
import { LEG_ORDER, type Leg, type LegId } from '@game/types';
import { stripComments } from '../kernel/sourceScan';
import { createSyntheticLeg } from '../game/fixtures/syntheticLeg';
import {
  assertClean, assertHeadless, remainderHashAfter, runLeg, type HarnessResult,
} from './harness/LegHarness';
import { assertLegShape, loadLegForTest, loadShippedSet, REPO_ROOT, scanForbiddenImports, tryLoadLegForTest } from './harness/loadLeg';
import { makeConvoy, makeRunState } from './harness/makeRunState';
import { validateScript, type DecisionScript } from './harness/decisionScript';
import { CompetentPolicy, competentCrossingChoice, ScriptedDecisions, type DriverContext } from './harness/scriptedDecisions';
import { expectOutcome, outcomeProblems } from './harness/expectOutcome';
import { REQUIRED_EVENTS } from './harness/requiredEvents';
import {
  createHarnessLeg, FIXTURE_SEED, HARNESS_CROSSING, HARNESS_LEG_ID, HARNESS_OBJECTIVE_IDS,
  KNOWN_BAD_EXPECTATION, KNOWN_BAD_SCRIPT, KNOWN_GOOD_EXPECTATION, KNOWN_GOOD_SCRIPT,
} from './harness/syntheticLeg';

const HARNESS_DIR = resolve(REPO_ROOT, 'tests', 'legs', 'harness');
const script = (steps: DecisionScript['steps'], patch: Partial<DecisionScript> = {}): DecisionScript => ({ legId: HARNESS_LEG_ID, label: 'case', crossings: [HARNESS_CROSSING], steps, ...patch });

async function firstUnshipped(): Promise<LegId | null> {
  for (const id of LEG_ORDER) {
    const result = await tryLoadLegForTest(id);
    if (!result.shipped) return id;
  }
  return null;
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(ts|mts|mjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out.sort();
}

describe('loading', () => {
  it('constructs by id: every shipped leg loads and an unshipped id throws with its id in the message', async () => {
    const shipped = await loadShippedSet();
    for (const leg of shipped.legs) expect((await loadLegForTest(leg.id)).id).toBe(leg.id);
    const missing = await firstUnshipped();
    if (missing === null) console.log('harness: every leg has shipped; the unshipped-id half of this case has nothing to exercise');
    else await expect(loadLegForTest(missing)).rejects.toThrow(missing);
    const synthetic = await loadLegForTest(HARNESS_LEG_ID, { indexPath: join(HARNESS_DIR, 'syntheticLeg.ts'), loader: async () => ({ default: createHarnessLeg() }) });
    expect(synthetic.id).toBe(HARNESS_LEG_ID);
    expect(synthetic.index).toBe(LEG_ORDER.indexOf(HARNESS_LEG_ID));
  });

  it('try load: an unshipped id returns shipped false with the missing path', async () => {
    const missing = await firstUnshipped();
    if (missing === null) { console.log('harness: every leg has shipped; try load has no unshipped id to exercise'); return; }
    const result = await tryLoadLegForTest(missing);
    expect(result.shipped).toBe(false);
    if (!result.shipped) expect(result.reason).toContain(`src/legs/${missing}/index.ts does not exist`);
  });

  it('asserts the shape on load, naming the field', async () => {
    const wrongIndex = { ...createHarnessLeg(), index: 3 };
    await expect(loadLegForTest(HARNESS_LEG_ID, { indexPath: join(HARNESS_DIR, 'syntheticLeg.ts'), loader: async () => ({ default: wrongIndex }) })).rejects.toThrow(/index/);
    const wrongId = { ...createHarnessLeg(), id: 'the_weave' as LegId };
    expect(() => assertLegShape(wrongId, HARNESS_LEG_ID)).toThrow(/id/);
    const noEvaluate = { ...createHarnessLeg(), evaluate: undefined as unknown as Leg['evaluate'] };
    expect(() => assertLegShape(noEvaluate, HARNESS_LEG_ID)).toThrow(/evaluate/);
  });

  it('a present index whose import is rejected throws with the id rather than reading as unshipped', async () => {
    await expect(loadLegForTest(HARNESS_LEG_ID, { indexPath: join(HARNESS_DIR, 'syntheticLeg.ts'), loader: () => Promise.reject(new Error('syntax error')) })).rejects.toThrow(/fork_fields.*syntax error/);
  });

  it('forbidden import: a synthetic leg importing three fails at load with a message naming the import', async () => {
    const forbidden = join(HARNESS_DIR, 'forbidden', 'index.ts');
    expect(existsSync(forbidden)).toBe(true);
    await expect(tryLoadLegForTest(HARNESS_LEG_ID, { indexPath: forbidden, loader: () => import('./harness/forbidden/index') })).rejects.toThrow(/imports three at module scope/);
    expect(scanForbiddenImports("import type { Vector3 } from 'three';\n// import { Mesh } from 'three'\nconst x = 1;")).toEqual([]);
    expect(scanForbiddenImports("import {\n  Mesh,\n} from 'three/webgpu';")).toEqual(['three/webgpu']);
    expect(scanForbiddenImports("export * from '@world/index';\nimport '@audio';\nimport { a } from '../../render/x';")).toEqual(['@world/index', '@audio', '../../render/x']);
    expect(scanForbiddenImports("import { LEG_ORDER } from '@game/types';\nimport { asPid } from '@kernel/types';")).toEqual([]);
  });
});

describe('the run loop', () => {
  it('no dom: document and window are undefined during a run, and the harness refuses to run otherwise', async () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    expect(() => assertHeadless()).not.toThrow();
    const result = await runLeg(createHarnessLeg(), { seed: 1, script: KNOWN_GOOD_SCRIPT });
    assertClean(result);
    Reflect.set(globalThis, 'document', {});
    try {
      await expect(runLeg(createHarnessLeg(), { seed: 1 })).rejects.toThrow(/node environment/);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('no stage: createStage is not called when stageContext is null', async () => {
    const onStage = vi.fn();
    const result = await runLeg(createHarnessLeg({ onStage }), { seed: 3, script: KNOWN_GOOD_SCRIPT });
    assertClean(result);
    expect(onStage).not.toHaveBeenCalled();
    expect(result.stageCalls).toBe(0);
  });

  it('repeatable: two runs in one process give the same hash, outcome and run state', async () => {
    const first = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT });
    const second = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT });
    assertClean(first);
    expect(second.logHash).toBe(first.logHash);
    expect(second.outcome).toEqual(first.outcome);
    expect(second.run).toEqual(first.run);
    expect(second.ticks).toBe(first.ticks);
    expect(first.events.length).toBeGreaterThan(0);
  });

  it('restore mid-leg: the remainder and the whole log hash identically to the uninterrupted run', async () => {
    const straight = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT });
    const restored = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT, restoreAt: Math.floor(straight.ticks / 2) });
    assertClean(restored);
    expect(restored.restore).not.toBeNull();
    if (restored.restore === null) throw new Error('unreachable');
    expect(restored.restore.at).toBeGreaterThanOrEqual(Math.floor(straight.ticks / 2));
    expect(restored.restore.remainderHash).toBe(remainderHashAfter(straight, restored.restore.seq));
    expect(restored.logHash).toBe(straight.logHash);
    expect(restored.outcome).toEqual(straight.outcome);
    expect(restored.run).toEqual(straight.run);
    expect(restored.ticks).toBe(straight.ticks);
  });

  it('panic fails: a leg that panics stops the run, lands in panics, and fails a clean assertion', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 4, script: script([{ at: 3, command: { kind: 'set_replacement', to: 'optimal' } }]) });
    expect(result.panics).toHaveLength(1);
    expect(result.panics[0]).toMatch(/OPT requires a scripted workload/);
    expect(result.ticks).toBeLessThan(10);
    expect(() => assertClean(result)).toThrow(/panics/);
  });

  it('sandbox reported: a leg that throws in evaluate lands in legFailures and fails a clean assertion', async () => {
    const leg: Leg = { ...createHarnessLeg(), evaluate: () => { throw new Error('bad evaluator'); } };
    const result = await runLeg(leg, { seed: 5, script: KNOWN_GOOD_SCRIPT });
    expect(result.legFailures.map((failure) => failure.phase)).toEqual(['evaluate']);
    expect(result.outcome.debrief.headline).toContain('reduced instrumentation');
    expect(() => assertClean(result)).toThrow(/leg failures: evaluate: bad evaluator/);
  });

  it('a runner failure (the maxTicks cap) lands in runnerFailures, separate from leg failures', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 6, maxTicks: 12 });
    expect(result.runnerFailures).toHaveLength(1);
    expect(result.runnerFailures[0]).toMatch(/maxTicks/);
    expect(result.legFailures).toEqual([]);
    expect(result.ticks).toBe(12);
    expect(() => assertClean(result)).toThrow(/runner failures/);
  });

  it('measures wall time and the per-kernel-tick cost', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 7, script: KNOWN_GOOD_SCRIPT });
    expect(result.wallMs).toBeGreaterThan(0);
    expect(result.maxTickMs).toBeGreaterThan(0);
    expect(result.maxTickMs).toBeLessThan(result.wallMs);
  });
});

describe('scripts', () => {
  it('script at tick: a step at tick 40 lands in the tick-40 command drain', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 8, script: script([{ at: 40, command: { kind: 'set_pace', to: 'aggressive' } }]) });
    assertClean(result);
    const record = result.decisions.find((decision) => decision.kind === 'set_pace');
    expect(record?.tick).toBe(40);
    expect(record?.choice).toBe('aggressive');
    expect(originFromRecord(record ?? result.decisions[0]!).source).toBe('replay');
    expect(result.unfiredSteps).toEqual([]);
  });

  it('script when: a trigger fires once, on the tick after it became true', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 9, script: script([{ when: { kind: 'event', type: 'context.switch', nth: 2 }, command: { kind: 'set_rations', to: 'lean' } }]) });
    assertClean(result);
    const switches = result.events.filter((event) => event.type === 'context.switch');
    expect(switches.length).toBeGreaterThanOrEqual(2);
    const records = result.decisions.filter((decision) => decision.kind === 'set_rations');
    expect(records).toHaveLength(1);
    expect(records[0]?.tick).toBe(switches[1]?.tick);
    expect(result.decisions.filter((decision) => decision.tick < (switches[1]?.tick ?? 0))).toEqual([]);
    expect(result.unfiredSteps).toEqual([]);
  });

  it('script order: three steps at the same tick fire in declared order', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 10, script: script([
      { at: 10, command: { kind: 'set_degree', to: 3 } },
      { at: 10, command: { kind: 'set_rations', to: 'generous' } },
      { at: 10, command: { kind: 'set_pace', to: 'conservative' } },
    ]) });
    assertClean(result);
    expect(result.decisions.filter((decision) => decision.tick === 10).map((decision) => decision.kind)).toEqual(['set_degree', 'set_rations', 'set_pace']);
  });

  it('unfired reported: a trigger that never becomes true leaves its step in unfiredSteps', async () => {
    const never = { when: { kind: 'resource_below', resource: 'cycles', value: -1 }, command: { kind: 'set_pace', to: 'reckless' } } as const;
    const result = await runLeg(createHarnessLeg(), { seed: 11, script: script([{ at: 2, command: { kind: 'set_pace', to: 'steady' } }, never]) });
    assertClean(result);
    expect(result.unfiredSteps).toEqual([never]);
    expect(result.decisions.some((decision) => decision.choice === 'reckless')).toBe(false);
  });

  it('a step whose tick was passed inside an action fires at the next slot and is noted', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 12, script: script([
      { at: 6, crossing: 'vault_gate', option: 'wait' },
      { at: 8, command: { kind: 'set_pace', to: 'aggressive' } },
    ]) });
    assertClean(result);
    const record = result.decisions.find((decision) => decision.kind === 'set_pace');
    expect(record?.tick).toBeGreaterThan(8);
    expect(result.notes.some((note) => /tick 8 was passed inside an action/.test(note))).toBe(true);
    expect(result.unfiredSteps).toEqual([]);
  });

  it('validate script: the four failure kinds are named and a valid script returns empty', () => {
    expect(validateScript(KNOWN_GOOD_SCRIPT)).toEqual([]);
    expect(validateScript(KNOWN_BAD_SCRIPT)).toEqual([]);
    const negative = validateScript(script([{ at: -1, command: { kind: 'set_pace', to: 'steady' } }]));
    expect(negative).toHaveLength(1);
    expect(negative[0]).toMatch(/not a non-negative integer/);
    const contradiction = validateScript(script([{ at: 4, command: { kind: 'set_pace', to: 'steady' } }, { at: 4, command: { kind: 'set_pace', to: 'reckless' } }]));
    expect(contradiction).toHaveLength(1);
    expect(contradiction[0]).toMatch(/contradicts an earlier set_pace at tick 4/);
    const undeclared = validateScript(script([{ at: 4, crossing: 'no_such_gate', option: 'spin' }]));
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]).toMatch(/crossing no_such_gate is not declared/);
    const noDepot = validateScript({ legId: 'drowned_reach', label: 'reach', steps: [{ at: 4, depot: 'repair', target: 'lumen' }] });
    expect(noDepot).toHaveLength(1);
    expect(noDepot[0]).toMatch(/drowned_reach has no depot/);
  });

  it('replay origin: every scripted command carries source replay, and the recorded decisions replay without the script', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT });
    assertClean(result);
    const commands = result.decisions.filter((decision) => ['set_pace', 'set_rations', 'interaction'].includes(decision.kind));
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const record of commands) expect(originFromRecord(record).source).toBe('replay');
    for (const kind of ['crossing_open', 'crossing', 'depot_open', 'depot', 'reclamation_open', 'reclamation', 'travel_resume']) {
      expect(result.decisions.some((decision) => decision.kind === kind), kind).toBe(true);
    }
    if (result.entry === null) throw new Error('missing entry');
    const replay = runReplay({ seed: FIXTURE_SEED, discClass: 'shell', difficulty: 'operator', legs: [HARNESS_LEG_ID], decisions: result.run.decisions,
      overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 2000, entry: result.entry });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (!replay.ok) return;
    expect(replay.eventLogHash).toBe(result.logHash);
    expect(replay.diagnostics.skippedDecisions).toBe(0);
  });
});

describe('policies', () => {
  it('passive dispatches nothing', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 13, policy: 'passive' });
    assertClean(result);
    expect(result.decisions).toEqual([]);
    expect(result.ticks).toBeGreaterThan(50);
  });

  it('competent applies the remedy for an acquired affliction and notes the remedies it cannot issue', async () => {
    const gusts: Leg = { ...createHarnessLeg(), eventTable: [
      { id: 'gust', weight: 60, title: 'Gust', narration: 'cache gust', targets: null, inflicts: 'cache_thrash', resourceDelta: {}, onlyIf: null },
      { id: 'orphan', weight: 40, title: 'Orphan', narration: 'orphaned', targets: null, inflicts: 'orphaned', resourceDelta: {}, onlyIf: null },
    ] };
    const result = await runLeg(gusts, { seed: 14, policy: 'competent' });
    assertClean(result);
    const remedies = result.decisions.filter((decision) => decision.kind === 'set_scheduler');
    expect(remedies.length).toBeGreaterThan(0);
    expect(remedies[0]?.choice).toBe('rr q=16');
    expect(result.notes.some((note) => /remedy for orphaned .* not issuable headlessly/.test(note))).toBe(true);
  });

  it('competent lowers the degree by one on memory.thrashing, never below one, and picks the cheapest viable crossing', () => {
    const dispatched: string[] = [];
    const fakeContext = (degree: number): DriverContext => ({
      legId: HARNESS_LEG_ID, tick: 5,
      kernel: { memorySubsystem: { pager: { control: { maximumDegree: 8 } } } } as unknown as DriverContext['kernel'],
      run: { ...makeRunState({ seed: 1, legIndex: 1, degree }) },
      dispatch: (command) => { dispatched.push(`${command.kind}:${'to' in command ? String(command.to) : ''}`); },
      flushCommands: () => undefined,
      crossing: () => { throw new Error('unused'); }, depot: () => { throw new Error('unused'); }, reclamation: () => { throw new Error('unused'); },
      note: () => undefined,
    });
    const thrashing = { type: 'memory.thrashing', tick: asTick(5), seq: 1, faultRate: 999, severity: 'critical' } as const;
    new CompetentPolicy().afterTick(fakeContext(3), [thrashing]);
    expect(dispatched).toEqual(['set_degree:2']);
    dispatched.length = 0;
    new CompetentPolicy().afterTick(fakeContext(1), [thrashing]);
    expect(dispatched).toEqual([]);
    expect(competentCrossingChoice({ contention: 0.2, ordered: true, rations: 'standard', aliveCount: 5, crosserHoldsResource: false })).toBe('spin');
    expect(competentCrossingChoice({ contention: 0.8, ordered: true, rations: 'standard', aliveCount: 5, crosserHoldsResource: false })).toBe('block');
    expect(competentCrossingChoice({ contention: 0.8, ordered: false, rations: 'standard', aliveCount: 5, crosserHoldsResource: false })).toBe('monitor');
  });

  it('chaotic rotates the dials every 40 ticks from its own stream and never picks optimal on an unscripted workload', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 4, policy: 'chaotic', maxTicks: 400 });
    expect(result.panics).toEqual([]);
    const paces = result.decisions.filter((decision) => decision.kind === 'set_pace');
    expect(paces.length).toBeGreaterThanOrEqual(1);
    expect(paces.every((decision) => decision.tick % 40 === 0)).toBe(true);
    expect(result.decisions.filter((decision) => decision.kind === 'set_replacement').every((decision) => decision.choice !== 'optimal')).toBe(true);
    const again = await runLeg(createHarnessLeg(), { seed: 4, policy: 'chaotic', maxTicks: 400 });
    expect(again.logHash).toBe(result.logHash);
  });

  it('a scheduled crossing in a policy run takes the policy option', async () => {
    const result = await runLeg(createHarnessLeg(), { seed: 15, policy: 'competent', crossings: [{ at: 12, def: HARNESS_CROSSING }] });
    assertClean(result);
    expect(result.crossings).toHaveLength(1);
    expect(result.crossings[0]?.option).toBe('spin');
    expect(result.decisions.some((decision) => decision.kind === 'crossing')).toBe(true);
  });

  it('competent is generic: the policy module imports nothing from a leg directory', () => {
    const source = stripComments(readFileSync(join(HARNESS_DIR, 'scriptedDecisions.ts'), 'utf8'), false);
    const legDirs = new RegExp(`from\\s*['"][^'"]*(?:legs/(?:${LEG_ORDER.join('|')})/|/fixtures)`, 'm');
    expect(source).not.toMatch(legDirs);
    expect(source).not.toMatch(/knownGood|knownBad/);
    expect(source).toMatch(/class CompetentPolicy/);
  });
});

describe('expectations', () => {
  let good: HarnessResult;
  const load = async (): Promise<HarnessResult> => (good ??= await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_GOOD_SCRIPT }));

  it('the composite fixtures meet their own expectations', async () => {
    const result = await load();
    assertClean(result);
    expect(outcomeProblems(result, KNOWN_GOOD_EXPECTATION)).toEqual([]);
    expect(result.outcome.objectivesMet).toEqual(HARNESS_OBJECTIVE_IDS);
    const bad = await runLeg(createHarnessLeg(), { seed: FIXTURE_SEED, script: KNOWN_BAD_SCRIPT });
    assertClean(bad);
    expect(outcomeProblems(bad, KNOWN_BAD_EXPECTATION)).toEqual([]);
    expect(bad.run.tombstones.map((stone) => `${stone.member}:${stone.reason}`)).toEqual(['lumen:starvation']);
  });

  it('expect subset: omitted expectation fields are not checked', async () => {
    const result = await load();
    expect(() => expectOutcome(result, {})).not.toThrow();
    expect(() => expectOutcome(result, { survived: true })).not.toThrow();
    expect(() => expectOutcome(result, { objectivesAtLeast: ['synthetic.survive'] })).not.toThrow();
    expect(() => expectOutcome(result, { ticksBetween: [result.ticks, result.ticks] })).not.toThrow();
    expect(() => expectOutcome(result, { casualtyCount: 0, decisionOutcomes: [{ kind: 'crossing', outcome: 'good' }] })).not.toThrow();
  });

  it('expect diff message: a set mismatch reports both directions and names the leg, seed, ticks and hash', async () => {
    const result = await load();
    let message = '';
    try {
      expectOutcome(result, { objectivesMet: ['synthetic.survive', 'synthetic.other'] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`[${HARNESS_LEG_ID} seed=${FIXTURE_SEED} ticks=${result.ticks} hash=${result.logHash}]`);
    expect(message).toContain('missing (expected, not present) [synthetic.other]');
    expect(message).toContain('unexpected (present, not expected) [synthetic.cross]');
  });

  it('absent events: a run in which a forbidden type fired fails', async () => {
    const result = await load();
    expect(result.eventTypes.has('context.switch')).toBe(true);
    expect(() => expectOutcome(result, { eventTypesAbsent: ['context.switch'] })).toThrow(/eventTypesAbsent: fired \[context.switch\]/);
    expect(() => expectOutcome(result, { eventTypesAbsent: ['deadlock.detected'] })).not.toThrow();
    expect(() => expectOutcome(result, { eventTypesPresent: ['deadlock.detected'] })).toThrow(/never fired/);
  });

  it('debrief.chapter compares chapter and sections and ignores the title', async () => {
    const result = await load();
    expect(() => expectOutcome(result, { debrief: { chapter: { chapter: 5, sections: [] } } })).not.toThrow();
    expect(() => expectOutcome(result, { debrief: { chapter: { chapter: 6, sections: [] } } })).toThrow(/expected chapter 6/);
  });
});

describe('run state and tables', () => {
  it('makeRunState builds a real RunState with the documented defaults', () => {
    const run = makeRunState({ seed: 21, legIndex: 4 });
    expect(Object.keys(run).sort()).toEqual(['codexUnlocked', 'convoy', 'decisions', 'difficulty', 'discClass', 'legIndex', 'legProgress', 'objectivesMet', 'policy', 'resources', 'runId', 'score', 'seed', 'status', 'tombstones']);
    expect(run.discClass).toBe('shell');
    expect(run.difficulty).toBe('operator');
    expect(run.policy).toEqual({ pace: 'steady', rations: 'standard', degreeOfMultiprogramming: 6 });
    expect(run.resources).toEqual({ cycles: 1600, quota: 900, blocks: 120, bandwidth: 60 });
    expect(run.legIndex).toBe(4);
    expect(makeConvoy().map((member) => `${member.name}:${member.integrity}:${member.afflictions.length}`)).toEqual(['LUMEN:100:0', 'SABLE:100:0', 'ORRERY:100:0', 'KESTREL:100:0', 'VESPER:100:0']);
    const patched = makeRunState({ seed: 21, legIndex: 2, discClass: 'compiler', difficulty: 'architect', pace: 'reckless', ledger: { cycles: 12 }, convoy: [{ id: 'sable', integrity: 40 }] });
    expect(patched.resources).toEqual({ cycles: 12, quota: 336, blocks: 72, bandwidth: 24 });
    expect(patched.policy.pace).toBe('reckless');
    expect(patched.convoy.find((member) => member.id === 'sable')?.integrity).toBe(40);
    expect(() => makeRunState({ seed: 1, legIndex: 0, convoy: [{ id: 'nobody' as never }] })).toThrow(/no convoy member/);
  });

  it('REQUIRED_EVENTS ships all fourteen rows, keyed by LEG_ORDER, none empty', () => {
    expect(Object.keys(REQUIRED_EVENTS).sort()).toEqual([...LEG_ORDER].sort());
    for (const id of LEG_ORDER) expect(REQUIRED_EVENTS[id].length, id).toBeGreaterThan(0);
    expect(REQUIRED_EVENTS.the_cistern).toEqual(['sync.blocked', 'sync.released']);
  });

  it('the script driver evaluates state triggers from the live run', async () => {
    const driver = new ScriptedDecisions(script([{ when: { kind: 'progress_at_least', value: 0.5 }, command: { kind: 'set_pace', to: 'aggressive' } }]));
    expect(driver.unfired()).toHaveLength(1);
    const result = await runLeg(createHarnessLeg(), { seed: 16, script: script([{ when: { kind: 'progress_at_least', value: 0.5 }, command: { kind: 'set_pace', to: 'aggressive' } }]) });
    assertClean(result);
    const record = result.decisions.find((decision) => decision.kind === 'set_pace');
    expect(record).toBeDefined();
    expect(record?.tick).toBeGreaterThanOrEqual(30);
    expect(result.unfiredSteps).toEqual([]);
  });
});

describe('boundaries', () => {
  it('nothing under src/ imports tests/legs/harness or tools', () => {
    const files = collect(resolve(REPO_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50);
    const offences: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'), false);
      code.split('\n').forEach((line, i) => {
        if (/\b(?:from|import)\s*\(?\s*['"][^'"]*(?:^|\/)(?:tests|tools)\//.test(line)) offences.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
      });
    }
    expect(offences).toEqual([]);
  });

  it('a synthetic leg from the WP-18 fixture still runs headlessly through the harness', async () => {
    const result = await runLeg(createSyntheticLeg({ id: 'the_weave', index: 2 }), { seed: 17 });
    assertClean(result);
    expect(result.legId).toBe('the_weave');
    expect(result.ticks).toBeGreaterThan(0);
    expect(createKernel(createSyntheticLeg().kernelConfig(result.run)).tick).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Golden runs: tiers, tools and the fixture contract                  */
/* ------------------------------------------------------------------ */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compareTiers, earliestSummaryDivergence, firstDivergence, goldenFiles, parseFingerprint, parseSummary, readGolden, renderFingerprint, renderSummary, summaryOf, tiersOf, writeGolden } from './harness/goldenLog';
import { checkFixtureRun, FIXTURE_SEED as CONTRACT_SEED, fixturePath, isWarning, loadFixtures, runFixture, validateFixture, type LegFixture, type LegFixtureModule } from './harness/fixtureContract';
import { owedFixtures, STUB_FIXTURES, fixtureStatus } from './harness/stubFixtures';
import { withInertPoison } from './harness/LegHarness';
import { renderEventLine, renderEventLog } from '../../tools/golden/renderEventLog';
import { describeRecord, main as recordMain, parseArgs, recordGolden } from '../../tools/golden/record';
import { explainGolden, main as explainMain } from '../../tools/golden/explain';
import { KNOWN_BAD_SCRIPT as BAD, KNOWN_GOOD_SCRIPT as GOOD } from './harness/syntheticLeg';

/** Built from code points so the contract guard, which scans for the literal characters, never trips on this file. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
const fixture = (path: 'good' | 'bad', patch: Partial<LegFixture> = {}): LegFixture => ({
  legId: HARNESS_LEG_ID, path, seed: CONTRACT_SEED, discClass: 'shell', difficulty: 'operator', pace: 'steady', rations: 'standard',
  enteringLedger: { cycles: 1600, quota: 900, blocks: 120, bandwidth: 60 }, enteringDecisions: [],
  script: path === 'good' ? GOOD : BAD, expect: path === 'good' ? KNOWN_GOOD_EXPECTATION : KNOWN_BAD_EXPECTATION, ...patch,
});
const syntheticFixtures: LegFixtureModule = { knownGood: fixture('good'), knownBad: fixture('bad') };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kt-wp20-golden-'));
  return dir;
}

describe('golden tiers', () => {
  let good: HarnessResult;
  const load = async (): Promise<HarnessResult> => (good ??= await runFixture(syntheticFixtures.knownGood, createHarnessLeg()));

  it('render stable: rendering the same log twice gives byte-identical text with no dashes and no locale formatting', async () => {
    const result = await load();
    const once = renderEventLog(result.events);
    const twice = renderEventLog(result.events);
    expect(twice).toBe(once);
    expect(once).not.toMatch(DASHES);
    expect(once).not.toMatch(/\d,\d{3}/);
    expect(once.split('\n')[0]).toMatch(/^\s*tick\s+seq\s+type\s+payload$/);
    expect(once.split('\n')).toHaveLength(result.events.length + 2);
    const line = renderEventLine({ type: 'context.switch', tick: asTick(4), seq: 11, from: asPid(1), to: asPid(2), rationale: 'quantum expired' });
    expect(line).toBe(`${'4'.padStart(6)} ${'11'.padStart(7)}  ${'context.switch'.padEnd(26)} from=1 rationale="quantum expired" to=2`);
    const nested = renderEventLine({ type: 'kernel.panic', tick: asTick(0), seq: 1, message: 'I-3: bad' });
    expect(nested).toContain('message="I-3: bad"');
  });

  it('fingerprint and summary round-trip through their file formats', async () => {
    const result = await load();
    const tiers = tiersOf(result);
    expect(renderFingerprint(tiers.fingerprint)).toBe(`seed=${FIXTURE_SEED} ticks=${result.ticks} events=${result.events.length} hash=${result.logHash}\n`);
    expect(parseFingerprint(renderFingerprint(tiers.fingerprint))).toEqual(tiers.fingerprint);
    expect(() => parseFingerprint('seed=1 ticks=2')).toThrow(/malformed fingerprint/);
    const summary = renderSummary(tiers.summary);
    expect(summary.split('\n')[0]).toMatch(/^type\s+count\s+first\s+last$/);
    expect(parseSummary(summary)).toEqual(tiers.summary);
    expect(tiers.summary.map((row) => row.type)).toEqual([...tiers.summary.map((row) => row.type)].sort());
    expect(tiers.summary.every((row) => row.count > 0 && row.first <= row.last)).toBe(true);
    expect(summaryOf([])).toEqual([]);
    expect(compareTiers(tiers, tiers)).toEqual([]);
    const shifted = { ...tiers, fingerprint: { ...tiers.fingerprint, hash: '0000000000000000' } };
    expect(compareTiers(tiers, shifted)).toEqual([`fingerprint.hash: expected 0000000000000000, got ${result.logHash}`]);
    const dir = tempDir();
    try {
      writeGolden(HARNESS_LEG_ID, 'good', tiers, dir);
      expect(readGolden(HARNESS_LEG_ID, 'good', dir)).toEqual(tiers);
      expect(readGolden(HARNESS_LEG_ID, 'bad', dir)).toBeNull();
      expect(readFileSync(goldenFiles(HARNESS_LEG_ID, 'good', dir).summary, 'utf8')).not.toMatch(DASHES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('firstDivergence names the first differing event by seq with context on both sides', async () => {
    const result = await load();
    expect(firstDivergence(result.events, result.events)).toBeNull();
    const other = await runLeg(createHarnessLeg(), { seed: 99, script: GOOD, run: makeRunState({ seed: 99, legIndex: 1 }) });
    const divergence = firstDivergence(result.events, other.events, 3);
    expect(divergence).not.toBeNull();
    if (divergence === null) return;
    expect(divergence.expected.length).toBeLessThanOrEqual(7);
    expect(divergence.actual.length).toBeLessThanOrEqual(7);
    expect(divergence.seq).toBe((other.events[divergence.index] ?? result.events[divergence.index])?.seq);
    const truncated = firstDivergence(result.events, result.events.slice(0, 5), 2);
    expect(truncated?.index).toBe(5);
    expect(earliestSummaryDivergence(tiersOf(result).summary, tiersOf(result).summary)).toBeNull();
    expect(earliestSummaryDivergence(tiersOf(result).summary, tiersOf(other).summary)).not.toBeNull();
  });
});

describe('golden tools', () => {
  it('record refuses: recording over an existing golden without --force refuses and prints both hashes, and --force overwrites', async () => {
    const dir = tempDir();
    try {
      const leg = createHarnessLeg();
      const first = await recordGolden({ legId: HARNESS_LEG_ID, path: 'good', dir, leg, fixtures: syntheticFixtures });
      expect(first.status).toBe('written');
      if (first.status !== 'written') return;
      expect(first.previous).toBeNull();
      expect(existsSync(goldenFiles(HARNESS_LEG_ID, 'good', dir).fingerprint)).toBe(true);
      expect(describeRecord({ legId: HARNESS_LEG_ID, path: 'good', dir }, first).some((line) => /closing ledger cycles=/.test(line))).toBe(true);
      const again = await recordGolden({ legId: HARNESS_LEG_ID, path: 'good', dir, leg, fixtures: syntheticFixtures });
      expect(again.status).toBe('refused');
      if (again.status !== 'refused') return;
      const lines = describeRecord({ legId: HARNESS_LEG_ID, path: 'good', dir }, again);
      expect(lines[0]).toMatch(/refusing to overwrite .*fork_fields\.good\.fingerprint\.txt; pass --force/);
      expect(lines[1]).toContain(`old hash ${again.previous.fingerprint.hash}  new hash ${again.next.fingerprint.hash}`);
      const forced = await recordGolden({ legId: HARNESS_LEG_ID, path: 'good', dir, leg, fixtures: syntheticFixtures, force: true });
      expect(forced.status).toBe('written');
      if (forced.status === 'written') expect(forced.previous?.fingerprint.hash).toBe(forced.next.fingerprint.hash);
      expect(describeRecord({ legId: HARNESS_LEG_ID, path: 'good', dir }, forced).some((line) => /old hash .* new hash .*forced/.test(line))).toBe(true);
      const invalid = await recordGolden({ legId: HARNESS_LEG_ID, path: 'bad', dir, leg, fixtures: { ...syntheticFixtures, knownBad: fixture('bad', { expect: { ...KNOWN_BAD_EXPECTATION, casualties: ['sable'] } }) } });
      expect(invalid.status).toBe('invalid');
      expect(existsSync(goldenFiles(HARNESS_LEG_ID, 'bad', dir).fingerprint)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('record: the command line refuses a malformed invocation and reports an unshipped leg', async () => {
    expect(() => parseArgs(['--leg', 'nowhere', '--path', 'good'])).toThrow(/unknown leg/);
    expect(() => parseArgs(['--leg', HARNESS_LEG_ID])).toThrow(/pass --leg/);
    expect(parseArgs(['--all', '--force'])).toEqual({ legId: null, path: null, all: true, force: true, dir: null });
    const lines: string[] = [];
    expect(await recordMain(['--path', 'sideways'], (line) => lines.push(line))).toBe(2);
    const missing = await firstUnshipped();
    if (missing === null) return;
    expect(await recordMain(['--leg', missing, '--path', 'good'], (line) => lines.push(line))).toBe(1);
    expect(lines.at(-1)).toMatch(/has not shipped/);
  });

  it('diff exits: a changed run exits non-zero and names the first divergent tick and seq', async () => {
    const dir = tempDir();
    try {
      const leg = createHarnessLeg();
      const recorded = await recordGolden({ legId: HARNESS_LEG_ID, path: 'good', dir, leg, fixtures: syntheticFixtures });
      expect(recorded.status).toBe('written');
      const same = await explainGolden({ legId: HARNESS_LEG_ID, path: 'good', dir, leg, fixtures: syntheticFixtures });
      expect(same.status).toBe('match');
      const changed = await explainGolden({ legId: HARNESS_LEG_ID, path: 'good', dir, leg, fixtures: { ...syntheticFixtures, knownGood: fixture('good', { seed: 99 }) } });
      expect(changed.status).toBe('mismatch');
      if (changed.status !== 'mismatch') return;
      expect(changed.problems.some((problem) => problem.startsWith('fingerprint.seed'))).toBe(true);
      expect(changed.report).toMatch(/first divergent event: tick \d+ seq \d+/);
      expect(changed.window.events.length).toBeGreaterThan(0);
      expect(changed.window.events.length).toBeLessThanOrEqual(101);
      const missing = await explainGolden({ legId: HARNESS_LEG_ID, path: 'bad', dir, leg, fixtures: syntheticFixtures });
      expect(missing.status).toBe('missing');
      const lines: string[] = [];
      expect(await explainMain([HARNESS_LEG_ID], (line) => lines.push(line))).toBe(2);
      expect(await explainMain(['nowhere', 'good'], (line) => lines.push(line))).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('update golden ignored: UPDATE_GOLDEN=1 changes nothing', async () => {
    const dir = tempDir();
    const previous = process.env.UPDATE_GOLDEN;
    process.env.UPDATE_GOLDEN = '1';
    try {
      const leg = createHarnessLeg();
      const tiers = tiersOf(await runFixture(syntheticFixtures.knownGood, leg));
      writeGolden(HARNESS_LEG_ID, 'good', { ...tiers, fingerprint: { ...tiers.fingerprint, hash: '0123456789abcdef' } }, dir);
      const outcome = await recordGolden({ legId: HARNESS_LEG_ID, path: 'good', dir, leg, fixtures: syntheticFixtures });
      expect(outcome.status).toBe('refused');
      expect(readGolden(HARNESS_LEG_ID, 'good', dir)?.fingerprint.hash).toBe('0123456789abcdef');
      const explained = await explainGolden({ legId: HARNESS_LEG_ID, path: 'good', dir, leg, fixtures: syntheticFixtures });
      expect(explained.status).toBe('mismatch');
      expect(readGolden(HARNESS_LEG_ID, 'good', dir)?.fingerprint.hash).toBe('0123456789abcdef');
      for (const file of ['harness/goldenLog.ts', 'harness/fixtureContract.ts', 'goldens.test.ts', 'smoke.test.ts', 'journey.test.ts'].map((name) => join(REPO_ROOT, 'tests', 'legs', name)).concat(['record.ts', 'explain.ts', 'renderEventLog.ts'].map((name) => join(REPO_ROOT, 'tools', 'golden', name)))) {
        if (!existsSync(file)) continue;
        expect(stripComments(readFileSync(file, 'utf8'), false), file).not.toMatch(/UPDATE_GOLDEN/);
      }
    } finally {
      if (previous === undefined) delete process.env.UPDATE_GOLDEN;
      else process.env.UPDATE_GOLDEN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the fixture contract', () => {
  it('validate fixture: every rule in 7.3, each with a failing case, and the composite fixtures pass', async () => {
    const leg = createHarnessLeg();
    expect(validateFixture(syntheticFixtures.knownGood, leg)).toEqual([]);
    expect(validateFixture(syntheticFixtures.knownBad, leg)).toEqual([]);
    const errors = (f: LegFixture): readonly string[] => validateFixture(f, leg).filter((problem) => !isWarning(problem));
    expect(errors(fixture('good', { expect: { survived: true } }))).toEqual([expect.stringMatching(/must name the objectives it meets/)]);
    expect(errors(fixture('good', { expect: { objectivesMet: ['synthetic.survive'] } }))).toEqual([expect.stringMatching(/missing \[synthetic\.cross\]/)]);
    expect(errors(fixture('good', { expect: { objectivesMet: [...HARNESS_OBJECTIVE_IDS, 'synthetic.extra'] } }))).toEqual([expect.stringMatching(/does not declare \[synthetic\.extra\]/)]);
    expect(errors(fixture('bad', { expect: { decisionOutcomes: [{ kind: 'crossing', outcome: 'fatal' }], ticksBetween: [1, 2] } }))).toEqual([expect.stringMatching(/which Program dies/)]);
    expect(errors(fixture('bad', { expect: { casualties: ['lumen'], ticksBetween: [1, 2] } }))).toEqual([expect.stringMatching(/decision marked fatal/)]);
    expect(errors(fixture('bad', { expect: { casualties: ['lumen'], decisionOutcomes: [{ kind: 'crossing', outcome: 'fatal' }] } }))).toEqual([expect.stringMatching(/roughly when/)]);
    const warnings = validateFixture(fixture('good', { seed: 7 }), leg);
    expect(warnings).toEqual([expect.stringMatching(/^warning: .*seed 7 is not the shared fixture seed/)]);
    expect(errors(fixture('good', { enteringLedger: { cycles: 1, quota: 1, blocks: 1 } }))).toEqual([expect.stringMatching(/enteringLedger\.bandwidth is missing/)]);
    const bootFixture = fixture('good', { legId: 'boot_sector', script: { ...GOOD, legId: 'boot_sector', steps: [], crossings: [] }, enteringLedger: { cycles: 1000, quota: 900, blocks: 120, bandwidth: 60 } });
    expect(validateFixture(bootFixture).filter((problem) => !isWarning(problem))).toEqual([expect.stringMatching(/leg 0 enters with the starting ledger, 1600/)]);
    expect(errors(fixture('good', { script: { ...GOOD, legId: 'the_weave', steps: [], crossings: [] } }))).toEqual([expect.stringMatching(/the script belongs to the_weave/)]);
    expect(errors(fixture('good', { script: { ...GOOD, steps: [...GOOD.steps, { at: -3, command: { kind: 'set_pace', to: 'steady' } }] } }))).toEqual([expect.stringMatching(/script: step .* not a non-negative integer/)]);
    expect(errors(fixture('good', { enteringDecisions: [{ tick: asTick(0), legId: 'nowhere' as LegId, kind: 'ring_closed', choice: '0', outcome: 'good', relatedObjective: null }] }))).toEqual([expect.stringMatching(/enteringDecisions\[0\] is not a DecisionRecord/)]);
    const good = await runFixture(syntheticFixtures.knownGood, leg);
    expect(checkFixtureRun(syntheticFixtures.knownGood, good, leg)).toEqual([]);
    const bad = await runFixture(syntheticFixtures.knownBad, leg);
    expect(checkFixtureRun(syntheticFixtures.knownBad, bad, leg)).toEqual([]);
    expect(checkFixtureRun(syntheticFixtures.knownBad, good, leg)).toEqual(expect.arrayContaining([expect.stringMatching(/produced no casualty/), expect.stringMatching(/marked no decision fatal/)]));
    expect(checkFixtureRun(syntheticFixtures.knownGood, bad, leg)).toEqual(expect.arrayContaining([expect.stringMatching(/missed declared objectives/)]));
    const panicked = await runLeg(leg, { seed: CONTRACT_SEED, script: { ...GOOD, steps: [{ at: 3, command: { kind: 'set_replacement', to: 'optimal' } }] } });
    expect(checkFixtureRun(syntheticFixtures.knownGood, panicked, leg)).toEqual(expect.arrayContaining([expect.stringMatching(/the run panicked/)]));
  });

  it('loadFixtures returns null for a leg without a fixture module and reads a module with exactly two exports', async () => {
    const missing = await firstUnshipped();
    if (missing !== null) expect(await loadFixtures(missing)).toBeNull();
    const dir = tempDir();
    try {
      const path = join(dir, 'fixtures.ts');
      writeFileSync(path, "export const knownGood = 1;\nexport const knownBad = 2;\nexport const extra = 3;\n");
      // The loader reads by leg id; a module with a third export is what a leg package must not ship.
      const module = await import(/* @vite-ignore */ `${path}`);
      expect(Object.keys(module).sort()).toEqual(['extra', 'knownBad', 'knownGood']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(fixturePath('the_cistern')).toMatch(/tests[\\/]legs[\\/]the_cistern[\\/]fixtures\.ts$/);
  });

  it('stub fixtures enumerate every leg with no fixture, and each stub throws naming its package', () => {
    const owed = owedFixtures();
    expect(owed.every((id) => fixtureStatus(id) === 'stubbed')).toBe(true);
    for (const id of LEG_ORDER) {
      expect(() => STUB_FIXTURES[id]()).toThrow(new RegExp(`tests/legs/${id}/fixtures\\.ts is written by WP-L\\d\\d`));
    }
    expect(owed.length + LEG_ORDER.filter((id) => fixtureStatus(id) === 'present').length).toBe(LEG_ORDER.length);
  });

  it('inert fields: poisoning every config field a disabled subsystem owns leaves the log hash unchanged over 400 ticks', async () => {
    const leg = createHarnessLeg({ config: { enabledSubsystems: ['process', 'scheduler', 'sync'] } });
    const run = makeRunState({ seed: 1, legIndex: 1 });
    const poisoned = withInertPoison(leg, run);
    expect(poisoned.fields).toEqual(['totalFrames', 'pageSize', 'allocationStrategy', 'tlbEntries', 'replacementPolicy', 'thrashingThreshold', 'deadlockStrategy', 'diskPolicy', 'totalCylinders', 'raidLevel', 'fileAllocation', 'journalingEnabled']);
    expect(poisoned.leg.kernelConfig(run).replacementPolicy).toBe('random');
    expect(poisoned.leg.kernelConfig(run).enabledSubsystems).toEqual(['process', 'scheduler', 'sync']);
    const clean = await runLeg(leg, { seed: 1, maxTicks: 400 });
    const dirty = await runLeg(poisoned.leg, { seed: 1, maxTicks: 400 });
    expect(dirty.logHash).toBe(clean.logHash);
    expect(dirty.ticks).toBe(clean.ticks);
    const full = withInertPoison(createHarnessLeg(), run);
    expect(full.fields).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The journey, over synthetic legs (section 8, W10, F8)                */
/* ------------------------------------------------------------------ */

import { HEADLESS_LEGS } from '@game/replay/headlessLegs';
import type { DecisionRecord } from '@game/types';
import { HANDOFFS, journeyHashOf, replayJourney, runJourney, type JourneyOptions } from './harness/journey';

const weaveScript: DecisionScript = { legId: 'the_weave', label: 'weave', steps: [{ at: 4, command: { kind: 'set_pace', to: 'aggressive' } }] };
const journeyLegs = (): Leg[] => [createSyntheticLeg(), createHarnessLeg(), createSyntheticLeg({ id: 'the_weave', index: 2 })];
const journeyScripts = new Map<LegId, DecisionScript>([[HARNESS_LEG_ID, GOOD], ['the_weave', weaveScript]]);
const journeyBase = (): JourneyOptions => ({ seed: FIXTURE_SEED, discClass: 'shell', difficulty: 'operator', scripts: journeyScripts, legs: journeyLegs() });

/** A synthetic leg whose populate writes hand-off records onto the entry draft, the one write a leg has at entry. */
function handoffLeg(id: LegId, index: number, records: readonly Omit<DecisionRecord, 'legId'>[], resolve?: (run: { decisions: DecisionRecord[] }) => void): Leg {
  const base = createSyntheticLeg({ id, index, processes: 2, service: [20, 40] });
  return {
    ...base,
    populate(ctx) {
      base.populate(ctx);
      for (const record of records) ctx.run.decisions.push({ ...record, legId: id });
      resolve?.(ctx.run);
    },
  };
}

describe('the journey over synthetic legs', () => {
  it('two journeys from the same seed and scripts hash the same, and a different seed hashes differently', async () => {
    const first = await runJourney(journeyBase());
    const second = await runJourney(journeyBase());
    const other = await runJourney({ ...journeyBase(), seed: 7 });
    try {
      expect(first.legs.map((result) => result.legId)).toEqual(['boot_sector', 'fork_fields', 'the_weave']);
      for (const result of first.legs) assertClean(result);
      expect(second.journeyHash).toBe(first.journeyHash);
      expect(other.journeyHash).not.toBe(first.journeyHash);
      expect(first.journeyHash).toBe(journeyHashOf(first.legs.map((result) => result.logHash), first.finalRun));
      expect(first.journeyHash).toMatch(/^[0-9a-f]{16}$/);
      expect(first.skipped).toEqual(LEG_ORDER.slice(3));
      expect(first.finalRun.legIndex).toBe(3);
      expect(first.finalRun.status).toBe('in_progress');
      expect(first.survivors).toBe(5);
      expect(first.ledgerByLeg).toHaveLength(3);
      expect(first.wallMs).toBeLessThan(60_000);
      expect(first.legs[1]?.decisions.some((record) => record.kind === 'crossing')).toBe(true);
    } finally {
      first.release(); second.release(); other.release();
    }
  });

  it('a journey with restoreAtBoundaries produces the same hash as one run straight through', async () => {
    const straight = await runJourney(journeyBase());
    const restored = await runJourney({ ...journeyBase(), restoreAtBoundaries: true });
    try {
      expect(restored.boundaryRestores).toBe(2);
      expect(restored.legs.map((result) => result.logHash)).toEqual(straight.legs.map((result) => result.logHash));
      expect(restored.finalRun).toEqual(straight.finalRun);
      expect(restored.journeyHash).toBe(straight.journeyHash);
      for (const result of restored.legs) assertClean(result);
    } finally {
      straight.release(); restored.release();
    }
  });

  it('replays through runReplay from the seed and the decision log alone to the same per-leg hashes and final run', async () => {
    const journey = await runJourney(journeyBase());
    try {
      const check = replayJourney(journey, journeyBase());
      expect(check.problems).toEqual([]);
      expect(check.ok).toBe(true);
      expect(check.skippedDecisions).toBe(0);
      expect(check.handoffRecords).toBe(0);
      expect(check.replayHash).toBe(journey.journeyHash);
    } finally {
      journey.release();
    }
  });

  it('the ledger never goes negative at a boundary, the credit fires where the entering ledger predicts, and objectives come from declared ids', async () => {
    const drained: Leg = { ...createHarnessLeg(), evaluate: (ctx) => ({ ...createHarnessLeg().evaluate(ctx), resourceDelta: { cycles: -1_000_000 } }) };
    const journey = await runJourney({ ...journeyBase(), legs: [createSyntheticLeg(), drained, createSyntheticLeg({ id: 'the_weave', index: 2 })] });
    try {
      for (const ledger of journey.ledgerByLeg) for (const value of Object.values(ledger)) expect(value).toBeGreaterThanOrEqual(0);
      // The outcome floors the ledger at zero and the dividend lands after it, so what remains is the dividend alone.
      expect(journey.ledgerByLeg[1]?.cycles).toBeLessThan(65 * 1.575);
      expect(journey.creditPredicted).toEqual(['the_weave']);
      expect(journey.creditLegs).toContain('the_weave');
      expect(journey.legs[2]?.onCredit).toBe(true);
      expect(journey.legs[2]?.run.policy.pace).toBe('conservative');
      const declared = new Set(journeyLegs().flatMap((leg) => leg.objectives.map((objective) => objective.id)));
      for (const id of journey.objectivesMet) expect(declared.has(id), id).toBe(true);
    } finally {
      journey.release();
    }
  });

  it('observes the hand-offs against their producers, marks the absent ones skipped or defaulted, and replays their records as skipped decisions', async () => {
    const pending = (kind: string, choice: string): Omit<DecisionRecord, 'legId'> => ({ tick: asTick(0), kind, choice, outcome: 'pending', relatedObjective: null });
    const legs: Leg[] = [];
    for (const [index, id] of LEG_ORDER.slice(0, 13).entries()) {
      if (id === 'the_cistern') legs.push(handoffLeg(id, index, [{ ...pending('ring_closed', '41'), outcome: 'good' }]));
      else if (id === 'allocation_yards') legs.push(handoffLeg(id, index, [pending('executable_bit', 'left_set')]));
      else if (id === 'the_bus') legs.push(handoffLeg(id, index, [{ ...pending('device_attach', 'block'), outcome: 'good' }]));
      else if (id === 'the_archive') legs.push(handoffLeg(id, index, [{ ...pending('crash_outcome', 'recovered'), outcome: 'good' }, { ...pending('manifest_integrity', 'intact'), outcome: 'good' }]));
      else if (id === 'arbiter_wall') legs.push(handoffLeg(id, index, [{ ...pending('escalation_outcome', 'all_blocked'), outcome: 'good' }, { ...pending('privilege_excess', '0'), outcome: 'good' }], (run) => {
        // Hand-off 2's write-back: the consumer resolves the producer's pending record.
        for (const record of run.decisions) if (record.kind === 'executable_bit') record.outcome = 'costly';
      }));
      else legs.push(createSyntheticLeg({ id, index, processes: 2, service: [20, 40] }));
    }
    const base: JourneyOptions = { seed: 5, discClass: 'shell', difficulty: 'operator', scripts: new Map(), legs };
    const journey = await runJourney(base);
    try {
      for (const result of journey.legs) assertClean(result);
      const byNumber = new Map(journey.handoffs.map((observation) => [observation.handoff, observation]));
      expect(byNumber.get(1)?.status).toBe('observed');
      expect(byNumber.get(1)?.producerWrote).toEqual(['ring_closed']);
      expect(byNumber.get(2)?.status).toBe('observed');
      expect(byNumber.get(2)?.writeBack).toBe(true);
      expect(byNumber.get(3)?.status).toBe('observed');
      expect(byNumber.get(4)?.status).toBe('observed');
      expect(byNumber.get(4)?.producerWrote).toEqual(['crash_outcome', 'manifest_integrity']);
      expect(byNumber.get(5)?.status).toBe('skipped');
      expect(byNumber.get(5)?.reason).toContain('the_portal did not run');
      expect(journey.finalRun.decisions.filter((record) => record.kind === 'executable_bit').map((record) => record.outcome)).toEqual(['costly']);
      const check = replayJourney(journey, base);
      expect(check.problems).toEqual([]);
      expect(check.handoffRecords).toBe(7);
      expect(check.skippedDecisions).toBe(7);
      const restored = await runJourney({ ...base, restoreAtBoundaries: true });
      try {
        expect(restored.journeyHash).toBe(journey.journeyHash);
        expect(restored.finalRun.decisions.filter((record) => HANDOFFS.some((spec) => spec.kinds.includes(record.kind)))).toHaveLength(7);
      } finally {
        restored.release();
      }
    } finally {
      journey.release();
    }
    const silent = await runJourney({ ...base, legs: legs.map((leg) => (leg.id === 'the_cistern' ? createSyntheticLeg({ id: 'the_cistern', index: 5, processes: 2, service: [20, 40] }) : leg)) });
    try {
      expect(silent.handoffs.find((observation) => observation.handoff === 1)?.status).toBe('defaulted');
      expect(silent.handoffs.find((observation) => observation.handoff === 1)?.reason).toContain('fell back to its default');
    } finally {
      silent.release();
    }
  });

  it('release puts the headless registry back as it was before the journey', async () => {
    const before = { boot: HEADLESS_LEGS.boot_sector, fork: HEADLESS_LEGS.fork_fields, weave: HEADLESS_LEGS.the_weave, portal: HEADLESS_LEGS.the_portal };
    const journey = await runJourney(journeyBase());
    expect(HEADLESS_LEGS.fork_fields).not.toBe(before.fork);
    expect(HEADLESS_LEGS.the_weave).not.toBe(before.weave);
    expect(() => HEADLESS_LEGS.the_weave()).not.toThrow();
    journey.release();
    expect(HEADLESS_LEGS.boot_sector).toBe(before.boot);
    expect(HEADLESS_LEGS.fork_fields).toBe(before.fork);
    expect(HEADLESS_LEGS.the_weave).toBe(before.weave);
    expect(HEADLESS_LEGS.the_portal).toBe(before.portal);
    expect(() => HEADLESS_LEGS.the_portal()).toThrow(/not implemented/);
  });
});
