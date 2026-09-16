/**
 * Acceptance 11: each `manual` equals the curriculum map byte for byte, the
 * shell accepts the definitions as identical re-registrations, and every
 * `See also:` topic resolves in a full shell's topic table.
 */
import { describe, expect, it } from 'vitest';
import { terminalCommands } from '@legs/boot_sector/commands';
import { ALL_DEFINITIONS } from '@terminal/commands/index';
import { resolveTopic, seeAlsoTopics } from '@terminal/man/ManPages';
import { curriculumDefinitions, makeFixture } from '../../terminal/harness';

describe('boot_sector manuals', () => {
  it('ships man, syscall and mode exactly as the curriculum map writes them', () => {
    const curriculum = curriculumDefinitions();
    expect(terminalCommands.map((def) => def.name)).toEqual(['man', 'syscall', 'mode']);
    for (const def of terminalCommands) {
      const expected = curriculum.get(def.name);
      expect(expected, def.name).toBeDefined();
      expect(def.manual, def.name).toBe(expected?.manual);
      expect(def, def.name).toEqual(expected);
    }
  });

  it('re-registers into a full shell as a byte-identical no-op', () => {
    const f = makeFixture();
    f.shell.registerAll(ALL_DEFINITIONS);
    const names = f.shell.registry.names();
    expect(() => f.shell.registerAll(terminalCommands)).not.toThrow();
    expect(f.shell.registry.names()).toEqual(names);
  });

  it('every See also topic resolves', () => {
    const f = makeFixture();
    f.shell.registerAll(ALL_DEFINITIONS);
    for (const def of terminalCommands) {
      const topics = seeAlsoTopics(def.manual.split('\n'));
      expect(topics.length, def.name).toBeGreaterThan(0);
      for (const topic of topics) expect(resolveTopic(topic, f.shell.registry, f.host), `${def.name}: ${topic}`).not.toBeNull();
    }
    for (const topic of ['EPERM', 'ENOMEM', 'EINVAL', 'codex']) expect(resolveTopic(topic, f.shell.registry, f.host), topic).not.toBeNull();
  });
});
