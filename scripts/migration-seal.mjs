#!/usr/bin/env node
/**
 *   npm run migrations:seal                      write a sidecar for every migration that has none (never rewrites one);
 *                                                refuses, writing nothing, if anything sealed was edited or the chain is malformed
 *   node scripts/migration-seal.mjs --check      fail on an edited, deleted, unsealed, duplicate or misnumbered migration
 *   node scripts/migration-seal.mjs --check --base <ref> [--require-base]
 *                                                also compare with <ref> (see lib/migration-seal.mjs). An unresolvable
 *                                                ref is an error (exit 2), never a pass. --require-base additionally fails
 *                                                when <ref> has no sidecars yet.
 *   --root <dir>                                 operate on another checkout (used by the tests)
 *
 * Exit codes: 0 ok, 1 a rule is broken, 2 the check could not run (bad arguments, git failure).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEAL_SUFFIX, checkSeal, compareToBase, hashMigration, renderSeal } from './lib/migration-seal.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? '');
};
const root = resolve(flag('--root') ?? dirname(dirname(fileURLToPath(import.meta.url))));
const dir = join(root, 'migrations');

function fail(code, message) {
  console.error(`migration seal: ${message}`);
  process.exit(code);
}

function splitTree(entries) {
  const files = {};
  const seals = {};
  for (const [name, read] of entries) {
    if (name.endsWith('.sql')) files[name] = read();
    else if (name.endsWith(`.sql${SEAL_SUFFIX}`)) seals[name.slice(0, -SEAL_SUFFIX.length)] = read();
  }
  return { files, seals };
}

const current = splitTree(
  readdirSync(dir)
    .sort()
    .map((name) => [name, () => readFileSync(join(dir, name), 'utf8')]),
);

function git(gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function readBase(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    fail(
      2,
      `base ref "${ref}" does not resolve (fetch it, or check the name); refusing to treat that as "no base"`,
    );
  }
  let listing;
  try {
    listing = git(['ls-tree', '-r', '--name-only', ref, '--', 'migrations/'])
      .split('\n')
      .filter(Boolean)
      .map((p) => p.slice('migrations/'.length));
  } catch (error) {
    fail(2, `could not list migrations on "${ref}": ${String(error.message).split('\n')[0]}`);
  }
  try {
    return splitTree(listing.map((name) => [name, () => git(['show', `${ref}:migrations/${name}`])]));
  } catch (error) {
    fail(2, `could not read migrations on "${ref}": ${String(error.message).split('\n')[0]}`);
  }
}

if (args.includes('--check')) {
  const problems = checkSeal(current.files, current.seals);
  const ref = flag('--base');
  if (args.includes('--base') && !ref) fail(2, '--base needs a ref');
  if (args.includes('--require-base') && !ref) fail(2, '--require-base needs --base <ref>');
  if (ref) {
    const base = readBase(ref);
    if (Object.keys(base.files).length === 0) fail(2, `"${ref}" has no migrations; the wrong ref?`);
    if (args.includes('--require-base') && Object.keys(base.seals).length === 0)
      problems.push(`"${ref}" has no sealed migrations yet, but --require-base was given`);
    problems.push(...compareToBase(base, current));
  }
  for (const p of problems) console.error(`migration seal: ${p}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

// Seal: write nothing unless the whole chain is sound.
const problems = checkSeal(current.files, current.seals, { allowUnsealed: true });
if (problems.length > 0) {
  for (const p of problems) console.error(`migration seal: ${p}`);
  fail(1, 'nothing was written');
}
for (const [name, text] of Object.entries(current.files)) {
  const path = join(dir, `${name}${SEAL_SUFFIX}`);
  if (name in current.seals || existsSync(path)) continue;
  writeFileSync(path, renderSeal(hashMigration(text)));
  console.log(`sealed ${name}`);
}
