/**
 * KERNEL TRAIL, the Narrows: the citations.
 *
 * Chapter 6 of Silberschatz, Operating System Concepts, 10th edition, with
 * the section list of `docs/05-CURRICULUM-MAP.md`, "Leg 4. THE NARROWS".
 * Every `ChapterRef` this leg builds draws its sections from this file, so a
 * debrief or a codex entry cannot cite a section the leg does not cover.
 */
import type { ChapterRef } from '@game/types';

export const SYNCHRONIZATION_TOOLS = 'Synchronization Tools';

export const chapters: readonly ChapterRef[] = [
  {
    chapter: 6,
    title: SYNCHRONIZATION_TOOLS,
    sections: ['6.1', '6.2', '6.3', '6.4.1', '6.4.2', '6.4.3',
      '6.5', '6.6.1', '6.6.2', '6.7.1', '6.7.2', '6.8', '6.9'],
  },
];

/** A citation into chapter 6 over the sections given, all of which the leg declares. */
export function cite(...sections: readonly string[]): ChapterRef {
  const declared = chapters[0];
  if (declared === undefined) throw new Error('the_narrows: no chapter declared');
  for (const section of sections) {
    if (!declared.sections.includes(section)) throw new Error(`the_narrows: section ${section} is outside the leg's declared coverage`);
  }
  return { chapter: 6, title: SYNCHRONIZATION_TOOLS, sections };
}

/** The debrief card's citation: the critical section problem itself. */
export const CRITICAL_SECTION = cite('6.2');
