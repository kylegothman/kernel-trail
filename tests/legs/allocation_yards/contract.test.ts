/** WP-L07 acceptance 1: the leg satisfies the frozen `Leg` and its companion validates. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LEG_ORDER } from '@game/types';
import { validateContent } from '@legs/content';
import { tryLoadLegForTest, REPO_ROOT, scanForbiddenImports } from '../harness/loadLeg';
import { OBJECTIVE_IDS } from '@legs/allocation_yards/objectives';
import { CODEX_IDS } from '@legs/allocation_yards/copy';

const loaded = await tryLoadLegForTest('allocation_yards');
if (!loaded.shipped) throw new Error(`allocation_yards did not load: ${loaded.reason}`);
const { leg, content } = loaded;

describe('the Allocation Yards conforms to the frozen Leg', () => {
  it('is leg 7, named and subtitled as the curriculum map names it', () => {
    expect(leg.id).toBe('allocation_yards');
    expect(leg.index).toBe(7);
    expect(LEG_ORDER[7]).toBe('allocation_yards');
    expect(leg.title).toBe('The Allocation Yards');
    expect(leg.subtitle).toBe('There is enough room. There is nowhere to stand.');
  });

  it('declares the sixteen-section chapter 9 coverage and seven objectives inside it', () => {
    expect(leg.chapters).toHaveLength(1);
    const chapter = leg.chapters[0];
    expect(chapter?.chapter).toBe(9);
    expect(chapter?.title).toBe('Main Memory');
    expect(chapter?.sections).toHaveLength(16);
    expect(leg.objectives).toHaveLength(7);
    for (const objective of leg.objectives) {
      expect(objective.chapter.chapter).toBe(9);
      for (const id of objective.chapter.sections) expect(chapter?.sections).toContain(id);
      expect(objective.id.startsWith('obj.allocation_yards.')).toBe(true);
      expect(objective.statement.length).toBeGreaterThan(40);
    }
    expect(new Set(OBJECTIVE_IDS).size).toBe(7);
  });

  it('declares ten interactions, four commands and an eight-entry event deck', () => {
    expect(leg.interactions).toHaveLength(10);
    expect(new Set(leg.interactions.map((def) => def.id)).size).toBe(10);
    expect(leg.terminalCommands.map((def) => def.name)).toEqual(['free', 'pagetable', 'tlb', 'frag']);
    expect(leg.eventTable).toHaveLength(8);
  });

  it('carries a companion `validateContent` accepts, with no crossing and no deferred handler', () => {
    expect(validateContent(leg, content)).toEqual([]);
    expect(content.legId).toBe('allocation_yards');
    expect(content.crossings).toEqual([]);
    expect(Object.keys(content.terminalHandlers)).toEqual([]);
    expect(Object.keys(content.interactions).sort()).toEqual([...leg.interactions.map((def) => def.id)].sort());
    expect(content.codex.map((entry) => entry.id)).toEqual([...CODEX_IDS]);
    expect(content.epitaphs.length).toBeGreaterThan(0);
  });

  it('every codex entry is authored in full and names no objective the leg does not declare', () => {
    for (const entry of content.codex) {
      expect(entry.workedExample, entry.id).toBeNull();
      expect(entry.counterfactual, entry.id).toBeNull();
      expect(entry.concept.split('. ').length, entry.id).toBeGreaterThanOrEqual(2);
      expect(entry.chapter.chapter, entry.id).toBe(9);
      if (entry.unlock.kind === 'objective') expect(OBJECTIVE_IDS).toContain(entry.unlock.id);
    }
  });

  it('nothing in the leg directory imports three, @world, @render, @ui or @audio', () => {
    const dir = resolve(REPO_ROOT, 'src', 'legs', 'allocation_yards');
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    const anywhere = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](?:three(?:['"]|\/)|@world|@render|@ui|@audio)/;
    for (const name of files) {
      const source = readFileSync(join(dir, name), 'utf8');
      expect(scanForbiddenImports(source), name).toEqual([]);
      expect(source, name).not.toMatch(anywhere);
    }
  });

  it('carries no em dash and no en dash in any string the player reads', () => {
    const dash = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
    const dir = resolve(REPO_ROOT, 'src', 'legs', 'allocation_yards');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts'))) {
      expect(dash.test(readFileSync(join(dir, name), 'utf8')), name).toBe(false);
    }
  });
});
