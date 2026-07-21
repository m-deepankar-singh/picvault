import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // libsodium's ESM dist has a broken relative import; use the CJS build.
      'libsodium-wrappers-sumo': fileURLToPath(
        new URL(
          '../node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
          import.meta.url
        )
      )
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true }
    }
  }
});
