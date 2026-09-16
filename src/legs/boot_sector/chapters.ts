/**
 * The Boot Sector's chapter coverage, copied from the curriculum map's
 * "Chapter and section coverage" block for leg 0. Section 1.7 is named once
 * in the vendor-string event and left unexplained on purpose; the Portal
 * pays it off.
 */
import type { ChapterRef } from '@game/types';

export const INTRODUCTION: ChapterRef = {
  chapter: 1,
  title: 'Introduction',
  sections: ['1.1', '1.2.1', '1.2.2', '1.3.1', '1.4.1', '1.4.2', '1.5', '1.6', '1.10.1'],
};

export const STRUCTURES: ChapterRef = {
  chapter: 2,
  title: 'Operating-System Structures',
  sections: ['2.1', '2.2', '2.3', '2.3.1', '2.3.2', '2.3.3', '2.4', '2.8.1', '2.8.2', '2.9'],
};

export const chapters: readonly ChapterRef[] = [INTRODUCTION, STRUCTURES];
