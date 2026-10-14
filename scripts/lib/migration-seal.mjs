/**
 * Migration immutability (spec 01 F05): a merged migration is never edited; a correction is a new numbered file.
 *
 * `migrations.sealed.json` records the SHA-256 of every migration. `checkSeal` fails when a recorded file was
 * changed or deleted, when a migration is not recorded yet, or when numbering is not strictly increasing.
 * `compareToBase` additionally compares the manifest with the one on the base branch, so rewriting an old
 * hash alongside the file (the obvious way round the first check) is caught in CI.
 *
 * Pure functions over plain data so tests need no filesystem; the CLI is scripts/migration-seal.mjs.
 */
import { createHash } from 'node:crypto';

/** CRLF and LF hash the same: a checkout with autocrlf must not look like an edit. */
export function hashMigration(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * @param {Record<string, string>} files  file name -> content, for every migrations/*.sql
 * @param {Record<string, string>} manifest  file name -> sha256
 * @returns {string[]} problems, empty when the chain is sealed and untouched
 */
export function checkSeal(files, manifest) {
  const problems = [];
  const names = Object.keys(files).sort();
  let previous = -1;
  for (const name of names) {
    const match = NAME.exec(name);
    if (!match) {
      problems.push(`${name}: not named NNNN_snake_case.sql`);
      continue;
    }
    const number = Number(match[1]);
    if (number <= previous)
      problems.push(`${name}: number ${match[1]} is not greater than the one before it`);
    previous = number;
  }
  for (const name of Object.keys(manifest).sort()) {
    if (!(name in files)) problems.push(`${name}: sealed but missing; a merged migration cannot be deleted`);
    else if (hashMigration(files[name] ?? '') !== manifest[name])
      problems.push(`${name}: changed after it was sealed; add a new migration instead of editing this one`);
  }
  for (const name of names)
    if (!(name in manifest)) problems.push(`${name}: not sealed; run npm run migrations:seal`);
  return problems;
}

/**
 * Every entry the base branch sealed must be present and identical now. New entries are allowed.
 * @param {Record<string, string>} base
 * @param {Record<string, string>} current
 */
export function compareToBase(base, current) {
  const problems = [];
  for (const [name, hash] of Object.entries(base).sort(([a], [b]) => a.localeCompare(b))) {
    if (!(name in current)) problems.push(`${name}: sealed on the base branch and removed here`);
    else if (current[name] !== hash) problems.push(`${name}: its sealed hash differs from the base branch`);
  }
  return problems;
}

/** Deterministic manifest text: sorted, one entry per line so two PRs adding migrations rarely conflict. */
export function renderManifest(hashes) {
  const entries = Object.keys(hashes)
    .sort()
    .map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(hashes[name])}`);
  return `{\n${entries.join(',\n')}\n}\n`;
}
