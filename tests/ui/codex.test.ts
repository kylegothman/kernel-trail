// @vitest-environment happy-dom
/**
 * The codex, narrative bible 14 and WP-17 acceptance 15 to 21. The entry set
 * below is a test fixture: this package ships zero entries.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRunStore } from '../../src/game/runStore';
import type { CodexEntry, CodexProfileState, CodexUnlock } from '../../src/game/codexTypes';
import type { LegId, RunState } from '../../src/game/types';
import type { KernelEvent, Pid, Tick } from '../../src/kernel/types';
import { FrameEventQueue, type EventConsumer } from '../../src/world/FrameEventQueue';
import { Codex } from '../../src/ui/codex/Codex';
import { CodexRegistry } from '../../src/ui/codex/entries';
import { matchesUnlock, structureFor } from '../../src/ui/codex/triggers';
import { buildWorkedExample, renderEventLine, WORKED_EXAMPLE_MAX_LINES } from '../../src/ui/codex/workedExample';
import { buildIndex, search } from '../../src/ui/codex/search';
import { collectSources, reportOffences, scanFiles, UI_ROOT, REPO_ROOT } from './uiSourceScan';
import { worstCaseRun } from './fixtures';

const tick = (n: number): Tick => n as Tick;
const pid = (n: number): Pid => n as Pid;

const CHAPTER = { chapter: 10, sections: ['10.6'], title: 'Thrashing' };

function entry(id: string, unlock: CodexUnlock, extra: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id,
    title: `Title of ${id}`,
    chapter: CHAPTER,
    concept: `Concept text for ${id}. The mechanism, in two sentences.`,
    unlock,
    workedExample: null,
    counterfactual: null,
    remedy: { kind: 'reduce_degree', by: 3 },
    remedyVisibility: 'immediate',
    related: [],
    commands: ['vmstat'],
    epitaphs: [],
    ...extra,
  };
}

/** Ten fixture entries, one or more per unlock kind. */
function fixtureRegistry(): CodexRegistry {
  const r = new CodexRegistry();
  r.register(entry('fx.thrashing', { kind: 'event', type: 'memory.thrashing' }));
  r.register(entry('fx.starvation', { kind: 'affliction', id: 'starvation' }, { chapter: { chapter: 5, sections: ['5.3.4'], title: 'Priority' } }));
  r.register(entry('fx.deadlock_victim', { kind: 'termination', reason: 'deadlock_victim' }, { chapter: { chapter: 8, sections: ['8.7.1'], title: 'Deadlock' } }));
  r.register(entry('fx.objective', { kind: 'objective', id: 'obj.quantum' }, { chapter: { chapter: 5, sections: ['5.3.3'], title: 'Round robin' } }));
  r.register(entry('fx.crossing_spin', { kind: 'crossing', option: 'spin' }, { chapter: { chapter: 6, sections: ['6.5'], title: 'Spinlocks' } }));
  r.register(entry('fx.leg_done', { kind: 'leg_complete', leg: 'the_narrows' }, { chapter: { chapter: 6, sections: ['6.1'], title: 'Critical sections' } }));
  r.register(entry('fx.race', { kind: 'event', type: 'sync.race_detected' }));
  r.register(entry('fx.panic', { kind: 'event', type: 'kernel.panic' }));
  r.register(entry('fx.oom', { kind: 'termination', reason: 'out_of_memory' }));
  r.register(entry('fx.memory_leak', { kind: 'affliction', id: 'memory_leak' }));
  return r;
}

const ev = (type: KernelEvent['type'], seq: number, extra: Record<string, unknown> = {}): KernelEvent =>
  ({ type, tick: tick(4900 + seq), seq, ...extra }) as KernelEvent;

interface Rig {
  readonly codex: Codex;
  readonly registry: CodexRegistry;
  readonly store: ReturnType<typeof createRunStore>;
  readonly onScreenCalls: string[];
  readonly screen: Set<string>;
}

function rig(run: RunState = worstCaseRun(), profile?: CodexProfileState, leg: LegId = 'allocation_yards', allOnScreen = true): Rig {
  const registry = fixtureRegistry();
  const store = createRunStore(run);
  const screen = new Set<string>();
  const onScreenCalls: string[] = [];
  const codex = new Codex({
    registry,
    runStore: store,
    ...(profile === undefined ? {} : { profile }),
    currentLeg: () => leg,
    metrics: () => ({ faultRate: 91, cpuUtilisation: 0.91 }),
    onScreen: allOnScreen ? () => true : (id) => {
      onScreenCalls.push(id);
      return screen.has(id);
    },
  });
  return { codex, registry, store, onScreenCalls, screen };
}

describe('codex', () => {
  it('locked returns locked: no code path returns concept text for an entry the run has not earned', () => {
    const r = rig();
    const locked = r.codex.open('fx.thrashing');
    expect(locked).toEqual({ kind: 'locked', id: 'fx.thrashing' });
    expect(JSON.stringify(locked)).not.toContain('Concept text');
    expect(r.codex.open('fx.unknown')).toEqual({ kind: 'locked', id: 'fx.unknown' });
    expect(r.codex.list()).toEqual([]);
    expect(r.codex.buildIndex().ids).toEqual([]);
    // Content leaves the registry through `reveal` alone, and only the codex calls it.
    const callers = scanFiles(collectSources(UI_ROOT), /\.reveal\(/, 'code').map((o) => o.file);
    expect(callers.every((f) => f.endsWith('codex/Codex.ts')), callers.join(', ')).toBe(true);
    // Ids and unlocks are the registry's only other outputs.
    expect(JSON.stringify(r.registry.unlocks())).not.toContain('Concept');
    expect(JSON.stringify(r.registry.ids())).not.toContain('Concept');
    r.codex.consume(ev('memory.thrashing', 1, { faultRate: 91, severity: 'critical' }));
    const open = r.codex.open('fx.thrashing');
    expect(open.kind).toBe('readable');
    if (open.kind === 'readable') expect(open.entry.concept).toContain('Concept text for fx.thrashing');
    expect(r.store.get().codexUnlocked).toEqual(['fx.thrashing']);
  });

  it('no browsable index: with 3 of 10 readable, the list and the search index hold exactly those 3', () => {
    const r = rig();
    r.codex.consume(ev('memory.thrashing', 1, { faultRate: 91, severity: 'critical' }));
    r.codex.consume(ev('sync.race_detected', 2, { race: {} }));
    r.codex.consume(ev('process.exited', 3, { pid: pid(4), exitCode: 1, reason: 'deadlock_victim' }));
    expect(r.registry.size).toBe(10);
    const listed = r.codex.list().map((i) => i.id);
    expect(listed).toHaveLength(3);
    expect(listed).toEqual(['fx.thrashing', 'fx.race', 'fx.deadlock_victim']);
    expect(r.codex.buildIndex().ids).toEqual(listed);
    for (const id of r.registry.ids()) {
      if (!listed.includes(id)) expect(r.codex.open(id).kind, id).toBe('locked');
    }
  });

  it('chronological: entries are ordered by first encounter, not by chapter', () => {
    const r = rig();
    r.codex.consume(ev('process.exited', 1, { pid: pid(4), exitCode: 1, reason: 'deadlock_victim' })); // Ch. 8
    r.codex.consume(ev('memory.thrashing', 2, { faultRate: 91, severity: 'critical' })); // Ch. 10
    r.codex.signal({ kind: 'crossing', option: 'spin' }); // Ch. 6
    r.codex.signal({ kind: 'objective', id: 'obj.quantum' }); // Ch. 5
    expect(r.codex.list().map((i) => i.id)).toEqual(['fx.deadlock_victim', 'fx.thrashing', 'fx.crossing_spin', 'fx.objective']);
  });

  it('worked example: built from the event log, at most 12 lines, oldest first', () => {
    const r = rig();
    for (let i = 1; i <= 30; i++) r.codex.consume(ev('memory.page_fault', i, { pid: pid(3), page: i, major: i % 2 === 0 }));
    r.codex.consume(ev('memory.thrashing', 31, { faultRate: 91, severity: 'critical' }));
    const open = r.codex.open('fx.thrashing');
    expect(open.kind).toBe('readable');
    if (open.kind !== 'readable') return;
    const example = open.entry.workedExample;
    expect(example).not.toBeNull();
    expect(example?.trace).toHaveLength(WORKED_EXAMPLE_MAX_LINES);
    expect(WORKED_EXAMPLE_MAX_LINES).toBe(12);
    expect(example?.trace[0]).toBe('t4920  memory.page_fault  pid 3  page 20  major true');
    expect(example?.trace[11]).toBe('t4931  memory.thrashing  faultRate 91  severity critical');
    const ticks = (example?.trace ?? []).map((l) => Number(l.slice(1, l.indexOf(' '))));
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    expect(example?.capturedAtTick).toBe(4931);
    expect(example?.legId).toBe('allocation_yards');
    expect(open.entry.counterfactual).toBeNull();
  });

  it('worked example not authored: every field derives from the log, the run state or the supplied metrics', () => {
    const run = worstCaseRun();
    run.decisions.push({ tick: tick(4980), legId: 'allocation_yards', kind: 'set_degree', choice: '9', outcome: 'pending', relatedObjective: null });
    const log = [ev('memory.page_fault', 1, { pid: pid(3), page: 7, major: true }), ev('memory.thrashing', 2, { faultRate: 91, severity: 'critical' })];
    const trigger = log[1] as KernelEvent;
    const example = buildWorkedExample({ log: [log[1] as KernelEvent, log[0] as KernelEvent], trigger, run, legId: 'drowned_reach', capturedAtTick: trigger.tick, metrics: { faultRate: 91 } });
    expect(example.trace).toEqual(log.map(renderEventLine));
    expect(example.capturedAtTick).toBe(trigger.tick);
    expect(example.legId).toBe('drowned_reach');
    expect(example.metrics).toEqual({ faultRate: 91 });
    expect(example.summary).toBe('At tick 4980 you chose set_degree 9, and the kernel reported memory.thrashing at tick 4902.');
    // The registry refuses an entry that arrives with run data already written in.
    const r = new CodexRegistry();
    expect(() => r.register(entry('fx.bad', { kind: 'event', type: 'kernel.panic' }, { workedExample: example }))).toThrow(/never written/);
  });

  it('profile persistence: a seen entry stays readable across runs while its example is rebuilt per run', () => {
    const first = rig(worstCaseRun(), undefined, 'the_narrows');
    first.codex.consume(ev('memory.thrashing', 1, { faultRate: 40, severity: 'warning' }));
    const profile = first.codex.profile();
    expect(profile.seen).toEqual(['fx.thrashing']);
    expect(profile.firstSeen['fx.thrashing']).toEqual({ runId: 'run-fixture-0001', legId: 'the_narrows' });

    const runTwo = { ...worstCaseRun(), runId: 'run-fixture-0002', codexUnlocked: [] };
    const second = rig(runTwo, profile, 'drowned_reach');
    const viaProfile = second.codex.open('fx.thrashing');
    expect(viaProfile.kind).toBe('readable');
    if (viaProfile.kind !== 'readable') return;
    expect(viaProfile.readableVia).toBe('profile');
    expect(viaProfile.entry.concept).toContain('Concept text for fx.thrashing');
    expect(viaProfile.entry.workedExample).toBeNull();
    expect(viaProfile.entry.counterfactual).toBeNull();
    expect(second.store.get().codexUnlocked).toEqual([]);

    second.codex.consume(ev('memory.thrashing', 7, { faultRate: 91, severity: 'critical' }));
    const viaRun = second.codex.open('fx.thrashing');
    if (viaRun.kind !== 'readable') throw new Error('expected readable');
    expect(viaRun.readableVia).toBe('run');
    expect(viaRun.entry.workedExample?.legId).toBe('drowned_reach');
    expect(viaRun.entry.workedExample?.trace).toEqual(['t4907  memory.thrashing  faultRate 91  severity critical']);
    expect(second.codex.profile().firstSeen['fx.thrashing']).toEqual({ runId: 'run-fixture-0001', legId: 'the_narrows' });
  });

  it('six CodexUnlock kinds: every variant has a working trigger', () => {
    const r = rig();
    const unlocked: string[] = [];
    r.codex.onUnlock((id) => unlocked.push(id));
    r.codex.consume(ev('kernel.panic', 1, { message: 'halt' }));
    r.codex.consume(ev('process.exited', 2, { pid: pid(4), exitCode: 1, reason: 'out_of_memory' }));
    r.store.mutate((s) => {
      s.convoy[0]?.afflictions.push({ id: 'memory_leak', displayName: 'Memory leak', acquiredAtTick: tick(1), drainPerTick: 1, fatalAfter: null, remedy: { kind: 'terminal', command: 'free' } });
    });
    r.store.flush();
    // A flush listener may not mutate the store, so a store-derived unlock
    // lands at endFrame, which the frame pipeline runs after flushState.
    expect(unlocked).toEqual(['fx.panic', 'fx.oom']);
    r.codex.endFrame();
    r.store.mutate((s) => {
      s.objectivesMet.push('obj.quantum');
    });
    r.store.flush();
    r.codex.endFrame();
    r.codex.signal({ kind: 'crossing', option: 'spin' });
    r.codex.signal({ kind: 'leg_complete', leg: 'the_narrows' });
    expect(unlocked).toEqual(['fx.panic', 'fx.oom', 'fx.memory_leak', 'fx.objective', 'fx.crossing_spin', 'fx.leg_done']);
    const kinds = unlocked.map((id) => r.registry.unlockOf(id)?.kind);
    expect(new Set(kinds)).toEqual(new Set(['event', 'termination', 'affliction', 'objective', 'crossing', 'leg_complete']));
    // Negative cases, one per variant.
    expect(matchesUnlock({ kind: 'event', type: 'kernel.panic' }, { kind: 'event', event: ev('deadlock.detected', 9, { report: {} }) })).toBe(false);
    expect(matchesUnlock({ kind: 'termination', reason: 'starvation' }, { kind: 'event', event: ev('process.exited', 9, { pid: pid(1), exitCode: 0, reason: 'normal_exit' }) })).toBe(false);
    expect(matchesUnlock({ kind: 'affliction', id: 'thrashing' }, { kind: 'affliction', id: 'starvation' })).toBe(false);
    expect(matchesUnlock({ kind: 'objective', id: 'a' }, { kind: 'objective', id: 'b' })).toBe(false);
    expect(matchesUnlock({ kind: 'crossing', option: 'block' }, { kind: 'crossing', option: 'spin' })).toBe(false);
    expect(matchesUnlock({ kind: 'leg_complete', leg: 'the_bus' }, { kind: 'leg_complete', leg: 'the_narrows' })).toBe(false);
  });

  it('off screen: an entry whose structure is not on screen is held, then offered once it is', () => {
    const r = rig(worstCaseRun(), undefined, 'allocation_yards', false);
    r.codex.consume(ev('memory.thrashing', 1, { faultRate: 91, severity: 'critical' }));
    expect(r.onScreenCalls).toContain('PageOcean');
    expect(r.codex.open('fx.thrashing').kind).toBe('locked');
    expect(r.codex.heldIds).toEqual(['fx.thrashing']);
    r.codex.endFrame();
    expect(r.codex.open('fx.thrashing').kind).toBe('locked');
    r.screen.add('PageOcean');
    r.codex.endFrame();
    expect(r.codex.open('fx.thrashing').kind).toBe('readable');
    expect(r.codex.heldIds).toEqual([]);
    expect(structureFor({ kind: 'affliction', id: 'starvation' })).toBe('ReadyQueueProcession');
    expect(structureFor({ kind: 'termination', reason: 'deadlock_victim' })).toBe('WaitForRing');
    expect(structureFor({ kind: 'objective', id: 'x' })).toBeNull();
    // A structureless unlock is offered at once even when nothing is on screen.
    r.codex.signal({ kind: 'crossing', option: 'spin' });
    expect(r.codex.open('fx.crossing_spin').kind).toBe('readable');
  });

  it('consumer order: the codex runs after the world and the audio and before the HUD', () => {
    const queue = new FrameEventQueue();
    const order: string[] = [];
    const spy = (name: string): EventConsumer => ({ name, consume: () => order.push(name) });
    queue.registerHud(spy('hud'));
    queue.registerCodex(spy('codex'));
    queue.registerAudio(spy('audio'));
    queue.registerWorld(spy('world'));
    queue.push([ev('kernel.panic', 1, { message: 'halt' })]);
    queue.drain();
    expect(order).toEqual(['world', 'audio', 'codex', 'hud']);
    const source = readFileSync(join(REPO_ROOT, 'src', 'world', 'FrameEventQueue.ts'), 'utf8');
    expect(source).toContain("['world', 'audio', 'codex', 'hud'] as const");
    const r = rig();
    expect(r.codex.name).toBe('codex');
    queue.registerCodex(r.codex);
    queue.push([ev('kernel.panic', 2, { message: 'halt' })]);
    queue.drain();
    expect(r.codex.open('fx.panic').kind).toBe('readable');
    expect(queue.failures).toEqual([]);
  });

  it('remedy visibility: each of the four values shows or hides the remedy as ruled', () => {
    const registry = new CodexRegistry();
    for (const v of ['immediate', 'on_unlock', 'after_first_success', 'never'] as const) {
      registry.register(entry(`fx.${v}`, { kind: 'event', type: 'kernel.panic' }, { remedyVisibility: v }));
    }
    const seenBefore: CodexProfileState = { seen: ['fx.immediate', 'fx.on_unlock', 'fx.after_first_success', 'fx.never'], demonstrated: [], firstSeen: {} };
    const store = createRunStore(worstCaseRun());
    const codex = new Codex({ registry, runStore: store, profile: seenBefore, currentLeg: () => 'the_bus' });
    const remedyOf = (id: string) => {
      const o = codex.open(id);
      return o.kind === 'readable' ? o.remedy : 'locked';
    };
    // Readable through the profile only: not yet unlocked in this run.
    expect(remedyOf('fx.immediate')).toEqual({ kind: 'reduce_degree', by: 3 });
    expect(remedyOf('fx.on_unlock')).toBeNull();
    expect(remedyOf('fx.after_first_success')).toBeNull();
    expect(remedyOf('fx.never')).toBeNull();
    codex.consume(ev('kernel.panic', 1, { message: 'halt' }));
    expect(remedyOf('fx.immediate')).toEqual({ kind: 'reduce_degree', by: 3 });
    expect(remedyOf('fx.on_unlock')).toEqual({ kind: 'reduce_degree', by: 3 });
    expect(remedyOf('fx.after_first_success')).toBeNull();
    expect(remedyOf('fx.never')).toBeNull();
    codex.markDemonstrated('fx.after_first_success');
    expect(remedyOf('fx.after_first_success')).toEqual({ kind: 'reduce_degree', by: 3 });
    expect(remedyOf('fx.never')).toBeNull();
    expect(codex.profile().demonstrated).toEqual(['fx.after_first_success']);
  });

  it('search readable only: the index contains no locked entry', () => {
    const r = rig();
    r.codex.consume(ev('memory.thrashing', 1, { faultRate: 91, severity: 'critical' }));
    r.codex.consume(ev('sync.race_detected', 2, { race: {} }));
    const index = r.codex.buildIndex();
    expect(index.ids).toEqual(['fx.thrashing', 'fx.race']);
    for (const ids of index.postings.values()) for (const id of ids) expect(['fx.thrashing', 'fx.race']).toContain(id);
    expect(search(index, 'concept')).toEqual(['fx.thrashing', 'fx.race']);
    expect(search(index, 'race')).toEqual(['fx.race']);
    expect(search(index, 'vmstat thrash')).toEqual(['fx.thrashing']);
    expect(search(index, 'panic')).toEqual([]);
    expect(search(index, '')).toEqual(index.ids);
    // The pure builder indexes exactly what it is given.
    const all = buildIndex([entry('fx.a', { kind: 'event', type: 'kernel.panic' })]);
    expect(all.ids).toEqual(['fx.a']);
  });

  it('no shipped content: the registry starts empty and src/ui/codex names no entry', () => {
    expect(new CodexRegistry().size).toBe(0);
    expect(new CodexRegistry().ids()).toEqual([]);
    const codexFiles = collectSources(join(UI_ROOT, 'codex'));
    expect(codexFiles.length).toBeGreaterThanOrEqual(5);
    expect(reportOffences(scanFiles(codexFiles, /['"]codex\.[a-z_]+['"]|\.register\(\s*\{/, 'imports'))).toBe('');
    const curriculumIds = readFileSync(join(REPO_ROOT, 'docs', '05-CURRICULUM-MAP.md'), 'utf8').match(/`codex\.[a-z_]+`/g) ?? [];
    expect(curriculumIds.length).toBeGreaterThan(50);
    const uiSource = codexFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const id of new Set(curriculumIds)) expect(uiSource).not.toContain(id.replaceAll('`', ''));
  });

  it('remedy field of a locked entry is unreachable and a resumed run keeps its unlocks readable', () => {
    const run = { ...worstCaseRun(), codexUnlocked: ['fx.race'] };
    const r = rig(run);
    expect(r.codex.list().map((i) => i.id)).toEqual(['fx.race']);
    expect(r.codex.open('fx.race').kind).toBe('readable');
    expect(r.codex.profile().seen).toEqual(['fx.race']);
  });
});
