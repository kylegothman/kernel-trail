import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const buildId = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'dev'; }
})();

/** Missing legs reject at runtime; authored legs retain normal dynamic chunks. */
export function absentLegs(root = r('.')): Plugin {
  const source = readFileSync(resolve(root, 'src/game/types.ts'), 'utf8');
  const order = source.match(/export const LEG_ORDER[^=]*=\s*\[([\s\S]*?)\];/)?.[1];
  if (order === undefined) throw new Error('Cannot read LEG_ORDER for absent leg resolution.');
  const absent = new Map<string, string>();
  const prefix = '\0kt-absent-leg:';
  for (const match of order.matchAll(/'([^']+)'/g)) {
    const id = match[1];
    if (id === undefined || existsSync(resolve(root, 'src/legs', id, 'index.ts'))) continue;
    absent.set(`@legs/${id}`, id);
    absent.set(resolve(root, 'src/legs', id), id);
  }
  return {
    name: 'kt-absent-legs',
    enforce: 'pre',
    resolveId(id) {
      const missing = absent.get(id);
      return missing === undefined ? null : `${prefix}${missing}`;
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      return `throw new Error(${JSON.stringify(`Leg ${id.slice(prefix.length)} is not in this build.`)});`;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [absentLegs()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@app': r('./src/app'),
      '@kernel': r('./src/kernel'),
      '@render': r('./src/render'),
      '@world': r('./src/world'),
      '@game': r('./src/game'),
      '@legs': r('./src/legs'),
      '@design': r('./src/design'),
      '@ui': r('./src/ui'),
      '@audio': r('./src/audio'),
      '@terminal': r('./src/terminal'),
      '@platform': r('./src/platform'),
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          return id.includes('node_modules/three') ? 'three' : undefined;
        },
      },
    },
  },
});
