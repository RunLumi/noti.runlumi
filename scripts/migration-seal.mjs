#!/usr/bin/env node
/**
 *   npm run migrations:seal                     record hashes for new migrations (never rewrites a sealed one)
 *   node scripts/migration-seal.mjs --check     fail on edited, deleted, unsealed or misnumbered migrations
 *   node scripts/migration-seal.mjs --check --base origin/main
 *                                               also fail when the manifest changed or lost an entry versus <ref>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeal, compareToBase, hashMigration, renderManifest } from './lib/migration-seal.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(root, 'migrations.sealed.json');

function readFiles() {
  const dir = join(root, 'migrations');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
  );
}

const args = process.argv.slice(2);
const files = readFiles();
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};

if (args.includes('--check')) {
  const problems = checkSeal(files, manifest);
  const baseIndex = args.indexOf('--base');
  if (baseIndex !== -1) {
    const ref = args[baseIndex + 1];
    if (!ref) {
      console.error('--base needs a ref');
      process.exit(2);
    }
    let baseText;
    try {
      baseText = execFileSync('git', ['show', `${ref}:migrations.sealed.json`], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch {
      baseText = undefined; // the base predates the manifest: nothing to compare yet
    }
    if (baseText !== undefined) problems.push(...compareToBase(JSON.parse(baseText), manifest));
  }
  for (const p of problems) console.error(`migration seal: ${p}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

// Seal only what is not sealed yet. An edited sealed migration is reported, not re-hashed.
const next = { ...manifest };
for (const [name, text] of Object.entries(files)) if (!(name in next)) next[name] = hashMigration(text);
writeFileSync(MANIFEST, renderManifest(next));
const edited = Object.keys(manifest).filter(
  (n) => n in files && manifest[n] !== hashMigration(files[n] ?? ''),
);
if (edited.length > 0) {
  console.error(`sealed migrations were edited and left sealed at the old hash: ${edited.join(', ')}`);
  process.exit(1);
}
