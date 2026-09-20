/**
 * WP-23 section 1, acceptance 5: the debug seam `src/main.ts` attaches at
 * `globalThis.__kernelTrailDebug` exists in a development build only. A
 * production build is made into a scratch directory and every file a player
 * downloads is scanned for the identifier; a development-mode build is made
 * the same way and must contain it, so the `import.meta.env.DEV` guard is
 * proven to be the mechanism rather than a coincidence of tree shaking.
 * Source maps are excluded, as the bundle budget excludes them: they embed
 * the original source and are fetched only with devtools open.
 */
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SEAM = '__kernelTrailDebug';

function shippedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) shippedFiles(full, out);
    else if (!entry.endsWith('.map')) out.push(full);
  }
  return out;
}

async function buildInto(mode: 'production' | 'development'): Promise<{ readonly dir: string; readonly hits: readonly string[] }> {
  const dir = mkdtempSync(join(tmpdir(), `kt-wp23-${mode}-`));
  // Vite derives import.meta.env.DEV from NODE_ENV when one is already set, and
  // vitest sets it to test; the build must see the same NODE_ENV the CLI would.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    await build({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, mode, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true, sourcemap: true } });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
  const hits = shippedFiles(dir).filter((file) => readFileSync(file, 'utf8').includes(SEAM)).map((file) => file.slice(dir.length + 1));
  return { dir, hits };
}

describe('the debug seam and dist/', () => {
  it('a production build ships no occurrence of the seam identifier', { timeout: 60_000 }, async () => {
    const { dir, hits } = await buildInto('production');
    try {
      expect(hits, `the production build carries ${SEAM} in ${hits.join(', ')}`).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a development-mode build carries the seam, so the DEV guard is the mechanism', { timeout: 60_000 }, async () => {
    const { dir, hits } = await buildInto('development');
    try {
      expect(hits.length, `no shipped file of the development build carries ${SEAM}`).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
