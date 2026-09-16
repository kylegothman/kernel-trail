/**
 * KERNEL TRAIL: concept topics (WP-15 spec 5, scope correction T7 and pre-flight F11).
 *
 * The curriculum map has no concept pages: `man syscall` and `man mode`
 * resolve as command pages because both are Leg 0 commands. A codex reference
 * (`codex`, `codex zombie_orphan`) is redirected to the codex, which is WP-17's
 * surface. Any other concept topic resolves to the no-page message naming the
 * nearest real topic by edit distance. Nothing here invents a page.
 */

/**
 * Concept pages sourced from the curriculum map. Empty today because the map
 * defines none.
 */
// TODO(astra): add a concept page here only when docs/05-CURRICULUM-MAP.md gains one; `man shared_memory`, named by the ipc page, is the first known gap.
export const CONCEPT_PAGES: ReadonlyMap<string, readonly string[]> = new Map();

export const CODEX_TOPIC = 'codex';

export function isCodexReference(topic: string): boolean {
  return topic === CODEX_TOPIC || topic.startsWith(`${CODEX_TOPIC} `) || topic.startsWith(`${CODEX_TOPIC}.`);
}

/** Pre-flight F11: one authored redirect line. */
export function codexRedirect(topic: string): string[] {
  return [`'${topic}' is a codex entry, not a manual page. Open the codex to read it.`, '', 'See also: man.'];
}

/** Template 3d. */
export function noPage(topic: string, nearest: string): string[] {
  return [`No manual page for '${topic}'. The nearest topic is '${nearest}'.`, '', `See also: ${nearest}.`];
}
