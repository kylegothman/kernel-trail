/** KERNEL TRAIL: the Allocation Yards' citations (curriculum map, leg 7). */
import type { ChapterRef } from '@game/types';

export const MAIN_MEMORY: ChapterRef = {
  chapter: 9,
  title: 'Main Memory',
  sections: ['9.1.1', '9.1.2', '9.1.3', '9.1.4', '9.1.5',
    '9.2.1', '9.2.2', '9.2.3',
    '9.3.1', '9.3.2', '9.3.3', '9.3.4',
    '9.4.1', '9.4.3', '9.5.1', '9.5.2'],
};

export const chapters: readonly ChapterRef[] = [MAIN_MEMORY];

/** A citation into the leg's one chapter, for an objective or the debrief card. */
export function section(...sections: readonly string[]): ChapterRef {
  for (const id of sections) {
    if (!MAIN_MEMORY.sections.includes(id)) throw new Error(`allocation_yards: section ${id} is not in the leg's chapter coverage`);
  }
  return { chapter: 9, title: 'Main Memory', sections };
}
