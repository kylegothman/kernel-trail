/**
 * File collection and line scanning for the src/ui guard rails. It defines
 * no rule of its own: every pattern comes from the test that calls it, and
 * comment stripping is the shared scanner in tests/kernel/sourceScan.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripComments } from '../kernel/sourceScan';

export const REPO_ROOT = resolve(__dirname, '..', '..');
export const UI_ROOT = join(REPO_ROOT, 'src', 'ui');

export function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

export interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Identifier scans strip comments and literals; import scans keep literals. */
export type ScanMode = 'code' | 'imports';

export function scanFiles(files: readonly string[], pattern: RegExp, mode: ScanMode): Offence[] {
  const offences: Offence[] = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const prepared = stripComments(raw, mode === 'code');
    const lines = prepared.split('\n');
    const rawLines = raw.split('\n');
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    lines.forEach((line, i) => {
      const re = new RegExp(pattern.source, flags);
      if (re.test(line)) offences.push({ file: relative(REPO_ROOT, file), line: i + 1, text: (rawLines[i] ?? '').trim() });
    });
  }
  return offences;
}

export const reportOffences = (offences: readonly Offence[]): string =>
  offences.map((o) => `${o.file}:${o.line}  ${o.text}`).join('\n');
