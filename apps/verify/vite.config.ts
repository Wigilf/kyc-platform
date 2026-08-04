import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5176,
    // Same-origin in dev so there is no CORS to configure locally.
    proxy: { '/v1': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: true } },
  },
  build: { emptyOutDir: true },
});
