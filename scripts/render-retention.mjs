// Renders docs/DATA_RETENTION.md from src/compliance/retention.ts.
//   npm run docs:retention          write the file
//   npm run docs:retention -- --check   fail if the committed file differs (CI uses the test instead)
// The matrix is TypeScript and imports other modules without file extensions, so it is loaded
// through Vite's SSR loader rather than by Node directly.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'docs', 'DATA_RETENTION.md');

const server = await createServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const mod = await server.ssrLoadModule('/src/compliance/render-retention.ts');
  const rendered = mod.renderRetentionDoc();
  if (process.argv.includes('--check')) {
    const current = readFileSync(target, 'utf8');
    if (current !== rendered) {
      console.error('docs/DATA_RETENTION.md is out of date. Run: npm run docs:retention');
      process.exitCode = 1;
    }
  } else {
    writeFileSync(target, rendered);
    console.log('wrote docs/DATA_RETENTION.md');
  }
} finally {
  await server.close();
}
