import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
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
