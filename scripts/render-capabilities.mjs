// Renders docs/CAPABILITIES.md from src/connectors/destinations/kind-registry.ts (F120, ADR 0052).
//   npm run docs:capabilities          write the file
//   npm run docs:capabilities -- --check   fail if the committed file differs (CI uses the test instead)
// The registry is TypeScript and imports other modules without file extensions, so it is loaded
// through Vite's SSR loader rather than by Node directly.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'docs', 'CAPABILITIES.md');

const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const mod = await server.ssrLoadModule('/src/connectors/destinations/render-capabilities.ts');
  const rendered = mod.renderCapabilitiesDoc();
  if (process.argv.includes('--check')) {
    const current = readFileSync(target, 'utf8');
    if (current !== rendered) {
      console.error('docs/CAPABILITIES.md is out of date. Run: npm run docs:capabilities');
      process.exitCode = 1;
    }
  } else {
    writeFileSync(target, rendered);
    console.log('wrote docs/CAPABILITIES.md');
  }
} finally {
  await server.close();
}
