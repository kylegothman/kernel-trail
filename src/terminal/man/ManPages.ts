/**
 * KERNEL TRAIL: `man` resolution (WP-15 spec 5).
 *
 * A topic is a command name (the definition's manual, verbatim), a syscall
 * name (assembled from the specs), a native errno (the eleven members), a
 * substituted Unix code (the seven rows), a codex reference (redirected), or
 * nothing, in which case the nearest real topic is named. Command names win a
 * collision with a syscall name; `call:kill` reaches the syscall page. Every
 * page ends with a See also line, and every error names a topic that exists.
 */
import type { Errno, SyscallName } from '@kernel/types';
import type { TerminalHost } from '../host';
import { nearest, type CommandRegistry, type CommandResult } from '../registry';
import { CODEX_TOPIC, CONCEPT_PAGES, codexRedirect, isCodexReference, noPage } from './conceptPages';
import { ERRNO_NAMES, errnoPage, isErrno, substitutedPage } from './errnoPages';
import { CALL_PREFIX, syscallPage } from './syscallPages';

export type TopicKind = 'command' | 'syscall' | 'errno' | 'substituted' | 'codex' | 'concept';

export interface ResolvedTopic { readonly kind: TopicKind; readonly key: string }

function isSyscall(name: string, host: TerminalHost): name is SyscallName {
  return (host.specs.names as readonly string[]).includes(name);
}

/** What a topic names, or null when no page exists for it. */
export function resolveTopic(topic: string, registry: CommandRegistry, host: TerminalHost): ResolvedTopic | null {
  const text = topic.trim();
  if (text.length === 0) return null;
  if (isCodexReference(text)) return { kind: 'codex', key: text };
  if (registry.has(text)) return { kind: 'command', key: text };
  if (text.startsWith(CALL_PREFIX) && isSyscall(text.slice(CALL_PREFIX.length), host)) return { kind: 'syscall', key: text.slice(CALL_PREFIX.length) };
  if (isSyscall(text, host)) return { kind: 'syscall', key: text };
  if (isErrno(text)) return { kind: 'errno', key: text };
  if (host.specs.substitutions.some(row => row.unix === text)) return { kind: 'substituted', key: text };
  if (CONCEPT_PAGES.has(text)) return { kind: 'concept', key: text };
  return null;
}

/** Every topic `man` can answer, for completion and for the nearest-topic search. */
export function allTopics(registry: CommandRegistry, host: TerminalHost): readonly string[] {
  return [...new Set([...registry.names(), ...host.specs.names, ...ERRNO_NAMES, ...host.specs.substitutions.map(row => row.unix), ...CONCEPT_PAGES.keys(), CODEX_TOPIC])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function pageFor(resolved: ResolvedTopic, registry: CommandRegistry, host: TerminalHost): readonly string[] {
  switch (resolved.kind) {
    case 'command': return (registry.get(resolved.key)?.def.manual ?? '').split('\n');
    case 'syscall': return syscallPage(resolved.key as SyscallName, host);
    case 'errno': return errnoPage(resolved.key as Errno);
    case 'substituted': {
      const row = host.specs.substitutions.find(candidate => candidate.unix === resolved.key);
      return row === undefined ? [] : substitutedPage(row);
    }
    case 'codex': return codexRedirect(resolved.key);
    case 'concept': return CONCEPT_PAGES.get(resolved.key) ?? [];
  }
}

/** The `man` command's result: a page, or the no-page message naming the nearest real topic. */
export function manPage(topic: string, registry: CommandRegistry, host: TerminalHost): CommandResult {
  const text = topic.trim();
  if (text.length === 0) return { ok: false, message: 'man needs a topic: a command name, a system call, or an error code. See man man.', topic: 'man' };
  const resolved = resolveTopic(text, registry, host);
  if (resolved !== null) return { ok: true, lines: pageFor(resolved, registry, host) };
  const candidates = allTopics(registry, host);
  const near = nearest(text, candidates) ?? 'man';
  return { ok: false, message: noPage(text, near).join('\n'), topic: near };
}

/** The topics a page's See also line names, one per comma, flags and "(available later)" stripped, `man X` unwrapped. */
export function seeAlsoTopics(lines: readonly string[]): readonly string[] {
  const last = [...lines].reverse().find(line => line.trim().length > 0) ?? '';
  const match = /^See also:\s*(.*?)\.?\s*$/.exec(last.trim());
  if (match === null) return [];
  return (match[1] ?? '').split(',').map(item => item.replace(/\(available later\)/g, '').trim()).filter(item => item.length > 0).map(item => {
    const words = item.split(/\s+/);
    if (words[0] === 'man' && words[1] !== undefined) return words[1];
    if (words[0] === CODEX_TOPIC) return words.slice(0, 2).join(' ');
    return words[0] ?? item;
  });
}
