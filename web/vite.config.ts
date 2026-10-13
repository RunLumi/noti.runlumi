import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * One build, one Worker (ADR 0017). `vite dev` runs the dashboard and the API Worker in the same
 * process on one origin, so the browser, cookies and the CSRF origin check behave as in
 * production. Run it through the npm scripts: TanStack Start resolves its output directory
 * from the working directory, so the scripts `cd web` first.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    cloudflare({
      // Start's server environment is the Worker's environment.
      viteEnvironment: { name: 'ssr' },
      configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
      // Same local D1 and queue state as `wrangler d1 migrations apply --local` at the root.
      persistState: { path: fileURLToPath(new URL('../.wrangler/state', import.meta.url)) },
    }),
    // SPA mode: the build prerenders one shell document and the browser renders every route.
    tanstackStart({ spa: { enabled: true } }),
    react(),
    tailwindcss(),
  ],
  // Start decides "render only the root route" (the SPA shell) from this flag, which it reads
  // from `process.env` at runtime. The Worker runtime does not see the build's environment, so
  // without this the prerendered shell contains the `/` page. Server environment only.
  environments: { ssr: { define: { 'process.env.TSS_PRERENDERING': '"true"' } } },
  // APP_ORIGIN in .dev.vars.example is http://localhost:5173.
  server: { port: 5173 },
  build: { outDir: 'dist' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
