/**
 * WP-15: the manual. Command pages are the curriculum map's text verbatim,
 * syscall and errno pages are assembled from the kernel's own tables through
 * the host, codex references are redirected, and an unknown topic names the
 * nearest real one. No page tells the player which choice to make, every page
 * ends with a See also line whose topics resolve, and no page cites the three
 * corrected section numbers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ERRNO_SUBSTITUTIONS } from '@kernel/syscall/errno';
import type { Errno, SyscallName } from '@kernel/types';
import { ALL_DEFINITIONS, BASE_COMMAND_NAMES, SHIPPED_HANDLERS } from '@terminal/commands/index';
import { DEFERRED_COMMANDS } from '@terminal/registry';
import { createBaseShell } from '@terminal/Shell';
import { ERRNO_CALLS, ERRNO_NAMES } from '@terminal/man/errnoPages';
import { allTopics, pageFor, resolveTopic, seeAlsoTopics } from '@terminal/man/ManPages';
import { CALL_PREFIX } from '@terminal/man/syscallPages';
import { createTerminalHost } from '@game/terminalHost';
import { curriculumDefinitions, ERRORS, expectError, expectErrorsNameTopics, expectOk, fixtureRun, makeFixture, makeKernel, recordingSink, ROOT } from './harness';

const DEFINED = curriculumDefinitions();
const DOC = readFileSync(resolve(ROOT, 'docs', '05-CURRICULUM-MAP.md'), 'utf8');
const CODEX_IDS = new Set([...DOC.matchAll(/`codex\.([a-z_]+)`/g)].map(match => match[1] ?? ''));

/** A shell with all 49 definitions registered, so every command page exists. */
function fullShell() {
  const f = makeFixture();
  f.shell.registerAll(ALL_DEFINITIONS);
  return f;
}

/** Every page the package can produce: 49 commands, 27 syscalls, 11 errnos, 7 substitutions. */
function everyPage(f: ReturnType<typeof fullShell>): { readonly topic: string; readonly kind: string; readonly lines: readonly string[] }[] {
  const pages: { topic: string; kind: string; lines: readonly string[] }[] = [];
  for (const def of ALL_DEFINITIONS) pages.push({ topic: def.name, kind: 'command', lines: expectOk(f.shell, `man ${def.name}`) });
  for (const name of f.host.specs.names) pages.push({ topic: `${CALL_PREFIX}${name}`, kind: 'syscall', lines: expectOk(f.shell, `man ${CALL_PREFIX}${name}`) });
  for (const code of ERRNO_NAMES) pages.push({ topic: code, kind: 'errno', lines: expectOk(f.shell, `man ${code}`) });
  for (const row of f.host.specs.substitutions) pages.push({ topic: row.unix, kind: 'substituted', lines: expectOk(f.shell, `man ${row.unix}`) });
  return pages;
}

describe('man', () => {
  it('command page: man ps returns TerminalCommandDef.manual verbatim, and so does every other command', () => {
    const f = fullShell();
    expect(expectOk(f.shell, 'man ps').join('\n')).toBe(DEFINED.get('ps')?.manual);
    for (const def of ALL_DEFINITIONS) expect(expectOk(f.shell, `man ${def.name}`).join('\n'), def.name).toBe(def.manual);
    expect(expectOk(f.shell, 'man kill').join('\n')).toBe(DEFINED.get('kill')?.manual);
    expect(expectOk(f.shell, `man ${CALL_PREFIX}kill`)[0]).toBe(`kill: ${f.host.specs.calls.kill.summary}`);
  });

  it('concept page: man syscall and man mode return the Leg 0 command manuals, and a codex reference is redirected', () => {
    const f = fullShell();
    expect(expectOk(f.shell, 'man syscall').join('\n')).toBe(DEFINED.get('syscall')?.manual);
    expect(expectOk(f.shell, 'man mode').join('\n')).toBe(DEFINED.get('mode')?.manual);
    expect(expectOk(f.shell, 'man codex zombie_orphan')[0]).toBe("'codex zombie_orphan' is a codex entry, not a manual page. Open the codex to read it.");
    expect(expectOk(f.shell, 'man codex').at(-1)).toBe('See also: man.');
  });

  it('syscall pages: man fork and the other 26 names are assembled from the specs with a usage line and the errno column', () => {
    const f = fullShell();
    const page = expectOk(f.shell, 'man fork');
    expect(page[0]).toBe(`fork: ${f.host.specs.calls.fork.summary}`);
    expect(page[1]).toBe(`usage: ${f.host.specs.usage('fork')}`);
    expect(page).toContain('  none');
    expect(page.some(line => line === 'errno: EAGAIN, ENOMEM, EINVAL')).toBe(true);
    expect(page.at(-1)).toBe('See also: syscall, EAGAIN.');
    const killPage = expectOk(f.shell, `man ${CALL_PREFIX}kill`);
    expect(killPage.some(line => line.startsWith('  pid  number role pid min 0'))).toBe(true);
    expect(killPage.some(line => line === 'rights: control')).toBe(true);
    expect(killPage.at(-1)).toBe('See also: kill, syscall, EPERM.');
    const requestPage = expectOk(f.shell, 'man request');
    expect(requestPage.some(line => line === '  resource instances  repeated as a group')).toBe(true);
    expect(expectOk(f.shell, 'man getpid').at(-1)).toBe('See also: syscall.');
    for (const name of f.host.specs.names) expect(expectOk(f.shell, `man ${CALL_PREFIX}${name}`)[0], name).toContain(`${name}:`);
  });

  it('errno pages: all eleven members of the frozen union, each naming calls that are real syscall names (acceptance 10)', () => {
    const f = fullShell();
    const every: Readonly<Record<Errno, true>> = { EPERM: true, ENOENT: true, EAGAIN: true, ENOMEM: true, EACCES: true, EBUSY: true, EEXIST: true, EINVAL: true, ENOSPC: true, EDEADLK: true, ESRCH: true };
    const codes = Object.keys(every) as Errno[];
    expect(codes).toHaveLength(11);
    expect([...ERRNO_NAMES].sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const page = expectOk(f.shell, `man ${code}`);
      expect(page[0], code).toBe(code);
      expect(page[1], code).toBe(`returned by: ${ERRNO_CALLS[code].join(', ')}`);
      for (const call of ERRNO_CALLS[code]) expect(f.host.specs.names, `${code} names ${call}`).toContain(call);
      expect(page.at(-1), code).toMatch(/^See also: .*syscall\.$/);
    }
    expect(expectOk(f.shell, 'man ESRCH')).toContain('Any call returns ESRCH when the calling pid does not exist.');
    expect(ERRNO_CALLS.EINVAL).toHaveLength(26);
    expect(ERRNO_CALLS.EINVAL).not.toContain('getpid');
  });

  it('substituted codes: man ECHILD explains the ESRCH substitution and the "no children: " prefix, and so do the other six (acceptance 10)', () => {
    const f = fullShell();
    expect(ERRNO_SUBSTITUTIONS).toHaveLength(7);
    expect(f.host.specs.substitutions).toEqual(ERRNO_SUBSTITUTIONS);
    const expected: readonly [string, Errno, string][] = [
      ['ECHILD', 'ESRCH', 'no children: '], ['ENOTDIR', 'EINVAL', 'not a directory: '], ['EBADF', 'EINVAL', 'bad file descriptor: '],
      ['EMFILE', 'EAGAIN', 'too many open files: '], ['EFAULT', 'EINVAL', 'address out of range: '], ['EISDIR', 'EINVAL', 'is a directory: '],
      ['ENOTEMPTY', 'EBUSY', 'directory not empty: '],
    ];
    for (const [unix, errno, prefix] of expected) {
      const row = ERRNO_SUBSTITUTIONS.find(candidate => candidate.unix === unix);
      expect(row, unix).toEqual({ unix, errno, prefix });
      const page = expectOk(f.shell, `man ${unix}`);
      expect(page[0], unix).toBe(unix);
      expect(page[1], unix).toContain(`returns ${errno} in its place`);
      expect(page[1], unix).toContain(`"${prefix}"`);
      expect(page[1], unix).toContain('is not a member of this kernel\'s errno set');
      expect(page.at(-1), unix).toBe(`See also: ${errno}, syscall.`);
    }
  });

  it('unknown topic: a clear no-page message naming the nearest real topic (acceptance 9)', () => {
    const f = fullShell();
    const unknown = expectError(f.shell, 'man shared_memory');
    expect(unknown.message).toMatch(/^No manual page for 'shared_memory'\. The nearest topic is '[a-zA-Z_:]+'\./);
    expect(resolveTopic(unknown.topic, f.shell.registry, f.host)).not.toBeNull();
    expect(unknown.message.endsWith(`See also: ${unknown.topic}.`)).toBe(true);
    const typo = expectError(f.shell, 'man pagetabel');
    expect(typo.topic).toBe('pagetable');
    expect(expectError(f.shell, 'man').topic).toBe('man');
    const base = makeFixture();
    base.shell.registerAll(ALL_DEFINITIONS.filter(def => BASE_COMMAND_NAMES.includes(def.name)));
    expect(expectError(base.shell, 'man sched').topic).not.toBe('sched');
  });

  it('no remedies: no page contains a remedy instruction (patterns and exclusions as data)', () => {
    const f = fullShell();
    // Approved in the pre-flight (F12): forms that would tell the player which choice to make.
    const forbidden = ['you must', 'switch to', 'switch the', 'set the scheduler', 'increase the quantum', 'decrease the quantum',
      'raise the quantum', 'lower the quantum', 'reduce the degree', 'lower the degree', 'the fix is', 'should be set'];
    // Descriptive uses the curriculum map makes, excluded from the scan: "consequences you should predict" (kill),
    // "set the reader-writer lock policy" (rwlock), "the remedy you pick should be aimed" (wfg), "does not fix the policy" (nice).
    const excluded = ['you should', 'set the policy', 'the remedy', 'to fix'];
    expect(excluded).toHaveLength(4);
    for (const page of everyPage(f)) {
      const text = page.lines.join('\n').toLowerCase();
      for (const pattern of forbidden) expect(text, `${page.topic} contains "${pattern}"`).not.toContain(pattern);
    }
  });

  it('see also: every page ends with a See also line and every topic it names resolves, except the one known source gap', () => {
    const f = fullShell();
    const unresolved: string[] = [];
    const unknownCodex: string[] = [];
    for (const page of everyPage(f)) {
      const last = [...page.lines].reverse().find(line => line.trim().length > 0) ?? '';
      expect(last, page.topic).toMatch(/^See also: .+\.$/);
      const topics = seeAlsoTopics(page.lines);
      expect(topics.length, page.topic).toBeGreaterThan(0);
      for (const topic of topics) {
        if (topic.startsWith('codex ')) { if (!CODEX_IDS.has(topic.slice('codex '.length))) unknownCodex.push(`${page.topic}: ${topic}`); continue; }
        if (resolveTopic(topic, f.shell.registry, f.host) === null) unresolved.push(`${page.topic}: ${topic}`);
      }
    }
    // Two source gaps, reported under item 5: the ipc page names `man shared_memory`, which the map defines nowhere,
    // and the nice page names `codex starvation` where the map's id is `codex.priority_starvation`.
    expect(unresolved).toEqual(['ipc: shared_memory']);
    expect(unknownCodex).toEqual(['nice: codex starvation']);
  });

  it('citations: no page cites 5.3.4 for the quantum, 8.6.2 for the safe sequence or 8.3.2 for the cycle (acceptance 12)', () => {
    const f = fullShell();
    for (const page of everyPage(f)) {
      const text = page.lines.join('\n');
      expect(text, page.topic).not.toContain('5.3.4');
      expect(text, page.topic).not.toContain('8.6.2');
      expect(text, page.topic).not.toContain('8.3.2');
    }
  });

  it('no invented pages: every command page is in the curriculum map and every other page is template plus data', () => {
    const f = fullShell();
    for (const page of everyPage(f)) {
      const text = page.lines.join('\n');
      if (page.kind === 'command') { expect(DOC, page.topic).toContain(page.lines[0] ?? ''); expect(DEFINED.get(page.topic)?.manual, page.topic).toBe(text); continue; }
      if (page.kind === 'syscall') {
        const name = page.topic.slice(CALL_PREFIX.length) as SyscallName;
        expect(page.lines[0], page.topic).toBe(`${name}: ${f.host.specs.calls[name].summary}`);
        expect(page.lines[1], page.topic).toBe(`usage: ${f.host.specs.usage(name)}`);
        expect(page.lines[2], page.topic).toBe('arguments:');
        expect(page.lines.some(line => line.startsWith('rights: ')), page.topic).toBe(true);
        expect(page.lines.some(line => line.startsWith('errno: ')), page.topic).toBe(true);
        continue;
      }
      if (page.kind === 'errno') { expect(page.lines[1], page.topic).toMatch(/^returned by: /); continue; }
      expect(page.lines[1], page.topic).toMatch(/^[A-Z]+ is not a member of this kernel's errno set\./);
    }
    expect(everyPage(f)).toHaveLength(49 + 27 + 11 + 7);
  });

  it('topics: allTopics lists commands, syscalls, errnos, substitutions and codex for completion', () => {
    const f = fullShell();
    const topics = allTopics(f.shell.registry, f.host);
    for (const name of ['ps', 'fork', 'EPERM', 'ECHILD', 'codex', 'hyper']) expect(topics).toContain(name);
    expect(pageFor({ kind: 'concept', key: 'nothing' }, f.shell.registry, f.host)).toEqual([]);
    expect(f.shell.complete('man EPE').candidates).toEqual(['EPERM']);
    expect(f.shell.complete('man pa').candidates).toEqual(['pagetable']);
  });
});

describe('base shell', () => {
  it('registers exactly the fourteen names of design brief section 7, each with a shipped handler', () => {
    const kernel = makeKernel();
    const run = fixtureRun();
    const host = createTerminalHost(kernel, recordingSink(kernel, run), () => run);
    const shell = createBaseShell(host);
    expect(shell.registry.names()).toEqual([...BASE_COMMAND_NAMES].sort());
    for (const name of BASE_COMMAND_NAMES) expect(SHIPPED_HANDLERS.has(name), name).toBe(true);
    expect(SHIPPED_HANDLERS.size + DEFERRED_COMMANDS.length).toBe(49);
    expect(expectOk(shell, 'man man').join('\n')).toBe(DEFINED.get('man')?.manual);
    expect(expectError(shell, 'sched').topic).not.toBe('');
    shell.dispose();
  });
});

describe('errors name topics (acceptance 11)', () => {
  it('every error this suite produced names a man topic that resolves', () => {
    expect(ERRORS.length).toBeGreaterThan(3);
    expectErrorsNameTopics();
  });
});
