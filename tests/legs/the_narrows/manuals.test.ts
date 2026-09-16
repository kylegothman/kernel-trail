/**
 * WP-L04 acceptance 16: the three man pages, byte for byte against the
 * curriculum map, and the load-bearing lines the leg depends on the player
 * having read. WP-15 shipped these definitions, so re-shipping them has to be
 * identical or the shell throws naming the first differing line.
 */
import { describe, expect, it } from 'vitest';
import { firstDefinitionDifference } from '@terminal/registry';
import { ALL_DEFINITIONS } from '@terminal/commands/index';
import theNarrows from '@legs/the_narrows';
import { curriculumDefinitions } from '../../terminal/harness';

const MAP = curriculumDefinitions();
const NAMES = ['lock', 'race', 'trace'] as const;

describe('the man pages of the Narrows', () => {
  it.each(NAMES)('%s matches the curriculum map byte for byte', (name) => {
    const mine = theNarrows.terminalCommands.find((def) => def.name === name);
    const mapped = MAP.get(name);
    expect(mine, name).toBeDefined();
    expect(mapped, `${name} is not in the curriculum map`).toBeDefined();
    if (mine === undefined || mapped === undefined) return;
    expect(mine.usage).toBe(mapped.usage);
    expect(mine.summary).toBe(mapped.summary);
    expect(mine.manual).toBe(mapped.manual);
    expect(mine.chapter).toEqual(mapped.chapter);
  });

  it.each(NAMES)('%s re-ships identically to what the shell already carries, so registering it changes nothing', (name) => {
    const mine = theNarrows.terminalCommands.find((def) => def.name === name);
    const shipped = ALL_DEFINITIONS.find((def) => def.name === name);
    expect(shipped, `${name} is not in the base shell`).toBeDefined();
    if (mine === undefined || shipped === undefined) return;
    expect(firstDefinitionDifference(shipped, mine)).toBeNull();
  });

  it('carries the line that answers the second misconception before the player reaches the second ford', () => {
    const lock = theNarrows.terminalCommands.find((def) => def.name === 'lock');
    expect(lock?.manual).toContain('Nothing in');
    expect(lock?.manual).toContain('the hardware associates a lock with the data it protects');
    expect(lock?.manual).toContain('two crossings guarding the same');
  });

  it('carries the three requirements and the line about which one fails quietly', () => {
    const lock = theNarrows.terminalCommands.find((def) => def.name === 'lock');
    expect(lock?.manual).toContain('mutual exclusion');
    expect(lock?.manual).toContain('progress');
    expect(lock?.manual).toContain('bounded waiting');
    expect(lock?.manual).toContain('A protocol missing any one of them fails, and it usually fails on the third, quietly,');
  });

  it('carries the line that explains why a source line is not one operation', () => {
    const race = theNarrows.terminalCommands.find((def) => def.name === 'race');
    expect(race?.manual).toContain('Between any two of those operations the scheduler may preempt you, because the');
    expect(race?.manual).toContain('scheduler has no idea that those three operations were meant to be one thing.');
  });

  it('carries the line about fixing a race and being able to prove it', () => {
    const trace = theNarrows.terminalCommands.find((def) => def.name === 'trace');
    expect(trace?.manual).toContain('way to know whether you fixed it or got lucky. Here you can fix it and prove it,');
    expect(trace?.manual).toContain('against the exact interleaving that broke it.');
  });

  it('ends every page with a See also line, and every target resolves in the shipped shell', () => {
    const shipped = new Set(ALL_DEFINITIONS.map((def) => def.name));
    const pending: string[] = [];
    for (const def of theNarrows.terminalCommands) {
      const line = def.manual.split('\n').at(-1);
      expect(line, def.name).toMatch(/^See also: /);
      const targets = (line ?? '').replace('See also: ', '').replace(/\.$/, '').split(', ')
        .map((entry) => entry.trim().split(' ')[0] ?? '')
        .filter((entry) => entry.length > 0 && entry !== 'codex');
      for (const target of targets) if (!shipped.has(target)) pending.push(`${def.name} -> ${target}`);
    }
    expect(pending, `unresolved See also targets: ${pending.join(', ')}`).toEqual([]);
  });
});
