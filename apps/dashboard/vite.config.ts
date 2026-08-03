import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Same-origin in dev so the session token is never sent cross-site and there
    // is no CORS configuration to keep in step with the API.
    proxy: {
      '/v1': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: true },
      '/health': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
});
