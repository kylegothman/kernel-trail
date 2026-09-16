/**
 * KERNEL TRAIL: Quantum Pass, chapter coverage. Curriculum map, leg 3.
 *
 * Section 5.6 (real-time scheduling) is deliberately absent: the audit lists it
 * as partial and the leg builds no real-time scheduler.
 */
import type { ChapterRef } from '@game/types';

export const CPU_SCHEDULING: ChapterRef = {
  chapter: 5,
  title: 'CPU Scheduling',
  sections: ['5.1.1', '5.1.2', '5.1.3', '5.2', '5.3.1', '5.3.2', '5.3.3', '5.3.4', '5.3.5', '5.3.6', '5.4', '5.5.1', '5.8.1', '5.8.2'],
};

export const chapters: readonly ChapterRef[] = [CPU_SCHEDULING];

/** A narrower citation into the same chapter, for objectives, codex entries and the debrief. */
export function cite(...sections: readonly string[]): ChapterRef {
  return { chapter: 5, title: 'CPU Scheduling', sections: [...sections] };
}
