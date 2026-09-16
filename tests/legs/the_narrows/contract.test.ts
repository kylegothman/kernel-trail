/**
 * WP-L04 acceptance 1 and 15: the leg satisfies the frozen `Leg`, its
 * companion satisfies `validateContent`, and the tables it declares are the
 * shapes the host reads.
 */
import { describe, expect, it } from 'vitest';
import { validateTable } from '@game/events/EventDeck';
import { LEG_ORDER } from '@game/types';
import { validateContent } from '@legs/content';
import theNarrows, { content } from '@legs/the_narrows';
import { CODEX_IDS, EPITAPH_IDS } from '@legs/the_narrows/copy';
import { OBJECTIVE_IDS } from '@legs/the_narrows/objectives';
import { loadLegForTest } from '../harness/loadLeg';

describe('the Narrows satisfies the frozen leg contract', () => {
  it('is the_narrows at index 4, with the journey order agreeing', () => {
    expect(theNarrows.id).toBe('the_narrows');
    expect(theNarrows.index).toBe(4);
    expect(LEG_ORDER[4]).toBe('the_narrows');
    expect(theNarrows.title).toBe('The Narrows');
    expect(theNarrows.subtitle).toBe('Two feet, one plank.');
  });

  it('loads through the registry with a companion the loader accepts', async () => {
    const loaded = await loadLegForTest('the_narrows');
    expect(loaded.id).toBe('the_narrows');
  });

  it('declares chapter 6 and cites nothing outside it', () => {
    expect(theNarrows.chapters).toHaveLength(1);
    const chapter = theNarrows.chapters[0];
    expect(chapter?.chapter).toBe(6);
    expect(chapter?.title).toBe('Synchronization Tools');
    expect(chapter?.sections).toEqual(['6.1', '6.2', '6.3', '6.4.1', '6.4.2', '6.4.3', '6.5', '6.6.1', '6.6.2', '6.7.1', '6.7.2', '6.8', '6.9']);
    for (const objective of theNarrows.objectives) {
      expect(objective.chapter.chapter).toBe(6);
      for (const section of objective.chapter.sections) expect(chapter?.sections).toContain(section);
    }
  });

  it('declares six objectives, each assessed by a declared route', () => {
    expect(theNarrows.objectives.map((objective) => objective.id)).toEqual(OBJECTIVE_IDS);
    expect(OBJECTIVE_IDS).toHaveLength(6);
    expect(new Set(OBJECTIVE_IDS).size).toBe(6);
    expect(theNarrows.objectives.map((objective) => objective.assessedBy).sort())
      .toEqual(['decision', 'outcome', 'outcome', 'survival', 'terminal_command', 'terminal_command']);
    for (const objective of theNarrows.objectives) expect(objective.statement.length).toBeGreaterThan(40);
  });

  it('the companion validates: no crossing on an undeclared lock, no interaction without a handler', () => {
    expect(validateContent(theNarrows, content)).toEqual([]);
    expect(content.legId).toBe('the_narrows');
    expect(Object.keys(content.interactions).sort()).toEqual(theNarrows.interactions.map((def) => def.id).sort());
    expect(content.terminalHandlers).toEqual({});
  });

  it('ships eight codex entries and five stones, all with unique ids', () => {
    expect(content.codex.map((entry) => entry.id)).toEqual(CODEX_IDS);
    expect(new Set(CODEX_IDS).size).toBe(8);
    expect(content.epitaphs.map((stone) => stone.id)).toEqual(EPITAPH_IDS);
    expect(new Set(EPITAPH_IDS).size).toBe(5);
    for (const entry of content.codex) {
      expect(entry.workedExample).toBeNull();
      expect(entry.counterfactual).toBeNull();
      expect(entry.concept.split('. ').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('the event table is the seven entries of the bible, and its weights total one hundred', () => {
    expect(validateTable(theNarrows.eventTable)).toEqual([]);
    expect(theNarrows.eventTable).toHaveLength(7);
    expect(theNarrows.eventTable.reduce((sum, def) => sum + def.weight, 0)).toBe(100);
    expect(new Set(theNarrows.eventTable.map((def) => def.id)).size).toBe(7);
  });

  it('adds three terminal commands', () => {
    expect(theNarrows.terminalCommands.map((def) => def.name)).toEqual(['lock', 'race', 'trace']);
  });
});
