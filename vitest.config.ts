import { allocationProbe } from './tests/render/gpu/allocationProbe';
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [allocationProbe],
  test: {
    environment: 'node',
    server: { deps: { inline: ['three'] } },
    // Headroom over the slowest ordinary test (~1.2s) on a slow runner. Anything
    // heavier declares its own budget on the test, as DET-D4 does.
    testTimeout: 20_000,
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/kernel/**', 'src/game/**'] },
  },
  resolve: {
    alias: {
      '@kernel': r('./src/kernel'),
      '@game': r('./src/game'),
      '@legs': r('./src/legs'),
      '@design': r('./src/design'),
      '@platform': r('./src/platform'),
      '@render': r('./src/render'),
    },
  },
});
