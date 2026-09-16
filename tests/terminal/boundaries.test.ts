/**
 * WP-15 scope correction T9: the terminal's import and mutation boundary.
 *
 * `src/terminal` may value-import from @design, @game and itself; every
 * @kernel import is `import type`; no three, no hex colour literal, no
 * localStorage, no innerHTML, no Math.random, no Date.now, and no import from
 * the world, render, audio, ui, app or platform layers. Acceptance 7 is
 * asserted here too: no call to a kernel setter, `restore` or `syscall`
 * anywhere in the terminal, because every write goes through the sink.
 * Uses the one scanner, tests/kernel/sourceScan.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripComments } from '../kernel/sourceScan';

const ROOT = resolve(__dirname, '..', '..');
const TERMINAL_ROOT = join(ROOT, 'src', 'terminal');

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out.sort();
}

const FILES = collect(TERMINAL_ROOT);

interface Offence { readonly file: string; readonly line: number; readonly text: string }

function scan(pattern: RegExp, prepare: (source: string) => string): Offence[] {
  const offences: Offence[] = [];
  for (const file of FILES) {
    const raw = readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    prepare(raw).split('\n').forEach((line, index) => {
      const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      if (re.test(line)) offences.push({ file: relative(ROOT, file), line: index + 1, text: (rawLines[index] ?? '').trim() });
    });
  }
  return offences;
}

const codeOnly = (source: string): string => stripComments(source, true);
const withLiterals = (source: string): string => stripComments(source, false);
const report = (offences: readonly Offence[]): string => offences.map(o => `${o.file}:${o.line}  ${o.text}`).join('\n');

describe('src/terminal boundary', () => {
  it('finds the terminal sources', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES.map(file => relative(TERMINAL_ROOT, file))).toContain('Shell.ts');
  });

  it('imports nothing from three', () => {
    expect(report(scan(/\bfrom\s*['"]three(\/[^'"]*)?['"]|\bimport\s*\(\s*['"]three/, withLiterals))).toBe('');
  });

  it('imports nothing from the world, render, audio, ui, app or platform layers', () => {
    expect(report(scan(/\bfrom\s*['"](@world|@render|@audio|@ui|@app|@platform)\b|\bfrom\s*['"](\.\.\/)+(world|render|audio|ui|app|platform)\b/, withLiterals))).toBe('');
  });

  it('imports from the kernel with import type only (acceptance 20)', () => {
    const offences: Offence[] = [];
    for (const file of FILES) {
      const raw = readFileSync(file, 'utf8');
      withLiterals(raw).split('\n').forEach((line, index) => {
        if (!/\bfrom\s*['"](@kernel\b|(\.\.\/)+kernel\b)/.test(line)) return;
        if (/^\s*import\s+type\b/.test(line) || /^\s*export\s+type\b/.test(line)) return;
        // A multi-line import ends with `} from '@kernel/...'`; find its opening line.
        let opening = index;
        while (opening > 0 && !/^\s*(import|export)\b/.test(raw.split('\n')[opening] ?? '')) opening -= 1;
        const head = raw.split('\n')[opening] ?? '';
        if (/^\s*import\s+type\b/.test(head) || /^\s*export\s+type\b/.test(head)) return;
        offences.push({ file: relative(ROOT, file), line: index + 1, text: line.trim() });
      });
    }
    expect(report(offences)).toBe('');
  });

  it('contains no hex colour literal (acceptance 19)', () => {
    expect(report(scan(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z])|\b0x[0-9a-fA-F]{6}\b/, withLiterals))).toBe('');
  });

  it('never touches localStorage, innerHTML, Math.random or Date.now', () => {
    expect(report(scan(/\b(localStorage|sessionStorage|indexedDB)\b|\.innerHTML\b|\bMath\s*\.\s*random\b|\bDate\s*\.\s*now\b|\bnew\s+Date\b|\bperformance\s*\.\s*now\b/, codeOnly))).toBe('');
  });

  it('never mutates the kernel directly (acceptance 7)', () => {
    expect(report(scan(/\.(setScheduler|setReplacementPolicy|setDiskPolicy|setAllocationStrategy|setDegreeOfMultiprogramming|setDeadlockStrategy|restore|syscall)\s*\(/, codeOnly))).toBe('');
  });
});
