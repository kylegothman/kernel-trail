/**
 * The codex search index, over readable entries only. Architecture 9.1 puts
 * construction in `bake.worker.ts`, so `buildIndex` is pure and either thread
 * can call it; the codex passes it the readable set and nothing else.
 */
import type { CodexEntry } from '@game/codexTypes';

export interface CodexSearchIndex {
  readonly ids: readonly string[];
  /** Token to the ids containing it, ids in chronological order. */
  readonly postings: ReadonlyMap<string, readonly string[]>;
}

/** Lowercase words; a dotted id such as `fx.entry` yields both halves and itself. */
export function tokenise(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
  const ids = lower.split(/[^a-z0-9_.]+/).filter((t) => t.includes('.') && t.length > 1 && !t.endsWith('.'));
  return [...words, ...ids];
}

export function buildIndex(entries: readonly CodexEntry[]): CodexSearchIndex {
  const postings = new Map<string, string[]>();
  const ids: string[] = [];
  for (const e of entries) {
    ids.push(e.id);
    const tokens = new Set([...tokenise(e.id), ...tokenise(e.title), ...tokenise(e.concept), ...e.commands.flatMap(tokenise)]);
    for (const t of tokens) {
      const list = postings.get(t);
      if (list === undefined) postings.set(t, [e.id]);
      else list.push(e.id);
    }
  }
  return { ids, postings };
}

/** Ids matching every query token, in the index's chronological order. */
export function search(index: CodexSearchIndex, query: string): readonly string[] {
  const tokens = tokenise(query);
  if (tokens.length === 0) return index.ids;
  const matchedPerToken = tokens.map((t) => {
    const matched = new Set<string>();
    for (const [token, ids] of index.postings) if (token.startsWith(t)) for (const id of ids) matched.add(id);
    return matched;
  });
  return index.ids.filter((id) => matchedPerToken.every((m) => m.has(id)));
}
