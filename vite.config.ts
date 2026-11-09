import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, 'app'),
  server: {
    port: 4771,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4770' },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
