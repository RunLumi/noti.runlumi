/**
 * Migration immutability (spec 01 F05): a merged migration is never edited; a correction is a new numbered file.
 *
 * Every `migrations/NNNN_name.sql` has a sidecar `migrations/NNNN_name.sql.sha256` holding its SHA-256, written once by
 * `npm run migrations:seal` and never edited. Sidecars are separate files, so two pull requests that add migrations touch
 * disjoint paths and cannot conflict; two that pick the same number are caught (duplicate number).
 *
 * `checkSeal` looks at one tree. `compareToBase` compares it with the base branch: nothing the base had may change or
 * disappear, and a new migration must be numbered above everything the base had. Pure functions over plain data; the
 * CLI is scripts/migration-seal.mjs.
 *
 * This is a check, not a guarantee: it only blocks a merge once branch protection requires the CI jobs that run it
 * (docs/RELEASE_GATES.md).
 */
import { createHash } from 'node:crypto';

/** CRLF and LF hash the same: a checkout with autocrlf must not look like an edit. */
export function hashMigration(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export const SEAL_SUFFIX = '.sha256';
/** Numbers that are deliberately absent from the chain. 0023 was reserved and never used. */
export const ALLOWED_GAPS = new Set([23]);

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const HASH = /^[0-9a-f]{64}$/;

/** Parses a sidecar's text; returns undefined when it is not exactly `<64 hex>\n`. */
export function parseSeal(text) {
  const t = text.trim();
  return HASH.test(t) ? t : undefined;
}

export function renderSeal(hash) {
  return `${hash}\n`;
}

/**
 * @param {Record<string, string>} files  migration file name -> content
 * @param {Record<string, string>} seals  migration file name -> sidecar text
 * @param {{ allowUnsealed?: boolean }} [options]  `migrations:seal` runs with this, since sealing is what adds them
 * @returns {string[]} problems, empty when the chain is sealed and untouched
 */
export function checkSeal(files, seals, options = {}) {
  const problems = [];
  const names = Object.keys(files).sort();
  let previous;
  for (const name of names) {
    const match = NAME.exec(name);
    if (!match) {
      problems.push(`${name}: not named NNNN_snake_case.sql`);
      continue;
    }
    const number = Number(match[1]);
    if (previous !== undefined) {
      if (number === previous)
        problems.push(`${name}: duplicate migration number ${match[1]} (renumber the newer one)`);
      else if (number !== previous + 1 && !gapIsAllowed(previous, number))
        problems.push(`${name}: number ${match[1]} leaves a gap after ${pad(previous)}`);
    }
    previous = number;
  }
  for (const name of Object.keys(seals).sort()) {
    const recorded = parseSeal(seals[name] ?? '');
    if (!(name in files)) problems.push(`${name}: sealed but missing; a merged migration cannot be deleted`);
    else if (recorded === undefined) problems.push(`${name}${SEAL_SUFFIX}: not a 64 character hex digest`);
    else if (hashMigration(files[name] ?? '') !== recorded)
      problems.push(`${name}: changed after it was sealed; add a new migration instead of editing this one`);
  }
  if (!options.allowUnsealed)
    for (const name of names)
      if (!(name in seals)) problems.push(`${name}: not sealed; run npm run migrations:seal`);
  return problems;
}

function gapIsAllowed(previous, number) {
  for (let n = previous + 1; n < number; n += 1) if (!ALLOWED_GAPS.has(n)) return false;
  return true;
}

const pad = (n) => String(n).padStart(4, '0');
const numberOf = (name) => Number(NAME.exec(name)?.[1] ?? Number.NaN);

/**
 * Compares the current tree with the base branch.
 * - every base migration must still exist with the same content (so this works even when the base has no sidecars yet);
 * - every base sidecar must exist and be byte-identical;
 * - a migration the base did not have must be numbered above the base's highest.
 * @param {{ files: Record<string, string>, seals: Record<string, string> }} base
 * @param {{ files: Record<string, string>, seals: Record<string, string> }} current
 */
export function compareToBase(base, current) {
  const problems = [];
  for (const name of Object.keys(base.files).sort()) {
    if (!(name in current.files)) problems.push(`${name}: exists on the base branch and was removed here`);
    else if (hashMigration(current.files[name] ?? '') !== hashMigration(base.files[name] ?? ''))
      problems.push(`${name}: differs from the base branch; a merged migration is never edited`);
  }
  for (const name of Object.keys(base.seals).sort()) {
    if (!(name in current.seals))
      problems.push(`${name}${SEAL_SUFFIX}: sealed on the base branch and removed here`);
    else if (current.seals[name] !== base.seals[name])
      problems.push(`${name}${SEAL_SUFFIX}: differs from the base branch; a seal is never edited`);
  }
  const baseMax = Math.max(-1, ...Object.keys(base.files).map(numberOf).filter(Number.isFinite));
  for (const name of Object.keys(current.files).sort()) {
    if (name in base.files) continue;
    if (numberOf(name) <= baseMax)
      problems.push(
        `${name}: new migration is numbered ${pad(numberOf(name))}, not above the base's highest ${pad(baseMax)}`,
      );
  }
  return problems;
}
