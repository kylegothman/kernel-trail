/**
 * The architectural guard rail, stated at the top of src/kernel/types.ts:
 *
 *   1. Nothing under src/kernel imports from three, the DOM, or any render
 *      module.
 *   2. Nothing under src/kernel calls Math.random, Date.now, or performance.now.
 *      All nondeterminism flows through the injected Rng.
 *
 * Architecture section 1.5 makes this a test rather than a lint rule, because a
 * lint rule can be disabled inline and a failing test cannot be argued with.
 *
 * Comments and string literals are stripped before scanning. That matters: the
 * frozen types.ts states the rule in prose, and a naive `includes('Math.random')`
 * would fail on the very file that declares the contract.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const KERNEL_ROOT = resolve(__dirname, '..', '..', 'src', 'kernel');

/* ------------------------------------------------------------------ */
/* File collection                                                     */
/* ------------------------------------------------------------------ */

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out.sort();
}

const FILES = collect(KERNEL_ROOT);

/* ------------------------------------------------------------------ */
/* Comment and string stripping                                        */
/* ------------------------------------------------------------------ */

/**
 * Replace every comment and every string or template literal with spaces of the
 * same length, so line and column numbers survive and so a rule named in prose
 * is not mistaken for a rule broken in code.
 *
 * This is a scanner, not a parser. The one construct it cannot distinguish from
 * a division is a regex literal, so a `/` that begins a regex is treated as
 * division; that is harmless here, because no rule below looks for a character
 * a regex body could contain in a way that changes the verdict.
 */
export { stripComments } from './sourceScan';
import { stripComments } from './sourceScan';

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Identifier scanning strips comments AND literals: a rule named in prose or in
 * an error message is not a rule broken in code.
 */
const codeOnly = (source: string): string => stripComments(source, true);

/**
 * Import scanning strips comments ONLY. A module specifier lives inside a
 * string literal, so blanking literals here would make every import rule
 * silently unable to fire, which is the worst failure mode a guard rail has.
 */
const withLiterals = (source: string): string => stripComments(source, false);

function scan(pattern: RegExp, prepare: (s: string) => string = codeOnly): Offence[] {
  const offences: Offence[] = [];
  for (const file of FILES) {
    const raw = readFileSync(file, 'utf8');
    const code = prepare(raw);
    const lines = code.split('\n');
    const rawLines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      if (re.test(line)) {
        offences.push({
          file: relative(resolve(KERNEL_ROOT, '..', '..'), file),
          line: i + 1,
          text: (rawLines[i] ?? '').trim(),
        });
      }
    }
  }
  return offences;
}

const report = (offences: readonly Offence[]): string =>
  offences.map((o) => `${o.file}:${o.line}  ${o.text}`).join('\n');

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('the comment and string stripper', () => {
  it('blanks line comments, block comments and every kind of literal', () => {
    const stripped = codeOnly(
      [
        '// Math.random is forbidden',
        '/* so is Date.now */',
        'const a = "performance.now";',
        'const b = `document.body`;',
        "const c = 'window';",
        'const real = Math.floor(1.5);',
      ].join('\n'),
    );
    expect(stripped).not.toMatch(/Math\.random/);
    expect(stripped).not.toMatch(/Date\.now/);
    expect(stripped).not.toMatch(/performance\.now/);
    expect(stripped).not.toMatch(/document/);
    expect(stripped).not.toMatch(/window/);
    expect(stripped).toMatch(/Math\.floor/);
  });

  it('preserves line numbering', () => {
    const source = 'const a = 1;\n/* two\nthree */\nconst b = 2;';
    expect(codeOnly(source).split('\n').length).toBe(source.split('\n').length);
  });

  it('handles escaped quotes inside a string', () => {
    const stripped = codeOnly('const s = "a \\" Math.random b"; const t = 1;');
    expect(stripped).not.toMatch(/Math\.random/);
    expect(stripped).toMatch(/const t = 1;/);
  });

  it('is what makes this suite pass on types.ts, which names the rules in prose', () => {
    const types = readFileSync(join(KERNEL_ROOT, 'types.ts'), 'utf8');
    expect(types).toMatch(/Math\.random/); // stated in the header comment
    expect(codeOnly(types)).not.toMatch(/Math\.random/);
  });
});

describe('src/kernel is headless', () => {
  it('finds files to scan', () => {
    expect(FILES.length).toBeGreaterThan(0);
    const names = FILES.map((f) => relative(KERNEL_ROOT, f));
    expect(names).toContain('types.ts');
    expect(names).toContain('rng.ts');
    expect(names).toContain('Kernel.ts');
    expect(names).toContain('EventBus.ts');
  });

  it('imports nothing from three', () => {
    const offences = scan(
      /\bfrom\s*['"]three(\/[^'"]*)?['"]|\bimport\s*\(\s*['"]three/,
      withLiterals,
    );
    expect(report(offences)).toBe('');
  });

  it('imports nothing from a render, world, ui, audio, app or platform module', () => {
    const offences = scan(
      /\bfrom\s*['"](@render|@world|@ui|@audio|@app|@platform|@terminal|@design)\b/,
      withLiterals,
    );
    expect(report(offences)).toBe('');
  });

  it('imports nothing from the game layer, since the dependency runs the other way', () => {
    const offences = scan(
      /\bfrom\s*['"](@game|@legs)\b|\bfrom\s*['"](\.\.\/)+game\b/,
      withLiterals,
    );
    expect(report(offences)).toBe('');
  });

  it('never touches document or window', () => {
    const offences = scan(/\b(document|window|navigator|localStorage|sessionStorage)\b/);
    expect(report(offences)).toBe('');
  });

  it('never touches a canvas, a WebGL context or requestAnimationFrame', () => {
    const offences = scan(/\b(HTMLCanvasElement|WebGL2RenderingContext|requestAnimationFrame|GPUDevice)\b/);
    expect(report(offences)).toBe('');
  });
});

describe('src/kernel is deterministic', () => {
  it('never calls Math.random', () => {
    const offences = scan(/\bMath\s*\.\s*random\b/);
    expect(report(offences)).toBe('');
  });

  it('never calls Date.now or constructs a Date', () => {
    const offences = scan(/\bDate\s*\.\s*now\b|\bnew\s+Date\b/);
    expect(report(offences)).toBe('');
  });

  it('never calls performance.now', () => {
    const offences = scan(/\bperformance\s*\.\s*now\b/);
    expect(report(offences)).toBe('');
  });

  it('never calls crypto.getRandomValues', () => {
    const offences = scan(/\bcrypto\s*\.\s*getRandomValues\b/);
    expect(report(offences)).toBe('');
  });

  it('never uses toLocaleString or Intl, whose output is locale-dependent', () => {
    const offences = scan(/\btoLocale[A-Za-z]*\s*\(|\bIntl\s*\./);
    expect(report(offences)).toBe('');
  });

  it('never sorts without a comparator', () => {
    // `.sort()` with no argument is lexicographic on strings and its result on
    // numbers depends on prior array history. Sim spec 1.3.
    const offences = scan(/\.sort\s*\(\s*\)/);
    expect(report(offences)).toBe('');
  });

  it('never reads process.env or import.meta.env', () => {
    const offences = scan(/\bprocess\s*\.\s*env\b|\bimport\s*\.\s*meta\b/);
    expect(report(offences)).toBe('');
  });
});

describe('src/kernel has no runtime dependencies', () => {
  it('imports only relative paths and @kernel', () => {
    const offences: Offence[] = [];
    const importRe = /\bfrom\s*['"]([^'"]+)['"]/;
    for (const file of FILES) {
      const raw = readFileSync(file, 'utf8');
      const code = withLiterals(raw);
      const rawLines = raw.split('\n');
      code.split('\n').forEach((line, i) => {
        const match = importRe.exec(line);
        const specifier = match?.[1];
        if (specifier === undefined) return;
        const ok = specifier.startsWith('.') || specifier.startsWith('@kernel');
        if (!ok) {
          offences.push({
            file: relative(resolve(KERNEL_ROOT, '..', '..'), file),
            line: i + 1,
            text: (rawLines[i] ?? '').trim(),
          });
        }
      });
    }
    expect(report(offences)).toBe('');
  });
});
