/**
 * The codex entry registry. Empty: this package ships the machinery and zero
 * entry content, and each leg package registers its own entries from the
 * "Codex entries unlocked" section of the curriculum map.
 *
 * Content leaves the registry through exactly one accessor, `reveal`, which
 * only `Codex.open` and the codex's own unlock path call after the gate in
 * narrative bible 14.1 has passed. Nothing else reads `concept` text.
 */
import type { CodexEntry, CodexUnlock } from '@game/codexTypes';

export class CodexRegistry {
  private readonly entries = new Map<string, CodexEntry>();

  register(entry: CodexEntry): void {
    if (this.entries.has(entry.id)) throw new Error(`codex: duplicate entry id ${entry.id}`);
    if (entry.workedExample !== null || entry.counterfactual !== null) {
      throw new Error(`codex: ${entry.id} is authored with run data; worked examples are built, never written`);
    }
    this.entries.set(entry.id, entry);
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Entry ids in registration order. Ids only, no content. */
  ids(): readonly string[] {
    return [...this.entries.keys()];
  }

  unlockOf(id: string): CodexUnlock | null {
    return this.entries.get(id)?.unlock ?? null;
  }

  /** Every entry's unlock condition, for the trigger table. Ids and unlocks only. */
  unlocks(): readonly { readonly id: string; readonly unlock: CodexUnlock }[] {
    return [...this.entries.values()].map((e) => ({ id: e.id, unlock: e.unlock }));
  }

  /**
   * The content accessor. Callers must have passed the readability gate:
   * the id is in `RunState.codexUnlocked` or in the profile's `seen` set.
   * `tests/ui/codex.test.ts` scans for callers outside `Codex.ts`.
   */
  reveal(id: string): CodexEntry {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error(`codex: unknown entry ${id}`);
    return entry;
  }
}

export function createCodexRegistry(): CodexRegistry {
  return new CodexRegistry();
}
