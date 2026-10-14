#!/usr/bin/env node
/**
 * Pre-deploy guard (docs/RELEASE_GATES.md; ADR 0022). `npm run deploy` runs it first (npm runs a
 * `predeploy` script before `deploy`), and it can be run on its own: `npm run predeploy`.
 *
 * `wrangler.jsonc` is committed with `REPLACE_WITH_...` placeholders so a fresh checkout fails
 * closed. Deploying one of them to production would leave the Worker refusing to serve (a KEK check
 * value) or silently dead (a D1 id), so this refuses to deploy while any REQUIRED placeholder
 * remains, and only warns about the OPTIONAL ones (the GitHub App identifiers, which keep GitHub
 * ingress failing closed until the App exists, by design).
 *
 * Exit 0: nothing fatal (warnings are printed). Exit 1: fix the listed items first.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Placeholders that are allowed to remain at deploy time: the feature fails closed until set. */
export const OPTIONAL_PLACEHOLDERS = new Set(['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_CLIENT_ID']);

/**
 * Every placeholder the committed file may contain. A new one has to be added here on purpose
 * (tests/config.placeholders.test.ts), so a `REPLACE_WITH_` cannot slip into an unrelated var.
 */
export const ALLOWED_PLACEHOLDER_KEYS = new Set([...OPTIONAL_PLACEHOLDERS, 'KEK_CHECK_V1', 'database_id']);

/** Strip `//` and block comments from JSONC without touching `//` inside strings. */
export function stripJsonComments(input) {
  let out = '';
  let inString = false;
  let line = false;
  let block = false;
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    const n = input.charAt(i + 1);
    if (line) {
      if (c === '\n') {
        line = false;
        out += c;
      }
      continue;
    }
    if (block) {
      if (c === '*' && n === '/') {
        block = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += n;
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && n === '/') {
      line = true;
      i++;
    } else if (c === '/' && n === '*') {
      block = true;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseWrangler(text) {
  return JSON.parse(stripJsonComments(text));
}

/** Every `[key, value]` whose string value contains `REPLACE_WITH_`, anywhere in the config. */
export function placeholders(config) {
  const found = [];
  const walk = (node, key) => {
    if (typeof node === 'string') {
      if (node.includes('REPLACE_WITH_')) found.push([key, node]);
    } else if (Array.isArray(node)) node.forEach((n) => walk(n, key));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  walk(config, '');
  return found;
}

/**
 * @param {Record<string, unknown>} config parsed wrangler.jsonc
 * @returns {{ fatal: string[], warnings: string[] }}
 */
export function evaluatePredeploy(config) {
  const fatal = [];
  const warnings = [];
  for (const [key, value] of placeholders(config)) {
    if (OPTIONAL_PLACEHOLDERS.has(key))
      warnings.push(`${key} is still a placeholder (${value}): this feature stays disabled, fail closed.`);
    else fatal.push(`${key} is still a placeholder (${value}): set the real value before deploying.`);
  }
  const vars = /** @type {Record<string, unknown>} */ (config.vars ?? {});
  if (!['production', 'staging'].includes(String(vars.ENVIRONMENT_NAME)))
    fatal.push('ENVIRONMENT_NAME must be "production" or "staging" for a deployment.');
  const check = String(vars.KEK_CHECK_V1 ?? '');
  if (!check.includes('REPLACE_WITH_') && !/^[0-9a-f]{32}$/.test(check))
    fatal.push('KEK_CHECK_V1 must be 32 hex characters (scripts/kek-destroy-check.mjs check-value).');
  return { fatal, warnings };
}

function main() {
  const config = parseWrangler(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  const { fatal, warnings } = evaluatePredeploy(config);
  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const f of fatal) console.error(`FATAL: ${f}`);
  if (fatal.length > 0) {
    console.error('Refusing to deploy. See docs/RUNBOOK.md, "KEK check value and environment mismatch".');
    process.exit(1);
  }
  console.info('predeploy: ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
