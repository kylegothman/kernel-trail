/** WP-L07 acceptance 20: the four manual strings, byte for byte, and their See also graph. */
import { describe, expect, it } from 'vitest';
import { ALL_DEFINITIONS } from '@terminal/commands/index';
import { firstDefinitionDifference } from '@terminal/registry';
import { resolveTopic } from '@terminal/man/ManPages';
import { curriculumDefinitions, makeFixture } from '../../terminal/harness';
import { loadLegForTest } from '../harness/loadLeg';
import { XLATE_MANUAL } from '@legs/allocation_yards/fixtures';

const leg = await loadLegForTest('allocation_yards');
const NAMES = ['free', 'pagetable', 'tlb', 'frag'] as const;

describe('the four instruments are the curriculum map\'s, unchanged', () => {
  const curriculum = curriculumDefinitions();

  for (const name of NAMES) {
    it(`${name} matches the curriculum map line for line`, () => {
      const mine = leg.terminalCommands.find((def) => def.name === name);
      const theirs = curriculum.get(name);
      expect(mine, name).toBeDefined();
      expect(theirs, name).toBeDefined();
      if (mine === undefined || theirs === undefined) return;
      expect(mine.usage).toBe(theirs.usage);
      expect(mine.summary).toBe(theirs.summary);
      expect(mine.chapter).toEqual(theirs.chapter);
      const mineLines = mine.manual.split('\n');
      const theirLines = theirs.manual.split('\n');
      expect(mineLines).toHaveLength(theirLines.length);
      mineLines.forEach((row, index) => { expect(row, `${name} line ${index}`).toBe(theirLines[index]); });
    });
  }

  it('re-shipping them registers nothing new and throws nothing', () => {
    const fixture = makeFixture();
    fixture.shell.registerAll(ALL_DEFINITIONS);
    const before = fixture.shell.registry.names();
    expect(() => fixture.shell.registerAll(leg.terminalCommands)).not.toThrow();
    expect(fixture.shell.registry.names()).toEqual(before);
    for (const def of leg.terminalCommands) {
      const shipped = ALL_DEFINITIONS.find((candidate) => candidate.name === def.name);
      expect(shipped, def.name).toBeDefined();
      if (shipped !== undefined) expect(firstDefinitionDifference(shipped, def), def.name).toBeNull();
    }
  });

  it('keeps the load-bearing lines the package says must survive transcription', () => {
    const text = (name: string): string => leg.terminalCommands.find((def) => def.name === name)?.manual ?? '';
    expect(text('free')).toContain('A request for 12 contiguous frames fails when the largest');
    expect(text('free')).toContain('Read the reason on the failure event before you spend anything.');
    expect(text('free')).toContain('no_space');
    expect(text('free')).toContain('fragmentation  enough free memory, wrong shape');
    expect(text('pagetable')).toContain('any free frame fits any page');
    expect(text('pagetable')).toContain('Without help, paging doubles the cost of');
    expect(text('tlb')).toContain('The hit rate is not a property of the hardware. It is a property of your access');
    expect(text('frag')).toContain('It\nleaves the most holes, which is the opposite of useful.');
  });
});

describe('the See also graph', () => {
  it('every topic the four manuals point at resolves against a full shell', () => {
    const fixture = makeFixture();
    fixture.shell.registerAll(ALL_DEFINITIONS);
    const unresolved: string[] = [];
    for (const def of leg.terminalCommands) {
      const seeAlso = def.manual.split('\n').find((row) => row.startsWith('See also:'));
      expect(seeAlso, def.name).toBeDefined();
      const topics = (seeAlso ?? '').replace('See also:', '').replace(/\.$/, '').split(',').map((entry) => entry.trim());
      expect(topics.length, def.name).toBeGreaterThan(0);
      for (const topic of topics) {
        // A pointer may carry a flag, as `free -f` does; the topic is the command.
        const key = topic.startsWith('codex ') ? topic : (topic.split(/\s+/)[0] ?? topic);
        if (resolveTopic(key, fixture.shell.registry, fixture.host) === null) unresolved.push(`${def.name} -> ${topic}`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});

describe('the pagetable worked examples are arithmetically correct as printed', () => {
  it('a 256-byte page puts logical 1000 at page 3, offset 232', () => {
    const manual = leg.terminalCommands.find((def) => def.name === 'pagetable')?.manual ?? '';
    expect(manual).toContain('256-byte page, logical address 1000 is page 3, offset 232');
    expect(manual).toContain('11, the physical address is 11 * 256 + 232');
    expect(Math.floor(XLATE_MANUAL.logical / XLATE_MANUAL.pageSize)).toBe(XLATE_MANUAL.page);
    expect(XLATE_MANUAL.logical % XLATE_MANUAL.pageSize).toBe(XLATE_MANUAL.offset);
    expect(XLATE_MANUAL.frame * XLATE_MANUAL.pageSize + XLATE_MANUAL.offset).toBe(3048);
  });

  it('states the half-a-page average the leg measures against', () => {
    const manual = leg.terminalCommands.find((def) => def.name === 'pagetable')?.manual ?? '';
    expect(manual).toContain('Average waste is half a page');
  });
});
