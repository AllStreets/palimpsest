import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, 'app'),
  server: {
    port: 4771,
    strictPort: true,
    // changeOrigin sends the engine's own Host, which its rebinding check requires; the page's
    // Origin (this dev server) stays as it is and the engine lets it through.
    proxy: { '/api': { target: 'http://127.0.0.1:4770', changeOrigin: true } },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
