/**
 * Acceptance 1 and 12: the exported object satisfies the frozen `Leg`, the
 * companion validates, and the curriculum data is exact.
 */
import { describe, expect, it } from 'vitest';
import { validateContent } from '@legs/content';
import { bootSector, content } from './leg';
import { chapters } from '@legs/boot_sector/chapters';
import { CODEX_IDS, codexEntries } from '@legs/boot_sector/copy';
import { objectives } from '@legs/boot_sector/objectives';
import { curriculumChapters, curriculumObjectiveIds } from './curriculum';
import { CODEX, OBJECTIVES } from './scripts';

describe('boot_sector contract', () => {
  it('exports the Leg with the exact identity', () => {
    expect(bootSector.id).toBe('boot_sector');
    expect(bootSector.index).toBe(0);
    expect(bootSector.title).toBe('The Boot Sector');
    expect(bootSector.subtitle).toBe('Everything you want is on the other side of a trap.');
    expect(bootSector.chapters).toBe(chapters);
    expect(bootSector.objectives).toBe(objectives);
  });

  it('chapters deep-equal the curriculum map array', () => {
    expect(chapters).toEqual(curriculumChapters());
  });

  it('declares the six objectives with the exact ids and sections within the declared chapters', () => {
    expect(objectives.map((objective) => objective.id)).toEqual(OBJECTIVES);
    expect(objectives.map((objective) => objective.id)).toEqual(curriculumObjectiveIds());
    for (const objective of objectives) {
      const declared = chapters.find((chapter) => chapter.chapter === objective.chapter.chapter);
      expect(declared, objective.id).toBeDefined();
      for (const section of objective.chapter.sections) expect(declared?.sections, `${objective.id} ${section}`).toContain(section);
    }
  });

  it('the companion validates and carries the five codex entries, no stones, no crossings and no deferred handlers', () => {
    expect(validateContent(bootSector, content)).toEqual([]);
    expect(content.legId).toBe('boot_sector');
    expect(content.crossings).toEqual([]);
    expect(content.epitaphs).toEqual([]);
    expect(content.terminalHandlers).toEqual({});
    expect(content.codex.map((entry) => entry.id)).toEqual(CODEX);
    expect(CODEX_IDS).toEqual(CODEX);
    for (const entry of codexEntries) {
      expect(entry.unlock).toEqual({ kind: 'leg_complete', leg: 'boot_sector' });
      expect(entry.workedExample).toBeNull();
      expect(entry.counterfactual).toBeNull();
      const sentences = entry.concept.split(/\.\s+|\.$/).filter((part) => part.trim().length > 0);
      expect(sentences.length, entry.id).toBeGreaterThanOrEqual(2);
      expect(sentences.length, entry.id).toBeLessThanOrEqual(4);
      const declared = chapters.find((chapter) => chapter.chapter === entry.chapter.chapter);
      for (const section of entry.chapter.sections) expect(declared?.sections, `${entry.id} ${section}`).toContain(section);
    }
  });

  it('every interaction has a companion handler and every codex id is unique', () => {
    for (const def of bootSector.interactions) expect(content.interactions[def.id], def.id).toBeDefined();
    expect(new Set(CODEX_IDS).size).toBe(CODEX_IDS.length);
  });
});
