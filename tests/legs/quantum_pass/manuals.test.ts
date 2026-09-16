/**
 * WP-L03 acceptance 17 and scope correction section 3: the three man pages
 * match the curriculum map byte for byte, re-registering them over WP-15's own
 * definitions is a no-op, and every `See also:` topic resolves.
 */
import { describe, expect, it } from 'vitest';
import { ALL_DEFINITIONS } from '@terminal/commands/index';
import { resolveTopic, seeAlsoTopics } from '@terminal/man/ManPages';
import { firstDefinitionDifference } from '@terminal/registry';
import leg from '@legs/quantum_pass/index';
import { curriculumDefinitions, makeFixture } from '../../terminal/harness';

const curriculum = curriculumDefinitions();

describe('the three man pages', () => {
  it('introduces sched, nice and gantt and nothing else', () => {
    expect(leg.terminalCommands.map((def) => def.name)).toEqual(['sched', 'nice', 'gantt']);
  });

  for (const name of ['sched', 'nice', 'gantt'] as const) {
    it(`${name} matches the curriculum map byte for byte (acceptance 17)`, () => {
      const fromMap = curriculum.get(name);
      expect(fromMap, `${name} is not in the curriculum map`).toBeDefined();
      const shipped = leg.terminalCommands.find((def) => def.name === name);
      expect(shipped).toBeDefined();
      expect(firstDefinitionDifference(fromMap!, shipped!)).toBeNull();
      expect(shipped?.usage).toBe(fromMap?.usage);
      expect(shipped?.summary).toBe(fromMap?.summary);
      expect(shipped?.manual).toBe(fromMap?.manual);
      expect(shipped?.chapter).toEqual(fromMap?.chapter);
    });
  }

  it('re-shipping WP-15s own definitions registers nothing new and throws nothing', () => {
    const fixture = makeFixture();
    fixture.shell.registerAll(ALL_DEFINITIONS);
    const before = fixture.shell.registry.names();
    expect(() => fixture.shell.registerAll(leg.terminalCommands)).not.toThrow();
    expect(fixture.shell.registry.names()).toEqual(before);
  });

  it('every See also topic resolves', () => {
    const fixture = makeFixture();
    fixture.shell.registerAll(ALL_DEFINITIONS);
    for (const def of leg.terminalCommands) {
      const topics = seeAlsoTopics(def.manual.split('\n'));
      expect(topics.length, `${def.name} names no See also topics`).toBeGreaterThan(0);
      for (const topic of topics) {
        expect(resolveTopic(topic, fixture.shell.registry, fixture.host), `${def.name} See also: ${topic}`).not.toBeNull();
      }
    }
  });

  it('the sched page lists all seven policy ids', () => {
    const manual = leg.terminalCommands.find((def) => def.name === 'sched')?.manual ?? '';
    for (const id of ['fcfs', 'sjf', 'srtf', 'priority', 'priority_aging', 'rr', 'mlfq']) {
      expect(manual, id).toMatch(new RegExp(`^  ${id}\\s`, 'm'));
    }
  });

  it('carries the three load-bearing sentences the leg is built around', () => {
    const page = (name: string): string => leg.terminalCommands.find((def) => def.name === name)?.manual ?? '';
    expect(page('sched')).toContain('This policy starves processes. It is not a defect in');
    expect(page('sched')).toContain('Requires knowing burst');
    expect(page('nice')).toContain('does not fix the policy that starved it, and the next process down will starve in');
    expect(page('gantt')).toContain('--replay re-runs the exact arrival times and burst lengths you already');
  });
});
