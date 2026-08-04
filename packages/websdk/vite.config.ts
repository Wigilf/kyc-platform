import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only stand-in for the integrator's backend.
 *
 * Minting an applicant token needs backend credentials, which must never reach
 * the browser — so the harness page posts here and this does it server-side,
 * exactly as a real integration would. Not part of the built library.
 *
 * It signs in as a seeded demo operator, so every run leaves an applicant (and
 * audit entries) in the demo tenant. Fine for local work; delete the `sdk-*`
 * applicants afterwards if you want the demo data to read cleanly.
 */
function tokenHarness(): Plugin {
  return {
    name: 'kyc-token-harness',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/harness/token', async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return send(405, { message: 'POST only' });

        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const { apiBaseUrl, externalUserId } = JSON.parse(
            Buffer.concat(chunks).toString() || '{}',
          );
          const base = String(apiBaseUrl ?? 'http://localhost:4000').replace(/\/$/, '');

          const login = await fetch(`${base}/v1/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: process.env.HARNESS_EMAIL ?? 'compliance@acme.test',
              password: process.env.HARNESS_PASSWORD ?? process.env.SEED_PASSWORD ?? 'dev-only-local-password',
            }),
          });
          const session = await login.json();
          if (!login.ok) return send(login.status, session);

          const minted = await fetch(`${base}/v1/sdk/tokens`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${session.token}`,
            },
            body: JSON.stringify({
              externalUserId: externalUserId ?? 'sdk-demo-001',
              levelName: 'standard-kyc-aml',
              ttlSeconds: 1800,
            }),
          });
          send(minted.status, await minted.json());
        } catch (error) {
          send(500, { message: error instanceof Error ? error.message : 'harness failed' });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [tokenHarness()],
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'KycVerification',
      // ESM for bundlers, IIFE for a plain <script> tag. Integrators who are not
      // running a build step are the ones most likely to embed a widget.
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'iife' ? 'kyc-websdk.js' : 'index.js'),
    },
    // Self-contained by design: no dependencies to leave external.
    rollupOptions: {},
    sourcemap: true,
    emptyOutDir: true,
  },
  server: { port: 5175 },
});
