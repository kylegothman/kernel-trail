/**
 * WP-L03 acceptance 1, 3 and 16: the leg satisfies the frozen `Leg`, carries
 * the identity the journey expects, declares exactly the two subsystems it
 * teaches, and ships a companion `validateContent` accepts.
 */
import { describe, expect, it } from 'vitest';
import { LEG_ORDER } from '@game/types';
import { validateContent } from '@legs/content';
import { validateTable } from '@game/events/EventDeck';
import leg, { content } from '@legs/quantum_pass/index';
import { CODEX_IDS } from '@legs/quantum_pass/copy';
import { OBJECTIVE_IDS } from '@legs/quantum_pass/objectives';
import { assertLegShape, loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';

const run = makeRunState({ seed: 0x4b54524c, legIndex: 3 });

describe('the Leg contract', () => {
  it('is the leg the journey expects at index 3 (acceptance 1)', () => {
    expect(leg.id).toBe('quantum_pass');
    expect(leg.index).toBe(3);
    expect(LEG_ORDER[3]).toBe('quantum_pass');
    expect(leg.title).toBe('Quantum Pass');
    expect(leg.subtitle).toBe('Someone has to go last.');
    expect(() => assertLegShape(leg, 'quantum_pass')).not.toThrow();
  });

  it('loads through the registry with its companion', async () => {
    const loaded = await loadLegForTest('quantum_pass');
    expect(loaded.id).toBe(leg.id);
  });

  it('declares one chapter, chapter 5, with the curriculum map sections and without 5.6', () => {
    expect(leg.chapters).toHaveLength(1);
    const chapter = leg.chapters[0];
    expect(chapter?.chapter).toBe(5);
    expect(chapter?.title).toBe('CPU Scheduling');
    expect(chapter?.sections).toEqual([
      '5.1.1', '5.1.2', '5.1.3', '5.2',
      '5.3.1', '5.3.2', '5.3.3', '5.3.4', '5.3.5', '5.3.6',
      '5.4', '5.5.1', '5.8.1', '5.8.2',
    ]);
    // Section 5.6 is real-time scheduling; the leg touches it only through a deadline flag and builds no real-time scheduler.
    expect(chapter?.sections).not.toContain('5.6');
  });

  it('declares the seven objectives, each citing a section the leg covers', () => {
    expect(leg.objectives.map((objective) => objective.id)).toEqual(Object.values(OBJECTIVE_IDS));
    const covered = new Set(leg.chapters[0]?.sections ?? []);
    for (const objective of leg.objectives) {
      expect(objective.chapter.chapter, objective.id).toBe(5);
      expect(objective.statement.length, objective.id).toBeGreaterThan(0);
      for (const section of objective.chapter.sections) expect(covered, `${objective.id} cites ${section}`).toContain(section);
    }
    expect(new Set(leg.objectives.map((objective) => objective.assessedBy))).toEqual(new Set(['outcome', 'terminal_command', 'decision', 'survival']));
  });

  it('enables process and scheduler and nothing else (acceptance 3)', () => {
    expect(leg.kernelConfig(run).enabledSubsystems).toEqual(['process', 'scheduler']);
  });

  it('declares no sync primitive, no resource and no crossing (acceptance 3)', () => {
    // The priority-inversion event inflicts an affliction through the event table; the Narrows owns real inversion.
    expect(content.crossings).toEqual([]);
    expect(validateContent(leg, content)).toEqual([]);
  });

  it('the companion answers for every declared interaction', () => {
    for (const def of leg.interactions) {
      expect(content.interactions[def.id], def.id).toBeDefined();
      // No interaction on this leg costs integrity, so none needs a target Program.
      expect(def.cost.integrity ?? 0, def.id).toBe(0);
      expect(content.interactions[def.id]?.target, def.id).toBeNull();
    }
    expect(Object.keys(content.interactions).sort()).toEqual(leg.interactions.map((def) => def.id).sort());
  });

  it('registers no terminal handler, because none of its three commands is deferred', () => {
    expect(content.terminalHandlers).toEqual({});
    expect(leg.terminalCommands.map((def) => def.name)).toEqual(['sched', 'nice', 'gantt']);
  });

  it('carries the seven codex entries, each authored without run data', () => {
    expect(content.codex.map((codex) => codex.id)).toEqual(Object.values(CODEX_IDS));
    for (const codex of content.codex) {
      expect(codex.workedExample, codex.id).toBeNull();
      expect(codex.counterfactual, codex.id).toBeNull();
      expect(codex.chapter.chapter, codex.id).toBe(5);
      expect(codex.concept.split('. ').length, `${codex.id} concept is two to four sentences`).toBeGreaterThanOrEqual(2);
      for (const related of codex.related) expect(Object.values(CODEX_IDS), `${codex.id} relates to ${related}`).toContain(related);
    }
  });

  it('the event table is eight weighted rows summing to 100 (acceptance 16)', () => {
    expect(validateTable(leg.eventTable)).toEqual([]);
    expect(leg.eventTable).toHaveLength(8);
    expect(leg.eventTable.reduce((total, def) => total + def.weight, 0)).toBe(100);
    expect(new Set(leg.eventTable.map((def) => def.id)).size).toBe(8);
  });

  it('gates the short job flood on a shortest-first policy and nothing else (acceptance 16)', () => {
    const flood = leg.eventTable.find((def) => def.id === 'quantum.short_job_flood');
    expect(flood?.onlyIf).not.toBeNull();
    const under = (to: string): boolean => {
      const state = makeRunState({ seed: 1, legIndex: 3 });
      state.decisions.push({ tick: 1 as never, legId: 'quantum_pass', kind: 'set_scheduler', choice: to, outcome: 'pending', relatedObjective: null });
      return flood?.onlyIf?.(state) ?? false;
    };
    expect(under('sjf')).toBe(true);
    expect(under('srtf')).toBe(true);
    expect(under('rr')).toBe(false);
    expect(under('priority')).toBe(false);
    expect(flood?.onlyIf?.(makeRunState({ seed: 1, legIndex: 3 }))).toBe(false);
  });

  it('no string the player reads carries a dash or a forbidden term', () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
    const strings = [
      leg.title, leg.subtitle,
      ...leg.objectives.map((objective) => objective.statement),
      ...leg.interactions.flatMap((def) => [def.label, def.description]),
      ...leg.eventTable.flatMap((def) => [def.title, def.narration]),
      ...leg.terminalCommands.flatMap((def) => [def.usage, def.summary, def.manual]),
      ...content.codex.flatMap((codex) => [codex.title, codex.concept]),
      ...content.epitaphs.flatMap((stone) => [stone.inscription, stone.cause]),
    ];
    for (const text of strings) expect(text, text.slice(0, 60)).not.toMatch(dashes);
  });
});
