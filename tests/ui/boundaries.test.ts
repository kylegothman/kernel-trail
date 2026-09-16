// @vitest-environment happy-dom
/**
 * The src/ui import boundary, WP-17 scope correction S11, in the pattern of
 * tests/kernel/boundaries.test.ts: value imports only from @design and from
 * inside src/ui; every import from the kernel, game, world, audio and render
 * layers is type-only; no three, no colour literal, no localStorage, no
 * innerHTML, no Math.random, no Date.now.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSources, reportOffences, scanFiles, UI_ROOT, REPO_ROOT } from './uiSourceScan';

const FILES = collectSources(UI_ROOT);

describe('src/ui boundaries', () => {
  it('finds files to scan', () => {
    expect(FILES.length).toBeGreaterThan(5);
    expect(FILES.some((f) => f.endsWith('hud/Hud.ts'))).toBe(true);
    expect(FILES.some((f) => f.endsWith('DomBatch.ts'))).toBe(true);
  });

  it('imports nothing from three', () => {
    expect(reportOffences(scanFiles(FILES, /\bfrom\s*['"]three(\/[^'"]*)?['"]|\bimport\s*\(\s*['"]three/, 'imports'))).toBe('');
  });

  it('holds value imports only from @design and from inside src/ui', () => {
    const offences = scanFiles(
      FILES,
      /^\s*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*['"](?!@design\b|\.)/,
      'imports',
    );
    expect(reportOffences(offences)).toBe('');
  });

  it('imports from the kernel, game, world, audio and render layers as types only', () => {
    const offences = scanFiles(
      FILES,
      /^\s*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*['"](?:@kernel|@game|@world|@audio|@render|@terminal|@app|@legs|@platform)\b/,
      'imports',
    );
    expect(reportOffences(offences)).toBe('');
  });

  it('never deep-imports another layer by relative path', () => {
    expect(reportOffences(scanFiles(FILES, /\bfrom\s*['"](?:\.\.\/)+(?:kernel|game|world|audio|render|terminal|app|legs|platform|design)\b/, 'imports'))).toBe('');
  });

  it('contains no colour literal', () => {
    expect(reportOffences(scanFiles(FILES, /#[0-9a-fA-F]{3,8}\b|\b0x[0-9a-fA-F]{6}\b/, 'imports'))).toBe('');
  });

  it('never touches localStorage, innerHTML, Math.random, Date.now, performance.now or the document global', () => {
    expect(reportOffences(scanFiles(FILES, /\b(localStorage|sessionStorage|innerHTML|outerHTML|indexedDB)\b/, 'code'))).toBe('');
    expect(reportOffences(scanFiles(FILES, /\bMath\s*\.\s*random\b|\bDate\s*\.\s*now\b|\bnew\s+Date\b|\bperformance\s*\.\s*now\b/, 'code'))).toBe('');
    expect(reportOffences(scanFiles(FILES, /(?<![.\w])(document|window)\s*\./, 'code'))).toBe('');
  });

  it('never schedules its own timers', () => {
    expect(reportOffences(scanFiles(FILES, /\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/, 'code'))).toBe('');
  });

  it('uses the shared scanner and defines no rules of its own', () => {
    const helper = readFileSync(join(REPO_ROOT, 'tests', 'ui', 'uiSourceScan.ts'), 'utf8');
    expect(helper).toMatch(/from '\.\.\/kernel\/sourceScan'/);
    expect(helper).not.toMatch(/function\s+stripComments/);
    // No regex literal and no assertion: the helper walks and matches, the tests decide what is forbidden.
    const code = helper.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\/\\b|\/\^|expect\(|describe\(|\bit\(/);
  });
});
