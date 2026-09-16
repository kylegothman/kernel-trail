/**
 * The leg 0 blocks of docs/05-CURRICULUM-MAP.md, evaluated as written, so the
 * suites assert against the source document rather than a copy of it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChapterRef, LearningObjective } from '@game/types';
import { REPO_ROOT } from '../harness/loadLeg';

function legZero(): string {
  const doc = readFileSync(resolve(REPO_ROOT, 'docs', '05-CURRICULUM-MAP.md'), 'utf8');
  const start = doc.indexOf('## Leg 0. THE BOOT SECTOR');
  const end = doc.indexOf('## Leg 1.', start);
  if (start < 0 || end < 0) throw new Error('curriculum map: the leg 0 section was not found');
  return doc.slice(start, end);
}

function literal<T>(section: string, name: string): T {
  const match = new RegExp(`const ${name}: readonly [A-Za-z]+\\[\\] = (\\[[\\s\\S]*?\\n\\]);`).exec(section);
  if (match?.[1] === undefined) throw new Error(`curriculum map: no ${name} literal in leg 0`);
  return new Function(`return ${match[1]};`)() as T;
}

export function curriculumChapters(): readonly ChapterRef[] {
  return literal<readonly ChapterRef[]>(legZero(), 'chapters');
}

export function curriculumObjectiveIds(): readonly string[] {
  return literal<readonly LearningObjective[]>(legZero(), 'objectives').map((objective) => objective.id);
}

export function curriculumCodexIds(): readonly string[] {
  const section = legZero();
  const table = section.slice(section.indexOf('### Codex entries unlocked'), section.indexOf('### Misconceptions targeted'));
  return [...table.matchAll(/^\| `(codex\.[a-z_]+)` \|/gm)].map((match) => match[1] ?? '');
}
