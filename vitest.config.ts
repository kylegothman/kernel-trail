import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/kernel/**', 'src/game/**'] },
  },
  resolve: {
    alias: {
      '@kernel': r('./src/kernel'),
      '@game': r('./src/game'),
      '@legs': r('./src/legs'),
      '@design': r('./src/design'),
    },
  },
});
